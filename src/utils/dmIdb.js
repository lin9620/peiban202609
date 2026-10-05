/* ═══ 轮 204 · 会话全量本地库（IndexedDB）═══
 * 微信式：本机存全量、优先本地、离线可翻。与 dmStore（localStorage 首帧同步层）双层并存：
 *   - dmStore：最近窗口，同步读，进会话第一帧零延迟（已有）。
 *   - 本库：全量历史（含后台回填的更早消息），异步读写，上滑翻历史时优先供给。
 * 服务器永远是真相源；本库只是本设备的加速副本（换设备不迁移，与微信一致）。
 * 隐私模式等 IndexedDB 不可用场景：全部接口静默降级为 no-op，行为退回现状。 */

const DB_NAME = "wp-dm-full";
const STORE = "convs";
/* 单会话软上限（条）：超过裁最旧。全量语义下的失控保险，正常远达不到。 */
const SOFT_CAP = 20000;

let dbp = null;
function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        try { req.result.createObjectStore(STORE); } catch (e) { rej(e); }
      };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error || new Error("idb open failed"));
    } catch (e) { rej(e); }
  }).catch(() => null);   /* 隐私模式/禁用：降级为不可用 */
  return dbp;
}

function emptyRecord() {
  return { msgs: [], backfilledTo: null, serverDone: false };
}

/** 读某会话的全量记录；不可用/无记录返回空记录（不抛错） */
export async function idbLoad(convId) {
  try {
    const db = await open();
    if (!db) return emptyRecord();
    return await new Promise((res, rej) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(String(convId));
      req.onsuccess = () => res(req.result || emptyRecord());
      req.onerror = () => rej(req.error);
    });
  } catch (e) { return emptyRecord(); }
}

async function putRecord(convId, rec) {
  const db = await open();
  if (!db) return;
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(rec, String(convId));
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  }).catch(() => { /* 静默降级 */ });
}

/** 按 id 去重合并并升序裁剪（纯逻辑，可测） */
export function mergeRows(existing, rows, softCap = SOFT_CAP) {
  const map = new Map();
  for (const m of existing || []) if (m && m.id != null) map.set(m.id, m);
  for (const m of rows || []) if (m && m.id != null) map.set(m.id, m);
  let msgs = [...map.values()].sort((a, b) => a.id - b.id);
  if (msgs.length > softCap) msgs = msgs.slice(msgs.length - softCap);   /* 裁最旧 */
  return msgs;
}

/** 合并一批消息进全量库（去重保序）；older=true 时更新回填游标 */
export async function idbMerge(convId, rows, { older = false, serverDone = null } = {}) {
  try {
    if (!rows || !rows.length) return;
    const rec = await idbLoad(convId);
    rec.msgs = mergeRows(rec.msgs, rows);
    if (older) {
      const oldest = rows.reduce((m, r) => (r && r.id != null && (!m || r.id < m)) ? r.id : m, rec.backfilledTo ?? Infinity);
      rec.backfilledTo = rec.backfilledTo == null ? oldest : Math.min(rec.backfilledTo, oldest);
    }
    if (serverDone != null) rec.serverDone = serverDone;
    await putRecord(convId, rec);
  } catch (e) { /* 静默降级 */ }
}

/** 取比 beforeId 更早的最多 limit 条（升序；IDB 优先供页） */
export async function idbOlderThan(convId, beforeId, limit = 30) {
  const rec = await idbLoad(convId);
  const older = rec.msgs.filter((m) => m.id < beforeId);
  return older.slice(Math.max(0, older.length - limit));
}

/** 该会话更早历史是否已被服务器侧穷尽（回填跑完过） */
export async function idbServerDone(convId) {
  const rec = await idbLoad(convId);
  return !!rec.serverDone;
}

/** 删会话时清全量库 */
export async function idbDrop(convId) {
  try {
    const db = await open();
    if (!db) return;
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(String(convId));
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    }).catch(() => { /* 静默 */ });
  } catch (e) { /* 静默 */ }
}
