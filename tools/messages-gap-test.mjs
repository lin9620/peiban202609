/* 轮 358 · 消息页「漂流瓶段 / 会话顶部」留白锁（Node 直跑，只读源码）
 *   node tools/messages-gap-test.mjs
 *
 * 用户实报：
 *   1) App 消息 → 漂流瓶，顶部区块和下面「漂流瓶记录」之间空出一大段；
 *   2) 漂流瓶下面那段说明太长；
 *   3) 点进任意会话，聊天头上面还有一条空白（截图红框）。
 *
 * 锁的是三处：
 *   · 手机聊天页 .dm-thread 顶部只让状态栏（--sat），不再多垫 14px；
 *   · BottleView .mail-list / BottleRecords .bottle-records 的记录区上边距收紧；
 *   · 漂流瓶说明文案保持短句（防止以后又扩写回两大段）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const style = fs.readFileSync(path.join(root, "src/style.css"), "utf8");
const records = fs.readFileSync(path.join(root, "src/components/BottleRecords.vue"), "utf8");
const i18n = fs.readFileSync(path.join(root, "src/i18n.js"), "utf8");

let pass = 0, fail = 0; const out = [];
function t(name, fn) {
  try { fn(); pass++; out.push("ok   " + name); }
  catch (e) { fail++; out.push("FAIL " + name + " :: " + e.message); }
}

t("S1 手机聊天页 .dm-thread 顶部只让 --sat，不再额外垫 14px", () => {
  const m = style.match(/\.shell--mobile-nav\.shell--chat \.dm-thread\s*\{([\s\S]*?)\}/);
  assert.ok(m, "找不到手机聊天页 .dm-thread 规则");
  assert.match(m[1], /padding:\s*var\(--sat,\s*env\(safe-area-inset-top,\s*0px\)\)\s+0\s+var\(--sab,/,
    "padding 顶部必须是 var(--sat, env(...))");
  assert.doesNotMatch(m[1], /calc\(14px \+ var\(--sat/,
    "又退回了 calc(14px + var(--sat)) —— 3x 屏上就是聊天头上方那条空白");
});

t("S2 首页漂流瓶 .mail-list 记录区上边距收紧到 8/10px", () => {
  assert.match(style, /\.mail-list\s*\{[^}]*margin-top:\s*8px;[^}]*padding-top:\s*10px;/,
    ".mail-list 应为 margin-top:8px; padding-top:10px;");
  assert.doesNotMatch(style, /\.mail-list\s*\{[^}]*margin-top:\s*16px;/,
    ".mail-list 又回到了 16px 上边距");
});

t("S3 消息页漂流瓶记录 .bottle-records 上边距清零（轮 363：父容器已有 6px）", () => {
  assert.match(records, /\.bottle-records\s*\{[^}]*margin-top:\s*0;[^}]*padding-top:\s*0;/,
    ".bottle-records 应为 margin-top:0; padding-top:0;（父容器 .dm-list 已有 6px gap）");
  assert.doesNotMatch(records, /\.bottle-records\s*\{[^}]*margin-top:\s*(10|20)px;/,
    ".bottle-records 又叠回 10/20px 上边距");
});

t("S4 漂流瓶说明文案保持短句（中文 sub ≤ 20 字）", () => {
  const all = [...i18n.matchAll(/bottle:\s*\{[\s\S]*?\n\s*sub:\s*"([^"]+)"/g)].map((x) => x[1]);
  const zh = all.find((s) => /[\u4e00-\u9fa5]/.test(s));
  assert.ok(zh, "找不到中文 bottle.sub");
  assert.ok(zh.length <= 20, `bottle.sub 又变长了（${zh.length} 字）：${zh}`);
});

t("S5 漂流瓶记录提示保持短句（中文 recordsHint ≤ 30 字）", () => {
  const all = [...i18n.matchAll(/recordsHint:\s*"([^"]+)"/g)].map((x) => x[1]);
  const zh = all.find((s) => /[\u4e00-\u9fa5]/.test(s));
  assert.ok(zh, "找不到中文 bottle.recordsHint");
  assert.ok(zh.length <= 30, `recordsHint 又变长了（${zh.length} 字）：${zh}`);
});

t("S6 漂流瓶规则保持短句（中文 rules ≤ 70 字）", () => {
  /* 这句是瓶子页底部的一行说明，太长会挤成三行。文案后来改写并补上了「7 天内不会再发给你」
     这条真实规则（原句只有「每天可投 / 可捞 / 可回」），字数上限随之从 50 放到 70 ——
     仍能拦住「往这儿堆规则」的退化，但不再和产品文案打架。 */
  const all = [...i18n.matchAll(/rules:\s*"([^"]+)"/g)].map((x) => x[1]);
  const zh = all.find((s) => /[\u4e00-\u9fa5]/.test(s) && /每(天| 24 小时)/.test(s));
  assert.ok(zh, "找不到中文 bottle.rules");
  assert.ok(zh.length <= 70, `rules 又变长了（${zh.length} 字）：${zh}`);
});

console.log(out.join("\n"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
