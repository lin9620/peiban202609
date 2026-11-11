/* 跨版本 / 跨机型视口矩阵（Node 直跑：node tools/viewport-matrix-test.mjs）
 * ------------------------------------------------------------
 * 轮 508。用户原话：「你不要只看我这台手机的，别的苹果手机浏览器呢」。
 *
 * 前七轮（496~507）全是「拿一台真机量出数字 → 照那个数字调判据」。可 iOS 各版本上报的
 * 视口语义根本不是一回事，同一份代码换台机就换一种错法，所以才会「改好了又坏了」。
 *
 * 这里不去追任何一台机的数字，而是把**各家上报的读数**当输入，断言几条不变量：
 *   V1 没键盘时 kb 必须为 0 —— 浏览器 UI 的遮挡绝不能被当成键盘（面板会凭空弹出）
 *   V2 没键盘时 kbb 不能超过浏览器 UI 的量级 —— 吸底条不许悬空
 *   V3 有键盘时 kb ≈ 真键盘高（±25）—— 表情面板高度才对得上输入框
 *   V4 有键盘时 kbb ≈ UI 遮挡 + 键盘高 —— 吸底条贴在键盘上沿，不压不悬
 *   V5 收起键盘后必须完全回到无键盘态（基线不许被键盘污染）
 *   V6 双指放大时不许有任何让位（缩放不是键盘）
 *   V7 同一模型换尺寸 / 换机型，结论一致（不是只对 393×852 成立）
 *
 * 覆盖的语义（每一行都是实际存在的内核，不是假想）：
 *   ios15-18   inner == vv == 小视口；键盘只缩 vv
 *   ios26      inner == **大视口**（含两条玻璃栏）、键盘弹起也不变；vv == 小视口
 *   ios26-nodvh dvh 不随键盘缩（部分版本实测如此）—— 键盘态只能听 vv
 *   x-inapp    X / 微博 内置浏览器：100svh 被报成 100lvh（错的），dvh 才对
 *   miui       小米浏览器：无键盘时 vv 少 31px（工具栏被重复扣），窗口自己缩
 *   chromium   Chromium Android (resizes-content)：三者一起缩
 *   legacy     老内核：没有 visualViewport、也不认 dvh/svh
 *
 * 纯 Node，无 DOM、无网络。
 */
import assert from "node:assert/strict";
import { computeViewportVars, KB_MIN, CHROME_UI_MAX } from "../src/utils/viewportMath.js";

let pass = 0;
let fail = 0;
const out = [];
const t = (name, fn) => {
  try { fn(); pass++; out.push("ok   " + name); }
  catch (e) { fail++; out.push("FAIL " + name + " :: " + e.message); }
};

/* ══════════ 机型表（CSS px）══════════
 * vp    = 视口高（无浏览器 UI 遮挡时 innerHeight 的值）
 * bar   = 该机上「浏览器 UI 浮在页面上」遮挡的高度（iOS 26 玻璃栏 / X 控制条）
 * kb    = 竖屏中文输入法实际高度（真机量级）
 */
const DEVICES = [
  { id: "se3-375x667", vp: 667, bar: 62, kb: 260 },
  { id: "mini-375x812", vp: 812, bar: 74, kb: 291 },
  { id: "ip15-393x852", vp: 852, bar: 81, kb: 336 },
  { id: "ip16pm-440x956", vp: 956, bar: 88, kb: 346 },
  { id: "ipad-820x1180", vp: 1180, bar: 99, kb: 310 },
  { id: "land-852x393", vp: 393, bar: 58, kb: 209 },
  { id: "and-360x640", vp: 640, bar: 0, kb: 240 },
];

/* ══════════ 内核语义模型 ══════════
 * read(dev, phase) → 该状态下浏览器会上报的读数
 * phase: "closed" 无键盘 / "open" 键盘弹起 / "zoom" 双指放大（scale 2）
 */
