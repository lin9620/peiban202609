/* 轮 322 · 键盘让位：把「输入法压住的高度」写成 CSS 变量 --kb-h，
 * 让「整屏聊天页高度 / 吸底输入条 bottom」用等时长的过渡跟着输入法一起上移。
 *
 * 两条来源（轮 462 拆成 App 壳 / 网页端两支，写的是同一个变量）：
 *   App 壳：Keyboard 插件（window 不缩，插件报输入法真实高度，见下面 initNative）
 *   网页端：visualViewport（布局视口不缩，只有可视视口缩，见 initWeb）
 *
 * 为什么 App 壳非这么做不可（真机实测，见 jiaojie 轮 322）：键盘弹起的瞬间，如果页面靠系统去缩，
 *   布局视口会一步从 843 跳到 539，而输入法还要 ~200ms 才从屏底滑上来 —— 中间那条空区
 *   在布局视口之外，网页层画不到（红块实验证实），所以只能把「让位」搬到自己手里：
 *     · AndroidManifest 已经是 adjustNothing（窗口不缩）；
 *     · SystemBars 插件已改成 insetsHandling="disable"，MainActivity 只给系统栏让位、
 *       不把输入法高度算进 padding（否则 WebView 布局视口又被压）。
 *
 * 时机（插件 8.0.6 Android 侧 Keyboard.java onStart）：keyboardWillShow 在输入法动画
 *   **开始**时触发，且带的是**最终高度**（imeHeight / density ≈ CSS px）→ CSS 过渡与
 *   输入法同起点同终点，全程不留缝。
 *
 * 为什么网页端也要自己让（轮 462 用户两张截图）：index.html 的视口策略是
 *   interactive-widget=resizes-visual —— 键盘弹起时**布局视口不动**，100dvh 不变，
 *   position:fixed 的底条仍钉在布局视口底部（= 键盘底下）；iOS Safari 还会把整个可视
 *   视口上推，聊天页那层固定高度因此被顶上去、底下露一条空白。算式与各浏览器分支见
 *   keyboardMath.js 的 kbWebInset。
 *
 * 兜底原则：任何异常一律往「--kb-h 归零」走。宁可让输入栏贴底被键盘盖住一瞬，
 *   也绝不能留一条永久空白（那正是用户报的问题）。
 */
import { Capacitor } from "@capacitor/core";
import { Keyboard } from "@capacitor/keyboard";
import { kbPageInset, kbWebInset, kbShrinkInset } from "./keyboardMath.js";
import { kbInsetValue } from "./chatHeight.js";

const VAR = "--kb-h";
const SYS_BOTTOM_VAR = "--sys-bottom";
/* 网页端打这个类，style.css 里三条 .kb-web 规则才生效（与 cap-app 三条一一对应）。
   默认 --kb-h: 0px ⇒ 老内核 / 读不到可视视口时表现与改之前完全一致。 */
const WEB_CLASS = "kb-web";

/* 轮 324（用户：「太宽了」）—— 键盘高度要扣掉「WebView 底部让给系统栏的那一条」。
 *   Keyboard 插件的 keyboardHeight 是从**窗口底**量的（Keyboard.java：
 *     int imeHeight = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom;
 *     Math.round(imeHeight / density)），不是从 WebView 底量的。
 *   轮 322 的旧布局里 MainActivity 给 decorView 加了 padding-bottom = 导航栏高度 →
 *   WebView 的底比窗口底高出一条导航栏，所以要扣；不扣输入栏会悬在键盘上沿上面
 *   ≈42 CSS px（真机实测，用户红框那条「太宽」）。
 *   轮 347 改成真·全屏（edge-to-edge）后 WebView 底 = 窗口底，MainActivity 把
 *   --sys-bottom 固定写成 0 → 这里的减法自然变成 no-op；保留它是为了老 APK
 *   （仍带导航栏 padding）升级网页层时不至于把输入栏顶到键盘上沿上方。
 *   读不到就按 0 处理（老 APK / 网页端），行为退回轮 322 的样子，不会更糟。
 *   算式在 keyboardMath.js（纯函数，Node 里直接测过各机型组合，见 tools/kb-math-test.mjs）。 */
