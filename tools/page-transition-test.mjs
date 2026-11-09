/* 页面过渡动画护栏（Node 直跑：node tools/page-transition-test.mjs）
 * ------------------------------------------------------------
 * 轮 481。用户原话：「进入聊天框搞点过渡动画，现在这啥都没有，还有其他的页面
 * 点击也搞点过渡动画好吗」。
 *
 * 这里钉的不是「动画好不好看」（那个得人眼看），而是**几条一违反就出事**的硬约束：
 *
 *  A. 路由过渡只能用 opacity。
 *     transform / filter / perspective / scale 都会创建包含块，把后代
 *     position:fixed 的定位基准从视口改成这个祖先。全站导航栏、底栏、聊天输入条
 *     都是 fixed —— style.css:2884 记过同款事故（fixed 被「劫持」进 transform 层）。
 *
 *  B. 页签互切必须保持零动画。
 *     轮 221 用户录屏对标知乎：「页签切换必须即时互换，第一帧就在正确位置」。
 *     加淡入 = 先白一下再出现，是被打回过的方案。
 *
 *  C. 聊天面板的 transform 不许常驻。
 *     面板里有 position:fixed 的表情面板，动画的 fill-mode 如果是 both/forwards，
 *     transform:translateX(0) 也是「非 none」，照样创建包含块 —— 表情面板会贴到
 *     聊天框底部而不是屏幕底部。所以动画类必须定时摘掉、keyframes 末帧不带 transform。
 *
 * 纯 Node，无 DOM、无网络。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

let pass = 0;
let fail = 0;
const out = [];
function t(name, fn) {
  try {
    fn();
    pass++;
    out.push("ok   " + name);
  } catch (e) {
    fail++;
    out.push("FAIL " + name + " :: " + e.message);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const app = read("src/App.vue");
const css = read("src/style.css");
const msgView = read("src/views/MessagesView.vue");

/* 取某个选择器后面的规则体（第一个 { }） */
function ruleBody(source, selector) {
  const i = source.indexOf(selector);
  if (i < 0) return "";
  const a = source.indexOf("{", i + selector.length);
  const b = source.indexOf("}", a);
  return a < 0 || b < 0 ? "" : source.slice(a + 1, b);
}
/* 取 @keyframes 名 的整段 */
function keyframesBody(source, name) {
  const i = source.indexOf("@keyframes " + name);
  if (i < 0) return "";
  const a = source.indexOf("{", i);
  let d = 1;
  let j = a + 1;
  while (j < source.length && d > 0) {
    if (source[j] === "{") d++;
    else if (source[j] === "}") d--;
    j++;
  }
  return source.slice(a, j);
}

/* ───────── A. 路由过渡：存在、且只用 opacity ───────── */
t("A1 路由出口包了 transition（否则永远是硬切）", () => {
  assert(/<transition[\s\S]{0,200}<keep-alive/.test(app), "router-view 里没有 <transition> 包住 <keep-alive>");
});

t("A2 transition 的 name 走 pageFx，且空名时用 :css 彻底关掉过渡", () => {
  assert(/:name="pageFx"/.test(app), "transition 没有 :name=\"pageFx\"");
  assert(/:css="pageFx !== ''"/.test(app), "没有 :css=\"pageFx !== ''\" —— 空名时 Vue 仍会走过渡流程，页签互切会出现一帧空等");
});

