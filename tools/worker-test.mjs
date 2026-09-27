/* API 网关 Worker 契约测试（阶段 2）
 * ------------------------------------------------------------
 * 直接在 Node 里跑 worker/api.js 的 fetch handler（无需 wrangler / 无需网络）：
 * 用「会记录出站请求的假 fetch」当地上游，断言每个 /api/* 端点翻译出的
 *   URL / 方法 / 头（apikey、JWT 透传、Prefer/Accept）/ body 与 Supabase 直连模式逐字符一致；
 * 并覆盖：静态资源放行、CORS 预检、健康检查、404、参数校验、上游故障 502、RLS 错误透传、PGRST116→null。
 * 与 tools/gateway-contract-test.mjs（前端侧）成对：两端形状都对上，端到端才通。
 * 运行：node tools/worker-test.mjs
 */
import worker from "../worker/api.js";

const ORIGIN = "https://sb.test";
const ANON = "anon-test-key";
const enc = encodeURIComponent;

function makeEnv() {
  return {
    SUPABASE_URL: ORIGIN,
    SUPABASE_ANON_KEY: ANON,
    ASSETS: { fetch: async (r) => new Response(`ASSET:${new URL(r.url).pathname}`) },
  };
}

/* 出站捕获：替换 globalThis.fetch，记录 {url, init}；按 script 依次回响应 */
function capture(script = []) {
  const outbound = [];
  const real = globalThis.fetch;
  let i = 0;
  globalThis.fetch = async (url, init = {}) => {
    outbound.push({ url: String(url), init });
    const s = script[i++];
    if (s && s.throw) throw new Error("network-down");
    const status = s && s.status ? s.status : 200;
    const hasBody = status !== 204 && status !== 304;
    const body = !hasBody
      ? null
      : s && s.body !== undefined
        ? JSON.stringify(s.body)
        : s && s.text != null
          ? s.text
          : "[]";
    return new Response(body, {
      status,
      headers: { "content-type": "application/json", ...(s && s.headers ? s.headers : {}) },
    });
  };
  return { outbound, restore() { globalThis.fetch = real; } };
}

let pass = 0;
const fails = [];
function ok(name, cond, extra = "") {
  if (cond) pass++;
  else fails.push(name + (extra ? ` —— ${extra}` : ""));
}

const req = (path, init = {}) => new Request(`https://site.test${path}`, init);
const hdr = (init) => new Headers(init && init.headers ? init.headers : {});
const row = [{ id: "p1" }, { id: "p2" }];
/** 跑一个请求：返回响应 + 出站记录（用完即恢复真 fetch） */
async function hit(script, path, init) {
  const c = capture(script);
  try {
    return { res: await worker.fetch(req(path, init), makeEnv(), {}), c };
  } finally {
    c.restore();
  }
}

/* ─────────── 基础行为 ─────────── */
{
  const c = capture();
  try {
    const res = await worker.fetch(req("/api/health"), makeEnv(), {});
    ok("health 200 {ok,mode:gateway}", res.status === 200 && (await res.json()).mode === "gateway");
    const res2 = await worker.fetch(req("/pet"), makeEnv(), {});
    ok("静态资源放行给 ASSETS", res2.status === 200 && (await res2.text()) === "ASSET:/pet");
    ok("静态路径不出站", c.outbound.length === 0);
    const res3 = await worker.fetch(req("/api/posts", { method: "OPTIONS" }), makeEnv(), {});
    ok("CORS 预检 204 + 允许 authorization", res3.status === 204 && (res3.headers.get("access-control-allow-headers") || "").includes("authorization"));
    const res3b = await worker.fetch(req("/sb/storage/v1/object/wall-images/u1/x.jpg", {
      method: "OPTIONS",
      headers: { "access-control-request-headers": "cache-control,content-type,authorization,x-upsert" },
    }), makeEnv(), {});
    ok("轮29 预检回显客户端申请的头（storage 的 cache-control 不再被卡）",
      res3b.status === 204
        && (res3b.headers.get("access-control-allow-headers") || "") === "cache-control,content-type,authorization,x-upsert");
    const res3c = await worker.fetch(req("/api/posts", { method: "OPTIONS" }), makeEnv(), {});
    ok("无申请头时回退显式白名单（含 cache-control）",
      (res3c.headers.get("access-control-allow-headers") || "").includes("cache-control"));
    const res4 = await worker.fetch(req("/api/typo"), makeEnv(), {});
    ok("未知 api → 404 JSON", res4.status === 404);
    const res5 = await worker.fetch(req("/api/health"), {}, {});
    ok("未配置 SUPABASE_URL → 503", res5.status === 503);
    const res6 = await worker.fetch(req("/api/health", { method: "DELETE" }), makeEnv(), {});
    ok("health 类已知路径未知方法 → 405", res6.status === 405);
    const res7 = await worker.fetch(req("/api/posts", { method: "PUT" }), makeEnv(), {});
    ok("走穿到底的未知方法 → 404", res7.status === 404);
  } finally {
    c.restore();
  }
}

/* ─────────── 帖子 ─────────── */
{
  const { res, c } = await hit([{ body: row }], "/api/posts?limit=200");
  ok("listPosts 200", res.status === 200);
  ok("listPosts 出站 URL",
    c.outbound[0].url === `${ORIGIN}/rest/v1/wall_posts?select=*&removed=eq.false&order=created_at.desc&limit=200`,
    c.outbound[0].url);
  const h = hdr(c.outbound[0].init);
  ok("listPosts apikey=anon / 匿名不带 JWT", h.get("apikey") === ANON && !h.get("authorization"));
  ok("listPosts 返回行", JSON.stringify(await res.json()) === JSON.stringify(row));
}
{
  const { res, c } = await hit([{ body: row }], "/api/posts?limit=50&before_id=623");
  ok("listPosts before_id 游标（轮62）", res.status === 200
    && c.outbound[0].url === `${ORIGIN}/rest/v1/wall_posts?select=*&id=lt.623&removed=eq.false&order=created_at.desc&limit=50`,
    c.outbound[0].url);
}
{
  const { res, c } = await hit([{ status: 400, body: { code: "42703" } }, { body: row }], "/api/posts?limit=200");
  ok("removed 缺列 → 退回查询仍 200", res.status === 200);
  ok("退回查询不带 removed",
    c.outbound[1].url === `${ORIGIN}/rest/v1/wall_posts?select=*&order=created_at.desc&limit=200`,
    c.outbound[1].url);
}
{
  const { c } = await hit([{ body: [] }], "/api/posts?limit=10", { headers: { authorization: "Bearer tok-1" } });
  ok("用户 JWT 原样透传", hdr(c.outbound[0].init).get("authorization") === "Bearer tok-1");
}
{
  const { c } = await hit([{ body: [] }], "/api/users/u9/posts?limit=50");
  ok("listPostsByUser 出站 URL",
    c.outbound[0].url === `${ORIGIN}/rest/v1/wall_posts?select=*&user_id=eq.u9&removed=eq.false&order=created_at.desc&limit=50`,
    c.outbound[0].url);
}
{
  const body = { user_id: "u1", author_name: "G", body: "hi", image_path: null };
  const { res, c } = await hit([{ status: 201, body: { id: "p1" } }], "/api/posts", { method: "POST", body: JSON.stringify(body) });
  ok("insertPost 201", res.status === 201);
  ok("insertPost 出站 URL/方法/body 透传",
    c.outbound[0].url === `${ORIGIN}/rest/v1/wall_posts` && c.outbound[0].init.method === "POST" &&
    c.outbound[0].init.body === JSON.stringify(body));
  const h = hdr(c.outbound[0].init);
  ok("insertPost prefer=representation + object accept",
    h.get("prefer") === "return=representation" && h.get("accept") === "application/vnd.pgrst.object+json");
}

