/* 轮 424 · 全局按压反馈（「一点就有反应」）
 *
 * 用户原话：「app 里面大多数的点击都没有效果，改成小红书那样，点击有轻微的反馈」。
 *
 * 小红书那套拆开只有三件事：
 *   ① 反馈挂在「手指按下」那一刻，不等 click —— click 要等抬手，安卓 WebView 上还会多 300ms；
 *   ② 幅度极小：透明度掉到 ~0.66，或者 scale 0.97，动 60~120ms，抬手立刻弹回；
 *   ③ 系统自带的灰色高亮块（tap-highlight）必须关掉，否则两层叠在一起又脏又迟钝。
 *
 * 为什么不用纯 CSS :active —— 实测（tools/screencast-tap.mjs + .probe7/sampler.js）：
 * 同一次点击里 :active 什么时候挂上由浏览器决定，配合路由切换时经常「还没画就被撤掉」，
 * 所以这里用 pointerdown 委托自己加类，时序完全由我们掌握。
 *
 * 不碰的地方：聊天组件（vue-advanced-chat 在 shadow DOM 里，透传上来的 target 是宿主，
 * 给整块聊天区做缩放会像屏幕在抖）、输入框、文字选中、以及滚动过程中的手指。
 */

const PRESSABLE = [
  "a[href]",
  "button",
  "[role='button']",
  "summary",
  "label",
  ".clickable",
  ".van-tabbar-item",
  ".van-button",
  ".van-cell",
  ".van-switch",
  ".van-tabs__nav",
  "[data-press]",
  /* 下面这批是从源码里统计出来的「带 @click 的元素类名」（tools/skin-gate-test 里有清单校验）。
   * 为什么不能只靠语义标签：这个 App 里大量可点元素是光秃秃的 div。
   * 为什么不能靠 el._vei（Vue 的事件表）：这个构建里挂不上，实测拿不到，别再走那条路。
   * 注意：**不要加裸 .card** —— 消息列表整块是 `aside.card.dm-list`，加了它按住空白处
   * 会把整个面板变淡（真机实测踩过），那是假反馈。只认具体的卡片类。 */
  ".post-card",
  ".btn",
  ".post-avatar",
  ".post-name",
  ".go-detail",
  ".ra",
  ".dm-act",
  ".dm-menu-item",
  ".dm-more",
  ".dm-head-more",
  ".dm-name",
  ".dm-peer-link",
  ".dm-seg-btn",
  ".more-item",
  ".more-btn",
  ".set-row",
  ".set-opt",
  ".cmt-react",
  ".cmt-act",
  ".cmt-del",
  ".cmt-more",
  ".cmt-entry",
  ".cmt-toggle",
  ".t-like",
  ".st-btn",
  ".sr-btn",
  ".st-link",
  ".sort-btn",
  ".auth-cta",
  ".auth-link",
  ".waller-act",
  ".fold-more",
  ".admin-tab",
  ".admin-open",
  ".admin-entry",
  ".notif-act",
  ".mail-send",
  ".tabbar-opt",
  ".bar-reply-tap",
  ".compose-send",
  ".p-card",
  ".adopt-mask",
  ".bcl-tab",
  ".bcl-more",
  ".tag-chip",
].join(",");

/* 这些区域一律不做（会晃、会打断手势、或者自己已有更细的按压态） */
const SKIP = ".dm-thread, .dm-vac, .dm-vac-box, .vac-box, .dm-row, .wp-nopress, input, textarea, select";

const MOVE_TOLERANCE = 10;   /* 手指移动超过 10px 视为滚动，立刻撤掉 */
const MIN_HOLD = 90;         /* 按住时间太短也至少亮这么久，否则快点点一下看不见 */

let held = null;      /* { el, x, y, at } */
let releaseTimer = 0;

