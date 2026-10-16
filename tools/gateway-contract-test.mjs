/* 网关模式数据层契约测试（阶段 2）
 * ------------------------------------------------------------
 * 用「会记录请求的假 fetch」跑 src/utils/api/db.gateway.js 的每个方法，断言：
 *   1. 端点：路径 / 查询 / 方法 / body 与 worker/api.js 的路由一一对应；
 *   2. 鉴权：登录后每个请求带 Authorization: Bearer <token>，未登录不带；
 *   3. 红线：upsertPetProfile 的 body 只含 user_id/data/updated_at（绝不覆盖 pats/feeds 计数）。
 * 与 tools/worker-test.mjs（Worker 侧）成对：两端形状都对上，端到端才通。
 * 运行：node tools/gateway-contract-test.mjs
 */
import { db, setGatewayAuthProbe, setGatewayTokenRefresher, __resetGatewayRateBackoff } from "../src/utils/api/db.gateway.js";
import { setAuthTokenProvider } from "../src/utils/api/authToken.js";

let pass = 0;
const fails = [];
function ok(name, cond, extra = "") {
  if (cond) pass++;
  else fails.push(name + (extra ? ` —— ${extra}` : ""));
}

function capture() {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, restore() { globalThis.fetch = real; } };
}

const enc = encodeURIComponent;
setGatewayAuthProbe(() => true); /* 单测注入：auth 就绪（与 db.supabase 的 setDbClient 对称） */

/* ── 就绪探测 ── */
{
  ok("ready()=true（探针注入）", db.ready() === true);
  setGatewayAuthProbe(null);
  ok("ready()=false（无探针、无 client）", db.ready() === false);
  setGatewayAuthProbe(() => true);
}

/* ── 鉴权头 ── */
{
  const c = capture();
  try {
    await db.listPosts(200);
    ok("未登录：不带 authorization", !new Headers(c.calls[0].init.headers).get("authorization"));
    setAuthTokenProvider(() => "tok-1");
    await db.listPosts(200);
    ok("登录后：Bearer <jwt>", new Headers(c.calls[1].init.headers).get("authorization") === "Bearer tok-1");
    setAuthTokenProvider(() => "");
  } finally {
    c.restore();
  }
}

/* ── 轮 62：before_id 游标（万帖级深翻页恒定成本） ── */
{
  const c = capture();
  try {
    await db.listPosts(50, { beforeId: 623 });
    ok("listPosts before_id 游标端点", c.calls[0].url === "/api/posts?limit=50&before_id=623", c.calls[0].url);
  } finally {
    c.restore();
  }
}

