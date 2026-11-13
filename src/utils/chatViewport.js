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
  /* 轮 522 · 退场期一律不接管。
   *
   * 病根（无头 Edge 逐帧抓到的，393×852，真 style.css + 真 chatViewport）：
   * 退出时 `dm-page--chat` 这个类要等淡出播完才摘（聊天体得活着才能淡），于是
   * releaseChatViewport() 之后的那一次巡检 / resize 又把它认成「还在聊天页」——
   * 当场重新写回 position:fixed + 393 宽 + 锁文档。逐帧看得很清楚：
   *   t3002 已交还（list 18/357）→ t3050 又被接管（list 0/393）→ t3184 再次交还。
   * 也就是说用户在淡出的那 180ms 里看到列表先宽、再窄、再宽，最后才是收尾那次缩。
   * 这正是「退出会话有一个缩放」一直没治好的原因 —— 轮 517/519 只做了「退的那一下
   * 交还」，没人保证「交还之后不再抢回去」。
   *
   * 标记由 MessagesView.beginThreadOut 挂、finishThreadOut 摘，与 threadOut 同一帧。 */
  if (document.documentElement.classList.contains("dm-exiting")) return null;
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

/* 轮 521 · 键盘弹起时盒子有多高（--kb-pageh，由 viewportVars 在键盘锁高后写）。
 * 读不到（还没弹过键盘 / App 壳）返回 0，调用方退回原行为。 */
function kbPageHeight() {
  try {
    const v = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--kb-pageh")
    );
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch (e) { return 0; }
}

/* 表情面板是不是开着（宿主 DmVacChat 挂在 html 上）。
 * 不用查 DOM：面板在 shadow tree 里，querySelector 根本找不到。 */
function emojiSheetOpen() {
  try {
    return document.documentElement.classList.contains("wp-emoji-open");
  } catch (e) { return false; }
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
  let h = rect.h;
  /* 轮 521 · 表情面板开着时，盒子高度**沿用键盘态的盒子高**，不跟着当前视口走。
   *
   * 用户第六次报（原话）：「别的软件都是键盘跟表情固定一个高度」「以键盘高度为准是
   * 做不到吗」。真机逐帧量到的差就是 55px，而且不是算错：
   *   · 键盘态 inner 744（浏览器工具栏展开）、键盘 260 → 盒子 484
   *   · 面板态 inner 799（键盘收起时工具栏也收了）→ 盒子 799 − 260 = 539
   * 输入条贴盒子底，于是每切一次摆 55px。
   *
   * 钉成同一个盒子高之后：键盘态 484、面板态也 484，条一动不动；面板从 484 铺到
   * 视口底（799 − 484 = 315），多吃掉的那 55px 正是工具栏腾出来的那块，
   * 视觉上跟「键盘换成面板」完全等价 —— B站/微信那种手感。
   *
   * 只在面板真的开着时钉：平时盒子必须跟着视口（工具栏伸缩、滚动都靠它）。
   * 键盘态下 rect.h 本来就等于 --kb-pageh，取 min 不产生任何变化。 */
  if (emojiSheetOpen()) {
    const kp = kbPageHeight();
    if (kp > 0 && kp < h) h = kp;
  }
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

  /* 轮 520 · 把「页面此刻实际有多高」也导出去，给表情面板的让位当参照系。
   *
   * 为什么必须共用这一个数：会话页的整屏高度是**这里写的内联像素**，快捷键收起时
   * 它只能靠 resize 事件 + 250ms 巡检更新，跟不上键盘动画 —— 真机逐帧
   * （_scratch/real/v520-vac.json）拍到 inner 已经 799 了，这个盒子还停在 484
   * 整整 258ms（正好一个巡检周期）。而 footer 的让位吃的是逐帧算的 --kb-now，
   * 两者一错位，输入条就被算到屏幕上半部再弹回来（日志里那条 ±315px）。
   * 让位改吃 --chat-h 之后：盒子没动，让位也不动 —— 无论它什么时候更新，
   * 条都停在同一个位置（见 DmVacChat 的 THEME_CSS）。 */
  const de = document.documentElement;
  if (de && de.style.getPropertyValue("--chat-h") !== h + "px") {
    de.style.setProperty("--chat-h", h + "px");
  }

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

/* 轮 524 · resize 类事件**当场同步对齐**，不再只等 rAF。
 *
 * 真机逐帧（小米 393×744，键盘 260）量到的：点输入框那一趟 inner 走
 * 744 → 539 → 484，盒子高度在最后一步上晚了一帧 —— 那一帧里输入条还停在 539，
 * 而键盘顶已经到 484，**条被键盘埋进去 55px**（肉眼就是「条从键盘底下钻出来」）。
 *
 * 原因不是 sync 算错，是 rAF 的语义：回调是在**本帧的回调队列已经跑完之后**才注册的，
 * 于是只能排到下一帧。事件落在「布局/绘制阶段」时，这一帧已经按新视口画完了，
 * 盒子却还是旧高。同步跑一次就没有这个缝 —— sync 内部有 key 去重，
 * 值没变时只做几次 getComputedStyle 就返回，多跑一次的成本可以忽略。
 *
 * 只有 resize 类事件走同步（一次键盘动画总共两三次）；scroll 那一路会每帧都响，
 * 继续挂 rAF，别在滚动时强制重排。 */
function kickNow() {
  sync();
  kick();
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

/* 轮 517 · 退出会话时**同步拆掉接管**，不许等 250ms 巡检。
 *
 * 用户第 3 条（安卓浏览器）：「从某一条会话退出到会话列表有一个缩放」。
 * 真凶不在过渡曲线 —— 是这段时间没人回来收摊：
 *   · .dm-page 上的内联还挂着 position:fixed / width / height / overflow:hidden
 *   · html/body 还带着 `wp-chat-fix { height:100%; overflow:hidden }`
 * 退出只是把 `dm-page--chat` 这个**类**摘掉，内联样式照样生效，于是列表页被钉在
 * 「393×812 的 fixed 框 + 裁切」里；等巡检的 sync 发现 findChatPage() 已经不是聊天页、
 * 才 clearInline + unlockDoc —— 用户在 0~250ms 后看到内容「弹」回文档流，就是那个缩放。
 *
 * 这里刻意**不查** findChatPage：退出那一帧 Vue 还没 patch 完、路由也还没退回来，
 * 查出来的结论不可靠。谁锁的谁放，最不容易错。 */
export function releaseChatViewport() {
  if (el) { clearInline(el); el = null; }
  lastKey = "";
  unlockDoc();
}

export function initChatViewport() {
  if (booted || typeof window === "undefined") return;
  /* App 壳连监听都不装、定时器都不起 —— 那边完全走原生路径，这里零开销。 */
  if (isNativeShell()) return;
  booted = true;

  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", kickNow);
    window.visualViewport.addEventListener("scroll", kick);
  }
  window.addEventListener("resize", kickNow, { passive: true });
  window.addEventListener("orientationchange", kickNow, { passive: true });
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
