/* ═══ iOS / WebKit 专属「键盘 ↔ 表情」视口控制器 · 轮 533 ═══
 *
 * 用户原话（2026-11-14）：
 *   「苹果端的键盘-表情你也没搞好啊，一堆问题还在，都说了苹果的你搞个单独的，
 *     代码隔离一下，别天天改完苹果的安卓的就出问题」
 *
 * 这轮就是照这句话做的：**这个文件和 src/utils/viewportVars.js 互不引用。**
 *
 *   · viewportVars.js 在入口只判一次 isIosKbDevice()，是 iOS 就整个交给这里，
 *     后面那一整套安卓状态机（base / vvBase / shouldAdoptBase / --kb-over / --kb-kbb）
 *     一行都不执行；
 *   · 这里也不 import viewportVars 的任何状态，只共用 chatHeight.js 的无状态纯函数。
 *
 * 所以「改苹果」在物理上碰不到安卓的代码，反之亦然。这是结构上的隔离，不是靠
 * if (isIOS) 把两套逻辑塞进同一个函数里 —— 那种写法这半年已经互相踩了三次
 * （524 改坏安卓、532 又改坏一次）。
 *
 * ═══ iOS 的两个物理事实（决定了下面每一行）═══
 *
 * ① **布局视口不随键盘缩。** interactive-widget 在 Safari 上等于没写，键盘弹起时
 *    innerHeight 一个像素都不变（852 还是 852），只有 visualViewport 会变。
 *    所以安卓那条 `base − inner` 在 iOS 上**恒为 0**，一个信息量都没有。
 *
 * ② **键盘底永远贴着布局视口底。** 键盘从屏幕最底下长上来，所以
 *    `innerHeight − visualViewport.height` 在键盘态就**正好是键盘高**，
 *    不需要推导、不需要基线、不需要「上一帧涨了多少」。
 *
 * ② 是这份文件的核心。旧的共用实现走的是 `vvBase − vvH`（开机无键盘时的 vv 当基线），
 * 那个基线在两代 Safari 上是两个不同的数：
 *
 *    · 无键盘时 vv.height = 852（工具栏是覆盖层，不扣可视高）→ vvBase 852 → 键盘高 330 ✓
 *    · 无键盘时 vv.height = 771（工具栏扣掉了可视高）→ vvBase 771 → 键盘高 **249** ✗
 *
 * 而 iOS 真正的键盘高是 330。差的那 81px 是工具栏：键盘弹起时工具栏消失、
 * 收起时又回来，于是「无键盘基线」和「键盘态读数」里各含一次工具栏，一减就错。
 * 旧工装之所以全绿，是因为它在开机那一刻把 vv 模拟成 852（`__kbSim(852, 0)`），
 * 正好落在第一种语义上 —— 第二种语义从来没被测过。这就是「一堆问题还在」的地基。
 *
 * 换成 `inner − vvH` 之后，两种语义下都对：
 *    852 − 852 = 0   ·   852 − 522 = 330 ✓（第一种）
 *    852 − 771 = 81 → 低于 KB_MIN 判成工具栏，不算键盘
 *    852 − 522 = 330 ✓（第二种）
 * 无键盘时最多算出 81（工具栏），KB_MIN 那道闸门正好把它挡掉。
 */

import { kbbValue } from "./chatHeight.js";

const KBB = "--kbb";
const KPANEL = "--kb-panel";
const VTOP = "--vtop";
const VPH = "--vph";
const VLH = "--vlh";
const VLH_BASE = "--vlh-base";
const KBPAGEH = "--kb-pageh";

const WEB_CLASS = "kb-web";
const OVERLAY_CLS = "kb-overlay";
const RESIZE_CLS = "kb-resize";

/* 键盘高的合法区间。跟安卓那边同一个语义（真键盘 200~360），
 * 只是一份独立的常量 —— 两边互不 import，就是为了谁改谁都不连带。 */
const KB_MIN = 180;
const KB_MAX = 420;
/* 键盘动画 iOS 约 250ms。读数连续 LOCK_SETTLE_MS 不变，才算停稳。 */
const LOCK_SETTLE_MS = 180;
const BASE_WINDOW_MS = 1500;

/** 这台设备是不是走 iOS 这一套。
 *  iPadOS 13+ 的 UA 是 Macintosh —— 用触摸点数认回来，否则 iPad 会掉进安卓那套。 */
