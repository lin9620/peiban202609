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

function corsPreflight() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
      "access-control-allow-headers": "authorization,content-type,apikey,x-upsert",
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

/** 请求体：限长 + JSON 解析；出错时给现成的 Response（{err}） */
async function readJson(request) {
  let text;
  try {
    text = await request.text();
  } catch (e) {
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
async function listPosts(env, request, uid, limit, offset) {
  const base = ["select=*"];
  if (uid) base.push(`user_id=eq.${encodeURIComponent(uid)}`);
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

/** 评论列表（旧→新） */
async function listComments(env, request, postId, limit) {
  const res = await upstream(
    env, request,
    restUrl(env, TABLE.comments, `select=*&post_id=eq.${encodeURIComponent(postId)}&order=created_at.asc&limit=${limit}`),
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




/* ══════════ 路由分发 ══════════ */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") return corsPreflight();

    /* 非 /api/*：静态资源（含 SPA 兜底），Worker 不掺手 */
    if (path !== "/api" && !path.startsWith("/api/")) {
      return env.ASSETS ? env.ASSETS.fetch(request) : fail(404, "not-found");
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

      /* —— 帖子 —— */
      if (seg[0] === "posts") {
        if (seg.length === 1) {
          if (m === "GET") return listPosts(env, request, "", parseLimit(q.get("limit"), 200), parseOffset(q.get("offset")));
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

      /* —— 管理员公告（阶段 4：全员 system 通知） —— */
      if (seg[0] === "admin" && seg[1] === "broadcast" && seg.length === 2 && m === "POST") {
        const b = await readJson(request);
        if (b.err) return b.err;
        const t = b.body || {};
        const body = typeof t.body === "string" ? t.body : "";
        if (!body.trim()) return fail(400, "empty-body");
        return rpc(env, request, "admin_broadcast", { p_body: body });
      }

      return fail(404, "not-found");
    } catch (e) {
      return fail(500, "worker-error");
    }
  },
};