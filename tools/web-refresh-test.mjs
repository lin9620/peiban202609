/* 网页端暖心墙刷新按钮回归测试（Node 直跑：node tools/web-refresh-test.mjs）
 * ------------------------------------------------------------
 * 背景（轮 83）：下拉刷新靠 touch 事件，桌面网页没有触屏够不着 —— 用户点名在
 * 排序行右端补一个刷新按钮，点它走与下拉同一条 loadCloud({ fresh: true }) 强制
 * 取新路径；App 壳里有原生下拉刷新，按钮在 App 里隐藏（html.cap-app 规则）。
 * 这里锁 6 项结构断言，防止后续改动把按钮/隐藏规则/i18n 词条悄悄改回去。
 * i18n 词条用行为断言（Node 下可直接 import i18n.js 的 messages）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { messages } from "../src/i18n.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const out = [];
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; out.push("PASS  " + name); }
  catch (e) { fail++; out.push("FAIL  " + name + "  → " + e.message); }
}

const view = read("src/views/CommunityView.vue");
const css = read("src/style.css");

/* ══════════ 按钮 ══════════ */

t("T1 排序行里有刷新按钮：class=wall-refresh、@click=manualRefresh({ pin:true })、disabled 绑 loadingCloud", () => {
  const row = view.slice(view.indexOf('class="sort-row"'));
  assert.ok(row.includes('class="sort-btn wall-refresh"'), "排序行后没有 .wall-refresh 按钮");
  /* 轮 294 起必须带 pin：深滚时点刷新要「先归位再换内容」，否则列表塌缩会把视口一路往上拽 */
  assert.ok(row.includes('@click="manualRefresh({ pin: true })"'), "按钮没接 manualRefresh（或丢了轮 294 的 pin）");
  assert.ok(row.includes(':disabled="loadingCloud"'), "按钮没绑 loadingCloud 防重入");
});

t("T2 manualRefresh 走与下拉刷新同一条强制取新路径 loadCloud({ fresh: true })，且有防重入卫语句", () => {
  const fn = view.slice(view.indexOf("async function manualRefresh"));
  assert.ok(fn.includes("loadCloud({ fresh: true })"), "manualRefresh 没走 fresh 强制取新");
  assert.ok(/if\s*\(\s*loadingCloud\.value\s*\)\s*return/.test(fn), "缺 loadingCloud 防重入卫语句");
  /* 下拉刷新（te）也在同一条路径上：两个入口谁都不能被悄悄改掉 */
  const te = view.slice(view.indexOf("async function te()"), view.indexOf("async function manualRefresh"));
  assert.ok(te.includes("loadCloud({ fresh: true })"), "下拉刷新 te 的强制取新被改动了");
});

/* ══════════ App 壳隐藏 + 样式 ══════════ */

t("T3 App 壳里隐藏按钮（html.cap-app .wall-refresh），网页端 margin-left:auto 推到排序行右端", () => {
  assert.ok(/html\.cap-app \.wall-refresh\s*\{[^}]*display:\s*none/.test(css),
    "style.css 缺 html.cap-app .wall-refresh 隐藏规则（App 端会和下拉刷新重复）");
  assert.ok(/\.wall-refresh\s*\{[^}]*margin-left:\s*auto/.test(css), "按钮没有推到排序行右端");
});

t("T4 旋转动画有 prefers-reduced-motion 降级", () => {
  assert.ok(css.includes("@keyframes wall-refresh-spin"), "缺 spin 关键帧");
  /* 从 .wall-refresh 自己的规则块往后找 reduced-motion（style.css 前面有别的动画的同名媒体块） */
  const seg = css.slice(css.indexOf(".wall-refresh {"));
  const i = seg.indexOf("@media (prefers-reduced-motion: reduce)");
  assert.ok(i > 0, ".wall-refresh 规则后面没有 reduced-motion 块");
  assert.ok(seg.slice(i, i + 200).includes(".wall-refresh.spin"),
    "reduced-motion 块里没关掉刷新按钮动画");
});

/* ══════════ i18n 词条（行为断言） ══════════ */

t("T5 中英文都有 community.refreshBtn（i18n 词条对齐，缺一个就是硬编码文案回归）", () => {
  assert.equal(typeof messages.en.community.refreshBtn, "string");
  assert.equal(typeof messages.zh.community.refreshBtn, "string");
  assert.ok(messages.en.community.refreshBtn.length > 0, "en 词条为空");
  assert.ok(messages.zh.community.refreshBtn.length > 0, "zh 词条为空");
});

/* ══════════ 自检（跟 feed-perf-test T16 同款：exit 之后不许再有用例） ══════════ */

t("T7 轮 304：回顶三处全 instant + manualRefresh 真读 pin —— 深滚刷新秒回顶，不许 smooth 回潮", () => {
  /* focusFeedTop：悬浮「回顶部」按钮一律 instant */
  const go = view.slice(view.indexOf("function focusFeedTop()"), view.indexOf("function pinToTop()"));
  assert.ok(/behavior:\s*"instant"/.test(go), "goTop 回顶不是 instant");
  assert.ok(!/behavior:\s*"smooth"/.test(go), "goTop 里还有 smooth");
  /* 再点页签：retap 回调内一律 instant（切片只取 retap 回调，避免圈进下面的帖子定位 smooth） */
  const reStart = view.indexOf("watch([retapSeq, retapPath]");
  const re = view.slice(reStart, view.indexOf("wallScrollTop = 0;", reStart) + 30);
  assert.ok(/behavior:\s*"instant"/.test(re), "retap 回顶不是 instant");
  assert.ok(!/behavior:\s*"smooth"/.test(re), "retap 分支里还有 smooth");
  /* 网页刷新钮的 pin 必须真被读：先 instant 钉回顶部再刷新（T1 断言的按钮 pin 在此坐实；
   * 轮 294 实现 if (opts.pin)，后续改写保留任一形态都算过） */
  const mr = view.slice(view.indexOf("async function manualRefresh"), view.indexOf("function pinToTop()"));
  assert.ok(/if\s*\(\s*opts(\s*&&\s*opts)?\.pin\s*\)\s*pinToTop\(\)/.test(mr), "manualRefresh 没读 opts.pin");
});

t("T6 自检：process.exit 之后不许再出现 t(...)", () => {
  const self = read("tools/web-refresh-test.mjs");
  const i = self.indexOf("process.exit");
  assert.ok(i > 0, "找不到 process.exit");
  const after = self.slice(i).replace(/process\.exit\([^)]*\)/g, "");
  assert.ok(!/(^|\n)\s*t\(/.test(after), "process.exit 之后还有用例（静默丢测试）");
});

console.log(out.join("\n"));
console.log(`\nTOTAL ${pass + fail}  PASS ${pass}  FAIL ${fail}`);
const bad = fail > 0;
process.exit(bad ? 1 : 0);
