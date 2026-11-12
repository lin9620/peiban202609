/* ═══ 轮 513 · 闭环校正（--kbb-fix）纯函数验证 ═══
 *
 * 用户第九次报 iOS 表情面板/输入条位置不对。前八轮全都在调「推导」的参数，
 * 这次改成「量出误差再补回去」。这个测试就是那条闭环的数学模型：
 *
 *   页面高 = inner − (kbb + fix)      ← 会话页 / 暖心墙两种消费者在布局坐标里同构
 *   可视区底 = vv.offsetTop + vv.height（布局坐标）
 *   误差    = 可视区底 − 元素底边
 *   补正    = −误差（--kbb 越大元素越往上）
 *
 * 断言的重点不是「算得对」，而是：**哪怕浏览器把 --kbb 报成 0（错的最坏情况），
 * 几帧之后元素也会落在可视区底边上**。这正是 iOS 那一堆机器上发生的错法。
 */
import assert from "node:assert/strict";
import { pinDelta } from "../src/utils/bottomPin.js";
import { computeViewportVars } from "../src/utils/viewportMath.js";

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { fail++; console.log("FAIL " + name + "\n     " + e.message); }
};
const near = (a, b, tol = 2) => assert.ok(Math.abs(a - b) <= tol, `${a} ≠ ${b}（容差 ${tol}）`);

/* 一帧一帧地跑闭环，返回收敛过程。
 * 注意这里连「同一个误差连着两帧才动手」的稳定性闸门一起模拟了 ——
 * 实现在动画过渡态里就是靠它不去追每帧都在变的 rect。 */
function converge({ inner, vvT, vvH, kbb, frames = 10 }) {
  const visBottom = vvT + vvH;
  let fix = 0;
  let lastErr = null;
  let nudges = 0;
  const hist = [];
  for (let i = 0; i < frames; i++) {
    const pageH = inner - (kbb + fix);          /* 页面盒子高（布局坐标下底边 = 这个值） */
    const elBottom = pageH;                     /* 页面盒子从 0 开始，底边 = 高 */
    const err = visBottom - elBottom;
    const d = pinDelta(visBottom, elBottom);
    hist.push({ elBottom, err, fix, d });
    if (!d) { lastErr = null; break; }
    const stable = lastErr !== null && Math.abs(err - lastErr) <= 1;
    lastErr = err;
    if (!stable) continue;
    fix += d;
    nudges++;
    if (Math.abs(fix) > 260) fix = Math.sign(fix) * 260;   /* 与模块里的 FIX_LIMIT 一致 */
    lastErr = null;
  }
  const pageH = inner - (kbb + fix);
  return { fix, bottom: pageH, visBottom, hist, nudges };
}

/* ── 1. 数字报得对：不该有任何补正 ───────────────────────────── */
t("P1 无键盘、kbb 报对（81）：不动", () => {
  const r = converge({ inner: 852, vvT: 0, vvH: 771, kbb: 81 });
  assert.equal(r.fix, 0, `不该补，实际补了 ${r.fix}`);
  near(r.bottom, 771);
});
t("P2 键盘上推、kbb=0 报对：不动", () => {
  const r = converge({ inner: 852, vvT: 330, vvH: 522, kbb: 0 });
  assert.equal(r.fix, 0, `不该补，实际补了 ${r.fix}`);
  near(r.bottom, 852);
});

/* ── 2. 数字报错：闭环必须把它拉回来（这批就是用户遇到的真机） ── */
t("P3 玻璃栏 81px 被漏掉（kbb 报 0，实际要 81）：补到对齐", () => {
  const r = converge({ inner: 852, vvT: 0, vvH: 771, kbb: 0 });
  near(r.bottom, 771);
  assert.ok(r.fix > 0, `应该往上补（正数），实际 ${r.fix}`);
  assert.ok(r.hist.length <= 4, `收敛太慢：${r.hist.length} 帧（稳定性闸门占 1 帧）`);
});
t("P4 键盘上推态但 kbb 还留着工具栏 81：也要拉回来", () => {
  /* iOS 上推后可视区底 = 852，页面若按 852−81=771 就悬空 81px */
  const r = converge({ inner: 852, vvT: 330, vvH: 522, kbb: 81 });
  near(r.bottom, 852);
  assert.ok(r.fix < 0, `应该往下补（负数），实际 ${r.fix}`);
});
t("P5 工具栏被高估（报 120，实际 81）：往下补回 39", () => {
  const r = converge({ inner: 852, vvT: 0, vvH: 771, kbb: 120 });
  near(r.bottom, 771);
  near(r.fix, -39, 3);
});
t("P6 键盘动画中途（offsetTop=120、vvH=702）：逐帧都能跟上", () => {
  const r = converge({ inner: 852, vvT: 120, vvH: 702, kbb: 0 });
  near(r.bottom, 822);
});
t("P7 屏高 932 的大机（Pro Max）+ 34px 手势条", () => {
  const r = converge({ inner: 932, vvT: 0, vvH: 863, kbb: 0 });
  near(r.bottom, 863);
});

/* ── 3. 护栏：不许无限推 ───────────────────────────────────── */
t("P8 离谱误差（kbb 报成 -500）补正量必须被夹在 ±260 内", () => {
  const r = converge({ inner: 852, vvT: 0, vvH: 771, kbb: -500, frames: 12 });
  assert.ok(Math.abs(r.fix) <= 260, `补正量越界：${r.fix}`);
  assert.ok(r.nudges <= 6, `夹住后还在反复推：${r.nudges} 次`);
});
t("P9 已对齐（≤2px 噪声）时不做任何改动", () => {
  assert.equal(pinDelta(771, 771), 0);
  assert.equal(pinDelta(771, 770), 0, "1px 噪声不该补");
  assert.equal(pinDelta(771, 768), -3, "3px 偏低要往上补 3");
});

/* ── 4. 与 viewportMath 的接口对齐 ─────────────────────────── */
t("P10 玻璃栏机型：computeViewportVars 给的 kbb 正好等于可视区底的缺口", () => {
  /* iPhone 15 Pro：inner 852、vv 771、svh/dvh 都被报成 852（big viewport 误报） */
  const r = computeViewportVars({
    inner: 852, vvH: 771, vvT: 0, scale: 1,
    svh: 852, dvh: 852, restH: 852, barsBase: -1, kbMax: 0,
  });
  assert.equal(r.ok, true);
  assert.equal(r.kbb, 81, `kbb 应为工具栏高 81，实际 ${r.kbb}（src=${r.src}）`);
  /* 报对的情况下闭环不该动它 */
  assert.equal(pinDelta(771, 852 - r.kbb), 0);
});
t("P11 同上但内核把 dvh 报成 737（X 内置浏览器那种错）：闭环兜住", () => {
  const r = computeViewportVars({
    inner: 852, vvH: 771, vvT: 0, scale: 1,
    svh: 737, dvh: 737, restH: 852, barsBase: -1, kbMax: 0,
  });
  const conv = converge({ inner: 852, vvT: 0, vvH: 771, kbb: r.kbb });
  near(conv.bottom, 771, 3);
});

console.log(`\n闭环校正：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