export function isIosKbDevice() {
  try {
    const ua = navigator.userAgent || "";
    if (/iP(hone|ad|od)/.test(ua)) return true;
    return /Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1;
  } catch (e) { return false; }
}

/* ── 本模块私有状态。viewportVars.js 里那些同名变量跟这些毫无关系。 ── */
let panelH = 0;      /* 锁定的键盘高（= 面板高） */
let base = 0;        /* 无键盘时的 innerHeight（iOS 上它就等于当前 inner，这里只给 --vlh-base 用） */
let bootAt = 0;
let peakKb = 0;      /* 键盘在屏期间见过的最大值，锁定时兜底 */
let lockTimer = 0;
let lockKb = -1;
let kbUpAt = 0;
let kbbFix = 0;      /* 闭环修正量（bottomPin 用，iOS 上也留着） */
const FIX_LIMIT = 260;
const FORCE_LOCK_MS = 900;
let booted = false;
let lastKey = "";
let svhH = 0;
let dvhH = 0;
let probeEl = null;

const PANEL_KEY = "wp-kb-panel-ios";

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

function num(v) {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/* ── 面板高：跨会话记住 ────────────────────────────────────────────
 * 键盘高在一台设备上是常量，所以第一次量到就存起来，下次开页面第一帧就用它 ——
 * 用户冷启动直接点表情时，面板不会先是 1px 再突然长出来。 */
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
  } catch (e) { /* 隐私模式：当没存过 */ }
}
function savePanelLocked() {
  try {
    localStorage.setItem(PANEL_KEY, JSON.stringify({
      h: panelH, w: Math.round(window.innerWidth || 0), at: Date.now(),
    }));
  } catch (e) { /* 忽略 */ }
}

/* ── 三个度量。全部只依赖「此刻这一帧」的读数，没有基线减法 ────────── */

/** 键盘此刻有多高。**这是整个 iOS 实现的唯一来源。**
 *
 *  `inner − vvH`：键盘贴着布局视口底长上来，所以这个差就是键盘占的那一块。
 *  无键盘时它等于底部工具栏（0 或 81），低于 KB_MIN 一律判成 0。
 *  键盘动画期间它是逐帧单调变化的，跟得住，不会提前满格也不会滞后。 */
function kbHeight(inner, vvH) {
  if (!(inner > 0) || !(vvH > 0)) return 0;
  const d = inner - vvH;
  if (d < KB_MIN) return 0;     /* 工具栏（0~81），不是键盘 */
  return Math.min(d, KB_MAX);
}

/** 键盘在不在屏上。跟 kbHeight 同一个判据，避免「量出一个数又用另一个数判在不在」。 */
function kbIsUp(inner, vvH) {
  return kbHeight(inner, vvH) > 0;
}

/* ── 锁面板高 ────────────────────────────────────────────────────
 * iOS 上「点表情」会立刻开始收键盘，读数从 330 一路掉到 81。如果照安卓那样
 * 「读数变了就重新计时」，定时器会一直重设、直到键盘收完 kbUp 变假才停 ——
 * 那时读数是 81（工具栏），锁不上。所以两头都要：
 *   · 读数还在变 → 重新计时（滤掉动画中间帧，525 那版锁成 249 就是没滤）；
 *   · 定时器到点时用 peakKb 兜底（键盘已经收掉了也不怕，用过见过的最大值）。 */
function scheduleLock() {
  const d = kbHeight(Math.round(window.innerHeight || 0), currentVvH());
  const forced = kbUpAt > 0 && Date.now() - kbUpAt >= FORCE_LOCK_MS;
  if (lockTimer) {
    if (forced || d === lockKb) return;
    clearTimeout(lockTimer);
    lockTimer = 0;
  }
  lockKb = d;
  lockTimer = setTimeout(applyLock, LOCK_SETTLE_MS);
}

function applyLock() {
  lockTimer = 0;
  const d = kbHeight(Math.round(window.innerHeight || 0), currentVvH());
  const v = Math.max(d, peakKb);
  if (v < KB_MIN || v > KB_MAX) return;
  if (panelH > 0 && Math.abs(panelH - v) < 12) return;
  panelH = v;
  setVar(KPANEL, v + "px");
  savePanelLocked();
  lastKey = "";
  iosSyncViewportVars();
}

function currentVvH() {
  const vv = window.visualViewport;
  return vv && vv.height > 0 ? Math.round(vv.height) : 0;
}

/* ── 视口单位探针（--vph 用）。改 height 会重排，所以只在 sync 里按 key 去重跑。 ── */
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

