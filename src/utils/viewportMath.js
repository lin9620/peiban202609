/* ═══ 轮 508 · 视口读数 → CSS 变量（纯函数，无 DOM）═══
 *
 * 为什么单独抽出来（用户原话：「你不要只看我这台手机的，别的苹果手机浏览器呢」）：
 *   前面每一轮都是「拿一台真机量出数字 → 照那个数字调判据」。可 iOS 各版本上报的
 *   视口语义根本不是一回事，同一份代码换台机就换一种错法：
 *
 *   内核 / 系统                         无键盘时                           键盘弹起
 *   ─────────────────────────────────────────────────────────────────────────────
 *   iOS 15–18 Safari                    inner == vv == 小视口               inner 不变，只听 vv
 *                                       （底部工具栏已在 inner 里扣掉）      vv 缩到键盘上沿
 *   iOS 26 Safari（Liquid Glass）       inner == **大视口**（整块屏，含      inner **仍然不变**
 *                                       两条浮动玻璃栏后面）· vv == 小视口   vv 缩；两栏都算进 vv
 *   X / 微博 等 iOS 内置浏览器           100svh 被报成 100lvh（错的）·      同上
 *                                       dvh 才是真值
 *   小米浏览器                           vv 比 inner 少 31px（工具栏被        窗口自己缩
 *                                       重复扣一次，纯噪声）
 *   Chromium Android (resizes-content)  inner == vv == dvh                  inner 自己缩
 *
 *   唯一稳的做法是把这些**读数**当输入、把结论当输出，然后把上面每一行都跑一遍断言。
 *   本文件只做计算，不碰 DOM，所以 Node 里能直接测（tools/viewport-matrix-test.mjs）。
 *
 * 两个输出量的语义（务必分清，历史上混用过一次就复发一次）：
 *   kb  = 键盘**本体**高度  → 决定表情面板高度（--kb-last）
 *   kbb = 布局视口底到**真实可视底**的距离 → 决定吸底条 / 面板的 bottom 让位（--kbb）
 */

/** 低于它一律当浏览器 UI 遮挡，不当键盘。真键盘最低也 ≥ 200。 */
export const KB_MIN = 120;
/** 浏览器 UI（地址栏 / 底部工具栏 / 玻璃栏）的最大量级。
 *  取 160 而不是 120：iOS 26 横屏时顶部+底部两条玻璃栏加起来能到 110~130，
 *  卡在 120 会把「横屏第一次打开」直接误判成键盘（面板凭空弹出、吸底条悬空）。
 *  真键盘（横屏 iPhone 209 / 安卓 240 / iPad 310）都在 160 以上，两边不误伤。 */
export const CHROME_UI_MAX = 160;
/** 「这一截是浏览器 UI 而不是内核噪声」的下限（px）。
 *  小米浏览器无键盘时 vv 就比 inner 矮 31px（工具栏被重复扣一次），那是噪声；
 *  Safari 工具栏 / iOS 26 玻璃栏实际都在 50 以上。卡 31 与 50 之间两边都不误伤。 */
export const UI_MIN = 50;
/** 键盘不可能占掉七成屏高（缩放 / 分屏时的兜底）。 */
export const KB_MAX_RATIO = 0.7;

