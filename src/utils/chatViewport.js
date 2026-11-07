/* ═══ 轮 465 · 聊天页视口接管（position: fixed + visualViewport，彻底脱离文档流）═══
 *
 * 前三轮（462/463/464）都在「算高度」上打转，全没解决。真机复验后确认根因不在算式：
 *
 *   ① iOS Safari 的键盘**从不缩布局视口**（interactive-widget 在 Safari 上等于没写），
 *      vh / dvh / innerHeight 一个都不变；它只会把**整个文档往上滚**去露出光标。
 *      只要文档比视口高哪怕一行 —— 而 .shell 天生带 `padding: 0 18px 48px`，
 *      再加上页脚、浮层外边距 —— Safari 就有得滚，滚完页尾就露出「视口之外」的空白。
 *      所以 `calc(100dvh - 键盘高)` 算得再准，那块空白照样在。
 *   ② 安卓小米浏览器同理：键盘是 overlay，布局视口不变；输入条贴在布局视口底部，
 *      正好压在系统手势条上（Chromium 的 env(safe-area-inset-bottom) 恒为 0，
 *      没有值可让位）。
 *
 * 换机制：把聊天页容器直接钉成 `position: fixed` + 精确覆盖 visualViewport。
 *   · fixed 脱离文档流 → 文档没有任何可滚内容 → Safari / 小米都无处可推，空白消失；
 *   · height 取 visualViewport.height（不是 dvh）→ 无论内核用 resizes-content 还是
 *     overlay，这个值都等于「键盘上方的可见高度」，一套代码覆盖两边；
 *   · top 取 visualViewport.offsetTop → 万一被强制滚动了也跟着钉住不会错位。
 *
 * 也刻意**不依赖任何类名判据**（前两轮死在 .shell--chat / .dm-page--chat 没挂上）：
 * 只认「移动形态 + 聊天面板真的渲染了」这一条事实。
 */

const MOBILE_QUERY = "(max-width: 899px)";
const MOBILE = typeof window !== "undefined" && window.matchMedia
  ? window.matchMedia(MOBILE_QUERY)
  : null;

let el = null;          /* 当前被接管的 .dm-page */
let lastKey = "";       /* 上次写入的 高度|偏移|宽度，没变就不碰样式（避免每帧重排） */
let locked = false;     /* 是否锁了文档滚动 */
let timer = 0;
let booted = false;

/* 聊天面板真的在页面上（v-if 渲染完成）才算数。
 * 先看 .dm-page--chat（正常路径），再兜底看 /messages/:id + .dm-thread —— 后者是
 * 「类没挂上」的历史事故形态，面板画出来了但外壳不知道，前两轮就是死在这里。 */
function findChatPage() {
  /* App 壳绝不接管：那边是 adjustNothing + 原生 Keyboard 插件给 --kb-h，
   * 高度用过渡跟系统输入法动画咬合，WebView 的 visualViewport 语义也不一样。
   * 两套混用会把输入条顶穿（轮 322 踩过）。 */
  if (isNativeShell()) return null;
  if (!MOBILE || !MOBILE.matches) return null;
  const page = document.querySelector(".dm-page");
  if (!page) return null;
  if (page.classList.contains("dm-page--chat")) return page;
  if (/^\/messages\/[^/]+\/?$/.test(location.pathname) && page.querySelector(".dm-thread")) {
    return page;
  }
  return null;
}

function isNativeShell() {
  const c = typeof window !== "undefined" ? window.Capacitor : null;
  if (c && typeof c.isNativePlatform === "function") {
    try { return !!c.isNativePlatform(); } catch (e) { /* 继续看类名 */ }
  }
  return !!document.documentElement && document.documentElement.classList.contains("cap-app");
}

function lockDoc() {
  if (locked) return;
  locked = true;
  /* 双保险：fixed + 文档不可滚。有些内核（含小米）对 html 的 overflow 支持不严，
   * 但 fixed 已经把文档高度压成 0，两者叠加才万无一失。 */
  document.documentElement.style.overflow = "hidden";
  document.body.style.overflow = "hidden";
  document.documentElement.classList.add("wp-chat-fix");
}

function unlockDoc() {
  if (!locked) return;
  locked = false;
  const de = document.documentElement;
  const bd = document.body;
  if (de) {
    de.style.overflow = "";
    de.classList.remove("wp-chat-fix");
  }
  if (bd) bd.style.overflow = "";
}

