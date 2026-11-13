/* ═══ 视口变量（轮 519 重写）═══
 *
 * 为什么整篇推翻重写（用户：「清掉那个 ai 写的，你重新改」）：
 *
 * 旧的这版是五层叠起来的：
 *     ① --kbb 推导        = inner − (vv.offsetTop + vv.height)
 *     ② --kb-last 推导    = 每帧拿 inner 的缩小量当键盘高，取历史最大
 *     ③ --vtop 修正       = 给 ② 算错时打补丁
 *     ④ bottomPin 闭环    = ③ 还错，就直接量元素位置往回推 --kbb
 *     ⑤ wp-kb-swap 钉位   = ④ 推的过程中位置在跳，再钉一手
 *
 * 真机逐帧（小米浏览器 / 安卓 13 / CDP 注入，_scratch/real/probe-b.json）把 ① 和 ②
 * 直接否掉了：
 *   · 安卓是 resize 型内核，vv.height 每一帧都等于 inner，① 的结果**恒为 0px**。
 *     也就是说吸底条 bottom / 面板 bottom 全部吃的是一个常量 0 —— 五层里有一层空转。
 *   · ② 更糟：键盘动画是 744 → 539 → 484，539 那一帧被算成「键盘高 205」并写进
 *     --kb-last；收起时浏览器先报 799（工具栏临时收起）再报 744，而旧代码
 *     `if (inner > restH) restH = inner` 只增不减，799 被永久当成无键盘基线，
 *     下一次键盘高就成了 799−484 = 315（真值 260）。
 *   用户报的「表情框高度变来变去」「有一闪」就是 ② 自己造出来的，不是浏览器报错。
 *
 * 重写之后只保留两个**测得准**的量，没有一个是从别的量推出来的：
 *
 *   --kb-panel   表情面板高度 = 键盘高度。**只锁一次，永不更新。**
 *                同一台设备上键盘高度是常量，所以它就该是常量 —— 这是「不要变来变去」
 *                在代码里的直接写法，而不是再调一次阈值让它变得没那么明显。
 *
 *   --kbb        可视区底离布局视口底多远。只服务 overlay 型（iOS：键盘浮层、
 *                布局视口不缩）。resize 型（安卓）上它恒为 0，这是**正确值**，不是
 *                兜底 —— 布局视口本身就是可视区。
 *
 * 顺带删掉的：--kb-last / --kb-fallback / --kb-cap / kbbFix / nudgeKbbFix /
 * resetKbbFix / 两套探针的取舍逻辑（现在只取最小，语义单一）。
 *
 * --vtop（可视视口上推量）与 --vph（浏览器 UI 展开后的可视高）保留：它们是
 * 「读一个属性」，不是推导，而且 iOS 的让位公式和聊天盒子高度确实要用。
 */

import { kbbValue, shouldAdoptBase, kbHeightNow, kbIsUp, pickKbKind } from "./chatHeight.js";

const KBB = "--kbb";         /* 吸底条 / 面板离布局视口底的距离 */
const KPANEL = "--kb-panel"; /* 表情面板高度 = 锁定的键盘高 */
const VTOP = "--vtop";       /* 可视视口上推量（iOS 键盘态） */
const VPH = "--vph";         /* 浏览器 UI 展开后的可视高（svh/dvh/inner 取最小） */
const VLH = "--vlh";         /* 布局视口高（innerHeight） */
const VLH_BASE = "--vlh-base"; /* 无键盘时的布局视口高（开机锁定的基线） */
const KBPAGEH = "--kb-pageh";  /* 键盘弹起时聊天页盒子有多高（= base − 键盘高） */

const WEB_CLASS = "kb-web";
const OVERLAY_CLS = "kb-overlay";
const RESIZE_CLS = "kb-resize";

/* 键盘高度的合法区间。真键盘 200~360；低于 180 是动画中间帧，
 * 高于 420 是旋屏 / 分屏 / 读数错了 —— 两个边界都不锁。 */
const KB_MIN = 180;
const KB_MAX = 420;
/* 键盘从弹起到停稳约 250ms。停稳后再等这么久才认，中间帧（539 那种）自然被滤掉。 */
const LOCK_SETTLE_MS = 180;

