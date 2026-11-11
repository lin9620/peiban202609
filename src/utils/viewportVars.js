/* ═══ 轮 506 · 视口唯一事实来源（吸底条 / 表情面板的定位与高度）═══
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

const KBB = "--kbb";        /* 条/面板离布局视口底 */
const KBL = "--kb-last";    /* 键盘本体高度（面板高度就用它） */
const VPH = "--vph";        /* 真实可视高（浏览器 UI 占用后的那一块） */
const WEB_CLASS = "kb-web";
const MIN_KB = 120;         /* 低于它一律当工具栏，不当键盘 */
const MAX_RATIO = 0.7;      /* 键盘不可能占掉七成屏高（缩放到 1.05 以内时兜底） */

let kbMax = 0;              /* 本会话见过的最大键盘高度 */
let restH = 0;              /* 无键盘时的 innerHeight 基线（缩布局视口型内核要用） */
let vphH = 0;               /* 探针测出的真实可视高（见 readViewportHeight） */
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

function readViewportHeight(inner) {
  let best = inner;
  for (let i = 0; i < 2; i++) {
    const css = i === 0 ? "100svh" : "100dvh";
    const h = probeHeight(css);
    if (h > 0 && h < best) best = h;
  }
  /* 探针读到比屏还高的值（个别内核把 svh 当 lvh 算）→ 弃用，避免把容器撑爆 */
  if (!(best > 0) || best > inner + 1) return inner;
  return best;
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

  const inner = Math.round(window.innerHeight || 0);
  if (!(inner > 0)) return;
  if (!(restH > 0)) restH = inner;

  /* 真实可视高探针：量 height 会触发重排，所以节流。
   * 注意 innerHeight 一变（键盘缩窗口 / 地址栏收放）就必须重测 —— 否则会把键盘态的
   * 小值缓存下来，键盘收起后 kbb 仍按小值算，整条吸底栏被抬到半空（kb-matrix 抓到过）。 */
  const nowMs = Date.now();
  const innerMoved = Math.abs(inner - lastProbeInner) > 2;
  if (!(vphH > 0) || innerMoved || nowMs - lastProbeAt > 900) {
    lastProbeAt = nowMs;
    lastProbeInner = inner;
    vphH = readViewportHeight(inner);
  }
  const vv = window.visualViewport;
  const zoomed = !!(vv && vv.scale > 1.05);
  /* 双指放大也会缩可视视口，但那不是键盘；缩放态一律按「没有键盘」处理 */
  const vvH = vv && vv.height > 0 && !zoomed ? Math.round(vv.height) : 0;
  const vvT = vv && !zoomed ? Math.max(0, Math.round(vv.offsetTop || 0)) : 0;

  /* ① 键盘本体高度 —— 只跟 inner 与 vv.height 有关，**不扣 offsetTop** */
  let kb = vvH > 0 ? inner - vvH : 0;
  if (!(kb >= MIN_KB)) {
    /* 缩布局视口型内核（Chrome Android / 部分国产浏览器）：键盘把 innerHeight 自己缩了，
       此时 inner - vv.height ≈ 0，只能拿基线反推 */
    const shrink = restH - inner;
    kb = shrink >= MIN_KB ? shrink : 0;
  }
  if (!(kb >= MIN_KB) || kb > inner * MAX_RATIO) kb = 0;

  if (!(kb > 0) && inner > restH) restH = inner;   /* 基线只在真没键盘时抬高 */

  /* ② 吸底条 / 面板该离布局视口底多远
   *
   * 三个来源各说各话，必须按**内核语义**分流，不能一把抓：
   *   · 缩 inner 型（Chrome Android / 小米自带）：键盘弹起时 innerHeight 自己缩了，
   *     此时 inner 就是可视底；而 vv 还会再少 31px（工具栏被重复扣一次），信它就多抬 31。
   *   · 不缩 inner 型（iOS Safari）：inner 不动，只有 vv 缩 —— 可视底 = offsetTop + vv.height。
   *   · 谁都没缩（没键盘）：inner / vv 都不扣 Safari 那个**浮在页面上**的底部工具栏，
   *     只有 svh/dvh 探针（vph）能给到工具栏上方那条线。
   *
   * 上一版把三者一律取 min，结果小米那 31px 静态噪声被当成工具栏，
   * 无键盘时条被平白抬起 31px（kb-matrix 当场抓到 16 条红）。 */
  const vph = vphH > 0 ? vphH : inner;
  const shrunk = restH - inner >= MIN_KB;
  let visBottom;
  if (shrunk) visBottom = inner;
  else if (kb > 0 || vvT > 0) visBottom = vvT + (vvH > 0 ? vvH : inner);
  /* vv 静态偏小（小米那 31px）时不信探针：那不是工具栏，是内核把工具栏重复扣了一次。
     只有 vvH 与 inner 一致（Safari）才说明「谁都没缩」，此时探针是唯一能给出
     工具栏上方那条线的来源。 */
  else visBottom = vvH > 0 && vvH < inner - 2 ? inner : vph;
  let kbb = 0;
  if (visBottom > 0 && visBottom < inner) kbb = inner - visBottom;

  if (kb > kbMax) {
    kbMax = kb;
    setVar(KBL, kbMax + "px");
  }
  const key = inner + "|" + vvH + "|" + vvT + "|" + kbb + "|" + vph;
  if (key !== lastKey) {
    lastKey = key;
    setVar(KBB, kbb + "px");
    setVar(VPH, vph + "px");
  }
  /* 现场诊断（只写全局、不改行为）：控制台一句 JSON.stringify(window.__wpVars) */
  try {
    window.__wpVars = {
      inner, vvH, vvT, kbb, kb, kbMax, restH, vph,
      panel: kbMax || null, scale: vv ? vv.scale : null, at: Date.now(),
    };
  } catch (e) { /* 忽略 */ }
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
  window.addEventListener("orientationchange", () => { restH = 0; syncViewportVars(); sample(900); }, { passive: true });
  document.addEventListener("focusin", () => sample(900), true);
  document.addEventListener("focusout", () => sample(420), true);
  document.addEventListener("visibilitychange", syncViewportVars);
  window.addEventListener("pageshow", syncViewportVars, { passive: true });
  /* 有的内核干脆不派发 visualViewport 事件（实测小米浏览器）—— 巡检兜底 */
  setInterval(syncViewportVars, 250);
}