/** 现读一次视口，把 iOS 那一套变量写到 :root。幂等。 */
export function iosSyncViewportVars() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  /* App 壳走原生 Keyboard 插件（--kb-h 是系统给的最终值），两套语义不能混用 */
  if (isNativeShell()) return;

  const de = document.documentElement;
  if (de) {
    try {
      if (!de.classList.contains(WEB_CLASS)) de.classList.add(WEB_CLASS);
      /* 轮 533 · 给 <html> 挂一枚 .kb-ios，作为「这一整套 iOS 规则」的唯一作用域。
       *
       * 样式表里有几处「键盘态 10px 保底、面板态归零」的规则（.dm-thread 的
       * padding-bottom）。在 iOS 上这两态必须合成一个常量，否则输入行每切一次
       * 就在两个参照系之间跳 10px —— 那正是逐帧工装里唯一还剩下的那一下。
       * 安卓不能动（那边 10px 是真的需要的保底），所以用这枚类把它隔开。 */
      if (!de.classList.contains("kb-ios")) de.classList.add("kb-ios");
      /* iOS **恒是 overlay 型**：布局视口不缩，只有可视视口缩。
       * 这个类只在 UA 是 iOS 时才会出现（viewportVars 已经把 iOS 整包交给这里），
       * 所以可以直接写死，不需要每帧再判一次「inner 缩没缩」。 */
      if (!de.classList.contains(OVERLAY_CLS)) de.classList.add(OVERLAY_CLS);
      de.classList.remove(RESIZE_CLS);
    } catch (e) { /* 忽略 */ }
  }

  const inner = Math.round(window.innerHeight || 0);
  if (!(inner > 0)) return;

  restorePanel();

  if (!base) { base = inner; bootAt = Date.now(); }
  /* iOS 的 innerHeight 不随键盘变、也不随工具栏变（工具栏是覆盖层）。
   * 唯一的变动来源是转屏 / 分屏 —— 那两个由 orientationchange 重置 base。 */

  const vv = window.visualViewport;
  const vvH = vv && vv.height > 0 ? Math.round(vv.height) : 0;
  const vtop = vv ? Math.round(vv.offsetTop || 0) : 0;

  /* --vph：这一帧真正能看见多高。iOS Safari 的底部工具栏浮在页面之上，
   * 既不减 innerHeight、也不进 visualViewport（老版本），只能靠 svh/dvh 探针量。
   * 聊天盒子的底一旦落到工具栏下面，贴着盒底的表情面板就会被吃掉一排
   * （用户视频里只露出 2 排）。 */
  svhH = probeHeight("100svh");
  dvhH = probeHeight("100dvh");
  const vph = Math.min(inner, ...[svhH, dvhH].filter((x) => x > 0));

  const kb = kbHeight(inner, vvH);
  const up = kb > 0;

  if (up) {
    if (!kbUpAt) kbUpAt = Date.now();
    if (kb > peakKb) peakKb = kb;
    scheduleLock();
  } else {
    kbUpAt = 0;
    /* 键盘已经收起：把 peak 用掉就清，否则换了输入法（键盘变高）时旧峰值会一直压着 */
    if (panelH > 0 && peakKb > panelH + 12) peakKb = 0;
  }

  /* --kb-now：键盘此刻还占着多高。切换动画全靠它。
   * 键盘全开 = 面板高；全收 = 0；中间逐帧连续 —— 让位算式里两项互补，条原地不动。 */
  const kbNowCap = panelH > 0 ? panelH : KB_MAX;
  const kbNow = Math.max(0, Math.min(kbNowCap, kb));

  /* --kbb：可视区底离**布局视口底**多远（fixed 元素的 bottom 参照布局视口底）。
   *   无键盘、工具栏展开：inner 852 / vv 771 → 81
   *   键盘态：inner 852 / offsetTop 330 + vv 522 → 0
   * 只给 fixed 的面板 / 吸底条用，iOS 上它必须是真实值（安卓那边恒 0，两套互不相干）。 */
  const kbb = kbbValue(inner, vvH, vtop, true, kbbFix);

  const key = [inner, vvH, vtop, vph, kbNow, kbb, panelH, base, isNativeShell()].join("|");
  if (key === lastKey) return;
  lastKey = key;

  setVar(KBB, kbb + "px");
  setVar(VTOP, vtop + "px");
  setVar(VPH, vph + "px");
  setVar(VLH, inner + "px");
  if (base > 0) setVar(VLH_BASE, base + "px");
  /* --kb-pageh：键盘弹起时聊天页盒子有多高 = base − 面板高。
   * 面板态 chatViewport 也把盒子钉成这个数 —— 两种状态的页面盒子是同一个常量，
   * 输入条才可能一动不动。 */
  if (base > 0 && panelH > 0) setVar(KBPAGEH, base - panelH + "px");
  /* --kb-over：**iOS 恒 0**。那个量是安卓的「布局视口比基线还高出来一截」
   * （浏览器工具栏临时收起 55px 再还回来）。iOS 的布局视口不会这样跳，
   * 硬给个非 0 只会把条推歪。变量照写，让 CSS 侧不用判内核。 */
  setVar("--kb-over", "0px");
  setVar("--kb-now", kbNow + "px");
  /* --kb-kbb：按键盘收起进度打折的 --kbb（会话页让位专用）。
   * 键盘全开 ⇒ 0（条贴键盘顶）；全收 ⇒ kbb（条贴面板顶）；中间线性 —— 全程连续。 */
  const kbbEff = panelH > 0
    ? kbb * Math.max(0, 1 - kbNow / panelH)
    : kbb;
  setVar("--kb-kbb", Math.round(kbbEff) + "px");

  try {
    window.__wpVars = {
      inner, vvH, vtop, kbb, vph, svh: svhH, dvh: dvhH,
      base, vvBase: vvH, kbUp: up, kbNow, over: 0, panel: panelH || null,
      peak: peakKb || null,
      kind: "overlay",
      engine: "ios",
      at: Date.now(),
    };
  } catch (e) { /* 忽略 */ }
}

