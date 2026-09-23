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
import { keys, removeItem } from "./storage.js";

export const BOTTLE_SEND_MAX = 3;                 /* 每天最多写几封 */
export const BOTTLE_FISH_MAX = 7;                 /* 每天最多捞几封 */
export const BOTTLE_BODY_MAX = 1000;              /* 字数放宽：信与回信同限 */
export const BOTTLE_HOLD_TTL_MS = 48 * 3600 * 1000; /* 捞起后 48h 不处理自动回海 */

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
 * 启动页（App.vue prefetchBottle）与首页三联（BottleView 的 immediate watch）会对
 * 同一批接口各发一次请求——不合并就是双份流量 + 竞态覆盖。这里把**正在进行**的
 * 同 key 请求合并成同一个 Promise：预热发的那次就是界面等到的那次。
 * 只合并在途请求：不缓存、不写存储、不复用**已完成**的结果（轮 37 口径不变：
 * 一切以服务端此刻返回为准；回信/投递后的 syncQuota 一定是新请求，不会读到旧值）。 */
const flights = new Map();
export function singleFlight(key, fn) {
  const hit = flights.get(key);
  if (hit) return hit;
  const p = Promise.resolve().then(fn).finally(() => { flights.delete(key); });
  flights.set(key, p);
  return p;
}

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

/** 我捞到、还没回的信（换页/刷新后找回来）；轮 41：与预热单飞合并 */
export function bottleHeld() {
  return singleFlight("held", () => db.bottleHeld());
}

/** 今日已用次数（服务端权威，UTC 日）：{ sent, fished }（轮 18：跨端不再打架；轮 41：与预热单飞合并） */
export function bottleQuota() {
  return singleFlight("quota", () => db.bottleQuota());
}

/** 漂流瓶记录：p_mine=true 我发布的 / false 我捞到的 / null 原行为；limit 每页条数（#17）
 *  轮 41：同参数在途请求单飞合并（分页参数不同 = 不同 key，互不影响） */
export function bottleRecords(id = null, offset = 0, { mine = null, limit = 0 } = {}) {
  return singleFlight(`rec:${id}|${offset}|${mine}|${limit}`,
    () => db.bottleRecords(id, offset, { mine, limit }));
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
