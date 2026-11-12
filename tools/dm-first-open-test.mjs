/* 首开长会话：换房先开 loader，绝不先亮空态
 *   node tools/dm-first-open-test.mjs
 *
 * 用户实测：第一次打开有很长记录的会话会跳闪，后面再开就正常。
 * 根因：DmVacChat 旧版固定等 600ms；长记录首开走 IndexedDB/网络，超过 600ms 就先把
 * 新会话按空消息提交（loaded false→true），组件亮一帧「还没有消息」，消息到了再填上。
 * 第二次打开命中 dmStore，同步有消息，所以不闪。
 *
 * 本测试锁的是结构：
 *   F1 commit 在 loading=true 时只关到 false，不把 loader 收掉；
 *   F2 已知会话 + 正在加载 + 暂无消息 → 立刻换房并 commit(..., true)；
 *   F3 深链 rooms 未到时的 600ms 兜底也要带 loading 态；
 *   F4 已知会话不再走旧的 600ms 空消息提交；
 *   F5 消息到场仍然关 loader；F6 messages-loaded 仍由 loaded 驱动。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const RAW = (p) => fs.readFileSync(path.join(root, p), "utf8");
const code = (s) => s.replace(/<!--[\s\S]*?-->/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
const VAC = code(RAW("src/components/DmVacChat.vue"));
const fnBody = (src, sig, endSig) => {
  const i = src.indexOf(sig);
  if (i < 0) return "";
  const j = endSig ? src.indexOf(endSig, i) : -1;
  return src.slice(i, j > i ? j : i + 2200);
};

let pass = 0, fail = 0; const out = [];
const t = (name, fn) => {
  try { fn(); pass++; out.push("ok   " + name); }
  catch (e) { fail++; out.push("FAIL " + name + " :: " + e.message); }
};
const has = (src, re, msg) => { if (!re.test(src)) throw new Error(msg); };
const notHas = (src, re, msg) => { if (re.test(src)) throw new Error(msg); };

const commitBody = fnBody(VAC, "const commit = (room, msgs, loading = false) => {", "let holdTimer");
const watchBody = fnBody(VAC, "watch(\n  () => [props.roomId", "/* ── 轮 340");

t("F1 loading=true 时 commit 只关 loader，不亮空态", () => {
  assert.ok(commitBody, "找不到 commit");
  has(commitBody, /loaded\.value = false/, "没有先关 loader");
  has(commitBody, /if \(!loading\) nextTick/, "loading 时仍会 nextTick 把 loaded 置 true（会亮空态）");
  has(commitBody, /loaded\.value = true/, "没有收 loader 的分支");
});

t("F2 已知会话 + loading + 暂无消息 → 立刻换房并开 loader", () => {
  assert.ok(watchBody, "找不到 watch");
  has(watchBody, /if \(!nextMsgs\.length && props\.loadingMessages\)/, "没有「加载中且无消息」判断");
  has(watchBody, /commit\(nextRoom, nextMsgs, true\)/, "没有带 loading=true 提交");
  has(watchBody, /return;/, "提交后没有 return");
});

t("F3 深链 600ms 兜底也带 loading 态", () => {
  has(watchBody, /if \(!known && nextRoom !== curRoom\.value\)/, "600ms 兜底不只给 rooms 未到的深链首帧");
  has(watchBody, /commit\(nextRoom, mapMsgs\(\), props\.loadingMessages\)/, "深链兜底丢了 loading 态");
});

t("F3b rooms 晚到要能立刻触发 watch，不能死等 600ms（props.rooms 是不存在的 prop）", () => {
  has(watchBody, /props\.loadingMessages, roomKnown\.value\]/, "watch 依赖里没有 roomKnown.value");
  notHas(watchBody, /props\.rooms/, "watch 又写回不存在的 props.rooms");
});

t("F4 已知会话不再走旧的 600ms 空消息等待", () => {
  notHas(watchBody, /const waiting =/, "旧版 waiting 变量还在");
  notHas(watchBody, /if \(nextRoom !== curRoom\.value && waiting\)/, "旧版 600ms 空消息等待还在");
});

t("F5 消息到场仍会关 loader", () => {
  has(commitBody, /if \(msgs\.length\)/, "没有消息到场分支");
  has(commitBody, /if \(!loaded\.value\) nextTick\(\(\) => \{ if \(seq === commitSeq\) loaded\.value = true; \}\)/, "消息到场后不关 loader");
});

t("F6 messages-loaded 仍由 loaded 驱动", () => {
  has(VAC, /:messages-loaded="loaded \? 'true' : 'false'"/, "messages-loaded 不再跟 loaded 走");
});

t("F7 首帧 onMounted 不关正在加载的 loader", () => {
  const f = fnBody(VAC, "onMounted(() => {", "onBeforeUnmount");
  assert.ok(f, "找不到 onMounted");
  has(f, /if \(props\.loadingMessages && !curMsgs\.value\.length\) return;/, "挂载首帧无条件把 loaded 翻 true（手机首开会露空态）");
});

/* 轮 351：用户实测「很长的记录，第一次进去会跳闪」——父级没定高那一帧列表按整段撑开，
   scrollTop 写不进去，先亮顶部再跳底。锁「落底前不亮」。 */
