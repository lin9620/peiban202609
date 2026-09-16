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
  ok("profile 出站 URL", c.outbound[0].url === `${ORIGIN}/rest/v1/profiles?select=nickname%2Ccreated_at&id=eq.u1`, c.outbound[0].url);
  ok("profile object accept", hdr(c.outbound[0].init).get("accept") === "application/vnd.pgrst.object+json");
}
{
  const { res } = await hit([{ status: 406, body: { code: "PGRST116", message: "x" } }], "/api/users/u1/profile");
  ok("profile 行不存在 → 200 null", res.status === 200 && (await res.text()) === "null");
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
  const res = await worker.fetch(req("/api/img/u1/x.jpg"), makeEnv(), {});
  ok("img 302 → Storage 公开地址",
    res.status === 302 &&
    res.headers.get("location") === `${ORIGIN}/storage/v1/object/public/wall-images/u1/x.jpg`,
    String(res.headers.get("location")));
  ok("img 长缓存（内容哈希文件名）", (res.headers.get("cache-control") || "").includes("immutable"));
  const res2 = await worker.fetch(req("/api/img/u1/%2E%2E/x.jpg"), makeEnv(), {});
  ok("img 拒绝目录穿越", res2.status === 400);
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

console.log(`worker-test: ${pass} pass, ${fails.length} fail`);
for (const f of fails) console.log("FAIL  " + f);
if (fails.length) process.exit(1);

