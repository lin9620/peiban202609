/* 轮 355 · 私信「列表有新消息，点进会话却要等好几秒」回归
 *   node tools/dm-tail-cache-test.mjs
 *
 * 病根：会话列表的预览由 dm_list_convs / 实时刷新，点进会话时 loadMessages
 * **只读本地库**（dmStore → IndexedDB），本地库没有这条新消息，就只能等
 * dm_list_messages 跨境往返（用户实测好几秒）。
 *
 * 修法：
 *   ① 别的会话收到实时 INSERT → cacheIncoming 把这条并进该会话本地库；
 *   ② 当前会话收到实时 INSERT → 直接拿实时行 applyTail 上屏，不再多绕一次网络；
 *   ③ 轮询/实时并进当前会话的新消息，也整窗落本地库（旧版只在 loadMessages/send 落）。
 *
 * 本锁：A. dmStoreAppend 纯逻辑（只给已有历史的会话追加，绝不把一条尾部当完整历史）；
 *       B. MessagesView 三处接线（非当前会话缓存 / 当前会话直上屏 / 尾部落库）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { dmStoreLoad, dmStoreSave, dmStoreAppend, dmStoreUpsert, dmStoreReplace, dmStoreRemove, dmStoreDrop } from "../src/utils/dmStore.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("PASS ", name); }
  else { fail++; console.log("FAIL ", name, extra ? "→ " + extra : ""); }
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);

console.log("── A. dmStoreAppend：只给已有历史的会话追加 ──");

/* 已有历史：追加新消息，排序、去重、more 保持 */
dmStoreDrop("u1", "c1");
dmStoreSave("u1", "c1", [
  { id: 1, body: "old-1" },
  { id: 2, body: "old-2" },
], true);
ok("A1 有历史时追加成功", dmStoreAppend("u1", "c1", { id: 3, body: "new" }) === true);
eq("A2 追加后仍是升序、新消息在尾部", dmStoreLoad("u1", "c1").msgs.map((m) => m.id), [1, 2, 3]);
ok("A3 more 保持原值", dmStoreLoad("u1", "c1").more === true);

/* 同 id 再来（实时重投）→ 原位更新，不重复 */
ok("A4 重复 id 仍返回写入", dmStoreAppend("u1", "c1", { id: 3, body: "new-edited" }) === true);
eq("A5 重复 id 不产生第二行", dmStoreLoad("u1", "c1").msgs.map((m) => m.id), [1, 2, 3]);
eq("A6 重复 id 用新内容覆盖", dmStoreLoad("u1", "c1").msgs[2].body, "new-edited");
dmStoreSave("u1", "c1", [{ id: 3, body: "dup-old" }, { id: 3, body: "dup-new" }], true);
eq("A6b 直接整窗保存也按 id 去重（同一条只留一行）", dmStoreLoad("u1", "c1").msgs.map((m) => m.id), [3]);
eq("A6c 去重保留最后写入的字段", dmStoreLoad("u1", "c1").msgs[0].body, "dup-new");
dmStoreSave("u1", "c1", [{ id: 5, body: "num" }, { id: "5", body: "str" }], true);
eq("A6d 数字/字符串 id 也按同一条去重", dmStoreLoad("u1", "c1").msgs.map((m) => String(m.id)), ["5"]);
eq("A6e 数字/字符串 id 去重保留最后字段", dmStoreLoad("u1", "c1").msgs[0].body, "str");

/* 没有历史：绝不写。否则进会话先看到孤零零一条，网络回来的更早记录会被追加到它后面 */
dmStoreDrop("u1", "c2");
ok("A7 无历史时不写（返回 false）", dmStoreAppend("u1", "c2", { id: 9, body: "only" }) === false);
eq("A8 无历史时本地库仍为空", dmStoreLoad("u1", "c2").msgs, []);

/* 轮377：只有负数失败草稿不是“历史”。否则实时尾部一写，本地库就有正数行，
 * 进会话时 IDB 全量首帧被跳过，只剩一条孤零零的实时消息。 */