function sysBottom() {
  try {
    const n = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(SYS_BOTTOM_VAR));
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch (e) { return 0; }
}

function writeVar(px, info, panelPx) {
  try {
    document.documentElement.style.setProperty(VAR, px + "px");
    /* 轮 482：「上一次真实键盘高度」单独记一份，键盘收起（px=0）时**不清零**。
     * 用途：表情面板高度（--kb-panel-h）要跟键盘一致 —— 可面板弹出时键盘必然已经收起，
     * 那时 --kb-h 已经是 0，只能靠这份残留值还原。见 style.css 的 :root。
     * 轮 496：键盘本体高度与「页面让位高度」在网页端不是同一个量（缩布局视口型内核
     * 不需要我们让位，--kb-h 恒为 0，但键盘实际压住了屏底一大截）——面板要跟的是
     * **键盘本体**，所以单独传 panelPx 进来，别再拿 --kb-h 顶替。 */
    const panel = Number(panelPx);
    if (panel > 0) document.documentElement.style.setProperty("--kb-last", Math.round(panel) + "px");
    else if (px > 0) document.documentElement.style.setProperty("--kb-last", px + "px");
  } catch (e) { /* 极端环境忽略：样式变量设不上也不能抛错 */ }
  /* 现场诊断（只写全局、不改行为）：别的机型若报「还是有缝/被压住」，一句
     JSON.stringify(window.__kbInfo) 就能看清是哪个输入没对，不用连 logcat。 */
  try { window.__kbInfo = info; } catch (e) { /* 忽略 */ }
}

function setInset(px) {
  const raw = Number(px) || 0;
  const sys = raw > 0 ? sysBottom() : 0;
  const vh = (typeof window !== "undefined" && window.innerHeight) || 0;
  const h = kbPageInset(raw, sys, vh);
  /* App 壳里「让位高度」与「键盘本体高度」是同一个量（插件报的就是输入法真实高度），
     第三参显式传同一个值，别让两条口径在将来分叉。 */
  writeVar(h, { src: "native", raw, sysBottom: sys, kbH: h, innerHeight: vh, at: Date.now() }, h);
  if (h <= 0) return;
  /* 长页面里的输入框可能被键盘盖住（窗口不再缩 ⇒ 系统不会替我们滚）：
     等让位生效后再把焦点元素滚进可视区。 */
  requestAnimationFrame(() => {
    const el = document.activeElement;
    if (!el || el === document.body || typeof el.scrollIntoView !== "function") return;
    try { el.scrollIntoView({ block: "center" }); } catch (e) { /* 忽略 */ }
  });
}

/* ═══════════════════════════════════════════════════════════════════
 * 网页端（浏览器 / 小米浏览器 / iOS Safari）：用 visualViewport 量键盘
 * ═══════════════════════════════════════════════════════════════════ */
const EDITABLE_TAGS = { INPUT: 1, TEXTAREA: 1, SELECT: 1 };

/* 只在「真的在输入」时才让位。不这么判会有两个误伤：
 *   ① iOS 的地址栏伸缩会改 innerHeight，滚动时会被当成键盘，页面自己抽一下；
 *   ② 桌面浏览器把窗口缩小时同理。
 * 注意必须钻进 shadow DOM：会话输入框在 vue-advanced-chat 的自定义元素里，
 *   document.activeElement 只会停在宿主标签上（tagName = VUE-ADVANCED-CHAT），
 *   直接判 tagName 会永远「没在输入」—— 这条在真机上表现为「聊天页一点动静都没有」。 */
