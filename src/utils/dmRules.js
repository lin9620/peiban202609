/* 私信业务规则（纯函数，阶段 4）
 * ------------------------------------------------------------
 * 与 wallRules.js / comments.js 同一哲学：所有「能不碰网络就算出来」的判断都放这里，
 * 视图层（MessagesView / dm.js）只做装配 —— 因此每一条都能单测（tools/dm-test.mjs）。
 * 常量约定（与 MIGRATION_dm_notifications.sql 同源）：
 *   📷 = 纯图片消息的预览占位；⟲ = 最新一条被撤回后的预览占位。
 */
import { cacheKey, cachePeek, cacheSet } from "./cache.js";

export const RECALL_WINDOW_MS = 15 * 60 * 1000; // 撤回窗口：15 分钟（与 dm_recall 的 interval 一致）
export const BODY_MAX = 2000;                   // 单条正文上限（与 dm_messages 约束一致）
export const FIRST_CONTACT_LIMIT = 3;           // 陌生人首聊：对方回复前最多发 3 条（与 dm_send 的 first-limit 一致）
export const IMAGE_PLACEHOLDER = "📷";
export const RECALLED_PLACEHOLDER = "⟲";

/** 会话预览文本：后端给的 last_preview 直接用（已截 80 字）；空会话给占位 */
export function previewText(preview, t = (k) => k) {
  const s = String(preview || "");
  if (!s) return t("dm.emptyPreview");
  return s;
}

/** 是否可撤回：本人消息、未撤回、在窗口内 */
export function canRecall(msg, meId, nowMs = Date.now()) {
  if (!msg || !meId) return false;
  if (msg.sender !== meId) return false;
  if (msg.deleted_at) return false;
  /* 轮 376：在飞/失败的乐观行还没有服务端 msg_id，撤回 RPC 只会报错；
   * 旧版只在 VAC 映射层挡了一次，旧版列表仍会给失败行出「撤回」。规则收到这里。 */
  if (msg.pending || msg.failed) return false;
  if (Number(msg.id) < 0) return false;   /* 负数 = 本地临时 id，服务端没有可撤回的 msg_id */
  const t = Date.parse(msg.created_at);
  if (!Number.isFinite(t)) return false;
  return nowMs >= t && nowMs - t <= RECALL_WINDOW_MS;
}

/** 展示态：撤回的消息渲染为占位（正文 / 图片都清空） */
export function displayMsg(msg) {
  if (!msg) return msg;
  if (!msg.deleted_at) return msg;
  return { ...msg, body: "", image_path: null, recalled: true };
}

/** 未读计数（本地兜底：水位之后、对方发的、未撤回的消息数） */
export function unreadOf(messages, lastReadId, meId) {
  if (!Array.isArray(messages)) return 0;
  /* 轮381：水位/消息 id 可能是字符串；两个字符串用 > 会按字典序比（"9" > "100"），
   * 未读数会算反。水位统一转数字。 */
  const wm = Number(lastReadId) || 0;
  return messages.filter(
    (m) => m && m.sender !== meId && !m.deleted_at && (Number(m.id) || 0) > wm,
  ).length;
}

/** 会话排序：最近动静新→旧（last_message_at 缺失时用 created_at） */
export function sortConvs(convs) {
  if (!Array.isArray(convs)) return [];
  const ts = (c) => Date.parse(c.last_message_at || c.created_at || "") || 0;
  return [...convs].sort((a, b) => ts(b) - ts(a));
}

/** 会话搜索：按昵称或预览子串（不区分大小写） */
export function filterConvs(convs, q) {
  const list = Array.isArray(convs) ? convs : [];
  const key = String(q || "").trim().toLowerCase();
  if (!key) return list;
  return list.filter((c) =>
    String(c.nickname || "").toLowerCase().includes(key) ||
    String(c.last_preview || "").toLowerCase().includes(key));
}

/* ───────── 轮 337 · 本地聊天记录搜索（只读，给左列用） ─────────
 * 用户报障「搜索功能没有用」：原来只搜昵称 + 列表预览 —— 搜聊天里出现过的话
 * （比如对话里明明有「给漂流瓶加一个时间限制」）永远是空，还会显示成
 * 「还没有会话」，看起来像整个列表坏了。
 * 这里只做纯函数：从 IndexedDB 读出来的 msgs 里找子串，返回命中条数 +
 * 一条能放在列表行里显示的片段。索引/缓存/异步都在页面层（MessagesView）。 */

