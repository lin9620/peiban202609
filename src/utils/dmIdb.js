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

/* 轮 376：同一会话的读-改-写必须串行。applyTail / tick / backfillOlder 可能同时
 * idbMerge，旧写法各自 idbLoad 再 putRecord 会互相覆盖（后写的把先写的一页丢掉）。 */
const queues = new Map();
function enqueue(convId, fn) {
  const key = String(convId);
  const prev = queues.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  queues.set(key, run);
  const clean = () => { if (queues.get(key) === run) queues.delete(key); };
  run.then(clean, clean);
  return run;
}

/** 轮 376：重发/确认后摘掉本地临时行（负数 id），避免全量镜像里留下重复行。 */
export function idbRemoveRows(convId, ids) {
  return enqueue(convId, async () => {
    try {
      const rec = await idbLoad(convId);
      const drop = new Set((ids || []).map((x) => String(x)));
      const msgs = (rec && Array.isArray(rec.msgs) ? rec.msgs : [])
        .filter((m) => m && !drop.has(String(m.id)));
      await putRecord(convId, { ...rec, msgs: mergeRows([], msgs) });
    } catch (e) { /* 本地库不可用：静默 */ }
  });
}

/** 按 id 去重合并并升序裁剪（纯逻辑，可测） */
export function mergeRows(existing, rows, softCap = SOFT_CAP) {
  const map = new Map();
  /* 旧记录可能把 msgs 存成对象/字符串；不能直接 for-of 抛错，否则整次镜像静默失败。
   * 轮 377：id 数字/字符串统一按 String 归一，避免同一行在 IDB 里存两份。 */
  for (const m of Array.isArray(existing) ? existing : []) if (m && m.id != null) map.set(String(m.id), m);
  for (const m of Array.isArray(rows) ? rows : []) if (m && m.id != null) map.set(String(m.id), m);
  let msgs = [...map.values()].sort((a, b) => a.id - b.id);
  if (msgs.length > softCap) {
    /* 轮378：负数待发/失败行按 id 升序排在最前，旧写法 slice(-cap) 会先裁掉它们。
     * 先保住失败草稿，再裁最旧正式行；草稿本身超过上限时也只留最新的那些。 */
    const drafts = msgs.filter((m) => Number(m.id) < 0);
    const positives = msgs.filter((m) => Number(m.id) >= 0);
    const keepDrafts = drafts.length > softCap ? drafts.slice(drafts.length - softCap) : drafts;
    const keepPos = positives.slice(-Math.max(0, softCap - keepDrafts.length));
    msgs = keepDrafts.concat(keepPos).sort((a, b) => a.id - b.id);
  }
  return msgs;
}

/** 轮377：回填游标只认数值；字符串 id 不能按字典序取最小。 */
export function olderWatermark(rows, prev) {
  const start = prev != null && Number.isFinite(Number(prev)) ? Number(prev) : null;
  return (Array.isArray(rows) ? rows : []).reduce((m, r) => {
    const id = r && r.id != null ? Number(r.id) : NaN;
    if (!Number.isFinite(id) || id <= 0) return m;
    return m == null || id < m ? id : m;
  }, start);
}

/** 合并一批消息进全量库（去重保序）；older=true 时更新回填游标 */
export function idbMerge(convId, rows, { older = false, serverDone = null } = {}) {
  return enqueue(convId, async () => {
    try {
      /* 轮 376：旧版在 rows 为空时直接 return，导致 backfillOlder 的
       * idbMerge(convId, [], { serverDone: true }) 永远不落库 —— serverDone 永远 false，
       * 每次进会话都重跑回填，hasMore 也永远当「还有更早」。空页 + serverDone 必须允许写。 */
      const list = Array.isArray(rows) ? rows : [];
      if (!list.length && serverDone == null) return;
      const rec = await idbLoad(convId);
      if (list.length) rec.msgs = mergeRows(rec.msgs, list);
      if (older && list.length) {
        /* 轮377：id 可能是字符串；Math.min/字典序会把 "999" 和 "1000" 比反，
         * 回填游标卡在较大值上，下一页又拉回同一段。统一 Number 后取最小。 */
        const oldest = olderWatermark(list, rec.backfilledTo);
        if (oldest != null) rec.backfilledTo = oldest;
      }
      if (serverDone != null) rec.serverDone = serverDone;
      await putRecord(convId, rec);
    } catch (e) { /* 静默降级 */ }
  });
}

/** 取比 beforeId 更早的最多 limit 条（升序；IDB 优先供页） */
/* 轮377：网关可能回字符串 id。旧写法 m.id < beforeId 在两个字符串时会按字典序比较，
 * "9" < "100" 会判成 false，导致翻历史漏页；这里统一 Number 后再比。 */
export function olderRows(msgs, beforeId, limit = 30) {
  const before = Number(beforeId);
  if (!Number.isFinite(before)) return [];
  const older = (Array.isArray(msgs) ? msgs : []).filter((m) => {
    const id = Number(m && m.id);
    return Number.isFinite(id) && id > 0 && id < before;
  });
  return older.slice(Math.max(0, older.length - limit));
}

export async function idbOlderThan(convId, beforeId, limit = 30) {
  const rec = await idbLoad(convId);
  /* 轮 376：只把**正式行**当历史页。失败/待发的负数 id 行会被 mergeRows 排在前面，
   * 旧写法 filter(m.id < beforeId) 会把它们当成「更早一页」塞进分页，造成重复/乱序。
   * 旧记录/手改记录可能没有 msgs 或不是数组，不能在这里 TypeError（会让 loadMore 直接失败）。 */
  const all = rec && Array.isArray(rec.msgs) ? rec.msgs : [];
  return olderRows(all, beforeId, limit);
}

/** 该会话更早历史是否已被服务器侧穷尽（回填跑完过） */
export async function idbServerDone(convId) {
  const rec = await idbLoad(convId);
  return !!rec.serverDone;
}

/** 删会话时清全量库 */
export function idbDrop(convId) {
  return enqueue(convId, async () => {
    try {
      const db = await open();
      if (!db) return;
      await new Promise((res, rej) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).delete(String(convId));
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
    } catch (e) { /* 静默 */ }
  });
}