dmStoreSave("u1", "c3", [{ id: -1, body: "draft", pending: false, failed: true }], true);
ok("A7b 只有失败草稿时实时尾部不写", dmStoreAppend("u1", "c3", { id: 10, body: "tail" }) === false);
ok("A8b 失败草稿保留且没有混入实时尾部", (() => {
  const m = dmStoreLoad("u1", "c3").msgs;
  return m.length === 1 && String(m[0].id) === "-1";
})());
dmStoreDrop("u1", "c3");

/* 脏参数 */
ok("A9 缺 me/conv/row 不炸且不写", dmStoreAppend("", "c1", { id: 4 }) === false
  && dmStoreAppend("u1", "", { id: 4 }) === false
  && dmStoreAppend("u1", "c1", null) === false);
ok("A10 row.id 为空不写", dmStoreAppend("u1", "c1", { body: "no-id" }) === false);

console.log("");
console.log("── A2. dmStoreUpsert：发送确认行，无历史也要落库 ──");

dmStoreDrop("u1", "c3");
ok("A11 无历史时发送确认行仍写入", dmStoreUpsert("u1", "c3", { id: 9, body: "sent", created_at: "2026-10-29T14:33:00Z" }) === true);
eq("A12 无历史也能读到刚确认的消息", dmStoreLoad("u1", "c3").msgs.map((m) => m.id), [9]);
ok("A13 重复确认不产生第二行", dmStoreUpsert("u1", "c3", { id: 9, body: "sent-edited" }) === true
  && dmStoreLoad("u1", "c3").msgs.length === 1
  && dmStoreLoad("u1", "c3").msgs[0].body === "sent-edited");
ok("A14 缺参数/无 id 不写", dmStoreUpsert("", "c3", { id: 10 }) === false
  && dmStoreUpsert("u1", "", { id: 10 }) === false
  && dmStoreUpsert("u1", "c3", { body: "no-id" }) === false);
dmStoreSave("u1", "bad-rows", [{ id: 2 }, { id: 1 }, null, {}], true);
const badRows = dmStoreLoad("u1", "bad-rows");
ok("A15 本地库混进 null / 无 id 坏行也不炸，读时过滤", badRows.msgs.map((m) => m.id).join(",") === "1,2");

dmStoreDrop("u1", "pending");
dmStoreUpsert("u1", "pending", { id: -7, body: "sending", pending: true });
ok("A16 负数乐观行先落本地库（发完马上重进也看得见）", dmStoreLoad("u1", "pending").msgs[0].id === -7);
dmStoreReplace("u1", "pending", -7, { id: 77, body: "sent", created_at: "2026-10-29T14:34:00Z" });
eq("A17 确认后负数行被正数行换掉，不留两条", dmStoreLoad("u1", "pending").msgs.map((m) => m.id), [77]);
dmStoreUpsert("u1", "pending", { id: -8, body: "failed", failed: true });
dmStoreRemove("u1", "pending", -8);
eq("A18 重发前能摘掉旧失败行", dmStoreLoad("u1", "pending").msgs.map((m) => m.id), [77]);

dmStoreDrop("u1", "cap");
dmStoreSave("u1", "cap", Array.from({ length: 401 }, (_, i) => ({ id: i + 1 })), false);
ok("A19 真裁过 400 条时 more 必须为 true（否则永远翻不动更早历史）", dmStoreLoad("u1", "cap").more === true);

dmStoreDrop("u1", "bad-rows");
dmStoreDrop("u1", "pending");
dmStoreDrop("u1", "cap");

dmStoreDrop("u1", "c1");
dmStoreDrop("u1", "c2");
dmStoreDrop("u1", "c3");

console.log("");
console.log("── B. MessagesView 接线 ──");
const mv = read("src/views/MessagesView.vue");

/** 切一个函数的完整体：从签名到下一个顶层声明（与 dm-race-test 同口径） */
function fnBody(src, signature) {
  const i = src.indexOf(signature);
  if (i < 0) return "";
  const stops = ["\nasync function ", "\nfunction ", "\nconst ", "\nlet ", "\nwatch(", "\nonMounted(", "\nonActivated(", "\nonDeactivated(", "\nonBeforeUnmount(", "\n</script>"];
  const cuts = stops.map((s) => src.indexOf(s, i + signature.length)).filter((v) => v > 0);
  return cuts.length ? src.slice(i, Math.min(...cuts)) : src.slice(i);
}
const at = fnBody(mv, "function applyTail(");

