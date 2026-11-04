/* 轮 322 · 键盘让位（只对 App 壳生效）：把系统输入法的高度写成 CSS 变量 --kb-h，
 * 让「整屏聊天页高度 / 吸底输入条 bottom」用等时长的过渡跟着输入法一起上移。
 *
 * 为什么非这么做不可（真机实测，见 jiaojie 轮 322）：键盘弹起的瞬间，如果页面靠系统去缩，
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
 * 兜底原则：任何异常一律往「--kb-h 归零」走。宁可让输入栏贴底被键盘盖住一瞬，
 *   也绝不能留一条永久空白（那正是用户报的问题）。
 */
import { Capacitor } from "@capacitor/core";
import { Keyboard } from "@capacitor/keyboard";
import { kbPageInset } from "./keyboardMath.js";

const VAR = "--kb-h";
const SYS_BOTTOM_VAR = "--sys-bottom";

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

function setInset(px) {
  const raw = Number(px) || 0;
  const sys = raw > 0 ? sysBottom() : 0;
  const vh = (typeof window !== "undefined" && window.innerHeight) || 0;
  const h = kbPageInset(raw, sys, vh);
  /* 现场诊断（只写全局、不改行为）：别的机型若报「还是有缝/被压住」，一句
     JSON.stringify(window.__kbInfo) 就能看清是哪个输入没对，不用连 logcat。 */
  try {
    window.__kbInfo = { raw, sysBottom: sys, kbH: h, innerHeight: vh, at: Date.now() };
  } catch (e) { /* 忽略 */ }
  try {
    document.documentElement.style.setProperty(VAR, h + "px");
  } catch (e) { /* 极端环境忽略：样式变量设不上也不能抛错 */ }
  if (h <= 0) return;
  /* 长页面里的输入框可能被键盘盖住（窗口不再缩 ⇒ 系统不会替我们滚）：
     等让位生效后再把焦点元素滚进可视区。 */
  requestAnimationFrame(() => {
    const el = document.activeElement;
    if (!el || el === document.body || typeof el.scrollIntoView !== "function") return;
    try { el.scrollIntoView({ block: "center" }); } catch (e) { /* 忽略 */ }
  });
}

export function initKeyboardInset() {
  if (!Capacitor.isNativePlatform()) return;      /* 网页端零改动：浏览器自己会平移可视视口 */
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