const pinOnceBody = fnBody(VAC, "const pinOnce = () => {", "/* 进房后追 1.2s");
const pinBottomBody = fnBody(VAC, "const pinBottom = () => {", "const stopPin");

t("F8 钉底成功前不亮消息列表（首帧不在顶部）", () => {
  assert.ok(pinOnceBody, "找不到 pinOnce");
  has(pinOnceBody, /if \(!firstPinDone\)/, "pinOnce 没有首帧门控");
  has(pinOnceBody, /isPinned\(n\)/, "没有「真的贴底了」判据");
  has(pinOnceBody, /n\.style\.visibility = "hidden"/, "没定高/没贴底时没有藏起来");
  const pinnedBody = fnBody(VAC, "const isPinned = (n) => {", "const revealList");
  has(pinnedBody, /clientHeight/, "isPinned 没量 clientHeight");
  has(pinnedBody, /window\.innerHeight/, "isPinned 没和视口比（父级没定高时 clientHeight 会是整段高度）");
  has(pinnedBody, /scrollHeight - n\.scrollTop - ch < 2/, "isPinned 没查 gap");
  const revealBody = fnBody(VAC, "const revealList = (n) => {", "const listNode");
  has(revealBody, /firstPinDone = true/, "revealList 没落标记");
  has(revealBody, /visibility = ""/, "revealList 没恢复可见");
});

t("F9 钉底兜底：异常时 900ms 也得亮出来", () => {
  assert.ok(pinBottomBody, "找不到 pinBottom");
  has(pinBottomBody, /if \(!firstPinDone && !gateTimer\)/, "pinBottom 没有兜底门");
  has(pinBottomBody, /revealList\(m\)/, "兜底没恢复可见");
});

const PAGE = code(RAW("src/views/MessagesView.vue"));
t("F10 手机形态：路由 :id 没对齐前不渲染聊天面板", () => {
  has(PAGE, /const paneReady = computed\(/, "没有 paneReady");
  has(PAGE, /route\.name === "messages" && String\(route\.params\.id \|\| ""\) === id/, "paneReady 没认路由 :id");
  has(PAGE, /if \(!isMobileNav\.value\) return true;/, "桌面双列也被挡住了");
  /* 轮 519：退出动画期间（threadOut）面板还要留在 DOM 里，否则动画根本没机会播。 */
  has(PAGE, /v-show="!isMobileNav \|\| \(!!activeId && paneReady\) \|\| threadOut"/, "面板 v-show 没挂 paneReady / threadOut");
  has(PAGE, /<template v-if="activeId && paneReady">/, "面板内容没挂 paneReady");
  /* 轮 519：退场动画期间（threadOut）列表和面板**都要在**：列表铺在底下当背景，
   * 面板在上面淡出。只留面板 = 淡到一半露出白底（真机 screencast +462ms 全白）。 */
  has(PAGE, /v-show="!isMobileNav \|\| !activeId \|\| !paneReady \|\| threadOut"/, "列表页没在等待期继续显示（会出现两边都藏的空白帧）");
  const openBody = fnBody(PAGE, "async function openConv(id) {", "/* ← 返回会话列表");
  has(openBody, /routeSettledFallback\.value = false/, "openConv 没重置兜底");
  has(openBody, /\}, 400\)/, "openConv 没有 400ms 放行兜底");
});

console.log(out.join("\n"));
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
