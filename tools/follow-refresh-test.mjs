/* ═══ 关注流「下拉刷新」数据源护栏（轮487）═══
 *
 * 用户实测：「暖心墙我的关注，下拉刷新，在没任何新增内容的情况下，
 *   第一次刷新是暂无新内容，第二次刷新就是那个 ♥ 的已刷新，怎么回事」。
 *
 * 真因（本轮改掉的东西，别再改回去）：
 *   下拉刷新没分流，进了 loadCloud({ fresh: true }) → cloudFetchWallRefresh，
 *   而那是服务端 wall_feed_page 的**全站**包（最新 20 条 + 7 天随机批，RPC 没有作者白名单）。
 *   拿全站包去比关注流那份列表 —— 「有没有新内容」的答案取决于两份数据重不重合，
 *   同一个动作两次就能得两种结论；命中「有新」还会 consume 整表替换成全站帖。
 *
 * 这套护栏守两件事：
 *   ① 纯函数 newFollowRows：这一页里哪些是列表没有的（页内顺序，不重排）；
 *   ② 源码分流：关注流的三条入口（下拉 / 刷新钮 / loadCloud 的 quiet·挂载校准）
 *      都必须走 refreshFollowFeed，而 refreshFollowFeed 只准拉关注作者那一页。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newFollowRows } from "../src/utils/followFeed.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

let pass = 0;
const fails = [];
const ok = (name, cond, extra = "") => {
  if (cond) { pass += 1; console.log("PASS  " + name); return; }
  fails.push(`${name}${extra ? ` — ${extra}` : ""}`);
  console.log("FAIL  " + name + (extra ? `\n      → ${extra}` : ""));
};
const t = (name, fn) => {
  try { fn(); } catch (e) { ok(name, false, e.message); return; }
  /* fn 内部用 ok 记录；这里只兜异常 */
};

/* ═════════ ① newFollowRows ═════════ */
t("N1 页里有列表没有的 → 只返回新的，保持页内顺序", () => {
  const page = [{ id: 9 }, { id: 5 }, { id: 3 }, { id: 1 }];
  const cur = [{ id: 3 }, { id: 1 }];
  ok("N1 页里有列表没有的 → 只返回新的，保持页内顺序",
    JSON.stringify(newFollowRows(page, cur).map((p) => p.id)) === "[9,5]",
    JSON.stringify(newFollowRows(page, cur).map((p) => p.id)));
});

t("N2 整页都在列表里 → 空（这就是「暂无新内容」的唯一判据）", () => {
  const page = [{ id: 3 }, { id: 2 }, { id: 1 }];
  const cur = [{ id: 3 }, { id: 2 }, { id: 1 }, { id: 0 }];
  ok("N2 整页都在列表里 → 空", newFollowRows(page, cur).length === 0);
});

t("N3 列表为空 → 整页都算新", () => {
  const page = [{ id: 3 }, { id: 2 }];
  ok("N3 列表为空 → 整页都算新", newFollowRows(page, []).length === 2);
});

t("N4 脏输入安全（null / 非数组 / 无 id 行）", () => {
  ok("N4 脏输入安全", newFollowRows(null, null).length === 0
    && newFollowRows(undefined, [{ id: 1 }]).length === 0
    && newFollowRows([null, "x", { body: "no-id" }, { id: 7 }], []).map((p) => p.id).join() === "7");
});

t("N5 id 类型不一致也能去重（数字 vs 字符串）", () => {
  ok("N5 id 类型不一致也能去重", newFollowRows([{ id: "12" }], [{ id: 12 }]).length === 0);
});

t("N6 不修改入参", () => {
  const page = [{ id: 2 }, { id: 1 }];
  const cur = [{ id: 1 }];
  newFollowRows(page, cur);
  ok("N6 不修改入参", page.length === 2 && cur.length === 1);
});

/* ═════════ ② 源码分流（关注流只有一个数据源）═════════ */
const src = read("src/views/CommunityView.vue");
const slice = (from, to) => {
  const i = src.indexOf(from);
  if (i < 0) return "";
  const j = to ? src.indexOf(to, i + from.length) : -1;
  return src.slice(i, j > 0 ? j : i + 4000);
};
const loadCloud = slice("async function loadCloud(", "/* 触底续载");
const te = slice("async function te()", "/* ════════ 网页端刷新按钮");
const manual = slice("async function manualRefresh(", "/* ═════════ 轮 294");
const followRefresh = slice("async function refreshFollowFeed(", "function exitFollowFeed");
const merger = slice("function mergeFollowPage(", "async function refreshFollowFeed(");

ok("R1 loadCloud 顶部把关注流改道到 refreshFollowFeed",
  /if \(followOnly\.value\) return refreshFollowFeed\(/.test(loadCloud),
  loadCloud.slice(0, 400));

ok("R2 下拉刷新（te）在关注流走 refreshFollowFeed", /if \(followOnly\.value\)[\s\S]{0,80}refreshFollowFeed\(/.test(te));

ok("R3 网页刷新钮（manualRefresh）在关注流走 refreshFollowFeed", /if \(followOnly\.value\)[\s\S]{0,60}refreshFollowFeed\(/.test(manual));

ok("R4 refreshFollowFeed 只拉关注作者那一页（cloudFetchPosts + userIds）",
  /cloudFetchPosts\(REFRESH_PAGE, 0, \{ userIds: ids \}\)/.test(followRefresh), followRefresh.slice(0, 200));

ok("R5 refreshFollowFeed 绝不含全站合并包（cloudFetchWallRefresh）",
  !/cloudFetchWallRefresh/.test(followRefresh));

ok("R6 refreshFollowFeed 不用「整页陌生」判新（不调 hasNewPosts）",
  !/hasNewPosts/.test(followRefresh));

ok("R7 有新内容只并回顶部，不整表替换（mergeFollowPage 里 [...adds, ...cur]）",
  /cloudPosts\.value = \[\.\.\.adds, \.\.\.cur\]/.test(merger), merger.slice(0, 300));

ok("R8 mergeFollowPage 只在列表为空时整表铺（consume 仅此一处）",
  (merger.match(/consume\(/g) || []).length === 1 && /if \(!cur\.length\)/.test(merger));

ok("R9 新内容进来后解除「到底」（否则触底不再续载）", /cloudDone\.value = false/.test(merger));

ok("R10 刷新失败如实提示（fail 分支存在）", /say\("fail"\)/.test(followRefresh));

ok("R11 静默口径存在（切回页签不弹提示条）", /\{ silent = false \}/.test(followRefresh) && /if \(!silent\)/.test(followRefresh));

const guardIdx = src.indexOf("if (box && box.rows.length) {");
const judgeIdx = src.indexOf("hasNewPosts(box.rows");
ok("R12 全部流的判定在 box 非空之后才跑（超时 box=null 会崩，把 loadingCloud 钉死在 true）",
  guardIdx > 0 && judgeIdx > guardIdx,
  `guard@${guardIdx} judge@${judgeIdx}`);

/* ═════════ 结果 ═════════ */
console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log("  ✗ " + f); process.exit(1); }
