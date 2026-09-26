/* 动态流虚拟窗口（B1 档）纯函数回归测试（Node 直跑：node tools/feed-window-test.mjs）
 * ------------------------------------------------------------
 * 背景（轮 82）：暖心墙滚到几百条就卡 —— 原生列表靠「回收复用」做到节点恒定
 * （屏幕上永远只有十几个 item 视图），我们是 v-for 只增不减（滚 300 条 = 300 张卡全活着）。
 * B1 把「已亮出条数」与「真正挂进 DOM 的条数」拆开，本文件锁住 src/utils/feedWindow.js
 * 这套纯逻辑，防止后续改动把窗口算错（算错的后果是白屏/串位/滚动条乱跳，肉眼很难复现）。
 *
 * 契约要点：
 *   buildOffsets → 前缀高度表（offsets[i] = 前 i 条总高，含每条 margin-bottom 间距）
 *   indexAt      → 二分定位，越界一律夹到两端（绝不返回 -1/NaN）
 *   windowRange  → { start, end, padTop, padBottom }，且恒定满足
 *                  padTop + (offsets[end]-offsets[start]) + padBottom === total
 *   nearEnd      → 视口底是否接近数据末尾（触底续载的唯一依据）
 *   revealTarget → 深链跳帖要亮到多少条（按页取整）
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_EST, DEFAULT_OVERSCAN, WINDOW_ON_THRESHOLD, NEAR_END_PX,
  idOf, heightOf, buildOffsets, indexAt, windowRange, nearEnd, revealTarget,
} from "../src/utils/feedWindow.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const out = [];
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; out.push("PASS  " + name); }
  catch (e) { fail++; out.push("FAIL  " + name + "  → " + e.message); }
}

/** 造一份「第 i 条高度 = 300 + i*10」的列表 + 高度表，便于断言具体像素 */
function makeList(n, known) {
  const list = [];
  const heights = {};
  for (let i = 0; i < n; i++) {
    const id = "p" + i;
    list.push({ id, dbId: id });
    if (known == null || i < known) heights[id] = 300 + i * 10;
  }
  return { list, heights };
}

/* ══════════ idOf / heightOf ══════════ */

t("T1 idOf：数字/字符串/对象 id 统一成稳定字符串，空值一律空串", () => {
  assert.equal(idOf({ id: 7 }), "7");
  assert.equal(idOf({ id: "c12" }), "c12");
  assert.equal(idOf(1758800000000), "1758800000000");
  assert.equal(idOf({ id: 0 }), "0");           /* 0 是合法 id，不能被当空 */
  assert.equal(idOf(null), "");
  assert.equal(idOf(undefined), "");
  assert.equal(idOf({}), "");
  assert.equal(idOf({ id: null }), "");
});

t("T2 heightOf：实测优先；0/负数/NaN/字符串脏值一律回落估高", () => {
  assert.equal(heightOf({ a: 512 }, "a"), 512);
  assert.equal(heightOf({ a: 512 }, "a", 999), 512);
  for (const bad of [0, -3, NaN, Infinity, "abc", null, undefined]) {
    assert.equal(heightOf({ a: bad }, "a"), DEFAULT_EST, `脏值 ${String(bad)} 未回落估高`);
  }
  assert.equal(heightOf({ a: 1 }, "a", 0), 1, "实测值有效时估高参数不该抢班");
  assert.equal(heightOf(null, "a"), DEFAULT_EST);              /* 高度表缺失也不崩 */
  assert.equal(heightOf({ a: 0 }, "a", -5), DEFAULT_EST);      /* 实测脏 + 估高也脏 → 兜底常量 */
});

/* ══════════ buildOffsets ══════════ */

t("T3 buildOffsets：offsets[0]=0，每条都含一次 gap（间距不能漏）", () => {
  const { list, heights } = makeList(3);
  const { offsets, total } = buildOffsets(list, heights, { gap: 18 });
  assert.deepEqual(offsets, [0, 300 + 18, (300 + 18) + (310 + 18), (300 + 18) + (310 + 18) + (320 + 18)]);
  assert.equal(total, offsets[3]);
  assert.equal(total, 300 + 310 + 320 + 18 * 3);
});

t("T4 buildOffsets：没实测的条目用估高，前缀表仍严格单调不减", () => {
  const { list, heights } = makeList(6, 2);       /* 只量了前 2 条 */
  const { offsets, total } = buildOffsets(list, heights, { gap: 18 });
  assert.equal(offsets[1], 300 + 18);
  assert.equal(offsets[2], 300 + 18 + 310 + 18);
  assert.equal(offsets[3], offsets[2] + DEFAULT_EST + 18, "第 3 条应回落估高");
  for (let i = 1; i < offsets.length; i++) assert.ok(offsets[i] > offsets[i - 1], `offsets 非单调：${i}`);
  assert.equal(total, offsets[6]);
});

