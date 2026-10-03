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

/** 轮 157：轮询尾部增量合并（替代「msgs = 尾部 N 条」的整段替换——那会把翻过的历史冲掉）
 * ------------------------------------------------------------
 * tailAsc：尾部若干条（旧→新）。规则：
 *  ① 已见过的 id → 原位更新（撤回/失败标记等字段能刷进来）；字段没变就不动数组（不触发重渲染）；
 *  ② 没见过的 id → 追加，插到乐观临时消息（id<0，发送中）之前——临时消息永远压尾部；
 *  ③ 返回 { rows, added }：无变化时 rows 与入参同引用（Vue 不会重渲染）；added = 是否有新消息落地。
 */
export function mergeTail(existing, tailAsc) {
  const cur = Array.isArray(existing) ? existing : [];
  const tail = Array.isArray(tailAsc) ? tailAsc : [];
  if (!tail.length) return { rows: cur, added: false };
  const curIdx = new Map(cur.map((m, i) => [m.id, i]));
  let rows = cur;
  let copied = false;
  let added = false;
  for (const m of tail) {                       /* ① 原位更新 */
    const i = curIdx.get(m.id);
    if (i == null) continue;
    if (rows[i] !== m && JSON.stringify(rows[i]) !== JSON.stringify(m)) {
      if (!copied) { rows = cur.slice(); copied = true; }
      rows[i] = m;
    }
  }
  for (const m of tail) {                       /* ② 追加新行 */
    if (curIdx.has(m.id)) continue;
    if (!copied) { rows = cur.slice(); copied = true; }
    const at = rows.findIndex((x) => x.id < 0);
    if (at >= 0) rows.splice(at, 0, m); else rows.push(m);
    added = true;
  }
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