/** 命中片段：关键词前后各留 span 个字，两端超出的补省略号（列表行只放得下一行） */
export function hitSnippet(body, q, span = 18) {
  const text = String(body || "");
  const key = String(q || "").trim();
  if (!text || !key) return "";
  const i = text.toLowerCase().indexOf(key.toLowerCase());
  if (i < 0) return "";
  const start = Math.max(0, i - span);
  const end = Math.min(text.length, i + key.length + span);
  return (start > 0 ? "…" : "") + text.slice(start, end).replace(/\s+/g, " ") + (end < text.length ? "…" : "");
}

/** 在一批消息里搜关键词：{ count, snippet, lastAt } / null
 *  - 撤回（deleted_at）和空正文不算命中（图片消息没有正文，搜不到）
 *  - 只扫最近 limit 条：全量库单会话最多 2 万条，搜索不能把主线程拖住
 *  - lastAt 取**最新**一条命中，用来显示「最近一次说到」 */
export function searchRows(rows, q, { limit = 2000 } = {}) {
  const key = String(q || "").trim().toLowerCase();
  if (!key) return null;
  const list = Array.isArray(rows) ? rows : [];
  const from = Math.max(0, list.length - Math.max(1, limit));
  let count = 0, snippet = "", lastAt = "";
  for (let i = from; i < list.length; i++) {
    const m = list[i];
    if (!m || m.deleted_at) continue;
    const body = String(m.body || "");
    if (!body || !body.toLowerCase().includes(key)) continue;
    count++;
    const at = String(m.created_at || "");
    if (!lastAt || at > lastAt) { lastAt = at; snippet = hitSnippet(body, q); }
  }
  return count ? { count, snippet, lastAt } : null;
}

/** 日期分隔标签的判定：跨天则显示新日期（local 时区；跨年带年份） */
export function dayKey(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/* 轮 376：消息按「发送时间」升序，id/key 只做同一毫秒的稳定次序。
 * 旧版 VAC 路径已按 created_at 排，但旧版列表（?ui=legacy）仍直接吃 msgs 原数组；
 * 确认行晚回来、补拉历史、实时行插入都可能让原数组暂时不是时间序 —— 日期分隔
 * 就会「今天 → 昨天 → 今天」倒着走。排序放在日期分隔之前，两条路径同一口径。 */
export function sortMsgRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const ts = (m) => {
    const t = Date.parse(m && m.created_at);
    return Number.isFinite(t) ? t : 0;
  };
  return list.slice().sort((a, b) => {
    const ap = a && a.id < 0 ? 1 : 0;
    const bp = b && b.id < 0 ? 1 : 0;
    if (ap !== bp) return ap - bp;                 /* 发送中的临时行永远压尾部 */
    const at = ts(a), bt = ts(b);
    if (at !== bt) return at - bt;
    const ai = Number(a && a.id) || 0, bi = Number(b && b.id) || 0;
    if (ai !== bi) return ai - bi;
    return (Number(a && a.key) || 0) - (Number(b && b.key) || 0);
  });
}

/** 消息流 → 带日期分隔标记的序列（[type:day|msg]），供视图层渲染 */
export function withDayDividers(messages) {
  const list = sortMsgRows(messages);
  const out = [];
  let prev = "";
  let prevTs = 0;
  for (const m of list) {
    /* 轮 376：坏行（null / 没有 id）不能把整个聊天页渲染炸掉。 */
    if (!m || m.id == null) continue;
    const k = dayKey(m.created_at);
    const t = Date.parse(m.created_at) || 0;
    /* 轮 377：待发/失败行压在末尾，但 created_at 可能早于最后一条已确认消息
     * （跨午夜/时钟偏差）。此时再插“昨天”分隔符会排在“今天”后面，日期倒挂；
     * 只对不早于当前分隔日的时间点开新分隔。 */
    if (k && k !== prev && (m.id > 0 || t >= prevTs)) {
      out.push({ type: "day", key: k, ts: m.created_at });
      prev = k;
    }
    if (t > prevTs) prevTs = t;
    out.push({ type: "msg", key: `m${m.id}`, msg: m });
  }
  return out;
}

