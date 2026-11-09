/* ═══ 轮 472 · 输入态「两级返回」+ 键盘可见判据 ═══
 *
 * 用户报：「折叠了是成功了，但是折叠之后暖心墙怎么样去切换底部四个按钮呢？」
 *
 * 病根：条一打开就把 tabbar 整条 `v-if` 摘掉（轮 108 为让条贴键盘）。键盘收起后条仍留在
 * 屏底，四个页签一个都点不到，只能靠「点空白把条关掉」才切得回来 —— 而用户往往不知道
 * 要点哪儿（按键盘自带的「收起」时连 click 都不会发生）。
 *
 * 试过的另一版（**用户否掉了，别再回潮**）：折叠键盘后 tabbar 回来、条抬到它头顶。
 * 底部堆两层既丑又挤，用户原话「太丑了，不要折叠后 tabbar 回来、条坐到它头顶」。
 *
 * 定案（用户拍板）：「做输入的时候上面变暗一点点，然后点击外部返回。」
 *   · 条打开时整页压一层很淡的暗色（style.css 的 .cmt-bar-mask），出口明确；
 *   · 点暗处 / 按系统返回键 = 返回，两级：
 *       第一下 = 落键盘（条留着、草稿留着，等于键盘上的「收起」）
 *       第二下 = 收条（tabbar 回原位）
 *     微信 / 小红书 / 知乎的评论输入条都是这个手感：先落键盘，再退面板。
 *
 * ⚠ 真机踩到的坑（小米浏览器 / 1080×2460，2026-11-08）：
 *   **键盘收起后焦点仍留在 textarea 里**（点页面空白只收键盘、不 blur）。
 *   所以「条内有焦点 = 键盘在」是错的 —— 一开始就是这么写的，结果键盘收了还判「在」，
 *   点外部只白白 blur 一下、条没退（用户说的「点了没反应」）。
 *   现在主判据是**视口有没有真的缩**（含 resizes-content 内核的 innerHeight 收缩），
 *   焦点只在「刚聚焦 800ms 内、视口还没来得及反馈」时兜一下。
 */

import { ref } from "vue";
import { pickChatHeight } from "./chatHeight.js";

export const kbVisible = ref(false);

/* 「条」的选择器：暖心墙评论条 / 详情页回复栏 / 聊天页输入栏 */
const BAR_SEL = ".cmt-main-bar, .reply-bar";
/* 视口明显缩小多少才算「键盘占了屏」：31~80px 是浏览器工具栏/手势条的常态抖动 */
const KB_GAP = 100;
/* 刚聚焦后给视口多少时间反馈。超过这段还没缩，就当「没有键盘弹出来」 */
const FOCUS_GRACE = 800;

function kbVar() {
  try {
    const n = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--kb-h"));
    return Number.isFinite(n) ? n : 0;
  } catch (e) { return 0; }
}

function focusedInBar() {
  const el = typeof document !== "undefined" ? document.activeElement : null;
  if (!el || el === document.body || el === document.documentElement) return false;
  return !!(el.closest && el.closest(BAR_SEL));
}

/* 无键盘时的布局视口高（基准）。只在「条里没有焦点」时刷新 ——
 * 键盘弹着时 innerHeight 是缩过的 484，拿它当基准就永远判不出「键盘收了」。
 * 横竖屏切换时布局视口会整块换掉，直接重置，别拿竖屏的 744 去比横屏的 390。 */
let baseInner = 0;

export function readKbVisible() {
  if (typeof window === "undefined") return false;
  const inner = window.innerHeight || 0;
  const vv = window.visualViewport;
  const vvH = vv ? vv.height : 0;

  /* ① 原生壳：Keyboard 插件写的真实高度（adjustNothing，布局视口不动） */
  if (kbVar() > 80) return true;
  /* ② 绝对判据：可视视口比布局视口矮 → overlay 键盘 */
  if (inner - vvH > KB_GAP) return true;
  /* ③ 增量判据：布局视口自己缩了 → resizes-content 内核（小米浏览器就是这一支） */
  if (baseInner > 0 && baseInner - inner > KB_GAP) return true;
  /* ④ 兜底：刚聚焦、视口还没来得及反馈（键盘正在升的那 100~300ms） */
  return focusedInBar() && Date.now() - focusedAt < FOCUS_GRACE;
}

