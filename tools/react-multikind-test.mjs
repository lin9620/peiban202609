/* 轮 354 · 暖心墙「多个回应按钮连续快点」回归
 *   node tools/react-multikind-test.mjs
 *
 * 病根：wall_set_reaction 的返回是「写完后整帖三份计数 + 我的三份状态」，
 * 但不同 kind 的请求走不同队列 key（post:<id>:<kind>）→ 并行。
 * 先发的旧响应可能最后到；旧代码整包写回，会把后点的另外两个 kind 按旧快照翻回去。
 * 实测：抱抱→暖暖→同感 80ms 连点，最终只剩抱抱亮（服务端三条都写成功了）。
 *
 * 本锁：
 *   A. 纯函数 applyReactionAuthoritative：乱序回包只动自己的 kind，绝不覆盖别的 kind。
 *   B. 暖心墙接入：必须用这个 helper，源码里不许再出现 fr.hug / fr.warm / fr.relate 整包写回。
 *   C. 帖子详情页回归：它一直是「只写本次 key」，别被改回整包。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { applyReactionAuthoritative } from "../src/utils/wallRules.js";
import { applyCommentReactionResult } from "../src/utils/comments.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

let pass = 0, fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log("PASS ", name); }
  else { fail++; console.log("FAIL ", name); }
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want));

console.log("── A. 纯函数：乱序权威回包只写自己的 kind ──");

/* 三连点后的本地乐观态：三个都点亮 */
const post = {
  dbId: 1001,
  reacts: { hug: 1, warm: 1, relate: 1, dislike: 2 },
  mine: { hug: true, warm: true, relate: true, dislike: true },
};

/* 三个请求在服务端到达时的快照（抱抱最早、同感最晚） */
const snapHug = { hug: 1, warm: 0, relate: 0, mine: { hug: true, warm: false, relate: false } };
const snapWarm = { hug: 1, warm: 1, relate: 0, mine: { hug: true, warm: true, relate: false } };
const snapRelate = { hug: 1, warm: 1, relate: 1, mine: { hug: true, warm: true, relate: true } };

/* 关键顺序：暖暖先回、同感再回、抱抱（最旧快照）最后回 */
const afterWarm = applyReactionAuthoritative(post, "warm", snapWarm);
eq("A1 暖暖回包：只把 warm 写回权威值，抱抱/同感保留乐观态",
  { reacts: afterWarm.reacts, mine: afterWarm.mine },
  { reacts: { hug: 1, warm: 1, relate: 1, dislike: 2 }, mine: { hug: true, warm: true, relate: true, dislike: true } });

const p2 = { ...post, ...afterWarm };
const afterRelate = applyReactionAuthoritative(p2, "relate", snapRelate);
eq("A2 同感回包：仍不碰抱抱/暖暖",
  { reacts: afterRelate.reacts, mine: afterRelate.mine },
  { reacts: { hug: 1, warm: 1, relate: 1, dislike: 2 }, mine: { hug: true, warm: true, relate: true, dislike: true } });

const p3 = { ...p2, ...afterRelate };
const afterHug = applyReactionAuthoritative(p3, "hug", snapHug);
eq("A3 抱抱的旧快照最后到：只写 hug，暖暖/同感不能被翻回 0",
  { reacts: afterHug.reacts, mine: afterHug.mine },
  { reacts: { hug: 1, warm: 1, relate: 1, dislike: 2 }, mine: { hug: true, warm: true, relate: true, dislike: true } });

/* 反向：取消其中一个，也只动自己 */
const off = applyReactionAuthoritative(
  { reacts: { hug: 1, warm: 1, relate: 1, dislike: 2 }, mine: { hug: true, warm: true, relate: true, dislike: true } },
  "warm",
  { hug: 1, warm: 0, relate: 1, mine: { hug: true, warm: false, relate: true } }
);
eq("A4 取消暖暖：只把 warm 归 0，抱抱/同感仍亮",
  { reacts: off.reacts, mine: off.mine },
  { reacts: { hug: 1, warm: 0, relate: 1, dislike: 2 }, mine: { hug: true, warm: false, relate: true, dislike: true } });

