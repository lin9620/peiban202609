/* 暖心墙「触底续载」回归测试（Node 直跑：node tools/feed-autoload-test.mjs）
 * ------------------------------------------------------------
 * 背景（轮 306，用户实测「一二十张就到底了」）：
 *   一页续载 = listPosts + listReactionsByPosts **两次串行**请求。弱网实测
 *   7.7s + 2.2s ≈ 10s，必超 PAGE_BUSY_MS(8000)。旧代码把 withTimeout 的拒绝
 *   当「这页不要了」用 → 两个请求都 200 回来、整页数据却被丢掉：游标不动、
 *   卡片不动，而用户此时已经贴在列表底部，滚动再也产生不出新滚动事件
 *  （@scroll 只在位置真的变化时触发）→ 永久停在首屏那一二十张，还没有「到底」提示。
 *
 * 本文件锁住修复的每一条腿，防止后续改动把它们悄悄改回去：
 *   T1 取数句柄先落地（不许再「直接 await withTimeout(cloudFetchPosts(...))」）
 *   T2 超时分支必须把「迟到页」补上屏（数据不丢）
 *   T3 pageBusy 交接给在飞请求（超时后不许立刻重发同一页，白花 Workers 额度）
 *   T4 硬上限兜底（连接挂死时强制放行，pageBusy 不许永久锁死续载）
 *   T5 失败自愈（!rows 与 catch 两条路径都要自动重排触底，不许只等用户再滚）
 *   T6 收尾口径唯一（去重/上屏/推游标/判到底/评论数只在 appendFeedRows 里）
 *   T7 离场清理（rAF 取消后归零 + 定时器清空）
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const out = [];
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; out.push("PASS  " + name); }
  catch (e) { fail++; out.push("FAIL  " + name + "  → " + e.message); }
}

const view = read("src/views/CommunityView.vue");
/* loadMoreCloud 起的这一整段（含 appendFeedRows），后面所有断言都在这段里找，
   免得同名串在别处出现造成假绿 */
const lmStart = view.indexOf("function appendFeedRows");
const lm = view.slice(lmStart, view.indexOf("function feedTick", lmStart));
assert.ok(lmStart > 0, "找不到 appendFeedRows —— 收尾口径被改名/删了");

/* ══════════ 取数：句柄必须先落地 ══════════ */