function guessOverlayByUA() {
  try {
    const ua = navigator.userAgent || "";
    if (/iP(hone|ad|od)/.test(ua)) return true;
    return /Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1;
  } catch (e) { return false; }
}

/* 内核类型。开机先按 UA 猜（iOS 一定是 overlay，能省掉第一次弹键盘时的判断延迟），
 * 之后键盘每在屏上一帧都用 pickKbKind 校正（不是锁死一次）。 */
let isOverlay = guessOverlayByUA();

/* 锁定的键盘高。0 = 还没测到（面板用 CSS 兜底高度）。 */
let panelH = 0;
/* 轮 524 · 锁到的键盘高要**跨会话记住**。
 *
 * 用户「安卓端暖心墙 / 会话，键盘-表情-键盘切换一堆问题」，真机冷启动逐帧抓到的：
 *   · 刚进页面还没弹过键盘就点表情 → --kb-panel 是空的 → 面板高 = max(0, vlh − chat-h)
 *     = 744 − 744 = **0**，面板只有 1px（等于点了没反应）；
 *   · 接着点键盘 → 让位钉在 320 兜底上，输入行从 433 弹到 380 再掉回来，
 *     键盘才姗姗来迟 —— 用户说的「第一次点键盘没反应」。
 * 键盘高在一台设备上是常量，所以第一次测到就存下来，下次开页面直接用它：
 * 冷启动第一帧面板就是 260，跟键盘一模一样，上面那两条整类问题消失。
 * 存 { h, w }：宽度对不上就作废（横竖屏互串会给出一个完全不对的高度）。 */
const PANEL_KEY = "wp-kb-panel-v2";
function restorePanel() {
  if (panelH > 0) return;
  try {
    const o = JSON.parse(localStorage.getItem(PANEL_KEY) || "null");
    const h = Number(o && o.h) || 0;
    if (!(h >= KB_MIN && h <= KB_MAX)) return;
    const w = Number(o && o.w) || 0;
    const nowW = Math.round((typeof window !== "undefined" && window.innerWidth) || 0);
    if (w > 0 && nowW > 0 && Math.abs(w - nowW) > 40) return;
    panelH = Math.round(h);
    setVar(KPANEL, panelH + "px");
  } catch (e) { /* 隐私模式 / 禁用存储：当没存过 */ }
}
function savePanelLocked() {
  try {
    localStorage.setItem(PANEL_KEY, JSON.stringify({
      h: panelH, w: Math.round(window.innerWidth || 0), at: Date.now(),
    }));
  } catch (e) { /* 忽略 */ }
}
/* 无键盘基线：**开机取一次就冻结**。
 *
 * 这是整件事的锚点，取错了后面全错：
 *   base 744 → 键盘态 484 → 面板高 260 ✓
 *   base 799 → 键盘态 484 → 面板高 315 ✗（面板比键盘高 55px，条会差一截）
 *
 * 为什么不能「跟着当前视口走」：用户一滚动，浏览器底部工具栏就收起，inner 从 744 变 799。
 * 799 也会在某些时刻稳定存在，所以「等它稳定」这类闸门挡不住它 —— 上一版就是这么被带偏的
 * （同一段操作，第一次锁 260、第二次锁 315）。
 *
 * 为什么开机那一帧可信：页面刚加载完、还没滚动过，工具栏一定是展开状态，inner 就是 744。
 * 给 1.5s 的窗口取最小值，是为了躲开首帧还没算好工具栏的那一两帧；窗口一过就冻结，
 * 之后页面怎么滚、工具栏怎么收放，都不再影响它。 */
let base = 0;
let bootAt = 0;
const BASE_WINDOW_MS = 1500;
/* 轮 525 · 无键盘时的可视视口高。跟 base 一起冻结。
 *
 * 所有 overlay 型的判据都靠它：键盘占高 = vvBase − vvH。
 * 拿它而不是直接拿 vv 跟 base 比，是为了把「这个内核常年把 vv 报小」那部分抵掉
 * （小米 31px、有的内核 200px）—— 噪声在 vvBase 和 vvH 里是同一个常数，相减就没了。 */
