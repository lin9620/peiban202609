/* ═══ 轮 506 · 视口唯一事实来源（吸底条 / 表情面板的定位与高度）═══
 *
 * 轮 508（用户：「你不要只看我这台手机的，别的苹果手机浏览器呢」）：
 *   本文件只负责**读原始数字 + 写 CSS 变量**，所有判据都搬进了 viewportMath.js。
 *   原因还是那句话：iOS 各版本上报的视口语义不是一回事 —— iOS 15–18 的 inner 是
 *   小视口，iOS 26 的 inner 是**含玻璃栏的大视口**且键盘弹起也不变，X 内置浏览器把
 *   100svh 报成 100lvh。把这些当输入跑纯函数，才能一次覆盖十几台机；
 *   真机一台台点做不到（iOS 没有 adb，见 tools/ios-compat-test.mjs 开头）。
 *
 * 用户第五次报同一件事：「表情框跟输入框高度依然不一致」。前四轮（496~504）都在这条
 * 链上打补丁，没有一个治到根 —— 因为**面板高度和面板位置一直是「推导」出来的**：
 *
 *     面板高 = --kb-panel-h = min(--kb-last, --kb-cap)
 *                --kb-last ← writeVar(panelH)
 *                panelH   ← h = kbInsetValue(kbWebInset(inner, vv.height, vv.offsetTop))
 *
 * 这条链有三个独立的失效点，任一个断掉，面板就退回「估计值」（320 或 307），
 * 与真键盘（iPhone 336 / 291）差一截 —— 用户看到的就是「表情框跟输入框高度不一致」。
 *
 * 最致命的是 kbWebInset 里的 **减 offsetTop**：
 *   iOS 为了让光标露出来，会把可视视口**上推**（offsetTop ≈ 键盘高）。
 *   于是 inner - vv.height - offsetTop ≈ 0 → --kb-h = 0 → --kb-last 永远写不进去。
 *   而「键盘占多高」这个量本来就跟 offsetTop 无关：
 *       键盘高 = innerHeight − visualViewport.height      （上推不上推都成立）
 *
 * 所以这里不再推导，直接读三个原始数字：
 *   --kb-last : 键盘本体高度（本会话最大值，设备常量；只增不减）
 *   --kbb     : 吸底条 / 表情面板离**布局视口底**的距离（= 可视视口底在哪）
 *
 * 两个值都不加任何闸门（不看焦点、不看 --kb-h、不看面板开关状态）。
 * 事件漏派发就靠 250ms 巡检补 —— 读两个只读属性，命中缓存，不触发重排。
 *
 * 「静态噪声」只在一处挡：inner 与 vv 差 < 120 一律当浏览器工具栏（小米浏览器无键盘
 * 时 vv 就比 inner 矮 31px），不让它冒充键盘。真键盘最低也 ≥ 200，120 这个界两边都安全。
 */

import { computeViewportVars } from "./viewportMath.js";

const KBB = "--kbb";        /* 条/面板离布局视口底 */
const KBL = "--kb-last";    /* 键盘本体高度（面板高度就用它） */
const VPH = "--vph";        /* 真实可视高（浏览器 UI 占用后的那一块，**含键盘**） */
/* 轮 511 · 布局视口高（innerHeight）。
 *
 * 页面盒子（私信页 .dm-page）要的是这个，不是 --vph：
 *   高度 = 布局视口高 − 让位量(--kbb)
 *     · 无键盘：852 − 81(工具栏) = 771 = 工具栏上方那条线 ✓
 *     · 键盘上推：852 − 0 = 852，iOS 自己把可视区上推了，页面底正好落在键盘上沿 ✓
 * 换用 --vph 会算错键盘态：它是「含键盘」的可视高（522），页面缩到 522 之后
 * 再叠上 iOS 的上推，输入条反而悬在键盘上方 81px。 */