/* ── 轮 302：批量记浏览（POST /api/posts/views） ── */
{
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({
      ok: true,
      results: [{ post: 7, ok: true, counted: true, views: 3, dislikes: 0, removed: false }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const map = await db.addViews([7, 7, "x"], "v");
    ok("addViews 端点+body（轮 302 批量）",
      calls[0].url === "/api/posts/views" && (calls[0].init.method || "GET") === "POST"
      && calls[0].init.body === JSON.stringify({ ids: [7], viewer: "v" }),
      calls[0].url + " " + calls[0].init.body);
    ok("addViews 返回 Map", map instanceof Map && map.get(7).views === 3);
  } finally {
    globalThis.fetch = real;
  }
}

/* ── 端点形状（21 个方法一次跑完） ── */
{
  const c = capture();
  try {
    await db.listPosts(200);
    await db.listPostsByUser("u9", 50);
    await db.insertPost({ user_id: "u1", body: "hi" });
    await db.getProfile("u1");
    await db.listComments("p1", 200);
    await db.insertComment({ post_id: "p1" });
    await db.listCommentPostIds(["a", "b"], 500);
    await db.deleteComment("c1");
    await db.listReactionsByPosts(["a", "b"]);
    await db.listReactionsByPost("p1");
    await db.findReaction({ postId: "p", userId: "u", kind: "hug" });
    await db.insertReaction({ post_id: "p" });
    await db.deleteReaction({ postId: "p", userId: "u", kind: "hug" });
    await db.addView("p1", "v");
    await db.toggleDislike("p1");
    await db.petInteract("o1", "pat", "anon");
    await db.getPetProfile("u1");
    await db.upsertPetProfile("u1", { pet: { name: "M" } }, "2026-01-01T00:00:00.000Z");
    await db.uploadImage("u1/pet-ab12.jpg", new Uint8Array([1, 2, 3]), { mime: "image/png", upsert: true });
    await db.setStatus("u1", "working");
    await db.listRecentStatuses(12, "2026-01-01T00:00:00.000Z");

    const u = (i) => c.calls[i].url;
    const m = (i) => c.calls[i].init.method || "GET";
    const b = (i) => c.calls[i].init.body;
    ok("listPosts 端点", u(0) === "/api/posts?limit=200" && m(0) === "GET", u(0));
    ok("listPostsByUser 端点", u(1) === "/api/users/u9/posts?limit=50", u(1));
    ok("insertPost 端点+body", u(2) === "/api/posts" && m(2) === "POST" && b(2) === JSON.stringify({ user_id: "u1", body: "hi" }));
    ok("getProfile 端点", u(3) === "/api/users/u1/profile", u(3));
    ok("listComments 端点", u(4) === "/api/posts/p1/comments?limit=200", u(4));
    ok("insertComment 端点+body", u(5) === "/api/comments" && m(5) === "POST" && b(5) === JSON.stringify({ post_id: "p1" }));
    ok("listCommentPostIds 端点", u(6) === `/api/comment-post-ids?ids=${enc("a,b")}&limit=500`, u(6));
    ok("deleteComment 端点（轮 285 软删：POST /api/comments/delete，不 DELETE 行）",
      u(7) === "/api/comments/delete" && m(7) === "POST" && b(7) === JSON.stringify({ id: "c1" }),
      u(7) + " " + m(7) + " " + b(7));
    ok("listReactionsByPosts 端点", u(8) === `/api/reactions?ids=${enc("a,b")}`, u(8));
    ok("listReactionsByPost 端点", u(9) === "/api/posts/p1/reactions", u(9));
    ok("findReaction 端点", u(10) === "/api/reactions/mine?post_id=p&user_id=u&kind=hug", u(10));
    ok("insertReaction 端点+body", u(11) === "/api/reactions" && m(11) === "POST" && b(11) === JSON.stringify({ post_id: "p" }));
    ok("deleteReaction 端点", u(12) === "/api/reactions?post_id=p&user_id=u&kind=hug" && m(12) === "DELETE");
    ok("addView 端点+body", u(13) === "/api/posts/p1/view" && b(13) === JSON.stringify({ viewer: "v" }), u(13));
    ok("toggleDislike 端点", u(14) === "/api/posts/p1/dislike" && m(14) === "POST", u(14));
    ok("petInteract 端点+body", u(15) === "/api/pet/o1/interact" && b(15) === JSON.stringify({ kind: "pat", viewer: "anon" }), u(15));
    ok("getPetProfile 端点", u(16) === "/api/pet/u1", u(16));
    ok("upsertPetProfile 红线：body 只含 user_id/data/updated_at（绝不覆盖计数）",
      u(17) === "/api/pet/u1" && m(17) === "PUT" &&
      b(17) === JSON.stringify({ user_id: "u1", data: { pet: { name: "M" } }, updated_at: "2026-01-01T00:00:00.000Z" }),
      b(17));
    ok("uploadImage 端点+upsert 标记", u(18) === `/api/uploads?path=${enc("u1/pet-ab12.jpg")}&upsert=1` && m(18) === "POST", u(18));
    ok("uploadImage content-type", new Headers(c.calls[18].init.headers).get("content-type") === "image/png");
    ok("setStatus 端点+body（时间戳由 Worker 盖）",
      u(19) === "/api/users/u1/status" && m(19) === "PATCH" && b(19) === JSON.stringify({ status: "working" }), u(19));
    ok("listRecentStatuses 端点", u(20) === `/api/statuses?limit=12&since=${enc("2026-01-01T00:00:00.000Z")}`, u(20));
  } finally {
    c.restore();
  }
}

/* ── 管理员（RLS is_admin 兜底；Worker 只翻译） ── */
{
  const c = capture();
  try {
    await db.amAdmin();
    await db.adminOverview();
    await db.adminListPosts(50);
    await db.adminSetPostRemoved("p1", true);
    await db.adminDeletePost("p1");
    await db.adminListComments(100);
    await db.adminDeleteComment("c1");
    await db.adminUsersPage(0, 100);
    await db.adminClientLogsPage(0, 50);
    const u = (i) => c.calls[i].url;
    const m = (i) => c.calls[i].init.method || "GET";
    const b = (i) => c.calls[i].init.body;
    ok("amAdmin 端点", u(0) === "/api/admin/me" && m(0) === "GET", u(0));
    ok("adminOverview 端点", u(1) === "/api/admin/overview", u(1));
    ok("adminListPosts 端点", u(2) === "/api/admin/posts?limit=50", u(2));
    ok("adminSetPostRemoved 端点+body（PATCH）",
      u(3) === "/api/admin/posts/p1" && m(3) === "PATCH" && b(3) === JSON.stringify({ removed: true }), u(3));
    ok("adminDeletePost 端点（DELETE）", u(4) === "/api/admin/posts/p1" && m(4) === "DELETE", u(4));
    ok("adminListComments 端点", u(5) === "/api/admin/comments?limit=100", u(5));
    ok("adminDeleteComment 端点（DELETE）", u(6) === "/api/admin/comments/c1" && m(6) === "DELETE", u(6));
    ok("adminUsersPage 端点", u(7) === "/api/admin/users?offset=0&limit=100", u(7));
    /* 轮 270：客户端错误日志（只读分页；是否管理员由 DB 侧 admin_users 判定） */
    ok("adminClientLogsPage 端点", u(8) === "/api/admin/client-logs?offset=0&limit=50", u(8));
  } finally {
    c.restore();
  }
}

/* ── 轮 252：搜索 / 列探测（前端侧端点形状） ── */
{
  const c = capture();
  try {
    await db.searchPosts("q=%E5%BC%80%E5%BF%83&tags=%E5%92%96%E5%95%A1&limit=20&before_id=7");
    await db.probeColumns();
    const u = (i) => c.calls[i].url;
    ok("searchPosts 端点（原样透传查询串）",
      u(0) === `/api/posts/search?q=${enc("开心")}&tags=${enc("咖啡")}&limit=20&before_id=7`, u(0));
    ok("probeColumns 端点", u(1) === "/api/posts/columns", u(1));
  } finally {
    c.restore();
  }
  /* probeColumns 失败一律给 []（调用方保守走旧载荷，不炸发帖） */
  const real = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ message: "down" }), { status: 500, headers: { "content-type": "application/json" } });
    const cols = await db.probeColumns();
    ok("probeColumns 失败 → []", Array.isArray(cols) && cols.length === 0, JSON.stringify(cols));
  } finally {
    globalThis.fetch = real;
  }
}

