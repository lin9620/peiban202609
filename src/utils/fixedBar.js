/* ═══ 轮 469 · 吸底输入条（暖心墙评论条 / 详情页回复栏）直接钉到可视视口底 ═══
 *
 * 用户报：「在手机浏览器上暖心墙帖子评论，打字也有问题，看不见」。
 *
 * 病根（真机 + 诊断条确认）：这两条原来是 `position: fixed; bottom: var(--kb-h)`。
 * 这是**间接推导** —— --kb-h 由 keyboardInset 的网页分支算出来，而那条链上有三道
 * 可能失效的闸门：visualViewport 事件派发、焦点判据、缩放保护。任何一道在某台设备/
 * 某个浏览器上不成立，--kb-h 就是 0，条停在 bottom:0，键盘一弹直接把它整个盖住：
 * 键盘亮着，人却看不见自己打的字。
 *
 * 聊天页（chatViewport.js）早就改成直接读 visualViewport 了，评论区漏了这一刀。
 * 这里用同一套判据（utils/chatHeight.js 的 fixedBarTop）把条钉到「可见区底 − 条高」，
 * 不经过 --kb-h，因此与内核语义无关：
 *   · resizes-content 内核：可见区底 = innerHeight（已经缩过）
 *   · overlay 键盘内核：可见区底 = vv.offsetTop + vv.height
 *   · iOS Safari 上推：offsetTop 一并计入
 *
 * App 壳（cap-app）完全不走这里：那边是 adjustNothing + 原生 Keyboard 插件给 --kb-h，
 * 高度由 CSS 的 calc 负责，混进来会把条顶穿（轮 322 踩过）。
 */
import { fixedBarTop } from "./chatHeight.js";

const SELECTOR = ".cmt-main-bar, .reply-bar";
/* 表情面板打开时条要抬到面板上沿，那个位置由 CSS（min(46vh,320px)）算，
 * 这里必须让开，否则内联 top 会把它压回底部、盖在面板上。 */
const PANEL_CLASSES = ["wp-emoji-open", "wp-kb-swap"];

let booted = false;
let timer = 0;
let mo = null;
let ro = null;
const watching = new Set();
const lastTop = new WeakMap();
/* 现场诊断用（?kbdiag=1 或浏览器控制台可看 window.__wpBarDebug）：不参与逻辑 */
let DEBUG = null;

function isNativeShell() {
  const c = typeof window !== "undefined" ? window.Capacitor : null;
  if (c && typeof c.isNativePlatform === "function") {
    try { return !!c.isNativePlatform(); } catch (e) { /* 继续看类名 */ }
  }
  return !!document.documentElement && document.documentElement.classList.contains("cap-app");
}

function kbVar() {
  const v = getComputedStyle(document.documentElement).getPropertyValue("--kb-h");
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function release(el) {
  if (!el) return;
  el.style.top = "";
  el.style.bottom = "";
  lastTop.delete(el);
}

function place(el) {
  /* 面板打开 / 条已隐藏 → 交回 CSS，不许留内联值。
   * 注意不能用 offsetParent 判可见：position:fixed 元素的 offsetParent 恒为 null。 */
  if (!el.isConnected) return;
  if (PANEL_CLASSES.some((c) => el.classList.contains(c))) { release(el); return; }

  const vv = window.visualViewport;
  const barH = el.getBoundingClientRect().height;
  if (!(barH > 0)) return;
  const top = fixedBarTop(
    window.innerHeight,
    vv ? vv.height : 0,
    vv ? vv.offsetTop : 0,
    kbVar(),
    barH
  );
  if (!(top > 0)) return;
  if (lastTop.get(el) === top) return;
  lastTop.set(el, top);
  el.style.top = top + "px";
  /* 必须显式清 bottom：CSS 里写的是 bottom:0 / var(--kb-h)，留着两个都生效会互相顶。 */
  el.style.bottom = "auto";
}

function sync() {
  if (isNativeShell()) return;
  if (DEBUG) { DEBUG.runs++; DEBUG.lastTops = []; }
  const list = document.querySelectorAll(SELECTOR);
  if (DEBUG) DEBUG.found = list.length;
  list.forEach((el) => {
    const before = el.style.top;
    place(el);
    if (DEBUG && el.style.top !== before) DEBUG.lastTops.push(el.style.top);
    if (!watching.has(el) && ro) {
      ro.observe(el);          /* 文本换行长高 → 重新贴底（否则底边会跑出屏幕） */
      watching.add(el);
    }
  });
  /* 已经不在文档里的条：从观察列表移除，避免泄漏 */
  watching.forEach((el) => {
    if (!el.isConnected) { if (ro) ro.unobserve(el); watching.delete(el); }
  });
}

function kick() {
  clearTimeout(timer);
  timer = setTimeout(sync, 16);
}

export function initFixedBar() {
  if (booted || typeof window === "undefined" || typeof document === "undefined") return;
  /* App 壳零开销：不装监听、不起定时器 */
  if (isNativeShell()) return;
  booted = true;
  DEBUG = window.__wpBarDebug = { booted: true, runs: 0, found: 0, lastTops: [] };

  if (typeof ResizeObserver !== "undefined") {
    ro = new ResizeObserver(kick);
  }
  if (typeof MutationObserver !== "undefined") {
    /* 条是靠 v-if / Teleport 现挂现摘的，没有事件能听 —— 盯 body 的子节点变化 */
    mo = new MutationObserver(kick);
    mo.observe(document.body, { childList: true, subtree: true });
  }

  const vv = window.visualViewport;
  if (vv) {
    vv.addEventListener("resize", kick);
    vv.addEventListener("scroll", kick);
  }
  window.addEventListener("resize", kick, { passive: true });
  window.addEventListener("orientationchange", kick, { passive: true });
  /* 焦点进出会让键盘起落，而有些内核不派发 visualViewport 事件 —— 补一条 */
  document.addEventListener("focusin", kick, true);
  document.addEventListener("focusout", kick, true);

  /* 兜底巡检：键盘起落期间每 250ms 校一次，key 不变就什么都不做 */
  setInterval(sync, 250);

  sync();
}