const VLH = "--vlh";
const WEB_CLASS = "kb-web";
/* 轮 512 · 键盘/视口关系分流（用户：「安卓本来好好的，你改苹果之后全是问题」）
 *
 * 轮 511 把「页面盒子高 = --vlh − --kbb」这一套无条件套给了所有网页端，但它是为
 * **overlay 型**（iOS Safari：键盘浮在页面上、布局视口不缩）推导的。安卓是 resize 型
 * ——键盘一弹窗口自己就缩了，innerHeight 随地址栏/键盘实时变，于是：
 *   · 页面高度跟着 inner 一帧一帧变，`.dm-page` 又带 .22s 的 height 过渡
 *     → 退出会话、切表情时看到的「缩放 / 一闪」；
 *   · 键盘弹起时盒子 = inner − 0，和原来 `100dvh − --kb-h` 的落点对不齐，
 *     表情面板与输入条交接那一瞬错位。
 * 所以这里只做一件事：**判定内核属于哪一型，打在 html 上**，CSS 按类型选式子。
 *   html.kb-overlay → 用 --vlh − --kbb（iOS 那套，轮 511）
 *   html.kb-resize  → 用原来的 100dvh − --kb-h（安卓那套，轮 511 之前，行为一字不改）
 * 初值按 UA 猜（iOS 的 UA 在移动端足够可靠），**第一次弹出键盘就以实测为准**并锁定：
 * 键盘弹了而 inner 没缩 = overlay；inner 被缩了 ≥120 = resize。以后不再翻。 */
const OVERLAY_CLS = "kb-overlay";
const RESIZE_CLS = "kb-resize";

function guessOverlayByUA() {
  try {
    const ua = navigator.userAgent || "";
    if (/iP(hone|ad|od)/.test(ua)) return true;
    /* iPadOS 13+ 的 UA 伪装成 Macintosh，用触点数区分 */
    return /Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1;
  } catch (e) { return false; }
}

let overlayLocked = false;   /* 已经由实测锁定（弹过一次键盘） */
let isOverlay = guessOverlayByUA();

function applyKbKind(de) {
  if (!de) return;
  try {
    de.classList.toggle(OVERLAY_CLS, isOverlay);
    de.classList.toggle(RESIZE_CLS, !isOverlay);
  } catch (e) { /* 忽略 */ }
}

let kbMax = 0;              /* 本会话见过的最大键盘高度 */
let restH = 0;              /* 无键盘时的 innerHeight 基线（缩布局视口型内核要用） */
let barsBase = -1;          /* 无键盘时的「浏览器 UI 遮挡高」基线（iOS 26 玻璃栏 / 小米噪声） */
/* 轮 513 · 闭环校正量（见 utils/bottomPin.js）。
 * 上面那一整套是**推导**：拿浏览器上报的数字算「可视区底在哪」。推导依赖每一台机器
 * 上报的数字都对 —— iOS 26 的玻璃栏、X 内置浏览器的 svh、小米的 31px 噪声，每个都
 * 能让它错一次；错了就表现成「表情面板沉到屏幕外 / 只露两排」。
 * 这里留一个**实测**的补正量：由 bottomPin.js 直接量「该贴住的元素」离可视区底多远，
 * 差多少就补多少。方向与 --kbb 相反（--kbb 越大越往上），所以消费者不用改式子 ——
 * 写进 --kbb 的就是 kbb + fix，几个消费者（页面高 / 吸底条 / 面板）自动一起动。 */
let kbbFix = 0;
const FIX_LIMIT = 260;      /* 兜底上限：真错了也不会把界面推到屏幕外 */
let svhH = 0;               /* 100svh 探针读数（0 = 量不出来） */
let dvhH = 0;               /* 100dvh 探针读数（0 = 量不出来） */
let lastProbeAt = 0;        /* 上次测探针的时间（节流用） */
let lastProbeInner = 0;     /* 上次测探针时的 innerHeight（变了就立刻重测） */
let lastKey = "";
let booted = false;

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