/* ── imageUrl（纯字符串，不发请求） ── */
{
  ok("imageUrl → 同源 /api/img/*", db.imageUrl("u1/x.jpg") === "/api/img/u1/x.jpg", String(db.imageUrl("u1/x.jpg")));
  ok("imageUrl 拒绝目录穿越", db.imageUrl("../etc") === "");
}

/* ── 错误上抛 / 空响应 / 网络故障 / 未就绪 ── */
{
  const real = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ message: "boom" }), { status: 403, headers: { "content-type": "application/json" } });
    let msg = "";
    try { await db.insertPost({}); } catch (e) { msg = e && e.message; }
    ok("非 2xx → throw（消息取 message）", msg === "boom", msg);

    globalThis.fetch = async () => new Response(null, { status: 204 });
    let clean = true;
    try { await db.deleteComment("c1"); } catch (e) { clean = false; }
    ok("204 空 body → 不抛错", clean);

    /* 轮 285：老库没跑 MIGRATION_comment_delete.sql → 上游 404/PGRST202（Worker 原样透传）
     * → 认出「没这个函数」就退回硬删路由，行为与迁移前完全一致（不把没跑迁移当删除失败）。 */
    const seen = [];
    globalThis.fetch = async (url, init = {}) => {
      const u0 = String(url);
      seen.push([u0, (init && init.method) || "GET"]);
      if (u0.includes("/comments/delete")) {
        return new Response(
          JSON.stringify({ code: "PGRST202", message: "Could not find the function public.wall_comment_delete(p_id) in the schema cache" }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(null, { status: 204 });
    };
    let fellBack = "";
    try { await db.deleteComment("c1"); } catch (e) { fellBack = e && e.message; }
    ok("deleteComment 降级：函数不存在 → 退回 DELETE /api/comments/c1",
      !fellBack && seen.length === 2 && seen[1][0] === "/api/comments/c1" && seen[1][1] === "DELETE",
      fellBack || JSON.stringify(seen));

    globalThis.fetch = async () => { throw new Error("down"); };
    let msg2 = "";
    try { await db.listPosts(10); } catch (e) { msg2 = e && e.message; }
    ok("网络故障 → gateway-unreachable", msg2 === "gateway-unreachable", msg2);

    setGatewayAuthProbe(null);
    let msg3 = "";
    try { await db.listPosts(10); } catch (e) { msg3 = e && e.message; }
    ok("未就绪 → cloud-not-ready", msg3 === "cloud-not-ready", msg3);
  } finally {
    globalThis.fetch = real;
    setGatewayAuthProbe(null);
    setAuthTokenProvider(() => "");
  }
}

/* ── 私信端点形状（阶段 4） ── */
{
  setGatewayAuthProbe(() => true);
  const c = capture();
  try {
    await db.dmOpen("u2");
    await db.dmListConvs(50, 10);
    await db.dmBlocks();
    await db.dmBlock("u3");
    await db.dmUnblock("u3");
    await db.dmUnreadTotal();
    await db.dmRecall(99);
    const u = (i) => c.calls[i].url;
    const m = (i) => c.calls[i].init.method || "GET";
    const b = (i) => c.calls[i].init.body;
    ok("dmOpen 端点+body", u(0) === "/api/dm" && m(0) === "POST" && b(0) === JSON.stringify({ other: "u2" }), u(0));
    ok("dmListConvs 端点", u(1) === "/api/dm/convs?limit=50&offset=10", u(1));
    ok("dmBlocks 端点", u(2) === "/api/dm/blocks", u(2));
    ok("dmBlock 端点+body", u(3) === "/api/dm/blocks" && m(3) === "POST" && b(3) === JSON.stringify({ user: "u3" }), u(3));
    ok("dmUnblock 端点", u(4) === "/api/dm/blocks/u3" && m(4) === "DELETE", u(4));
    ok("dmUnreadTotal 端点", u(5) === "/api/dm/unread", u(5));
    ok("dmRecall 端点", u(6) === "/api/dm/messages/99/recall" && m(6) === "POST", u(6));
  } finally {
    c.restore();
  }
}
{
  setGatewayAuthProbe(() => true);
  const c = capture();
  try {
    await db.dmListMessages(7, null, 30);
    await db.dmListMessages(7, 123, 30);
    await db.dmSend(7, "hi", null);
    await db.dmConvMeta(7);
    await db.dmMarkRead(7);
    await db.dmHide(7);
    await db.dmUnhide(7);
    await db.dmMute(7, true);
    await db.dmAccept(7);
    const u = (i) => c.calls[i].url;
    const m = (i) => c.calls[i].init.method || "GET";
    const b = (i) => c.calls[i].init.body;
    ok("dmListMessages 首页", u(0) === "/api/dm/7/messages?limit=30", u(0));
    ok("dmListMessages 游标", u(1) === "/api/dm/7/messages?limit=30&before=123", u(1));
    ok("dmSend 端点+body", u(2) === "/api/dm/7/messages" && m(2) === "POST" && b(2) === JSON.stringify({ body: "hi", image: null }), u(2));
    ok("dmConvMeta 端点", u(3) === "/api/dm/7/meta", u(3));
    ok("dmMarkRead 端点", u(4) === "/api/dm/7/read" && m(4) === "POST", u(4));
    ok("dmHide 端点", u(5) === "/api/dm/7/hide" && m(5) === "POST", u(5));
    ok("dmUnhide 端点", u(6) === "/api/dm/7/unhide" && m(6) === "POST", u(6));
    ok("dmMute 端点+body", u(7) === "/api/dm/7/mute" && b(7) === JSON.stringify({ on: true }), u(7));
    ok("dmAccept 端点", u(8) === "/api/dm/7/accept" && m(8) === "POST", u(8));
  } finally {
    c.restore();
  }
}

/* ── 通知中心端点形状（阶段 4） ── */
{
  setGatewayAuthProbe(() => true);
  const c = capture();
  try {
    await db.notifPage({ offset: 10, limit: 30, kinds: null, unread: false });
    await db.notifPage({ offset: 0, limit: 30, kinds: ["comment", "reply"], unread: true });
    await db.notifUnread();
    await db.notifMark([1, 2], false);
    await db.notifMark([], true);
    await db.notifPrefsGet();
    await db.notifPrefsSet({ comments: true, reactions: false, pets: true, dms: false });
    await db.adminBroadcastStart("hi");
    await db.adminBroadcastStep("11111111-2222-3333-4444-555555555555");
    await db.adminBroadcasts(20, 0);
    await db.notifClear();
    await db.deleteMyAccount();
    const u = (i) => c.calls[i].url;
    const m = (i) => c.calls[i].init.method || "GET";
    const b = (i) => c.calls[i].init.body;
    ok("notifPage 全部", u(0) === "/api/notifications?offset=10&limit=30", u(0));
    ok("notifPage 过滤", u(1) === `/api/notifications?offset=0&limit=30&kinds=${enc("comment,reply")}&unread=1`, u(1));
    ok("notifUnread 端点", u(2) === "/api/notifications/unread", u(2));
    ok("notifMark 按列表", u(3) === "/api/notifications/read" && m(3) === "POST" && b(3) === JSON.stringify({ ids: [1, 2], all: false }), b(3));
    ok("notifMark 全部", b(4) === JSON.stringify({ ids: null, all: true }), b(4));
    ok("notifPrefsGet 端点", u(5) === "/api/notifications/prefs", u(5));
    ok("notifPrefsSet 端点+body", u(6) === "/api/notifications/prefs" && m(6) === "POST" &&
      b(6) === JSON.stringify({ comments: true, reactions: false, pets: true, dms: false }), b(6));
    ok("adminBroadcastStart 端点+body", u(7) === "/api/admin/broadcast" && m(7) === "POST" && b(7) === JSON.stringify({ body: "hi" }), u(7));
    ok("adminBroadcastStep 端点+bid", u(8) === "/api/admin/broadcast/step" && m(8) === "POST" && b(8) === JSON.stringify({ bid: "11111111-2222-3333-4444-555555555555" }), u(8));
    ok("adminBroadcasts 端点", u(9) === "/api/admin/broadcast?limit=20&offset=0" && m(9) === "GET", u(9));
    ok("notifClear 端点", u(10) === "/api/notifications/clear" && m(10) === "POST" && b(10) === JSON.stringify({}), u(10));
    ok("accountDelete 端点", u(11) === "/api/account/delete" && m(11) === "POST" && b(11) === JSON.stringify({}), u(11));
  } finally {
    c.restore();
  }
}

/* ── 轮 84 · 评论回应（👍心 / 💔碎心；独立块，不挤占上面大块的序号断言） ── */
{
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const body = String(url).includes("/api/comments/react")
      ? JSON.stringify({ ok: true, on: true, hearts: 2, brokens: 1 })
      : "[]";
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await db.listCommentReactions([3, 4]);
    await db.listMyCommentReactions([3, 4], "u1");
    const r = await db.toggleCommentReaction(9, "heart");
    const u = (i) => calls[i].url;
    const m = (i) => calls[i].init.method || "GET";
    const b = (i) => calls[i].init.body;
    ok("listCommentReactions 端点", u(0) === `/api/comments/reactions?ids=${enc("3,4")}`, u(0));
    ok("listMyCommentReactions 端点", u(1) === `/api/comments/reactions/mine?ids=${enc("3,4")}&user_id=u1`, u(1));
    ok("toggleCommentReaction 端点+body",
      u(2) === "/api/comments/react" && m(2) === "POST" && b(2) === JSON.stringify({ comment_id: 9, kind: "heart" }), u(2));
    ok("toggleCommentReaction 返回 RPC 权威计数", r && r.ok === true && r.hearts === 2 && r.brokens === 1);
  } finally {
    globalThis.fetch = real;
  }
}

