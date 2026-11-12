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
t("C1 聊天面板绑定了 dm-thread--in / --out，且由 threadIn、threadOut 驱动", () => {
  assert(/class="card dm-thread" :class="\{ 'dm-thread--in': threadIn, 'dm-thread--out': threadOut \}"/.test(msgView),
    "模板里没有把 dm-thread--in / --out 绑到 threadIn / threadOut");
  /* 轮 519：退出必须和进入对称。只加 --in 不加 --out，退出就是一次硬切
     （真机逐帧：fixed 393×744 → static 357×728，中间零过渡 = 用户说的「缩放」）。 */
  assert(/v-show="!isMobileNav \|\| \(!!activeId && paneReady\) \|\| threadOut"/.test(msgView),
    "退出动画期间 dm-thread 被 v-show 藏掉了（动画根本播不出来）");
  assert(/dm-page--chat': isMobileNav && \(\(!!activeId && paneReady\) \|\| threadOut\)/.test(msgView),
    ".dm-page--chat 没跟着 threadOut 延后摘（卡片会先跳到列表位置再播动画）");
});

t("C2 只在手机形态加动画（桌面双栏是同时可见，没有「进入」动作）", () => {
  const i = msgView.indexOf("const threadIn = ref(false)");
  assert(i > 0, "没有 threadIn 定义");
  /* 轮 519：原本是 `slice(i, i + 2600)` 的固定字符窗口。退场那一段加了说明注释之后，
   * 这个窗口把 `if (!isMobileNav.value) return;` 挤出去了，假红。改成切到语义边界
   * （threadIn 的收尾清理那一行）为止，注释再长也不会误判。 */
  const end = msgView.indexOf("onBeforeUnmount(() => clearTimeout(threadInTimer))");
  assert(end > i, "找不到 threadIn 的收尾清理，切片边界失效");
  const seg = msgView.slice(i, end);
  assert(/if \(!isMobileNav\.value\) return;/.test(seg), "threadIn 没有 isMobileNav 早退 —— 桌面双栏也会跑动画");
});

t("C3 动画类必须定时摘掉，并在卸载时清定时器", () => {
  const i = msgView.indexOf("let threadInTimer = 0");
  assert(i > 0, "没有 threadInTimer");
  /* 轮 519：原来是 `slice(i, i + 3000)` 的固定字符窗口 —— 退场那段加说明之后
   * `setTimeout(... threadIn.value = false ..., 320)` 被挤出窗口，假红。
   * 改成切到 threadIn 的收尾清理那一行为止（语义边界，注释再长也不会漂）。
   * 注意顺序：threadIn 的 watch 排在 threadOut 定义**之后**，所以不能用 threadOut 当边界。 */
  const end = msgView.indexOf("onBeforeUnmount(() => clearTimeout(threadInTimer))");
  assert(end > i, "找不到 threadIn 的收尾清理，切片边界失效");
  const seg = msgView.slice(i, end);
  assert(/setTimeout\(\(\)\s*=>\s*\{\s*threadIn\.value = false; \},\s*\d+\)/.test(seg),
    "没有把 threadIn 摘掉的定时器 —— transform 会常驻并劫持 fixed 表情面板");
  /* 轮 519：退场收尾从「固定定时器」改成「听 animationend + 定时器兜底」——
   * 固定 180ms 会在动画只播了 67ms 时就切布局（真机 t8155 → t8222 实测）。 */
  assert(/const finishThreadOut = \(\) => \{[\s\S]{0,200}threadOut\.value = false;/.test(msgView),
    "没有 threadOut 的收尾函数");
  assert(/addEventListener\("animationend", onThreadOutEnd/.test(msgView),
    "退场没有听 animationend（固定定时器会在动画播完前就切布局）");
  assert(/setTimeout\(finishThreadOut, THREAD_OUT_FALLBACK_MS\)/.test(msgView),
    "没有兜底定时器（reduced-motion 或无动画时收不了尾）");
  assert(/onBeforeUnmount\(\(\) => clearTimeout\(threadInTimer\)\)/.test(msgView),
    "组件卸载时没清 threadInTimer（切页后定时器仍会写已卸载组件的 ref）");
  assert(/onBeforeUnmount\(\(\) => clearTimeout\(threadOutTimer\)\)/.test(msgView),
    "组件卸载时没清 threadOutTimer");
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

t("C7 退场动画期间不许清会话态（否则淡的是空壳，等于没动画）", () => {
  /* 轮 519 真机事故：路由一回到列表就 resetConv()，activeId/msgs/meta 当场清空，
   * 模板 `v-if="activeId && paneReady"` 把聊天体卸载 → dm-thread--out 跑在一张空卡片上。
   * screencast 逐帧：点返回后 0~423ms 画面完全静止（帧哈希一致），+480ms 直接跳列表，
   * 中间一帧淡出都没有。所以清态必须发生在 finishThreadOut 里。 */
  assert(/function beginThreadOut\(\)/.test(msgView), "没有 beginThreadOut（退场唯一入口）");
  assert(/const finishThreadOut = \(\) => \{[\s\S]{0,400}?resetConv\(\)/.test(msgView),
    "finishThreadOut 里没有 resetConv() —— 退场结束后没人清会话态");
  /* 路由回列表那一支必须是 beginThreadOut，不能直连 resetConv */
  const routeBranch = msgView.slice(msgView.indexOf("const id = String(v || \"\")"));
  const exitPart = routeBranch.slice(0, routeBranch.indexOf("});"));
  assert(/beginThreadOut\(\)/.test(exitPart),
    "路由回到列表时没走 beginThreadOut（直接 resetConv 会在动画开始前卸掉内容）");
  assert(!/^\s*resetConv\(\);/m.test(exitPart),
    "路由回到列表那一支还在直接 resetConv()");
  /* 清态时要点上锁，否则 watch(activeId) 会把「自己清的」当成「用户又退了一次」 */
  assert(/threadExitLock = true;/.test(msgView) && /if \(threadExitLock\) return;/.test(msgView),
    "缺 threadExitLock —— finishThreadOut 清态会再触发一轮退场，永远退不出去");
});

console.log(out.join("\n"));
console.log(`\npage-transition-test: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
