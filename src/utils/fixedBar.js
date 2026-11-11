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

/* 轮 506：评论底条与表情面板**退出**这里，改由 CSS 吃 --kbb（utils/viewportVars.js
 * 现读 visualViewport 写成 px）。原因：fixedBar 要自己量条高、写内联 top、再跟
 * ResizeObserver 抢时序；而面板高度来自 --kb-last 另一条推导链 —— 两条链一错位，
 * 条在键盘上沿、面板在键盘底下（用户「表情框跟输入框高度不一致 / 最后一排看不见」）。
 * 现在两者共用同一个 --kbb：值对两个都对，值错两个一起错。这里只留详情页回复栏。 */
const SELECTOR = ".reply-bar";

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
  /* 只接管**真正 fixed** 的元素：桌面上 .wp-composer-picker 是 absolute 小浮窗
   * （跟着输入框往上弹），把它算进来会凭空写一个 top 把它挪走。
   * 轮 504 起不再用「面板打开就把条交回 CSS」—— 条改成用 padding-bottom 让出面板的位置，
   * 两者一起钉在可视底；交回 CSS 等于让它回到「锚布局视口」那个错误参照系。
   * 注意不能用 offsetParent 判可见：position:fixed 元素的 offsetParent 恒为 null。 */
  if (!el.isConnected) return;
  let posValue = "";
  try { posValue = getComputedStyle(el).position; } catch (e) { posValue = "fixed"; }
  if (posValue !== "fixed") { release(el); return; }

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
