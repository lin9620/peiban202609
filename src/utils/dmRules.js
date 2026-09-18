/* 私信业务规则（纯函数，阶段 4）
 * ------------------------------------------------------------
 * 与 wallRules.js / comments.js 同一哲学：所有「能不碰网络就算出来」的判断都放这里，
 * 视图层（MessagesView / dm.js）只做装配 —— 因此每一条都能单测（tools/dm-test.mjs）。
 * 常量约定（与 MIGRATION_dm_notifications.sql 同源）：
 *   📷 = 纯图片消息的预览占位；⟲ = 最新一条被撤回后的预览占位。
 */

export const RECALL_WINDOW_MS = 15 * 60 * 1000; // 撤回窗口：15 分钟（与 dm_recall 的 interval 一致）
export const BODY_MAX = 2000;                   // 单条正文上限（与 dm_messages 约束一致）
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
  const t = Date.parse(msg.created_at);
  if (!Number.isFinite(t)) return false;
  return nowMs - t <= RECALL_WINDOW_MS;
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
  return messages.filter(
    (m) => m && m.sender !== meId && !m.deleted_at && (m.id || 0) > (lastReadId || 0),
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

/** 日期分隔标签的判定：跨天则显示新日期（local 时区；跨年带年份） */
export function dayKey(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 消息流 → 带日期分隔标记的序列（[type:day|msg]），供视图层渲染 */
export function withDayDividers(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const out = [];
  let prev = "";
  for (const m of list) {
    const k = dayKey(m && m.created_at);
    if (k && k !== prev) {
      out.push({ type: "day", key: k, ts: m.created_at });
      prev = k;
    }
    out.push({ type: "msg", key: `m${m.id}`, msg: m });
  }
  return out;
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
