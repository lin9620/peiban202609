/* ═══ 轮 513 · 可视区底部的**闭环**校正 ═══
 *
 * 用户第九次报同一件事（14 秒拍屏视频 + 「苹果的你到底能不能做好」）。前八轮全是
 * **开环**：拿浏览器上报的数字推导「可视区底在哪」——
 *
 *     --kbb = innerHeight − (visualViewport.offsetTop + visualViewport.height)
 *     页面高 = --vlh − --kbb     吸底条 bottom = --kbb     面板 bottom = --kbb
 *
 * 这条链要求每一台机器上报的四个数字**全部正确**。而实际情况是：
 *   · iOS 26 玻璃栏：inner 含两条栏，vv 也含；
 *   · X/微博内置：100svh 被报成 100lvh；
 *   · 小米浏览器：无键盘时 vv 就比 inner 矮 31px；
 *   · 上推态：offsetTop ≈ 键盘高，--kbb 反而从 81 掉到 0。
 * 每一台机器错的方式都不一样，于是「我这台好了、他那台还是沉的」反复发生。
 *
 * 这一版不再推导位置，而是**量**：
 *   找那个「本该贴在可视区底边」的元素（会话页 = 页面盒子，暖心墙 = 评论条），
 *   直接算它离可视区底还差多少（err），差多少就往回推多少（补进 --kbb）。
 *   推完下一帧再量一次 —— 位置与 --kbb 是线性关系，一两次就收敛。
 *
 * 为什么这样可以收敛而不会打架：
 *   · 误差与 --kbb 一一线性对应（改 1px，元素就动 1px），所以 err 直接就是修正量；
 *   · 只在 overlay 型（iOS：布局视口不缩）上跑，安卓/小米走原来的 resize 那套；
 *   · 收敛后 |err| ≤ 2px 就停手，不会每帧抖。
 *
 * 于是不管哪台机器把数字报成什么样，元素最终都落在可视区底边上 —— 表情面板沉到屏幕外
 * 这一类问题在**结构上**不再可能发生，而不是又调了一次阈值。
 */

import { nudgeKbbFix, resetKbbFix } from "./viewportVars.js";

const TOLERANCE = 2;      /* ≤2px 认为已对齐（亚像素/取整噪声） */
const MAX_STEP = 8;       /* 一次 burst 最多推 8 次（正常情况下 1~2 次就收敛） */
const BURST_MS = 420;     /* 键盘/工具栏动画的采样窗口 */

let getEl = null;
let steps = 0;
let lastErr = null;
let raf = 0;
let until = 0;
let hb = 0;
let onResize = null;
let onScroll = null;
let onFocusIn = null;
let onFocusOut = null;
const now = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());

const isOverlay = () => {
  try { return document.documentElement.classList.contains("kb-overlay"); } catch (e) { return false; }
};

function isNative() {
  const c = typeof window !== "undefined" ? window.Capacitor : null;
  if (c && typeof c.isNativePlatform === "function") {
    try { if (c.isNativePlatform()) return true; } catch (e) { /* 继续看类名 */ }
  }
  return !!document.documentElement && document.documentElement.classList.contains("cap-app");
}

/** 纯函数：这次该往 --kbb 里补多少（0 = 已经对齐）。
 *  --kbb 越大元素越往上（页面高 = inner − kbb；吸底条 bottom = kbb），
 *  所以「元素偏低」要补正数，「元素偏高」要补负数 —— 就是 -err。 */
export function pinDelta(visBottom, elBottom) {
  const err = Math.round(visBottom) - Math.round(elBottom);
  if (!isFinite(err)) return 0;
  return Math.abs(err) <= TOLERANCE ? 0 : -err;
}