t("A3 四个页签路径都在 TAB_PATHS 里", () => {
  for (const p of ['"/"', '"/community"', '"/messages"', '"/profile"']) {
    assert(app.includes(p), `TAB_PATHS 少了 ${p}`);
  }
  assert(/TAB_PATHS\s*=\s*new Set\(\[/.test(app), "没有 TAB_PATHS 集合");
});

t("A4 页签互切 → pageFx 为空（轮 221 的即时互换不许被这次改掉）", () => {
  assert(/pageFx\.value\s*=\s*a && b && a !== b \? "" : "wp-page"/.test(app),
    "判据不是「两端都是页签且不同 → 空」——页签互切会被加动画（轮 221 明确否掉）");
});

t("A5 页面淡入的 keyframes 里不许出现 transform / filter / scale / perspective", () => {
  const kf = keyframesBody(css, "wp-page-in");
  assert(kf.length > 0, "style.css 里没有 @keyframes wp-page-in");
  assert(!/transform|filter|scale|perspective|zoom/.test(kf),
    "wp-page-in 里用了会产生包含块的属性 —— 后代的 position:fixed 会被劫持（导航栏/底栏/输入条整片错位）");
  assert(/opacity/.test(kf), "wp-page-in 连 opacity 都没有");
});

t("A6 .wp-page-enter-active 用的是纯 opacity 动画，且不定义 leave", () => {
  const body = ruleBody(css, ".wp-page-enter-active");
  assert(body.length > 0, "没有 .wp-page-enter-active 规则");
  assert(/wp-page-in/.test(body), "enter-active 没挂 wp-page-in 动画");
  assert(!/\.wp-page-leave-active/.test(css),
    "定义了 leave-active —— 旧页会停留，等于回到轮 221 否掉的「先显示再切换」；旧页应当立即移除");
});

t("A7 页面过渡有 prefers-reduced-motion 降级", () => {
  assert(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.wp-page-enter-active\s*\{\s*animation:\s*none/.test(css),
    "缺少 reduced-motion 降级");
});

/* ───────── C. 聊天面板过渡 ───────── */
t("C1 聊天面板绑定了 dm-thread--in，且由 threadIn 驱动", () => {
  assert(/class="card dm-thread" :class="\{ 'dm-thread--in': threadIn \}"/.test(msgView),
    "模板里没有把 dm-thread--in 绑到 threadIn");
});

t("C2 只在手机形态加动画（桌面双栏是同时可见，没有「进入」动作）", () => {
  const i = msgView.indexOf("const threadIn = ref(false)");
  assert(i > 0, "没有 threadIn 定义");
  const seg = msgView.slice(i, i + 900);
  assert(/if \(!isMobileNav\.value\) return;/.test(seg), "threadIn 没有 isMobileNav 早退 —— 桌面双栏也会跑动画");
});

t("C3 动画类必须定时摘掉，并在卸载时清定时器", () => {
  const i = msgView.indexOf("let threadInTimer = 0");
  assert(i > 0, "没有 threadInTimer");
  const seg = msgView.slice(i, i + 500);
  assert(/setTimeout\(\(\)\s*=>\s*\{\s*threadIn\.value = false; \},\s*\d+\)/.test(seg),
    "没有把 threadIn 摘掉的定时器 —— transform 会常驻并劫持 fixed 表情面板");
  assert(/onBeforeUnmount\(\(\) => clearTimeout\(threadInTimer\)\)/.test(msgView),
    "组件卸载时没清 threadInTimer（切页后定时器仍会写已卸载组件的 ref）");
});

t("C4 .dm-thread--in 的动画不许带 fill-mode both/forwards", () => {
  const body = ruleBody(css, ".dm-thread--in");
  assert(body.length > 0, "没有 .dm-thread--in 规则");
  assert(!/forwards|both/.test(body),
    "fill-mode 用了 forwards/both —— 动画结束后 transform:translateX(0) 仍是「非 none」，照旧创建包含块，表情面板会贴到聊天框底部");
});

t("C5 dm-thread-in 末帧不带 transform（只有 from 里可以出现）", () => {
  const kf = keyframesBody(css, "dm-thread-in");
  assert(kf.length > 0, "没有 @keyframes dm-thread-in");
  const toBlock = kf.slice(kf.indexOf("to {"), kf.length);
  assert(toBlock.length > 0, "keyframes 没有 to 帧");
  const toBody = toBlock.slice(0, toBlock.indexOf("}"));
  assert(!/transform/.test(toBody), "to 帧里写了 transform —— 动画结束会有残留");
});

t("C6 聊天面板过渡也有 reduced-motion 降级", () => {
  assert(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.dm-thread--in\s*\{\s*animation:\s*none/.test(css),
    "缺少 reduced-motion 降级");
});

console.log(out.join("\n"));
console.log(`\npage-transition-test: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
