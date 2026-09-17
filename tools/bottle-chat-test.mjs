/* 漂流瓶续聊离线回归：纯规则、双适配器及 Worker 正常请求、文案与接线。
 * 不访问网络，不执行 SQL；不能替代隔离数据库及浏览器验收。
 * 在项目根目录运行 node tools/bottle-chat-test.mjs。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { bottleChatState, bottleErrKey } from "../src/utils/bottle.js";
import { itemView, targetOf } from "../src/utils/notifyRules.js";
import { messages } from "../src/i18n.js";
import { db as direct, setDbClient } from "../src/utils/api/db.supabase.js";
import { db as gateway, setGatewayAuthProbe } from "../src/utils/api/db.gateway.js";
import worker from "../worker/api.js";

let pass = 0;
function eq(actual, expected) { assert.deepEqual(actual, expected); pass++; }
const id = "11111111-1111-4111-8111-111111111111";
const row = { id, user_id: "a", reply_by: "b", status: "answered", chat_decision: "pending" };
eq(bottleChatState(row, "a"), "choose");
eq(bottleChatState(row, "b"), "waiting");
eq(bottleChatState({ ...row, status: "drifting" }, "a"), "drifting");
for (const who of ["a", "b"]) {
  eq(bottleChatState({ ...row, chat_decision: "accepted", conv_id: 8 }, who), "accepted");
  eq(bottleChatState({ ...row, chat_decision: "declined" }, who), "declined");
}
eq(bottleErrKey(new Error("PGRST202")), "bottle.chatSetup");
for (const [event, key] of [["bottle_reply", "bottle.notifyReply"], ["bottle_chat", "bottle.notifyChat"]]) {
  const n = { kind: "dm", conv_id: 8, meta: { event, bottle_id: id, preview: "你好" } };
  eq(itemView(n).key, key);
  eq(targetOf(n), { type: "bottle", bottleId: id });
  for (const lang of ["zh", "en"]) eq(typeof messages[lang].bottle[key.split(".")[1]], "string");
}
eq(itemView({ kind: "dm" }).key, "notif.dm");
eq(targetOf({ kind: "dm", conv_id: 8 }), { type: "dm", convId: 8 });

const calls = [];
setDbClient({ rpc: async (name, params) => { calls.push({ name, params }); return { data: [], error: null }; } });
try {
  await direct.bottleRecords(id, 30);
  for (const accept of [true, false]) await direct.bottleChatDecide(id, accept);
  eq(calls, [
    { name: "bottle_records", params: { p_id: id, p_offset: 30 } },
    { name: "bottle_chat_decide", params: { p_id: id, p_accept: true } },
    { name: "bottle_chat_decide", params: { p_id: id, p_accept: false } },
  ]);
} finally { setDbClient(null); }

setGatewayAuthProbe(() => true);
const realFetch = globalThis.fetch;
const env = { SUPABASE_URL: "https://db.test", SUPABASE_ANON_KEY: "fixture", ASSETS: { fetch: async () => new Response("") } };
try {
  // gateway -> Worker -> 假上游；所有出站都由本测试截获。
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).startsWith("/api/")) return worker.fetch(new Request("https://site.test" + url, init), env, {});
    const name = new URL(url).pathname.split("/").pop();
    const params = JSON.parse(init.body);
    calls.push({ name, params });
    return Response.json(name === "bottle_records" ? [row] : { decision: params.p_accept ? "accepted" : "declined", conv_id: params.p_accept ? 8 : null });
  };
  calls.length = 0;
  eq(await gateway.bottleRecords(id, 30), [row]);
  eq(await gateway.bottleChatDecide(id, true), { decision: "accepted", conv_id: 8 });
  eq(await gateway.bottleChatDecide(id, false), { decision: "declined", conv_id: null });
  eq(calls, [
    { name: "bottle_records", params: { p_id: id, p_offset: 30 } },
    { name: "bottle_chat_decide", params: { p_id: id, p_accept: true } },
    { name: "bottle_chat_decide", params: { p_id: id, p_accept: false } },
  ]);
} finally { globalThis.fetch = realFetch; setGatewayAuthProbe(null); }

const read = (p) => fs.readFileSync(p, "utf8");
const component = read("src/components/BottleRecords.vue");
for (const key of [...component.matchAll(/["']bottle\.([A-Za-z]+)["']/g)].map((m) => m[1])) {
  for (const lang of ["zh", "en"]) eq(typeof messages[lang].bottle[key], "string");
}
eq(read("src/views/MessagesView.vue").includes("<BottleRecords"), true);
eq(read("src/views/NotificationsView.vue").includes('tg.type === "bottle"'), true);
// 静态迁移检查：仅确认脚本包含关键步骤，不证明事务及幂等行为已在数据库通过。
const sql = read("MIGRATION_bottle_chat.sql");
for (const text of ["begin;", "commit;", "bottle_reply_notification", "bottle_chat_decide", "bottle_records", "letter.body, letter.created_at", "letter.reply, letter.reply_at"]) eq(sql.includes(text), true);
console.log(`bottle-chat-test: ${pass} pass, 0 fail (offline; SQL not executed)`);