/* 脏数据 / 未知 kind 不炸、不乱写 */
const dirty = applyReactionAuthoritative({ reacts: { hug: 3 }, mine: { hug: true } }, "hug", { hug: -2, mine: {} });
eq("A5 负数计数钳到 0", dirty.reacts.hug, 0);
ok("A6 mine 缺失时保留本地 mine", dirty.mine.hug === true);
const badKind = applyReactionAuthoritative({ reacts: { hug: 3 } }, "dislike", { dislike: 99 });
eq("A7 非回应 kind（dislike）原样返回，不误写", badKind.reacts, { hug: 3 });
const noFresh = applyReactionAuthoritative({ reacts: { hug: 3 } }, "hug", null);
eq("A8 fresh 为空时原样返回", noFresh.reacts, { hug: 3 });

console.log("");
console.log("── B. 暖心墙接入：必须只写本次 kind ──");
const community = read("src/views/CommunityView.vue");
ok("B1 import applyReactionAuthoritative", /applyReactionAuthoritative/.test(community) && /from "\.\.\/utils\/wallRules\.js"/.test(community));
ok("B2 applyAuthoritative 调用 helper", /applyReactionAuthoritative\(post, kind, fr\)/.test(community));
ok("B3 不再出现 fr.hug / fr.warm / fr.relate 整包写回",
  !/fr\.(hug|warm|relate)/.test(community));
ok("B4 不再出现「nreacts.hug =」这类整包赋值",
  !/nreacts\.(hug|warm|relate)\s*=/.test(community));

console.log("");
console.log("── C. 帖子详情页：同一口径的回归锁 ──");
const detail = read("src/views/PostDetailView.vue");
ok("C1 只写 fresh[key]", /if \(fresh\[key\] != null\) fr\[key\] = Math\.max\(0, Number\(fresh\[key\]\) \|\| 0\)/.test(detail));
ok("C2 mine 只写 fresh.mine[key]", /if \(fresh\.mine && fresh\.mine\[key\] !== undefined\) fm\[key\] = !!fresh\.mine\[key\]/.test(detail));
ok("C3 不整包合并 fresh.mine", !/\.\.\.\(fresh\.mine \|\| \{\}\)/.test(detail));
ok("C4 详情页评论也走 applyCommentReactionResult", /applyCommentReactionResult\(cm, kind, res\)/.test(detail));

console.log("");
console.log("── D. 评论 ❤️/💔：同一条评论的两格也是并行队列，旧回包不能改另一格 ──");
const cmt = { reacts: { heart: 1, broken: 1 }, myReacts: ["heart", "broken"] };
/* ❤️ 的旧快照最后到：hearts=1、brokens=0，且 on=true */
const afterHeart = applyCommentReactionResult(cmt, "heart", { ok: true, on: true, hearts: 1, brokens: 0 });
eq("D1 旧快照只写 heart，broken 计数仍是 1", afterHeart.reacts, { heart: 1, broken: 1 });
eq("D2 旧快照只维护 heart，broken 高亮不丢", afterHeart.myReacts, ["heart", "broken"]);
/* 取消 ❤️：只删 heart，broken 保留 */
const offHeart = applyCommentReactionResult(cmt, "heart", { ok: true, on: false, hearts: 0, brokens: 1 });
eq("D3 取消 heart：只归零 heart", offHeart.reacts, { heart: 0, broken: 1 });
eq("D4 取消 heart：broken 仍亮", offHeart.myReacts, ["broken"]);
ok("D5 失败结果不写 UI（返回原对象）",
  applyCommentReactionResult(cmt, "heart", { ok: false, on: true, hearts: 9, brokens: 9 }) === cmt);

const community2 = read("src/views/CommunityView.vue");
ok("D6 暖心墙 import applyCommentReactionResult", /applyCommentReactionResult/.test(community2));
ok("D7 评论成功回包走 helper", /applyCommentReactionResult\(cm, kind, res\)/.test(community2));
ok("D8 不再整包覆盖 heart/broken 计数",
  !/cm\.reacts = \{ heart: res\.hearts, broken: res\.brokens \}/.test(community2));
ok("D9 评论失败只回滚当前 kind", /if \(prevReacts\[kind\] != null\) rr\[kind\] = prevReacts\[kind\]/.test(community2));

console.log("");
console.log(`TOTAL ${pass + fail}  PASS ${pass}  FAIL ${fail}`);
process.exit(fail ? 1 : 0);
