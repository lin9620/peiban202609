/* 轮 492 · 发帖页（/compose）顶部安全区锁（Node 直跑，只读源码）
 *   node tools/compose-safearea-test.mjs
 *
 * 用户实报图（App 真机）：发帖页整条顶栏被状态栏压住 —— 系统的时间 / 网速 / 信号图标
 * 直接落在「发暖心帖」标题和右上角「发布」键上，两者挤在一起看不清。
 *
 * 根因：/compose 被 App.vue 归到 shell--chat 整屏形态，而
 * `.shell--mobile-nav.shell--chat main { padding-top: 0 }` 把外层让位的 padding 归零了
 * （聊天页是 .dm-thread 自己让，见 style.css）；这页只在容器上垫了 12px，没吃安全区。
 * 另一层坑：App 壳里 env(safe-area-inset-*) 常为 0，真实值由 MainActivity 推成 --sat/--sab，
 * 所以「只写 env()」等于没写。
 *
 * 这里锁的是**行为**，不是某一段字面量：
 *   · 顶栏自己吃 --sat（而不是垫在 .compose-page 上）—— 因为页面被键盘顶起后会滚，
 *     sticky 吸顶时容器上的 padding 已经滚出视口，只有元素自身的 padding 还管用。
 *     实测（393×852，--sat:28）：垫在容器上时吸顶后 back 顶到 0；垫在顶栏上仍是 41。
 *   · 正因为安全区在顶栏，容器**不能**再垫一层（否则 28+28 双倍留白）。
 *   · 负外边距必须与容器水平内边距同值（14 / 窄屏 12），否则内容与卡片错位、或背景露缝。
 *   · 底部同理认 --sab（--sat 的兄弟），不允许退回裸 env()。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const src = read("src/views/ComposeView.vue");
const css = read("src/style.css");

let pass = 0, fail = 0; const out = [];
function t(name, fn) {
  try { fn(); pass++; out.push("ok   " + name); }
  catch (e) { fail++; out.push("FAIL " + name + " :: " + e.message); }
}

/* 只取 <style> 之后的内容：注释里出现同样的写法（说明文字）不该被当成代码判红 */
const styleAt = src.indexOf("<style");
const style = styleAt > 0 ? src.slice(styleAt) : "";

/* 取一条选择器规则的声明块（容错：只取第一个 { ... }） */
function rule(sel) {
  const i = style.indexOf(sel + " {");
  if (i < 0) return "";
  const j = style.indexOf("}", i);
  return j > i ? style.slice(i, j + 1) : "";
}
const pageRule = rule(".compose-page");
const headRule = rule(".compose-head");
/* 窄屏那条是嵌套在 @media 里的，单独取 */
const mediaAt = style.indexOf("@media (max-width: 560px)");
const mediaBlock = mediaAt > 0 ? style.slice(mediaAt, style.indexOf("</style>", mediaAt) > 0 ? style.indexOf("</style>", mediaAt) : undefined) : "";
const pageNarrow = mediaBlock.slice(mediaBlock.indexOf(".compose-page {"), mediaBlock.indexOf(".compose-page {") + 160);
const headNarrowAt = mediaBlock.indexOf(".compose-head {");
const headNarrow = headNarrowAt >= 0 ? mediaBlock.slice(headNarrowAt, mediaBlock.indexOf("}", headNarrowAt) + 1) : "";

t("C1 找得到 .compose-page / .compose-head 两条规则（含窄屏变体）", () => {
  assert.ok(pageRule, "没有 .compose-page 规则");
  assert.ok(headRule, "没有 .compose-head 规则");
  assert.ok(pageNarrow.includes(".compose-page"), "窄屏没有 .compose-page 覆盖");
  assert.ok(headNarrow.includes(".compose-head"), "窄屏没有 .compose-head 覆盖");
});

t("C2 顶栏自己吃顶部安全区（--sat 优先，env() 只作兜底）", () => {
  assert.match(headRule, /padding:\s*calc\([^)]*var\(--sat,\s*env\(safe-area-inset-top,\s*0px\)\)[^)]*\)/,
    "顶栏 padding 里没有 var(--sat, env(safe-area-inset-top, 0px))");
  assert.match(headNarrow, /var\(--sat,\s*env\(safe-area-inset-top,\s*0px\)\)/,
    "窄屏顶栏把顶部安全区丢了（≤560px 是手机主力宽度，恰恰最需要）");
});

t("C3 容器不再垫一层顶部安全区（否则和顶栏叠加成双倍留白）", () => {
  const pad = (pageRule.match(/padding:\s*([^;]+);/) || [])[1] || "";
  assert.ok(pad, ".compose-page 没有 padding 简写");
  assert.match(pad.trim(), /^0\s/, "容器 padding 首值不是 0：顶部安全区应只由顶栏承担（容器垫的会随滚动滚出视口）");
  assert.doesNotMatch(pad, /safe-area-inset-top/, "容器又在垫顶部安全区了");
  const padN = (pageNarrow.match(/padding:\s*([^;]+);/) || [])[1] || "";
  assert.match(padN.trim(), /^0\s/, "窄屏容器 padding 首值不是 0");
});