function activeInput() {
  let el = typeof document !== "undefined" ? document.activeElement : null;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

function editableFocused() {
  const el = activeInput();
  if (!el) return false;
  if (el.isContentEditable) return true;
  return !!EDITABLE_TAGS[el.tagName || ""];
}

function readWebKb() {
  const vv = typeof window !== "undefined" && window.visualViewport;
  if (!vv) return 0;                              /* 老内核：不动作，退回浏览器自己平移 */
  if (vv.scale > 1.05) return 0;                  /* 双指放大也会缩可视视口，但这不是键盘 */
  return kbWebInset(window.innerHeight, vv.height, vv.offsetTop);
}

let lastWebKb = -1;
let lastPanelKb = -1;
/* 轮 496：本会话内见过的最大的「可视视口让位高度」。
 * 只在 >0 时更新 —— 它同时是「这台设备/这个浏览器走的是 visualViewport 让位路线」的标记，
 * 表情面板 → 键盘交接要不要先钉住让位，就看它（见 webSwapNeeded）。 */
let webKbSeen = 0;
/* 键盘弹起前的 innerHeight 基线：缩布局视口型内核靠它反推键盘本体高度。 */
let restH = 0;

function applyWeb() {
  const raw = readWebKb();
  /* 焦点判据只能当「加速」，不能当「门槛」—— 轮 463 真机反馈：iOS Safari 上输入法已经
     起来了，--kb-h 还是 0。activeElement 在深层层级（vue-advanced-chat / 自定义元素 /
     部分国产内核的 IME 代理）里不一定停在我们认得的 input 上，一条判死 = 整段失效。
     所以只要可视视口比布局视口矮出 100px 以上，就直接认定是键盘：
       · 地址栏伸缩 → innerHeight 与 vv.height 同增同减，差值为 0，不会误触；
       · 双指放大 → readWebKb 已在 scale > 1.05 时返回 0；
       · 页面被 iOS 上推 → offsetTop 已经计进算式，差值同步变小。 */
  /* 轮 468：焦点那条捷径也必须过「工具栏量级」闸门（80px）。小米浏览器无键盘时
     vv 比 inner 矮 31px（浏览器工具栏），一聚焦输入框，这 31px 就被当成键盘 → 评论条 /
     回复栏整体抬 31px，下方平白多一条空白。而真键盘最低也 ≥ 200px，80 这道闸门
     两边都不误伤。判据抽到 chatHeight.js，与聊天容器高度共用同一份口径。 */
  const focused = editableFocused();
  const h = kbInsetValue(raw, focused);
  const inner = (typeof window !== "undefined" && window.innerHeight) || 0;

  /* 轮 496：表情面板要跟的是「键盘本体占多高」，它跟「页面需要让多高」不是同一个量。
   * 缩可视视口型内核：让位就是键盘高，两者相等；
   * 缩布局视口型内核：让位恒为 0（浏览器自己缩），键盘高只能从 innerHeight 缩掉的量反推。
   * 不补这一段，--kb-last 在后者上永远拿不到值，面板就退回 46vh/320px 的死值 ——
   * 用户看到的「表情跟文字输入高度不一致」。 */
  let panelH = h;
  if (!(panelH > 0)) panelH = kbShrinkInset(restH, inner);
  if (h > 0) webKbSeen = Math.max(webKbSeen, h);
  /* 基线只在「确实没有键盘」时刷新：不然键盘弹起后的 innerHeight 会被记成基线，
   * 下一次就再也算不出差值。 */
  if (!(panelH > 0) && !focused && inner > 0) restH = inner;

  /* iOS 为了让光标可见会把**整个文档**往上滚（window.scrollY > 0）。整屏聊天页本来
     就没有文档级滚动，这一滚会在页尾露出一条「视口之外」的空白（用户截图①那块）。
     只在整屏聊天壳里归零 —— 别的页面（首页搜索框等）本来就靠文档滚动把输入框带进可视区，
     在那里强行归零会把光标送回键盘底下。每帧都判：Safari 会在键盘动画期间反复滚。 */
  if (h > 0 && document.querySelector(".shell--chat, .dm-page--chat")) {
    try {
      const se = document.scrollingElement || document.documentElement;
      if (se && se.scrollTop > 0) se.scrollTop = 0;
    } catch (e) { /* 忽略 */ }
  }
  if (h === lastWebKb && panelH === lastPanelKb) return;   /* 逐帧采样时别反复写样式（会触发重排） */
  lastWebKb = h;
  lastPanelKb = panelH;
  const vv = window.visualViewport || {};
  writeVar(h, {
    src: "web", kbH: h, panelH, innerHeight: inner, restH,
    vvHeight: vv.height, vvTop: vv.offsetTop, scale: vv.scale, at: Date.now(),
  }, panelH);
}

/* 轮 496：表情面板「收起 → 键盘接上」这段空档，底条要不要先钉在面板高度上。
 * 只有走 visualViewport 让位路线的设备会掉（--kb-h 归零 ⇒ fixed 底条落回屏底，
 * 键盘几百毫秒后才把它顶回来）；缩布局视口型内核本来就跟着视口走，钉住反而悬空。
 * 判据 = 本会话见过 --kb-h > 0。 */
export function webSwapNeeded() {
  return !Capacitor.isNativePlatform() && webKbSeen > 0;
}

let sampleRaf = 0;
/* 输入法弹起后连采 ~0.9s：有些国产内核（实测小米浏览器）在键盘起来时
 * **不派发 visualViewport resize**，只靠事件会整段漏掉；逐帧读两个只读属性很便宜
 * （都命中缓存值，不触发强制同步布局）。 */
function sampleFrames(ms) {
  if (typeof requestAnimationFrame !== "function") return;
  const now = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
  const until = now() + ms;
  cancelAnimationFrame(sampleRaf);
  const tick = () => {
    applyWeb();
    if (now() < until) sampleRaf = requestAnimationFrame(tick);
  };
  sampleRaf = requestAnimationFrame(tick);
}

function initWeb() {
  try { document.documentElement.classList.add(WEB_CLASS); } catch (e) { /* 忽略 */ }
  /* 轮 496：键盘前基线。缩布局视口型内核（innerHeight 直接变小的那批）就是靠
     「基线 − 当前 innerHeight」反推键盘本体高度的，没有基线就永远是 0。 */
  restH = (typeof window !== "undefined" && window.innerHeight) || 0;
  const vv = window.visualViewport;
  if (vv && typeof vv.addEventListener === "function") {
    vv.addEventListener("resize", applyWeb);
    vv.addEventListener("scroll", applyWeb);       /* iOS 上推可视视口只派发 scroll */
  }
  window.addEventListener("resize", applyWeb);      /* 兼容「缩布局视口」型内核 / 旋屏 */
  window.addEventListener("orientationchange", () => sampleFrames(600));
  document.addEventListener("focusin", () => sampleFrames(900), true);
  document.addEventListener("focusout", () => { setTimeout(applyWeb, 60); }, true);
  document.addEventListener("visibilitychange", () => {
    /* 切后台可能吞掉收起事件：直接归零，绝不带着一条空白回前台 */
    if (document.hidden) { lastWebKb = -1; applyWeb(); }
  });
  applyWeb();
}

export function initKeyboardInset() {
  if (!Capacitor.isNativePlatform()) { initWeb(); return; }   /* 网页端走可视视口那套 */
  try {
    Keyboard.addListener("keyboardWillShow", (i) => setInset(i && i.keyboardHeight));
    Keyboard.addListener("keyboardDidShow", (i) => setInset(i && i.keyboardHeight));
    Keyboard.addListener("keyboardWillHide", () => setInset(0));
    Keyboard.addListener("keyboardDidHide", () => setInset(0));
  } catch (e) {
    setInset(0);
    return;
  }
  /* 切后台时系统可能吞掉某次 hide 事件：一并归零，绝不带着一条空白回到前台 */
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) setInset(0);
  });
}
