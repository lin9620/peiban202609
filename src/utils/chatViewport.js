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
 *   · height 无键盘取 innerHeight（小米浏览器实测与真实可见底一致），
 *     有键盘取 visualViewport.height（那时布局视口不变、只有可视视口缩）；
 *   · top 取 visualViewport.offsetTop → 万一被强制滚动了也跟着钉住不会错位。
 *
 * 也刻意**不依赖任何类名判据**（前两轮死在 .shell--chat / .dm-page--chat 没挂上）：
 * 只认「移动形态 + 聊天面板真的渲染了」这一条事实。
 */

import { pickChatRect } from "./chatHeight.js";

const MOBILE_QUERY = "(max-width: 899px)";
const MOBILE = typeof window !== "undefined" && window.matchMedia
  ? window.matchMedia(MOBILE_QUERY)
  : null;
/* 内核认不认 dvh（Chrome 108+）。不认就只能由脚本写死高度。 */
const supportsDvh = typeof CSS !== "undefined" && typeof CSS.supports === "function"
  && (() => { try { return CSS.supports("height", "100dvh"); } catch (e) { return false; } })();

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

/* 轮 507 · 真实可视高（--vph，由 utils/viewportVars.js 的 svh/dvh 探针写）。
 * Safari 的底部工具栏是 overlay，innerHeight 不扣它；聊天盒子的底边一旦落在工具栏
 * 下面，贴着盒底的表情面板就会少一整排（用户视频里只露出 2 排）。
 * 读不到（老内核 / JS 没跑到）返回 0，pickChatRect 会退回 innerHeight，行为不变。 */
function viewportHeight() {
  try {
    const v = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--vph")
    );
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch (e) { return 0; }
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
  /* 轮 468 · 高度不再在脚本里拍板，交给纯函数按内核语义选源（见 utils/chatHeight.js）：
   * 无键盘用 innerHeight（各内核都等于真实可见高），有键盘用 visualViewport.height
   * （唯一随键盘缩的值）。小米浏览器 vv 偏小 31px、iOS 键盘不缩 inner —— 两种病同一套判据。 */
  const kbRaw = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue("--kb-h")
  ) || 0;
  const vvH = vv && vv.height > 0 ? vv.height : 0;
  const vvTop = vv ? Math.max(0, Math.round(vv.offsetTop || 0)) : 0;
  /* 轮 503：整块「能看见哪一段」的裁决收进 pickChatRect（纯函数、有单测）。
   * 关键一条：可视视口被上推时（iOS 为露出光标会这么干）页面必须同时缩到可视高，
   * 否则 fixed 的页面比能看见的那块高 —— iOS 一推，整页跑到屏幕上方：输入条贴在
   * 地址栏底下、下面一大片空白、消息一条不见（用户四张截图里的第 4 张）。 */
  const rect = pickChatRect(window.innerHeight, vvH, vvTop, kbRaw, viewportHeight());
  const h = rect.h;
  const kbOpen = rect.kbOpen;
  const left = Math.round(vv ? vv.offsetLeft : 0);
  const w = Math.round(document.documentElement.clientWidth || window.innerWidth);
  const top = rect.top;
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

  /* 轮 470 · 只要判定「键盘占位」就必须由脚本写内联高度，不能交回 CSS。
   *
   * 病根（多内核矩阵抓到的，不是这台机）：某些国产内核键盘弹起时**不派发
   * visualViewport 事件**，--kb-h 一直是 0。而 `100dvh` 在 overlay 键盘下根本不变
   * （布局视口不动，缩的只有可视视口）→ 容器仍是全屏高，底边落在键盘底下，
   * 输入条被整个盖住 = 用户说的「打字看不见」。
   * 所以判据只能是「可视视口已经缩了」（pickChatHeight 给的 kbOpen），
   * 不能是「--kb-h 有值」（那只是某一条链路的结果）。
   * 无键盘 + 认 dvh 时才交回 CSS —— 那种情况浏览器自己算得比脚本准。 */
  /* 轮 507 · **永远由脚本写内联高度**，不再「支持 dvh 就交回 CSS」。
   *
   * 病因（用户视频：表情面板只露出 2 排，其余全在屏幕外）：
   * 这之前 `useInlineH = kbOpen || !supportsDvh` —— 键盘没弹起、内核又认 dvh 时，
   * 这里写的是 `height: ""`，把高度交回 CSS 的 `100dvh`。而 iOS Safari 的 dvh
   * 在「大视口」状态下**比当前内层高度大**（地址栏/工具栏收起时的那个数），
   * 于是 .dm-page 比能看见的那块高一两百像素：页面顶对齐、底边沉到屏幕外，
   * 贴着盒底的表情面板自然只剩最上面两排。
   * 判据本来就是「此刻能看见多少」（visualViewport 给的），没有理由再让 CSS 猜一次。
   *
   * 高度来源：h ← pickChatRect（无键盘 = min(innerHeight, --vph)，键盘 = vv.height）。 */
  const useInlineH = true;

  lockDoc();
  el.style.position = "fixed";
  el.style.top = top + "px";
  el.style.left = left + "px";
  el.style.width = w + "px";
  el.style.height = useInlineH ? h + "px" : "";
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

let rafPending = false;
function kick() {
  /* 轮 474：16ms 定时器可能正好跨过下一次绘制，导致「错高度先画一帧」。
   * 补一条 rAF —— 它在**本帧绘制之前**跑，sync 写进去的内联高度和 DOM 更新同帧落地，
   * 用户永远不会看见中间态。两路都留：rAF 在后台标签页会被挂起，定时器兜底。 */
  if (!rafPending && typeof requestAnimationFrame === "function") {
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; sync(); });
  }
  clearTimeout(timer);
  timer = setTimeout(sync, 16);
}
/* 轮 474：进会话是 history.pushState（没有任何事件可听），面板什么时候真的画出来
 * 只有页面自己知道。由 MessagesView 在面板打开的那个 tick 主动踢一脚，
 * 不用干等 250ms 巡检 —— 那 0~250ms 就是「输入条先在屏幕中间弹一下」的全部时长。
 * 这里**同步**跑 sync 而不是走 kick 的延后：调用方已经等过 nextTick（DOM 更新完、
 * 尚未绘制），此刻写内联高度就能和面板落在同一帧；再延 16ms 就会先画一帧 100vh
 * （比可见区高 24px，输入条低一截）。 */
export function kickChatViewport() {
  if (!booted) return;
  sync();
}

export function initChatViewport() {
  if (booted || typeof window === "undefined") return;
  /* App 壳连监听都不装、定时器都不起 —— 那边完全走原生路径，这里零开销。 */
  if (isNativeShell()) return;
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