/* ═══ 真实可视高探针（轮 507）═══
 *
 * 用户第五次报同一个问题后，真相比前几轮更难缠：Safari 的**底部工具栏是 overlay**
 * —— 它盖在页面之上，而 window.innerHeight / visualViewport.height 都**不扣它**。
 * 于是 `.dm-page { height: 100dvh }` 的底边落在工具栏下面那一截，表情面板贴着这个底，
 * 最后一排正好被工具栏吃掉（视频里只露出 2 排表情，其余全在屏幕外）。
 *
 * 没有任何一个 JS 属性会说「工具栏多高」，但**视口单位会**：
 *   svh = 小视口 = 永远取「浏览器 UI 全展开」时的高度（最保守，最可能扣掉工具栏）
 *   dvh = 动态视口 = 随 UI 伸缩
 * 各版本 Safari 的实现并不一致，所以不押宝某一个 —— 直接量，**取三者最小**：
 * 谁扣掉了浏览器 UI，就取到谁。量不出来（老内核把 svh 算成 0）就退回 innerHeight，
 * 与改动前完全一致，不会更差。
 *
 * 探针用持久元素、只在 resize / 方向变化 / 可见性变化时重测（改 height 会重排），
 * 250ms 巡检只复用缓存值。
 */
let probeEl = null;
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

/* 轮 508：两个读数**分别**留下，不再当场取 min。
 * 取 min 让「iOS 26 玻璃栏收起后 dvh 长大」这件事永远体现不出来（吸底条悬空），
 * 而且掩盖不了 svh 在 X 内置浏览器里被报成 lvh 的错（737 vs 691）。
 * 该选哪个由 viewportMath 按语义决定（dvh 优先），这里只负责量。 */
function readProbes() {
  svhH = probeHeight("100svh");
  dvhH = probeHeight("100dvh");
}

/** 现读一次视口，把变量写到 :root。幂等，值没变就不碰样式。 */
export function syncViewportVars() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  /* App 壳走原生 Keyboard 插件（那边 --kb-h 是系统给的最终值），两套语义不能混用 */
  if (isNativeShell()) return;

  const de = document.documentElement;
  if (de && !de.classList.contains(WEB_CLASS)) {
    try { de.classList.add(WEB_CLASS); } catch (e) { /* 忽略 */ }
  }
  applyKbKind(de);

  const inner = Math.round(window.innerHeight || 0);
  if (!(inner > 0)) return;
  if (!(restH > 0)) restH = inner;

  /* 真实可视高探针：量 height 会触发重排，所以节流。
   * 注意 innerHeight 一变（键盘缩窗口 / 地址栏收放）就必须重测 —— 否则会把键盘态的
   * 小值缓存下来，键盘收起后 kbb 仍按小值算，整条吸底栏被抬到半空（kb-matrix 抓到过）。 */
  const nowMs = Date.now();
  const innerMoved = Math.abs(inner - lastProbeInner) > 2;
  if (!(svhH > 0) || !(dvhH > 0) || innerMoved || nowMs - lastProbeAt > 900) {
    lastProbeAt = nowMs;
    lastProbeInner = inner;
    readProbes();
  }
  const vv = window.visualViewport;

  /* 轮 508：算式整块搬进 viewportMath.js（纯函数），因为「换一台苹果手机就换一种错法」
   * 这件事只能靠矩阵单测挡住 —— 真机一台台去点是不现实的。见 tools/viewport-matrix-test.mjs */
  const r = computeViewportVars({
    inner,
    vvH: vv && vv.height > 0 ? vv.height : 0,
    vvT: vv ? vv.offsetTop || 0 : 0,
    scale: vv ? vv.scale : 1,
    svh: svhH,
    dvh: dvhH,
    restH,
    barsBase,
    kbMax,
  });
  if (!r.ok) return;

  /* 轮 512 · 弹过键盘就以实测锁定内核类型（UA 只是初值；分屏 / 桌面模式会骗人）。
   * 只锁一次：键盘动画中途读数会抖，反复改类会让页面高度来回跳。 */
  if (!overlayLocked && r.kb > 0) {
    overlayLocked = true;
    if (r.overlay !== isOverlay) {
      isOverlay = r.overlay;
      applyKbKind(de);
    }
  }

  /* 基线只在「确实没有键盘」时抬高：不然键盘弹起后的 innerHeight 会被记成基线，
   * 下一次就再也算不出差值（历史坑，见 keyboardInset.js 的 restH）。 */
  if (!(r.kb > 0) && inner > restH) restH = inner;
  barsBase = r.bars;

  if (r.kbMax > kbMax) {
    kbMax = r.kbMax;
    setVar(KBL, kbMax + "px");
  }
  const key = inner + "|" + r.vph + "|" + r.kbb + "|" + barsBase + "|" + kbbFix;
  if (key !== lastKey) {
    lastKey = key;
    setVar(KBB, (r.kbb + kbbFix) + "px");
    setVar(VPH, r.vph + "px");
    setVar(VLH, inner + "px");
  }
  /* 现场诊断（只写全局、不改行为）：控制台一句 JSON.stringify(window.__wpVars) */
  try {
    window.__wpVars = {
      inner, vvH: Math.round(vv && vv.height || 0), vvT: Math.round(vv && vv.offsetTop || 0),
      kbb: r.kbb, kbbFix, kbbUsed: r.kbb + kbbFix, kb: r.kb, kbMax, restH, vph: r.vph, vphSrc: r.src,
      bars: r.bars, svh: svhH, dvh: dvhH, visBottom: r.visBottom,
      panel: kbMax || null, scale: vv ? vv.scale : null, at: Date.now(),
    };
  } catch (e) { /* 忽略 */ }
}