/** 轮 352：给乐观消息取一个「确认后也不变」的行 key（排在最后一条正式消息之后的小数位）
 * ------------------------------------------------------------
 * 组件（vue-advanced-chat）只把消息的 indexId 当 v-for key。乐观行的临时 id 是负数，
 * 确认回写时换成服务端 id —— key 一变，TransitionGroup 就把同一句当成「旧行淡出 + 新行淡入」：
 * 列表先多一行（旧行留 200ms）再缩回，还多触发一次 onMessageAdded 的滚底 = 用户实报
 * 「发送消息之后，成功了会跳」。这里在发送时就把 key 定下来（= 现有最大 id/key 之后 +0.001），
 * 确认行沿用同一个 key → 组件原地更新那一行，不重挂、不滚动。
 */
/** 当前窗口里最大的正式消息 id（负数乐观行不算）。发送时记进临时行，作为
 * 「这次回显一定比它新」的下限：重开 App 后同一快照里同时留下 pending + 确认行时，
 * 不再靠 5s 时钟差去猜，也不会把用户几十秒前同一句话的旧消息当成这次回显。 */
export function maxPositiveId(rows) {
  let mx = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r) continue;
    const n = Number(r.id);
    if (Number.isFinite(n) && n > mx) mx = n;
  }
  return mx;
}

export function nextMsgKey(rows) {
  let mx = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r) continue;
    const a = Number(r.id) || 0;
    const b = Number(r.key) || 0;
    if (a > mx) mx = a;
    if (b > mx) mx = b;
  }
  return Math.round((mx + 0.001) * 1000) / 1000;   /* 定到 3 位小数：连发不漂移、key 仍严格递增 */
}

/** 轮 377：发送 RPC 超时/没回 msg_id，但服务端其实已经插入时，尾部/实时快照里会出现
 *  一条同发送人、同正文的新正式行。用它来认领乐观行，避免把已经成功的那条又标成失败，
 *  用户看到「一条已发 + 一条红色失败」两条。
 *
 *  beforeIds：发送前列表里已有的 id（String）。只在「发送前不存在的新行」里找，
 *  防止把用户上一条同样正文的消息误认成本次回显。
 *  如果还有更早的同正文待发行，说明这次不是最老的一条，也不认领（防连发同文错配）。 */
export function findSentEcho(rows, temp, beforeIds = null) {
  const list = Array.isArray(rows) ? rows : [];
  const t = temp || {};
  const tSender = String(t.sender || "");
  const tBody = String(t.body || "");
  const tAt = Date.parse(t.created_at) || 0;
  const tKey = t.key != null && t.key !== "" ? String(t.key) : "";
  const before = beforeIds instanceof Set ? beforeIds : new Set(beforeIds || []);
  /* 发送前列表里最大的正式 id；服务端新插入的行 id 一定更大（bigserial），
   * 比拿本机时间判断回显更稳（设备时钟可能偏几分钟）。 */
  let beforeMax = 0;
  for (const id of before) {
    const n = Number(id);
    if (Number.isFinite(n) && n > beforeMax) beforeMax = n;
  }
  const olderPending = list.some((m) => m && m.id < 0 && m.pending
    && String(m.sender || "") === tSender
    && String(m.body || "") === tBody
    && (Date.parse(m.created_at) || 0) < tAt);
  if (olderPending) return null;
  return list.find((m) => {
    if (!m || Number(m.id) <= 0 || Number(m.id) <= beforeMax || m.deleted_at || m.failed) return false;
    if (before.has(String(m.id))) return false;
    if (String(m.sender || "") !== tSender) return false;
    if (String(m.body || "") !== tBody) return false;
    if ((t.image_path || null) !== (m.image_path || null)) return false;
    /* 轮381：连发两条同文时，后一条的确认行带着自己的稳定 key。若候选行的 key
     * 明确属于另一条待发行，绝不能拿来认领这一条（否则两条发送只剩一行，
     * 另一条被标失败/消失）。服务端原行没有 key，仍按正文+新 id 认领。 */
    const mKey = m.key != null && m.key !== "" ? String(m.key) : "";
    if (tKey && mKey && tKey !== mKey) return false;
    return true;
  }) || null;
}