/* ── 轮 145 · 故事栏（/api/story/* 七方法与 worker/api.js 路由一一对上） ── */
{
  const c = capture();
  try {
    await db.storySaveDraft(null, "", "草稿正文", ["治愈"]);
    await db.storyPublish(7, "标题", "正文", ["深夜", "成长"]);
    await db.storyToggleLike(7);
    await db.storyAddView(7);
    await db.storyRank("random", "", "2026-10", 20, 0);
    await db.storyRank("tag", "深夜", null, 10, 5);
    await db.storyGet(42);
    await db.storyMine("published", 30, 0);
    await db.storyMine();
    const u = (i) => c.calls[i].url;
    const m = (i) => c.calls[i].init.method || "GET";
    const b = (i) => c.calls[i].init.body;
    ok("storySaveDraft 端点+body（草稿宽容：标题可空、id 可空）",
      u(0) === "/api/story/draft" && m(0) === "POST" &&
      b(0) === JSON.stringify({ id: null, title: "", body: "草稿正文", tags: ["治愈"] }), u(0));
    ok("storyPublish 端点+body（标签透传数组）",
      u(1) === "/api/story/publish" && m(1) === "POST" &&
      b(1) === JSON.stringify({ id: 7, title: "标题", body: "正文", tags: ["深夜", "成长"] }), u(1));
    ok("storyToggleLike 端点+body",
      u(2) === "/api/story/like" && m(2) === "POST" && b(2) === JSON.stringify({ id: 7 }), u(2));
    ok("storyAddView 端点+body",
      u(3) === "/api/story/view" && m(3) === "POST" && b(3) === JSON.stringify({ id: 7 }), u(3));
    ok("storyRank 端点（random+period 排在 mode/limit/offset 后）",
      u(4) === "/api/story/rank?mode=random&limit=20&offset=0&period=2026-10", u(4));
    ok("storyRank 端点（tag 中文编码、无 period 不带参）",
      u(5) === `/api/story/rank?mode=tag&limit=10&offset=5&tag=${enc("深夜")}`, u(5));
    ok("storyGet 端点", u(6) === "/api/story/42" && m(6) === "GET", u(6));
    ok("storyMine 端点（显式 status）",
      u(7) === "/api/story/mine?limit=30&offset=0&status=published", u(7));
    ok("storyMine 端点（省略 status = 草稿+已发布）",
      u(8) === "/api/story/mine?limit=30&offset=0", u(8));
  } finally {
    c.restore();
  }
}