const MODELS = [
  {
    id: "ios15-18", ov: true,
    desc: "iOS 15–18 Safari：inner 已是小视口，键盘只缩 vv",
    read: (d, ph) => ph === "closed"
      ? { inner: d.vp, vvH: d.vp, svh: d.vp, dvh: d.vp }
      : { inner: d.vp, vvH: d.vp - d.kb, svh: d.vp, dvh: d.vp - d.kb },
    expectBars: 0,          /* 工具栏已在 inner 里扣掉，不需要额外让位 */
  },
  {
    id: "ios26", ov: true,
    desc: "iOS 26 Safari：inner = 大视口（含玻璃栏）、键盘弹起也不变",
    read: (d, ph) => ph === "closed"
      ? { inner: d.vp, vvH: d.vp - d.bar, svh: d.vp - d.bar, dvh: d.vp - d.bar }
      : { inner: d.vp, vvH: d.vp - d.bar - d.kb, svh: d.vp - d.bar, dvh: d.vp - d.bar - d.kb },
    expectBars: "bar",
  },
  {
    id: "ios26-nodvh", ov: true,
    desc: "iOS 26（dvh 不随键盘缩）—— 键盘态只能听 vv",
    read: (d, ph) => ph === "closed"
      ? { inner: d.vp, vvH: d.vp - d.bar, svh: d.vp - d.bar, dvh: d.vp - d.bar }
      : { inner: d.vp, vvH: d.vp - d.bar - d.kb, svh: d.vp - d.bar, dvh: d.vp - d.bar },
    expectBars: "bar",
  },
  {
    /* 真机实测分支：iOS 为了让光标露出来，会把可视视口**整体上推**，
     * 于是 offsetTop ≈ 键盘高，而 offsetTop + vv.height ≈ innerHeight。
     * 这一支之前**一个模型都没覆盖**（全部 offsetTop = 0），
     * 而它正是「面板只露两排、输入条不抬」的真凶所在。 */
    id: "ios-pan", ov: true,
    desc: "iOS 15–18 + 可视视口上推：offsetTop ≈ 键盘高，offsetTop+vvH == inner",
    read: (d, ph) => ph === "closed"
      ? { inner: d.vp, vvH: d.vp, svh: d.vp, dvh: d.vp, vvT: 0 }
      : { inner: d.vp, vvH: d.vp - d.kb, svh: d.vp, dvh: d.vp - d.kb, vvT: d.kb },
    expectBars: 0,
  },
  {
    id: "ios26-pan", ov: true,
    desc: "iOS 26 + 上推：offsetTop ≈ 玻璃栏 + 键盘高",
    read: (d, ph) => ph === "closed"
      ? { inner: d.vp, vvH: d.vp - d.bar, svh: d.vp - d.bar, dvh: d.vp - d.bar, vvT: 0 }
      : { inner: d.vp, vvH: d.vp - d.bar - d.kb, svh: d.vp - d.bar, dvh: d.vp - d.bar - d.kb, vvT: d.bar + d.kb },
    expectBars: "bar",
  },
  {
    /* 真机视频定案的那一版（用户 iPhone，2026-11-12 视频）：
     * 100dvh / 100svh 都报**整屏**（等于 innerHeight），探针完全看不见底部工具栏；
     * 只有 visualViewport.height 知道工具栏还在。上一版只信探针 → 无键盘时 kbb=0
     * → 表情面板整块贴到布局视口底 → 最后一排被工具栏压住。 */
    id: "probe-blind", ov: true,
    desc: "探针报整屏、只有 vv 知道工具栏（用户真机那一版 Safari）",
    read: (d, ph) => ph === "closed"
      ? { inner: d.vp, vvH: d.vp - d.bar, svh: d.vp, dvh: d.vp, vvT: 0 }
      : { inner: d.vp, vvH: d.vp - d.bar - d.kb, svh: d.vp, dvh: d.vp, vvT: 0 },
    expectBars: "bar",
  },
  {
    id: "x-inapp", ov: true,
    desc: "X / 微博 内置浏览器：100svh 被报成 lvh（错），dvh 才对",
    read: (d, ph) => ph === "closed"
      ? { inner: d.vp, vvH: d.vp - d.bar, svh: d.vp, dvh: d.vp - d.bar }
      : { inner: d.vp, vvH: d.vp - d.bar - d.kb, svh: d.vp, dvh: d.vp - d.bar - d.kb },
    expectBars: "bar",
  },
  {
    id: "miui",
    desc: "小米浏览器：窗口自己缩 + 无键盘时 vv 少 31px（重复扣工具栏）",
    read: (d, ph) => ph === "closed"
      ? { inner: d.vp, vvH: d.vp - 31, svh: d.vp, dvh: d.vp }
      : { inner: d.vp - d.kb, vvH: d.vp - d.kb - 31, svh: d.vp - d.kb, dvh: d.vp - d.kb },
    expectBars: 0,          /* 那 31px 是噪声，不是真遮挡 → 不该让位 */
  },
  {
    id: "chromium",
    desc: "Chromium Android (resizes-content)：三者一起缩",
    read: (d, ph) => ph === "closed"
      ? { inner: d.vp, vvH: d.vp, svh: d.vp, dvh: d.vp }
      : { inner: d.vp - d.kb, vvH: d.vp - d.kb, svh: d.vp - d.kb, dvh: d.vp - d.kb },
    expectBars: 0,
  },
  {
    id: "legacy",
    desc: "老内核：没有 visualViewport，也不认 dvh/svh",
    read: (d, ph) => ph === "closed"
      ? { inner: d.vp, vvH: 0, svh: 0, dvh: 0 }
      : { inner: d.vp - d.kb, vvH: 0, svh: 0, dvh: 0 },
    expectBars: 0,
  },
];

