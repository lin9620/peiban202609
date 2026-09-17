/* 通知中心业务层（阶段 4）
 * ------------------------------------------------------------
 * 同 dm.js：视图只调这里，云端访问走 api/db.js；未登录给可降级返回值。
 */
import { db } from "./api/db.js";
import { normUnread } from "./notifyRules.js";

export function notifyReady() {
  return db.ready();
}

/** 通知分页：tab = all|comments|reactions|pets|dms|system（kinds 映射在 notifyRules） */
export async function page({ offset = 0, limit = 30, kinds = null, unreadOnly = false } = {}) {
  return db.notifPage({ offset, limit, kinds, unreadOnly });
}

/** 分类未读数（含 total；导航角标取 total） */
export async function unread() {
  return normUnread(await db.notifUnread());
}

/** 「绝不抛错」版本：角标轮询失败时退化为全 0 */
export async function unreadSafe() {
  try {
    if (!db.ready()) return normUnread(null);
    return normUnread(await db.notifUnread());
  } catch (e) {
    return normUnread(null);
  }
}

/** 标记已读：ids 数组或全部 */
export async function mark({ ids = null, all = false } = {}) {
  return db.notifMark(ids, all);
}

/** 偏好读 / 写 */
export async function prefsGet() {
  return db.notifPrefsGet();
}
export async function prefsSet(p) {
  const o = p && typeof p === "object" ? p : {};
  return db.notifPrefsSet(
    o.comments !== false, o.reactions !== false, o.pets !== false, o.dms !== false,
  );
}

/** 清空我的全部通知（RLS delete 自己的行） */
export async function clearAll() {
  return db.notifClear();
}

/** 管理员公告（非管理员得到 {admin:false}） */
export async function broadcast(body) {
  return db.adminBroadcast(body);
}