/** 轮 157：轮询尾部增量合并（替代「msgs = 尾部 N 条」的整段替换——那会把翻过的历史冲掉）
 * ------------------------------------------------------------
 * tailAsc：尾部若干条（旧→新）。规则：
 *  ① 已见过的 id → 原位更新（撤回/失败标记等字段能刷进来）；字段没变就不动数组（不触发重渲染）；
 *  ② 没见过的 id → 追加，插到乐观临时消息（id<0，发送中）之前——临时消息永远压尾部；
 *  ③ 返回 { rows, added }：无变化时 rows 与入参同引用（Vue 不会重渲染）；added = 是否有新消息落地。
 */
/* 轮378：发送超时后进程被杀/重开，本地会留下负数失败草稿；服务端其实已经插入同一条。
 * 重进时网络尾部和失败草稿同时存在，旧代码会画成“失败 + 已发送”两行。
 * 只在服务端行与草稿同发送者、同正文/图片，且时间不早于草稿（允许 60s 时钟偏差）
 * 时才认领；不按纯正文去重，避免把用户更早发过的同一句话误删。 */
export function dropEchoedDrafts(rows, fresh, windowMs = 10 * 60 * 1000) {
  const list = Array.isArray(rows) ? rows : [];
  const incoming = Array.isArray(fresh) ? fresh : [];
  const pos = incoming.filter((m) => m && Number(m.id) > 0);
  if (!pos.length) return list;
  const drop = new Set();
  for (const m of list) {
    if (!m || !(Number(m.id) < 0) || !m.failed) continue;
    const mt = Date.parse(m.created_at) || 0;
    if (!mt) continue;
    const body = String(m.body || "");
    const img = String(m.image_path || "");
    const sender = String(m.sender || "");
    const mk = m.key != null && m.key !== "" ? String(m.key) : "";
    const hit = pos.some((p) => {
      if (String(p.sender || "") !== sender) return false;
      if (String(p.body || "") !== body) return false;
      if (String(p.image_path || "") !== img) return false;
      const pk = p.key != null && p.key !== "" ? String(p.key) : "";
      /* 轮378：同一句话一分钟内发两次（先成功、后失败）时，不能拿前一条的
       * 回显把后一条失败草稿误删。两边都有稳定行 key 时只认同一 key。 */
      if (mk && pk) return mk === pk;
      const pt = Date.parse(p.created_at) || 0;
      if (!pt) return false;
      /* 有 key 的草稿只容忍 5s 时钟差；没有 key 的旧草稿才用 60s 宽窗。 */
      const slack = mk ? 5 * 1000 : 60 * 1000;
      return pt >= mt - slack && pt <= mt + windowMs;
    });
    if (hit) drop.add(String(m.id));
  }
  return drop.size ? list.filter((m) => !drop.has(String(m.id))) : list;
}

/* 轮382：实时 INSERT 往往比 dm_send 的 HTTP 回包先到。屏上此时已经有负数乐观行，
 * 旧逻辑把正式行插到它前面 → 同一句话短暂显示两条，弱网下能挂好几秒。
 * 这里在尾部正式行里找「发送人/正文/图片相同、时间相近」的待发行，用正式行原位换掉它。
 *
 * 只认 pending（发送中），不碰 failed 草稿（失败草稿由 dropEchoedDrafts 处理）；
 * 两边都有稳定 key 时必须一致，避免连发两条同文时把另一条吃掉。
 * 时间窗用 60s 容差 + 10min 上限：设备时钟偏几分钟也不会把更早的同文消息误认。 */