ok("B1 引入 dmStoreAppend", /import \{[^}]*dmStoreAppend[^}]*\} from "\.\.\/utils\/dmStore\.js"/.test(mv));
ok("B2 cacheIncoming 把实时行写进 dmStore", /dmStoreAppend\((?:meId\.value|owner), cid, row\)/.test(mv));
ok("B3 cacheIncoming 只在 IDB 已有历史时镜像", /const rec = await idbLoad\(cid\);[\s\S]{0,240}?rec\.msgs\.length[\s\S]{0,120}?idbMerge\(cid, \[row\]\)/.test(mv));
ok("B4 非当前会话收到实时消息先 cacheIncoming", /return;\s*\}\s*cacheIncoming\(cid, row\)\.catch/.test(mv));
ok("B5 当前会话直接用实时行 applyTail，不再 pullTail 多绕网络",
  /if \(!applyTail\(cid, \[row\]\)\) cacheIncoming\(cid, row\)/.test(mv)
    && !/if \(activeId\.value && String\(activeId\.value\) === cid\) \{\s*pullTail\(cid\)/.test(mv));
ok("B6 applyTail 收到新行后整窗落 dmStore", at.length > 100 && /dmStoreSave\(meId\.value, cid, msgs\.value, hasMore\.value\)/.test(at));
ok("B7 applyTail 收到新行后镜像 IDB", at.length > 100 && /idbMerge\(cid, msgs\.value\)/.test(at));
ok("B8 applyTail 只处理当前会话且 msgs 确实装着它",
  /String\(activeId\.value\) !== String\(cid\) \|\| msgsConv !== cid/.test(mv));
ok("B9 pullTail 仍保留过期守卫", /const mySeq = msgSeq;[\s\S]{0,200}?isStale\(mySeq, cid\)/.test(mv));
ok("B10 loadMessages 仍先读本地库再走网络", /const local = dmStoreLoad\(meId\.value, cid\)/.test(mv));

const sd = fnBody(mv, "async function send(");
ok("B11 发送确认后切走也写该会话本地库，并把负数乐观行换掉",
  /dmStoreReplace\(meId\.value, convId, temp\.id, rowSrv\)/.test(sd) && /idbMerge\(convId, \[rowSrv\]\)/.test(sd));
ok("B12 同会话刷新一律 mergeTail，不再因待发行整窗替换",
  /} else if \(msgsConv === cid\) \{[\s\S]{0,900}?const \{ rows: merged, added \} = mergeTail\(msgs\.value, asc\)/.test(mv)
    && !/msgsConv === cid && !msgs\.value\.some\(\(m\) => m\.id < 0\)/.test(mv));
ok("B13 同会话读本地库只补缺，不整窗替换也不倒灌旧正文",
  /const sameConv = msgsConv === cid && msgs\.value\.length > 0;[\s\S]{0,500}?const extra = local\.msgs\.filter\(\(m\) => m\.id > 0 && !have\.has\(String\(m\.id\)\)\)/.test(mv));
ok("B14 尾部行补出正数 id 后要更新分页锚点",
  /oldestId\.value = oldestServerId\(msgs\.value\);/.test(at));
ok("B15 当前会话新消息要跟手更新列表预览归属",
  /last_sender: latestRow\.sender \|\| crow\.last_sender,/.test(at)
    && /convLocal\.set\(cid, \{ \.\.\.\(convLocal\.get\(cid\) \|\| \{\}\), \.\.\.patch \}\);/.test(at));
ok("B16 同会话重开：内存已有消息就直接揭示，不等网络",
  /if \(before == null && msgsConv === cid && msgs\.value\.length\) \{[\s\S]{0,160}?entryReady\.value = true;/.test(mv));
ok("B17 同会话重开顺手回写内存窗口（本地库被清/网络失败也不白屏）",
  /if \(before == null && msgsConv === cid && msgs\.value\.length\) \{[\s\S]{0,500}?dmStoreSave\(meId\.value, cid, msgs\.value, hasMore\.value\)/.test(mv));
ok("B18 乐观行发出去立刻落本地库，不等 RPC 回来", /dmStoreUpsert\((?:meId\.value|owner), convId, temp\)/.test(sd));
ok("B19 首屏整窗替换也保留已确认的正数行，不只保负数乐观行",
  /const snap = dropEchoedPending\(asc\);/.test(mv)
  && /const claimed = claimPendingEcho\(msgs\.value, snap\);/.test(mv)
  && /const keep = claimed\.rows\.filter\(\(m\) => !incoming\.has\(String\(m\.id\)\)\)/.test(mv));
ok("B20 发送确认预览按服务端时间比新旧，晚到的旧确认不盖新预览",
  /function bumpConvPreview\(convId, text, at = "", sender = meId\.value\)/.test(mv)
    && /if \(ts < convLatestAt\(cid\)\) return;/.test(mv));
ok("B21 实时旧行只进消息库，不把列表预览盖回去",
  /const rowAt = Date\.parse\(row\.created_at \|\| ""\) \|\| 0;/.test(mv)
    && /if \(crow && rowAt >= convLatestAt\(cid\)\)/.test(mv));
ok("B22 切走后发送失败也要落第一句失败草稿",
  /dmStoreUpsert\(meId\.value, convId, failedRow\);[\s\S]{0,220}?idbMerge\(convId, \[failedRow\]\)/.test(sd));
ok("B23 异常网关无 msg_id / 乐观行已被清屏摘掉时也补失败行，不永远发送中",
  /if \(!sent\) \{ refreshBadge\(\); return; \}/.test(sd)
    && /msgs\.value\.some\(\(m\) => String\(m\.id\) === String\(temp\.id\)\)\s*\?[\s\S]{0,180}?failedRow[\s\S]{0,180}?: msgs\.value\.concat\(\[failedRow\]\)/.test(sd));
ok("B24 发送确认后等 IDB 期间切走，不拿新会话的 msgs 改旧锚点",
  /msgsConv === convId\) oldestId\.value = oldestServerId\(msgs\.value\)/.test(sd));
ok("B25 撤回预览不被撤回前的旧服务端快照盖回（服务端撤回不改时间戳）",
  /loc\.preview_rev && srv <= loc2/.test(mv)
    && /loc\.recalled_from == null \|\| raw\.last_preview === loc\.recalled_from/.test(mv)
    && /preview_rev: Date\.now\(\)/.test(mv));
ok("B28 本地库只有失败草稿时，也要从 IDB 顶出完整历史",
  /before == null && meId\.value[\s\S]{0,80}?!msgs\.value\.some\(\(m\) => Number\(m\.id\) > 0\) \|\| thinLocal/.test(mv));

ok("B27 撤回行不在本地库时，也要把它算进「最后一条」判断，预览才能变已撤回",
  /dmStoreUpsert\(owner, convId, patch\);[\s\S]{0,260}?bumpConvRecall\(convId, patch, cur\.msgs\.concat\(\[patch\]\)\)/.test(mv));

ok("B26 会话列表 fresh 回写的是合并后的本地补丁，不是服务端旧快照",
  /const merged = withBlockedTombstones\(mergeLocalConvs\(rows\)\);[\s\S]{0,500}?cacheSet\(cacheKey\("dm:convs", owner\), merged\);/.test(mv));

ok("B29 发消息时会话行还没建，也要立刻插占位行，不等 loadMeta/15s 轮询",
  /function bumpConvPreview[\s\S]{0,1500}?else convs\.value = \[stub, \.\.\.convs\.value\]/.test(mv)
    && /cachePatch\(cacheKey\("dm:convs", meId\.value\)[\s\S]{0,260}?\{ createIfMissing: true \}/.test(mv));

ok("B30 loadMeta 回来只补昵称/对方 id，不拿空预览和新时间覆盖刚发消息",
  (() => {
    const i = mv.indexOf("async function loadMeta");
    const body = i >= 0 ? mv.slice(i, i + 2400) : "";
    return /last_message_at: \(hit && hit\.last_message_at\) \|\| new Date\(\)\.toISOString\(\)/.test(body)
      && /writeConvRow\(row\)/.test(body);
  })());

ok("B31 同一时间戳服务端预览还是空，不能盖掉本地刚发正文",
  /srv === loc2 && loc\.last_preview && !r\.last_preview/.test(mv)
    && /sameTimeEmptyPreview/.test(mv));

console.log("");
console.log(`TOTAL ${pass + fail}  PASS ${pass}  FAIL ${fail}`);
process.exit(fail ? 1 : 0);
