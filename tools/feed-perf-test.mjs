/* 动态流性能（A 档）回归测试（Node 直跑：node tools/feed-perf-test.mjs）
 * ------------------------------------------------------------
 * 背景：暖心墙动态流滚到几百条后卡顿（原生列表「节点恒定」vs 我们「DOM 只增不减」）。
 * A 档先做低风险渲染优化，本文件锁住这 4 项，防止被后续改动悄悄改回去：
 *   A1  卡片「屏外跳过渲染」：.post-card 的 content-visibility:auto + contain-intrinsic-size
 *   A2  列表图懒加载 + 异步解码（loading=lazy / decoding=async）
 *   A3  列表图未解码前的占位底色（减少白闪跳动）
 *   A4  时间文案记忆化 memoWhen（fmtWhen 走 toLocaleString，是重渲染里最贵的一项）
 * 其中 A4 是纯函数，直接跑行为断言；A1～A3 读源码/样式做结构断言。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { memoWhen, fmtWhen } from "../src/utils/wallRules.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const out = [];
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; out.push("PASS  " + name); }
  catch (e) { fail++; out.push("FAIL  " + name + "  → " + e.message); }
}

/* ══════════ A4 · 时间文案记忆化（纯函数，行为直测） ══════════ */

/** 造一个记账版格式化器：记调用次数 + 入参，便于断言「有没有真的少算」 */
function spy(fn) {
  const s = { calls: 0, args: [] };
  s.fn = (...a) => { s.calls++; s.args.push(a); return fn(...a); };
  return s;
}

t("T1 memoWhen：同语言同时间戳反复取 → 底层只算一次", () => {
  const s = spy(fmtWhen);
  const when = memoWhen(s.fn);
  const ts = Date.now();
  const a = when(ts, "zh"), b = when(ts, "zh"), c = when(ts, "zh");
  assert.equal(s.calls, 1, `底层被调用 ${s.calls} 次（应为 1）`);
  assert.equal(a, b);
  assert.equal(b, c);
});

t("T2 memoWhen：不同时间戳各自成条（不串值）", () => {
  const s = spy(fmtWhen);
  const when = memoWhen(s.fn);
  const t1 = Date.now(), t2 = t1 - 86400000;
  const a = when(t1, "zh"), b = when(t2, "zh");
  assert.equal(s.calls, 2, `底层被调用 ${s.calls} 次（应为 2）`);
  assert.equal(a, fmtWhen(t1, "zh"));
  assert.equal(b, fmtWhen(t2, "zh"));
  assert.notEqual(a, b);
});

t("T3 memoWhen：语言切换 → 整表失效（中英文案不串）", () => {
  const s = spy(fmtWhen);
  const when = memoWhen(s.fn);
  const ts = Date.now();
  const zh1 = when(ts, "zh");
  const en = when(ts, "en");
  const zh2 = when(ts, "zh");
  assert.equal(zh1, zh2, "切回中文应仍是中文文案");
  assert.equal(en, fmtWhen(ts, "en"));
  assert.equal(s.calls, 3, `切两次语言应各重算一次（实际 ${s.calls}）`);
  assert.notEqual(zh1, en);
});

t("T4 memoWhen：超过容量上限 → 清空重建，不做无界缓存", () => {
  const s = spy(fmtWhen);
  const when = memoWhen(s.fn, 3);
  const base = Date.now();
  for (let i = 0; i < 4; i++) when(base - i * 1000, "zh");   /* 第 4 条触发一次清空 */
  assert.equal(s.calls, 4, `4 个新时间戳各算一次（实际 ${s.calls}）`);
  when(base, "zh");                                          /* 最早的已被清掉 → 需重算 */
  assert.equal(s.calls, 5, `容量满清空后最早的应重算（实际 ${s.calls}）`);
  const again = when(base, "zh");                            /* 这次命中 */
  assert.equal(s.calls, 5, `刚算过的应命中缓存（实际 ${s.calls}）`);
  assert.equal(again, fmtWhen(base, "zh"));
});

t("T5 memoWhen：输出与 fmtWhen 逐字一致（多时间戳 × 双语）", () => {
  const when = memoWhen((ts, locale) => fmtWhen(ts, locale));
  const now = Date.now();
  const y = new Date(now);
  const stamps = [
    now,
    now - 90 * 1000,
    now - 3 * 86400000,
    new Date(y).setFullYear(y.getFullYear() - 1),   /* 跨年 */
    new Date(y).setMonth(0, 2),                     /* 年初 */
  ];
  for (const ts of stamps) {
    for (const loc of ["zh", "en", "zh"]) {   /* 混序切换，逼出 locale 失效路径 */
      assert.equal(when(ts, loc), fmtWhen(ts, loc), `ts=${ts} loc=${loc} 文案不一致`);
    }
  }
});

t("T6 memoWhen：非法时间仍返回空串（与 fmtWhen 同口径，且可缓存）", () => {
  const s = spy(fmtWhen);
  const when = memoWhen(s.fn);
  for (const bad of [null, undefined, "", "不是时间"]) {
    assert.equal(when(bad, "zh"), "");
    assert.equal(when(bad, "zh"), "");
  }
  assert.equal(s.calls, 4, `4 个非法值各算一次（实际 ${s.calls}）`);
});


