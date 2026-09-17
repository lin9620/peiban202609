/* 私信业务层（阶段 4）
 * ------------------------------------------------------------
 * 视图（MessagesView / store）只调这里的函数；真正碰云端统一走 api/db.js 适配层。
 * 原则与 wall.js 一致：云端不可用 / 未登录直接给「可降级」的返回值，绝不白屏。
 */
import { db } from "./api/db.js";
import { canRecall } from "./dmRules.js";

/** 云端就绪且已登录（私信的全部入口都以此为闸） */
export function dmReady() {
  return db.ready();
}

/** 找或建会话，返回 conv_id；抛错由调用方按 sendErrKey 映射 */
export async function openConv(otherId) {
  const r = await db.dmOpen(otherId);
  return r && r.conv_id;
}

/** 会话列表（新→旧；db 侧已排序，这里兜底再排一次以防实现差异） */
export async function listConvs(limit = 100, offset = 0) {
  return db.dmListConvs(limit, offset);
}

/** 单会话元信息（深链进入用） */
export async function convMeta(convId) {
  return db.dmConvMeta(convId);
}

/** 消息分页：返回新→旧；视图层 reverse 后展示 */
export async function listMessages(convId, { before = null, limit = 30 } = {}) {
  return db.dmListMessages(convId, before, limit);
}

/** 发送。返回插入结果；错误上抛（调用方 sendErrKey 映射成 i18n） */
export async function send(convId, body, image = null) {
  return db.dmSend(convId, body, image);
}

/** 抬已读水位（进入会话 / 收到新消息时） */
export async function markRead(convId) {
  return db.dmMarkRead(convId);
}

/** 隐藏 / 取消隐藏 / 免打扰 / 接受消息请求 */
export async function hide(convId) { return db.dmHide(convId); }
export async function unhide(convId) { return db.dmUnhide(convId); }
export async function mute(convId, on = true) { return db.dmMute(convId, on); }
export async function accept(convId) { return db.dmAccept(convId); }

/** 撤回：先本地判窗口（省一次 RPC），再调服务端（服务端仍是权威） */
export async function recall(msg, meId) {
  if (!canRecall(msg, meId)) {
    const e = new Error("too-late");
    throw e;
  }
  return db.dmRecall(msg.id);
}

/** 拉黑 / 解除 / 名单 */
export async function block(userId) { return db.dmBlock(userId); }
export async function unblock(userId) { return db.dmUnblock(userId); }
export async function blocks() { return db.dmBlocks(); }

/** 未读总览（导航角标轮询用） */
export async function unreadTotal() {
  return db.dmUnreadTotal();
}

/** 图片消息：走同一 IMAGE_BUCKET（复用 wall 的上传约定，路径 <uid>/dm-<ts>） */
export { db };
