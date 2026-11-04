/* 会话页换组件 · 数据映射 + 「微信式本地缓存保留」锁（Node 直跑）
 *   node tools/dm-map-test.mjs
 *
 * 锁两件事：
 *   ① 我们 conv/msg 行 → 组件 room/message 的翻译语义（撤回/失败/待发/图片/去重/顺序/上限）；
 *   ② 缓存层没被换组件这件事顺手改掉：会话列表仍走 SWR，历史仍走 IndexedDB 全量库，
 *      适配层只读、不写、不新建第二份。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { convToRoom, convsToRooms, dayLabel, rowToMessage, rowsToMessages, timeLabel } from "../src/utils/dmMap.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
let pass = 0, fail = 0; const out = [];
function t(name, fn) {
  try { fn(); pass++; out.push("ok   " + name); }
  catch (e) { fail++; out.push("FAIL " + name + " :: " + e.message); }
}

const NOW = new Date(2026, 9, 22, 15, 30).getTime();          /* 2026-10-22 15:30 本地 */
const iso = (d) => new Date(d).toISOString();

/* ───────── 时间标签 ───────── */
t("T1 日期标签：今天 / 昨天 / 同年 M月D日 / 跨年补年份", () => {
  assert.equal(dayLabel(iso(new Date(2026, 9, 22, 9, 0)), NOW), "今天");
  assert.equal(dayLabel(iso(new Date(2026, 9, 21, 23, 0)), NOW), "昨天");
  assert.equal(dayLabel(iso(new Date(2026, 7, 3, 12, 0)), NOW), "8月3日");
  assert.equal(dayLabel(iso(new Date(2025, 11, 31, 12, 0)), NOW), "2025年12月31日");
  assert.equal(dayLabel("", NOW), "");
  assert.equal(dayLabel("坏日期", NOW), "");
});

t("T2 时刻：HH:mm 补零、非法值空串", () => {
  assert.equal(timeLabel(iso(new Date(2026, 9, 22, 9, 5))), "09:05");
  assert.equal(timeLabel(iso(new Date(2026, 9, 22, 19, 45))), "19:45");
  assert.equal(timeLabel(null), "");
});

/* ───────── 会话 → room ───────── */
const conv = {
  conv_id: "c1", other_id: "u2", nickname: "球球的主人", unread: 3,
  last_preview: "周末一起带它去河边？", last_message_at: iso(new Date(2026, 9, 22, 15, 20)),
  created_at: iso(new Date(2026, 9, 1)), accepted: true, blocked: false,
};

t("T3 会话映射：roomId/昵称/头像/未读/排序键/最后一条", () => {
  const r = convToRoom(conv, { meId: "me", avatarOf: (id) => "av-" + id });
  assert.equal(r.roomId, "c1");
  assert.equal(r.roomName, "球球的主人");
  assert.equal(r.avatar, "av-u2");
  assert.equal(r.unreadCount, 3);
  assert.equal(r.index, Date.parse(conv.last_message_at));
  assert.equal(r.lastMessage.content, "周末一起带它去河边？");
  assert.equal(r.lastMessage.timestamp, "15:20");
  assert.equal(r.lastMessage.seen, false, "有未读时不该显示已读");
  assert.equal(r.lastMessage.new, true);
  assert.equal(r.users.length, 2);
  assert.equal(r.users[0]._id, "u2");
  assert.equal(r.users[1]._id, "me");
  assert.equal(convToRoom(null), null);
  assert.equal(convToRoom({ nickname: "没 id" }), null);
});

t("T4b 不伪造在线状态（现网没有 presence，别亮绿点/写「在线」）", () => {
  const r = convToRoom(conv, { meId: "me" });
  for (const u of r.users) {
    assert.ok(!u.status || !u.status.state, "users 里不许塞 online 状态");
  }
});

t("T4 未读为 0 → 最后一条显示已读；缺 last_message_at 时退回 created_at", () => {
  const r = convToRoom({ ...conv, unread: 0, last_message_at: null }, { meId: "me" });
  assert.equal(r.lastMessage.seen, true);
  assert.equal(r.lastMessage.new, false);
  assert.equal(r.index, Date.parse(conv.created_at));
});

t("T5 会话列表：按最新时间倒序、过滤拉黑/未接受、坏行不炸", () => {
  const list = [
    { conv_id: "a", other_id: "u1", last_message_at: iso(new Date(2026, 9, 20)) },
    { conv_id: "b", other_id: "u2", last_message_at: iso(new Date(2026, 9, 22)) },
    { conv_id: "c", other_id: "u3", blocked: true, last_message_at: iso(new Date(2026, 9, 21)) },
    { conv_id: "d", other_id: "u4", accepted: false, last_message_at: iso(new Date(2026, 9, 21)) },
    null, { nickname: "无 id" },
  ];
  assert.deepEqual(convsToRooms(list, { meId: "me" }).map((r) => r.roomId), ["b", "a"]);
  assert.deepEqual(convsToRooms(null), []);
});