let vvBase = 0;
/* 轮 524b · 基线采纳的观察窗口（见 sync 里那段：瞬时过冲不采纳，稳定才采纳） */
let adoptVal = 0;
let adoptSince = 0;
/* 探针读数（100svh / 100dvh），量不出来是 0 */
let svhH = 0;
let dvhH = 0;
let lockTimer = 0;
/* 轮 526 · 键盘在屏期间量到的最大高度。
 * 面板高要等键盘稳定才锁，可 iOS 上「点表情」会立刻开始收键盘：180ms 后定时器醒过来，
 * 键盘已经收了、只剩工具栏那 81px，被 KB_MIN 挡掉 → 永远锁不上。
 * 所以把「键盘还在时见过的最高值」留一手，定时器拿它兜底。 */
let peakKb = 0;
let booted = false;
let probeEl = null;
let lastKey = "";

/* --kbb 的闭环修正量。只有会话页（DmVacChat / iOS overlay 型）还在用：
 * 那边沿用「量元素离可视区底差多少，就往回推多少」的老做法，本轮不动它。
 * 暖心墙已经不用了 —— 它的问题是面板高度漂移，跟 --kbb 无关。
 * 安卓 resize 型上 --kbb 恒 0，这个值也恒 0，不影响本次修复。 */
let kbbFix = 0;
const FIX_LIMIT = 260;

function isNativeShell() {
  const c = typeof window !== "undefined" ? window.Capacitor : null;
  if (c && typeof c.isNativePlatform === "function") {
    try { return !!c.isNativePlatform(); } catch (e) { /* 继续看类名 */ }
  }
  return !!document.documentElement && document.documentElement.classList.contains("cap-app");
}

function setVar(k, v) {
  try { document.documentElement.style.setProperty(k, v); } catch (e) { /* 忽略 */ }
}

function applyKbKind(de) {
  if (!de) return;
  try {
    de.classList.toggle(OVERLAY_CLS, isOverlay);
    de.classList.toggle(RESIZE_CLS, !isOverlay);
  } catch (e) { /* 忽略 */ }
}

/* 视口单位探针：改 height 会触发重排，所以只在 resize / 方向变化时重测。 */
function probeHeight(css) {
  try {
    if (!probeEl) {
      probeEl = document.createElement("div");
      probeEl.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:0;"
        + "visibility:hidden;pointer-events:none;z-index:-1";
      (document.body || document.documentElement).appendChild(probeEl);
    }
    probeEl.style.height = css;
    return Math.round(probeEl.getBoundingClientRect().height);
  } catch (e) { return 0; }
}

function readProbes() {
  svhH = probeHeight("100svh");
  dvhH = probeHeight("100dvh");
}

/* 键盘停稳后锁一次面板高度。
 * 用「稳定 180ms」而不是「取最大值」来辨认：键盘动画中间帧只存在几十毫秒，
 * 停稳后的那个值才是键盘本身。锁完就再也不会变 —— 面板高度从此是常量。
 *
 * 轮 524：冷启动会先从 localStorage 恢复一份，所以这里不再是「锁一次就永远不碰」，
 * 而是「跟上次记下的差 12px 以上才改」。差 12 以内当抖动忽略，避免面板高来回改；
 * 用户换了输入法 / 换了导航方式（真会让键盘高变几十像素）时又能自己纠正回来。 */
function schedulePanelLock() {
  /* 轮 526 · 这里原来每帧 clearTimeout 再重设 —— 键盘动画期间 sync 是逐帧跑的，
   * 于是 180ms 的定时器**永远等不到触发**，面板高（--kb-panel-h）一直是空的，
   * 全程吃 CSS 兜底 min(46vh,320px)。
   *
   * 安卓上正好能蒙混过去：兜底 320 和真键盘 260 只差 60，且真机验收时键盘高度
   * 恰好让兜底也能看。iOS 上原形毕露 —— 真键盘 330、兜底 320，工装里读出来
   * 面板高一直是 `min(320px, 420px)`，直到手动停手 900ms 后才「啪」地锁成 330。
   * 用户说的「苹果端键盘-表情切换一堆问题」，这是第一条。 */
  if (lockTimer) return;      /* 已经在等，不许重置 */
  lockTimer = setTimeout(() => {
    lockTimer = 0;
    const inner = Math.round(window.innerHeight || 0);
    const vv = window.visualViewport;
    const vvH = vv && vv.height > 0 ? Math.round(vv.height) : 0;
    /* 轮 525：键盘高不能再用 base − inner —— overlay 型内核（iOS、FF 安卓
     * resizes-visual）布局视口根本不缩，这个式子恒得 0，面板高永远锁不上，
     * 于是一直吃 CSS 兜底高度（min(46vh,320px)），跟真键盘差几十像素。
     * kbHeightNow 两条路都量，取大者。 */
    const kb = Math.max(kbHeightNow(base, inner, vvBase, vvH), peakKb);
    if (kb < KB_MIN || kb > KB_MAX) return;
    if (panelH > 0 && Math.abs(panelH - kb) < 12) return;
    panelH = kb;
    setVar(KPANEL, kb + "px");
    savePanelLocked();
    lastKey = "";             /* 让下一帧把其余变量重写一遍（幂等） */
    syncViewportVars();
  }, LOCK_SETTLE_MS);
}