t("T5 buildOffsets：空列表 / 脏入参 → offsets=[0] 且 total=0（不能是 NaN）", () => {
  for (const bad of [[], null, undefined, "x"]) {
    const r0 = buildOffsets(bad, null, { gap: 18 });
    assert.equal(r0.offsets.length, 1);
    assert.equal(r0.offsets[0], 0);
    assert.equal(r0.total, 0);
    assert.ok(Number.isFinite(r0.total), "total 必须是有限数");
  }
});

/* ══════════ indexAt ══════════ */

t("T6 indexAt：落在哪条就是哪条，越界夹两端，脏输入不产生 NaN", () => {
  const { list, heights } = makeList(4);
  const { offsets, total } = buildOffsets(list, heights, { gap: 18 });
  assert.equal(indexAt(offsets, 0), 0);
  assert.equal(indexAt(offsets, 1), 0);
  assert.equal(indexAt(offsets, offsets[1] + 5), 1);
  assert.equal(indexAt(offsets, offsets[2] - 1), 1);          /* 刚好在边界前一条 */
  assert.equal(indexAt(offsets, offsets[3] + 1), 3);          /* 末条中间 → 末条 */
  for (const bad of [total, total + 5000, Infinity, NaN, -1, -1e9, "abc", null, undefined]) {
    const i = indexAt(offsets, bad);
    assert.ok(Number.isInteger(i) && i >= 0 && i <= list.length - 1, `脏值 ${String(bad)} → ${i}`);
  }
  assert.equal(indexAt([0], 123), 0);                          /* 空表 */
  assert.equal(indexAt(null, 123), 0);
});

t("T7 indexAt：对每条取「条内任意高度」都定位到自己（全表自洽）", () => {
  const { list, heights } = makeList(40);
  const { offsets } = buildOffsets(list, heights, { gap: 18 });
  for (let i = 0; i < list.length; i++) {
    const y0 = offsets[i] + 1;
    const y1 = offsets[i + 1] - 1;
    assert.equal(indexAt(offsets, y0), i, `第 ${i} 条顶部定位错`);
    assert.equal(indexAt(offsets, y1), i, `第 ${i} 条底部定位错`);
  }
});

/* ══════════ windowRange ══════════ */

t("T8 windowRange：窗口自洽不变量 padTop + 窗口内总高 + padBottom === total", () => {
  const { list, heights } = makeList(80, 40);
  const { offsets, total } = buildOffsets(list, heights, { gap: 18 });
  for (const scrollTop of [0, 300, 2500, 9000, 30000, 1e7]) {
    const r = windowRange({ offsets, total, scrollTop, viewportH: 800, overscan: DEFAULT_OVERSCAN });
    assert.ok(r.start >= 0 && r.end <= list.length && r.start <= r.end, `范围非法 ${JSON.stringify(r)}`);
    const inner = offsets[r.end] - offsets[r.start];
    assert.equal(r.padTop, offsets[r.start], "padTop 必须等于窗口起点的前缀高度");
    assert.equal(r.padBottom + inner + r.padTop, total, `总高不守恒（scrollTop=${scrollTop}）`);
  }
});

t("T9 windowRange：贴顶 → start=0 且 padTop=0；贴底 → end=末条 且 padBottom=0", () => {
  const { list, heights } = makeList(60, 60);
  const { offsets, total } = buildOffsets(list, heights, { gap: 18 });
  const top = windowRange({ offsets, total, scrollTop: 0, viewportH: 800, overscan: 4 });
  assert.equal(top.start, 0);
  assert.equal(top.padTop, 0);
  assert.ok(top.end >= 1);
  const bottom = windowRange({ offsets, total, scrollTop: total, viewportH: 800, overscan: 4 });
  assert.equal(bottom.end, list.length);
  assert.equal(bottom.padBottom, 0);
  assert.ok(bottom.start > 0, "滚到底时窗口不该还是从头发起（否则白挂一整列）");
});

t("T10 windowRange：窗口大小 ≈ 视口 + 上下 overscan（回收生效的关键）", () => {
  const { list, heights } = makeList(500, 500);
  const { offsets, total } = buildOffsets(list, heights, { gap: 18 });
  const r = windowRange({ offsets, total, scrollTop: 12000, viewportH: 800, overscan: 6 });
  const size = r.end - r.start;
  assert.ok(size >= 2 && size <= 4 + 6 * 2 + 1, `窗口 ${size} 条不合常理（应远小于 500）`);
  assert.ok(size < list.length / 10, "窗口大小必须与列表长度无关");
});

