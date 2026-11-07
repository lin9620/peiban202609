/* ═══ 关注流预热 + 本地快照（轮 459）═══
 *
 * 用户反馈：「暖心墙点击我的关注，进去非常慢，能不能在启动页的时候就获取一部分数据，缓存到本地」。
 * 这一套测的是**预热这台机器本身**，不起浏览器、不连网：
 *   · 启动期 warmFollowFeed() 是否真的把「名单 + 第一页」写进本地快照；
 *   · 快照是否按账号域分开、指纹是否跟着名单走；
 *   · 0 人关注时是否**绝不发帖列表请求**（服务端把空白名单当「不过滤」，会返回全站 —— 坑 8）；
 *   · 并发调用 refreshFollows 是否共用同一个在途请求（否则后到的拿到空名单 = 满屏「+ 关注」）。
 *
 * 做法：把 api/db.js 的 db 门面打桩（Node 里存储层自动降级成内存 Map，见 utils/storage.js），
 * 于是 follows.js / followFeed.js 里的真实代码路径会被完整执行一遍，只有网络那一层是假的。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

let pass = 0;
const fails = [];
const ok = (name, cond, extra = "") => {
  if (cond) { pass += 1; console.log("PASS  " + name); return; }
  fails.push(`${name}${extra ? ` — ${extra}` : ""}`);
  console.log("FAIL  " + name + (extra ? `\n      → ${extra}` : ""));
};

const { cloud } = await import("../src/utils/supabase.js");
const { db } = await import("../src/utils/api/db.js");

/* ── 打桩：只替网络那一层 ─────────────────────────────────────── */
const calls = { following: 0, listPosts: 0, lastPostsOpts: null, lastLimit: 0 };
let followingRows = [];
let postRows = [];
let followGate = null;   /* 手动控制 following() 何时返回（测并发单飞） */

db.ready = () => true;
db.following = async () => {
  calls.following += 1;
  if (followGate) await followGate;
  return followingRows;
};
db.listPosts = async (limit, opts = {}) => {
  calls.listPosts += 1;
  calls.lastLimit = limit;
  calls.lastPostsOpts = opts;
  return postRows;
};
db.listReactionsByPosts = async () => [];
db.listCommentPostIds = async () => [];

const { followState, refreshFollows } = await import("../src/utils/follows.js");
const {
  warmFollowFeed, readFollowSnap, saveFollowSnap, clearFollowSnap, idsSig, FOLLOW_SNAP_PAGE,
} = await import("../src/utils/followFeed.js");

/* ── 造数据：形状与 rowsToPosts 的入参一致 ────────────────────── */
const row = (id, uid) => ({
  id,
  user_id: uid,
  author_name: "T" + uid,
  body: "post " + id,
  image_path: "",
  created_at: new Date(Date.now() - id * 60000).toISOString(),
  views: 3,
  dislikes: 0,
  removed: false,
  tags: [],
  lang: "zh",
});

function login(uid = "u-follow-1") {
  cloud.ready = true;
  cloud.user = { id: uid };
}
function logout() {
  cloud.user = null;
  cloud.ready = false;
}
function resetState() {
  followState.ids = [];
  followState.rows = [];
  followState.loaded = false;
  followState.error = false;
}

/* ── P1 未登录：一次网络都不发 ─────────────────────────────────── */
logout();
resetState();
const before1 = calls.following + calls.listPosts;
ok("P1 未登录 → warmFollowFeed 直接返回 null，不发任何请求",
  (await warmFollowFeed({ force: true })) === null
    && calls.following + calls.listPosts === before1);

/* ── P2 0 人关注：只拉名单，绝不拉帖子 ─────────────────────────── */
login();
resetState();
followingRows = [];
const c0 = calls.listPosts;
const r2 = await warmFollowFeed({ force: true });
ok("P2 0 人关注 → 不发帖列表请求（空作者白名单会被服务端当成「不过滤」= 返回全站），快照为空",
  r2 === null && calls.listPosts === c0 && readFollowSnap() === null);

/* ── P3 正常预热：名单 + 第一页 → 写快照 ───────────────────────── */
followingRows = [
  { user_id: "u-a", nickname: "A", followed_at: "", post_count: 2, last_post_at: null },
  { user_id: "u-b", nickname: "B", followed_at: "", post_count: 1, last_post_at: null },
];
postRows = [row(101, "u-a"), row(102, "u-b"), row(103, "u-a")];
resetState();
const snap3 = await warmFollowFeed({ force: true });
ok("P3 启动预热把「名单 + 第一页」写进本地快照",
  !!snap3 && snap3.rows.length === 3 && snap3.sig === idsSig(followState.ids));
ok("P4 预热的帖列表只查我关注的人（userIds 就是名单，不是空）",
  calls.lastPostsOpts && Array.isArray(calls.lastPostsOpts.userIds)
    && calls.lastPostsOpts.userIds.join(",") === "u-a,u-b");