/* ─────────── 档案 ─────────── */
{
  const { c } = await hit([{ body: { nickname: "n", created_at: null } }], "/api/users/u1/profile");
  ok("profile 出站 URL（含状态列）",
    c.outbound[0].url === `${ORIGIN}/rest/v1/profiles?select=nickname%2Ccreated_at%2Cstatus%2Cstatus_at&id=eq.u1`,
    c.outbound[0].url);
  ok("profile object accept", hdr(c.outbound[0].init).get("accept") === "application/vnd.pgrst.object+json");
}
{
  const { res } = await hit([{ status: 406, body: { code: "PGRST116", message: "x" } }], "/api/users/u1/profile");
  ok("profile 行不存在 → 200 null", res.status === 200 && (await res.text()) === "null");
}
{
  const { res, c } = await hit(
    [{ status: 400, body: { code: "42703" } }, { body: { nickname: "n", created_at: null } }],
    "/api/users/u1/profile",
  );
  ok("profile 老库无状态列 → 退回两列查询仍 200", res.status === 200);
  ok("profile 退回查询不带状态列",
    c.outbound[1].url === `${ORIGIN}/rest/v1/profiles?select=nickname%2Ccreated_at&id=eq.u1`, c.outbound[1].url);
}
{
  const since = "2026-01-01T00:00:00.000Z";
  const { c } = await hit([{ body: [{ id: "u2", status: "working" }] }], `/api/statuses?limit=12&since=${enc(since)}`);
  ok("statuses 出站 URL（非空 + since 窗口 + 新→旧）",
    c.outbound[0].url === `${ORIGIN}/rest/v1/profiles?select=id%2Cnickname%2Cstatus%2Cstatus_at&status=not.is.null&status_at=gte.${enc(since)}&order=status_at.desc&limit=12`,
    c.outbound[0].url);
}
{
  const { res, c } = await hit(
    [{ status: 400, body: { code: "42703" } }],
    "/api/statuses?limit=12",
  );
  ok("statuses 老库无列 → 400 透传（前端 catch 隐藏区块兜底）", res.status === 400);
  ok("statuses 老库兜底：仅一次出站", c.outbound.length === 1);
}
{
  const { res, c } = await hit(
    [{ status: 204 }],
    "/api/users/u1/status",
    { method: "PATCH", body: JSON.stringify({ status: "working" }) },
  );
  ok("setStatus 204", res.status === 204);
  ok("setStatus 出站 URL/方法（RLS self update 兜底）",
    c.outbound[0].url === `${ORIGIN}/rest/v1/profiles?id=eq.u1` && c.outbound[0].init.method === "PATCH", c.outbound[0].url);
  const out = JSON.parse(c.outbound[0].init.body);
  ok("setStatus body：status 原样 + 服务端盖 status_at",
    out.status === "working" && !Number.isNaN(Date.parse(out.status_at)), c.outbound[0].init.body);
}
{
  const { c } = await hit([{ status: 204 }], "/api/users/u1/status", {
    method: "PATCH", body: JSON.stringify({ status: null }),
  });
  ok("setStatus null → 清除", JSON.parse(c.outbound[0].init.body).status === null, c.outbound[0].init.body);
}
{
  const { res } = await hit([], "/api/users/u1/status", {
    method: "PATCH", body: JSON.stringify({ status: 42 }),
  });
  ok("setStatus 非法类型（不在白名单）→ 400 bad-status", res.status === 400);
}
{
  const { res } = await hit([], "/api/users/u1/status", {
    method: "PATCH", body: JSON.stringify({ status: "x".repeat(120) }),
  });
  ok("setStatus 未知长 key（白名单外）→ 400", res.status === 400);
}

/* ─────────── 评论 ─────────── */
{
  const { c } = await hit([{ body: [] }], "/api/posts/p1/comments?limit=200");
  ok("listComments 出站 URL",
    c.outbound[0].url === `${ORIGIN}/rest/v1/wall_comments?select=*&post_id=eq.p1&order=created_at.asc&limit=200`,
    c.outbound[0].url);
}
{
  const { c } = await hit([{ status: 201, body: { id: "c1" } }], "/api/posts/p1/comments", { method: "POST", body: JSON.stringify({ post_id: "p1" }) });
  ok("insertComment 走 wall_comments + prefer",
    c.outbound[0].url === `${ORIGIN}/rest/v1/wall_comments` && hdr(c.outbound[0].init).get("prefer") === "return=representation");
}
{
  const { c } = await hit([{ body: [] }], "/api/comment-post-ids?ids=a,b&limit=500");
  ok("comment-post-ids 出站 URL（in-list）",
    c.outbound[0].url === `${ORIGIN}/rest/v1/wall_comments?select=post_id&post_id=${enc(`in.("a","b")`)}&limit=500`,
    c.outbound[0].url);
}
{
  const { res, c } = await hit([{ status: 204 }], "/api/comments/c1", { method: "DELETE" });
  ok("deleteComment 出站 URL/方法/204",
    c.outbound[0].url === `${ORIGIN}/rest/v1/wall_comments?id=eq.c1` && c.outbound[0].init.method === "DELETE" && res.status === 204);
}

/* ─────────── 回应 ─────────── */
{
  const { c } = await hit([{ body: [] }], "/api/reactions?ids=a,b");
  ok("listReactionsByPosts 出站 URL（in-list）",
    c.outbound[0].url === `${ORIGIN}/rest/v1/wall_reactions?select=post_id%2Cuser_id%2Ckind&post_id=${enc(`in.("a","b")`)}`,
    c.outbound[0].url);
}
{
  const { c } = await hit([{ body: [] }], "/api/posts/p1/reactions");
  ok("listReactionsByPost 出站 URL",
    c.outbound[0].url === `${ORIGIN}/rest/v1/wall_reactions?select=post_id%2Cuser_id%2Ckind&post_id=eq.p1`,
    c.outbound[0].url);
}
{
  const { res, c } = await hit([{ status: 406, body: { code: "PGRST116" } }], "/api/reactions/mine?post_id=p&user_id=u&kind=hug");
  ok("findReaction 出站 URL",
    c.outbound[0].url === `${ORIGIN}/rest/v1/wall_reactions?select=post_id&post_id=eq.p&user_id=eq.u&kind=eq.hug`,
    c.outbound[0].url);
  ok("findReaction 无记录 → null", res.status === 200 && (await res.text()) === "null");
}
{
  const b = { post_id: "p", user_id: "u", kind: "hug" };
  const { c } = await hit([{ status: 201 }], "/api/reactions", { method: "POST", body: JSON.stringify(b) });
  ok("insertReaction 出站 URL/body",
    c.outbound[0].url === `${ORIGIN}/rest/v1/wall_reactions` && c.outbound[0].init.body === JSON.stringify(b));
  ok("insertReaction 无 select → 不带 prefer", !hdr(c.outbound[0].init).get("prefer"));
}
{
  const { c } = await hit([{ status: 204 }], "/api/reactions?post_id=p&user_id=u&kind=hug", { method: "DELETE" });
  ok("deleteReaction 出站 URL",
    c.outbound[0].url === `${ORIGIN}/rest/v1/wall_reactions?post_id=eq.p&user_id=eq.u&kind=eq.hug`,
    c.outbound[0].url);
}

/* ─────────── 轮 84 · 评论回应（👍心 / 💔碎心） ─────────── */
{
  const { c } = await hit([{ body: [] }], "/api/comments/reactions?ids=1,2");
  ok("listCommentReactions 出站 URL（in-list + limit）",
    c.outbound[0].url === `${ORIGIN}/rest/v1/wall_comment_reactions?select=comment_id%2Cuser_id%2Ckind&comment_id=${enc(`in.("1","2")`)}&limit=2000`,
    c.outbound[0].url);
}
{
  const { c } = await hit([{ body: [] }], "/api/comments/reactions/mine?ids=1,2&user_id=u1");
  ok("listMyCommentReactions 出站 URL",
    c.outbound[0].url === `${ORIGIN}/rest/v1/wall_comment_reactions?select=comment_id%2Ckind&comment_id=${enc(`in.("1","2")`)}&user_id=eq.u1&limit=2000`,
    c.outbound[0].url);
}
{
  const { c } = await hit([{ body: { ok: true, on: true, hearts: 1, brokens: 0 } }],
    "/api/comments/react", { method: "POST", body: JSON.stringify({ comment_id: 7, kind: "heart" }) });
  ok("toggleCommentReaction rpc URL + body",
    c.outbound[0].url === `${ORIGIN}/rest/v1/rpc/wall_toggle_comment_reaction` &&
    c.outbound[0].init.body === JSON.stringify({ p_comment: 7, p_kind: "heart" }));
}
{
  const { res } = await hit([], "/api/comments/react", { method: "POST", body: JSON.stringify({ comment_id: 7, kind: "hug" }) });
  ok("toggleCommentReaction 非法 kind → 400", res.status === 400);
}
{
  const { res } = await hit([], "/api/comments/reactions/mine?ids=1&user_id=", { method: "GET" });
  ok("listMyCommentReactions 缺 user_id → 400", res.status === 400);
}