/* ══════════ 会话状态机：closed → open → closed，跨步保留基线 ══════════ */
function session(model, dev) {
  const st = { restH: dev.vp, barsBase: -1, kbMax: 0 };
  const step = (ph) => {
    const rd = model.read(dev, ph);
    const r = computeViewportVars({
      ...rd, scale: ph === "zoom" ? 2 : 1, vvT: rd.vvT || 0,
      restH: st.restH, barsBase: st.barsBase, kbMax: st.kbMax,
    });
    if (!(r.kb > 0) && rd.inner > st.restH) st.restH = rd.inner;
    st.barsBase = r.bars;
    st.kbMax = r.kbMax;
    return r;
  };
  return { step, st };
}

const near = (a, b, tol) => Math.abs(a - b) <= tol;
const barsOf = (model, dev) => (model.expectBars === "bar" ? dev.bar : model.expectBars);

/* ══════════ 主循环：每个模型 × 每台机，跑完整会话 ══════════ */
for (const m of MODELS) {
  for (const d of DEVICES) {
    const { step } = session(m, d);
    const closed = step("closed");
    const open = step("open");
    const back = step("closed");
    const B = barsOf(m, d);
    const tag = `${m.id}@${d.id}`;
    const detail = (r) => `inner=${r.vph}/${r.bars}bars kb=${r.kb} kbb=${r.kbb} src=${r.src}`;

    t(`${tag} · V1 无键盘时 kb=0（UI 遮挡不许当键盘）`, () => {
      assert.equal(closed.kb, 0, `把浏览器 UI 当成键盘了：kb=${closed.kb}（${detail(closed)}）`);
    });

    t(`${tag} · V2 无键盘时 kbb 不超过 UI 量级`, () => {
      assert.ok(closed.kbb <= CHROME_UI_MAX, `吸底条被抬太远：kbb=${closed.kbb}（${detail(closed)}）`);
      assert.ok(closed.kbb >= 0, `kbb 不能为负：${closed.kbb}`);
    });

    t(`${tag} · V2b 有 UI 遮挡的机型，无键盘时 kbb 应等于该遮挡量`, () => {
      if (!B) return;                       /* ios15-18 / 安卓：没有额外遮挡，不用让位 */
      assert.ok(near(closed.kbb, B, 4), `应当让开 ${B}px，实际 ${closed.kbb}（${detail(closed)}）`);
    });

    t(`${tag} · V3 键盘态 kb ≈ 真键盘高（±25）`, () => {
      assert.ok(near(open.kb, d.kb, 25), `键盘高应≈${d.kb}，实际 ${open.kb}（${detail(open)}）`);
    });

    t(`${tag} · V4 键盘态：条的**屏幕**底边 = 可视视口底`, () => {
      /* 这一条是轮 509 重写的。原来断言 kbb 的绝对值，结果被 ios-pan 模型打脸 ——
       * 因为 kbb 是**布局坐标**，可视视口被上推时它本来就该变小甚至为 0，
       * 浏览器已经用平移把位置摆好了，我们只补它没摆的那部分。
       *
       * 唯一跟坐标无关、可以直接验的物理量是**屏幕坐标**：
       *   屏幕底边 = 布局底边 − offsetTop = inner − kbb − vt
       * 它必须等于此刻可视视口高（vh），也就是键盘上沿 / 工具栏上沿。
       * 残差 0 意味着条正好贴在键盘上，不压不悬。 */
      /* overlay 型：屏幕上能看见的底 = 可视视口底（vw 缩到键盘上沿）。
       * resize 型：窗口自己缩了，屏幕底就是 inner —— 小米那 31px 是**噪声**，
       *            信 vv 就等于要求条凭空多抬 31px（这正是历史反复复发的那个错）。 */
      const rd = m.read(d, "open");
      const want = m.ov ? (rd.vvH || rd.inner) : rd.inner;
      const got = rd.inner - open.kbb - (rd.vvT || 0);
      assert.ok(near(got, want, 2), `屏幕底边应 ${want}，实际 ${got}（${detail(open)}）`);
    });

    t(`${tag} · V4b 面板（bottom: --kbb）屏幕底边 = 可视视口底`, () => {
      /* 面板与条共用 --kbb，所以只要这一条成立，面板也一定落在键盘上沿。
       * 同上，验屏幕坐标而不是布局坐标。 */
      const rd = m.read(d, "open");
      const want = m.ov ? (rd.vvH || rd.inner) : rd.inner;
      const got = open.visBottom - (rd.vvT || 0);
      assert.ok(near(got, want, 2), `面板屏幕底应 ${want}，实际 ${got}`);
    });

    t(`${tag} · V5 收起键盘完全复原`, () => {
      assert.equal(back.kb, 0, `收键盘后 kb 没归零：${back.kb}`);
      assert.ok(near(back.kbb, closed.kbb, 2), `kbb 没复原：${closed.kbb} → ${back.kbb}`);
    });

    t(`${tag} · V7 面板高度 = 键盘本体高（输入条不许上下跳）`, () => {
      /* 推导：键盘态输入行底 = inner − kbb = inner − (栏 + 键盘)
       *       面板态输入行底 = inner − kbbₚ − 面板高 = inner − 栏 − 面板高
       *       两者相等 ⇒ 面板高 = 键盘本体高。
       * 取 kbb 会把玻璃栏多算一遍（iOS 26 上 81px），一开面板输入条就往下跳。 */
      const want = d.kb;
      assert.ok(near(open.panel, want, 25), `面板高应≈${want}，实际 ${open.panel}`);
    });
  }
}

