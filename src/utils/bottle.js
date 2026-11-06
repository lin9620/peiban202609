/* 温暖漂流瓶（#6）：纯规则 + 云操作封装
 * ------------------------------------------------------------
 * 玩法：写信投进「温暖的海」，其他用户随机捞起，可以回信，也可以放回海里。
 * 规则（明牌告知用户，服务端是权威）：
 *   - 过去 24 小时最多写 BOTTLE_SEND_MAX（5）封（滚动 24h，不再按 UTC 自然日）；
 *   - 过去 24 小时最多捞 BOTTLE_PICK_MAX（30）瓶；捞起就记 1 次，放回也照记，
 *     所以不能靠「放回→立刻再捞」免费换一批；
 *   - 回信另计：过去 24 小时最多回 BOTTLE_FISH_MAX（7）封；捞信本身不占回信额度；
 *   - 放回后没有时间冷却，可以立刻再捞（但同一封信 7 天内不会再发给你）；
 *   - 手里压着 7 封未回时先回信/放回，再捞新的（防无限囤信，服务端 bottle-limit-hold）；
 *   - 捞起的信 48 小时不处理（不回也不放回）会自动漂回海里，不让海里的信卡死；
 *   - 自己捞不到自己投的信；双方任一方拉黑，都不会再互相捞到/回信；
 *   - 内容质量：至少 BOTTLE_BODY_MIN（10）个字，同一用户 24h 内不能重复发同一段内容。
 * 云端实现在 MIGRATION_bottle_fair_quota.sql（公平捞取 + 24h 滚动额度），
 * 基础表/其它 RPC 见 MIGRATION_bottle.sql，走网关时由 Worker /api/bottle/* 收口。
 */
import { cloud } from "./supabase.js";
import { db } from "./api/db.js";
import { detectContentLang, preferredLang } from "./contentLang.js";
import { guardWrite } from "./maintenance.js";
import { keys, removeItem } from "./storage.js";

export const BOTTLE_SEND_MAX = 5;                 /* 滚动 24h 最多写几封（轮 305：3 → 5） */
export const BOTTLE_PICK_MAX = 30;                /* 滚动 24h 最多捞几瓶；放回也照记，防免费换一批 */
export const BOTTLE_FISH_MAX = 7;                 /* 滚动 24h 最多回几封；回信才占这个额度 */
export const BOTTLE_BODY_MIN = 10;                /* 内容质量：一封信至少 10 个字符 */
export const BOTTLE_BODY_MAX = 1000;              /* 字数放宽：信与回信同限 */
export const BOTTLE_HOLD_TTL_MS = 48 * 3600 * 1000; /* 捞起后 48h 不处理自动回海 */
export const BOTTLE_TITLE_MAX = 42;               /* 轮398：列表标题只留信文前缀，避免全文重复 */

/** 按 Unicode 码点计数（与 PG 的 char_length 同口径，emoji 不会被算成两个字符）。 */
export function bottleBodyChars(text) {
  return Array.from(String(text || "")).length;
}

/**
 * 轮398：把信文压成一行标题。
 * - 换行/连续空白折成单空格，避免 summary 被撑成多行；
 * - 按 Unicode 码点截断，emoji 不会被切成半个；
 * - 超长才补「…」，短信用原文。
 */
