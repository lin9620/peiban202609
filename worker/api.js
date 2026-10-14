/* Warm Paws API 网关（阶段 2）
 * ------------------------------------------------------------
 * 一个 Worker 同时承担两件事：
 *   1. /api/*    —— 前端数据网关：具名端点 → Supabase REST(PostgREST)/Storage 的纯翻译层。
 *                   只做协议翻译 + 鉴权头透传，不藏业务逻辑（业务仍在 DB 函数与 RLS 里）。
 *                   用户 JWT 原样转发 → RLS 照旧由数据库执行；本文件绝不解析/验证 token。
 *   2. 其余路径  —— 静态资源（env.ASSETS；SPA 兜底由 wrangler.jsonc 的 assets 配置决定）。
 *
 * 图片例外：/api/img/* 不走 302 直连 Storage，而是由本 Worker 代理字节 + Cache API
 *   长效缓存（见 imgResponse）—— 302 跨用户不共享，每张图的每次浏览都算一次
 *   Supabase egress，是免费额度最先触顶的地方；边缘缓存后同一张图只回源一次。
 *
 * 阶段 3（换 D1 / R2 / DO）时只重写本文件里 upstream 的指向，端点契约与前端不动；
 * 契约由 tools/worker-test.mjs（Worker 侧形状）+ tools/gateway-contract-test.mjs（前端侧）双面钉死。
 *
 * 配置（npx wrangler secret put；本地开发放 .dev.vars，均已被 .gitignore 忽略）：
 *   SUPABASE_URL       https://xxx.supabase.co
 *   SUPABASE_ANON_KEY  公开 anon key —— 未登录请求以它访问上游（anon 角色，能力由 RLS 决定）
 *
 * 安全模型：这不是开放代理 —— 每个端点只指向固定的表 / RPC / 桶路径；
 *   图片路径按 <uid>/<file> 白名单校验（与前端 isImageRef 同规则），拒绝目录穿越。
 */

const TABLE = {
  posts: "wall_posts",
  comments: "wall_comments",
  reactions: "wall_reactions",
  commentReactions: "wall_comment_reactions",   /* 轮 84：评论的 👍心 / 💔碎心 */
  favorites: "wall_favorites",                 /* 轮 128：帖子收藏夹（收藏列表私有，RLS 兜底） */
  profiles: "profiles",
  pet: "pet_profiles",
};
const IMAGE_BUCKET = "wall-images";
const OBJECT_ACCEPT = "application/vnd.pgrst.object+json";
const LIMIT_MAX = 1000;
const JSON_BODY_MAX = 2 * 1024 * 1024; /* 宠物快照降级保留 dataURL 时可达 ~1.8MB（shrinkPetPayload 预算） */
const UPLOAD_BODY_MAX = 512 * 1024; /* 前端单图上限 200KB，这里留一倍余量 */
/* 图片永久缓存：路径含时间戳/内容哈希且上传 upsert=false → 同 URL 字节不变（见 imgResponse） */
const CACHE_IMMUTABLE = "public, max-age=31536000, immutable";
/* 陪你大厅状态 key 白名单（与前端 src/utils/statuses.js 的 STATUS_KEYS 一致） */
const VALID_STATUS = new Set(["working", "studying", "sleepless", "chilling"]);
/* 图片路径白名单：uid 段不允许点号，文件段允许扩展名点号 —— ".." 穿越直接拒绝 */
const UID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const FILE_RE = /^[A-Za-z0-9_.-]{1,128}$/;

/* ──────── 小工具 ──────── */

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data ?? null), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      ...(extra || {}),
    },
  });
const fail = (status, code) => json({ error: code }, status);

function corsPreflight(request) {
  /* 轮 29：预检直接回显客户端申请的头（access-control-request-headers）——
   * 显式白名单漏一个就全挂（轮 23 漏了 supabase storage 上传的 cache-control，
   * 手机端暖心墙传图预检失败 → Failed to fetch；网页同源不预检所以一直正常）。
   * 回显 + 显式兜底，以后客户端带任何新头都不会再被卡。 */
  const asked = request && request.headers ? request.headers.get("access-control-request-headers") : "";
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,PUT,DELETE,PATCH,OPTIONS",
      "access-control-allow-headers":
        asked ||
        "authorization,content-type,apikey,x-upsert,cache-control,x-client-info,x-supabase-api-version,x-application-name,range,prefer,accept-profile,content-profile",
      "access-control-max-age": "86400",
    },
  });
}

function parseLimit(raw, dflt) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return Math.min(n, LIMIT_MAX);
}

