/* 评论系统逻辑单元测试（纯 Node，无需浏览器） */
import assert from "node:assert/strict";
import {
  seedComments, listComments, countComments, addComment, removeComment,
  canDelete, normalizeText, postKey, MAX_LEN, MAX_PER_POST, SEEDS,
  topComments, repliesOf, replyCount, displayCount,
} from "../src/utils/comments.js";

const out = [];
let pass = 0, fail = 0;

function t(name, fn) {
  try {
    fn();
    pass++;
    out.push("PASS  " + name);
  } catch (e) {
    fail++;
    out.push("FAIL  " + name + "  → " + e.message);
  }
}

const EN = seedComments({}, "en");

t("T1 首次访问注入 3 条示范评论", () => {
  assert.equal(Object.keys(SEEDS).length, 3);
  for (const k of Object.keys(SEEDS)) assert.equal(listComments(EN, { id: k, sample: true }).length, 1);
});

t("T2 注入幂等：重复调用不会重复添加", () => {
  const again = seedComments(EN, "en");
  for (const k of Object.keys(SEEDS)) assert.equal(listComments(again, { id: k, sample: true }).length, 1);
});

t("T3 中文环境注入中文评论", () => {
  const zh = seedComments({}, "zh");
  assert.equal(listComments(zh, { id: "s1", sample: true })[0].text, SEEDS.s1.zh);
});

t("T4 删除示范评论后重新 seed 不会复活（真实 bug 修复验证）", () => {
  const seededComment = listComments(EN, { id: "s1", sample: true })[0];
  const afterDel = removeComment(EN, { id: "s1", sample: true }, seededComment.id);
  assert.equal(listComments(afterDel, { id: "s1", sample: true }).length, 0);
  const reSeeded = seedComments(afterDel, "en");
  assert.equal(listComments(reSeeded, { id: "s1", sample: true }).length, 0);
});

t("T5 空 / 纯空格输入被拒绝", () => {
  for (const bad of ["", "   ", "\n\t ", null, undefined]) {
    const r = addComment(EN, { id: "s1", sample: true }, { name: "A", text: bad });
    assert.equal(r.ok, false, "应拒绝: " + JSON.stringify(bad));
    assert.equal(r.reason, "empty");
  }
});

t("T6 超长文本截断到 200 字", () => {
  const r = addComment(EN, { id: "s1", sample: true }, { name: "A", text: "x".repeat(500) });
  assert.equal(r.ok, true);
  assert.equal(listComments(r.store, { id: "s1", sample: true }).at(-1).text.length, MAX_LEN);
});

t("T7 文本首尾空白被清理", () => {
  const r = addComment(EN, { id: "s1", sample: true }, { name: "A", text: "  hi  " });
  assert.equal(listComments(r.store, { id: "s1", sample: true }).at(-1).text, "hi");
});

t("T8 不同帖子的评论互不影响", () => {
  let s = addComment(EN, { id: "s1", sample: true }, { name: "A", text: "one" }).store;
  s = addComment(s, { id: "s2", sample: true }, { name: "A", text: "two" }).store;
  assert.equal(listComments(s, { id: "s1", sample: true }).at(-1).text, "one");
  assert.equal(listComments(s, { id: "s2", sample: true }).at(-1).text, "two");
  assert.equal(countComments(s, { id: "s1", sample: true }), 2);
});

t("T9 删除只移除目标评论", () => {
  let s = addComment(EN, { id: "s1", sample: true }, { name: "A", text: "a" }).store;
  s = addComment(s, { id: "s1", sample: true }, { name: "A", text: "b" }).store;
  const before = listComments(s, { id: "s1", sample: true });
  const target = before.find((c) => c.text === "a");
  const after = removeComment(s, { id: "s1", sample: true }, target.id);
  const texts = listComments(after, { id: "s1", sample: true }).map((c) => c.text);
  assert.deepEqual(texts.filter((x) => x === "b").length, 1);
  assert.equal(texts.includes("a"), false);
});

t("T10 只能删除自己的评论", () => {
  const mine = { name: "Alice" };
  assert.equal(canDelete(mine, "Alice"), true);
  assert.equal(canDelete(mine, "Bob"), false);
  assert.equal(canDelete(mine, ""), false);
  assert.equal(canDelete(null, "Alice"), false);
});