function clearInline(node) {
  if (!node) return;
  node.style.position = "";
  node.style.top = "";
  node.style.left = "";
  node.style.width = "";
  node.style.height = "";
  node.style.maxHeight = "";
  node.style.zIndex = "";
  node.style.overflow = "";
  node.style.boxSizing = "";
}

function sync() {
  const page = findChatPage();
  if (!page) {
    if (el) { clearInline(el); el = null; }
    lastKey = "";
    unlockDoc();
    return;
  }

  const vv = window.visualViewport;
  const h = Math.round(vv ? vv.height : window.innerHeight);
  const left = Math.round(vv ? vv.offsetLeft : 0);
  const w = Math.round(vv ? vv.width : window.innerWidth);
  /* offsetTop 是「可视视口相对布局视口的位移」——iOS 为了让光标可见会把可视视口往上推，
   * fixed 元素却钉在布局视口上，不补这一下就会错位。但补偿不能超过「布局视口 - 可视高度」
   * （即键盘占掉的那部分），否则极端情况会把整页推出屏幕。 */
  const maxTop = Math.max(0, window.innerHeight - h);
  const top = Math.min(Math.max(0, Math.round(vv ? vv.offsetTop : 0)), maxTop);
  if (!(h > 0) || !(w > 0)) return;

  if (page !== el) {
    if (el) clearInline(el);
    el = page;
    lastKey = "";
    settleScroll(el);
  }

  const key = h + "|" + top + "|" + left + "|" + w;
  if (key === lastKey) return;
  lastKey = key;

  /* 改高度之前先记「原来是不是贴着底」。键盘弹起时容器从 812 缩到 476，
   * 内容区跟着矮 336px；如果不管，scrollTop 不动就等于往上跳了 336px（用户会看到
   * 自己刚发的消息被顶出屏幕）。只有原本就贴底才补，正在翻历史的不动。 */
  const sc = el.querySelector(".dm-scroll");
  const stick = sc ? sc.scrollHeight - sc.scrollTop - sc.clientHeight < 48 : false;

  lockDoc();
  el.style.position = "fixed";
  el.style.top = top + "px";
  el.style.left = left + "px";
  el.style.width = w + "px";
  el.style.height = h + "px";
  el.style.maxHeight = "none";
  el.style.zIndex = "30";
  el.style.overflow = "hidden";
  el.style.boxSizing = "border-box";
  /* 必须显式关掉过渡：CSS 里 .dm-page--chat 带着 height .22s 的曲线（给 App 壳用，
   * 那边键盘高度是「预先告知的最终值」）。网页端 visualViewport 是实时的，留着过渡
   * 会让输入条在键盘动画整段期间都落后半拍 —— 手感上就是「键盘上来了，条还在下面」。 */
  el.style.transition = "none";

  if (stick && sc) sc.scrollTop = sc.scrollHeight;
}

/* 接管的那一瞬间，消息区可能还是「按内容撑高」的老布局（clientHeight == scrollHeight，
 * scrollTop 写不进去）—— 这正是用户报的「点进会话直接出现在记录最前方」。
 * 高度被真正限住之后补一次贴底；已经有正常滚动位置的不动，免得把正在翻历史的人拽回底部。 */
function settleScroll(node) {
  setTimeout(() => {
    if (!node.isConnected || node !== el) return;
    const sc = node.querySelector(".dm-scroll");
    if (!sc) return;
    if (sc.scrollHeight > sc.clientHeight + 4 && sc.scrollTop < 8) {
      sc.scrollTop = sc.scrollHeight;
    }
  }, 80);
}

function kick() {
  clearTimeout(timer);
  timer = setTimeout(sync, 16);
}

export function initChatViewport() {
  if (booted || typeof window === "undefined") return;
  booted = true;

  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", kick);
    window.visualViewport.addEventListener("scroll", kick);
  }
  window.addEventListener("resize", kick, { passive: true });
  window.addEventListener("orientationchange", kick, { passive: true });
  window.addEventListener("pageshow", kick, { passive: true });

  /* 路由是 history.pushState，没有事件可听；小米浏览器这类内核又可能完全不派发
   * visualViewport 事件。用 250ms 低频巡检兜底 —— 一次 matchMedia + 一次
   * querySelector，且 key 不变就直接返回，开销可忽略。 */
  setInterval(() => {
    if (!MOBILE || !MOBILE.matches) { if (el) sync(); return; }
    sync();
  }, 250);

  sync();
}