/* ─────────── RPC（服务端权威逻辑） ─────────── */
{
  const { c } = await hit([{ body: { ok: true } }], "/api/posts/p1/view", { method: "POST", body: JSON.stringify({ viewer: "v1" }) });
  ok("addView rpc URL + body",
    c.outbound[0].url === `${ORIGIN}/rest/v1/rpc/wall_add_view` &&
    c.outbound[0].init.body === JSON.stringify({ p_post: "p1", p_viewer: "v1" }));
}
{
  const { c } = await hit([{ body: { ok: true } }], "/api/posts/p1/dislike", { method: "POST" });
  ok("toggleDislike rpc URL + body",
    c.outbound[0].url === `${ORIGIN}/rest/v1/rpc/wall_toggle_dislike` &&
    c.outbound[0].init.body === JSON.stringify({ p_post: "p1" }));
}
{
  const { c } = await hit([{ body: { ok: true } }], "/api/pet/o1/interact", { method: "POST", body: JSON.stringify({ kind: "pat", viewer: "anon" }) });
  ok("petInteract rpc URL + body",
    c.outbound[0].url === `${ORIGIN}/rest/v1/rpc/pet_interact` &&
    c.outbound[0].init.body === JSON.stringify({ p_owner: "o1", p_kind: "pat", p_viewer: "anon" }));
}

/* ─────────── 宠物主页 ─────────── */
{
  const { c } = await hit([{ body: { data: {}, pats: 1, feeds: 2 } }], "/api/pet/u1");
  ok("getPet 出站 URL（带计数列）",
    c.outbound[0].url === `${ORIGIN}/rest/v1/pet_profiles?select=data%2Cpats%2Cfeeds&user_id=eq.u1`,
    c.outbound[0].url);
}
{
  const { res, c } = await hit([{ status: 400, body: { code: "42703" } }, { body: { data: {} } }], "/api/pet/u1");
  ok("getPet 缺计数列 → 退回只读 data",
    c.outbound[1].url === `${ORIGIN}/rest/v1/pet_profiles?select=data&user_id=eq.u1`,
    c.outbound[1].url);
  ok("getPet 退回后返回行", res.status === 200);
}
{
  const body = { user_id: "u1", data: { pet: {} }, updated_at: "T" };
  const { c } = await hit([{ status: 201 }], "/api/pet/u1", { method: "PUT", body: JSON.stringify(body) });
  ok("upsertPet URL（on_conflict=user_id）+ prefer",
    c.outbound[0].url === `${ORIGIN}/rest/v1/pet_profiles?on_conflict=user_id` &&
    hdr(c.outbound[0].init).get("prefer") === "resolution=merge-duplicates");
  ok("upsertPet body 原样透传（红线：Worker 不改写 payload）", c.outbound[0].init.body === JSON.stringify(body));
}

/* ─────────── 图片（上传 + 公开 URL） ─────────── */
{
  const { res, c } = await hit(
    [{ status: 200, body: { Key: "k" } }],
    "/api/uploads?path=u1%2Fpet-ab12.jpg&upsert=1",
    { method: "POST", body: "abc", headers: { "content-type": "image/png" } },
  );
  ok("upload 出站 URL（Storage 桶 + 路径）",
    c.outbound[0].url === `${ORIGIN}/storage/v1/object/wall-images/u1/pet-ab12.jpg`,
    c.outbound[0].url);
  const h = hdr(c.outbound[0].init);
  ok("upload x-upsert / content-type / 字节透传",
    h.get("x-upsert") === "true" && h.get("content-type") === "image/png" &&
    (c.outbound[0].init.body instanceof ArrayBuffer || c.outbound[0].init.body instanceof Uint8Array));
  ok("upload 200", res.status === 200);
}
{
  const { res } = await hit([], "/api/uploads?path=..%2Fx.jpg", { method: "POST", body: "abc" });
  ok("upload 拒绝目录穿越", res.status === 400);
}
{
  const { res } = await hit([], "/api/uploads?path=u1%2Fx.jpg", { method: "POST", body: "x".repeat(600 * 1024) });
  ok("upload 超限 → 413", res.status === 413);
}
{
  /* 图片改为「字节代理 + 边缘缓存」：不再是 302 直连（302 跨用户不共享 → 每张图的每次浏览
     都算一次 Supabase egress）。这里逐一钉住：代理语义、长缓存头、缓存命中不再回源、上游故障兜底 302。 */
  const IMG = `${ORIGIN}/storage/v1/object/public/wall-images/u1/x.jpg`;
  const imgUp = { status: 200, headers: { "content-type": "image/jpeg", etag: '"abc"' }, text: "BINARY-IMG" };

  const { res, c } = await hit([imgUp], "/api/img/u1/x.jpg");
  ok("img 代理字节（200，不再 302 直连）", res.status === 200 && (await res.text()) === "BINARY-IMG");
  ok("img 出站取 Storage 公开地址", c.outbound.length === 1 && c.outbound[0].url === IMG, c.outbound.map((o) => o.url).join(","));
  ok("img 透传 content-type/etag", res.headers.get("content-type") === "image/jpeg" && res.headers.get("etag") === '"abc"');
  ok("img 长缓存 immutable（路径含时间戳/内容哈希且不覆盖 → 字节不变）",
    (res.headers.get("cache-control") || "").includes("immutable"));
  ok("img 无 Cache API 时标 BYPASS（行为仍正确，只是不共享）", res.headers.get("x-img-cache") === "BYPASS");
}

/* 有 Cache API 时：首次 MISS 写缓存 → 第二次 HIT 不再回源（这正是省 egress 的地方） */
{
  const store = new Map();
  globalThis.caches = {
    default: {
      match: async (k) => store.get(k.url),
      put: async (k, r) => { store.set(k.url, r); },
    },
  };
  try {
    const waits = [];
    const ctx = { waitUntil: (p) => waits.push(p) };
    const c1 = capture([{ status: 200, headers: { "content-type": "image/jpeg" }, text: "IMG" }]);
    let r1;
    try {
      r1 = await worker.fetch(req("/api/img/u1/y.jpg"), makeEnv(), ctx);
      ok("首次回源标 MISS 且出站一次", r1.headers.get("x-img-cache") === "MISS" && c1.outbound.length === 1);
      ok("内容正确回传", (await r1.text()) === "IMG");
    } finally { c1.restore(); }
    await Promise.all(waits);
    ok("MISS 后写入边缘缓存", store.has(`https://site.test/api/img/u1/y.jpg`), [...store.keys()].join(","));

    const c2 = capture([]); /* 这次不该有任何出站 */
    try {
      const r2 = await worker.fetch(req("/api/img/u1/y.jpg"), makeEnv(), ctx);
      ok("命中边缘缓存 → HIT 且零回源（egress 由此降到 1/N）",
        r2.headers.get("x-img-cache") === "HIT" && c2.outbound.length === 0,
        `x-cache=${r2.headers.get("x-img-cache")} outbound=${c2.outbound.length}`);
    } finally { c2.restore(); }
  } finally { delete globalThis.caches; }
}

/* 缓存读取抛错 / 上游故障：都不能白块 —— 退回改造前的 302 直连 */
{
  globalThis.caches = { default: { match: async () => { throw new Error("cache-down"); }, put: async () => {} } };
  try {
    const { res } = await hit([{ status: 200, headers: { "content-type": "image/jpeg" }, text: "OK" }], "/api/img/u1/z.jpg");
    ok("缓存读失败不致命：照常回源出图", res.status === 200 && (await res.text()) === "OK");
  } finally { delete globalThis.caches; }
}
{
  const { res } = await hit([{ throw: true }], "/api/img/u1/z.jpg");
  ok("上游网络故障 → 兜底 302 直连（图仍能显示，不白块）",
    res.status === 302 && res.headers.get("location") === `${ORIGIN}/storage/v1/object/public/wall-images/u1/z.jpg`
    && res.headers.get("x-img-cache") === "FALLBACK");
}
{
  const { res } = await hit([{ status: 404 }], "/api/img/u1/z.jpg");
  ok("上游 404（图不存在）→ 也兜底 302，让 Storage 自己回准确状态",
    res.status === 302 && res.headers.get("x-img-cache") === "FALLBACK");
}
{
  const { res } = await hit([], "/api/img/u1/%2E%2E/x.jpg");
  ok("img 拒绝目录穿越", res.status === 400);
}
{
  const { res } = await hit([], "/api/img/u1/x.jpg", { method: "POST" });
  ok("img 只允许 GET", res.status === 405);
}