t("T11 windowRange：脏输入（NaN/负/Infinity/缺参）不崩、不产生 NaN 像素", () => {
  const { list, heights } = makeList(30);
  const { offsets, total } = buildOffsets(list, heights, { gap: 18 });
  for (const o of [
    {}, { offsets }, { offsets, total: NaN }, { offsets, total, scrollTop: NaN, viewportH: NaN },
    { offsets, total, scrollTop: -999, viewportH: -5 }, { offsets, total, scrollTop: Infinity, viewportH: Infinity },
    { offsets, total, scrollTop: 1000, viewportH: 800, overscan: -3 }, { offsets: [], total: 0 },
  ]) {
    const r = windowRange(o);
    for (const k of ["start", "end", "padTop", "padBottom"]) {
      assert.ok(Number.isFinite(r[k]), `${k} 不是有限数：${JSON.stringify(r)}（入参 ${JSON.stringify(o)}）`);
      assert.ok(r[k] >= 0, `${k} 为负：${JSON.stringify(r)}`);
    }
    assert.ok(Number.isInteger(r.start) && Number.isInteger(r.end), "start/end 必须是整数");
  }
});

t("T12 windowRange：pinIndex（深链）把目标条包进窗口，且占位仍自洽", () => {
  const { list, heights } = makeList(200, 0);     /* 全部没量过：最坏情况（全靠估高） */
  const { offsets, total } = buildOffsets(list, heights, { gap: 18 });
  const r = windowRange({ offsets, total, scrollTop: 0, viewportH: 800, overscan: 6, pinIndex: 150 });
  assert.ok(r.start <= 150 && r.end > 150, `窗口 ${r.start}~${r.end} 没包住第 150 条`);
  assert.equal(r.padTop + (offsets[r.end] - offsets[r.start]) + r.padBottom, total);
  assert.ok(r.padTop > 0 && r.padBottom > 0);
  /* 钉住时不能被 scrollTop 带偏（否则目标条一滚就飞出窗口，scrollIntoView 失效） */
  const r2 = windowRange({ offsets, total, scrollTop: 99999, viewportH: 800, overscan: 6, pinIndex: 150 });
  assert.deepEqual(r2, r);
  /* 越界的 pinIndex 视为「没钉」（退回按 scrollTop 算） */
  const r3 = windowRange({ offsets, total, scrollTop: 12000, viewportH: 800, overscan: 6, pinIndex: 9999 });
  assert.notDeepEqual(r3, r);
  assert.ok(Number.isFinite(r3.padTop));
});

/* ══════════ nearEnd（触底续载） ══════════ */

t("T13 nearEnd：视口底进到末尾阈值内才为真；短列表（铺不满一屏）恒为真", () => {
  assert.equal(nearEnd({ total: 10000, scrollTop: 0, viewportH: 800 }), false);
  assert.equal(nearEnd({ total: 10000, scrollTop: 10000 - 800 - NEAR_END_PX + 10, viewportH: 800 }), true);
  assert.equal(nearEnd({ total: 10000, scrollTop: 10000, viewportH: 800 }), true);
  assert.equal(nearEnd({ total: 500, scrollTop: 0, viewportH: 800 }), true, "一屏都没铺满 → 应立即续载");
  assert.equal(nearEnd({ total: 10000, scrollTop: 10000, viewportH: 800, threshold: 0 }), true);
  assert.equal(nearEnd({ total: 10000, scrollTop: 0, viewportH: 800, threshold: 99999 }), true);
  assert.equal(nearEnd({}), true);                    /* 空数据：total=0 ≤ vh */
  assert.equal(nearEnd({ total: NaN, scrollTop: NaN, viewportH: NaN }), true);
  /* 刚好差一点点 → 必须为假，否则会一直续载（哨兵时代的「一进来就联网取下一页」隐患） */
  assert.equal(nearEnd({ total: 10000, scrollTop: 10000 - 800 - NEAR_END_PX - 5, viewportH: 800 }), false);
});

/* ══════════ revealTarget（深链跳帖） ══════════ */

t("T14 revealTarget：按页取整，刚好包住目标条（不破坏每页 10 条的节奏）", () => {
  assert.equal(revealTarget(0, 10), 10);
  assert.equal(revealTarget(9, 10), 10);
  assert.equal(revealTarget(10, 10), 20);
  assert.equal(revealTarget(24, 10), 30);
  assert.equal(revealTarget(99, 10), 100);
  assert.equal(revealTarget(-5, 10), 10);              /* 越界夹到第一页 */
  assert.equal(revealTarget(7, 1), 8);                 /* 页长为 1 */
  assert.equal(revealTarget(7, 0), 8);                 /* 页长非法 → 按 1 */
  assert.equal(revealTarget(NaN, NaN), 1);
  assert.ok(Number.isInteger(revealTarget(13, 10)));
});