const pos = (v) => {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** 探针读数是否可信：必须是正数，且不超过布局视口（个别内核把 svh 当 lvh 算）。 */
const probeOk = (h, inner) => h > 0 && h <= inner + 1;

/**
 * @param {object} i
 * @param {number} i.inner     window.innerHeight
 * @param {number} i.vvH       visualViewport.height
 * @param {number} i.vvT       visualViewport.offsetTop
 * @param {number} i.scale     visualViewport.scale
 * @param {number} i.svh       100svh 探针读数（0 = 量不出来）
 * @param {number} i.dvh       100dvh 探针读数（0 = 量不出来）
 * @param {number} i.restH     无键盘时的 innerHeight 基线（缩布局视口型内核要用）
 * @param {number} i.barsBase  上一次算出的浏览器 UI 遮挡高（-1 = 还没建立）
 * @param {number} i.kbMax     本会话见过的最大键盘高度
 * @returns {{ok:boolean, zoomed:boolean, kb:number, kbb:number, vph:number,
 *            bars:number, visBottom:number, kbMax:number, panel:number, src:string}}
 */
export function computeViewportVars(i = {}) {
  const inner = Math.round(pos(i.inner));
  const out = {
    ok: false, zoomed: false, kb: 0, kbb: 0, vph: inner,
    bars: 0, visBottom: inner, kbMax: Math.round(pos(i.kbMax)), panel: 0, src: "none",
  };
  if (!(inner > 0)) return out;

  /* 双指放大也会缩可视视口，但那不是键盘：缩放态一律按「没有键盘、没有 UI 遮挡」处理。 */
  const zoomed = pos(i.scale) > 1.05;
  const vh = zoomed ? 0 : Math.round(pos(i.vvH));
  const vt = zoomed ? 0 : Math.round(pos(i.vvT));
  let restH = Math.round(pos(i.restH));
  if (!(restH > 0)) restH = inner;

  /* ── ① 真实可视高（浏览器 UI 占用之后那一条线）──
   *
   * **dvh 优先，不是取 min**（轮 508 改）。
   * 上一版取 min(svh, dvh) 有个致命问题：iOS 26 上顶部/底部玻璃栏收起后，
   * dvh 会长到大视口，而 svh 永远是那个保守小值 —— 取 min 就等于永远按「栏杆全展开」
   * 算，吸底条在大视口态被凭空抬高 80px（悬在半空）。
   * 反过来，X 内置浏览器把 svh 报成 lvh（实测 737 vs 691），svh 也是错的。
   * 实测下来只有 dvh 在各家都等于「此刻真正能看见多高」，所以它有就用它，
   * 量不出来才退回 svh，再不行退回 innerHeight（老内核，行为与改动前一致）。 */
  const dv = Math.round(pos(i.dvh));
  const sv = Math.round(pos(i.svh));
  let vph = inner;
  let src = "inner";
  /* 缩放态：页面被手指撑大，视口单位全是缩放后的数，拿它算让位会把吸底条弹到半空。
     历史上这里就是「缩放一律按没有键盘处理」，保持。 */
  if (zoomed) {
    return { ...out, ok: true, zoomed: true, vph: inner, visBottom: inner, src: "zoom", kbMax: out.kbMax };
  }
  if (probeOk(dv, inner)) { vph = dv; src = "dvh"; }
  else if (probeOk(sv, inner)) { vph = sv; src = "svh"; }
  /* 轮 509 · 探针也要跟 visualViewport 对一下，谁报出浏览器 UI 就信谁。
   *
   * 真机视频定案：表情面板最后一排被 Safari 工具栏压住，而探针当时报的是整屏 ——
   * 也就是说这版 Safari 的 100dvh / 100svh 都不扣工具栏，光靠探针永远看不见它。
   * 反过来 ios26 那类版本只有探针对、vv 也缩。所以两边都听，取**更小的可视高**
   * （= 让位更多的那一个）。
   *
   * vv 这一路要过 UI_MIN 闸门：小米无键盘时 vv 就矮 31px，那不浏览器 UI，是噪声。 */
  if (vh > 0 && vh < vph && inner - vh >= UI_MIN) {
    vph = vh;
    src = src === "inner" ? "vv" : src + "+vv";
  }

  /* ── ② 浏览器 UI 遮挡基线 ──
   *
   * 「布局视口底」和「可视视口底」之间那一段，在没有键盘时**全部**是浏览器 UI：
   *   iOS 26 的两条玻璃栏、iOS 15–18 的底部工具栏、小米那 31px、X 的控制条……
   * 把这段量下来当基线，键盘高度就能从同一个差里减出来 —— 这是本文件的核心一步：
   *
   *     键盘高 = (inner − vv.height) − 无键盘时的 (inner − vv.height)
   *
   * 上一版直接拿 inner − vv.height 当键盘高，等于把浏览器 UI 也算进键盘里：
   * iOS 26 上无键盘就有 80~100px 的差，横屏更大，一过 120 的闸门就被当成键盘 ——
   * 面板按 100 多像素开、吸底条被顶上去，而用户根本没在打字。
   *
   * 基线**取见过的最大值**（与 restH 同理）：Safari 的栏会随滚动收起又展开，
   * 取最大才能保证「键盘高 = 差 − 基线」不会因为栏刚收起一次就多算几十像素。
   */
  let bars = i.barsBase >= 0 ? Math.round(pos(i.barsBase)) : -1;
  const raw = vh > 0 ? inner - vh : 0;      /* 布局视口底 → 可视视口底 的原始差 */
  if (raw <= 0) bars = 0;
  else if (raw <= CHROME_UI_MAX) bars = Math.max(bars, raw);
  if (bars < 0) bars = 0;

  /* ── ③ 键盘本体高度 ── */
  let kb = raw >= KB_MIN ? raw - bars : 0;
  /* 缩布局视口型内核（Chromium / 小米）：窗口自己缩了，raw 只剩一点或为 0，
   * 只能拿「无键盘基线 − 当前 innerHeight」反推。 */
  if (!(kb >= KB_MIN)) {
    const shrink = restH - inner;
    if (shrink >= KB_MIN) kb = shrink;
  }
  /* 比例上限必须拿**键盘弹出前的视口高**（restH）比，不能拿缩小后的 inner：
   * 横屏 iPhone 视口 393、键盘 209，而键盘一弹 inner 就只剩 184 —— 拿 184 比
   * 209 必然超过七成，键盘态被整段丢弃，面板高度归零（矩阵在 land-852x393 抓到的）。
   * 同一台机竖屏没这问题，所以只测一台永远看不到。 */
  const refH = restH > 0 ? restH : inner;
  if (!(kb >= KB_MIN) || kb > refH * KB_MAX_RATIO) kb = 0;

  /* ── ④ 吸底条 / 表情面板该离布局视口底多远（--kbb）──
   *
   * ⚠️ 轮 509 修的真 bug（八轮没修对的那个）：
   *   上一版写的是「可视底 = offsetTop + vv.height」。看着合理，实际在 iOS 上**必然**
   *   算成 0 —— 因为 iOS 为了让光标露出来，会把可视视口整体**上推**，
   *   上推量正好是键盘高：offsetTop ≈ kb，而 offsetTop + vv.height ≈ innerHeight。
   *   于是 visBottom ≈ inner → kbb = 0 → 输入条一动不动、表情面板整块留在键盘底下
   *   （用户视频里「只露两排」就是这个数）。
   *
   *   而且这个错犯得很隐蔽：我的跨版本矩阵里 7 个内核模型的 offsetTop 全是 0，
   *   专门改了分支却从没测过 vt ≠ 0。补上 ios-pan / ios26-pan 两个模型后立刻 34 条红。
   *
   * 真正的语义只有一句：**键盘是从布局视口底往上吃掉 kb 像素的那一整条**。
   *   · overlay 型（iOS）：inner 不动，键盘实打实占住底部 raw = inner − vv.height 像素
   *     （raw 里包含玻璃栏/工具栏那一段，因为它也在底部）。让位量就是 raw 本身。
   *     offsetTop 表示的是"可视视口被推到哪儿"，与"底部被吃掉多少"无关，不该参与减法。
   *   · resize 型（Chromium / 小米）：窗口自己被键盘缩了，布局视口底就是可见底 → 让位 0。
   *   · 无键盘：底部只有浏览器 UI，只有 svh/dvh 探针知道它多高；探针量不出来就不让位
   *     （小米那 31px 是内核重复扣的噪声，信它会平白把条抬起 31px）。
   */
  const shrunk = restH > 0 && restH - inner >= KB_MIN;   /* 窗口真的被键盘缩了 */
  let kbb = 0;
  if (shrunk) {
    /* 布局视口已缩好，可见底就是布局视口底，不用再让位。 */
    kbb = 0;
  } else if (kb > 0 || vt > 0) {
    /* 键盘态 / 可视视口被上推：可见底 = offsetTop + vv.height。
     *
     * 这里**必须**加上 offsetTop —— 轮 509 我一度以为"上推时 offsetTop ≈ 键盘高，
     * 减出来是 0 所以是 bug"，就把 offsetTop 删了，结果 kb-matrix 当场红了 4 条
     * （ios-safari-pushed：条比可见底高出 24px，悬在半空）。
     *
     * 为什么 0 反而是对的：iOS 把可视视口整体下移 offsetTop 后，布局坐标 y=inner
     * 那一行**渲染在屏幕上 offsetTop 高度的位置**，也就是正好键盘上沿。
     * 此时条写 bottom:0 落到布局视口底 = 屏幕上就是键盘上沿，本来就该停在那儿。
     * 再减一次键盘高，等于把条抬到键盘上方一整个键盘的位置。
     *
     * 也就是说"上推量 ≈ 键盘高 → kbb≈0"不是失效，而是**正确的零让位**：
     * 浏览器已经用平移替我们把位置摆好了，我们只补它没摆的那部分。 */
    const vis = vt + (vh > 0 ? vh : inner);
    kbb = vis < inner ? inner - vis : 0;
  } else {
    /* ── 无键盘：底部被浏览器 UI（Safari 工具栏 / iOS 26 玻璃栏）占掉多少 ──
     *
     * 轮 509 真机视频定案：表情面板最后一排被 Safari 工具栏压住 = 这里算成了 0。
     * 病根是只信 svh/dvh 探针，而那版 Safari 把两者都报成整屏，探针根本看不见工具栏。
     * 现在 vph 已经把 visualViewport 也并进来（见 ① 末尾），这里直接照用：
     * 谁报出了 UI 遮挡，vph 就是谁的值，kbb 自然对。 */
    kbb = vph > 0 && vph < inner - 2 ? inner - vph : 0;
  }
  if (kbb < 0) kbb = 0;
  const visBottom = inner - kbb;

  /* ── ⑤ 表情面板该多高（--kb-last）──
   *
   * 目标只有一个：**开面板时输入行不许上下跳**。
   *
   *   键盘态：条底 = inner − kbb，输入行贴在「键盘上沿（含浮在键盘上的玻璃栏）」。
   *   面板态：键盘收起，kbb 掉回「只有玻璃栏」那个小值；
   *           条底 = inner − kbbₚ，再被 padding-bottom: 面板高 顶上去，
   *           输入行 = inner − kbbₚ − 面板高。
   *
   * 令两者相等：面板高 = kbb − kbbₚ = (栏 + 键盘) − 栏 = **键盘本体高** = kb。
   * 取 kbb 会多算一条玻璃栏（iOS 26 上 81px，一开面板输入条就往下跳一截）——
   * 用户反复说的「表情框跟输入框高度不一致」，一半是这个数。
   */
  const panelNow = kb;
  const kbMax = Math.max(Math.round(pos(i.kbMax)), panelNow);

  return {
    ok: true,
    zoomed,
    kb,
    kbb,
    vph,
    bars,
    visBottom,
    kbMax,
    panel: kbMax || 0,
    src,
  };
}