/* ══════════ V6 双指放大：任何让位都不许有 ══════════ */
t("V6 双指放大（scale=2）不算键盘、不让位", () => {
  for (const d of DEVICES) {
    const r = computeViewportVars({
      inner: d.vp, vvH: Math.round(d.vp / 2), vvT: 0, scale: 2,
      svh: d.vp, dvh: Math.round(d.vp / 2), restH: d.vp, barsBase: -1, kbMax: 0,
    });
    assert.equal(r.kb, 0, `${d.id}: 缩放被当成键盘 kb=${r.kb}`);
    assert.ok(r.kbb <= CHROME_UI_MAX, `${d.id}: 缩放导致让位 ${r.kbb}`);
  }
});

/* ══════════ 脏输入不许把条推到离谱位置 ══════════ */
t("脏输入兜底（0 / 负数 / 比屏还高）", () => {
  const cases = [
    { inner: 0 }, { inner: -5 }, { inner: NaN },
    { inner: 852, vvH: 0, vvT: 0 },
    { inner: 852, vvH: 9999, vvT: 0 },
    { inner: 852, vvH: 852, vvT: 9999 },       /* offsetTop 离谱 */
    { inner: 852, vvH: 852, svh: 0, dvh: 0 },
    { inner: 852, vvH: 852, svh: 9999, dvh: 9999 },
  ];
  for (const c of cases) {
    const r = computeViewportVars({ ...c, scale: 1, restH: 852, barsBase: -1, kbMax: 0 });
    if (!r.ok) continue;
    assert.ok(r.kb >= 0 && r.kb < r.vph, `kb 越界：${JSON.stringify(c)} → ${r.kb}`);
    assert.ok(r.kbb >= 0 && r.kbb < r.vph, `kbb 越界：${JSON.stringify(c)} → ${r.kbb}`);
  }
});