/* ─────────── 错误路径 ─────────── */
{
  const c = capture([{ throw: true }]);
  try {
    const res = await worker.fetch(req("/api/posts?limit=10"), makeEnv(), {});
    ok("上游网络故障 → 502", res.status === 502 && (await res.json()).error === "upstream-unreachable");
    ok("网络故障只出站一次（不重试网络错误）", c.outbound.length === 1);
  } finally {
    c.restore();
  }
}
{
  const { res } = await hit(
    [{ status: 403, body: { code: "42501", message: "new row violates row-level security" } }],
    "/api/reactions",
    { method: "POST", body: JSON.stringify({ post_id: "p", user_id: "u", kind: "hug" }) },
  );
  ok("RLS 403 原样透传（前端可感知）", res.status === 403 && (await res.json()).code === "42501");
}
{
  const { res } = await hit([], "/api/posts", { method: "POST", body: "{oops" });
  ok("非法 JSON body → 400", res.status === 400);
}

/* ─────────── 管理员（Worker 只翻译；权限由 RLS 兜底） ─────────── */
{
  const { res, c } = await hit([{ body: true }], "/api/admin/me");
  ok("admin/me → rpc is_admin",
    c.outbound[0].url === `${ORIGIN}/rest/v1/rpc/is_admin` && c.outbound[0].init.body === "{}",
    c.outbound[0].url);
  ok("admin/me 返回布尔", (await res.json()) === true);
}
{
  const { c } = await hit([{ body: { admin: true } }], "/api/admin/overview");
  ok("admin/overview → rpc admin_overview",
    c.outbound[0].url === `${ORIGIN}/rest/v1/rpc/admin_overview` && c.outbound[0].init.body === "{}");
}
{
  const { c } = await hit([{ body: row }], "/api/admin/posts?limit=50");
  ok("admin/posts 出站 URL",
    c.outbound[0].url ===
      `${ORIGIN}/rest/v1/wall_posts?select=${enc("id,user_id,author_name,body,image_path,views,dislikes,removed,created_at")}&order=created_at.desc&limit=50`,
    c.outbound[0].url);
}
{
  const { res, c } = await hit([{ status: 204 }], "/api/admin/posts/p1", { method: "PATCH", body: JSON.stringify({ removed: true }) });
  ok("admin PATCH removed 出站 URL/方法/body",
    c.outbound[0].url === `${ORIGIN}/rest/v1/wall_posts?id=eq.p1` && c.outbound[0].init.method === "PATCH" &&
    c.outbound[0].init.body === JSON.stringify({ removed: true }));
  ok("PATCH 返回 204", res.status === 204);
}
{
  const { c } = await hit([{ status: 204 }], "/api/admin/posts/p1", { method: "DELETE" });
  ok("admin DELETE post 出站 URL",
    c.outbound[0].url === `${ORIGIN}/rest/v1/wall_posts?id=eq.p1` && c.outbound[0].init.method === "DELETE");
}
{
  const { c } = await hit([{ body: [] }], "/api/admin/comments?limit=100");
  ok("admin/comments 出站 URL",
    c.outbound[0].url ===
      `${ORIGIN}/rest/v1/wall_comments?select=${enc("id,post_id,parent_id,user_id,author_name,body,created_at")}&order=created_at.desc&limit=100`,
    c.outbound[0].url);
}
{
  const { c } = await hit([{ status: 204 }], "/api/admin/comments/c1", { method: "DELETE" });
  ok("admin DELETE comment 出站 URL",
    c.outbound[0].url === `${ORIGIN}/rest/v1/wall_comments?id=eq.c1` && c.outbound[0].init.method === "DELETE");
}
{
  const { c } = await hit([{ body: { admin: true, total: 2, users: [] } }], "/api/admin/users?offset=100&limit=100");
  ok("admin/users → rpc admin_users_page（分页参数）",
    c.outbound[0].url === `${ORIGIN}/rest/v1/rpc/admin_users_page` &&
    c.outbound[0].init.body === JSON.stringify({ p_offset: 100, p_limit: 100 }),
    c.outbound[0].url);
}
{
  const { c } = await hit([], "/api/admin/users");
  ok("admin/users 缺省 → offset=0 / limit=100",
    c.outbound[0].init.body === JSON.stringify({ p_offset: 0, p_limit: 100 }));
}
{
  const { res } = await hit([{ status: 403, body: { code: "42501", message: "row-level security" } }], "/api/admin/overview");
  ok("非管理员 RPC 403 原样透传", res.status === 403);
}

/* ─────────── 私信（阶段 4：/api/dm/* → rpc dm_*） ─────────── */
{
  const { res, c } = await hit([{ body: { conv_id: 7 } }], "/api/dm", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ other: "u2" }),
  });
  ok("dmOpen 200", res.status === 200);
  ok("dmOpen → rpc dm_open（p_other）",
    c.outbound[0].url === `${ORIGIN}/rest/v1/rpc/dm_open` &&
    c.outbound[0].init.body === JSON.stringify({ p_other: "u2" }), c.outbound[0].url);
}
{
  const { res } = await hit([], "/api/dm", { method: "POST", body: JSON.stringify({ other: "" }) });
  ok("dmOpen 空 other → 400", res.status === 400);
}
{
  const { res, c } = await hit([{ body: [] }], "/api/dm/convs?limit=50&offset=10");
  ok("dmListConvs 200", res.status === 200);
  ok("dmListConvs → rpc dm_list_convs（分页）",
    c.outbound[0].url === `${ORIGIN}/rest/v1/rpc/dm_list_convs` &&
    c.outbound[0].init.body === JSON.stringify({ p_limit: 50, p_offset: 10 }), c.outbound[0].url);
}
{
  const { res, c } = await hit([{ body: [] }], "/api/dm/7/messages?limit=30&before=123");
  ok("dmListMessages 200", res.status === 200);
  ok("dmListMessages → rpc（游标）",
    c.outbound[0].url === `${ORIGIN}/rest/v1/rpc/dm_list_messages` &&
    c.outbound[0].init.body === JSON.stringify({ p_conv: 7, p_before: 123, p_limit: 30 }), c.outbound[0].url);
  const r2 = await hit([{ body: [] }], "/api/dm/7/messages?limit=30");
  ok("dmListMessages 无游标 → p_before=null",
    r2.c.outbound[0].init.body === JSON.stringify({ p_conv: 7, p_before: null, p_limit: 30 }), r2.c.outbound[0].init.body);
}
{
  const { res, c } = await hit([{ body: { msg_id: 1 } }], "/api/dm/7/messages", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "hi", image: null }),
  });
  ok("dmSend 200", res.status === 200);
  ok("dmSend → rpc dm_send（正文 + 空图片→null）",
    c.outbound[0].url === `${ORIGIN}/rest/v1/rpc/dm_send` &&
    c.outbound[0].init.body === JSON.stringify({ p_conv: 7, p_body: "hi", p_image: null }), c.outbound[0].init.body);
}
{
  const { res } = await hit([], "/api/dm/7/messages", { method: "POST", body: JSON.stringify({ body: 42 }) });
  ok("dmSend 非字符串正文 → 400", res.status === 400);
  const r2 = await hit([], "/api/dm/7/messages", { method: "POST", body: JSON.stringify({ body: "ok", image: 5 }) });
  ok("dmSend 非字符串图片 → 400", r2.res.status === 400);
  const r3 = await hit([], "/api/dm/abc/meta");
  ok("非数字会话 id → 404", r3.res.status === 404);
}
{
  const { c } = await hit([{ body: {} }], "/api/dm/7/meta");
  ok("dmConvMeta → rpc", c.outbound[0].url === `${ORIGIN}/rest/v1/rpc/dm_conv_meta` &&
    c.outbound[0].init.body === JSON.stringify({ p_conv: 7 }), c.outbound[0].url);
}
{
  const r = await hit([{ body: { ok: true } }], "/api/dm/7/read", { method: "POST", body: "{}" });
  ok("dmMarkRead → rpc dm_mark_read", r.c.outbound[0].url === `${ORIGIN}/rest/v1/rpc/dm_mark_read` &&
    r.c.outbound[0].init.body === JSON.stringify({ p_conv: 7 }), r.c.outbound[0].url);
  const r2 = await hit([{ body: { ok: true } }], "/api/dm/7/hide", { method: "POST", body: "{}" });
  ok("dmHide → rpc dm_hide", r2.c.outbound[0].init.body === JSON.stringify({ p_conv: 7 }));
  const r3 = await hit([{ body: { ok: true } }], "/api/dm/7/unhide", { method: "POST", body: "{}" });
  ok("dmUnhide → rpc dm_unhide", r3.c.outbound[0].init.body === JSON.stringify({ p_conv: 7 }));
  const r4 = await hit([{ body: { ok: true } }], "/api/dm/7/accept", { method: "POST", body: "{}" });
  ok("dmAccept → rpc dm_accept", r4.c.outbound[0].init.body === JSON.stringify({ p_conv: 7 }));
}
{
  const { c } = await hit([{ body: { ok: true } }], "/api/dm/7/mute", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on: true }),
  });
  ok("dmMute → rpc dm_mute（p_on）", c.outbound[0].init.body === JSON.stringify({ p_conv: 7, p_on: true }), c.outbound[0].init.body);
}
{
  const { c } = await hit([{ body: { ok: true } }], "/api/dm/messages/99/recall", { method: "POST", body: "{}" });
  ok("dmRecall → rpc dm_recall", c.outbound[0].url === `${ORIGIN}/rest/v1/rpc/dm_recall` &&
    c.outbound[0].init.body === JSON.stringify({ p_msg: 99 }), c.outbound[0].url);
}
{
  const { c } = await hit([{ body: [] }], "/api/dm/blocks");
  ok("dmBlocks → rpc dm_blocks", c.outbound[0].url === `${ORIGIN}/rest/v1/rpc/dm_blocks` &&
    c.outbound[0].init.body === "{}", c.outbound[0].url);
  const r = await hit([{ body: { ok: true } }], "/api/dm/blocks", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user: "u3" }),
  });
  ok("dmBlock → rpc dm_block", r.c.outbound[0].init.body === JSON.stringify({ p_user: "u3" }), r.c.outbound[0].init.body);
  const r2 = await hit([{ body: { ok: true } }], "/api/dm/blocks/u3", { method: "DELETE" });
  ok("dmUnblock → rpc dm_unblock", r2.c.outbound[0].init.body === JSON.stringify({ p_user: "u3" }), r2.c.outbound[0].init.body);
  const r3 = await hit([], "/api/dm/blocks", { method: "POST", body: JSON.stringify({ user: "" }) });
  ok("dmBlock 空 user → 400", r3.res.status === 400);
}
{
  const { c } = await hit([{ body: { total: 1, requests: 0 } }], "/api/dm/unread");
  ok("dmUnreadTotal → rpc dm_unread_total", c.outbound[0].url === `${ORIGIN}/rest/v1/rpc/dm_unread_total` &&
    c.outbound[0].init.body === "{}", c.outbound[0].url);
}

