/* 网关模式数据层契约测试（阶段 2）
 * ------------------------------------------------------------
 * 用「会记录请求的假 fetch」跑 src/utils/api/db.gateway.js 的每个方法，断言：
 *   1. 端点：路径 / 查询 / 方法 / body 与 worker/api.js 的路由一一对应；
 *   2. 鉴权：登录后每个请求带 Authorization: Bearer <token>，未登录不带；
 *   3. 红线：upsertPetProfile 的 body 只含 user_id/data/updated_at（绝不覆盖 pats/feeds 计数）。
 * 与 tools/worker-test.mjs（Worker 侧）成对：两端形状都对上，端到端才通。
 * 运行：node tools/gateway-contract-test.mjs
 */
import { db, setGatewayAuthProbe } from "../src/utils/api/db.gateway.js";
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
    ok("deleteComment 端点", u(7) === "/api/comments/c1" && m(7) === "DELETE");
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
  } finally {
    c.restore();
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
    await db.adminBroadcast("hi");
    await db.notifClear();
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
    ok("adminBroadcast 端点+body", u(7) === "/api/admin/broadcast" && m(7) === "POST" && b(7) === JSON.stringify({ body: "hi" }), u(7));
    ok("notifClear 端点", u(8) === "/api/notifications/clear" && m(8) === "POST" && b(8) === JSON.stringify({}), u(8));
  } finally {
    c.restore();
  }
}

setGatewayAuthProbe(null);
setAuthTokenProvider(() => "");
console.log(`gateway-contract: ${pass} pass, ${fails.length} fail`);
for (const f of fails) console.log("FAIL  " + f);
if (fails.length) process.exit(1);