/** 现读一次视口，把变量写到 :root。幂等：值没变就不碰样式。 */
export function syncViewportVars() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  /* App 壳走原生 Keyboard 插件（--kb-h 是系统给的最终值），两套语义不能混用 */
  if (isNativeShell()) return;

  const de = document.documentElement;
  if (de && !de.classList.contains(WEB_CLASS)) {
    try { de.classList.add(WEB_CLASS); } catch (e) { /* 忽略 */ }
  }
  applyKbKind(de);

  const inner = Math.round(window.innerHeight || 0);
  if (!(inner > 0)) return;

  /* 轮 524：先把上次记下的键盘高恢复出来（幂等，只在 panelH 还是 0 时动） */
  restorePanel();

  const vv = window.visualViewport;
  const vvH = vv && vv.height > 0 ? Math.round(vv.height) : 0;
  const vtop = vv ? Math.round(vv.offsetTop || 0) : 0;

  /* 基线：开机 1.5s 内只减不增（等浏览器把工具栏算稳），窗口一过就冻结。 */
  if (!base) { base = inner; bootAt = Date.now(); }
  else if (Date.now() - bootAt < BASE_WINDOW_MS && inner < base) base = inner;

  /* 轮 525 · vvBase 跟 base 同规则冻结（见文件上方声明）。
   * 不报 vv 的内核一直是 0，overlay 那一路自然失效 —— 它们靠 resize 那一路走。 */
  if (vvH > 0) {
    if (!vvBase) vvBase = vvH;
    else if (Date.now() - bootAt < BASE_WINDOW_MS && vvH < vvBase) vvBase = vvH;
  }

  readProbes();
  /* 「键盘真的在」：可见高度比开机时少了 150 以上（判据在 chatHeight.kbIsUp）。
   *
   * 旧写法 `vvH > 0 && base − vvH ≥ 150` 有两种塌法，都是别的浏览器上的：
   *   · 无键盘时 vv 就报小 200 的内核 → 页面一打开这个条件就成立，
   *     内核当场被判成 overlay，--kbb 抬 200px，吸底条浮在半空；
   *   · 根本不报 vv 的内核（vvH 恒 0）→ kbUp 恒假 → 面板高永远锁不上，
   *     而且基线会被键盘态的 484 采纳（shouldAdoptBase 以为那是工具栏收起）。
   * 现在两路都量、取大者，噪声靠 vvBase 相减抵掉。 */
  const kbUp = kbIsUp(base, inner, vvBase, vvH);

  /* 内核分流：按「两路各缩了多少」的比例判（判据在 chatHeight.pickKbKind）。
   *
   * 旧写法在两个地方错：① 只看 `base − inner ≥ 150` 这个绝对量 —— 键盘动画是
   * 两段式的，实测错帧那一帧 vv 已掉到 550、inner 还停在 620（只缩 124），
   * 当场判成 overlay；② `overlayLocked` 只判一次，错一帧就错一整场。
   * 现在键盘每在屏上一帧都可以校正，比例判据对错帧也稳（124/194 = 68% ≥ 50%）。 */
  if (kbUp) {
    const k = pickKbKind(base, inner, vvBase, vvH);
    if (k) {
      const ov = k === "overlay";
      if (ov !== isOverlay) {
        isOverlay = ov;
        applyKbKind(de);
      }
    }
  }

  /* 轮 524b · 过冲还是新基线？（判据在 chatHeight.shouldAdoptBase，有矩阵单测）
   *
   * 用户的机器上开机基线 744，之后工具栏收起、inner 稳定在 768，于是
   * `--kb-over` 常驻 24px —— 会话页的页面盒子被钉在 base − 面板高 = 508，
   * 而面板贴的是真正的屏底 532，两者差 24px，条和面板之间裂一条缝
   * （2026-11-14 第二张截图红框）。
   * 瞬时过冲（实测 140ms 就回来）必须继续只由 --kb-over 抵掉、不动基线，
   * 否则面板高会变成 315；稳定保持 ≥500ms 的，才认它为新基线、过冲归零。
   * 反方向同理：工具栏重新展开（inner 变小）也要跟回来，否则面板态盒子会比
   * 面板顶高出一截，同样裂一条缝。 */
  if (!kbUp && Math.abs(inner - base) > 8) {
    if (inner === adoptVal) {
      if (shouldAdoptBase(base, inner, kbUp, Date.now() - adoptSince)) {
        base = inner;
        adoptVal = 0;
        adoptSince = 0;
      }
    } else {
      adoptVal = inner;
      adoptSince = Date.now();
    }
  } else {
    adoptVal = 0;
    adoptSince = 0;
  }

  /* --kbb：可视区底离布局视口底多远。
   * resize 型键盘态：inner 484 / vv 484 → 0（布局视口就是可视区，条贴底即贴键盘沿）
   * overlay 型无键盘：inner 852 / vv 771 → 81（Safari 底部工具栏那一截）
   * overlay 型键盘态：inner 852 / offsetTop 330 + vv 522 → 0（可视区已被上推，条贴底即贴键盘沿）
   *
   * 轮 524b · **resize 型一律 0**，不许套这条公式。
   * 用户两张截图（暖心墙键盘态 / 会话页面板态）红框里各一条空白，量出来是
   * `--kbb` 31 + `--kb-over` 24 = 55px —— 这个 31 不是工具栏，是**小米浏览器把
   * visualViewport.height 常年报小 31px**（本文件开头「已知内核样本」里就记着这条）。
   * 上面那句「resize 型键盘态 vv 484」只对 Chromium 原生成立；小米、部分国产内核
   * 无键盘时就是 inner 768 / vv 737，公式直接算出 31px 的假让位：
   * 吸底条平白浮起 31px，底下露一条空白。
   * 判据用 isOverlay（UA 先判，第一次弹键盘再用「inner 缩没缩」校准）——
   * resize 型的布局视口就是可视区，根本没有「可视底离布局视口底」这回事。 */
  const kbb = kbbValue(inner, vvH, vtop, isOverlay, kbbFix);

  /* --vph：浏览器 UI 展开后还剩多少。三个读数取最小 —— 谁扣掉了工具栏就取到谁。
   * 老内核把 svh 报成 0 时自动跳过；全量不出来就退回 inner，与改造前一致。 */
  const vph = Math.min(inner, ...[svhH, dvhH].filter((x) => x > 0));

  /* --kb-now：当前键盘占了多高（0 ~ 面板高）。整个切换动画就靠这一个数驱动。
   *
   * resize 型 = 基线 − 当前 inner（键盘弹起时布局视口被压小了多少，收起时回到 0）
   * overlay 型 = 可视视口的上推量（inner 不变，iOS 靠上推露出输入框）
   *
   * 只有「弹过键盘」（panelH 已锁定、base 已确定）才算 —— 否则基线与当前值不可比，
   * 会算出「键盘还占着 55px」这种假的占位。 */
  const over = isOverlay ? 0 : Math.max(0, inner - base);
  /* 轮 524：面板高还没锁过（冷启动）时不再把 kbNow 压成 0。
   *
   * 旧写法 `panelH > 0 && …` 让 --kb-now 在第一次弹键盘的整段时间里恒为 0：
   * 面板的 translateY 不动、让位算式里的 −kbNow 也不动，于是输入条跟着缩小的视口
   * 一路往上跑（真机冷启动：433 → 168 → 113），等键盘量到 260 才「啪」地掉回 433。
   * 键盘当前占高本来就是实测值，跟「面板多高」是两件事 ——
   * 面板高只用来**夹上限**，没锁过就不夹（上限由 KB_MAX 那道闸门管着）。
   *
   * 轮 525：度量换成 chatHeight.kbHeightNow —— resize 型看布局视口缩了多少，
   * overlay 型看可视视口缩了多少，两条都算取大者。旧写法 overlay 分支直接用
   * vv.offsetTop：Firefox 安卓的 resizes-visual 模式下 vv 会缩、offsetTop 却是 0，
   * kbNow 恒 0 → 让位算式完全不动 → 输入条被键盘整个盖住。 */
  const kbNowCap = panelH > 0 ? panelH : KB_MAX;
  const rawKb = kbHeightNow(base, inner, vvBase, vvH);
  /* 轮 526 · overlay 型（iOS）必须把「工具栏」和「键盘」分开。
   *
   * iOS 的 vv 在键盘收起后仍比布局视口矮 81px（那是 Safari 底部工具栏），
   * kbHeightNow 会老老实实报 81 —— 于是 kbNow 常驻 81，面板的 bottom
   * `kb-kbb − kb-now` 变成 0，面板永远贴着屏幕最底、不往工具栏上面让，
   * 输入行和面板之间裂开一整个工具栏（工装实测 532..852 vs 该 441..771）。
   * resize 型没有这个静态噪声，那边必须保持逐帧跟（键盘动画前半段 < 180 时也要跟）。
   */
  if (kbUp && rawKb > peakKb) peakKb = rawKb;
  const kbNow = (isOverlay && rawKb < KB_MIN)
    ? 0
    : Math.max(0, Math.min(kbNowCap, rawKb));

  if (kbUp) schedulePanelLock();

  const key = [inner, kbb, vtop, vph, kbNow, over, panelH, isOverlay, base].join("|");
  if (key === lastKey) return;
  lastKey = key;
  setVar(KBB, kbb + "px");
  setVar(VTOP, vtop + "px");
  setVar(VPH, vph + "px");
  setVar(VLH, inner + "px");
  /* 轮 520 · 无键盘基线也导出：会话页的让位要拿「页面底该在哪」当参照系，
   * 而那个数就是 base − 面板高（见 DmVacChat 的 THEME_CSS）。 */
  if (base > 0) setVar(VLH_BASE, base + "px");
  /* --kb-pageh：**键盘弹起时聊天页盒子有多高**（base − 键盘高）。
   *
   * 轮 521 · 用户第六次报「键盘↔表情切换跳来跳去」，原话：「就不看别的软件吗？
   * 都是键盘跟表情固定一个高度」「以键盘高度为准是做不到吗」。
   *
   * 真机逐帧把最后那 55px 的来源说清楚了（这条不是算错，是**参照系选错**）：
   *   · 键盘态：浏览器工具栏是展开的，inner 744，键盘 260 → 页面盒子 484。
   *   · 面板态：键盘收起后工具栏**也**收起了（小米浏览器就是这样），inner 799，
   *     而面板高仍是 260 → 页面盒子 799 − 260 = 539，比键盘态高 55。
   *   输入条贴着盒子底，于是每切一次就上下摆那 55px。
   *
   * 别的 App 之所以稳，是因为它们的面板占的就是「键盘那一块」，高度跟着键盘走、
   * 不跟着视口走。所以这里把键盘态盒子高单独导出来，面板态直接沿用它 ——
   * 两种状态的页面盒子变成同一个数，条自然一动不动（面板多吃掉工具栏那 55px）。 */
  if (base > 0 && panelH > 0) setVar(KBPAGEH, base - panelH + "px");
  setVar("--kb-now", kbNow + "px");
  /* --kb-kbb：**按键盘收起进度打折的 --kbb**（会话页让位专用）。
   *
   * 会话页的输入条贴在页面盒子底，而表情面板是 fixed 贴「可视视口底」，两者差着
   * 浏览器工具栏那一条（真机 31px）。面板接管屏底之后，让位必须补上这一条，
   * 条才不会压在面板上。
   *
   * 但不能一开面板就补：那一帧键盘还在（--kb-now 260），补上 31px 会把条提前顶离
   * 键盘顶，条底 508 → 477，底下露出 31px 空隙（真机逐帧 t9988 那条 -24px）。
   * 所以要跟 --kb-now 反向走：键盘全开 ⇒ 0（条贴键盘顶），键盘全收 ⇒ kbb（条贴面板顶），
   * 中间线性 —— 条的屏幕位置全程连续，没有一帧是跳的。
   *
   * 除法放在 JS 里算，不写进 CSS：calc 带单位变量相除在国产内核上兼容性不齐。 */
  const kbbEff = panelH > 0
    ? kbb * Math.max(0, 1 - kbNow / panelH)
    : kbb;
  setVar("--kb-kbb", Math.round(kbbEff) + "px");
  /* --kb-over：布局视口比无键盘基线**还高**出来的那一截。
   *
   * 真机实测：键盘收起不是 484 → 744 一步到位，而是 484 → **799** → 744 ——
   * 浏览器底部工具栏临时收起，多报 55px，约 140ms 后又还回来。
   * 那 140ms 里 fixed 的吸底条会跟着 799 往下掉 55px 再弹回，就是用户说的「一闪」。
   * 把这一截单独给出来，让 CSS 在算位置时减掉它，条就钉在 484 不动。 */
  setVar("--kb-over", over + "px");

  /* 现场诊断（只写全局、不改行为）：控制台一句 JSON.stringify(window.__wpVars) */
  try {
    window.__wpVars = {
      inner, vvH, vtop, kbb, vph, svh: svhH, dvh: dvhH,
      base, vvBase, kbUp, kbNow, over, panel: panelH || null,
      kind: isOverlay ? "overlay" : "resize",
      at: Date.now(),
    };
  } catch (e) { /* 忽略 */ }
}