/* ─────────── 通知中心（阶段 4：/api/notifications/* → rpc notif_*） ─────────── */
{
  const { c } = await hit([{ body: [] }], "/api/notifications?offset=10&limit=30");
  ok("notifPage → rpc notif_page（默认全部）",
    c.outbound[0].url === `${ORIGIN}/rest/v1/rpc/notif_page` &&
    c.outbound[0].init.body === JSON.stringify({ p_offset: 10, p_limit: 30, p_kinds: null, p_unread: false }), c.outbound[0].init.body);
  const r = await hit([{ body: [] }], `/api/notifications?offset=0&limit=30&kinds=${enc("comment,reply")}&unread=1`);
  ok("notifPage 过滤参数透传",
    r.c.outbound[0].init.body === JSON.stringify({ p_offset: 0, p_limit: 30, p_kinds: "comment,reply", p_unread: true }), r.c.outbound[0].init.body);
}
{
  const { c } = await hit([{ body: { total: 0 } }], "/api/notifications/unread");
  ok("notifUnread → rpc notif_unread", c.outbound[0].url === `${ORIGIN}/rest/v1/rpc/notif_unread` &&
    c.outbound[0].init.body === "{}", c.outbound[0].url);
}
{
  const { c } = await hit([{ body: { ok: true } }], "/api/notifications/read", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: [1, 2, "x"], all: false }),
  });
  ok("notifMark → rpc notif_mark（ids 过滤非法值）",
    c.outbound[0].init.body === JSON.stringify({ p_ids: [1, 2], p_all: false }), c.outbound[0].init.body);
  const r = await hit([{ body: { ok: true } }], "/api/notifications/read", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ all: true }),
  });
  ok("notifMark 全部 → p_ids=null",
    r.c.outbound[0].init.body === JSON.stringify({ p_ids: null, p_all: true }), r.c.outbound[0].init.body);
}
{
  const { c } = await hit([{ body: { comments: true } }], "/api/notifications/prefs");
  ok("notifPrefsGet → rpc", c.outbound[0].url === `${ORIGIN}/rest/v1/rpc/notif_prefs_get` &&
    c.outbound[0].init.body === "{}", c.outbound[0].url);
  const r = await hit([{ body: { ok: true } }], "/api/notifications/prefs", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ comments: true, reactions: false, pets: true, dms: false }),
  });
  ok("notifPrefsSet → rpc（布尔）",
    r.c.outbound[0].init.body === JSON.stringify({ p_comments: true, p_reactions: false, p_pets: true, p_dms: false }), r.c.outbound[0].init.body);
}
{
  const { res, c } = await hit([{ body: { admin: true, sent: 1 } }], "/api/admin/broadcast", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "hi" }),
  });
  ok("adminBroadcast 200", res.status === 200);
  ok("adminBroadcast → rpc admin_broadcast", c.outbound[0].url === `${ORIGIN}/rest/v1/rpc/admin_broadcast` &&
    c.outbound[0].init.body === JSON.stringify({ p_body: "hi" }), c.outbound[0].init.body);
}

/* ─────────── 私信（阶段 4：/api/dm/* → rpc dm_*） ─────────── */
{
  const { res, c } = await hit([{ body: { conv_id: 7 } }], "/api/dm", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ other: "u2" }),
  });
  ok("dmOpen 200", res.status === 200);
  ok("dmOpen → rpc dm_open（p_other）",
    c.outbound[0].url === `${ORIGIN}/rest/v1/rpc/dm_open` &&
    c.outbound[0].init.body === JSON.stringify({ p_other: "u2" }), c.outbound[0].url);
}
{
  const { res } = await hit([], "/api/dm", { method: "POST", body: JSON.stringify({ other: "" }) });
  ok("dmOpen 空 other → 400", res.status === 400);
}
{
  const { res, c } = await hit([{ body: [] }], "/api/dm/convs?limit=50&offset=10");
  ok("dmListConvs 200", res.status === 200);
  ok("dmListConvs → rpc dm_list_convs（分页）",
    c.outbound[0].url === `${ORIGIN}/rest/v1/rpc/dm_list_convs` &&
    c.outbound[0].init.body === JSON.stringify({ p_limit: 50, p_offset: 10 }), c.outbound[0].url);
}
{
  const { res, c } = await hit([{ body: [] }], "/api/dm/7/messages?limit=30&before=123");
  ok("dmListMessages 200", res.status === 200);
  ok("dmListMessages → rpc（游标）",
    c.outbound[0].url === `${ORIGIN}/rest/v1/rpc/dm_list_messages` &&
    c.outbound[0].init.body === JSON.stringify({ p_conv: 7, p_before: 123, p_limit: 30 }), c.outbound[0].url);
  const r2 = await hit([{ body: [] }], "/api/dm/7/messages?limit=30");
  ok("dmListMessages 无游标 → p_before=null",
    r2.c.outbound[0].init.body === JSON.stringify({ p_conv: 7, p_before: null, p_limit: 30 }), r2.c.outbound[0].init.body);
}
{
  const { res, c } = await hit([{ body: { msg_id: 1 } }], "/api/dm/7/messages", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "hi", image: null }),
  });
  ok("dmSend 200", res.status === 200);
  ok("dmSend → rpc dm_send（正文 + 空图片→null）",
    c.outbound[0].url === `${ORIGIN}/rest/v1/rpc/dm_send` &&
    c.outbound[0].init.body === JSON.stringify({ p_conv: 7, p_body: "hi", p_image: null }), c.outbound[0].init.body);
}
{
  const { res } = await hit([], "/api/dm/7/messages", { method: "POST", body: JSON.stringify({ body: 42 }) });
  ok("dmSend 非字符串正文 → 400", res.status === 400);
  const r2 = await hit([], "/api/dm/7/messages", { method: "POST", body: JSON.stringify({ body: "ok", image: 5 }) });
  ok("dmSend 非字符串图片 → 400", r2.res.status === 400);
  const r3 = await hit([], "/api/dm/abc/meta");
  ok("非数字会话 id → 404", r3.res.status === 404);
}
{
  const { c } = await hit([{ body: {} }], "/api/dm/7/meta");
  ok("dmConvMeta → rpc", c.outbound[0].url === `${ORIGIN}/rest/v1/rpc/dm_conv_meta` &&
    c.outbound[0].init.body === JSON.stringify({ p_conv: 7 }), c.outbound[0].url);
}
{
  const r = await hit([{ body: { ok: true } }], "/api/dm/7/read", { method: "POST", body: "{}" });
  ok("dmMarkRead → rpc dm_mark_read", r.c.outbound[0].url === `${ORIGIN}/rest/v1/rpc/dm_mark_read` &&
    r.c.outbound[0].init.body === JSON.stringify({ p_conv: 7 }), r.c.outbound[0].url);
  const r2 = await hit([{ body: { ok: true } }], "/api/dm/7/hide", { method: "POST", body: "{}" });
  ok("dmHide → rpc dm_hide", r2.c.outbound[0].init.body === JSON.stringify({ p_conv: 7 }));
  const r3 = await hit([{ body: { ok: true } }], "/api/dm/7/unhide", { method: "POST", body: "{}" });
  ok("dmUnhide → rpc dm_unhide", r3.c.outbound[0].init.body === JSON.stringify({ p_conv: 7 }));
  const r4 = await hit([{ body: { ok: true } }], "/api/dm/7/accept", { method: "POST", body: "{}" });
  ok("dmAccept → rpc dm_accept", r4.c.outbound[0].init.body === JSON.stringify({ p_conv: 7 }));
}
{
  const { c } = await hit([{ body: { ok: true } }], "/api/dm/7/mute", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on: true }),
  });
  ok("dmMute → rpc dm_mute（p_on）", c.outbound[0].init.body === JSON.stringify({ p_conv: 7, p_on: true }), c.outbound[0].init.body);
}
{
  const { c } = await hit([{ body: { ok: true } }], "/api/dm/messages/99/recall", { method: "POST", body: "{}" });
  ok("dmRecall → rpc dm_recall", c.outbound[0].url === `${ORIGIN}/rest/v1/rpc/dm_recall` &&
    c.outbound[0].init.body === JSON.stringify({ p_msg: 99 }), c.outbound[0].url);
}
{
  const { c } = await hit([{ body: [] }], "/api/dm/blocks");
  ok("dmBlocks → rpc dm_blocks", c.outbound[0].url === `${ORIGIN}/rest/v1/rpc/dm_blocks` &&
    c.outbound[0].init.body === "{}", c.outbound[0].url);
  const r = await hit([{ body: { ok: true } }], "/api/dm/blocks", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user: "u3" }),
  });
  ok("dmBlock → rpc dm_block", r.c.outbound[0].init.body === JSON.stringify({ p_user: "u3" }), r.c.outbound[0].init.body);
  const r2 = await hit([{ body: { ok: true } }], "/api/dm/blocks/u3", { method: "DELETE" });
  ok("dmUnblock → rpc dm_unblock", r2.c.outbound[0].init.body === JSON.stringify({ p_user: "u3" }), r2.c.outbound[0].init.body);
  const r3 = await hit([], "/api/dm/blocks", { method: "POST", body: JSON.stringify({ user: "" }) });
  ok("dmBlock 空 user → 400", r3.res.status === 400);
}
{
  const { c } = await hit([{ body: { total: 1, requests: 0 } }], "/api/dm/unread");
  ok("dmUnreadTotal → rpc dm_unread_total", c.outbound[0].url === `${ORIGIN}/rest/v1/rpc/dm_unread_total` &&
    c.outbound[0].init.body === "{}", c.outbound[0].url);
}

