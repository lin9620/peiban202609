/* 记录卡长文本折叠单测（轮 319 · 纯逻辑 + 两组件接线；运行 node tools/fold-text-test.mjs） */
import assert from "node:assert/strict";
import fs from "node:fs";
import { FOLD_MIN_CHARS, needsFold, foldKey, isOverflowing } from "../src/utils/foldText.js";

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("PASS  " + name); }
  catch (e) { fail++; console.log("FAIL  " + name + "  → " + e.message); }
}
const read = (p) => fs.readFileSync(new URL("../" + p, import.meta.url), "utf8");

t("needsFold：≤40 字不折（短内容零打扰）+ 空/脏输入安全", () => {
  assert.equal(needsFold(""), false);
  assert.equal(needsFold(null), false);
  assert.equal(needsFold(undefined), false);
  assert.equal(needsFold("x".repeat(FOLD_MIN_CHARS)), false, "恰好 40 字不折");
  assert.equal(needsFold("你好呀"), false);
  assert.equal(needsFold("x".repeat(FOLD_MIN_CHARS + 1)), true, "41 字进入测量");
  assert.equal(needsFold("  \n\n "), false, "纯空白不折");
  assert.equal(needsFold("你好呀"), false);
});
t("foldKey：信文与回信各自独立（一长一短互不拖累）", () => {
  assert.equal(foldKey(7, "body"), "7|body");
  assert.notEqual(foldKey(7, "body"), foldKey(7, "reply"));
  assert.equal(foldKey("u-1", "body"), "u-1|body");
});
t("isOverflowing：收起态 clamp 生效时可比（scrollHeight > clientHeight+2）", () => {
  assert.equal(isOverflowing(null), false, "null 元素安全");
  assert.equal(isOverflowing({ scrollHeight: 400, clientHeight: 100 }), true);
  assert.equal(isOverflowing({ scrollHeight: 100, clientHeight: 100 }), false);
  assert.equal(isOverflowing({ scrollHeight: 101, clientHeight: 100 }), false, "≤2px 容差");
});
t("BottleView 接线：两文本块 clamp + 按钮 + 测量 watch", () => {
  const v = read("src/components/BottleView.vue");
  assert.ok(v.includes("foldRef(foldKey(l.id, 'body'))"), "信文 ref 收集");
  assert.ok(v.includes("foldRef(foldKey(l.id, 'reply'))"), "回信 ref 收集");
  assert.ok(v.includes('t("bottle.foldMore", { n: l.body.length })'), "按钮带字数");
  assert.ok(/watch\(recRows, \(\) => \{ nextTick\(measureFolds\); \}\)/.test(v), "换页后补测");
  assert.ok((v.match(/fold-clamp/g) || []).length >= 2, "信文+回信各挂 clamp 条件");
});
t("BottleRecords 接线：details toggle 补测 + 两文本块", () => {
  const v = read("src/components/BottleRecords.vue");
  assert.ok(v.includes('@toggle="nextTick(measureFolds)"'), "details 展开后补测（display:none 测不了）");
  assert.ok(v.includes("foldRef(foldKey(row.id, 'body'))") && v.includes("foldRef(foldKey(row.id, 'reply'))"));
  assert.ok(v.includes("if (!el || !el.clientHeight) continue;"), "收起态跳过测量");
});
t("i18n：foldMore/foldLess zh/en 成对 + {n} 占位", () => {
  const i = read("src/i18n.js");
  assert.ok(/foldMore: "展开全文（\{n\} 字）"/.test(i) && /foldLess: "收起"/.test(i));
  assert.ok(/foldMore: "Show full letter \(\{n\} chars\)"/.test(i) && /foldLess: "Collapse"/.test(i));
});
t("样式：clamp 4 行 + 渐隐 + 按钮在全局 style.css", () => {
  const s = read("src/style.css");
  assert.ok(/\.fold-clamp \{[^}]*-webkit-line-clamp: 4/s.test(s));
  assert.ok(s.includes(".fold-fade") && s.includes(".fold-more"));
});

console.log("\nfold-text-test: TOTAL " + (pass + fail) + "  PASS " + pass + "  FAIL " + fail);
if (fail) process.exit(1);
