/* ═══ iOS · 「表情面板 / 系统键盘」互斥守卫 · 轮 536 ═══
 *
 * 用户 2026-11-15 两张截图（iPhone，都在部署之后）：
 *   暖心墙「点击键盘-表情-键盘，第三次切换键盘的时候变成这样了」—— emoji 格子与键盘同时
 *   在屏上，输入行被整块盖掉，看不到了；
 *   会话「多次点击跟输入之后成这样了」—— 输入行浮在屏幕中段，下面一大片空白。
 *
 * 两次都不是「某个像素算错」，是**两个本该互斥的状态叠在了一起**：面板还开着，键盘也上来了。
 *
 * 为什么会叠（工装 tools/_tour-probe.mjs 逐帧抓到的）：
 *   交接流程全是「等键盘盖上来再收面板」，而 iOS 的键盘可能
 *     · 根本不来（焦点被吞）—— 轮 535 在暖心墙上故意「不来就不收」，于是永远不收；
 *     · 来得很晚（blur → focus 要等收起动画走完，实测 600~900ms，正好跨过 40 帧的窗口）；
 *     · 起来了但不是满高（短键盘 / 只有候选栏）。
 *   任何一次「等」错过窗口，面板就留在原地等一个**已经在它下面**的键盘。
 *
 * 所以这里不再加第三种等待，而是**取消「等」这件事**：面板开着的时候逐帧盯着键盘，
 * 只要键盘真的在屏上（升满，或者升到某个高度后不再变），就无条件让位。
 * 时序怎么乱 —— 连点两次、焦点被吞、键盘迟到 900ms —— 最后都收敛到
 * 「要么面板、要么键盘」，不会两个都在。
 *
 * 三条边界，缺一条都会把面板误收：
 *   ① **只认「升」**：键盘值往上长过，才认定用户要键盘。打开面板时我们在同一个手势栈里
 *      blur，键盘只会往下走 —— 那一段（250ms）绝不会被这条误伤；
 *   ② **只认「停稳」**：还在升的时候不动手，否则面板会在键盘升到一半时消失，
 *      露出底下那条会跳的空白（轮 524 花了整轮才消掉的「一闪」）；
 *   ③ 读 window.__wpVars（viewportVars / iosKb 每帧算好的快照），
 *      不读 getComputedStyle —— 这段跑在键盘动画里，强制重排会把弹出打断。
 *
 * 非 iOS 自动空转：判据是 __wpVars.engine === "ios"，安卓那套状态机一个字都不碰。
 *
 * ═══ 轮 537 · 这台设备推翻了上面「键盘只会 overlay」的前提 ═══
 * 用户三张 ?kbdiag=1 照片：键盘明明在屏上，`--kb-now` 却是 0px（innerHeight 也从
 * 549 缩到 422 —— 线上 viewport 声明了 interactive-widget=resizes-content，这版内核照做了）。
 * 于是「kbNow > 12 才算键盘」这条判据在这台机器上永远为假：面板永远不交班（表情压着键盘），
 * 点键盘键也永远等不到「键盘上来」（点了没反应）。
 * 改成读 __wpVars 的 `kbOn` / `shrink`（iosKb.js 轮 537 补的第二条信号），
 * 两种语义都能认出键盘；像素算式那边一律不动（resize 型的页面已经被浏览器缩好了）。
 */

const RISE_EPS = 1;      /* 一帧涨超过它才算「在升」（读数抖动都在 1px 以内） */
const SETTLE_FRAMES = 6; /* 高度连续这么多帧不变 = 停稳（≈100ms） */
const KB_MIN = 12;       /* 低于它就是「没键盘」（工具栏那一截不算） */
const CAP_MS = 3000;     /* 守卫最长存活时间：3 秒还等不到就收工，不留常驻 rAF */

/* 轮 537 · 键盘此刻「在屏上」有多深。两种语义各一条，取大者：
 *   overlay 型（经典 iOS Safari）：kbNow = inner − vvH
 *   resize 型（本机：viewport 声明了 resizes-content，内核照做了）：shrink = 基线 − inner
 * 只用来**判断状态**，不参与任何像素算式 —— 让位那边仍然只吃 --kb-now，
 * 否则 resize 型会被双算一次（页面已经被浏览器缩好了）。 */
function depthOf(v) {
  const kbNow = Math.max(0, Number(v.kbNow) || 0);
  const shrink = Math.max(0, Number(v.shrink) || 0);
  return Math.round(Math.max(kbNow, shrink));
}

/**
 * 面板开着的时候调用，返回 stop()。
 * @param {() => void} onYield 键盘真的起来了 —— 调用方负责把面板收掉
 * @param {{expect?: "rise"|"up"}} [opts]
 *   rise（默认）：等键盘**升上来**才让位。用在「面板刚打开」那一刻 ——
 *     那时键盘只会往下走（我们 blur 掉了），不能把「开局就有键盘」当成用户要键盘。
 *   up：调用方已经知道用户要键盘（他刚点了键盘键）。此时键盘可能**早就在屏上**
 *     （上一轮没收拾干净 / 焦点本来就在），没有「升」可等 —— 直接按停稳处理，
 *     否则这一个永远等不到上升的守卫会把界面卡死在「点了没反应」。
 */
export function startPanelKbGuard(onYield, opts) {
  const noop = () => {};
  if (typeof window === "undefined" || typeof requestAnimationFrame !== "function") return noop;
  const wv = window.__wpVars;
  if (!wv || wv.engine !== "ios") return noop;
  const expect = (opts && opts.expect) === "up" ? "up" : "rise";

  let raf = 0;
  let stopped = false;
  let prev = -1;
  let stable = 0;
  let armed = false;      /* 认定「用户要键盘」—— 之后只看它停没停稳 */
  const started = Date.now();

  const stop = () => {
    stopped = true;
    if (raf) { try { cancelAnimationFrame(raf); } catch (e) { /* 忽略 */ } raf = 0; }
  };

  const tick = () => {
    raf = 0;
    if (stopped) return;
    const v = window.__wpVars;
    if (!v || v.engine !== "ios") { stop(); return; }
    const kb = depthOf(v);
    const panel = Math.round(v.panel || 0) || 320;

    /* 第一帧只取基线。**不能**把「开局就有键盘」当成「在升」——
     * 点表情那一刻键盘本来就还开着（随后才收），那样会在 100ms 后把刚打开的面板收掉
     * （用户看到的就是「点表情没反应」）。
     * 但 expect=up 时相反：那一刻键盘在屏上就是用户要的结果，直接认。*/
    if (prev < 0) {
      prev = kb;
      if (expect === "up" && kb > KB_MIN) armed = true;
      stable = 0;
      raf = requestAnimationFrame(tick);
      return;
    }

    if (kb > KB_MIN) {
      if (kb > prev + RISE_EPS) { armed = true; stable = 0; }
      else if (kb < prev - RISE_EPS) { stable = 0; }   /* 还在降 —— 不是「停稳」 */
      else { stable += 1; }
      prev = kb;
      /* 升满，或升到某个高度后不再变（短键盘 / 只起了候选栏）—— 都算「键盘在屏上」 */
      if (armed && (kb >= panel - 6 || stable >= SETTLE_FRAMES)) {
        stop();
        try { onYield(); } catch (e) { /* 调用方自己兜 */ }
        return;
      }
    } else {
      prev = kb;
      stable = 0;
    }

    if (Date.now() - started > CAP_MS) { stop(); return; }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return stop;
}
