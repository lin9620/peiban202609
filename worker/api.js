/* Warm Paws API 网关（阶段 2）
 * ------------------------------------------------------------
 * 一个 Worker 同时承担两件事：
 *   1. /api/*    —— 前端数据网关：具名端点 → Supabase REST(PostgREST)/Storage 的纯翻译层。
 *                   只做协议翻译 + 鉴权头透传，不藏业务逻辑（业务仍在 DB 函数与 RLS 里）。
 *                   用户 JWT 原样转发 → RLS 照旧由数据库执行；本文件绝不解析/验证 token。
 *   2. 其余路径  —— 静态资源（env.ASSETS；SPA 兜底由 wrangler.jsonc 的 assets 配置决定）。
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

/** 帖子列表：先带 removed 过滤；任何非 2xx 都退回不带过滤的查询（老库没有这一列；与直连模式对齐） */
async function listPosts(env, request, uid, limit) {
  const base = ["select=*"];
  if (uid) base.push(`user_id=eq.${encodeURIComponent(uid)}`);
  const order = "order=created_at.desc";
  const lim = `limit=${limit}`;
  let res = await upstream(env, request, restUrl(env, TABLE.posts, [...base, "removed=eq.false", order, lim].join("&")));
  if (!res) return fail(502, "upstream-unreachable");
  if (!res.ok) {
    res = await upstream(env, request, restUrl(env, TABLE.posts, [...base, order, lim].join("&")));
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

/** RPC：服务端权威逻辑（去重 / 计数 / 自动下架） */
async function rpc(env, request, name, params) {
  const res = await upstream(env, request, restUrl(env, `rpc/${name}`, ""), {
    method: "POST",
    body: JSON.stringify(params),
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

/** 公开图 URL：302 到 Storage 公开地址；文件名是内容哈希 → 浏览器可永久缓存 */
function imgRedirect(env, rawSegs) {
  const path = safeImagePath(rawSegs.join("/"));
  if (!path) return fail(400, "bad-path");
  return new Response(null, {
    status: 302,
    headers: {
      location: `${env.SUPABASE_URL}/storage/v1/object/public/${IMAGE_BUCKET}/${path.split("/").map(encodeURIComponent).join("/")}`,
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}




/* ══════════ 路由分发 ══════════ */

export default {
  async fetch(request, env) {
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
        return m === "GET" ? imgRedirect(env, seg.slice(1)) : fail(405, "method-not-allowed");
      }
      if (seg[0] === "uploads") {
        return m === "POST" ? upload(env, request, url) : fail(405, "method-not-allowed");
      }

      /* —— 帖子 —— */
      if (seg[0] === "posts") {
        if (seg.length === 1) {
          if (m === "GET") return listPosts(env, request, "", parseLimit(q.get("limit"), 200));
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
          return listPosts(env, request, uid, parseLimit(q.get("limit"), 50));
        }
        if (seg[2] === "profile" && m === "GET") {
          const res = await upstream(
            env, request,
            restUrl(env, TABLE.profiles, `select=${encodeURIComponent("nickname,created_at")}&id=eq.${encodeURIComponent(uid)}`),
            { headers: { accept: OBJECT_ACCEPT } },
          );
          return res ? objectOrPassthrough(res) : fail(502, "upstream-unreachable");
        }
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

      /* —— 管理员（鉴权靠 JWT 透传 + RLS is_admin；无 token 时上游按 anon 判 false） —— */
      if (seg[0] === "admin") {
        if (seg[1] === "me" && seg.length === 2 && m === "GET") {
          return rpc(env, request, "is_admin", {});
        }
        if (seg[1] === "overview" && seg.length === 2 && m === "GET") {
          return rpc(env, request, "admin_overview", {});
        }
        if (seg[1] === "posts" && seg.length === 2 && m === "GET") {
          const res = await upstream(
            env, request,
            restUrl(env, TABLE.posts, `select=${encodeURIComponent("id,user_id,author_name,body,image_path,views,dislikes,removed,created_at")}&order=created_at.desc&limit=${parseLimit(q.get("limit"), 50)}`),
          );
          return res || fail(502, "upstream-unreachable");
        }
        if (seg[1] === "posts" && seg.length === 3) {
          const id = decodeSeg(seg[2]);
          if (!id) return fail(400, "bad-id");
          if (m === "PATCH") {
            const b = await readJson(request);
            if (b.err) return b.err;
            if (typeof b.body.removed !== "boolean") return fail(400, "bad-body");
            const res = await upstream(env, request, restUrl(env, TABLE.posts, `id=eq.${encodeURIComponent(id)}`), {
              method: "PATCH",
              body: JSON.stringify({ removed: b.body.removed }),
            });
            return res || fail(502, "upstream-unreachable");
          }
          if (m === "DELETE") {
            return deleteRows(env, request, TABLE.posts, `id=eq.${encodeURIComponent(id)}`);
          }
        }
        if (seg[1] === "comments" && seg.length === 2 && m === "GET") {
          const res = await upstream(
            env, request,
            restUrl(env, TABLE.comments, `select=${encodeURIComponent("id,post_id,parent_id,user_id,author_name,body,created_at")}&order=created_at.desc&limit=${parseLimit(q.get("limit"), 100)}`),
          );
          return res || fail(502, "upstream-unreachable");
        }
        if (seg[1] === "comments" && seg.length === 3 && m === "DELETE") {
          const id = decodeSeg(seg[2]);
          if (!id) return fail(400, "bad-id");
          return deleteRows(env, request, TABLE.comments, `id=eq.${encodeURIComponent(id)}`);
        }
      }

      /* —— 管理员（RLS is_admin 兜底；Worker 只翻译） —— */
      if (seg[0] === "admin") {
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

      return fail(404, "not-found");
    } catch (e) {
      return fail(500, "worker-error");
    }
  },
};