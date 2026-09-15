/* 暖心墙云端数据层纯函数单测（Node 直跑，无需浏览器/服务器/网络）
 *   node tools/wall-test.mjs
 */
import {
  rowsToPosts, aggregateReactions, rowsToComments, canDeleteCloud,
  canReadWall, canUseWall,
} from "../src/utils/wall.js";
import { canDelete } from "../src/utils/comments.js";

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