t("T11 每帖评论数上限", () => {
  let s = EN;
  for (let i = 0; i < MAX_PER_POST; i++) {
    s = addComment(s, { id: "s1", sample: true }, { name: "A", text: "c" + i }).store;
  }
  const r = addComment(s, { id: "s1", sample: true }, { name: "A", text: "overflow" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "full");
});

t("T12 用户帖（数字 id）与示例帖键名一致可比", () => {
  assert.equal(postKey({ id: 1730000000000 }), "1730000000000");
  assert.equal(postKey({ id: "s1", sample: true }), "s1");
});

t("T13 不修改入参（纯函数）", () => {
  const base = seedComments({}, "en");
  const snapshot = JSON.stringify(base);
  addComment(base, { id: "s1", sample: true }, { name: "A", text: "z" });
  removeComment(base, { id: "s1", sample: true }, "whatever");
  assert.equal(JSON.stringify(base), snapshot);
});

t("T14 normalizeText 边界", () => {
  assert.equal(normalizeText("abc"), "abc");
  assert.equal(normalizeText("   "), "");
  assert.equal(normalizeText(null), "");
  assert.equal(normalizeText("字".repeat(300)).length, MAX_LEN);
});

t("T15 空存储 / 脏数据不崩", () => {
  assert.deepEqual(listComments({}, { id: "x", sample: true }), []);
  assert.deepEqual(listComments(null, null), []);
  assert.equal(countComments({ s1: "not-an-array" }, { id: "s1", sample: true }), 0);
  assert.equal(addComment({}, null, { text: "x" }).reason, "no-post");
});

t("T16 恰好 200 字：原样保留不截断", () => {
  const p2 = { id: 90001 };
  const r = addComment(EN, p2, { name: "A", text: "y".repeat(MAX_LEN) });
  assert.equal(r.ok, true);
  assert.equal(listComments(r.store, p2).at(-1).text.length, MAX_LEN);
});

t("T17 201 字：截断到 200（上限硬约束回归）", () => {
  const p2 = { id: 90002 };
  const r = addComment(EN, p2, { name: "A", text: "z".repeat(MAX_LEN + 1) });
  assert.equal(r.ok, true);
  assert.equal(listComments(r.store, p2).at(-1).text.length, MAX_LEN);
});

t("T18 一级评论：parentId 为空，进主列表", () => {
  const p = { id: 91001 };
  const r = addComment({}, p, { name: "A", text: "root" });
  assert.equal(r.ok, true);
  assert.equal(r.comment.parentId, null);
  assert.equal(r.comment.replyTo, "");
  assert.equal(topComments(r.store, p).length, 1);
});

t("T19 回复一级评论：挂在该评论下，不进主列表但算总评论数", () => {
  const p = { id: 91002 };
  let s = addComment({}, p, { name: "A", text: "root" }).store;
  const rid = topComments(s, p)[0].id;
  const r = addComment(s, p, { name: "B", text: "reply", parentId: rid });
  s = r.store;
  assert.equal(r.comment.parentId, rid);
  assert.equal(repliesOf(s, p, rid).length, 1);
  assert.equal(replyCount(s, p, rid), 1);
  assert.equal(topComments(s, p).length, 1);
  assert.equal(countComments(s, p), 2);
});

t("T20 回复「回复」：两级封顶，仍挂在同一个一级评论下并自动 @被回复者", () => {
  const p = { id: 91003 };
  let s = addComment({}, p, { name: "A", text: "root" }).store;
  const rid = topComments(s, p)[0].id;
  s = addComment(s, p, { name: "B", text: "r1", parentId: rid }).store;
  const r1 = repliesOf(s, p, rid)[0];
  const r2 = addComment(s, p, { name: "C", text: "r2", parentId: r1.id });
  assert.equal(r2.ok, true);
  assert.equal(r2.comment.parentId, rid, "不应产生第三层");
  assert.equal(r2.comment.replyTo, "B", "应 @ 被回复的那位");
  assert.equal(repliesOf(r2.store, p, rid).length, 2);
  assert.equal(repliesOf(r2.store, p, r1.id).length, 0, "回复下不应再挂回复");
});

t("T21 直接回复一级作者：不冗余 @；显式给 replyTo 时以显式为准", () => {
  const p = { id: 91004 };
  let s = addComment({}, p, { name: "A", text: "root" }).store;
  const rid = topComments(s, p)[0].id;
  assert.equal(addComment(s, p, { name: "B", text: "hi", parentId: rid }).comment.replyTo, "");
  const r = addComment(s, p, { name: "B", text: "hi", parentId: rid, replyTo: "A" });
  assert.equal(r.comment.replyTo, "A");
});

t("T22 parentId 指向不存在 / 非本帖的评论 → 退化为一级评论", () => {
  const p = { id: 91005 };
  const other = { id: 91006 };
  const s = addComment({}, p, { name: "A", text: "root" }).store;
  const ghost = addComment(s, p, { name: "B", text: "x", parentId: "no-such-id" });
  assert.equal(ghost.ok, true);
  assert.equal(ghost.comment.parentId, null);
  assert.equal(topComments(ghost.store, p).length, 2);
  const cross = addComment(s, other, { name: "B", text: "y", parentId: topComments(s, p)[0].id });
  assert.equal(cross.comment.parentId, null, "别的帖里的 id 在本帖无效");
  assert.equal(topComments(cross.store, other).length, 1);
});

t("T23 删一级评论：其回复一并删除（与云端 FK 级联一致）", () => {
  const p = { id: 91007 };
  let s = addComment({}, p, { name: "A", text: "root" }).store;
  const rid = topComments(s, p)[0].id;
  s = addComment(s, p, { name: "B", text: "r1", parentId: rid }).store;
  s = addComment(s, p, { name: "C", text: "r2", parentId: rid }).store;
  assert.equal(countComments(s, p), 3);
  const after = removeComment(s, p, rid);
  assert.equal(countComments(after, p), 0);
  assert.deepEqual(topComments(after, p), []);
  assert.equal(after[postKey(p)], undefined, "空了要删键，存储不留空数组");
});

t("T24 删一条回复不动一级评论和其它回复", () => {
  const p = { id: 91008 };
  let s = addComment({}, p, { name: "A", text: "root" }).store;
  const rid = topComments(s, p)[0].id;
  s = addComment(s, p, { name: "B", text: "r1", parentId: rid }).store;
  const delId = repliesOf(s, p, rid)[0].id;
  s = addComment(s, p, { name: "C", text: "r2", parentId: rid }).store;
  const after = removeComment(s, p, delId);
  assert.equal(topComments(after, p).length, 1);
  assert.equal(repliesOf(after, p, rid).length, 1);
  assert.equal(repliesOf(after, p, rid)[0].text, "r2");
});

t("T25 displayCount：没拉评论明细时先用云端聚合数（评论数不再显示 0 —— bug 修复回归）", () => {
  assert.equal(displayCount(undefined, 2), 2);
  assert.equal(displayCount(undefined, 0), 0);
  assert.equal(displayCount(undefined, null), 0);
  assert.equal(displayCount(undefined, -3), 0, "负数按 0 处理");
  assert.equal(displayCount(undefined, "7"), 7);
  assert.equal(displayCount([], 5), 0, "已拉到本地且为空 → 以本地为准");
  assert.equal(displayCount([1, 2, 3], 0), 3, "本地增删即时反映");
  assert.equal(displayCount([1, 2], 99), 2);
});

t("T26 每帖上限把回复也算进去（回复绕不过 MAX_PER_POST）", () => {
  const p = { id: 91009 };
  let s = addComment({}, p, { name: "A", text: "root" }).store;
  const rid = topComments(s, p)[0].id;
  for (let i = 1; i < MAX_PER_POST; i++) {
    s = addComment(s, p, { name: "B", text: "r" + i, parentId: rid }).store;
  }
  assert.equal(countComments(s, p), MAX_PER_POST);
  const over = addComment(s, p, { name: "B", text: "more", parentId: rid });
  assert.equal(over.ok, false);
  assert.equal(over.reason, "full");
  assert.equal(replyCount(over.store, p, rid), MAX_PER_POST - 1);
});

out.push("");
out.push("TOTAL " + (pass + fail) + "  PASS " + pass + "  FAIL " + fail);

const fs = await import("node:fs");
fs.writeFileSync("comment-test.txt", out.join("\n"), "utf8");
console.log(out.join("\n"));