function pressable(target) {
  if (!target || target.nodeType !== 1) return null;
  let el = target.closest(PRESSABLE);
  if (!el) {
    /* 兜底：这个 App 里大量可点元素是光秃秃的 div（只有 @click，没有语义、也没有 cursor）。
     * 单靠 class 一定漏，所以两条一起看：
     *   · Vue 3 把 v-on 监听器挂在 el._vei 上（键名形如 onClick）—— 有它就说明这里真能点；
     *   · 其次才看 cursor:pointer。
     * 只往上找 8 层，避免一路爬到 body 把整页都算成可点。 */
    let n = target;
    let depth = 0;
    while (n && n !== document.body && depth++ < 8) {
      if (hasVueClick(n) || getComputedStyle(n).cursor === "pointer") { el = n; break; }
      n = n.parentElement;
    }
  }
  if (!el || el.closest(SKIP)) return null;
  return el;
}

function hasVueClick(el) {
  const v = el._vei;
  if (!v) return false;
  for (const k in v) if (/^onClick/i.test(k)) return true;
  return false;
}

function release(now = true) {
  clearTimeout(releaseTimer);
  const cur = held;
  held = null;
  if (!cur) return;
  const { el, at } = cur;
  const rest = now ? MIN_HOLD - (performance.now() - at) : 0;
  const off = () => {
    /* 这 200ms 里用户可能又按下同一个元素，别再把人家的类摘掉 */
    if (held && held.el === el) return;
    el.classList.remove("wp-press");
    /* wp-live 留着把「弹回」的过渡走完，再摘掉，避免把过渡属性长期挂在别人身上 */
    setTimeout(() => {
      if (held && held.el === el) return;
      el.classList.remove("wp-live", "wp-scale", "wp-big");
    }, 200);
  };
  if (rest > 0) releaseTimer = setTimeout(off, rest);
  else off();
}

function onDown(e) {
  if (e.pointerType === "mouse") return;               /* 桌面靠 :hover，不要重复 */
  if (e.button !== undefined && e.button !== 0) return;
  release(false);                                      /* 上一发没等到抬手就作废，防止叠两个 */
  const el = pressable(e.target);
  if (!el) return;
  el.classList.add("wp-live");
  /* 有自己 transform 的元素只做透明度：硬改会把别人的位移/旋转顶掉。
   * 但很多元素只是因为 transform: translateZ(0)（合成层提示）才算出 identity 矩阵，
   * 那种也该跟着缩 —— 否则「卡片按下去会收一下」的手感就没了（真机实测：post-card、
   * status-card、home-chip 全是 identity，早期版本因此只有页签会缩）。 */
  const tf = getComputedStyle(el).transform;
  if (tf === "none" || tf === "matrix(1, 0, 0, 1, 0, 0)") el.classList.add("wp-scale");
  /* 大块头（帖子卡、整块面板）压到 0.66 会整片发灰、正文发虚 —— 单独轻一档。
   * 阈值取 6 万 CSS px²（约 300×200），正好把「一张帖子卡」划进去、把按钮/图标留在外面。 */
  const r = el.getBoundingClientRect();
  if (r.width * r.height > 60000) el.classList.add("wp-big");
  el.classList.add("wp-press");
  held = { el, x: e.clientX, y: e.clientY, at: performance.now() };
}

function onMove(e) {
  if (!held) return;
  if (Math.abs(e.clientX - held.x) > MOVE_TOLERANCE || Math.abs(e.clientY - held.y) > MOVE_TOLERANCE) release(false);
}

function onScroll() {
  if (held) release(false);
}

const onUp = () => release();
const onCancel = () => release(false);

export function installTapFeedback() {
  const opts = { passive: true };
  document.addEventListener("pointerdown", onDown, opts);
  document.addEventListener("pointerup", onUp, opts);
  document.addEventListener("pointercancel", onCancel, opts);
  document.addEventListener("pointermove", onMove, opts);
  window.addEventListener("scroll", onScroll, { passive: true, capture: true });
  return () => {
    document.removeEventListener("pointerdown", onDown, opts);
    document.removeEventListener("pointerup", onUp, opts);
    document.removeEventListener("pointercancel", onCancel, opts);
    document.removeEventListener("pointermove", onMove, opts);
    window.removeEventListener("scroll", onScroll, { capture: true });
  };
}
