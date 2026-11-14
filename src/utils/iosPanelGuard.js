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
 */

const RISE_EPS = 1;      /* 一帧涨超过它才算「在升」（读数抖动都在 1px 以内） */
const SETTLE_FRAMES = 6; /* 高度连续这么多帧不变 = 停稳（≈100ms） */
const KB_MIN = 12;       /* 低于它就是「没键盘」（工具栏那一截不算） */
const CAP_MS = 3000;     /* 守卫最长存活时间：3 秒还等不到就收工，不留常驻 rAF */

/**
 * 面板开着的时候调用，返回 stop()。
 * @param {() => void} onYield 键盘真的起来了 —— 调用方负责把面板收掉
 */
export function startPanelKbGuard(onYield) {
  const noop = () => {};
  if (typeof window === "undefined" || typeof requestAnimationFrame !== "function") return noop;
  const wv = window.__wpVars;
  if (!wv || wv.engine !== "ios") return noop;

  let raf = 0;
  let stopped = false;
  let prev = -1;
  let stable = 0;
  let armed = false;      /* 见过键盘往上长 —— 用户要的是键盘 */
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
    const kb = Math.max(0, Math.round(v.kbNow || 0));
    const panel = Math.round(v.panel || 0) || 320;

    /* 第一帧只取基线。**不能**把「开局就有键盘」当成「在升」——
     * 点表情那一刻键盘本来就还开着（随后才收），那样会在 100ms 后把刚打开的面板收掉
     * （用户看到的就是「点表情没反应」）。*/
    if (prev < 0) {
      prev = kb;
      stable = 0;
      raf = requestAnimationFrame(tick);
      return;
    }

    if (kb > KB_MIN) {
      if (kb > prev + RISE_EPS) { armed = true; stable = 0; } else { stable += 1; }
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
