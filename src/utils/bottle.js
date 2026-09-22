/* 温暖漂流瓶（#6）：纯规则 + 云操作封装
 * ------------------------------------------------------------
 * 玩法：写信投进「温暖的海」，其他用户随机捞起，可以回信，也可以放回海里。
 * 规则（明牌告知用户，服务端是权威）：
 *   - 每天最多写 BOTTLE_SEND_MAX（3）封（UTC 日，与暖心墙同口径）；
 *   - 捞信本身**不扣次数**，**回信才计 1 次**，每天最多回 BOTTLE_FISH_MAX（7）封
 *     （轮 21 口径：用户反馈「没捞到也减次数」——捞起不计、放回不返还、回信才记账）；
 *   - 手里压着 7 封未回时先回信/放回，再捞新的（防无限囤信，服务端 bottle-limit-hold）；
 *   - 捞起的信 48 小时不处理（不回也不放回）会自动漂回海里，不让海里的信卡死；
 *   - 自己捞不到自己投的信；回信只有写信人能看到。
 * 云端实现在 MIGRATION_bottle.sql（两张表 + 6 个 security definer RPC），
 * 次数口径见 MIGRATION_bottle_reply_quota.sql，走网关时由 Worker /api/bottle/* 收口。
 */
import { cloud } from "./supabase.js";
import { db } from "./api/db.js";

export const BOTTLE_SEND_MAX = 3;                 /* 每天最多写几封 */
export const BOTTLE_FISH_MAX = 7;                 /* 每天最多捞几封 */
export const BOTTLE_BODY_MAX = 1000;              /* 字数放宽：信与回信同限 */
export const BOTTLE_HOLD_TTL_MS = 48 * 3600 * 1000; /* 捞起后 48h 不处理自动回海 */

/** 漂流瓶要登录（信要能找到作者、回信要能送到人） */
export function canBottle() {
  return !!(cloud.ready && cloud.user);
}

/** RPC raise 的 message / Worker 的错误码 → i18n key（两边的字符串必须与 SQL/Worker 一致） */
export function bottleErrKey(e) {
  const msg = String((e && e.message) || e || "");
  if (msg.includes("bottle-limit-send")) return "bottle.errSendLimit";
  if (msg.includes("bottle-limit-hold")) return "bottle.errHoldLimit";
  /* 注意顺序：先比 limit-hold 再无歧义地比 limit-fish（两者前缀不同，无覆盖风险） */
  if (msg.includes("bottle-limit-fish")) return "bottle.errFishLimit";
  if (msg.includes("bottle-empty-sea")) return "bottle.errEmpty";
  if (msg.includes("bottle-not-holder")) return "bottle.errNotHolder";
  if (msg.includes("bottle-too-long")) return "bottle.errTooLong";
  if (msg.includes("bottle-chat-blocked")) return "bottle.chatBlocked";
  if (msg.includes("bottle-not-owner") || msg.includes("bottle-not-answered")) return "bottle.chatUnavailable";
  /* 没跑迁移：列/RPC 不存在。真实响应里码在 error.code，消息是
     「Could not find the function … in the schema cache」——两句都要认 */
  if (/42703|PGRST202|does not exist/i.test(msg) || /could not find the function/i.test(msg)) return "bottle.chatSetup";
  return "bottle.errGeneric";
}

/* ══════════ 云操作（失败时把错误抛给调用方展示，次数与状态由服务端裁定） ══════════ */

/** 投一封信进海里；返回投出的那封 */
export async function bottleSend(body) {
  const text = String(body || "").trim();
  if (!text) throw new Error("bottle-empty-body");
  if (text.length > BOTTLE_BODY_MAX) throw new Error("bottle-too-long");
  return db.bottleSend(text);
}

/** 从海里随机捞一封（不是自己的）；没有可捞的信时抛 bottle-empty-sea */
export async function bottleFish() {
  return db.bottleFish();
}

/** 给手里这封写回信（只有持有者能回；回信只会送到写信人手里） */
export async function bottleReply(id, reply) {
  const text = String(reply || "").trim();
  if (!text) throw new Error("bottle-empty-body");
  if (text.length > BOTTLE_BODY_MAX) throw new Error("bottle-too-long");
  return db.bottleReply(id, text);
}

/** 不想回，放回海里 */
export async function bottleRelease(id) {
  return db.bottleRelease(id);
}

/** 我投的信（含收到的回信），新→旧 */
export async function bottleMine() {
  return db.bottleMine();
}

/** 我捞到、还没回的信（换页/刷新后找回来） */
export async function bottleHeld() {
  return db.bottleHeld();
}

/** 今日已用次数（服务端权威，UTC 日）：{ sent, fished }（轮 18：跨端不再打架） */
export function bottleQuota() {
  return db.bottleQuota();
}

/** 漂流瓶记录：p_mine=true 我发布的 / false 我捞到的 / null 原行为；limit 每页条数（#17） */
export function bottleRecords(id = null, offset = 0, { mine = null, limit = 0 } = {}) {
  return db.bottleRecords(id, offset, { mine, limit });
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
