/* 通知中心业务层（阶段 4）
 * ------------------------------------------------------------
 * 同 dm.js：视图只调这里，云端访问走 api/db.js；未登录给可降级返回值。
 */
import { db } from "./api/db.js";
import { normUnread, prefsPayload } from "./notifyRules.js";

export function notifyReady() {
  return db.ready();
}

/** 通知分页：tab = all|comments|reactions|pets|dms|system（kinds 映射在 notifyRules）
 *  轮 360：db 适配层契约参数名是 `unread`（对应 RPC 的 p_unread / 网关的 &unread=1）。
 *  这里把视图层的 `unreadOnly` 翻译过去；两边曾各叫各的，导致 p_unread 永远 false，
 *  「只看未读 / 看全部」按钮只换文案、列表不变。 */
export async function page({ offset = 0, limit = 30, kinds = null, unreadOnly = false } = {}) {
  return db.notifPage({ offset, limit, kinds, unread: unreadOnly });
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
  /* 必须传一个对象：db.notifPrefsSet 内部按 prefs.comments / prefs.reactions ... 取值。
   * 旧版这里拆成四个布尔实参，适配层拿到的是 true/false，属性全 undefined，
   * 所以「关」永远被写成 true —— 这就是设置开关点不动/重进复位的根因。 */
  return db.notifPrefsSet(prefsPayload(p));
}

/** 清空我的全部通知（RLS delete 自己的行） */
export async function clearAll() {
  return db.notifClear();
}

/** 管理员公告（非管理员得到 {admin:false}） */
export async function broadcast(body) {
  return db.adminBroadcast(body);
}
