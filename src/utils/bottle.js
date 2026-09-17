/* 温暖漂流瓶（#6）：纯规则 + 云操作封装
 * ------------------------------------------------------------
 * 玩法：写信投进「温暖的海」，其他用户随机捞起，可以回信，也可以放回海里。
 * 规则（明牌告知用户，服务端是权威）：
 *   - 每天最多写 BOTTLE_SEND_MAX（3）封、捞 BOTTLE_FISH_MAX（7）封（UTC 日，与暖心墙同口径）；
 *   - 捞起的信 48 小时不处理（不回也不放回）会自动漂回海里，不让海里的信卡死；
 *   - 自己捞不到自己投的信；回信只有写信人能看到。
 * 云端实现在 MIGRATION_bottle.sql（两张表 + 6 个 security definer RPC），
 * 走网关时由 Worker /api/bottle/* 收口（见 worker/api.js）。
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
  if (msg.includes("bottle-limit-fish")) return "bottle.errFishLimit";
  if (msg.includes("bottle-empty-sea")) return "bottle.errEmpty";
  if (msg.includes("bottle-not-holder")) return "bottle.errNotHolder";
  if (msg.includes("bottle-too-long")) return "bottle.errTooLong";
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
