/* ═══ 轮 194 · 私信本地消息库（每会话一份，localStorage 持久化）═══
 * 微信式架构：进会话 = 从本地库**瞬间渲染完整历史**（零网络等待、零闪跳）；
 * 后台只拉「比本地最新一条更新的增量」追加——追加不移动已有内容。
 * 取代轮 157b 的窗口缓存（那版缓存/fresh 两次渲染高度不同 = 跳闪根因）。
 * 存储走 utils/storage.js（隐私模式自动降级内存）。上限 400 条，超出裁最旧。 */
import { getJSON, setJSON, removeItem } from "./storage.js";

const KEY = (me, conv) => `wp-dm-store:${me}:${conv}`;
const MAX = 400;

/** 读某会话的本地消息库（无则空库）；按 id 升序返回 */
export function dmStoreLoad(me, conv) {
  const v = getJSON(KEY(me, conv), null);
  const msgs = v && Array.isArray(v.msgs) ? v.msgs : [];
  return { msgs: msgs.slice().sort((a, b) => (a.id || 0) - (b.id || 0)), more: v ? !!v.more : true };
}

/** 写本地消息库（全量替换，裁最旧） */
export function dmStoreSave(me, conv, msgs, more) {
  if (!me || !conv || !Array.isArray(msgs) || !msgs.length) return;
  try {
    setJSON(KEY(me, conv), { msgs: msgs.slice(-MAX), more: !!more });
  } catch (e) { /* 存储满等：静默 */ }
}

/** 按 id 去重合并（并集），id 升序 */
export function dmStoreMerge(a, b) {
  const map = new Map();
  for (const m of a || []) if (m && m.id != null) map.set(m.id, m);
  for (const m of b || []) if (m && m.id != null) map.set(m.id, m);
  return [...map.values()].sort((x, y) => (x.id || 0) - (y.id || 0));
}

/** 删会话时清库 */
export function dmStoreDrop(me, conv) {
  try { removeItem(KEY(me, conv)); } catch (e) { /* 忽略 */ }
}