/* ══════════ A1 · 卡片屏外跳过渲染 ══════════ */
const css = read("src/style.css");
/* 取「行首的 .post-card 规则块」——避免误匹配 .post .pic / .waller .pic 这类后代选择器 */
const POST_CARD = /(?:^|\n)\.post-card\s*\{[^}]*\}/;
t("T9 .post-card 开了 content-visibility:auto（屏外不 style/layout/paint）", () => {
  const m = css.match(POST_CARD);
  assert.ok(m, "style.css 缺少行首 .post-card 规则");
  assert.ok(/content-visibility:\s*auto/.test(m[0]), "未开 content-visibility");
  assert.ok(/contain-intrinsic-size:\s*auto\s+\d+px/.test(m[0]),
    "缺 contain-intrinsic-size（不写会让屏外卡片高度塌成 0，滚动条乱跳）");
});

t("T10 .post-card 的占位高度取了合理量级", () => {
  const m = css.match(POST_CARD);
  const px = Number((m[0].match(/contain-intrinsic-size:\s*auto\s+(\d+)px/) || [])[1]);
  assert.ok(px >= 120 && px <= 600, `占位高度 ${px}px 不合常理（应在 120~600 之间）`);
});

/* ══════════ A2 · 列表图懒加载 ══════════ */
const cmt = read("src/views/CommunityView.vue");
t("T11 动态流帖子图：loading=lazy + decoding=async", () => {
  const m = cmt.match(/<img[^>]*class="pic"[^>]*>/);
  assert.ok(m, 'CommunityView 里找不到 class="pic" 的帖子图');
  assert.ok(m[0].includes('loading="lazy"'), '帖子图缺 loading="lazy"');
  assert.ok(m[0].includes('decoding="async"'), '帖子图缺 decoding="async"');
});

t("T12 帖子图仍受 v-if=\"p.img\" 保护（无图帖不渲染空 img）", () => {
  assert.ok(/<img\s+v-if="p\.img"[^>]*class="pic"/.test(cmt), '帖子图丢了 v-if="p.img"');
});

/* ══════════ A3 · 占位底色 ══════════ */
t("T13 .pic 有未解码前的占位底色", () => {
  assert.ok(/(?:^|\n)\.pic\s*\{[^}]*background:\s*rgba?\(/.test(css),
    ".pic 缺占位底色（注意别被 .post .pic / .waller .pic 这类后代规则带偏）");
});

/* ══════════ A4 · 接线检查：组件确实用了记忆化版本 ══════════ */
t("T14 CommunityView 的 when 走 memoWhen（不再每次裸调 fmtWhen）", () => {
  assert.ok(cmt.includes("memoWhen"), "未导入/未使用 memoWhen");
  assert.ok(/memoWhen\(\(ts,\s*locale\)\s*=>\s*fmtWhen\(ts,\s*locale\)\)/.test(cmt),
    "未用 memoWhen 包住 fmtWhen");
  assert.ok(!/const when = \(ts\) => fmtWhen\(/.test(cmt), "when 仍在裸调 fmtWhen");
});

t("T15 模板里的调用点仍存在（记忆化没把用法删掉）", () => {
  assert.ok(cmt.includes("when(p.ts)"), "帖子时间调用点丢失");
  assert.ok(cmt.includes("when(cm.ts)"), "一级评论时间调用点丢失");
  assert.ok(cmt.includes("when(rp.ts)"), "二级回复时间调用点丢失");
});

t("T7 memoWhen：入参原样透传给底层（不改造 ts/locale）", () => {
  const s = spy(() => "x");
  const when = memoWhen(s.fn);
  const ts = Date.now();
  when(ts, "en");
  assert.deepEqual(s.args[0], [ts, "en"]);
});

t("T8 memoWhen：返回的是函数，可安全在每次渲染里调用", () => {
  const when = memoWhen((ts, locale) => fmtWhen(ts, locale));
  assert.equal(typeof when, "function");
  assert.equal(typeof when(Date.now(), "zh"), "string");
});

/* ══════════ 自检：用例注册位置 ══════════
 * 本文件初版把 T7/T8 写在了 process.exit 之后 → 两项永远跑不到（而 TOTAL 计数看着还正常，
 * 属于「静默丢测试」。这里锁住：process.exit 之后不许再出现 t(...) 用例。 */
t("T16 本文件所有用例都注册在 process.exit 之前（防新增用例被静默跳过）", () => {
  const self = read("tools/feed-perf-test.mjs");
  const exitAt = self.indexOf("process.exit(");
  assert.ok(exitAt > 0, "缺少 process.exit");
  assert.ok(!/^t\(/m.test(self.slice(exitAt)), "process.exit 之后还有 t(...) 用例 → 永远执行不到");
});

console.log(out.join("\n"));
console.log(`\nTOTAL ${pass + fail}  PASS ${pass}  FAIL ${fail}`);
process.exit(fail ? 1 : 0);
