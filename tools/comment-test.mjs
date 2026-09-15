/* 评论系统逻辑单元测试（纯 Node，无需浏览器） */
import assert from "node:assert/strict";
import {
  seedComments, listComments, countComments, addComment, removeComment,
  canDelete, normalizeText, postKey, MAX_LEN, MAX_PER_POST, SEEDS,
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

out.push("");
out.push("TOTAL " + (pass + fail) + "  PASS " + pass + "  FAIL " + fail);

const fs = await import("node:fs");
fs.writeFileSync("comment-test.txt", out.join("\n"), "utf8");
console.log(out.join("\n"));