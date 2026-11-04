/* 轮 363 · 漂流瓶记录顶部空白带
 *   node tools/bottle-gap-test.mjs
 *
 * 用户截图：分段条「漂流瓶 | 会话中心 | 通知」和「漂流瓶记录」之间还有一条
 * 约 26px 的空白带（.dm-list 的 6px flex gap + 记录的 10px margin + 10px padding）。
 * 这里锁住：记录段不再叠 margin/padding，只保留列表自身的 6px 间距。
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const RECS = fs.readFileSync("src/components/BottleRecords.vue", "utf8");
const CSS = fs.readFileSync("src/style.css", "utf8");

let pass = 0;
const fails = [];
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fails.push(name + " —— " + e.message); } };
const block = (src, sel) => {
  const i = src.indexOf(sel + " {");
  if (i < 0) return "";
  const j = src.indexOf("}", i);
  return src.slice(i, j + 1);
};
const px = (b, prop) => {
  const m = b.match(new RegExp(prop + ":\\s*(-?\\d+(?:\\.\\d+)?)(?:px)?"));
  return m ? Number(m[1]) : null;
};

t("G1 漂流瓶记录段不再叠 margin-top / padding-top", () => {
  const b = block(RECS, ".bottle-records");
  assert.ok(b, "找不到 .bottle-records 规则");
  assert.equal(px(b, "margin-top"), 0, "margin-top 不是 0（顶部还会空一条）");
  assert.equal(px(b, "padding-top"), 0, "padding-top 不是 0（标题还会被往下推）");
});

t("G2 只保留 .dm-list 的 6px 间距，空白带不超过 8px", () => {
  const list = [...CSS.matchAll(/\.dm-list \{[^}]*\}/g)]
    .map((m) => m[0])
    .find((b) => /gap:\s*6px/.test(b));
  assert.ok(list, "找不到带 gap: 6px 的 .dm-list 规则");
  const rec = block(RECS, ".bottle-records");
  const total = px(list, "gap") + (px(rec, "margin-top") || 0) + (px(rec, "padding-top") || 0);
  assert.ok(total <= 8, `分段条到标题仍有 ${total}px 空白`);
});

t("G3 记录卡片本身的 12px 间距不受影响", () => {
  const b = block(RECS, ".bottle-record");
  assert.ok(b, "找不到 .bottle-record 规则");
  assert.equal(px(b, "margin-top"), 12, "记录卡片间距被误改");
});

console.log(`bottle-gap-test: ${pass} pass, ${fails.length} fail`);
if (fails.length) { for (const f of fails) console.log("  FAIL " + f); process.exit(1); }