function sync() {
  if (!focusedInBar()) {
    const inner = window.innerHeight || 0;
    if (inner > 0) baseInner = inner;   /* 无焦点 = 最可信的无键盘态 */
  }
  const v = readKbVisible();
  if (kbVisible.value !== v) kbVisible.value = v;
}

/* ── 两级返回 ── */
let armed = false;      /* 条内输入框此刻握着焦点 */
let blurredAt = 0;      /* 最近一次「条内输入框失焦」的时刻 */
let focusedAt = 0;      /* 最近一次聚焦时刻（兜底判据用） */
let installed = false;

function blurActive() {
  try {
    const el = document.activeElement;
    if (el && el !== document.body && typeof el.blur === "function") el.blur();
  } catch (e) { /* 极端环境忽略：收不了键盘也不能抛错 */ }
}

/* 失焦到这一击之间允许的间隔。国产内核（含小米浏览器）在 touch 阶段就把焦点摘了，
 * click 冒到 document 时 activeElement 已经是 body —— 那次失焦本就是「这一击」造成的，
 * 所以给一段宽限。超过 400ms 才算「上一轮已经收过键盘了」。 */
const BLUR_GRACE = 400;

/* 点条外面时调用。
 * 返回 true  = 这一击只该落键盘，别关条；
 * 返回 false = 该关条了。
 *
 * ⚠ 焦点 + 视口必须同时成立才算「键盘还在」：真机上键盘收起后焦点常常还留在
 * textarea 里，只看焦点会把「键盘已经没了」误判成「还在」，用户点空白就只是
 * 白白 blur 一下、条还在原地 —— 正是他抱怨的「点了没反应」。 */
export function barTapIsKbBack() {
  sync();   /* 别用 200ms 前的旧判据：这一击前面可能刚收过键盘 */
  const now = Date.now();
  if (armed && kbVisible.value) {
    armed = false;
    blurredAt = 0;
    blurActive();
    return true;
  }
  if (blurredAt && now - blurredAt <= BLUR_GRACE) {
    blurredAt = 0;
    armed = false;
    return true;
  }
  return false;
}

/* 收条时清账：否则下次开条后第一击会被上一轮的 blurredAt 误判成「刚收过键盘」 */
export function resetBarReturn() {
  armed = false;
  blurredAt = 0;
}

export function initBarReturn() {
  if (installed || typeof window === "undefined" || typeof document === "undefined") return;
  installed = true;
  baseInner = window.innerHeight || 0;

  const vv = window.visualViewport;
  if (vv) {
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
  }
  window.addEventListener("resize", sync, { passive: true });
  window.addEventListener("orientationchange", () => {
    /* 横竖屏换了基准：等布局稳定后重取，否则会拿竖屏 744 去比横屏 390 */
    baseInner = 0;
    setTimeout(() => { baseInner = window.innerHeight || 0; sync(); }, 300);
  });

  document.addEventListener("focusin", () => {
    if (focusedInBar()) { armed = true; focusedAt = Date.now(); }
    sync();
  }, true);
  document.addEventListener("focusout", () => {
    if (!armed) { sync(); return; }
    armed = false;
    blurredAt = Date.now();
    /* 失焦后再校一次：键盘是不是真的落了，由视口说了算 */
    setTimeout(sync, 60);
    setTimeout(sync, 260);
  }, true);

  /* 兜底巡检：部分内核不派发 visualViewport / 不按预期派发 focus 事件 */
  setInterval(sync, 200);
  sync();
}