ok("P5 条数与进页首屏同口径（FOLLOW_SNAP_PAGE，避免进页后又整体换一遍）",
  calls.lastLimit === FOLLOW_SNAP_PAGE && FOLLOW_SNAP_PAGE === 20);

/* ── P6 快照新鲜就不再打网络（开机连点两次也只有一个来回）─────── */
const c6 = calls.listPosts;
const snap6 = await warmFollowFeed();
ok("P6 新鲜快照直接复用，不重复请求",
  snap6 && calls.listPosts === c6);

/* ── P7 名单变了：指纹跟着变，调用方据此整表换 ─────────────────── */
followingRows = [
  { user_id: "u-a", nickname: "A", followed_at: "", post_count: 2, last_post_at: null },
];
postRows = [row(201, "u-a"), row(202, "u-a")];
resetState();
const snap7 = await warmFollowFeed({ force: true });
ok("P7 关注名单一变，快照指纹随之变化（不相等 → 进页不许直接沿用）",
  snap7 && snap7.sig === idsSig(["u-a"]) && snap7.sig !== snap3.sig);

/* ── P8 关注清零：旧快照必须清掉，不能让别人关注流的内容留在设备上 ── */
followingRows = [];
postRows = [];
resetState();
await warmFollowFeed({ force: true });
ok("P8 关注清零后旧快照被清除（不留上一次的内容）", readFollowSnap() === null);

/* ── P8b 名单拉取失败 ≠ 没有关注：一次失败的预热不许清掉可用快照 ── */
followingRows = [{ user_id: "u-a", nickname: "A", followed_at: "", post_count: 1, last_post_at: null }];
postRows = [row(401, "u-a")];
resetState();
saveFollowSnap(["u-a"], [{ dbId: 401, id: "c401", ts: 1, text: "x" }], null);
db.following = async () => { calls.following += 1; throw new Error("offline"); };
resetState();
await warmFollowFeed({ force: true });
ok("P8b 名单拉取失败时保留旧快照（弱网下不能把能用的缓存清掉）",
  !!readFollowSnap() && readFollowSnap().rows.length === 1);
db.following = async () => { calls.following += 1; if (followGate) await followGate; return followingRows; };

/* ── P9 手写快照：能读回来，且带上评论数 ───────────────────────── */
followingRows = [{ user_id: "u-a", nickname: "A", followed_at: "", post_count: 1, last_post_at: null }];
resetState();
postRows = [row(301, "u-a")];
saveFollowSnap(["u-a"], [{ dbId: 301, id: "c301", ts: 1, text: "x" }], { 301: 7 });
const snap9 = readFollowSnap();
ok("P9 快照能存能读，评论数一并带上（进页连数字都是对的）",
  !!snap9 && snap9.rows.length === 1 && snap9.counts && snap9.counts[301] === 7);
clearFollowSnap();
ok("P10 clearFollowSnap 之后读不到（退出登录 / 0 关注用）", readFollowSnap() === null);

/* ── P11 并发 refreshFollows 共用同一个在途请求 ────────────────── */
resetState();
followingRows = [{ user_id: "u-z", nickname: "Z", followed_at: "", post_count: 0, last_post_at: null }];
let release;
followGate = new Promise((res) => { release = res; });
const c11 = calls.following;
const p1 = refreshFollows(true);
const p2 = refreshFollows(true);
release();
followGate = null;
const [ids1, ids2] = await Promise.all([p1, p2]);
ok("P11 两个并发调用只发一次名单请求，且都拿到同一份非空结果",
  calls.following - c11 === 1 && ids1.length === 1 && ids2.length === 1
    && ids1[0] === "u-z" && ids2[0] === "u-z");
ok("P12 名单请求结束后 inflight 放掉（下次 force 能真的再发）",
  (await refreshFollows(true), calls.following - c11 === 2));

/* ── P13 接线：进关注流必须先吃快照、再校准 ───────────────────── */
const community = read("src/views/CommunityView.vue");
const enterBody = (community.match(/async function enterFollowFeed\(\)[\s\S]*?\n\}/) || [""])[0];
ok("P13 进关注流 = 快照先上屏（readFollowSnap 在 refreshFollows 之前）",
  enterBody.indexOf("readFollowSnap()") > 0
    && enterBody.indexOf("readFollowSnap()") < enterBody.indexOf("await refreshFollows(true)"));
ok("P14 关注流快照写入时带名单（快照里的帖子必须能和「我关注谁」对上）",
  /saveFollowSnap\(ids, rows, null\)/.test(enterBody)
    && /saveFollowSnap\(ids, rows, counts\)/.test(enterBody));
ok("P15 启动预热接在 App.vue 的空闲回调上（不抢启动页带宽）",
  /requestIdleCallback\(warmFollow, \{ timeout: 6000 \}\)/.test(read("src/App.vue")));

logout();
console.log(`\nfollow-feed-test: ${pass} pass, ${fails.length} fail`);
if (fails.length) {
  console.log("失败项：");
  for (const f of fails) console.log("  ✗ " + f);
  process.exit(1);
}
