/* 轮 341 · 消息菜单的「撤回」：只能撤自己的、只给 15 分钟内的
 *   node tools/dm-recall-menu-test.mjs
 *
 * 报障：「这里怎么我还能撤回别人的消息，还有撤回不是有时间限制的吗」
 * 根因：换组件后 message-actions 是**全局**的一份，组件只按 onlyMe 过滤；
 *   我们没标 onlyMe，也没把 15 分钟窗口告诉它 → 别人的消息、两周前的消息都出「撤回」。
 * 修法：映射时按 canRecall(row, meId) 算 disableActions（不能撤的连 ⋯ 都不出）；
 *   菜单项加 onlyMe（双保险）；点下去再核一次（停在聊天里跨过 15 分钟）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rowToMessage, rowsToMessages } from "../src/utils/dmMap.js";
import { canRecall, RECALL_WINDOW_MS } from "../src/utils/dmRules.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const RAW = (p) => fs.readFileSync(path.join(root, p), "utf8");
const code = (s) => s.replace(/<!--[\s\S]*?-->/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
const VAC = code(RAW("src/components/DmVacChat.vue"));
const VIEW = code(RAW("src/views/MessagesView.vue"));

const ME = "11111111-1111-4111-8111-111111111111";
const PEER = "22222222-2222-4222-8222-222222222222";
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const row = (over = {}) => ({
  id: 9001, sender: ME, body: "hi", image_path: null,
  created_at: iso(60 * 1000), deleted_at: null, ...over,
});
/* 组件侧同款：在飞 / 失败一律不给撤回 */
const canRecallRow = (r) => !!r && !r.pending && !r.failed && canRecall(r, ME);
const mapOne = (r) => rowToMessage(r, { meId: ME, canRecall: canRecallRow });

let pass = 0, fail = 0; const out = [];
const t = (name, fn) => {
  try { fn(); pass++; out.push("ok   " + name); }
  catch (e) { fail++; out.push("FAIL " + name + " :: " + e.message); }
};
const has = (src, re, msg) => { if (!re.test(src)) throw new Error(msg); };

t("R1 不传 canRecall 时行为不变（chat-proto 那条不受影响）", () => {
  assert.equal(rowToMessage(row()).disableActions, false);
});

t("R2 自己 1 分钟前的消息：可以撤回（出菜单）", () => {
  assert.equal(mapOne(row()).disableActions, false);
});

t("R3 别人的消息：不给菜单（连 ⋯ 都不出）", () => {
  assert.equal(mapOne(row({ sender: PEER })).disableActions, true);
});

t("R4 自己 16 分钟前的消息：不给菜单（超 15 分钟）", () => {
  assert.equal(mapOne(row({ created_at: iso(16 * 60 * 1000) })).disableActions, true);
});

t("R5 窗口就是 15 分钟；卡在窗口内 1s 仍可撤（与 dm_recall 的 interval 同口径 <=）", () => {
  assert.equal(RECALL_WINDOW_MS, 15 * 60 * 1000);
  assert.equal(canRecall(row({ created_at: iso(RECALL_WINDOW_MS - 1000) }), ME), true);
});

t("R6 已撤回的消息：不给菜单", () => {
  const v = mapOne(row({ deleted_at: iso(1000) }));
  assert.equal(v.deleted, true);
  assert.equal(v.disableActions, true);
});

t("R7 在飞 / 失败的乐观行：不给菜单（没 msg_id，撤不了）", () => {
  assert.equal(mapOne(row({ pending: true })).disableActions, true);
  assert.equal(mapOne(row({ failed: true })).disableActions, true);
});

t("R7b 规则层自己也拒绝在飞/失败行（旧版列表不能绕过）", () => {
  assert.equal(canRecall(row({ pending: true }), ME), false);
  assert.equal(canRecall(row({ failed: true }), ME), false);
  assert.equal(canRecall(row({ id: -1 }), ME), false);   /* 旧数据只有负 id、没 pending 标记 */
});

t("R8 rowsToMessages 把 meId / canRecall 逐条传下去", () => {
  /* rowsToMessages 按 created_at 升序（轮 375）；这里显式给递增时间，避免
   * 三次 Date.now() 的毫秒差把 id 顺序打乱后误判测试。 */
  const list = rowsToMessages(
    [
      row({ id: 1, created_at: iso(60 * 1000) }),
      row({ id: 2, sender: PEER, created_at: iso(90 * 1000) }),
      row({ id: 3, created_at: iso(RECALL_WINDOW_MS * 2) }),
    ],
    { meId: ME, canRecall: canRecallRow }
  );
  assert.equal(list.length, 3);
  /* 按 id 断言，不依赖 rowsToMessages 的 created_at 排序（轮 375 起它按时间升序）。 */
  const byId = Object.fromEntries(list.map((m) => [m._id, m.disableActions]));
  assert.equal(byId["1"], false);
  assert.equal(byId["2"], true);
  assert.equal(byId["3"], true);
});

t("R9 组件接线：onlyMe + 映射传参 + 点击复核", () => {
  has(VAC, /name: "recall", title: t\("dm\.recall"\), onlyMe: true/, "菜单项没标 onlyMe（别人的消息还会出撤回）");
  has(VAC, /const canRecallRow = \(row\) => !!row && !row\.pending && !row\.failed && canRecall\(row, props\.meId\)/, "canRecallRow 规则不对");
  has(VAC, /rowsToMessages\(props\.messages, \{[\s\S]{0,180}?nameOf,[\s\S]{0,120}?meId: props\.meId,[\s\S]{0,120}?canRecall: canRecallRow/, "映射没把 meId/canRecall 传进去");
  assert.ok(!/rowsToMessages\(props\.messages, \{ nameOf \}\)/.test(VAC), "还有裸的 rowsToMessages 调用（会绕过撤回规则）");
  const act = VAC.slice(VAC.indexOf("const onAction = (e) =>"), VAC.indexOf("/* 发送："));
  has(act, /canRecallRow\(row\)/, "点击撤回时没复核 15 分钟窗口");
});

t("R10 旧版（非 vac）那条仍然按 canRecall + !pending 渲染撤回键", () => {
  has(VIEW, /v-if="canRecall\(it\.msg, meId\) && !it\.msg\.pending"/, "旧路径的撤回条件被改坏了");
});

console.log(out.join("\n"));
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