export function bottleLetterExcerpt(body, max = BOTTLE_TITLE_MAX) {
  const text = String(body || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const n = Math.max(1, Math.floor(Number(max) || BOTTLE_TITLE_MAX));
  const chars = Array.from(text);
  return chars.length > n ? chars.slice(0, n).join("").trimEnd() + "…" : text;
}

/* 老版本的本地次数账本键（轮 37 起已废弃，只用于清理） */
const QUOTA_LEGACY_KEY = "warm-paws-bottle-quota-v1";

/**
 * 轮 37：全线上 —— 清掉老版本留在家里的漂流瓶本地数据。
 * 老版本有两份本机数据：次数账本 `warm-paws-bottle-quota-v1:<uid>` 与 SWR 快照
 * `wp-cache:v1:bottle:…`。现在次数只认服务端 bottle_quota()、托盘与记录都现拉，
 * 这两份已无人读取，但留在设备上会在排查时误导（「都改成线上了，怎么本机还有一本账」），
 * 所以进页面时顺手清掉。只删漂流瓶前缀，不碰私信/通知等其它缓存。
 * @returns {number} 清掉的键数（测试与排查用）
 */
export function purgeLegacyBottleLocals() {
  let n = 0;
  for (const prefix of [QUOTA_LEGACY_KEY, "wp-cache:v1:bottle:"]) {
    for (const k of keys(prefix)) { removeItem(k); n++; }
  }
  return n;
}

/* ═══════════ 轮 41 · 单飞合并（让「启动期预热」有意义）═════════════
 * 实现已挪到 utils/inflight.js（轮 266：私信会话列表也要用）；这里保留导出
 * 使 bottle.js 既有调用方零改动。语义见 inflight.js 头注。
 * 注：必须「import 再 export」而非 re-export 语法——后者无本地绑定，
 * tools/undef-check.mjs 会把 bottle.js 内的使用判成未定义（实测误报）。 */
import { singleFlight, dropFlight } from "./inflight.js";
export { singleFlight };

/* 轮 338 · 只读接口超时：线上实测漂流瓶记录偶发 20~45s 不返回（Worker/上游链路卡住），
 * 旧代码没有超时 → 「正在找回漂流瓶记录……」永远转，刷新键还被 disabled 卡死。
 * 只包**只读**接口（记录 / 托盘 / 次数）；写操作绝不套超时（服务端可能已经落库）。
 * 超时同时把这趟单飞扔掉 —— 用户点「刷新记录」才是真的重发，而不是拿回同一个卡住的 Promise。
 * 网关侧 db.gateway 另有请求级超时（那条路走 Worker）；这里与后端实现无关，两边都管用。 */
const READ_TIMEOUT = 15000;
function withTimeout(p, ms, onTimeout = null) {
  let timer = 0;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => {
      try { if (onTimeout) onTimeout(); } catch (e) { /* 丢飞行失败也不影响报错 */ }
      const err = new Error("timeout");
      err.timeout = true;
      rej(err);
    }, ms);
  });
  return Promise.race([p, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

/** 漂流瓶要登录（信要能找到作者、回信要能送到人） */
export function canBottle() {
  return !!(cloud.ready && cloud.user);
}

/** RPC raise 的 message / Worker 的错误码 → i18n key（两边的字符串必须与 SQL/Worker 一致） */
export function bottleErrKey(e) {
  const msg = String((e && e.message) || e || "");
  /* 轮 338：15s 读超时（见 withTimeout）——单独一句，别混进泛泛的「海浪大」 */
  if ((e && e.timeout) || msg === "timeout" || /timeout/i.test(msg)) return "bottle.errTimeout";
  if (msg.includes("bottle-limit-send")) return "bottle.errSendLimit";
  if (msg.includes("bottle-limit-hold")) return "bottle.errHoldLimit";
  /* 注意顺序：先比 limit-hold / limit-pick，再无歧义地比 limit-fish（前缀不同，无覆盖风险） */
  if (msg.includes("bottle-limit-pick")) return "bottle.errPickLimit";
  if (msg.includes("bottle-limit-fish")) return "bottle.errFishLimit";
  if (msg.includes("bottle-empty-sea")) return "bottle.errEmpty";
  if (msg.includes("bottle-not-holder")) return "bottle.errNotHolder";
  if (msg.includes("bottle-blocked")) return "bottle.errBlocked";
  if (msg.includes("bottle-too-short")) return "bottle.errTooShort";
  if (msg.includes("bottle-duplicate")) return "bottle.errDuplicate";
  if (msg.includes("bottle-empty-body") || msg.includes("empty-body")) return "bottle.errEmptyBody";
  if (msg.includes("bottle-too-long")) return "bottle.errTooLong";
  if (msg.includes("bottle-chat-blocked")) return "bottle.chatBlocked";
  if (msg.includes("bottle-not-owner") || msg.includes("bottle-not-answered")) return "bottle.chatUnavailable";
  /* 轮 444：维护期写入被触发器拦下（errcode PT503 / message 'maintenance-mode'）。
   * 必须排在「没跑迁移」之前判断 —— 两者都会带英文技术原因，混淆了用户会以为要修库。 */
  if (/maintenance-mode|PT503/i.test(msg)) return "bottle.errMaintenance";
  /* 没跑迁移：列/RPC 不存在。真实响应里码在 error.code，消息是
     「Could not find the function … in the schema cache」——两句都要认 */
  if (/42703|PGRST202|does not exist/i.test(msg) || /could not find the function/i.test(msg)) return "bottle.chatSetup";
  return "bottle.errGeneric";
}

/* ══════════ 云操作（失败时把错误抛给调用方展示，次数与状态由服务端裁定） ══════════ */

/** 投一封信进海里；返回投出的那封 */
export async function bottleSend(body) {
  /* 轮 444：维护期先拦一道（抛 maintenance-mode，调用方用 bottleErrKey 得到准确文案） */
  if (!guardWrite()) throw new Error("maintenance-mode");
  const text = String(body || "").trim();
  if (!text) throw new Error("bottle-empty-body");
  const chars = bottleBodyChars(text);
  if (chars < BOTTLE_BODY_MIN) throw new Error("bottle-too-short");
  if (chars > BOTTLE_BODY_MAX) throw new Error("bottle-too-long");
  /* 轮 439：信本身的语言（不是写信人的界面语言）。'prefer' 模式下读者优先捞同语言的信。 */
  return db.bottleSend(text, detectContentLang(text));
}

/** 从海里随机捞一封（不是自己的）；没有可捞的信时抛 bottle-empty-sea */
export async function bottleFish() {
  /* 轮 444：捞信会写 bottle_fishes（记录谁捞过哪封），维护期同样被拦 ——
   * 这里先给准确文案，别让用户以为是「海里没信了」。 */
  if (!guardWrite()) throw new Error("maintenance-mode");
  /* 轮 439：服务端先在本语言池里捞，池空自己退回全语言 —— 不会因为语言偏好捞不到。 */
  return db.bottleFish(preferredLang());
}

/** 给手里这封写回信（只有持有者能回；回信只会送到写信人手里） */
export async function bottleReply(id, reply) {
  if (!guardWrite()) throw new Error("maintenance-mode");
  const text = String(reply || "").trim();
  if (!text) throw new Error("bottle-empty-body");
  if (bottleBodyChars(text) > BOTTLE_BODY_MAX) throw new Error("bottle-too-long");
  return db.bottleReply(id, text);
}

/** 不想回，放回海里 */
export async function bottleRelease(id) {
  return db.bottleRelease(id);
}

/** 我投的信（含收到的回信），新→旧 */
export async function bottleMine() {
  return withTimeout(db.bottleMine(), READ_TIMEOUT);
}

/** 我捞到、还没回的信（换页/刷新后找回来）；轮 41：与预热单飞合并 */
export function bottleHeld() {
  return withTimeout(singleFlight("held", () => db.bottleHeld()), READ_TIMEOUT, () => dropFlight("held"));
}

/** 过去 24 小时已用次数（服务端权威）：{ sent, fished, picked }
 *  - sent   已投几封
 *  - picked 已捞几瓶（含已放回）
 *  - fished 已回几封（回信才计）
 *  轮 41：与预热单飞合并。 */
export function bottleQuota() {
  return withTimeout(singleFlight("quota", () => db.bottleQuota()), READ_TIMEOUT, () => dropFlight("quota"));
}

/** 漂流瓶记录：p_mine=true 我发布的 / false 我捞到的 / null 原行为；limit 每页条数（#17）
 *  轮 41：同参数在途请求单飞合并（分页参数不同 = 不同 key，互不影响）
 *  轮 338：15s 超时（超时丢单飞，见 withTimeout 头注） */
export function bottleRecords(id = null, offset = 0, { mine = null, limit = 0 } = {}) {
  const key = `rec:${id}|${offset}|${mine}|${limit}`;
  return withTimeout(
    singleFlight(key, () => db.bottleRecords(id, offset, { mine, limit })),
    READ_TIMEOUT,
    () => dropFlight(key),
  );
}

export function bottleChatDecide(id, accept) {
  if (typeof accept !== "boolean") throw new Error("bottle-bad-decision");
  return db.bottleChatDecide(id, accept);
}

/** 仅作者能决定，双方都能进入已建立的会话；最终权限由数据库裁定。
 *  轮 18 拆出两个中间态（此前一律显示「漂流中」，用户看到信被捞走却毫无指引）：
 *    picked = 我发布的信被 TA 捞起、还没回信（等回信，回信后我决定开不开聊）
 *    inhand = 我捞起、还没回的信（在我手里，快回） */
export function bottleChatState(row, userId) {
  if (!row || !userId || (row.user_id !== userId && row.reply_by !== userId)) return "unavailable";
  if (row.chat_decision === "accepted" && row.conv_id) return "accepted";
  if (row.chat_decision === "declined") return "declined";
  if (row.status === "held") return row.user_id === userId ? "picked" : "inhand";
  if (row.status !== "answered") return "drifting";
  return row.user_id === userId ? "choose" : "waiting";
}

/* 轮 144 · 「我发布的」记录排序（电脑端漂流瓶页用户口径）：
 * 待我处理的（收到回信 · 同意或拒绝聊天 = choose 态）置顶，其余维持服务端时间新→旧。
 * Array.sort 是稳定的 → 同档内保持原时间序；只动内存顺序，不碰服务端分页与数据。 */
export function sortBottleMine(rows, userId) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  const rank = (l) => (bottleChatState(l, userId) === "choose" ? 0 : 1);
  return list.sort((a, b) => rank(a) - rank(b));
}

/** 「我发布的」里有多少封在等我点「愿意，开始聊天」——红点/角标的唯一口径。 */
export function bottlePendingCount(rows, userId) {
  return (Array.isArray(rows) ? rows : [])
    .filter((l) => bottleChatState(l, userId) === "choose").length;
}

/** 记录分页：总页数至少 1（空列表也显示第 1 / 1 页，不把 pager 画成 0 页）。 */
export function bottlePageCount(total, pageSize) {
  const n = Math.max(0, Math.floor(Number(total) || 0));
  const size = Math.max(1, Math.floor(Number(pageSize) || 1));
  return Math.max(1, Math.ceil(n / size));
}

/** 0 基页码钳位：首页/尾页/手输页码都先过这里，避免越界切片。 */
export function clampBottlePage(page, total, pageSize) {
  const pages = bottlePageCount(total, pageSize);
  return Math.min(Math.max(0, Math.floor(Number(page) || 0)), pages - 1);
}

/** 取某一页（0 基）；切片规则只此一份，BottleView 和测试共用。 */
export function bottlePageSlice(rows, page, pageSize) {
  const list = Array.isArray(rows) ? rows : [];
  const size = Math.max(1, Math.floor(Number(pageSize) || 1));
  const p = clampBottlePage(page, list.length, size);
  return list.slice(p * size, p * size + size);
}