/* ══════════ 顺序陷阱：先点键盘再滚动，不能把键盘高记进 UI 基线 ══════════ */
t("先键盘后滚动：UI 基线不被键盘污染（否则下次键盘高少算一截）", () => {
  const d = DEVICES[2];                       /* ip15-393x852 */
  const st = { restH: d.vp, barsBase: -1, kbMax: 0 };
  const run = (rd) => {
    const r = computeViewportVars({ ...rd, scale: 1, restH: st.restH, barsBase: st.barsBase, kbMax: st.kbMax });
    if (!(r.kb > 0) && rd.inner > st.restH) st.restH = rd.inner;
    st.barsBase = r.bars; st.kbMax = r.kbMax;
    return r;
  };
  run({ inner: d.vp, vvH: d.vp - d.bar, svh: d.vp - d.bar, dvh: d.vp - d.bar });   /* 打开时栏展开 */
  const first = run({ inner: d.vp, vvH: d.vp - d.bar - d.kb, svh: d.vp - d.bar, dvh: d.vp - d.bar - d.kb });
  assert.ok(near(first.kb, d.kb, 25), `第一次键盘高 ${first.kb} ≠ ${d.kb}`);
  run({ inner: d.vp, vvH: d.vp - d.bar, svh: d.vp - d.bar, dvh: d.vp - d.bar });   /* 收起 */
  const second = run({ inner: d.vp, vvH: d.vp - d.bar - d.kb, svh: d.vp - d.bar, dvh: d.vp - d.bar - d.kb });
  assert.ok(near(second.kb, d.kb, 25), `第二次键盘高 ${second.kb} ≠ ${d.kb}（基线被污染了）`);
  assert.equal(st.barsBase, d.bar, `UI 基线应恒为 ${d.bar}，实际 ${st.barsBase}`);
});

/* ══════════ 横屏：玻璃栏更高，也不能误判 ══════════ */
t("横屏 iPhone（栏 110px）不许被当成键盘", () => {
  const r = computeViewportVars({
    inner: 393, vvH: 393 - 110, svh: 393 - 110, dvh: 393 - 110,
    scale: 1, restH: 393, barsBase: -1, kbMax: 0,
  });
  assert.equal(r.kb, 0, `横屏栏被当键盘：kb=${r.kb}`);
  assert.equal(r.bars, 110);
});

/* ══════════ 基线未建立时（首帧就在键盘态）也要给合理值 ══════════ */
t("首帧就在键盘态：面板高度不许爆表", () => {
  const r = computeViewportVars({
    inner: 852, vvH: 852 - 336, svh: 852, dvh: 852 - 336,
    scale: 1, restH: 852, barsBase: -1, kbMax: 0,
  });
  assert.ok(r.kb > 0 && r.kb <= 852 * 0.7, `kb 爆表：${r.kb}`);
  assert.ok(r.panel <= 852 * 0.7, `面板高爆表：${r.panel}`);
});

/* ══════════ 常量口径护栏 ══════════ */
t("常量：UI 遮挡上限必须高于真键盘下限，否则横屏必误判", () => {
  assert.ok(CHROME_UI_MAX >= 150, `CHROME_UI_MAX=${CHROME_UI_MAX} 太小，横屏玻璃栏会被当键盘`);
  assert.ok(KB_MIN < CHROME_UI_MAX, "KB_MIN 必须小于 CHROME_UI_MAX");
});

console.log(out.join("\n"));
console.log(`\nviewport-matrix-test: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