export function claimPendingEcho(rows, fresh, { windowMs = 10 * 60 * 1000, slackMs = 60 * 1000 } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const incoming = Array.isArray(fresh) ? fresh : [];
  const pend = [];
  list.forEach((m, i) => {
    if (m && Number(m.id) < 0 && m.pending && !m.failed) pend.push({ m, i });
  });
  if (!pend.length) return { rows: list, claimed: false };
  const have = new Set(list.map((m) => (m && m.id != null ? String(m.id) : "")));
  const used = new Set();
  let out = null;
  for (const p of incoming) {
    if (!p || Number(p.id) <= 0 || p.deleted_at || p.failed) continue;
    const pid = String(p.id);
    if (have.has(pid)) continue;
    const pKey = p.key != null && p.key !== "" ? String(p.key) : "";
    const pId = Number(p.id) || 0;
    const pAt = Date.parse(p.created_at) || 0;
    let best = null, bestDelta = Infinity, bestAt = Infinity;
    for (const cand of pend) {
      if (used.has(cand.i)) continue;
      const t = cand.m;
      if (String(t.sender || "") !== String(p.sender || "")) continue;
      if (String(t.body || "") !== String(p.body || "")) continue;
      if ((t.image_path || null) !== (p.image_path || null)) continue;
      const tKey = t.key != null && t.key !== "" ? String(t.key) : "";
      if (tKey && pKey && tKey !== pKey) continue;
      const sameKey = !!(tKey && pKey && tKey === pKey);
      /* 临时行记了发送前的最大正式 id：回显必须是之后插入的新行。这样即便设备
       * 时钟比服务器快/慢，也不会把发送前同正文的旧消息认成本次回显。 */
      const floor = Number(t.before_max) || 0;
      if (!sameKey && floor > 0 && pId <= floor) continue;
      const tAt = Date.parse(t.created_at) || 0;
      /* 带 key 且没有 id 下限的旧临时行，只容忍 5s，防把刚发过的同文旧消息吃掉；
       * 有新 id 下限时，旧消息已经被 id 排除，时间窗可以放宽处理设备时钟偏差。 */
      if (!sameKey) {
        if (!pAt || !tAt) continue;
        const slack = tKey && !floor ? Math.min(slackMs, 5 * 1000) : slackMs;
        if (pAt < tAt - slack || pAt > tAt + windowMs) continue;
      }
      const d = Math.abs((pAt || 0) - (Date.parse(t.created_at) || 0));
      /* 同文连发时优先认时间最近的一条；完全同一毫秒再认更早的待发行（FIFO）。 */
      if (d < bestDelta || (d === bestDelta && tAt < bestAt)) {
        best = cand;
        bestDelta = d;
        bestAt = tAt;
      }
    }
    if (!best) continue;
    used.add(best.i);
    if (!out) out = list.slice();
    out[best.i] = pKey ? p : { ...p, key: best.m.key };
    have.add(pid);
  }
  return out ? { rows: out, claimed: true } : { rows: list, claimed: false };
}

/** 同一份快照里同时有「待发行」和「它的确认行」时，摘掉待发行。
 * 首页快照（localStorage/IDB）可能在上一条 RPC 还没回来时同时写入了两边；
 * 只靠 id 去重看不出来（id 一负一正），组件会画成“发送中”+“已发送”两行。 */
export function dropEchoedPending(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const pend = list.filter((m) => m && Number(m.id) < 0 && m.pending && !m.failed);
  if (!pend.length) return list;
  const pos = list.filter((m) => m && Number(m.id) > 0 && !m.deleted_at && !m.failed);
  if (!pos.length) return list;
  const claimed = claimPendingEcho(pend, pos);
  if (!claimed.claimed) return list;
  const drop = new Set();
  for (let i = 0; i < pend.length; i++) {
    if (claimed.rows[i] !== pend[i]) drop.add(pend[i]);
  }
  return drop.size ? list.filter((m) => !drop.has(m)) : list;
}