/* ───────── 消息 → message ───────── */
/* 用「今天的 10:00」构造，不然跨过零点这条测试就会从「今天」翻成「昨天」
   （轮 331 实测：凌晨 01:27 跑闸门，T6 因为写死 10-22 而变红） */
const todayAt = (h, m = 0) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.toISOString(); };
const base = { id: 101, sender: "u2", body: "你好", image_path: null, created_at: todayAt(10), deleted_at: null };

t("T6 普通消息：id/正文/发送者/日期时刻/勾状态", () => {
  const m = rowToMessage(base, { nameOf: (id) => (id === "u2" ? "球球的主人" : "我") });
  assert.equal(m._id, "101");
  assert.equal(m.indexId, 101);
  assert.equal(m.content, "你好");
  assert.equal(m.senderId, "u2");
  assert.equal(m.username, "球球的主人");
  assert.equal(m.date, "今天");
  assert.equal(m.timestamp, "10:00");
  assert.equal(m.saved, true);
  assert.equal(m.distributed, true);
  assert.equal(m.deleted, false);
  assert.equal(m.failure, false);
  assert.equal(m.disableReactions, true, "现网没有消息表情回应，别让用户点了没反应");
});

t("T7 撤回：deleted=true 且正文清空（组件显示灰色占位，文案走 text-messages）", () => {
  const m = rowToMessage({ ...base, body: "说错话了", deleted_at: iso(new Date(2026, 9, 22, 10, 5)) });
  assert.equal(m.deleted, true);
  assert.equal(m.content, "");
});

t("T8 发送失败 → failure；待发 → 单灰勾（saved=false）", () => {
  const f = rowToMessage({ ...base, failed: true });
  assert.equal(f.failure, true);
  assert.equal(f.distributed, false);
  const p = rowToMessage({ ...base, pending: true });
  assert.equal(p.saved, false);
  assert.equal(p.distributed, false);
});

t("T9 图片消息：无正文时占位 [图片]；撤回后连占位都不给", () => {
  assert.equal(rowToMessage({ ...base, body: "", image_path: "u/a.png" }).content, "[图片]");
  const rec = rowToMessage({ ...base, body: "", image_path: "u/a.png", deleted_at: iso(NOW) });
  assert.equal(rec.content, "");
  assert.equal(rec.deleted, true);
});

t("T10 消息列表：去重、按 id 升序、只留最近 limit 条（裁最旧）", () => {
  const rows = [5, 3, 4, 4, 2, 1].map((id) => ({ ...base, id, body: "m" + id }));
  const all = rowsToMessages(rows);
  assert.deepEqual(all.map((m) => m.indexId), [1, 2, 3, 4, 5]);
  const patched = rowsToMessages([
    { ...base, id: 8, body: "old", created_at: todayAt(8) },
    { ...base, id: 8, body: "recalled", created_at: todayAt(8), deleted_at: todayAt(9) },
  ]);
  assert.equal(patched.length, 1);
  assert.equal(patched[0].deleted, true, "同 id 后到的撤回/确认行要覆盖先到的旧正文");
  assert.equal(patched[0].content, "", "撤回后的正文不能还是旧消息");
  const head = rowsToMessages(rows, { limit: 3 });
  assert.deepEqual(head.map((m) => m.indexId), [3, 4, 5], "limit 要保留最新的，裁最旧");
  assert.deepEqual(rowsToMessages(null), []);
  assert.deepEqual(rowsToMessages([{ body: "没有 id" }, null]), []);
});