/* ─────────── 通知中心（阶段 4：/api/notifications/* → rpc notif_*） ─────────── */
{
  const { c } = await hit([{ body: [] }], "/api/notifications?offset=10&limit=30");
  ok("notifPage → rpc notif_page（默认全部）",
    c.outbound[0].url === `${ORIGIN}/rest/v1/rpc/notif_page` &&
    c.outbound[0].init.body === JSON.stringify({ p_offset: 10, p_limit: 30, p_kinds: null, p_unread: false }), c.outbound[0].init.body);
  const r = await hit([{ body: [] }], `/api/notifications?offset=0&limit=30&kinds=${enc("comment,reply")}&unread=1`);
  ok("notifPage 过滤参数透传",
    r.c.outbound[0].init.body === JSON.stringify({ p_offset: 0, p_limit: 30, p_kinds: "comment,reply", p_unread: true }), r.c.outbound[0].init.body);
}
{
  const { c } = await hit([{ body: { total: 0 } }], "/api/notifications/unread");
  ok("notifUnread → rpc notif_unread", c.outbound[0].url === `${ORIGIN}/rest/v1/rpc/notif_unread` &&
    c.outbound[0].init.body === "{}", c.outbound[0].url);
}
{
  const { c } = await hit([{ body: { ok: true } }], "/api/notifications/read", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: [1, 2, "x"], all: false }),
  });
  ok("notifMark → rpc notif_mark（ids 过滤非法值）",
    c.outbound[0].init.body === JSON.stringify({ p_ids: [1, 2], p_all: false }), c.outbound[0].init.body);
  const r = await hit([{ body: { ok: true } }], "/api/notifications/read", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ all: true }),
  });
  ok("notifMark 全部 → p_ids=null",
    r.c.outbound[0].init.body === JSON.stringify({ p_ids: null, p_all: true }), r.c.outbound[0].init.body);
}
{
  const { c } = await hit([{ body: { comments: true } }], "/api/notifications/prefs");
  ok("notifPrefsGet → rpc", c.outbound[0].url === `${ORIGIN}/rest/v1/rpc/notif_prefs_get` &&
    c.outbound[0].init.body === "{}", c.outbound[0].url);
  const r = await hit([{ body: { ok: true } }], "/api/notifications/prefs", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ comments: true, reactions: false, pets: true, dms: false }),
  });
  ok("notifPrefsSet → rpc（布尔）",
    r.c.outbound[0].init.body === JSON.stringify({ p_comments: true, p_reactions: false, p_pets: true, p_dms: false }), r.c.outbound[0].init.body);
}
{
  const { res, c } = await hit([{ body: { admin: true, sent: 1 } }], "/api/admin/broadcast", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "hi" }),
  });
  ok("adminBroadcast 200", res.status === 200);
  ok("adminBroadcast → rpc admin_broadcast", c.outbound[0].url === `${ORIGIN}/rest/v1/rpc/admin_broadcast` &&
    c.outbound[0].init.body === JSON.stringify({ p_body: "hi" }), c.outbound[0].init.body);
}

