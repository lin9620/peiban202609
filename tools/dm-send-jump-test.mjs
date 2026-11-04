/* 轮 352 · 发送成功不跳锁（Node 直跑）
 *   node tools/dm-send-jump-test.mjs
 *
 * 用户实报：「发送消息之后，成功了会跳」。
 * 根因：乐观行（临时负数 id）→ 服务端确认行（正式 id）时，行 key（组件只用 indexId 当
 * v-for key）变了；vue-advanced-chat 的 TransitionGroup 把同一句当成「旧行淡出 200ms +
 * 新行淡入 500ms」——列表先多一行再缩回，还会再触发一次 onMessageAdded 的滚底。
 *
 * 锁法：
 *   ① 发送时就给乐观行定下稳定 key（nextMsgKey），确认行沿用；
 *   ② rowToMessage 用 key 当 indexId（没有 key 才退回 id）；
 *   ③ 轮询 mergeTail 用服务端行覆盖时，把本地 key 带过去（否则下一拍又重挂一次）。
 * 同时锁接线（两个发送入口都要写 key），改坏必红。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rowToMessage, rowsToMessages } from "../src/utils/dmMap.js";
import { mergeTail, nextMsgKey } from "../src/utils/dmRules.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
let pass = 0, fail = 0; const out = [];
function t(name, fn) {
  try { fn(); pass++; out.push("ok   " + name); }
  catch (e) { fail++; out.push("FAIL " + name + " :: " + e.message); }
}

const base = { id: 251, sender: "me", body: "旧", image_path: null, created_at: "2026-10-26T02:00:00.000Z", deleted_at: null };

t("S1 nextMsgKey：空列表 0.001；接在最大 id / 已有 key 之后", () => {
  assert.equal(nextMsgKey([]), 0.001);
  assert.equal(nextMsgKey(null), 0.001);
  assert.equal(nextMsgKey([{ id: 251 }, { id: 250 }]), 251.001);
  assert.equal(nextMsgKey([{ id: 251, key: 251.001 }]), 251.002);
  assert.equal(nextMsgKey([{ id: 251, key: 251.002 }, { id: 250 }]), 251.003);
});

t("S2 rowToMessage：有 key 用 key，没有才用 id", () => {
  assert.equal(rowToMessage(base).indexId, 251);
  assert.equal(rowToMessage({ ...base, key: 251.001 }).indexId, 251.001);
});

t("S3 核心：乐观行 → 确认行，key 不变（组件不重挂那一行）", () => {
  const key = nextMsgKey([base]);
  const pending = { ...base, id: -179, body: "刚发", pending: true, key };
  const before = rowsToMessages([base, pending]);
  assert.equal(before.length, 2);
  assert.equal(before[1].indexId, key, "乐观行的 indexId 必须是稳定 key");
  assert.ok(before[1].indexId > before[0].indexId, "乐观行仍要排在最后一条正式消息后面");
  /* 服务端确认：同一句换成正式 id，key 沿用 */
  const confirmed = { ...base, id: 260, body: "刚发", key };
  const after = rowsToMessages([base, confirmed]);
  assert.equal(after.length, 2);
  assert.equal(after[1].indexId, key, "确认后 indexId 必须与乐观行一致（否则整行重挂 = 跳）");
  assert.equal(after[1]._id, "260", "内容身份仍要换成服务端 id（撤回等操作靠它）");
});

t("S4 多条连发：key 依次 +0.001，确认后顺序不乱", () => {
  const k1 = nextMsgKey([base]);
  const k2 = nextMsgKey([base, { id: -1, key: k1 }]);
  assert.ok(k2 > k1);
  const out2 = rowsToMessages([
    base,
    { ...base, id: 261, key: k1 },
    { ...base, id: 262, key: k2 },
  ]);
  assert.deepEqual(out2.map((m) => m._id), ["251", "261", "262"]);
  assert.deepEqual(out2.map((m) => m.indexId), [251, k1, k2]);
});

t("S5 mergeTail：服务端行覆盖时把本地 key 带过去（下一拍不重挂）", () => {
  const local = { ...base, id: 260, key: 251.001 };
  const srv = { ...base, id: 260, body: "旧" };   /* 服务端行没有 key */
  const r1 = mergeTail([base, local], [srv]);
  assert.equal(r1.added, false);
  assert.equal(r1.rows.length, 2);
  assert.equal(r1.rows[1].key, 251.001, "服务端行覆盖后 key 丢了 → 行 key 变一次 → 又跳");
  assert.equal(r1.rows[1].id, 260);
  /* 再合并一次（服务端字段没变）→ 同引用，不触发重渲染 */
  const r2 = mergeTail(r1.rows, [srv]);
  assert.equal(r2.rows, r1.rows, "字段没变必须返回同引用");
});

t("S6 撤回 / 失败行沿用 key（同一行原地变色，不重挂）", () => {
  const key = 251.001;
  const failed = { ...base, id: 260, failed: true, key };
  assert.equal(rowToMessage(failed).indexId, key);
  const recalled = { ...base, id: 260, body: "", deleted_at: "2026-10-26T03:00:00.000Z", key };
  assert.equal(rowToMessage(recalled).indexId, key);
});

t("S7 接线：两个发送入口都写稳定 key，映射层认 key，合并层保 key", () => {
  const mv = read("src/views/MessagesView.vue");
  const bc = read("src/components/BottleChat.vue");
  const map = read("src/utils/dmMap.js");
  const rules = read("src/utils/dmRules.js");
  assert.ok(mv.includes("key: nextMsgKey(msgs.value)"), "会话段乐观行没定稳定 key");
  assert.ok(mv.includes("key: temp.key"), "会话段确认行没沿用乐观行 key");
  assert.ok(bc.includes("key: nextMsgKey(msgs.value)"), "漂流瓶乐观行没定稳定 key");
  assert.ok(bc.includes("key: temp.key"), "漂流瓶确认行没沿用乐观行 key");
  assert.ok(mv.includes("before_max: beforeMax"), "会话段乐观行没记发送前最大 id");
  assert.ok(bc.includes("before_max: beforeMax"), "漂流瓶乐观行没记发送前最大 id");
  assert.ok(map.includes("indexId: m.key != null ? m.key : m.id"), "映射层没把 key 当行 key");
  assert.ok(rules.includes("prev.key != null && m.key == null"), "mergeTail 没把本地 key 带过去");
  assert.ok(rules.includes("export function nextMsgKey"), "nextMsgKey 被删了");
});

console.log(out.join("\n"));
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