/* ───────── 微信式本地缓存必须保留 ───────── */
t("T11 适配层只读缓存：SWR 会话 + IndexedDB 全量历史，且不写", () => {
  const src = read("src/proto/dm-cache.js");
  assert(/cacheKey\("dm:convs", meId\)/.test(src), "没读 SWR 会话缓存（dm:convs|<meId>）");
  assert(/cachePeek\(/.test(src), "没用 cachePeek（SWR 先画陈旧数据）");
  assert(/idbLoad\(convId\)/.test(src), "没读 IndexedDB 全量历史");
  assert(!/cacheSet\(|cachePatch\(|idbMerge\(|idbDrop\(/.test(src), "适配层不许写缓存（写路径仍在 MessagesView）");
});

t("T12 现网缓存三层仍在：dmStore 首帧层 / SWR 会话层 / IndexedDB 全量层", () => {
  const view = read("src/views/MessagesView.vue");
  assert(/dmStoreLoad\(/.test(view), "首帧同步层 dmStore 被删了");
  assert(/swr\(\s*\n?\s*cacheKey\("dm:convs"/.test(view), "会话列表不再走 SWR（离线首屏会白）");
  assert(/cachePatch\(cacheKey\("dm:convs"/.test(view), "会话预览不再回写 SWR（重开看不到最新一条）");
  assert(/idbMerge\(/.test(view) && /idbOlderThan\(/.test(view) && /idbServerDone\(/.test(view),
    "IndexedDB 全量历史的三件事（写/上滑翻页/回填完成）缺了");
  const idb = read("src/utils/dmIdb.js");
  assert(/wp-dm-full/.test(idb), "IndexedDB 库名变了（老用户的本地历史会读不到）");
  assert(/SOFT_CAP = 20000/.test(idb), "全量库软上限被改了");
});

t("T13 纯映射层零依赖（Node 可直接测、也能被别的页面复用）", () => {
  const raw = read("src/utils/dmMap.js");
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");   /* 只看代码，不看注释 */
  assert(!/^import /m.test(src), "dm-map.js 里不该有 import（保持纯函数）");
  assert(!/document\.|window\.|localStorage|indexedDB/.test(src), "纯映射层混进了环境依赖");
});

t("T14 待发（负数 id）排最后：不能因为 id 小就跑到聊天顶部", () => {
  const rows = [{ ...base, id: 251, body: "旧" }, { ...base, id: -179, body: "刚发", pending: true }];
  const out = rowsToMessages(rows);
  assert.deepEqual(out.map((m) => m._id), ["251", "-179"], "待发行必须排在最后");
  assert.ok(out[1].indexId > out[0].indexId, "indexId 要接在最后一条正式消息后面");
  const multi = rowsToMessages([{ ...base, id: 5 }, { ...base, id: -3, body: "a" }, { ...base, id: -2, body: "b" }]);
  assert.deepEqual(multi.map((m) => m._id), ["5", "-3", "-2"], "多条待发按发送顺序排");
});

t("T15 显示顺序按 created_at，不按 id：晚确认的旧消息不能跑到今天后面", () => {
  const y = new Date(Date.now() - 86400000);
  y.setHours(16, 4, 0, 0);
  const oldRow = { ...base, id: 300, body: "昨天 16:04", created_at: y.toISOString() };
  const newRow = { ...base, id: 200, body: "今天 14:33", created_at: todayAt(14, 33) };
  const out = rowsToMessages([newRow, oldRow]);
  assert.deepEqual(out.map((m) => m._id), ["300", "200"], "时间早的必须在前，哪怕 id 更大");
  assert.equal(out[0].date, "昨天");
  assert.equal(out[1].date, "今天");
});

t("T16 旧时间的待发/失败行也不能被 limit 裁掉（VAC 与旧版同一口径）", () => {
  const old = new Date(Date.now() - 3 * 86400000).toISOString();
  const rows = Array.from({ length: 301 }, (_, i) => ({
    ...base,
    id: i + 1,
    body: "m" + (i + 1),
    created_at: new Date(Date.now() - (300 - i) * 60000).toISOString(),
  }));
  rows.push({ ...base, id: -9, body: "失败草稿", pending: true, created_at: old });
  const limited = rowsToMessages(rows, { limit: 300 });
  assert.equal(limited.length, 300, "limit 仍生效");
  assert.equal(limited[limited.length - 1]._id, "-9", "失败草稿必须留在最后");
  assert.ok(!limited.some((m) => m._id === "1"), "最老正式行应被裁掉");
});

t("T17 待发行跨日压在末尾时，VAC 日期分隔也不能倒挂", () => {
  const y = new Date(Date.now() - 86400000);
  y.setHours(23, 59, 0, 0);
  const today = { ...base, id: 10, body: "今天", created_at: todayAt(0, 1) };
  const pending = { ...base, id: -1, body: "昨天发的失败草稿", pending: true, created_at: y.toISOString() };
  const mapped = rowsToMessages([today, pending]);
  assert.deepEqual(mapped.map((m) => m._id), ["10", "-1"], "待发行仍在最后");
  assert.equal(mapped[1].date, mapped[0].date, "失败草稿归到最后一天，不能今天后又插昨天");
});

t("T18 数字/字符串 id 视为同一条，不能上屏两行", () => {
  const mapped = rowsToMessages([
    { ...base, id: 7, body: "num" },
    { ...base, id: "7", body: "str" },
  ]);
  assert.equal(mapped.length, 1);
  assert.equal(mapped[0]._id, "7");
});

t("T19 乐观行与确认行共用稳定 key：同 key 只留确认后的正数行", () => {
  const mapped = rowsToMessages([
    { ...base, id: -9, body: "hello", pending: true, key: 12.5 },
    { ...base, id: 9, body: "hello", key: 12.5 },
  ]);
  assert.equal(mapped.length, 1, "同一次发送不能因为 id 变了就上屏两行");
  assert.equal(mapped[0]._id, "9");
  assert.equal(mapped[0].indexId, 12.5);
});

console.log(out.join("\n"));
console.log(`\ndm-map-test: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