/* ─────────── 私信（阶段 4：/api/dm/* → rpc dm_*） ─────────── */
{
  const { res, c } = await hit([{ body: { conv_id: 7 } }], "/api/dm", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ other: "u2" }),
  });
  ok("dmOpen 200", res.status === 200);
  ok("dmOpen → rpc dm_open（p_other）",
    c.outbound[0].url === `${ORIGIN}/rest/v1/rpc/dm_open` &&
    c.outbound[0].init.body === JSON.stringify({ p_other: "u2" }), c.outbound[0].url);
}
{
  const { res } = await hit([], "/api/dm", { method: "POST", body: JSON.stringify({ other: "" }) });
  ok("dmOpen 空 other → 400", res.status === 400);
}
{
  const { res, c } = await hit([{ body: [] }], "/api/dm/convs?limit=50&offset=10");
  ok("dmListConvs 200", res.status === 200);
  ok("dmListConvs → rpc dm_list_convs（分页）",
    c.outbound[0].url === `${ORIGIN}/rest/v1/rpc/dm_list_convs` &&
    c.outbound[0].init.body === JSON.stringify({ p_limit: 50, p_offset: 10 }), c.outbound[0].url);
}
{
  const { res, c } = await hit([{ body: [] }], "/api/dm/7/messages?limit=30&before=123");
  ok("dmListMessages 200", res.status === 200);
  ok("dmListMessages → rpc（游标）",
    c.outbound[0].url === `${ORIGIN}/rest/v1/rpc/dm_list_messages` &&
    c.outbound[0].init.body === JSON.stringify({ p_conv: 7, p_before: 123, p_limit: 30 }), c.outbound[0].url);
  const r2 = await hit([{ body: [] }], "/api/dm/7/messages?limit=30");
  ok("dmListMessages 无游标 → p_before=null",
    r2.c.outbound[0].init.body === JSON.stringify({ p_conv: 7, p_before: null, p_limit: 30 }), r2.c.outbound[0].init.body);
}
{
  const { res, c } = await hit([{ body: { msg_id: 1 } }], "/api/dm/7/messages", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "hi", image: null }),
  });
  ok("dmSend 200", res.status === 200);
  ok("dmSend → rpc dm_send（正文 + 空图片→null）",
    c.outbound[0].url === `${ORIGIN}/rest/v1/rpc/dm_send` &&
    c.outbound[0].init.body === JSON.stringify({ p_conv: 7, p_body: "hi", p_image: null }), c.outbound[0].init.body);
}
{
  const { res } = await hit([], "/api/dm/7/messages", { method: "POST", body: JSON.stringify({ body: 42 }) });
  ok("dmSend 非字符串正文 → 400", res.status === 400);
  const r2 = await hit([], "/api/dm/7/messages", { method: "POST", body: JSON.stringify({ body: "ok", image: 5 }) });
  ok("dmSend 非字符串图片 → 400", r2.res.status === 400);
  const r3 = await hit([], "/api/dm/abc/meta");
  ok("非数字会话 id → 404（不匹配 conv 分支）", r3.res.status === 404);
}
{
  const { c } = await hit([{ body: {} }], "/api/dm/7/meta");
  ok("dmConvMeta → rpc", c.outbound[0].url === `${ORIGIN}/rest/v1/rpc/dm_conv_meta` &&
    c.outbound[0].init.body === JSON.stringify({ p_conv: 7 }), c.outbound[0].url);
}
{
  const r = await hit([{ body: { ok: true } }], "/api/dm/7/read", { method: "POST", body: "{}" });
  ok("dmMarkRead → rpc dm_mark_read", r.c.outbound[0].url === `${ORIGIN}/rest/v1/rpc/dm_mark_read` &&
    r.c.outbound[0].init.body === JSON.stringify({ p_conv: 7 }), r.c.outbound[0].url);
  const r2 = await hit([{ body: { ok: true } }], "/api/dm/7/hide", { method: "POST", body: "{}" });
  ok("dmHide → rpc dm_hide", r2.c.outbound[0].init.body === JSON.stringify({ p_conv: 7 }));
  const r3 = await hit([{ body: { ok: true } }], "/api/dm/7/unhide", { method: "POST", body: "{}" });
  ok("dmUnhide → rpc dm_unhide", r3.c.outbound[0].init.body === JSON.stringify({ p_conv: 7 }));
  const r4 = await hit([{ body: { ok: true } }], "/api/dm/7/accept", { method: "POST", body: "{}" });
  ok("dmAccept → rpc dm_accept", r4.c.outbound[0].init.body === JSON.stringify({ p_conv: 7 }));
}
{
  const { c } = await hit([{ body: { ok: true } }], "/api/dm/7/mute", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on: true }),
  });
  ok("dmMute → rpc dm_mute（p_on）", c.outbound[0].init.body === JSON.stringify({ p_conv: 7, p_on: true }), c.outbound[0].init.body);
}
{
  const { c } = await hit([{ body: { ok: true } }], "/api/dm/messages/99/recall", { method: "POST", body: "{}" });
  ok("dmRecall → rpc dm_recall", c.outbound[0].url === `${ORIGIN}/rest/v1/rpc/dm_recall` &&
    c.outbound[0].init.body === JSON.stringify({ p_msg: 99 }), c.outbound[0].url);
}
{
  const { c } = await hit([{ body: [] }], "/api/dm/blocks");
  ok("dmBlocks → rpc dm_blocks", c.outbound[0].url === `${ORIGIN}/rest/v1/rpc/dm_blocks` &&
    c.outbound[0].init.body === "{}", c.outbound[0].url);
  const r = await hit([{ body: { ok: true } }], "/api/dm/blocks", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user: "u3" }),
  });
  ok("dmBlock → rpc dm_block", r.c.outbound[0].init.body === JSON.stringify({ p_user: "u3" }), r.c.outbound[0].init.body);
  const r2 = await hit([{ body: { ok: true } }], "/api/dm/blocks/u3", { method: "DELETE" });
  ok("dmUnblock → rpc dm_unblock", r2.c.outbound[0].init.body === JSON.stringify({ p_user: "u3" }), r2.c.outbound[0].init.body);
  const r3 = await hit([], "/api/dm/blocks", { method: "POST", body: JSON.stringify({ user: "" }) });
  ok("dmBlock 空 user → 400", r3.res.status === 400);
}
{
  const { c } = await hit([{ body: { total: 1, requests: 0 } }], "/api/dm/unread");
  ok("dmUnreadTotal → rpc dm_unread_total", c.outbound[0].url === `${ORIGIN}/rest/v1/rpc/dm_unread_total` &&
    c.outbound[0].init.body === "{}", c.outbound[0].url);
}

/* ─────────── 通知中心（阶段 4：/api/notifications/* → rpc notif_*） ─────────── */
{
  const { c } = await hit([{ body: [] }], "/api/notifications?offset=10&limit=30");
  ok("notifPage → rpc notif_page（默认全部）",
    c.outbound[0].url === `${ORIGIN}/rest/v1/rpc/notif_page` &&
    c.outbound[0].init.body === JSON.stringify({ p_offset: 10, p_limit: 30, p_kinds: null, p_unread: false }), c.outbound[0].init.body);
  const r = await hit([{ body: [] }], `/api/notifications?offset=0&limit=30&kinds=${enc("comment,reply")}&unread=1`);
  ok("notifPage 过滤参数透传",
    r.c.outbound[0].init.body === JSON.stringify({ p_offset: 0, p_limit: 30, p_kinds: "comment,reply", p_unread: true }), r.c.outbound[0].init.body);
}
{
  const { c } = await hit([{ body: { total: 0 } }], "/api/notifications/unread");
  ok("notifUnread → rpc notif_unread", c.outbound[0].url === `${ORIGIN}/rest/v1/rpc/notif_unread` &&
    c.outbound[0].init.body === "{}", c.outbound[0].url);
}
{
  const { c } = await hit([{ body: { ok: true } }], "/api/notifications/read", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: [1, 2, "x"], all: false }),
  });
  ok("notifMark → rpc notif_mark（ids 过滤非法值）",
    c.outbound[0].init.body === JSON.stringify({ p_ids: [1, 2], p_all: false }), c.outbound[0].init.body);
  const r = await hit([{ body: { ok: true } }], "/api/notifications/read", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ all: true }),
  });
  ok("notifMark 全部 → p_ids=null",
    r.c.outbound[0].init.body === JSON.stringify({ p_ids: null, p_all: true }), r.c.outbound[0].init.body);
}
{
  const { c } = await hit([{ body: { comments: true } }], "/api/notifications/prefs");
  ok("notifPrefsGet → rpc", c.outbound[0].url === `${ORIGIN}/rest/v1/rpc/notif_prefs_get` &&
    c.outbound[0].init.body === "{}", c.outbound[0].url);
  const r = await hit([{ body: { ok: true } }], "/api/notifications/prefs", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ comments: true, reactions: false, pets: true, dms: false }),
  });
  ok("notifPrefsSet → rpc（布尔）",
    r.c.outbound[0].init.body === JSON.stringify({ p_comments: true, p_reactions: false, p_pets: true, p_dms: false }), r.c.outbound[0].init.body);
}
{
  const { res, c } = await hit([{ body: { admin: true, sent: 1 } }], "/api/admin/broadcast", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "hi" }),
  });
  ok("adminBroadcast 200", res.status === 200);
  ok("adminBroadcast → rpc admin_broadcast", c.outbound[0].url === `${ORIGIN}/rest/v1/rpc/admin_broadcast` &&
    c.outbound[0].init.body === JSON.stringify({ p_body: "hi" }), c.outbound[0].init.body);
}
{
  const { res, c } = await hit([{ body: { ok: true, removed: 3 } }], "/api/notifications/clear", { method: "POST", body: "{}" });
  ok("notifClear 200", res.status === 200);
  ok("notifClear → rpc notif_clear", c.outbound[0].url === `${ORIGIN}/rest/v1/rpc/notif_clear` &&
    c.outbound[0].init.body === "{}", c.outbound[0].url);
}
{
  const { res, c } = await hit([{ body: { ok: true, storage_removed: 2 } }], "/api/account/delete", { method: "POST", body: "{}" });
  ok("accountDelete 200（自助删号，Play 2024 政策）", res.status === 200);
  ok("accountDelete → rpc delete_my_account", c.outbound[0].url === `${ORIGIN}/rest/v1/rpc/delete_my_account` &&
    c.outbound[0].init.body === "{}", c.outbound[0].url);
}