/** 量一次：把误差推回 --kbb。返回本次误差（诊断用）。 */
function tick() {
  if (!getEl || isNative() || !isOverlay()) return 0;
  const el = getEl();
  if (!el || !el.getBoundingClientRect) return 0;
  const vv = window.visualViewport;
  if (!vv || !(vv.height > 0)) return 0;
  const r = el.getBoundingClientRect();
  if (!(r.height > 0)) return 0;                 /* 元素不在屏上（切页/折叠）就别推 */
  /* 两个数都在**布局视口坐标系**里：rect 是布局坐标，vv.offsetTop 是可视区相对布局视口
     的上移量 —— 相加就是「可视区底边在布局坐标里的位置」。上推与否都成立。 */
  const visBottom = Math.round((vv.offsetTop || 0) + vv.height);
  const err = visBottom - Math.round(r.bottom);
  const d = pinDelta(visBottom, r.bottom);
  if (!d) { lastErr = null; return err; }
  if (steps >= MAX_STEP) return err;
  /* 稳定性闸门：同一个误差**连着两帧**才动手。
   * 理由：页面切换动画、键盘动画中途 rect 每帧都在变，那些都是过渡态，
   * 去追它反而会把元素往错的方向推；只有「落定了还是错」才是真的报错了数字。 */
  const stable = lastErr !== null && Math.abs(err - lastErr) <= 1;
  lastErr = err;
  if (!stable) return err;
  steps++;
  /* 符号：--kbb 越大，元素越**往上**（页面高 = inner − kbb，底边 bottom = kbb）。
     元素比目标低（err < 0）就要往上挪，即 kbb 变大 → 补 -err。
     页面高（inner − kbb）与吸底条（bottom: kbb）两个消费者方向相反，但都吃同一个数，
     这条式子对两边同时成立。 */
  nudgeKbbFix(d);
  lastErr = null;          /* 推完重新判一遍，别拿旧误差当基线 */
  return err;
}

/* 键盘起落是分几步动画走的，逐帧采一小段最稳（只读 rect，代价很小） */
function sample(ms) {
  if (typeof requestAnimationFrame !== "function") { tick(); return; }
  /* 新的外力（键盘/工具栏/焦点变化）来了就重置次数，否则上面那个 MAX_STEP 会让
     后面几次真实的错位修不动 */
  steps = 0;
  until = Math.max(until, now() + ms);
  if (raf) return;
  const loop = () => {
    tick();
    if (now() < until) { raf = requestAnimationFrame(loop); } else { raf = 0; }
  };
  raf = requestAnimationFrame(loop);
}

/**
 * 开始盯住某个元素（返回 null 表示当前不适合校正）。
 * @param {() => Element|null} resolver 每次采样时现取，切页/重建后自动跟到新节点
 */
export function startBottomPin(resolver) {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (typeof resolver !== "function") return;
  if (getEl) stopBottomPin();
  getEl = resolver;
  steps = 0;
  resetKbbFix();

  const vv = window.visualViewport;
  onResize = () => sample(BURST_MS);
  onScroll = () => sample(160);
  onFocusIn = () => sample(900);
  onFocusOut = () => sample(BURST_MS);
  try {
    if (vv && typeof vv.addEventListener === "function") {
      vv.addEventListener("resize", onResize);
      vv.addEventListener("scroll", onScroll);
    }
    window.addEventListener("resize", onResize, { passive: true });
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
  } catch (e) { /* 忽略 */ }
  /* 先把当前这一帧摆正，再开窗（进会话首帧就是对的，不用等用户动键盘） */
  tick();
  sample(BURST_MS);
  /* 心跳：只在事件上采样是不够的 —— 有些内核（安卓 WebView、部分省电模式）根本不派发
     visualViewport 事件，而「数字一直错着」这种状态在静止时正好没有事件可等。
     400ms 一次、每次只读一个 rect，代价可以忽略；读到对齐就什么都不做。 */
  hb = setInterval(() => { steps = 0; sample(120); }, 400);
}

export function stopBottomPin() {
  getEl = null;
  if (hb) { try { clearInterval(hb); } catch (e) { /* 忽略 */ } hb = 0; }
  if (raf) { try { cancelAnimationFrame(raf); } catch (e) { /* 忽略 */ } raf = 0; }
  until = 0;
  steps = 0;
  lastErr = null;
  const vv = window.visualViewport;
  try {
    if (vv && typeof vv.removeEventListener === "function") {
      vv.removeEventListener("resize", onResize);
      vv.removeEventListener("scroll", onScroll);
    }
    window.removeEventListener("resize", onResize);
    document.removeEventListener("focusin", onFocusIn, true);
    document.removeEventListener("focusout", onFocusOut, true);
  } catch (e) { /* 忽略 */ }
  onResize = onScroll = onFocusIn = onFocusOut = null;
  /* 页面自己的误差不带给下一页 */
  resetKbbFix();
}

/** 手动催一次（面板开合、发送失败补一行之后都可以叫它）。 */
export function pokeBottomPin() {
  if (!getEl) return;
  steps = 0;
  tick();
  sample(240);
}