/** 闭环校正：把「该贴住可视区底」的元素位置误差补进 --kbb（正数 = 往下挪）。 */
export function nudgeKbbFix(delta) {
  if (typeof delta !== "number" || !isFinite(delta)) return 0;
  const next = Math.max(-FIX_LIMIT, Math.min(FIX_LIMIT, Math.round(kbbFix + delta)));
  if (next === kbbFix) return kbbFix;
  kbbFix = next;
  lastKey = "";               /* 强制重写一次 --kbb */
  syncViewportVars();
  return kbbFix;
}

/** 换页面 / 旋屏时把校正量归零，别把上一页的误差带过去。 */
export function resetKbbFix() {
  if (!kbbFix) return;
  kbbFix = 0;
  lastKey = "";
  syncViewportVars();
}

let raf = 0;
let until = 0;
/* 键盘起落是分几步动画走的，逐帧采一小段最稳（读两个只读属性很便宜） */
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
  if (isNativeShell()) return;   /* App 壳零开销 */
  booted = true;

  syncViewportVars();

  const vv = window.visualViewport;
  if (vv && typeof vv.addEventListener === "function") {
    vv.addEventListener("resize", () => { syncViewportVars(); sample(360); });
    vv.addEventListener("scroll", syncViewportVars);
  }
  window.addEventListener("resize", () => { syncViewportVars(); sample(360); }, { passive: true });
  /* 旋屏后浏览器 UI 的排布整个换了（玻璃栏横竖不同、状态栏消失），基线必须全部重来 */
  window.addEventListener("orientationchange", () => {
    restH = 0; barsBase = -1; svhH = 0; dvhH = 0; kbbFix = 0;
    syncViewportVars(); sample(900);
  }, { passive: true });
  document.addEventListener("focusin", () => sample(900), true);
  document.addEventListener("focusout", () => sample(420), true);
  document.addEventListener("visibilitychange", syncViewportVars);
  window.addEventListener("pageshow", syncViewportVars, { passive: true });
  /* 有的内核干脆不派发 visualViewport 事件（实测小米浏览器）—— 巡检兜底 */
  setInterval(syncViewportVars, 250);
}