export function mergeTail(existing, tailAsc) {
  const cur = Array.isArray(existing) ? existing : [];
  const tail = Array.isArray(tailAsc) ? tailAsc : [];
  if (!tail.length) return { rows: cur, added: false };
  /* 轮382：先把「实时先到的正式行」和屏上的待发行对上，避免同一条短暂两行。 */
  const claim = claimPendingEcho(cur, tail);
  let rows = claim.rows;
  let copied = claim.claimed;
  let added = claim.claimed;
  const curIdx = new Map();
  /* 轮 377：服务端/RPC/本地缓存的 id 可能是数字或字符串，统一按 String 认同一行，
   * 否则 12 和 "12" 会各追加一次。 */
  rows.forEach((m, i) => { if (m && m.id != null && !curIdx.has(String(m.id))) curIdx.set(String(m.id), i); });
  for (const m of tail) {                       /* ① 原位更新 */
    if (!m || m.id == null) continue;
    const i = curIdx.get(String(m.id));
    if (i == null) continue;
    /* 轮 352：服务端行没有本地 key —— 直接换掉等于把行 key 变一次，组件重挂那一行
       （淡出淡入 + 可能再滚一次底）。key 跟着行走，其余字段仍由服务端整行覆盖。 */
    const prev = rows[i];
    const next = prev && prev.key != null && m.key == null ? { ...m, key: prev.key } : m;
    if (prev !== next && JSON.stringify(prev) !== JSON.stringify(next)) {
      if (!copied) { rows = cur.slice(); copied = true; }
      rows[i] = next;
    }
  }
  for (const m of tail) {                       /* ② 追加新行 */
    if (!m || m.id == null || curIdx.has(String(m.id))) continue;
    if (!copied) { rows = cur.slice(); copied = true; }
    const at = rows.findIndex((x) => x && x.id < 0);
    if (at >= 0) rows.splice(at, 0, m); else rows.push(m);
    /* 轮 376：同一页里若网关重复给了同一条，第一遍追加后必须记进索引，
     * 否则第二遍还会再追加一条（旧版只在 curIdx 里查已有行）。 */
    curIdx.set(String(m.id), at >= 0 ? at : rows.length - 1);
    added = true;
  }
  /* 轮378：网络尾部/实时回显到达后，顺手认领重启前留下的失败草稿。 */
  const kept = dropEchoedDrafts(rows, tail);
  if (kept !== rows) rows = kept;
  return { rows, added };
}

/* ──────── 轮 157b：会话消息「窗口缓存」 ────────
 * 首屏 SWR 一直有（最近 30 条本地直出），但翻过的历史页不进缓存，且全局缓存护栏只有
 * 60 条、会话一多聊天快照就被挤掉——用户要的是「下次打开聊天窗口，本地先把历史顶上来」。
 * 这里把本次翻到的窗口整体缓存（rows 新→旧 + more 是否还有更早），旧版纯数组快照兼容读。
 * 两个聊天视图（会话段 / 漂流瓶段）与发送补条都必须走这三个助手，形状才不会漂移。 */

/** 服务端分页批量（首屏一次拉多少；dmWin 兼容判定按它认「还有更早」） */
export const DM_PAGE = 30;
/** 缓存窗口上限（条）：超窗裁最旧的，localStorage 不被撑爆 */
export const DM_WINDOW_CAP = 60;

/** dm:msgs 缓存键（带用户域，换账号不串数据） */
export function dmMsgsKey(meId, convId) {
  return cacheKey("dm:msgs", meId, convId);
}

/** 归一化缓存快照 → { rows 新→旧, more }；旧版纯数组兼容；垃圾入参返回 null */
export function dmWin(v) {
  if (Array.isArray(v)) return { rows: v, more: v.length === DM_PAGE };
  if (v && Array.isArray(v.rows)) return { rows: v.rows, more: !!v.more };
  return null;
}

/** 写窗口快照（裁到 WINDOW_CAP） */
export function dmCacheWindow(meId, convId, rowsDesc, more) {
  cacheSet(dmMsgsKey(meId, convId), {
    rows: (Array.isArray(rowsDesc) ? rowsDesc : []).slice(0, DM_WINDOW_CAP),
    more: !!more,
  });
}

/** 读窗口快照（无 / 垃圾 → null） */
export function dmPeekWindow(meId, convId) {
  return dmWin(cachePeek(dmMsgsKey(meId, convId)));
}