t("T1 续载请求先存成变量再等（不许再直接 await withTimeout(cloudFetchPosts(...))：那种写法超时=丢页）", () => {
  assert.ok(/const req = cloudFetchPosts\(FEED_PAGE, cursor\)/.test(lm),
    "loadMoreCloud 没有把请求句柄存成 req（超时就再也拿不到那一页了）");
  assert.ok(!/await withTimeout\(cloudFetchPosts\(/.test(lm),
    "又出现「await withTimeout(cloudFetchPosts(...))」——超时会连同数据一起丢掉（轮 306 的病根）");
  assert.ok(/rows = await withTimeout\(req, PAGE_BUSY_MS\)/.test(lm), "等待上限没落在 req 上");
});

t("T2 超时分支必须把迟到页补上屏（超时只放弃「等」，不放弃「数据」）", () => {
  assert.ok(/req\.then\(\(late\) => \{ appendFeedRows\(late\); settle\(\); \}, settle\)/.test(lm),
    "超时分支没有挂「迟到就补」的回调 —— 弱网下整页数据会被静默丢弃");
  assert.ok(lm.includes("appendFeedRows(late)"), "迟到页没有走统一收尾");
});

t("T3 pageBusy 交接给在飞的请求（超时一放行就会跟还在路上的那个请求重复发同一页）", () => {
  assert.ok(/let handoff = false;/.test(lm), "缺 handoff 标记");
  assert.ok(/handoff = true;/.test(lm), "超时分支没有把 pageBusy 交出去");
  assert.ok(/if \(!handoff\) pageBusy\.value = false;/.test(lm),
    "finally 无条件复位 pageBusy —— 会让超时后的下一次触底重发同一页");
});

t("T4 硬上限兜底：连接挂死（Promise 永不变更状态）时也要放行，否则 pageBusy 一锁死续载彻底失联", () => {
  assert.ok(/laterFeedTick\(PAGE_HARD_MS,/.test(lm), "超时分支没有硬上限放行");
  assert.ok(/const PAGE_HARD_MS = \d+;/.test(view), "PAGE_HARD_MS 没定义");
});

t("T5 失败自愈：!rows（拉取失败）与 catch（真异常）两条路径都要自动重排一次触底", () => {
  const n = (lm.match(/laterFeedTick\(PAGE_RETRY_MS\)/g) || []).length;
  assert.ok(n >= 2, `自愈重排只出现在 ${n} 处（失败与异常两条路径都要）`);
  assert.ok(/const PAGE_RETRY_MS = \d+;/.test(view), "PAGE_RETRY_MS 没定义");
});

t("T6 收尾口径唯一：去重/上屏/推游标/判到底只在 appendFeedRows 里，正常路径也必须走它", () => {
  assert.ok((view.match(/cloudPosts\.value\.concat\(/g) || []).length === 1,
    "cloudPosts.value.concat 不止一处 —— 收尾口径被复制了一份，改一处必漏另一处");
  const fn = lm.slice(lm.indexOf("function appendFeedRows"), lm.indexOf("async function loadMoreCloud"));
  for (const s of ["new Set(cloudPosts.value", "filterBlocked(", "feedCursor.value = rows[rows.length - 1].dbId",
    "cloudDone.value = rows.length < FEED_PAGE", "cloudFetchCommentCounts("]) {
    assert.ok(fn.includes(s), "appendFeedRows 少了这一步：" + s);
  }
  assert.ok(/if \(appendFeedRows\(rows\)\) return;/.test(lm), "正常路径没走统一收尾");
  /* 整页都是已加载过的 → 前进游标跳过这页；连跳 3 页才判「真到底」 */
  assert.ok(/cursor = rows\[rows\.length - 1\]\.dbId;/.test(lm), "整页重复时没有前进游标");
  assert.ok(/cloudDone\.value = true;\s*\/\* 连跳 3 页全重复/.test(lm), "连跳 3 页判到底的逻辑没了");
});

/* ══════════ 离场：定时器与 rAF 都要收干净 ══════════ */

t("T7 离场清理：rAF 取消后必须归零 + 登记的定时器全部清空", () => {
  const um = view.slice(view.indexOf("onUnmounted(() => {", view.indexOf("savedFeedPos")));
  const seg = um.slice(0, um.indexOf("cardRO.disconnect"));
  assert.ok(/if \(feedRaf\) \{ cancelAnimationFrame\(feedRaf\); feedRaf = 0; \}/.test(seg),
    "取消 rAF 后没归零 —— scheduleFeedTick 的 if (feedRaf) return 会把之后所有触底早退掉");
  assert.ok(/for \(const t of feedTimers\) clearTimeout\(t\)/.test(seg), "离场没清定时器");
  assert.ok(/feedTimers = \[\];/.test(seg), "feedTimers 没清空");
});

t("T8 定时器统一登记（laterFeedTick 必须入账，否则离场后还会排一次触底）+ fn 必须可省（arity 守卫）", () => {
  const fn = view.slice(view.indexOf("function laterFeedTick("), view.indexOf("function withTimeout("));
  assert.ok(/function laterFeedTick\(ms, fn = null\)/.test(fn), "fn 不是可省参数 —— arity-test 会判成必填");
  assert.ok(/feedTimers\.push\(t\)/.test(fn), "定时器没登记进 feedTimers");
  assert.ok(/feedTimers = feedTimers\.filter\(/.test(fn), "触发后没从册里摘掉（长会话会越攒越多）");
});

/* ══════════ 自检（跟 feed-perf-test T16 同款：exit 之后不许再有用例） ══════════ */

t("T9 本文件所有用例都注册在 process.exit 之前（防新增用例被静默跳过）", () => {
  const self = read("tools/feed-autoload-test.mjs");
  const exitAt = self.indexOf("process.exit(");
  assert.ok(exitAt > 0, "缺少 process.exit");
  assert.ok(!/^t\(/m.test(self.slice(exitAt)), "process.exit 之后还有 t(...) 用例 → 永远执行不到");
});

console.log(out.join("\n"));
console.log(`\nTOTAL ${pass + fail}  PASS ${pass}  FAIL ${fail}`);
process.exit(fail ? 1 : 0);