/** 偏移量：非负整数（用户名单分页用） */
function parseOffset(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

/** 解码并校验 URL 段（帖 / 评论 / 用户 id）：拒绝空值与路径非法字符 */
function decodeSeg(s) {
  try {
    const d = decodeURIComponent(s);
    return d && !/[/?#\\\s]/.test(d) ? d : null;
  } catch (e) {
    return null;
  }
}

/** "a,b" → ["a","b"]（去空、限量） */
function parseIds(raw) {
  return (raw || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 200);
}

/** 图片路径校验：解码后必须正好 <uid>/<file> 两段，段内字符在白名单内 */
function safeImagePath(rawPath) {
  const segs = String(rawPath || "").split("/");
  if (segs.length !== 2) return null;
  const out = [];
  for (const s of segs) {
    let d;
    try {
      d = decodeURIComponent(s);
    } catch (e) {
      return null;
    }
    if (d === "." || d === "..") return null;
    out.push(d);
  }
  if (!UID_RE.test(out[0]) || !FILE_RE.test(out[1])) return null;
  return out.join("/");
}

/** 轮 256：client-log 每隔离实例内存限频窗（Map<ip,{ts,n}>，60s 窗、每 ip 20 条）。
 * Workers 的 isolate 各有各的内存，跨实例不共享——尽力而为，够防死循环刷屏。 */
let clientLogRL = null;

/** 请求体：限长 + JSON 解析；出错时给现成的 Response（{err}） */
async function readJson(request) {
  let text;
  try {
    text = await request.text();
  } catch (e) {
    console.error("READJSON THREW:", String(e && e.message));
    return { err: fail(400, "bad-body") };
  }
  if (text.length > JSON_BODY_MAX) return { err: fail(413, "payload-too-large") };
  if (!text.trim()) return { err: fail(400, "empty-body") };
  try {
    return { body: JSON.parse(text) };
  } catch (e) {
    return { err: fail(400, "invalid-json") };
  }
}

/* ──────── 上游（Supabase REST / Storage） ──────── */

/** 出站头：apikey 恒为 anon key；用户 JWT 若有则原样透传（RLS 据此判身份） */
function upstreamHeaders(env, request, extra) {
  const h = new Headers({ apikey: env.SUPABASE_ANON_KEY, "content-type": "application/json" });
  if (extra) for (const [k, v] of new Headers(extra)) h.set(k, v);
  const auth = request.headers.get("authorization");
  if (auth) h.set("authorization", auth);
  return h;
}

/** 一次上游调用；网络失败返回 null（由调用方统一 502） */
async function upstream(env, request, url, init = {}) {
  try {
    return await fetch(url, { ...init, headers: upstreamHeaders(env, request, init.headers) });
  } catch (e) {
    return null;
  }
}

const restUrl = (env, path, qs) => `${env.SUPABASE_URL}/rest/v1/${path}${qs ? `?${qs}` : ""}`;

/** Accept object 的 406(PGRST116) → 200 null：与 supabase-js maybeSingle 对齐（行不存在不算错） */
async function objectOrPassthrough(res) {
  if (res.status !== 406) return res;
  const text = await res.text();
  let code = "";
  try {
    const j = JSON.parse(text);
    code = j && j.code;
  } catch (e) { /* 非 JSON 错误体原样回传 */ }
  if (code === "PGRST116") return json(null, 200);
  return new Response(text, { status: 406, headers: { "content-type": "application/json" } });
}

/** 帖子列表：先带 removed 过滤；任何非 2xx 都退回不带过滤的查询（老库没有这一列；与直连模式对齐）
 *  offset：分页偏移（「我的帖子」10 条/页续拉用；0/缺省 = 与旧行为一致） */
/* 轮 64：sample 随机一批（「换一批」）——先数 7 天池总量（count=exact + Range 0-0，微小查询），
   再随机起点取一页。两次微小上游调用，不用全表排序。 */
async function samplePosts(env, request, limit, since) {
  /* 轮 162：随机时间锚点替代「count=exact → 随机 offset」。线上实测旧实现 12~16s/次
     还频繁 502：count=exact 在墙表上要 6s+（两次串行上游查询，慢查询窗口里一动就散）。
     改为：在 7 天窗口内随机取一个时刻，单条走 created_at 索引的查询取「该时刻之前的
     N 条」——免计数、单查、随机性照样每次不同（锚点毫秒级随机）；select=* 顺带修掉
     旧实现页面查询只取 id 的暗病。锚点早于窗口内最老帖子（空结果）→ 兜底拉最新一批。 */
  const now = Date.now();
  const parsed = since ? Date.parse(since) : NaN;
  const start = Number.isFinite(parsed) ? parsed : now - 7 * 86400000;
  const anchor = new Date(start + Math.random() * Math.max(1000, now - start)).toISOString();
  const base = [`select=${POST_COLS_ENC}`, "removed=eq.false", "order=created_at.desc", `limit=${limit}`];
  const anchored = [...base, `created_at=lte.${encodeURIComponent(anchor)}`].join("&");
  let res = await upstream(env, request, restUrl(env, TABLE.posts, anchored));
  if (res && res.ok) {
    const text = await res.text();   /* 只读一次：复用 text，别对同一 body 二次 text() */
    let rows = null;
    try { rows = JSON.parse(text); } catch (e) { rows = null; }
    if (Array.isArray(rows) && rows.length > 0) {
      return new Response(text, { status: res.status, headers: { "content-type": "application/json" } });
    }
    /* 锚点落空（窗口头部没货）→ 退最新一批，保证换一批永远有内容 */
    res = await upstream(env, request, restUrl(env, TABLE.posts, base.join("&")));
  }
  if (!res || !res.ok) return fail(502, "upstream-unreachable");
  return new Response(await res.text(), { status: res.status, headers: { "content-type": "application/json" } });
}

/* 轮 170：feed/列表用显式列（rowsToPosts 消费字段全覆盖），不再 select * */
const POST_COLS_ENC = encodeURIComponent("id,user_id,author_name,body,image_path,created_at,views,dislikes,removed");

async function listPosts(env, request, uid, limit, offset, beforeId = 0) {
  const base = [`select=${POST_COLS_ENC}`];
  if (uid) base.push(`user_id=eq.${encodeURIComponent(uid)}`);
  /* 轮 62：before_id 游标（keyset）——offset 深翻页要扫过并丢弃前面所有行，万帖级线性变慢；
     id 是串行主键（单调递增=发布顺序），id<游标 走主键索引，任意深度成本恒定。 */
  if (Number(beforeId) > 0) base.push(`id=lt.${Number(beforeId)}`);
  const order = "order=created_at.desc";
  const lim = `limit=${limit}`;
  const off = Number(offset) > 0 ? `offset=${Number(offset)}` : "";
  const qs = (extra) => [...base, ...[extra].filter(Boolean), order, lim, off].filter(Boolean).join("&");
  let res = await upstream(env, request, restUrl(env, TABLE.posts, qs("removed=eq.false")));
  if (!res) return fail(502, "upstream-unreachable");
  if (!res.ok) {
    res = await upstream(env, request, restUrl(env, TABLE.posts, qs("")));
    if (!res) return fail(502, "upstream-unreachable");
  }
  return res;
}

/* ═══ 轮 252 · 帖子搜索 / 列探测（关键词 + 标签）═══
 * 搜索首选 RPC wall_search_posts（迁移没跑 → 404 → 退回 REST 链，与 wallRefresh
 * 同思路）。REST 链显式列 + removed 过滤；老库无 tags/img_w/img_h 列（400）→
 * 退回旧列且隐掉标签条件（tag 过滤交回客户端筛，旧库 tags 恒空 → 标签搜空结果）。
 * 返回与合并包同形 { posts, react, comment }。 */
async function searchPosts(env, request, q) {
  const limit = parseLimit(q.get("limit"), 20);
  const beforeRaw = q.get("before_id") || "";
  const before = /^\d+$/.test(beforeRaw) ? Number(beforeRaw) : 0;
  const keyword = String(q.get("q") || "").trim().slice(0, 60);
  const tags = (q.get("tags") || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean).slice(0, 5);

  const rpcRes = await rpc(env, request, "wall_search_posts", {
    p_q: keyword, p_tags: tags, p_limit: limit, p_before: before,
  });
  if (rpcRes && rpcRes.ok) return rpcRes;

  /* ilike 转义：% _ \ 前加反斜杠（PostgREST 默认反斜杠转义），整段再 URL 编码 */
  const kw = keyword ? `%${keyword.replace(/[\\%_]/g, (c) => "\\" + c)}%` : "";
  const build = (cols, withTagFilter) => {
    const parts = [`select=${encodeURIComponent(cols)}`, "removed=eq.false"];
    if (before) parts.push(`id=lt.${before}`);
    if (kw) parts.push(`body=ilike.${encodeURIComponent(kw)}`);
    if (withTagFilter && tags.length) parts.push(`tags=ov.{${tags.map(encodeURIComponent).join(",")}}`);
    parts.push("order=id.desc", `limit=${limit}`);
    return restUrl(env, TABLE.posts, parts.join("&"));
  };
  const NEW_COLS = "id,user_id,author_name,body,image_path,created_at,views,dislikes,removed,tags,img_w,img_h";
  const OLD_COLS = "id,user_id,author_name,body,image_path,created_at,views,dislikes,removed";
  let res = await upstream(env, request, build(NEW_COLS, true));
  if (!res) return fail(502, "upstream-unreachable");
  if (!res.ok && res.status === 400) {
    res = await upstream(env, request, build(OLD_COLS, false));
    if (!res) return fail(502, "upstream-unreachable");
  }
  if (!res.ok) return res;
  let rows = [];
  try { rows = JSON.parse(await res.text()) || []; } catch (e) { rows = []; }
  if (!rows.length) return json({ posts: [], react: {}, comment: {} });
  const ids = rows.map((r) => r.id).filter((x) => x != null);
  const [rk, cm] = await Promise.all([
    listReactionsByPosts(env, request, ids),
    listCommentPostIds(env, request, ids, 2000),
  ]);
  let reactions = [], cmtRows = [];
  if (rk && rk.ok) { try { reactions = JSON.parse(await rk.text()) || []; } catch (e) { reactions = []; } }
  if (cm && cm.ok) { try { cmtRows = JSON.parse(await cm.text()) || []; } catch (e) { cmtRows = []; } }
  const uid = jwtUid(request);
  const react = {};
  for (const r of reactions) {
    if (!r || r.post_id == null) continue;
    const o = react[r.post_id] || (react[r.post_id] = { hug: 0, warm: 0, relate: 0, mine: {} });
    if (o[r.kind] !== undefined) o[r.kind]++;
    if (uid && r.user_id === uid && o[r.kind] !== undefined) o.mine[r.kind] = true;
  }
  const comment = {};
  for (const c of cmtRows) if (c && c.post_id != null) comment[c.post_id] = (comment[c.post_id] || 0) + 1;
  return json({ posts: rows, react, comment });
}

/* 轮 252：探 wall_posts 新列（tags/img_w/img_h）。显式 select 交给 PostgREST 校验，
 * 表为空也能判（老库 400 → []，调用方退回旧载荷；见 wall.js cloudInsertPost）。 */
async function probePostColumns(env, request) {
  const cols = encodeURIComponent("tags,img_w,img_h");
  const res = await upstream(env, request, restUrl(env, TABLE.posts, `select=${cols}&limit=1`));
  if (!res) return fail(502, "upstream-unreachable");
  return json(res.ok ? ["tags", "img_w", "img_h"] : []);
}

/** 评论列表（旧→新） */
async function listComments(env, request, postId, limit) {
  const res = await upstream(
    env, request,
    restUrl(env, TABLE.comments, `select=*&post_id=eq.${encodeURIComponent(postId)}&order=created_at.asc&limit=${limit}`),
  );
  return res || fail(502, "upstream-unreachable");
}

/* ── 轮 84 · 评论回应（👍心 / 💔碎心）────
 * 计数本身不在这里算：去归一化列 wall_comments.hearts / brokens 由 RPC 维护，
 * 列表接口 select=* 就带回来了。这里只负责两件事：
 *   ① 一次取多评论的回应明细（谁点了什么）→ 前端聚合出「我点过哪些」
 *   ② 转发切换 RPC（服务端算权威计数）
 */
const CMT_REACT_SEL = `select=${encodeURIComponent("comment_id,user_id,kind")}`;

/** 一批评论的全部回应明细（返回行里没有评论的就没有人点过） */
async function listCommentReactions(env, request, ids, limit) {
  const inList = encodeURIComponent(`in.(${ids.map((x) => `"${x}"`).join(",")})`);
  const res = await upstream(
    env, request,
    restUrl(env, TABLE.commentReactions, `${CMT_REACT_SEL}&comment_id=${inList}&limit=${limit}`),
  );
  return res || fail(502, "upstream-unreachable");
}

/** 我在这一批评论里点过的回应（只回 comment_id,kind —— user_id 由服务端条件固定，不接受客户端指定别的） */
async function listMyCommentReactions(env, request, ids, uid, limit) {
  const inList = encodeURIComponent(`in.(${ids.map((x) => `"${x}"`).join(",")})`);
  const sel = `select=${encodeURIComponent("comment_id,kind")}`;
  const res = await upstream(
    env, request,
    restUrl(env, TABLE.commentReactions, `${sel}&comment_id=${inList}&user_id=eq.${encodeURIComponent(uid)}&limit=${limit}`),
  );
  return res || fail(502, "upstream-unreachable");
}

/** 评论只取 post_id（聚合每帖条数） */
async function listCommentPostIds(env, request, ids, limit) {
  const inList = encodeURIComponent(`in.(${ids.map((x) => `"${x}"`).join(",")})`);
  const res = await upstream(env, request, restUrl(env, TABLE.comments, `select=post_id&post_id=${inList}&limit=${limit}`));
  return res || fail(502, "upstream-unreachable");
}

const REACT_SEL = `select=${encodeURIComponent("post_id,user_id,kind")}`;

/** ═══ 轮 169 · 暖心墙刷新合并包 ═══
 * 弱网真凶：刷新要串行跑 4~5 个网络来回（最新页→它的回应→随机批→它的回应→评论数），
 * 每个 RTT 在手机 4G 上都是 1s+。这里在 Worker 内并行打上游、打包一次回给客户端：
 * 手机只剩 1 个来回。响应 = { posts(最新4钉顶+随机批去重), reactions(明细,客户端聚合
 * 出计数与 mine), commentCounts({post_id: n}) }。随机+含用户身份混合 → 不进边缘缓存。 */
/** 从 JWT 里取 uid（只解 payload 不验签——仅用于「我点过哪些」的展示标记，安全由 RLS 管） */
function jwtUid(request) {
  const t = (request.headers.get("authorization") || "").replace(/^Bearer /, "");
  const parts = t.split(".");
  if (parts.length < 2) return "";
  try {
    const p = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    return p && p.sub ? p.sub : "";
  } catch (e) { return ""; }
}

async function wallRefresh(env, request, limit) {
  /* 轮 170：首选 RPC（wall_feed_page——一条 SQL 出合并包）；迁移还没跑（函数 404）时
   * 自动退回旧四查询编排并打包成同形响应，保证迁移前后都能用。 */
  const rpcRes = await rpc(env, request, "wall_feed_page", { p_limit: limit });
  if (rpcRes && rpcRes.ok) return rpcRes;
  return wallRefreshLegacy(env, request, limit);
}

async function wallRefreshLegacy(env, request, limit) {
  const now = Date.now();
  const anchor = new Date(now - 7 * 86400000 + Math.random() * 7 * 86400000).toISOString();
  const base = ["select=*", "removed=eq.false", "order=created_at.desc", `limit=${limit}`];
  const [a, b] = await Promise.all([
    upstream(env, request, restUrl(env, TABLE.posts, base.join("&"))),
    upstream(env, request, restUrl(env, TABLE.posts, [...base, `created_at=lte.${encodeURIComponent(anchor)}`].join("&"))),
  ]);
  if (!a || !a.ok) return fail(502, "upstream-unreachable");
  let latest = [], batch = [];
  try { latest = JSON.parse(await a.text()) || []; } catch (e) { latest = []; }
  if (b && b.ok) { try { batch = JSON.parse(await b.text()) || []; } catch (e) { batch = []; } }
  const seen = new Set();
  const merged = [];
  for (const r of latest.slice(0, 4)) if (r && r.id != null && !seen.has(r.id)) { seen.add(r.id); merged.push(r); }
  for (const r of batch) if (r && r.id != null && !seen.has(r.id)) { seen.add(r.id); merged.push(r); }
  for (const r of latest) if (r && r.id != null && !seen.has(r.id)) { seen.add(r.id); merged.push(r); }
  const ids = merged.map((r) => r.id).filter((x) => x != null);
  const [rk, cm] = await Promise.all([
    ids.length ? listReactionsByPosts(env, request, ids) : null,
    ids.length ? listCommentPostIds(env, request, ids, 2000) : null,
  ]);
  let reactions = [], cmtRows = [];
  if (rk && rk.ok) { try { reactions = JSON.parse(await rk.text()) || []; } catch (e) { reactions = []; } }
  if (cm && cm.ok) { try { cmtRows = JSON.parse(await cm.text()) || []; } catch (e) { cmtRows = []; } }
  /* 打包成与 RPC 同形：latest/random 数组 + react 聚合（mine 用 JWT uid）+ 评论计数 */
  const uid = jwtUid(request);
  const react = {};
  for (const r of reactions) {
    if (!r || r.post_id == null) continue;
    const o = react[r.post_id] || (react[r.post_id] = { hug: 0, warm: 0, relate: 0, mine: {} });
    if (o[r.kind] !== undefined) o[r.kind]++;
    if (uid && r.user_id === uid && o[r.kind] !== undefined) o[r.kind] = true;
  }
  const commentCounts = {};
  for (const c of cmtRows) if (c && c.post_id != null) commentCounts[c.post_id] = (commentCounts[c.post_id] || 0) + 1;
  return json({ latest: latest, random: batch, react, comment: commentCounts });
}

async function listReactionsByPosts(env, request, ids) {
  const inList = encodeURIComponent(`in.(${ids.map((x) => `"${x}"`).join(",")})`);
  const res = await upstream(env, request, restUrl(env, TABLE.reactions, `${REACT_SEL}&post_id=${inList}`));
  return res || fail(502, "upstream-unreachable");
}

async function listReactionsByPost(env, request, postId) {
  const res = await upstream(env, request, restUrl(env, TABLE.reactions, `${REACT_SEL}&post_id=eq.${encodeURIComponent(postId)}`));
  return res || fail(502, "upstream-unreachable");
}

/** 我有没有点过这种回应（object accept；无记录 → null） */
async function findReaction(env, request, q) {
  const parts = ["post_id", "user_id", "kind"].map((k) => `${k}=eq.${encodeURIComponent(q.get(k) || "")}`);
  const res = await upstream(env, request, restUrl(env, TABLE.reactions, `select=post_id&${parts.join("&")}`), {
    headers: { accept: OBJECT_ACCEPT },
  });
  return res ? objectOrPassthrough(res) : fail(502, "upstream-unreachable");
}

/** 插入（无 .select()：201 空 body） */
async function insertRow(env, request, table, body) {
  const res = await upstream(env, request, restUrl(env, table, ""), {
    method: "POST",
    body: JSON.stringify(body),
  });
  return res || fail(502, "upstream-unreachable");
}

/** 插入 + .single()：回传整行（return=representation + object accept） */
async function insertSingle(env, request, table) {
  const parsed = await readJson(request);
  if (parsed.err) return parsed.err;
  const res = await upstream(env, request, restUrl(env, table, ""), {
    method: "POST",
    body: JSON.stringify(parsed.body),
    headers: { accept: OBJECT_ACCEPT, prefer: "return=representation" },
  });
  return res || fail(502, "upstream-unreachable");
}

/** 删除（RLS 兜底：只能删自己的） */
async function deleteRows(env, request, table, qs) {
  const res = await upstream(env, request, restUrl(env, table, qs), { method: "DELETE" });
  return res || fail(502, "upstream-unreachable");
}

/** 管理员治理列表：固定列白名单（不透传 select 参数），新→旧 */
async function listAdminTable(env, request, table, columns, limit) {
  const res = await upstream(
    env, request,
    restUrl(env, table, `select=${encodeURIComponent(columns)}&order=created_at.desc&limit=${limit}`),
  );
  return res || fail(502, "upstream-unreachable");
}

/** 管理员局部更新（body 由路由白名单过滤后才到这里） */
async function patchRow(env, request, table, qs, patch) {
  const res = await upstream(env, request, restUrl(env, table, qs), {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return res || fail(502, "upstream-unreachable");
}

/** 陪你大厅状态上云：状态 key 白名单过滤（null=清除）+ 服务端盖时间戳（RLS self update 兜底只能写自己） */
async function setProfileStatus(env, request, uid, status) {
  if (!(status === null || VALID_STATUS.has(status))) return fail(400, "bad-status");
  const res = await upstream(env, request, restUrl(env, TABLE.profiles, `id=eq.${encodeURIComponent(uid)}`), {
    method: "PATCH",
    body: JSON.stringify({ status, status_at: new Date().toISOString() }),
  });
  return res || fail(502, "upstream-unreachable");
}

/** 大厅状态流：status 非空且 status_at ≥ since，新→旧；since 为空表示不做时间过滤（老客户端兜底） */
async function listProfileStatuses(env, request, limit, since) {
  const parts = [
    `select=${encodeURIComponent("id,nickname,status,status_at")}`,
    "status=not.is.null",
  ];
  if (since) parts.push(`status_at=gte.${encodeURIComponent(since)}`);
  parts.push("order=status_at.desc", `limit=${limit}`);
  const res = await upstream(env, request, restUrl(env, TABLE.profiles, parts.join("&")));
  return res || fail(502, "upstream-unreachable");
}

/** RPC：服务端权威逻辑（去重 / 计数 / 自动下架） */
async function rpc(env, request, name, params) {
  const res = await upstream(env, request, restUrl(env, `rpc/${name}`, ""), {
    method: "POST",
    body: JSON.stringify(params ?? {}),
  });
  return res || fail(502, "upstream-unreachable");
}

/** 宠物主页行：先带 pats/feeds 计数列；列不存在（非 406 的错误）退回只读 data（与直连模式对齐） */
async function getPet(env, request, uid) {
  const id = `user_id=eq.${encodeURIComponent(uid)}`;
  const attempt = (select) =>
    upstream(env, request, restUrl(env, TABLE.pet, `select=${encodeURIComponent(select)}&${id}`), {
      headers: { accept: OBJECT_ACCEPT },
    });
  let res = await attempt("data,pats,feeds");
  if (!res) return fail(502, "upstream-unreachable");
  if (!res.ok && res.status !== 406) {
    res = await attempt("data");
    if (!res) return fail(502, "upstream-unreachable");
  }
  return objectOrPassthrough(res);
}

/** 主人推送展示镜像：merge-duplicates 整行 upsert（payload 由前端红线约束：绝不带计数） */
async function upsertPet(env, request, body) {
  const res = await upstream(env, request, restUrl(env, TABLE.pet, "on_conflict=user_id"), {
    method: "POST",
    body: JSON.stringify(body),
    headers: { prefer: "resolution=merge-duplicates" },
  });
  return res || fail(502, "upstream-unreachable");
}

/** 图片上传：转发到 Storage（鉴权同 REST：JWT 透传 → storage 策略按 <uid>/ 前缀授权） */
async function upload(env, request, url) {
  const path = safeImagePath(url.searchParams.get("path") || "");
  if (!path) return fail(400, "bad-path");
  let buf;
  try {
    buf = await request.arrayBuffer();
  } catch (e) {
    return fail(400, "bad-body");
  }
  if (buf.byteLength > UPLOAD_BODY_MAX) return fail(413, "payload-too-large");
  if (!buf.byteLength) return fail(400, "empty-body");
  const extra = { "content-type": request.headers.get("content-type") || "application/octet-stream" };
  if (url.searchParams.get("upsert") === "1") extra["x-upsert"] = "true";
  const res = await upstream(
    env, request,
    `${env.SUPABASE_URL}/storage/v1/object/${IMAGE_BUCKET}/${path.split("/").map(encodeURIComponent).join("/")}`,
    { method: "POST", body: buf, headers: extra },
  );
  return res || fail(502, "upstream-unreachable");
}

/** 公开图：边缘缓存的字节代理（取代原先的 302 直连 Storage）
 *
 *  为什么改：302 只是把浏览器甩去 Storage 直连 ——  跨用户完全不共享，
 *  每个新访客的每张图都算一次 Supabase egress（免费额度 5GB/月主要被这项吃掉）。
 *  改成 Worker 取字节 + Cache API 长效缓存后，同一张图在边缘只回源一次，
 *  图片出口量降到约 1/N（N = 同一张图被看的次数）。
 *
 *  为什么敢 immutable：路径是 `<uid>/<时间戳|内容哈希>.<ext>`，且上传一律 upsert=false
 *  （宠物图是同内容同哈希覆盖）→ 同一 URL 的字节永不改变，永久缓存是安全的。
 *
 *  为什么不白块：上游取不到（网络抖动/Storage 报错）时退回 302 直连 ——
 *  图仍能显示，最差退化成改造前的行为。
 */
async function imgResponse(env, request, ctx, rawSegs) {
  const path = safeImagePath(rawSegs.join("/"));
  if (!path) return fail(400, "bad-path");

  const upstreamUrl = `${env.SUPABASE_URL}/storage/v1/object/public/${IMAGE_BUCKET}/${path.split("/").map(encodeURIComponent).join("/")}`;
  /* 兜底：与改造前完全一致的 302（location 指向 Storage 公开地址） */
  const fallback = (why) => new Response(null, {
    status: 302,
    headers: { location: upstreamUrl, "cache-control": CACHE_IMMUTABLE, "x-img-cache": why },
  });

  /* Node 测试环境 / 无 Cache API 的运行时：跳过缓存，仍代理字节（行为正确，只是不共享） */
  const store = typeof caches !== "undefined" && caches && caches.default ? caches.default : null;
  const key = store ? new Request(new URL(`/api/img/${path}`, request.url).toString(), { method: "GET" }) : null;
  if (store) {
    try {
      const hitRes = await store.match(key);
      if (hitRes) {
        const h = new Headers(hitRes.headers);
        h.set("x-img-cache", "HIT");
        return new Response(hitRes.body, { status: 200, headers: h });
      }
    } catch (e) { /* 读缓存失败不该让图挂掉：继续回源 */ }
  }

  let up = null;
  try {
    up = await fetch(upstreamUrl);
  } catch (e) {
    up = null;
  }
  if (!up || !up.ok) return fallback("FALLBACK"); /* 上游不可用 / 图不存在 → 交回浏览器直连 */

  const headers = new Headers();
  for (const k of ["content-type", "content-length", "etag", "last-modified"]) {
    const v = up.headers.get(k);
    if (v) headers.set(k, v);
  }
  headers.set("cache-control", CACHE_IMMUTABLE);
  headers.set("access-control-allow-origin", "*");
  headers.set("x-img-cache", store ? "MISS" : "BYPASS");

  let buf;
  try {
    buf = await up.arrayBuffer();
  } catch (e) {
    return fallback("FALLBACK");
  }

  /* 写边缘缓存：失败不影响本次响应（waitUntil 里再兜一层） */
  if (store && ctx && typeof ctx.waitUntil === "function") {
    const toCache = new Response(buf.slice(0), { status: 200, headers: new Headers(headers) });
    ctx.waitUntil(store.put(key, toCache).catch(() => {}));
  }
  return new Response(buf, { status: 200, headers });
}




/* ──────── 轮 85 · SEO 组合（/post 深链回壳 + /u noindex + 动态 sitemap） ──────── */

/** 帖子查询（带 removed 列降级）：老库无该列时 PostgREST 400 → 去掉过滤重试一次，
 * 与单帖接口 objectOrPassthrough 上方的 attempt 口径一致。 */
async function postsQuery(env, request, qs) {
  const attempt = (withRemoved) =>
    upstream(env, request, restUrl(env, TABLE.posts, withRemoved ? `${qs}&removed=eq.false` : qs));
  let res = await attempt(true);
  if (res && !res.ok && res.status === 400) res = await attempt(false);
  return res;
}

/** /post/:id 取帖子行（存在性 + ①c 注入共用）：确认存在才返回行；上游挂/查无 → null（宁可真 404 不发软 200） */
async function getPostRow(env, request, id) {
  const res = await postsQuery(env, request, `select=${encodeURIComponent("id,body,author_name,created_at,image_path")}&id=eq.${encodeURIComponent(id)}&limit=1`);
  if (!res || !res.ok) return null;
  try {
    const rows = await res.json();
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  } catch (e) {
    return null;
  }
}

/** 轮 145 · /story/:id 取故事行（存在性 + 壳注入共用）：查无/上游挂 → null（宁可真 404 不发软 200）。
 *  story_get 是 security definer：published 全员可读（含未登录 anon），未发布只有本人查得到。 */
async function getStoryRow(env, request, id) {
  const res = await rpc(env, request, "story_get", { p_id: Number(id) });
  if (!res || !res.ok) return null;
  try {
    const rows = await res.json();
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  } catch (e) {
    return null;
  }
}

/** 轮 145 · 把故事标题/正文/OG 注入 SPA 壳（口径同 postShellHtml）。
 *  正文只注入前 INJECT_MAX 码点：壳是给不执行 JS 的抓取方读的，全文（≤3 万字）塞进去
 *  会让每个深链的 HTML 涨到 ~100KB；截断后仍带真实标题/开头/发布时间，够收录与分享卡用。 */
const STORY_INJECT_MAX = 4000;
function storyShellHtml(shellHtml, row, origin) {
  const full = String(row.body || "").trim();
  const cut = [...full].slice(0, STORY_INJECT_MAX).join("");
  const more = [...full].length > STORY_INJECT_MAX;
  const flat = full.replace(/\s+/g, " ");
  const t2 = escapeHtmlWorker(flat ? flat.slice(0, 60) : row.title || "A story");
  const d = escapeHtmlWorker(flat ? flat.slice(0, 160) : String(row.title || "A gentle story on Warm Paws."));
  const paras = cut ? cut.split(/\n+/).filter(Boolean).map((x) => `<p>${escapeHtmlWorker(x)}</p>`).join("") : "";
  const content = `<div class="seo-static"><section class="card seo-hero"><h2 class="seo-title">${t2}</h2>${paras}${more ? "<p>…</p>" : ""}<p>${escapeHtmlWorker(row.nickname || "A gentle writer")}</p></section></div>`;
  let h = shellHtml;
  h = h.replace(/<title>[\s\S]*?<\/title>/, `<title>${t2} · Warm Paws</title>`);
  h = h.replace(/<meta\s+name="description"[\s\S]*?\/>/, `<meta name="description" content="${d}" />`);
  h = h.replace(/<link rel="canonical" href="[^"]*"/, `<link rel="canonical" href="${origin}/story/${row.id}"`);
  h = h.replace(/<meta property="og:url" content="[^"]*"/, `<meta property="og:url" content="${origin}/story/${row.id}"`);
  h = h.split(ROOT_TITLE_CONTENT).join(`content="${t2} · Warm Paws"`);
  h = h.split(ROOT_DESC_CONTENT).join(`content="${d}"`);
  h = h.replace(/<div class="seo-static">[\s\S]*?<\/section>\s*<\/div>/, content);
  return h;
}

/* 与 vite.config.js seoRoutes 的 ROOT_DESC 同源（og:description / twitter:description 共用占位串）
 * —— 两处是复制粘贴的兄弟代码，改一处必改另一处（踩坑 #28 口径）。 */
const ROOT_DESC_CONTENT = 'content="Care for a little pet, draw its food, share kindness with gentle people."';
const ROOT_TITLE_CONTENT = 'content="Warm Paws · A gentle place to be"';

function escapeHtmlWorker(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** ①c：把帖子标题/正文/OG 注入 SPA 壳 —— 爬虫（不执行 JS）读到这一页真实内容；
 * 正文包在 .seo-static 里（轮 83 内联规则对有 JS 的真人首帧前隐藏），挂载后 Vue 接管。
 * 根壳的 #app 里是家页 hero（内无嵌套 div），整块替换成帖子正文，避免每帖都带家页文案。 */
function postShellHtml(shellHtml, row, origin, env) {
  const body = String(row.body || "").trim();
  const who = escapeHtmlWorker(row.author_name || "Guest");
  const day = escapeHtmlWorker(String(row.created_at || "").slice(0, 10));
  /* 标题/描述压平空白（正文里的 \n 不能带进 <title>/meta） */
  const flat = body.replace(/\s+/g, " ");
  const titleText = flat ? flat.slice(0, 60) : `${row.author_name || "Guest"} shared a post`;
  const descText = flat ? flat.slice(0, 160) : `${row.author_name || "Guest"} shared a post on the Warm Paws kindness wall.`;
  const t = escapeHtmlWorker(titleText);
  const d = escapeHtmlWorker(descText);
  const paras = body ? body.split(/\n+/).filter(Boolean).map((x) => `<p>${escapeHtmlWorker(x)}</p>`).join("") : "";
  const imgUrl = row.image_path
    ? `${env.SUPABASE_URL}/storage/v1/object/public/${IMAGE_BUCKET}/${row.image_path.split("/").map(encodeURIComponent).join("/")}`
    : "";
  const content = `<div class="seo-static"><section class="card seo-hero"><h2 class="seo-title">${t}</h2>${paras}${imgUrl}<p>${who} · ${day}</p></section></div>`;
  let h = shellHtml;
  h = h.replace(/<title>[\s\S]*?<\/title>/, `<title>${t} · Warm Paws</title>`);
  h = h.replace(/<meta\s+name="description"[\s\S]*?\/>/, `<meta name="description" content="${d}" />`);
  h = h.replace(/<link rel="canonical" href="[^"]*"/, `<link rel="canonical" href="${origin}/post/${row.id}"`);
  h = h.replace(/<meta property="og:url" content="[^"]*"/, `<meta property="og:url" content="${origin}/post/${row.id}"`);
  h = h.split(ROOT_TITLE_CONTENT).join(`content="${t} · Warm Paws"`);
  h = h.split(ROOT_DESC_CONTENT).join(`content="${d}"`);
  if (imgUrl) h = h.replace(/<meta property="og:image" content="[^"]*"/, `<meta property="og:image" content="${imgUrl}"`);
  h = h.replace(/<div class="seo-static">[\s\S]*?<\/section>\s*<\/div>/, content);
  return h;
}

/** 动态 sitemap：固定 5 页（lastmod=今天）+ 最新 100 帖的 /post/:id 深链（lastmod=发帖日）。
 * dist 里的静态 sitemap.xml 只有 5 个固定页 —— 帖子是这个站最大的长尾内容，得让 Google
 * 知道它们存在。origin 取请求本身（换域名这份代码零改动）；上游挂 → 降级成只含固定 5 页
 * 的合法 XML（Google 下次抓取自然重试），不会 5xx。 */
async function sitemap(env, request, url) {
  const origin = url.origin;
  const today = new Date().toISOString().slice(0, 10);
  const fixed = [
    ["", "1.0"], ["/pet", "0.9"], ["/community", "0.9"], ["/profile", "0.5"], ["/privacy", "0.3"],
    /* 轮 86：/zh/* 中文预渲染页（与 en 页 hreflang 互指） */
    ["/zh", "1.0"], ["/zh/pet", "0.9"], ["/zh/community", "0.9"], ["/zh/profile", "0.5"], ["/zh/privacy", "0.3"],
  ];
  let posts = [];
  const res = await postsQuery(env, request, `select=${encodeURIComponent("id,created_at")}&order=id.desc&limit=100`);
  if (res && res.ok) {
    try { posts = await res.json(); } catch (e) { posts = []; }
  }
  if (!Array.isArray(posts)) posts = [];
  const parts = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ];
  for (const [p, pr] of fixed) {
    parts.push(`<url><loc>${origin}${p}</loc><lastmod>${today}</lastmod><priority>${pr}</priority></url>`);
  }
  for (const r of posts) {
    if (r && r.id != null) {
      parts.push(`<url><loc>${origin}/post/${r.id}</loc><lastmod>${String(r.created_at || "").slice(0, 10)}</lastmod></url>`);
    }
  }
  parts.push("</urlset>");
  return new Response(parts.join("\n"), {
    status: 200,
    headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" },
  });
}

/* ══════════ 路由分发 ══════════ */

/** ══════════ 轮 149 · 边缘缓存（只缓存「公开 + 匿名」的读接口）
 *
 * 为什么加：实测同一 URL /api/posts?limit=12 连打 6 次，耗时在
 *   861 / 3637 / 771 / 4669 / 9633 ms 之间跳 —— 差 12 倍。
 *   代码侧已排除瓶颈（索引齐全、无 N+1、串行 await 无、limit=12 反而比 50 慢），
 *   这是Cloudflare 免费版 isolate 被回收后的冷启动抖动，不是 SQL 慢。
 *
 * 怎么绕：把公开读接口的结果放进 caches.default，命中时由 Cloudflare 边缘直接返回，
 *   **根本不进isolate**，冷启动那一下被抹掉。
 *
 * 三条红线（破了就是数据泄露/功能错乱，不是性能问题）：
 *   1. 只 GET —— 写接口绝不能缓存；
 *   2. 携带 Authorization / apikey 一律不缓存 —— 登录用户的响应是「他自己的」数据，
 *      拿 anon 缓存键存进去会把 A 的私信发给 B。这条比第 1 条更要命；
 *   3. 只缓存白名单前缀 —— /api/story/mine、/api/notif、/api/dm 等一律不碰。
 * 缓存键只吃 path+query（不含任何身份头），命中即匿名视角，安全。
 */
const CACHE_TTL_SEC = 30;
/* 白名单：仅「任何人可读、内容公开、变化不频繁」的列表/详情。
   注意 /api/story/mine、/api/story/stats、/api/fav、/api/dm*、/api/notif* 不在其中。 */
const CACHEABLE = [
  /^\/api\/posts$/,          /* 墙列表（含 sample 换一批：随机结果，缓存 30s 可接受） */
  /^\/api\/story$/,          /* 故事流（发现页） */
  /^\/api\/story\/rank$/,    /* 四榜 */
  /^\/api\/story\/featured$/,
  /^\/api\/story\/\d+$/,     /* 故事详情 */
];
const cacheablePath = (p) => CACHEABLE.some((re) => re.test(p));
/** 带了任何身份凭证就一律不进缓存（见红线 2） */
const hasAuth = (req) =>
  req.headers.has("authorization") || req.headers.has("apikey") || req.headers.has("x-client-info");

/* 轮 149：原来这里直接是 `export default { async fetch(...) }`。
 * 现在把真逻辑挪进 handleApi()，export.fetch 只做一件事：缓存的前后各一道门。
 * 这样 try 里上百个 return 一行都不用动（改不动，也不该动）。 */
async function handleApi(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") return corsPreflight(request);

    /* ══════════ 轮 23：/sb/* 透明代理到 Supabase ══════════
     * 为什么：国内网络直连 *.supabase.co 间歇被 TLS 重置（手机 App logcat 实锤
     * SSL handshake failed / net_error -101 → 所有账号都登录不上、请求 fail to fetch）。
     * supabase-js 的全部流量（auth / REST / Storage）统一改走本域 /sb/*，由 Worker
     * 原样转发（路径 / query / 头 / body 全透传，响应流式回传）。
     * 安全口径不变：apikey / Authorization 由客户端携带，RLS 仍在数据库执行。 */
    if (path === "/sb" || path.startsWith("/sb/")) {
      if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return fail(503, "worker-not-configured");
      const target = env.SUPABASE_URL.replace(/\/$/, "") + path.slice(3) + url.search;
      const headers = new Headers(request.headers);
      if (!headers.has("apikey")) headers.set("apikey", env.SUPABASE_ANON_KEY);
      headers.delete("host");
      let body = null;
      if (request.method !== "GET" && request.method !== "HEAD") body = await request.arrayBuffer();
      let resp;
      try {
        resp = await fetch(target, { method: request.method, headers, body, redirect: "manual" });
      } catch (e) {
        return fail(502, "upstream-unreachable");
      }
      const out = new Headers(resp.headers);
      out.set("access-control-allow-origin", "*");
      out.set("access-control-expose-headers", "*");
      /* body 原样流式透传（不动 content-encoding/length，浏览器自己解压） */
      return new Response(resp.body, { status: resp.status, headers: out });
    }

    /* ──────── 轮 85：动态 sitemap 拦截在静态资产之前（上游挂时函数内降级为固定 5 页） ──────── */
    if (path === "/sitemap.xml" && request.method === "GET") return sitemap(env, request, url);

    /* 非 /api/*：静态资源优先；**动态路由回退**（/u/:id 他人主页、/messages/:id 直链会话
     * 没有预渲染文件，assets 会给真 404）→ 404 时改发 SPA 壳（根 index.html，200），
     * 前端路由接管渲染。未知乱路径仍维持真 404（防软 404，SEO 口径不变）。
     * 轮 85 ③：/u/:id 的壳注入 noindex（他人主页是薄内容壳，防稀释整站质量；follow 保留）——
     *   就地替换根壳的 robots meta，并抹掉 etag（body 已变，原 etag 不再成立）。
     * 轮 85 ①b：/post/:id 深链回壳前**先查帖子存在性**——查无/上游挂维持真 404
     *   （软 404 是轮 11 定案红线；帖子被删/乱 id 决不能变 200）。 */
    if (path !== "/api" && !path.startsWith("/api/")) {
      if (!env.ASSETS) return fail(404, "not-found");
      const res = await env.ASSETS.fetch(request);
      if (res.status === 404 && (path.startsWith("/u/") || path.startsWith("/messages/"))) {
        const shell = await env.ASSETS.fetch(new URL("/", url.origin));
        if (shell && shell.ok) {
          if (path.startsWith("/u/")) {
            try {
              const html = await shell.text();
              const injected = html.replace(
                '<meta name="robots" content="index, follow" />',
                '<meta name="robots" content="noindex, follow" />',
              );
              const headers = new Headers(shell.headers);
              headers.delete("etag");
              headers.delete("content-length");
              return new Response(injected, { status: 200, headers });
            } catch (e) {
              return shell;   /* 注入失败退回原壳（有壳总比没有强） */
            }
          }
          return shell;
        }
      }
      if (res.status === 404 && path.startsWith("/post/")) {
        const id = decodeSeg(decodeURIComponent(path.slice("/post/".length)).split("/")[0] || "");
        if (id && /^[0-9]+$/.test(id)) {
          const row = await getPostRow(env, request, id);
          if (row) {
            const shell = await env.ASSETS.fetch(new URL("/", url.origin));
            if (shell && shell.ok) {
              try {
                const html = await shell.text();
                const headers = new Headers(shell.headers);
                headers.delete("etag");
                headers.delete("content-length");
                return new Response(postShellHtml(html, row, url.origin, env), { status: 200, headers });
              } catch (e) {
                return shell;   /* 注入失败退回原壳（有壳总比没有强） */
              }
            }
          }
          /* 查无此帖 / 上游挂 → 落到下面的真 404 */
        }
      }
      /* 轮 145 · /story/:id 故事深链：同 post 口径 —— 先在 story_get 里确认存在（published 或本人），
         查无/上游挂维持真 404（软 404 红线不动）；存在则回壳并注入标题/正文开头/OG。 */
      if (res.status === 404 && path.startsWith("/story/")) {
        const id = decodeSeg(decodeURIComponent(path.slice("/story/".length)).split("/")[0] || "");
        if (id && /^[0-9]+$/.test(id)) {
          const row = await getStoryRow(env, request, id);
          if (row) {
            const shell = await env.ASSETS.fetch(new URL("/", url.origin));
            if (shell && shell.ok) {
              try {
                const html = await shell.text();
                const headers = new Headers(shell.headers);
                headers.delete("etag");
                headers.delete("content-length");
                return new Response(storyShellHtml(html, row, url.origin), { status: 200, headers });
              } catch (e) {
                return shell;
              }
            }
          }
        }
      }
      return res;
    }
    if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return fail(503, "worker-not-configured");

    const seg = path.slice(4).split("/").filter(Boolean); /* 去掉 "/api" 前缀 */
    const m = request.method;
    const q = url.searchParams;

    try {
      /* —— 健康 / 图片 / 上传 —— */
      if (seg[0] === "health") {
        return m === "GET" ? json({ ok: true, mode: "gateway", ts: Date.now() }) : fail(405, "method-not-allowed");
      }
      /* 轮 256 · 客户端错误信标：前端 utils/beacon.js 把未捕获错误/拒绝 POST 过来。
       * 这里做 白名单字段 + 截断 + 限频；只用 cf-connecting-ip 限频，不解析任何凭据。
       * 轮 270 · 此前只 console.log 进 Cloudflare 临时日志区 —— 采得到、看不到、回溯不了；
       * 现在额外落库到 client_logs（经 security definer RPC；Worker 只有 anon key、没有 service role）。
       * 落库是**尽力而为**：迁移未执行 / 上游不可达 / 被 SQL 侧防灌闸丢弃，一律不影响本接口
       * 返回 {ok:true} —— 信标的铁律是「绝不给本就出错的页面再加一次失败」。 */
      if (seg[0] === "client-log") {
        if (m !== "POST") return fail(405, "method-not-allowed");
        const b = await readJson(request);
        if (b.err) return b.err;
        const t = b.body || {};
        const now = Date.now();
        const ip = request.headers.get("cf-connecting-ip") || "anon";
        if (!clientLogRL) clientLogRL = new Map();
        let slot = clientLogRL.get(ip);
        if (!slot || now - slot.ts > 60000) { slot = { ts: now, n: 0 }; clientLogRL.set(ip, slot); }
        slot.n++;
        if (clientLogRL.size > 5000) clientLogRL = new Map(); /* 容量兜底：防内存被刷大 */
        if (slot.n > 20) return fail(429, "rate-limited");
        const kind = t.kind === "rej" ? "rej" : "err";
        const msg = typeof t.msg === "string" ? t.msg.slice(0, 300) : "";
        const route = typeof t.route === "string" ? t.route.slice(0, 120) : "";
        const stack = typeof t.stack === "string" ? t.stack.slice(0, 1200) : "";
        const ua = typeof t.ua === "string" ? t.ua.slice(0, 160) : "";
        console.log(JSON.stringify({ evt: "client-log", kind, msg, route, stack, ua, ts: now }));
        try {
          /* SQL 里会再夹一次字段并查每 IP / 全局日上限（纵深防御） */
          await rpc(env, request, "client_log_write", {
            p_kind: kind, p_msg: msg, p_route: route, p_stack: stack, p_ua: ua, p_ip: ip,
          });
        } catch { /* 落库失败静默吞掉：信标不向客户端报错、不重试 */ }
        return json({ ok: true });
      }
      if (seg[0] === "img") {
        return m === "GET" ? imgResponse(env, request, ctx, seg.slice(1)) : fail(405, "method-not-allowed");
      }
      if (seg[0] === "uploads") {
        return m === "POST" ? upload(env, request, url) : fail(405, "method-not-allowed");
      }

      /* —— 账号：自助删号（App 上架 Play 2024 政策硬门槛；T3）—— */
      if (seg[0] === "account" && seg[1] === "delete") {
        return m === "POST" ? rpc(env, request, "delete_my_account", {}) : fail(405, "method-not-allowed");
      }

      /* —— 帖子收藏夹（轮 128 / #13）：三件事全靠 RLS——列表/批量查只回本人的收藏，
         插入用 default auth.uid() 盖章（客户端只传 post_id），删除只能删自己的。
         Worker 不解析 JWT、不做身份参数透传；post_id 只认数字。 —— */
      if (seg[0] === "fav") {
        if (seg.length === 1 && m === "GET") {
          /* 我的收藏（含内嵌帖子）：created_at 倒序；被下架/删除的帖 embed 会置 null，由前端过滤 */
          const lim = parseLimit(q.get("limit"), 50);
          const off = Number(q.get("offset")) > 0 ? Number(q.get("offset")) : 0;
          const qs = `select=created_at,post:wall_posts(id,user_id,author_name,body,image_path,created_at,views)&order=created_at.desc&limit=${lim}&offset=${off}`;
          const res = await upstream(env, request, restUrl(env, TABLE.favorites, qs));
          return res || fail(502, "upstream-unreachable");
        }
        if (seg.length === 1 && m === "POST") {
          const b = await readJson(request);
          if (b.err) return b.err;
          const pid = Number(b.body && b.body.post_id);
          if (!/^[0-9]+$/.test(String(b.body && b.body.post_id)) || pid <= 0) return fail(400, "bad-post-id");
          /* 内联插入：insertSingle 会再读一次 body（已消费 → bad-body），这里同一次读取里校验+写库 */
          const res = await upstream(env, request, restUrl(env, TABLE.favorites, ""), {
            method: "POST",
            body: JSON.stringify({ post_id: pid }),
            headers: { accept: OBJECT_ACCEPT, prefer: "return=representation" },
          });
          return res || fail(502, "upstream-unreachable");
        }
        if (seg.length === 1 && m === "DELETE") {
          const pid = q.get("post_id") || "";
          if (!/^[0-9]+$/.test(pid)) return fail(400, "bad-post-id");
          return deleteRows(env, request, TABLE.favorites, `post_id=eq.${pid}`);
        }
        if (seg[1] === "check" && seg.length === 2 && m === "GET") {
          /* 批量查「这些帖子里我收藏了哪些」：ids=1,2,3 → 只回命中且属于本人的 post_id */
          const ids = (q.get("ids") || "").split(",").filter((x) => /^[0-9]+$/.test(x.trim()));
          if (!ids.length) return json({ ids: [] });
          const qs = `select=post_id&post_id=in.(${ids.map((x) => x.trim()).join(",")})`;
          const res = await upstream(env, request, restUrl(env, TABLE.favorites, qs));
          if (!res) return fail(502, "upstream-unreachable");
          if (!res.ok) return res;
          const rows = await res.json().catch(() => []);
          return json({ ids: rows.map((r) => r.post_id) });
        }
        return fail(404, "not-found");
      }

      /* —— 暖心墙刷新合并包（轮 169）—— */
      if (seg[0] === "wall" && seg[1] === "refresh") {
        if (m === "GET") return wallRefresh(env, request, parseLimit(q.get("limit"), 20));
        return fail(405, "bad-method");
      }

      /* —— 帖子 —— */
      if (seg[0] === "posts") {
        /* 轮 252：搜索 / 列探测要抢在「单帖 id」分支前拦下（decodeSeg("search") 不是空值） */
        if (seg.length === 2 && seg[1] === "columns" && m === "GET") return probePostColumns(env, request);
        if (seg.length === 2 && seg[1] === "search" && m === "GET") return searchPosts(env, request, q);
        if (seg.length === 1) {
          if (m === "GET") {
            const bidRaw = q.get("before_id") || "";
            const bid = /^\d+$/.test(bidRaw) ? Number(bidRaw) : 0;
            if (q.get("sample") === "1") {
              const since = /^\d{4}-\d{2}-\d{2}T/.test(q.get("since") || "") ? q.get("since") : "";
              return samplePosts(env, request, parseLimit(q.get("limit"), 50), since);
            }
            return listPosts(env, request, "", parseLimit(q.get("limit"), 200), parseOffset(q.get("offset")), bid);
          }
          if (m === "POST") return insertSingle(env, request, TABLE.posts);
        } else if (seg.length === 3) {
          const id = decodeSeg(seg[1]);
          if (!id) return fail(400, "bad-id");
          if (seg[2] === "comments") {
            if (m === "GET") return listComments(env, request, id, parseLimit(q.get("limit"), 200));
            if (m === "POST") return insertSingle(env, request, TABLE.comments);
          }
          if (seg[2] === "reactions" && m === "GET") return listReactionsByPost(env, request, id);
          if (seg[2] === "view" && m === "POST") {
            const b = await readJson(request);
            if (b.err) return b.err;
            return rpc(env, request, "wall_add_view", { p_post: id, p_viewer: b.body.viewer });
          }
          if (seg[2] === "dislike" && m === "POST") {
            return rpc(env, request, "wall_toggle_dislike", { p_post: id });
          }
        } else if (seg.length === 2 && m === "GET") {
          /* 单帖（轮 19 帖子详情页）：objectOrPassthrough 把「行不存在」翻成 200 null；
           * 老库无 removed 列（PostgREST 400）时去掉过滤重试一次 */
          const id = decodeSeg(seg[1]);
          if (!id) return fail(400, "bad-id");
          const attempt = (withRemoved) =>
            upstream(
              env, request,
              restUrl(env, TABLE.posts, `select=${encodeURIComponent("*")}&id=eq.${encodeURIComponent(id)}${withRemoved ? "&removed=eq.false" : ""}`),
              { headers: { accept: OBJECT_ACCEPT } },
            );
          let res = await attempt(true);
          if (!res) return fail(502, "upstream-unreachable");
          if (!res.ok && res.status === 400) {
            res = await attempt(false);
            if (!res) return fail(502, "upstream-unreachable");
          }
          return objectOrPassthrough(res);
        }
      }

      /* —— 评论 —— */
      if (seg[0] === "comments") {
        if (seg.length === 1 && m === "POST") return insertSingle(env, request, TABLE.comments);
        if (seg.length === 2 && m === "DELETE") {
          const id = decodeSeg(seg[1]);
          if (!id) return fail(400, "bad-id");
          return deleteRows(env, request, TABLE.comments, `id=eq.${encodeURIComponent(id)}`);
        }
        /* —— 轮 84 · 评论回应（👍心 / 💔碎心）—— */
        if (seg.length === 2 && seg[1] === "reactions" && m === "GET") {
          const ids = parseIds(q.get("ids"));
          if (!ids.length) return fail(400, "bad-ids");
          return listCommentReactions(env, request, ids, parseLimit(q.get("limit"), 2000));
        }
        if (seg.length === 3 && seg[1] === "reactions" && seg[2] === "mine" && m === "GET") {
          const ids = parseIds(q.get("ids"));
          if (!ids.length) return fail(400, "bad-ids");
          const uid = (q.get("user_id") || "").trim();
          if (!uid) return fail(400, "bad-uid");
          return listMyCommentReactions(env, request, ids, uid, parseLimit(q.get("limit"), 2000));
        }
        if (seg.length === 2 && seg[1] === "react" && m === "POST") {
          const b = await readJson(request);
          if (b.err) return b.err;
          const id = Number(b.body && b.body.comment_id);
          const kind = b.body && b.body.kind;
          if (!Number.isFinite(id) || id <= 0) return fail(400, "bad-id");
          if (kind !== "heart" && kind !== "broken") return fail(400, "bad-kind");
          return rpc(env, request, "wall_toggle_comment_reaction", { p_comment: id, p_kind: kind });
        }
      }
      if (seg[0] === "comment-post-ids" && seg.length === 1 && m === "GET") {
        const ids = parseIds(q.get("ids"));
        if (!ids.length) return fail(400, "bad-ids");
        return listCommentPostIds(env, request, ids, parseLimit(q.get("limit"), 500));
      }

      /* —— 回应 —— */
      if (seg[0] === "reactions") {
        if (seg.length === 1) {
          if (m === "GET") {
            const ids = parseIds(q.get("ids"));
            if (!ids.length) return fail(400, "bad-ids");
            return listReactionsByPosts(env, request, ids);
          }
          if (m === "POST") {
            const b = await readJson(request);
            if (b.err) return b.err;
            return insertRow(env, request, TABLE.reactions, b.body);
          }
          if (m === "DELETE") {
            const parts = ["post_id", "user_id", "kind"].map((k) => `${k}=eq.${encodeURIComponent(q.get(k) || "")}`);
            return deleteRows(env, request, TABLE.reactions, parts.join("&"));
          }
        } else if (seg.length === 2 && seg[1] === "mine" && m === "GET") {
          return findReaction(env, request, q);
        }
      }

      /* —— 用户档案 —— */
      if (seg[0] === "users" && seg.length === 3) {
        const uid = decodeSeg(seg[1]);
        if (!uid) return fail(400, "bad-id");
        if (seg[2] === "posts" && m === "GET") {
          return listPosts(env, request, uid, parseLimit(q.get("limit"), 50), parseOffset(q.get("offset")));
        }
        if (seg[2] === "profile" && m === "GET") {
          /* 先带状态列；列不存在（老库未跑迁移）时退回两列查询（与直连模式对齐） */
          const attempt = (cols) =>
            upstream(
              env, request,
              restUrl(env, TABLE.profiles, `select=${encodeURIComponent(cols)}&id=eq.${encodeURIComponent(uid)}`),
              { headers: { accept: OBJECT_ACCEPT } },
            );
          let res = await attempt("nickname,created_at,status,status_at");
          if (!res) return fail(502, "upstream-unreachable");
          if (!res.ok && res.status !== 406) {
            res = await attempt("nickname,created_at");
            if (!res) return fail(502, "upstream-unreachable");
          }
          return objectOrPassthrough(res);
        }
        if (seg[2] === "status" && m === "PATCH") {
          /* 陪你大厅状态上云：路径里带 uid（RLS self update 兜底，JWT 透传由数据库校验） */
          const b = await readJson(request);
          if (b.err) return b.err;
          return setProfileStatus(env, request, uid, b.body.status);
        }
      }

      /* 大厅只返回精确人数，不返回任何用户身份字段。 */
      if (seg[0] === "statuses" && seg[1] === "counts" && seg.length === 2 && m === "GET") {
        const since = q.get("since") || new Date(Date.now() - 86400000).toISOString();
        if (!Number.isFinite(Date.parse(since))) return fail(400, "bad-since");
        const counts = await Promise.all([...VALID_STATUS].map(async (status) => {
          const res = await upstream(env, request, restUrl(env, TABLE.profiles,
            `select=id&status=eq.${status}&status_at=gte.${encodeURIComponent(since)}`), {
            method: "HEAD", headers: { prefer: "count=exact" },
          });
          if (!res || !res.ok) throw new Error("status-count-unavailable");
          const total = (res.headers.get("content-range") || "").split("/")[1];
          if (!/^\d+$/.test(total || "") || !Number.isSafeInteger(Number(total))) throw new Error("invalid-status-count");
          return { status, count: Number(total) };
        }));
        return json(counts, 200);
      }

      /* —— 陪你大厅状态流（近 24h 有状态的人，新→旧；匿名可读） —— */
      if (seg[0] === "statuses" && seg.length === 1 && m === "GET") {
        return listProfileStatuses(
          env, request,
          parseLimit(q.get("limit"), 50),
          q.get("since") || "",
        );
      }

      /* —— 宠物主页 —— */
      if (seg[0] === "pet" && seg.length === 2) {
        const uid = decodeSeg(seg[1]);
        if (!uid) return fail(400, "bad-id");
        if (m === "GET") return getPet(env, request, uid);
        if (m === "PUT") {
          const b = await readJson(request);
          if (b.err) return b.err;
          return upsertPet(env, request, b.body);
        }
      }
      if (seg[0] === "pet" && seg.length === 3 && seg[2] === "interact" && m === "POST") {
        const uid = decodeSeg(seg[1]);
        if (!uid) return fail(400, "bad-id");
        const b = await readJson(request);
        if (b.err) return b.err;
        return rpc(env, request, "pet_interact", { p_owner: uid, p_kind: b.body.kind, p_viewer: b.body.viewer });
      }

      /* —— 温暖漂流瓶（#6）：全部收口到 DB 里的 bottle_* RPC ——
         每日写 3 / 捞 7、不能捞自己的信、只有持有者能回 —— 权限与限额都在 RPC 里把关；
         Worker 只做入参体检（长度 / UUID 形状），错误信息原样透传给前端归类。 —— */
      if (seg[0] === "bottle") {
        const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (seg[1] === "send" && seg.length === 2 && m === "POST") {
          const b = await readJson(request);
          if (b.err) return b.err;
          const body = typeof b.body.body === "string" ? b.body.body.trim() : "";
          if (!body) return fail(400, "empty-body");
          if (body.length > 1000) return fail(400, "bottle-too-long");
          return rpc(env, request, "bottle_send", { p_body: body });
        }
        if (seg[1] === "fish" && seg.length === 2 && m === "POST") {
          return rpc(env, request, "bottle_fish", {});
        }
        if ((seg[1] === "reply" || seg[1] === "release") && seg.length === 2 && m === "POST") {
          const b = await readJson(request);
          if (b.err) return b.err;
          const id = typeof b.body.id === "string" ? b.body.id : "";
          if (!UUID_RE.test(id)) return fail(400, "bad-id");
          if (seg[1] === "release") return rpc(env, request, "bottle_release", { p_id: id });
          const reply = typeof b.body.reply === "string" ? b.body.reply.trim() : "";
          if (!reply) return fail(400, "empty-body");
          if (reply.length > 1000) return fail(400, "bottle-too-long");
          return rpc(env, request, "bottle_reply", { p_id: id, p_reply: reply });
        }
        if (seg[1] === "records" && seg.length === 2 && m === "GET") {
          const id = q.get("id") || null;
          if (id && !UUID_RE.test(id)) return fail(400, "bad-id");
          /* #17 记录分类与分页：mine=true/false 只看一类，limit 每页条数（缺省维持旧行为） */
          const mineRaw = (q.get("mine") || "").toLowerCase();
          const mine = mineRaw === "true" ? true : mineRaw === "false" ? false : null;
          const params = { p_id: id, p_offset: parseOffset(q.get("offset")) };
          if (mine !== null) params.p_mine = mine;
          if (q.get("limit")) params.p_limit = parseLimit(q.get("limit"), 30);
          return rpc(env, request, "bottle_records", params);
        }
        if (seg[1] === "chat" && seg.length === 2 && m === "POST") {
          const b = await readJson(request);
          if (b.err) return b.err;
          if (typeof b.body.id !== "string" || !UUID_RE.test(b.body.id)) return fail(400, "bad-id");
          if (typeof b.body.accept !== "boolean") return fail(400, "bottle-bad-decision");
          return rpc(env, request, "bottle_chat_decide", { p_id: b.body.id, p_accept: b.body.accept });
        }
        if (seg[1] === "mine" && seg.length === 2 && m === "GET") return rpc(env, request, "bottle_mine", {});
        if (seg[1] === "held" && seg.length === 2 && m === "GET") return rpc(env, request, "bottle_held", {});
        /* 轮 18：今日次数探针（服务端权威）——前端「还能捞 N 瓶」以它为准，跨端一致 */
        if (seg[1] === "quota" && seg.length === 2 && m === "GET") return rpc(env, request, "bottle_quota", {});
      }

      /* —— 故事栏（轮 145）：投稿 / 四榜 / 点赞，全部收口到 DB 里的 story_* RPC ——
         字数(≤3万) / 标签(1~3) / 限额 / 计数 / 随机种子都在 RPC 里把关；Worker 只做入参体检。
         字数用码点计数（[...s].length）与 PG 的 char_length 同口径，emoji 不会被算两次。 —— */
      if (seg[0] === "story") {
        /* POST /story/draft | /story/publish：{ id, title, body, tags } */
        if ((seg[1] === "draft" || seg[1] === "publish") && seg.length === 2 && m === "POST") {
          const b = await readJson(request);
          if (b.err) return b.err;
          const t = b.body || {};
          const title = typeof t.title === "string" ? t.title.trim() : "";
          const text = typeof t.body === "string" ? t.body : "";
          const tags = Array.isArray(t.tags) ? t.tags.slice(0, 5) : [];
          if ([...text].length > 30000) return fail(400, "story-too-long");
          if (seg[1] === "publish") {
            if (!title || [...title].length > 100) return fail(400, "story-bad-title");
            if (![...text].length) return fail(400, "story-empty-body");
            if ([...text].length < 100) return fail(400, "story-too-short");
            if (!tags.length) return fail(400, "story-bad-tags");
          }
          const rawId = t.id === null || t.id === undefined || t.id === "" ? null : Number(t.id);
          if (rawId !== null && (!Number.isInteger(rawId) || rawId <= 0)) return fail(400, "bad-id");
          return rpc(env, request, seg[1] === "draft" ? "story_save_draft" : "story_publish",
            { p_id: rawId, p_title: title, p_body: text, p_tags: tags });
        }
        /* POST /story/like | /story/view：{ id } */
        if ((seg[1] === "like" || seg[1] === "view") && seg.length === 2 && m === "POST") {
          const b = await readJson(request);
          if (b.err) return b.err;
          const id = Number((b.body || {}).id);
          if (!Number.isInteger(id) || id <= 0) return fail(400, "bad-id");
          return rpc(env, request, seg[1] === "like" ? "story_toggle_like" : "story_add_view", { p_id: id });
        }
        /* GET /story/rank?mode=&tag=&period=&limit=&offset= —— 一条 RPC 出四榜 */
        if (seg[1] === "rank" && seg.length === 2 && m === "GET") {
          const mode = (q.get("mode") || "random").toLowerCase();
          if (mode !== "random" && mode !== "latest" && mode !== "monthly" && mode !== "tag") {
            return fail(400, "story-bad-mode");
          }
          const params = {
            p_mode: mode,
            p_period: q.get("period") || null,
            p_limit: parseLimit(q.get("limit"), 20),
            p_offset: parseOffset(q.get("offset")),
          };
          const tag = (q.get("tag") || "").trim();
          if (tag) params.p_tag = tag.slice(0, 20);
          return rpc(env, request, "story_rank", params);
        }
        /* GET /story/mine?status=&limit=&offset= —— 我的草稿箱 + 已发布 */
        if (seg[1] === "mine" && seg.length === 2 && m === "GET") {
          const status = (q.get("status") || "").toLowerCase();
          const params = { p_limit: parseLimit(q.get("limit"), 30), p_offset: parseOffset(q.get("offset")) };
          if (status === "draft" || status === "published") params.p_status = status;
          return rpc(env, request, "story_mine", params);
        }

        /* ── 批 2：评论 / 书架 / 每日精选 / 数据面板 ──
           顺序要紧：字面量子路径必须排在下面那条「/story/:id」通用分支之前，
           否则 /story/featured 会被当成 id=NaN 掉进 bad-id。 */
        /* GET /story/featured —— 每日精选那篇（无 → 200 null，与直连同契约） */
        if (seg[1] === "featured" && seg.length === 2 && m === "GET") {
          const res = await rpc(env, request, "story_featured", {});
          if (!res.ok) return res;
          let arr = null;
          try { arr = await res.json(); } catch (e) { arr = null; }
          return json(Array.isArray(arr) ? (arr[0] || null) : (arr || null), 200);
        }
        /* GET /story/stats —— 我的数据面板（单行汇总） */
        if (seg[1] === "stats" && seg.length === 2 && m === "GET") {
          const res = await rpc(env, request, "story_my_stats", {});
          if (!res.ok) return res;
          let arr = null;
          try { arr = await res.json(); } catch (e) { arr = null; }
          return json(Array.isArray(arr) ? (arr[0] || null) : (arr || null), 200);
        }
        /* GET /story/bookmarks?limit=&offset= —— 我的书架 */
        if (seg[1] === "bookmarks" && seg.length === 2 && m === "GET") {
          return rpc(env, request, "story_bookmark_list", {
            p_limit: parseLimit(q.get("limit"), 30), p_offset: parseOffset(q.get("offset")),
          });
        }
        /* POST /story/bookmark —— 收藏/取消（body: {id}） */
        if (seg[1] === "bookmark" && seg.length === 2 && m === "POST") {
          const b = await readJson(request);
          if (b.err) return b.err;
          const id = Number((b.body || {}).id);
          if (!Number.isInteger(id) || id <= 0) return fail(400, "bad-id");
          return rpc(env, request, "story_toggle_bookmark", { p_id: id });
        }
        /* DELETE /story/comments/:id —— 删评论（评论作者或故事作者） */
        if (seg[1] === "comments" && seg.length === 3 && m === "DELETE") {
          const id = Number(seg[2]);
          if (!Number.isInteger(id) || id <= 0) return fail(400, "bad-id");
          return rpc(env, request, "story_delete_comment", { p_id: id });
        }
        /* GET /story/:id/comments?limit= —— 评论列表 */
        if (seg.length === 3 && seg[2] === "comments" && m === "GET") {
          const id = Number(seg[1]);
          if (!Number.isInteger(id) || id <= 0) return fail(400, "bad-id");
          return rpc(env, request, "story_comment_list", {
            p_story_id: id, p_limit: parseLimit(q.get("limit"), 50),
          });
        }
        /* POST /story/:id/comments —— 发评论（body ≤1000 字，入参体检） */
        if (seg.length === 3 && seg[2] === "comments" && m === "POST") {
          const id = Number(seg[1]);
          if (!Number.isInteger(id) || id <= 0) return fail(400, "bad-id");
          const b = await readJson(request);
          if (b.err) return b.err;
          const body = typeof (b.body || {}).body === "string" ? b.body.body.trim() : "";
          if (!body) return fail(400, "story-comment-empty");
          if (body.length > 1000) return fail(400, "story-comment-long");
          return rpc(env, request, "story_add_comment", { p_story_id: id, p_body: body });
        }
        /* GET /story/:id —— 未发布且非本人 → 200 null（与直连实现的 maybeSingle 同契约） */
        if (seg.length === 2 && m === "GET") {
          const id = Number(seg[1]);
          if (!Number.isInteger(id) || id <= 0) return fail(400, "bad-id");
          const res = await rpc(env, request, "story_get", { p_id: id });
          if (!res.ok) return res;
          let arr = null;
          try { arr = await res.json(); } catch (e) { arr = null; }
          return json(Array.isArray(arr) ? (arr[0] || null) : (arr || null), 200);
        }
      }

      /* —— 举报（轮 33：帖子/评论；防刷限频与评论 ≥3 人自动隐藏都在 RPC 里） —— */
      if (seg[0] === "reports" && seg.length === 1 && m === "POST") {
        const b = await readJson(request);
        if (b.err) return b.err;
        const t = b.body || {};
        return rpc(env, request, "report_create", {
          p_target_type: typeof t.target_type === "string" ? t.target_type : "",
          p_target_id: Number(t.target_id) || 0,
          p_reason: typeof t.reason === "string" ? t.reason : "other",
          p_detail: typeof t.detail === "string" ? t.detail : "",
        });
      }

      /* —— 管理员（RLS is_admin 兜底；Worker 只翻译） —— */
      if (seg[0] === "admin") {
        if (seg[1] === "me" && seg.length === 2 && m === "GET") return rpc(env, request, "is_admin", {});
        if (seg.length === 1 && m === "GET") return rpc(env, request, "is_admin", {});
        if (seg[1] === "overview" && m === "GET") return rpc(env, request, "admin_overview", {});
        if (seg[1] === "users" && seg.length === 2 && m === "GET") {
          return rpc(env, request, "admin_users_page", {
            p_offset: parseOffset(q.get("offset")),
            p_limit: parseLimit(q.get("limit"), 100),
          });
        }
        /* 轮 33：举报/复核队列（待处理 pending / 已处理 handled） */
        if (seg[1] === "reports" && seg.length === 2 && m === "GET") {
          return rpc(env, request, "admin_report_page", {
            p_status: q.get("status") || "pending",
            p_offset: parseOffset(q.get("offset")),
            p_limit: parseLimit(q.get("limit"), 20),
          });
        }
        /* 轮 270：客户端错误日志（管理中心「客户端错误」页签）。
         * 只读、只翻译：是否管理员由 RPC 内的 admin_users 判定，Worker 不做第二道判断。
         * limit 钳到 200，与 SQL 侧 admin_clientlog_page 的钳位一致（别指望 DB 兜）。 */
        if (seg[1] === "client-logs" && seg.length === 2) {
          if (m !== "GET") return fail(405, "method-not-allowed");
          return rpc(env, request, "admin_clientlog_page", {
            p_offset: parseOffset(q.get("offset")),
            p_limit: Math.min(parseLimit(q.get("limit"), 50), 200),
          });
        }
        if (seg[1] === "reports" && seg.length === 4 && seg[3] === "handle" && m === "POST") {
          const id = decodeSeg(seg[2]);
          if (!id) return fail(400, "bad-id");
          const b = await readJson(request);
          if (b.err) return b.err;
          const t = b.body || {};
          return rpc(env, request, "admin_report_handle", {
            p_report: Number(id) || 0,
            p_action: typeof t.action === "string" ? t.action : "dismiss",
            p_note: typeof t.note === "string" ? t.note : "",
          });
        }
        if (seg[1] === "posts") {
          if (seg.length === 2 && m === "GET") {
            return listAdminTable(env, request, TABLE.posts,
              "id,user_id,author_name,body,image_path,views,dislikes,removed,created_at",
              parseLimit(q.get("limit"), 50));
          }
          if (seg.length === 3) {
            const id = decodeSeg(seg[2]);
            if (!id) return fail(400, "bad-id");
            if (m === "PATCH") {
              const b = await readJson(request);
              if (b.err) return b.err;
              const patch = {};
              if (typeof b.body.removed === "boolean") patch.removed = b.body.removed;
              if (!Object.keys(patch).length) return fail(400, "empty-patch");
              return patchRow(env, request, TABLE.posts, `id=eq.${encodeURIComponent(id)}`, patch);
            }
            if (m === "DELETE") return deleteRows(env, request, TABLE.posts, `id=eq.${encodeURIComponent(id)}`);
          }
        }
        if (seg[1] === "comments") {
          if (seg.length === 2 && m === "GET") {
            return listAdminTable(env, request, TABLE.comments,
              "id,post_id,parent_id,user_id,author_name,body,created_at",
              parseLimit(q.get("limit"), 100));
          }
          if (seg.length === 3 && m === "DELETE") {
            const id = decodeSeg(seg[2]);
            if (!id) return fail(400, "bad-id");
            return deleteRows(env, request, TABLE.comments, `id=eq.${encodeURIComponent(id)}`);
          }
        }
      }

      /* —— 私信（阶段 4：写入全走 security definer RPC；Worker 只翻译） —— */
      if (seg[0] === "dm") {
        if (seg.length === 1 && m === "POST") {
          const b = await readJson(request);
          if (b.err) return b.err;
          const t = b.body || {};
          const other = typeof t.other === "string" ? t.other.trim() : "";
          if (!other) return fail(400, "bad-target");
          return rpc(env, request, "dm_open", { p_other: other });
        }
        if (seg[1] === "convs" && seg.length === 2 && m === "GET") {
          return rpc(env, request, "dm_list_convs", {
            p_limit: parseLimit(q.get("limit"), 100),
            p_offset: parseOffset(q.get("offset")),
          });
        }
        if (seg[1] === "unread" && seg.length === 2 && m === "GET") {
          return rpc(env, request, "dm_unread_total", {});
        }
        if (seg[1] === "blocks") {
          if (seg.length === 2 && m === "GET") return rpc(env, request, "dm_blocks", {});
          if (seg.length === 2 && m === "POST") {
            const b = await readJson(request);
            if (b.err) return b.err;
            const t = b.body || {};
            const user = typeof t.user === "string" ? t.user.trim() : "";
            if (!user) return fail(400, "bad-target");
            return rpc(env, request, "dm_block", { p_user: user });
          }
          if (seg.length === 3 && m === "DELETE") {
            const user = decodeSeg(seg[2]);
            if (!user) return fail(400, "bad-id");
            return rpc(env, request, "dm_unblock", { p_user: user });
          }
        }
        const convId = /^[1-9]\d*$/.test(String(seg[1] || "")) ? parseInt(seg[1], 10) : null;
        if (seg.length === 3 && convId !== null) {
          if (seg[2] === "messages") {
            if (m === "GET") {
              const before = q.get("before");
              return rpc(env, request, "dm_list_messages", {
                p_conv: convId,
                p_before: before && /^\d+$/.test(before) ? parseInt(before, 10) : null,
                p_limit: parseLimit(q.get("limit"), 30),
              });
            }
            if (m === "POST") {
              const b = await readJson(request);
              if (b.err) return b.err;
              const t = b.body || {};
              if (!("body" in t) || typeof t.body !== "string") return fail(400, "bad-body");
              if ("image" in t && t.image !== null && typeof t.image !== "string") return fail(400, "bad-image");
              const image = typeof t.image === "string" ? t.image : null;
              return rpc(env, request, "dm_send", { p_conv: convId, p_body: t.body, p_image: image });
            }
          }
          if (seg[2] === "meta" && m === "GET") {
            return rpc(env, request, "dm_conv_meta", { p_conv: convId });
          }
          if (m === "POST") {
            if (seg[2] === "read") return rpc(env, request, "dm_mark_read", { p_conv: convId });
            if (seg[2] === "hide") return rpc(env, request, "dm_hide", { p_conv: convId });
            if (seg[2] === "unhide") return rpc(env, request, "dm_unhide", { p_conv: convId });
            if (seg[2] === "accept") return rpc(env, request, "dm_accept", { p_conv: convId });
            if (seg[2] === "mute") {
              const b = await readJson(request);
              if (b.err) return b.err;
              const t = b.body || {};
              const on = typeof t.on === "boolean" ? t.on : true;
              return rpc(env, request, "dm_mute", { p_conv: convId, p_on: on });
            }
          }
        }
        if (seg.length === 4 && seg[1] === "messages" && seg[3] === "recall" && m === "POST" && /^\d+$/.test(seg[2])) {
          return rpc(env, request, "dm_recall", { p_msg: parseInt(seg[2], 10) });
        }
      }

      /* —— 通知中心（阶段 4） —— */
      if (seg[0] === "notifications") {
        if (seg.length === 1 && m === "GET") {
          return rpc(env, request, "notif_page", {
            p_offset: parseOffset(q.get("offset")),
            p_limit: parseLimit(q.get("limit"), 30),
            p_kinds: q.get("kinds"),
            p_unread: q.get("unread") === "1" || q.get("unread") === "true",
          });
        }
        if (seg[1] === "unread" && seg.length === 2 && m === "GET") {
          return rpc(env, request, "notif_unread", {});
        }
        if (seg[1] === "clear" && seg.length === 2 && m === "POST") {
          return rpc(env, request, "notif_clear", {});
        }
        if (seg[1] === "read" && seg.length === 2 && m === "POST") {
          const b = await readJson(request);
          if (b.err) return b.err;
          const t = b.body || {};
          const ids = Array.isArray(t.ids)
            ? t.ids.filter((x) => /^\d+$/.test(String(x))).map((x) => parseInt(x, 10))
            : null;
          return rpc(env, request, "notif_mark", {
            p_ids: t.all === true ? null : ids && ids.length ? ids : null,
            p_all: t.all === true,
          });
        }
        if (seg[1] === "prefs") {
          if (seg.length === 2 && m === "GET") return rpc(env, request, "notif_prefs_get", {});
          if (seg.length === 2 && m === "POST") {
            const b = await readJson(request);
            if (b.err) return b.err;
            const t = b.body || {};
            const bool = (v) => (typeof v === "boolean" ? v : undefined);
            return rpc(env, request, "notif_prefs_set", {
              p_comments: bool(t.comments) ?? true,
              p_reactions: bool(t.reactions) ?? true,
              p_pets: bool(t.pets) ?? true,
              p_dms: bool(t.dms) ?? true,
            });
          }
        }
      }

      /* —— 管理员公告（轮 238 · 分批推送）：POST = 建档（start），POST step = 推一批，
         GET = 历史。管理端循环 step 直到 done；中途关页可从历史续发。 —— */
      if (seg[0] === "admin" && seg[1] === "broadcast" && seg.length === 2 && request.method === "POST") {
        const b = await readJson(request);
        if (b.err) return b.err;
        const t = b.body || {};
        const body = typeof t.body === "string" ? t.body : "";
        if (!body.trim()) return fail(400, "empty-body");
        return rpc(env, request, "admin_broadcast_start", { p_body: body });
      }
      if (seg[0] === "admin" && seg.length === 3 && seg[1] === "broadcast" && seg[2] === "step" && request.method === "POST") {
        const b = await readJson(request);
        if (b.err) return b.err;
        const bid = typeof (b.body || {}).bid === "string" ? b.body.bid : "";
        if (!/^[0-9a-f-]{36}$/i.test(bid)) return fail(400, "bad-bid");
        const batch = Number((b.body || {}).batch) > 0 ? Number(b.body.batch) : undefined;
        return rpc(env, request, "admin_broadcast_step", batch ? { p_bid: bid, p_batch: batch } : { p_bid: bid });
      }
      /* 轮 238 · GET 同路径 = 公告历史（admin_broadcasts_list；非管理员空集） */
      if (seg[0] === "admin" && seg[1] === "broadcast" && seg.length === 2 && m === "GET") {
        return rpc(env, request, "admin_broadcasts_list", {
          p_limit: parseLimit(q.get("limit"), 20),
          p_offset: parseOffset(q.get("offset")),
        });
      }

      return fail(404, "not-found");
    } catch (e) {
      return fail(500, "worker-error");
    }
}

/* ══════════ 轮 149 · 边缘缓存包装器 ══════════
 * 只在「公开 + 匿名 + GET + 白名单」时介入：
 *   HIT → 直接回缓存，**不执行 handleApi**，isolate 冷启动那一跳被完全绕过；
 *   MISS → 执行 handleApi，200 且是 JSON 才落缓存（用 ctx.waitUntil，不阻塞响应）。
 * 打上 x-cache 头，方便在浏览器/curl 里肉眼确认是否命中。
 * 注意：caches 是 Workers 运行时注入的全局，离线测试 harness 里没有，
 *   故这里做 typeof 探测 —— 探测失败直接回落 handleApi（等于没缓存，绝不能因此 500）。 */
export default {
  /* 轮 162：每分钟 cron 自 ping——免费版 isolate 回收造成冷启动尖峰（实测单查 2.3~9.6s
     跳变），靠它压住：保活 isolate 的同时顺手热身。免费额度 10 万次/天，每分钟 1 次
     = 1440 次，余量充足。wrangler.jsonc 里同步挂 triggers.crons。 */
  async scheduled(controller, env, ctx) {
    try {
      const p = fetch("https://warmpaws.de5.net/api/posts?limit=1").catch(() => {});
      if (ctx && ctx.waitUntil) ctx.waitUntil(p);
    } catch (e) { /* 保活失败无所谓 */ }
  },
  async fetch(request, env, ctx) {
    const hasCache = typeof caches !== "undefined" && caches && caches.default;
    const u0 = new URL(request.url);
    const cacheable =
      hasCache && request.method === "GET" && cacheablePath(u0.pathname)
      && !hasAuth(request)
      /* 轮 159（用户：「刷新没有用/每个人出现的都一样」）：随机批绝不进缓存——
         sample 的随机结果被边缘缓存 30s = 同一 POP 上所有人拿到同一份「随机」，
         刷新也只是原样回放。随机批每次回源（计数+随机起点两查，成本可接受）；
         普通列表仍是确定性内容，30s 边缘缓存照旧保留。 */
      && u0.searchParams.get("sample") !== "1";
    if (!cacheable) return handleApi(request, env, ctx);

    const key = new Request(request.url, { method: "GET" });
    const hit = await caches.default.match(key);
    if (hit) {
      const h = new Headers(hit.headers);
      h.set("x-cache", "HIT");
      return new Response(hit.body, { status: hit.status, headers: h });
    }

    const res = await handleApi(request, env, ctx);
    if (res && res.ok && res.status === 200) {
      /* 落盘前必须把 Set-Cookie 摘掉。
       * Cloudflare 的机器人防护会往每个响应注入 `Set-Cookie: __cf_bm=...`，
       * 而 Workers 的 Cache API 明确**拒绝**缓存带 Set-Cookie 的响应 ——
       * put() 会在 waitUntil 里静默失败，缓存永远写不进去（实测 x-cache 恒为 MISS）。
       * 这个 cookie 只服务 CF 自己，且带着 30 分钟过期，回放它没有任何意义。 */
      const ph = new Headers(res.headers);
      ph.delete("Set-Cookie");
      /* 关键：必须 clone()。Response.body 是一次性 ReadableStream，
       * 直接把 res.body 塞进 copy 会把流「用掉」，随后第二次读（返回给客户端那次）就抛错 → 500。
       * 先clone() 拿一份独立副本，再用净化头包装它。 */
      const copy = new Response(res.clone().body, { status: res.status, statusText: res.statusText, headers: ph });
      /* ctx.waitUntil 缺失时直接丢弃这次落盘（不影响本次响应，只是这请求没进缓存） */
      if (ctx && typeof ctx.waitUntil === "function") {
        ctx.waitUntil(caches.default.put(key, copy).catch(() => {}));
      }
      const h = new Headers(res.headers);
      h.set("x-cache", "MISS");
      return new Response(res.body, { status: res.status, headers: h });
    }
    return res;
  },
};