/** 相对时间（列表时间戳）：刚刚 / N 分钟前 / N 小时前 / 昨天 / 具体日期 */
export function relativeTime(ts, nowMs = Date.now(), t = (k, v) => v) {
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms)) return "";
  const diff = Math.max(0, nowMs - ms);
  const min = Math.floor(diff / 60000);
  if (min < 1) return t("time.now");
  if (min < 60) return t("time.minAgo", { n: min });
  const h = Math.floor(min / 60);
  if (h < 24) return t("time.hourAgo", { n: h });
  const d = new Date(ms);
  const yesterday = new Date(nowMs - 86400000);
  if (d.toDateString() === yesterday.toDateString()) return t("time.yesterday");
  const sameYear = d.getFullYear() === new Date(nowMs).getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return sameYear ? `${mm}-${dd}` : `${d.getFullYear()}-${mm}-${dd}`;
}

/** 发送前校验：正文 / 图片至少其一；返回错误 i18n 键或 null */
export function validateSend(body, image) {
  const b = String(body || "").trim();
  if (!b && !image) return "dm.errEmpty";
  if (b.length > BODY_MAX) return "dm.errTooLong";
  return null;
}

/** 陌生人首聊的 3 条上限是否已锁死（发送前本地拦截，不等 dm_send 报 first-limit）。
 *
 * 判定口径与 MIGRATION_dm_first_contact.sql 一致：
 *  - 对方回复过（且未撤回）→ 已解锁，永远不拦；
 *  - 对方没回复 → 我方未撤回的已发/在飞行数到 3 就拦；失败行不算服务端条数。
 *
 * 新版会话 RPC 若附带 peer_replied / my_count 就优先用服务端的精确值；
 * 老 RPC 没有这两个字段时，只对「短会话」做本地推断 —— 首聊受限时总数必然 ≤3，
 * 而解锁后的长会话最近一屏可能全是我方消息，不能凭一屏就误判成首聊。
 */
export function firstLimitLocked(meta, msgs, meId, otherId) {
  if (!meId || !otherId) return false;
  const me = String(meId);
  const other = String(otherId);
  const hasPeerFlag = !!meta && (meta.peer_replied === true || meta.peer_replied === false);

  if (hasPeerFlag && meta.peer_replied === true) return false;

  const list = Array.isArray(msgs) ? msgs.filter(Boolean) : [];
  const seen = new Set();
  let mine = 0;
  let live = 0;
  let peerReplied = false;
  for (const m of list) {
    if (!m || m.deleted_at || m.failed) continue;
    live += 1;
    const sender = String(m.sender || "");
    if (sender === other) { peerReplied = true; continue; }
    if (sender !== me) continue;
    /* 乐观行确认前后会短暂同时存在；同一 key / id 只算一条。 */
    const key = m.key != null && m.key !== "" ? `k:${m.key}` : `id:${m.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    mine += 1;
  }
  if (peerReplied) return false;

  if (hasPeerFlag) {
    const exact = Number(meta.my_count);
    return (Number.isFinite(exact) ? Math.max(exact, mine) : mine) >= FIRST_CONTACT_LIMIT;
  }

  /* 老 RPC：只对短会话推断，避免把「对方早回过、最近 30 条全是我」误锁。
     失败行/已撤回行不占 live，历史重试留下的红「!」不会把窗口撑长。 */
  if (live > FIRST_CONTACT_LIMIT + 2) return false;
  return mine >= FIRST_CONTACT_LIMIT;
}

/** RPC 错误 → i18n 键（dm_send / dm_open 抛的错误码） */
export function sendErrKey(err) {
  const s = String((err && (err.message || err)) || "");
  if (s.includes("blocked-by-me")) return "dm.errBlockedByMe";
  if (s.includes("blocked")) return "dm.errBlocked";
  if (s.includes("first-limit")) return "dm.errFirstLimit";   // #22 首次会话 3 条限制
  if (s.includes("forbidden") || s.includes("bad-conv")) return "dm.errForbidden";
  if (s.includes("empty-message")) return "dm.errEmpty";
  if (s.includes("auth-required") || s.includes("cloud-not-ready")) return "dm.errAuth";
  if (s.includes("no-user") || s.includes("bad-target")) return "dm.errNoUser";
  return "dm.errNetwork";
}

/** 列表行展示态：被拉黑的会话不显示未读红点（硬墙语义） */
export function rowView(c) {
  if (!c) return c;
  const unread = c.blocked ? 0 : (c.unread || 0);
  return { ...c, unread };
}