let raf = 0;
let until = 0;
/* 会话页专用（见上面 kbbFix 的说明）。暖心墙已不再调用这两个函数。 */
export function nudgeKbbFix(delta) {
  if (typeof delta !== "number" || !isFinite(delta)) return 0;
  const next = Math.max(-FIX_LIMIT, Math.min(FIX_LIMIT, Math.round(kbbFix + delta)));
  if (next === kbbFix) return kbbFix;
  kbbFix = next;
  lastKey = "";
  syncViewportVars();
  return kbbFix;
}

export function resetKbbFix() {
  if (!kbbFix) return;
  kbbFix = 0;
  lastKey = "";
  syncViewportVars();
}

function sample(ms) {
  if (typeof requestAnimationFrame !== "function") return;
  const now = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
  until = Math.max(until, now() + ms);
  if (raf) return;
  const tick = () => {
    syncViewportVars();
    if (now() < until) { raf = requestAnimationFrame(tick); } else { raf = 0; }
  };
  raf = requestAnimationFrame(tick);
}

export function initViewportVars() {
  if (booted || typeof window === "undefined") return;
  if (isNativeShell()) return;
  booted = true;

  syncViewportVars();

  const vv = window.visualViewport;
  if (vv && typeof vv.addEventListener === "function") {
    vv.addEventListener("resize", () => { syncViewportVars(); sample(360); });
    vv.addEventListener("scroll", syncViewportVars);
  }
  window.addEventListener("resize", () => { syncViewportVars(); sample(360); }, { passive: true });
  /* 旋屏后浏览器 UI 的排布整个换了（玻璃栏横竖不同、状态栏消失），基线必须重来。
   * 面板高度**不重置**：同一台设备横竖屏的键盘高不同，但用户是在竖屏下看的，
   * 重置只会让他在切回竖屏时又看到一次「面板变高了」。 */
  window.addEventListener("orientationchange", () => {
    base = 0; bootAt = 0; svhH = 0; dvhH = 0;
    syncViewportVars(); sample(900);
  }, { passive: true });
  document.addEventListener("focusin", () => sample(900), true);
  document.addEventListener("focusout", () => sample(420), true);
  document.addEventListener("visibilitychange", syncViewportVars);
  window.addEventListener("pageshow", syncViewportVars, { passive: true });
  /* 有的内核干脆不派发 visualViewport 事件（实测小米浏览器）—— 巡检兜底 */
  setInterval(syncViewportVars, 250);
}