/* ── 轮 160：401 自愈（带身份请求 401 → 强制刷新会话 → 换新 token 重试一次） ── */
{
  setGatewayAuthProbe(() => true);
  /* 契约：refresher 刷新成功必须【同步更新 token 源】（生产= supabase.js 的 accessToken 闭包） */
  let cur = "expired-token";
  setAuthTokenProvider(() => cur);
  const real = globalThis.fetch;
  const calls = [];
  let n = 0;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    n++;
    if (n === 1) return new Response(JSON.stringify({ code: "PGRST301", message: "JWT expired" }),
      { status: 401, headers: { "content-type": "application/json" } });
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  };
  let refreshed = 0;
  setGatewayTokenRefresher(async () => { refreshed++; cur = "fresh-token"; return cur; });
  const rows = await db.listPosts(5, {});
  ok("401 → 刷新会话后重试成功", Array.isArray(rows) && n === 2 && refreshed === 1);
  ok("重试请求带的是新 token", String(calls[1].init.headers.authorization || "").includes("fresh-token"));
  ok("重试是同一端点原样重发", calls[1].url === calls[0].url);
  /* 刷新失败（拿不到新 token）→ 原错误上抛，绝不循环 */
  n = 0;
  setGatewayTokenRefresher(async () => "");
  let threw = "";
  try { await db.listPosts(5, {}); } catch (e) { threw = String(e.message || e); }
  ok("刷新失败 → 原样上抛只打一发", n === 1 && /JWT expired/.test(threw));
  /* 未带身份（匿名）401 不触发刷新重试 */
  setGatewayTokenRefresher(async () => { refreshed++; return "x"; });
  setAuthTokenProvider(() => "");
  n = 0;
  threw = "";
  try { await db.listPosts(5, {}); } catch (e) { threw = String(e.message || e); }
  ok("匿名 401 → 不刷新不重试", n === 1 && refreshed === 1 && /JWT expired/.test(threw));
  setGatewayTokenRefresher(null);
  setGatewayAuthProbe(null);
  setAuthTokenProvider(() => "");
  globalThis.fetch = real;
}