/* ── 闭环修正（bottomPin 用；iOS 侧独立一份计数） ──────────────── */
export function iosNudgeKbbFix(delta) {
  if (typeof delta !== "number" || !isFinite(delta)) return 0;
  const next = Math.max(-FIX_LIMIT, Math.min(FIX_LIMIT, Math.round(kbbFix + delta)));
  if (next === kbbFix) return kbbFix;
  kbbFix = next;
  lastKey = "";
  iosSyncViewportVars();
  return kbbFix;
}

export function iosResetKbbFix() {
  if (!kbbFix) return;
  kbbFix = 0;
  lastKey = "";
  iosSyncViewportVars();
}

/* ── 逐帧采样窗口（键盘动画期间多跑几帧，别只靠事件） ──────────── */
let raf = 0;
let until = 0;
function sample(ms) {
  if (typeof requestAnimationFrame !== "function") return;
  const now = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
  until = Math.max(until, now() + ms);
  if (raf) return;
  const tick = () => {
    iosSyncViewportVars();
    if (now() < until) { raf = requestAnimationFrame(tick); } else { raf = 0; }
  };
  raf = requestAnimationFrame(tick);
}

export function initIosKb() {
  if (booted || typeof window === "undefined") return;
  if (isNativeShell()) return;
  booted = true;

  iosSyncViewportVars();

  const vv = window.visualViewport;
  if (vv && typeof vv.addEventListener === "function") {
    vv.addEventListener("resize", () => { iosSyncViewportVars(); sample(420); });
    vv.addEventListener("scroll", iosSyncViewportVars);
  }
  window.addEventListener("resize", () => { iosSyncViewportVars(); sample(420); }, { passive: true });
  window.addEventListener("orientationchange", () => {
    base = 0; bootAt = 0; svhH = 0; dvhH = 0;
    iosSyncViewportVars(); sample(900);
  }, { passive: true });
  document.addEventListener("focusin", () => sample(900), true);
  document.addEventListener("focusout", () => sample(420), true);
  document.addEventListener("visibilitychange", iosSyncViewportVars);
  window.addEventListener("pageshow", iosSyncViewportVars, { passive: true });
  /* 有的 WebKit 内嵌浏览器（App 内 / 第三方壳）不派发 visualViewport 事件 —— 巡检兜底 */
  setInterval(iosSyncViewportVars, 250);
}

/* 只给测试用：把模块状态清空，重跑一轮（工装里模拟「冷启动」） */
export function __resetIosKb() {
  panelH = 0; base = 0; bootAt = 0; peakKb = 0;
  lockTimer = 0; lockKb = -1; kbUpAt = 0; kbbFix = 0; lastKey = "";
  svhH = 0; dvhH = 0; booted = false;
}