/* ══════════ 常量与「纯函数」性质 ══════════ */

t("T15 常量量级合理（估高与 A 档同量级、缓冲适中、回退阀存在）", () => {
  assert.ok(DEFAULT_EST >= 120 && DEFAULT_EST <= 600, `估高 ${DEFAULT_EST} 不合理`);
  assert.ok(DEFAULT_OVERSCAN >= 2 && DEFAULT_OVERSCAN <= 20, `缓冲条数 ${DEFAULT_OVERSCAN} 不合理`);
  assert.ok(WINDOW_ON_THRESHOLD >= 20, "窗口启用阈值太小 → 短列表也走虚拟滚动（风险大）");
  assert.ok(NEAR_END_PX > 0 && NEAR_END_PX <= 2000, `触底阈值 ${NEAR_END_PX} 不合理`);
});

t("T16 模块是纯逻辑：不碰 DOM（没有 document/window 访问、不自己量尺寸）", () => {
  const src = read("src/utils/feedWindow.js");
  /* 注意别用 /\bwindow\b/：文件名 feed-window-test.mjs 里的「-window-」会被误命中（本测试初版踩过） */
  assert.ok(!/\bdocument\s*[.[]/.test(src), "feedWindow.js 里访问了 document —— 纯逻辑不该碰 DOM");
  assert.ok(!/\bwindow\s*[.[]/.test(src), "feedWindow.js 里访问了 window —— 纯逻辑不该碰 DOM");
  assert.ok(!/\bgetBoundingClientRect\b/.test(src), "纯逻辑不该自己量尺寸");
  assert.ok(!/\bResizeObserver\b/.test(src), "纯逻辑不该自己监听尺寸变化");
});

t("T17 估高与 A 档 contain-intrinsic-size 完全一致（差一点就是窗口尾部一截空档）", () => {
  const css = read("src/style.css");
  const m = css.match(/(?:^|\n)\.post-card\s*\{[^}]*\}/);
  assert.ok(m, "style.css 缺少 .post-card 规则");
  const px = Number((m[0].match(/contain-intrinsic-size:\s*auto\s+(\d+)px/) || [])[1]);
  assert.ok(px > 0, "A 档的 contain-intrinsic-size 没了");
  /* 不是「同量级」而是「相等」：估高就是浏览器给未渲染卡片的那个高度，
     差 20px × 窗口尾部十几张 = 一截可见空档（真机取证量到过 138px）。 */
  assert.equal(DEFAULT_EST, px, `CSS 占位 ${px}px 与模块估高 ${DEFAULT_EST}px 不一致`);
});

/* ══════════ 性能守卫：窗口计算不能是「每次滚动 O(n)」 ══════════ */

t("T18 2000 条列表：连续 2000 次 windowRange 不超时（二分而非线性扫描）", () => {
  const list = [];
  const heights = {};
  for (let i = 0; i < 2000; i++) { list.push({ id: "x" + i }); heights["x" + i] = 250 + (i % 7) * 30; }
  const { offsets, total } = buildOffsets(list, heights, { gap: 18 });
  const t0 = Date.now();
  let last = null;
  for (let s = 0; s < 2000; s++) {
    last = windowRange({ offsets, total, scrollTop: s * 300, viewportH: 800, overscan: DEFAULT_OVERSCAN });
    assert.ok(last.end > last.start, "空窗口");
  }
  const ms = Date.now() - t0;
  assert.ok(ms < 1500, `2000 次定位耗时 ${ms}ms（疑似退化成线性扫描）`);
  /* 末次 scrollTop = 1999*300 ≈ 60 万，离列表底（≈71 万）还早 → 窗口不该已经到底 */
  assert.ok(last.end < list.length, "窗口提前到底了：说明定位算错");
  assert.ok(last.end > 1600, `末次窗口 end=${last.end} 偏小，定位可能有系统偏移`);
  assert.equal(windowRange({ offsets, total, scrollTop: total, viewportH: 800, overscan: DEFAULT_OVERSCAN }).end,
    list.length, "滚到最底必须包含末条");
});

/* ══════════ 自检 ══════════ */
t("T19 本文件所有用例都注册在 process.exit 之前（防新增用例被静默跳过）", () => {
  const self = read("tools/feed-window-test.mjs");
  const exitAt = self.indexOf("process.exit(");
  assert.ok(exitAt > 0, "缺少 process.exit");
  assert.ok(!/^t\(/m.test(self.slice(exitAt)), "process.exit 之后还有 t(...) 用例 → 永远执行不到");
});

console.log(out.join("\n"));
console.log(`\nTOTAL ${pass + fail}  PASS ${pass}  FAIL ${fail}`);
process.exit(fail ? 1 : 0);
