/* 暖心墙云端数据层纯函数单测（Node 直跑，无需浏览器/服务器/网络）
 *   node tools/wall-test.mjs
 */
import {
  rowsToPosts, aggregateReactions, rowsToComments, canDeleteCloud,
  canReadWall, canUseWall, countsFromRows,
} from "../src/utils/wall.js";
import { canDelete, displayCount } from "../src/utils/comments.js";

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log("PASS ", name); }
  else { fail++; console.log("FAIL ", name); }
}

const imgFor = (p) => "https://x.test/" + p;

/* —— rowsToPosts —— */
const rows = [
  { id: 7, user_id: "u1", author_name: "Mochi", body: "hi", image_path: "u1/a.jpg", created_at: "2026-01-01T00:00:00Z" },
  { id: 8, user_id: "u2", author_name: "", body: "no img", image_path: null, created_at: "not-a-date" },
];
const rp = rowsToPosts(rows, {}, imgFor);
ok("T1 帖子映射：id 加 c 前缀", rp[0].id === "c7" && rp[0].dbId === 7);
ok("T2 帖子映射：作者缺省 Guest", rp[1].name === "Guest");
ok("T3 帖子映射：imagePath 经 imageUrlFor 变公开 URL", rp[0].img === "https://x.test/u1/a.jpg");
ok("T4 帖子映射：无图帖子 img 为空串", rp[1].img === "");
ok("T5 帖子映射：坏日期兜底为当前时间", rp[1].ts > 0);
ok("T6 帖子映射：cloud 标记 + userId 透传", rp[0].cloud === true && rp[0].userId === "u1");
ok("T7 非数组输入返回空数组", rowsToPosts(null).length === 0 && rowsToPosts(undefined).length === 0);

/* —— aggregateReactions —— */
const rk = [
  { post_id: 7, user_id: "u1", kind: "hug" },
  { post_id: 7, user_id: "u2", kind: "hug" },
  { post_id: 7, user_id: "u1", kind: "warm" },
  { post_id: 9, user_id: "u2", kind: "relate" },
];
const ag = aggregateReactions(rk, "u2");
ok("T8 回应聚合：计数正确", ag[7].hug === 2 && ag[7].warm === 1 && ag[9].relate === 1);
ok("T9 回应聚合：mine 按当前用户判定", ag[7].mine.hug === true && ag[7].mine.warm === false && ag[9].mine.relate === true);
ok("T10 回应聚合：无用户时不误标 mine", aggregateReactions(rk)[7].mine.hug === false && aggregateReactions(rk)[9].mine.relate === false);
ok("T11 回应聚合：空/脏输入安全", Object.keys(aggregateReactions([])).length === 0 && Object.keys(aggregateReactions(null)).length === 0);

/* —— rowsToComments —— */
const rc = rowsToComments([{ id: 3, post_id: 7, user_id: "u1", author_name: "Bean", body: "hey", created_at: "2026-01-02T00:00:00Z" }]);
ok("T12 评论映射：id/dbId/name/text/cloud", rc[0].id === "c3" && rc[0].dbId === 3 && rc[0].name === "Bean" && rc[0].text === "hey" && rc[0].cloud === true);
ok("T13 评论映射：非数组安全", rowsToComments("x").length === 0);

/* —— rowsToComments：二级评论（parent_id / reply_to_name） —— */
const rcs = rowsToComments([
  { id: 3, post_id: 7, user_id: "u1", author_name: "Bean", body: "root", created_at: "2026-01-02T00:00:00Z", parent_id: null, reply_to_name: null },
  { id: 4, post_id: 7, user_id: "u2", author_name: "Juno", body: "r1", created_at: "2026-01-02T00:01:00Z", parent_id: 3, reply_to_name: "Bean" },
  { id: 5, post_id: 7, user_id: "u2", author_name: "Juno", body: "r2", created_at: "2026-01-02T00:02:00Z", parent_id: 3, reply_to_name: null },
  { id: 6, post_id: 7, user_id: "u2", author_name: "Juno", body: "r3", created_at: "2026-01-02T00:03:00Z", parent_id: "3", reply_to_name: "Bean" },
]);
ok("T21 评论映射：parent_id → parentId（加 c 前缀，与 id 命名对齐）", rcs[1].parentId === "c3" && rcs[1].id === "c4");
ok("T22 评论映射：parent_id 为空 → parentId=null（一级评论）", rcs[0].parentId === null && rcs[0].replyTo === "");
ok("T23 评论映射：reply_to_name → replyTo，缺省为空串", rcs[1].replyTo === "Bean" && rcs[2].replyTo === "" && rcs[2].parentId === "c3");
ok("T24 评论映射：PostgREST 返回字符串型 parent_id 也能解析", rcs[3].parentId === "c3" && rcs[3].replyTo === "Bean");

/* —— countsFromRows：进页面时的「每帖评论数」（含回复） —— */
const cnt = countsFromRows([
  { post_id: 7 }, { post_id: 7 }, { post_id: 7 }, { post_id: 9 },
  { post_id: null }, null, "x",
]);
ok("T25 countsFromRows：按帖计数（一级 + 回复都算）", cnt[7] === 3 && cnt[9] === 1);
ok("T26 countsFromRows：空/脏输入安全", Object.keys(countsFromRows([])).length === 0 && Object.keys(countsFromRows(null)).length === 0 && Object.keys(countsFromRows("x")).length === 0);
ok("T27 countsFromRows + displayCount：进页面即显示真实评论数（0 → 3，bug 修复回归）", displayCount(undefined, cnt[7]) === 3);

/* —— 删除权限 —— */
const cloudCmt = { id: "c3", cloud: true, userId: "u1", name: "Bean" };
const otherCmt = { id: "c4", cloud: true, userId: "u2", name: "Juno" };
ok("T14 canDeleteCloud：本人云评论可删", canDeleteCloud(cloudCmt, "u1") === true);
ok("T15 canDeleteCloud：他人云评论不可删", canDeleteCloud(otherCmt, "u1") === false);
ok("T16 canDeleteCloud：未登录/非云评论不可删", canDeleteCloud(cloudCmt, "") === false && canDeleteCloud({ id: 1 }, "u1") === false);
ok("T17 canDelete 云端分支：按 userId 判定（新逻辑回归）", canDelete(cloudCmt, "随便什么昵称", "u1") === true && canDelete(otherCmt, "Bean", "u1") === false);
ok("T18 canDelete 本地分支：仍按昵称判定（旧逻辑回归）", canDelete({ id: 1, name: "Bean" }, "Bean") === true && canDelete({ id: 1, name: "Bean" }, "Juno") === false && canDelete({ id: 1, name: "Bean" }, "") === false);

/* —— 读写权限拆分（P1：未登录也能读云端墙，写入仍需登录） —— */
ok("T19 canReadWall：未配置云端时为 false", canReadWall() === false);
ok("T20 不变量：canReadWall=false ⇒ canUseWall=false", !canReadWall() ? canUseWall() === false : true);

console.log(`\nTOTAL ${pass + fail}  PASS ${pass}  FAIL ${fail}`);
process.exit(fail ? 1 : 0);