t("C4 顶栏 sticky 吸顶（top:0）——再确认这条 padding 吸顶后仍然有效", () => {
  assert.match(headRule, /position:\s*sticky/, "顶栏不是 sticky（长文案 / 键盘顶起时会整条滚走）");
  assert.match(headRule, /top:\s*0\s*;/, "顶栏 sticky 的 top 不是 0");
});

t("C5 负外边距 = 容器水平内边距（14 / 窄屏 12），内容与卡片左对齐", () => {
  const mHead = headRule.match(/margin:\s*0\s+(-?\d+)px\s*;/);
  assert.ok(mHead, "顶栏没有 margin: 0 -Npx 写法");
  const mPage = pageRule.match(/padding:\s*0\s+(\d+)px\s/);
  assert.ok(mPage, "读不到容器的水平内边距");
  assert.equal(Math.abs(Number(mHead[1])), Number(mPage[1]),
    `顶栏负外边距 ${mHead[1]} 与容器水平内边距 ${mPage[1]} 不一致（会把内容拉偏 / 背景露缝）`);

  const mHeadN = headNarrow.match(/margin:\s*0\s+(-?\d+)px\s*;/);
  const mPageN = pageNarrow.match(/padding:\s*0\s+(\d+)px\s/);
  assert.ok(mHeadN && mPageN, "窄屏缺 margin / padding 之一");
  assert.equal(Math.abs(Number(mHeadN[1])), Number(mPageN[1]),
    `窄屏顶栏负外边距 ${mHeadN[1]} 与容器水平内边距 ${mPageN[1]} 不一致`);

  /* 顶栏内边距的水平值也得等于同一数，否则内容左右各差一截 */
  const padHead = headRule.match(/padding:\s*calc\([^;]*\)\s+(\d+)px\s+10px/);
  assert.ok(padHead, "读不到顶栏的水平内边距");
  assert.equal(Number(padHead[1]), Number(mPage[1]), "顶栏水平内边距与容器不一致");
});

t("C6 底部认 --sab（App 壳里 env() 常为 0），容器与窄屏都要", () => {
  assert.match(pageRule, /calc\(\s*16px\s*\+\s*var\(--sab,\s*env\(safe-area-inset-bottom,\s*0px\)\)\s*\)/,
    "容器底部没有 calc(16px + var(--sab, env(safe-area-inset-bottom, 0px)))");
  assert.match(pageNarrow, /var\(--sab,\s*env\(safe-area-inset-bottom,\s*0px\)\)/,
    "窄屏底部把 --sab 丢了");
});

t("C7 本文件不允许退回裸 env()（--sat/--sab 才是 App 里真实生效的口径）", () => {
  const tops = style.match(/env\(safe-area-inset-top/g) || [];
  const sats = style.match(/var\(--sat,\s*env\(safe-area-inset-top/g) || [];
  assert.equal(tops.length, sats.length, `有 ${tops.length - sats.length} 处 env(safe-area-inset-top) 没走 var(--sat, …)`);
  const bots = style.match(/env\(safe-area-inset-bottom/g) || [];
  const sabs = style.match(/var\(--sab,\s*env\(safe-area-inset-bottom/g) || [];
  assert.equal(bots.length, sabs.length, `有 ${bots.length - sabs.length} 处 env(safe-area-inset-bottom) 没走 var(--sab, …)`);
});

t("C8 整屏形态里两页都得自己让状态栏（新加整屏页不能忘这条）", () => {
  /* 整屏页的外层 main padding-top 是 0，安全区必须各页自己吃 */
  assert.match(css, /\.shell--mobile-nav\.shell--chat main\s*\{\s*padding-top:\s*0;/, 
    "整屏形态不再把 main 的 padding-top 归零（那这条锁要重写）");
  assert.match(css, /\.shell--mobile-nav\.shell--chat \.dm-thread\s*\{[\s\S]{0,400}?var\(--sat,/,
    "聊天页 .dm-thread 不再自己让状态栏");
  assert.match(headRule, /var\(--sat,/, "发帖页顶栏没让状态栏");
});

t("C9 不该出现的替代做法：靠 transform / 负 top 把顶栏挪下去", () => {
  assert.doesNotMatch(headRule, /translateY\(-?.*safe-area/, "顶栏用了 translate 挪位（sticky 下会抖动）");
  assert.doesNotMatch(headRule, /top:\s*-\d/, "顶栏用了负 top");
});

console.log(out.join("\n"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