/* ─────────── 轮 85 · SEO（/u noindex / /post 存在性壳 / 动态 sitemap） ─────────── */
function seoEnv() {
  return {
    SUPABASE_URL: ORIGIN,
    SUPABASE_ANON_KEY: ANON,
    /* worker 回壳走 ASSETS.fetch(new URL("/", origin)) —— Cloudflare 运行时接受 URL 对象，
     * mock 这里必须同时认 Request 与 URL（r.url 在 URL 实例上是 undefined）。
     * 壳结构镜像真实 dist/index.html：multiline description / canonical / og 家页占位 / 家页 hero 在 .seo-static 里。 */
    ASSETS: { fetch: async (r) => {
      const p = (r instanceof URL) ? r.pathname : new URL(r.url).pathname;
      if (p === "/") {
        const shell = [
          "<!DOCTYPE html><html lang=\"en\"><head>",
          '<meta name="robots" content="index, follow" />',
          "<title>Warm Paws · A gentle place to be</title>",
          '<meta',
          '    name="description"',
          '    content="A warm, healing corner: an adorable pet to care for."',
          '  />',
          '<link rel="canonical" href="https://dale.de5.net/" />',
          '<meta property="og:url" content="https://dale.de5.net/" />',
          '<meta property="og:title" content="Warm Paws · A gentle place to be" />',
          '<meta property="og:description" content="Care for a little pet, draw its food, share kindness with gentle people." />',
          '<meta name="twitter:title" content="Warm Paws · A gentle place to be" />',
          '<meta name="twitter:description" content="Care for a little pet, draw its food, share kindness with gentle people." />',
          '<meta property="og:image" content="https://dale.de5.net/og-image.png" />',
          "</head><body>",
          '<div id="app"><div class="seo-static"><section class="card seo-hero"><h2 class="seo-title">A soft place to land</h2><ul class="seo-links"><li><a href="/pet">pet</a></li></ul></section></div></div>',
          "</body></html>",
        ].join("\n");
        return new Response(shell, { status: 200, headers: { "content-type": "text/html", etag: 'W/"shell-v1"' } });
      }
      return new Response("nope", { status: 404 });
    } },
  };
}
{
  /* ③：/u/:id 薄内容壳 → noindex, follow 注入 + etag 抹除 + 不查库 */
  const c = capture();
  try {
    const res = await worker.fetch(req("/u/abc"), seoEnv(), {});
    const text = await res.text();
    ok("/u/:id 壳 200 且 robots 注入 noindex, follow",
      res.status === 200 && text.includes("noindex, follow") && !text.includes('content="index, follow"'), text.slice(0, 140));
    ok("/u/:id 注入后不再带原 etag", !res.headers.get("etag"));
    ok("/u/:id noindex 不出站查库", c.outbound.length === 0);
  } finally { c.restore(); }
}
{
  /* ①b：/post/:id 存在 → SPA 壳；查无/上游挂/非数字 → 真 404 */
  const env = seoEnv();
  {
    /* ①c：存在 → 壳注入标题/正文/OG；无图帖 og:image 保持家页默认 */
    const c = capture([{ body: [{ id: 123, body: "整理书桌的时候翻到一张旧车票\n想起一段好天气", author_name: "压测员68", created_at: "2026-09-25T03:42:00Z" }] }]);
    try {
      const res = await worker.fetch(req("/post/123"), env, {});
      const text = await res.text();
      ok("/post/123 存在 → 壳 200", res.status === 200);
      ok("①c <title> 换成帖子正文截断（换行压平）",
        text.includes("<title>整理书桌的时候翻到一张旧车票 想起一段好天气 · Warm Paws</title>"), text.slice(0, 240));
      ok("①c canonical/og:url 指向 /post/123",
        text.includes('rel="canonical" href="https://site.test/post/123"') && text.includes('property="og:url" content="https://site.test/post/123"'));
      ok("①c og:title/twitter:title 替换", text.split("整理书桌的时候翻到一张旧车票 想起一段好天气 · Warm Paws").length >= 3);
      ok("①c description/og:description 替换",
        text.includes('name="description" content="整理书桌的时候翻到一张旧车票') && !text.includes("Care for a little pet"));
      ok("①c 正文进 .seo-static（换行 → 两段 <p>）",
        text.includes("<p>整理书桌的时候翻到一张旧车票</p>") && text.includes("<p>想起一段好天气</p>"));
      ok("①c 家页 hero 被整块替换（不再有 A soft place to land）", !text.includes("A soft place to land"));
      ok("①c 无图帖 og:image 保持家页默认", text.includes('content="https://dale.de5.net/og-image.png"'));
      ok("/post 存在性查询出站 URL",
        c.outbound[0].url === `${ORIGIN}/rest/v1/wall_posts?select=id%2Cbody%2Cauthor_name%2Ccreated_at%2Cimage_path&id=eq.123&limit=1&removed=eq.false`,
        c.outbound[0].url);
    } finally { c.restore(); }
  }
  {
    /* ①c：HTML 转义（script 不落地/属性引号转义）+ 带图帖 og:image 换成帖子图 */
    const c = capture([{ body: [{ id: 9, body: "<script>alert(1)</script> 你好", author_name: 'A"B', created_at: "2026-09-27T00:00:00Z", image_path: "u1/abc xyz.png" }] }]);
    try {
      const res = await worker.fetch(req("/post/9"), env, {});
      const text = await res.text();
      ok("①c 正文 HTML 转义（script 不落地）",
        text.includes("&lt;script&gt;alert(1)&lt;/script&gt; 你好") && !text.includes("<script>alert"));
      ok("①c 带图帖 og:image → Storage 公网 URL（路径段转义）",
        text.includes("storage/v1/object/public/wall-images/u1/abc%20xyz.png"), (text.match(/og:image[^>]*/) || [""])[0]);
      ok("①c 作者名转义进落款", text.includes("A&quot;B · 2026-09-27"));
    } finally { c.restore(); }
  }
  {
    const c = capture([{ body: [] }]);
    try {
      const res = await worker.fetch(req("/post/999"), env, {});
      ok("/post/999 查无此帖 → 真 404", res.status === 404);
    } finally { c.restore(); }
  }
  {
    const c = capture([{ throw: true }]);
    try {
      const res = await worker.fetch(req("/post/777"), env, {});
      ok("/post/777 上游挂 → 真 404（不发软 200）", res.status === 404);
    } finally { c.restore(); }
  }
  {
    const c = capture([{ status: 400, body: { code: "42703" } }, { body: [{ id: 5 }] }]);
    try {
      const res = await worker.fetch(req("/post/5"), env, {});
      ok("/post 老库无 removed 列（400）→ 降级重试后回壳",
        res.status === 200 && !c.outbound[1].url.includes("removed"), c.outbound[1].url);
    } finally { c.restore(); }
  }
  {
    const c = capture();
    try {
      const res = await worker.fetch(req("/post/abc"), env, {});
      ok("/post/abc 非数字 → 真 404 且不出站", res.status === 404 && c.outbound.length === 0);
    } finally { c.restore(); }
  }
}
{
  /* ②：动态 sitemap —— 固定 5 页 + 最新 100 帖深链；lastmod 取发帖日 */
  const c = capture([{ body: [{ id: 9, created_at: "2026-09-27T01:02:03Z" }] }]);
  try {
    const res = await worker.fetch(req("/sitemap.xml"), seoEnv(), {});
    const xml = await res.text();
    ok("sitemap.xml 200 + xml 类型",
      res.status === 200 && (res.headers.get("content-type") || "").includes("xml"));
    ok("sitemap 含固定页（en+zh）与帖子深链",
      xml.includes("<loc>https://site.test/privacy</loc>") &&
      xml.includes("<loc>https://site.test/zh/community</loc>") &&
      xml.includes("<loc>https://site.test/post/9</loc>") &&
      xml.includes("<lastmod>2026-09-27</lastmod>"), xml.slice(0, 160));
    ok("sitemap 出站 URL（order=id.desc&limit=100 + removed 降级列）",
      c.outbound[0].url === `${ORIGIN}/rest/v1/wall_posts?select=id%2Ccreated_at&order=id.desc&limit=100&removed=eq.false`,
      c.outbound[0].url);
  } finally { c.restore(); }
}
{
  /* ②：上游挂 → 降级成只含固定 5 页的合法 XML（不 5xx，Google 下次自然重试） */
  const c = capture([{ throw: true }]);
  try {
    const res = await worker.fetch(req("/sitemap.xml"), seoEnv(), {});
    const xml = await res.text();
    ok("sitemap 上游挂 → 仍 200 且只含固定页（无 /post 条目）",
      res.status === 200 && xml.includes("<loc>https://site.test</loc>") && !xml.includes("/post/"));
  } finally { c.restore(); }
}

console.log(`worker-test: ${pass} pass, ${fails.length} fail`);
for (const f of fails) console.log("FAIL  " + f);
if (fails.length) process.exit(1);