/* ── 轮 169：wallRefresh 合并包端点 ── */
{
  setGatewayAuthProbe(() => true);   /* 160 块结尾把探针清了，这里重新点亮 */
  const cap = capture();
  const pack = await db.wallRefresh(20);
  ok("wallRefresh：GET /wall/refresh?limit=20", cap.calls[0].url.includes("/wall/refresh?limit=20") && Array.isArray(pack));
  cap.restore();
}

/* ── 轮 311 · P1 429 退避 + P2 Turnstile 端点形状 ── */
{
  /* reportCreate 第五参 turnstile 透传（配了 secret 的 Worker 才强制校验） */
  const c = capture();
  try {
    await db.reportCreate("post", 9, "spam", "txt", "tok-abc");
    ok("轮311 reportCreate：body 带 turnstile token",
      c.calls[0].url === "/api/reports"
        && JSON.parse(c.calls[0].init.body).turnstile === "tok-abc",
      c.calls[0].init.body);
  } finally { c.restore(); }
  /* turnstileVerify 端点形状（capture 默认回 []，这里定制 {ok:true} 响应） */
  const c2real = globalThis.fetch;
  const c2calls = [];
  try {
    globalThis.fetch = async (url, init = {}) => {
      c2calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const r = await db.turnstileVerify("tok-1");
    ok("轮311 turnstileVerify：POST /turnstile/verify {token} → {ok:true}",
      c2calls[0].url === "/api/turnstile/verify"
        && JSON.parse(c2calls[0].init.body).token === "tok-1"
        && r.ok === true,
      c2calls[0].url);
  } finally { globalThis.fetch = c2real; }
  /* 429 → 按 Retry-After 退避：退避期内第二次调用 fail fast、不再发网络 */
  __resetGatewayRateBackoff();
  const real = globalThis.fetch;
  let n = 0;
  try {
    globalThis.fetch = async () => {
      n++;
      return new Response(JSON.stringify({ error: "rate-limited" }), { status: 429, headers: { "content-type": "application/json", "retry-after": "30" } });
    };
    let err1 = null;
    try { await db.listPosts(200); } catch (e) { err1 = e; }
    ok("轮311 收到 429 → 抛错且 status=429", err1 && err1.status === 429);
    let err2 = null;
    try { await db.listPosts(200); } catch (e) { err2 = e; }
    ok("轮311 退避期内第二次调用 fail fast（fetch 只被调 1 次）",
      n === 1 && err2 && err2.status === 429 && err2.message === "rate-limited",
      "fetch 调用数=" + n);
  } finally {
    globalThis.fetch = real;
    __resetGatewayRateBackoff();
  }
  /* 退避清零后恢复发网（模拟 Retry-After 到期） */
  const c3 = capture();
  try {
    const r = await db.listPosts(200);
    ok("轮311 退避清零后恢复（第二次 fetch 正常发出）", c3.calls.length === 1 && Array.isArray(r));
  } finally { c3.restore(); }
}

console.log(`gateway-contract: ${pass} pass, ${fails.length} fail`);
for (const f of fails) console.log("FAIL  " + f);
if (fails.length) process.exit(1);

