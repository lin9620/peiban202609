/* 轮 327 · 会话页组件的「本地缓存」读取口 —— 复用现网那两层，不新增第二份。
 *
 *   · 会话列表：SWR localStorage（key = cacheKey("dm:convs", meId)，首帧同步可读）
 *   · 历史消息：IndexedDB 全量库（wp-dm-full，微信式：本机存全量、离线可翻）
 *
 * 只读：本文件不调用 cacheSet / idbMerge，写路径仍由现有 MessagesView 负责。
 * 在 Node / 隐私模式（无 indexedDB、无 localStorage）下静默返回空，不抛错。
 */
import { cacheKey, cachePeek } from "../utils/cache.js";
import { idbLoad } from "../utils/dmIdb.js";

/** 读缓存的会话列表（可能过期，SWR 语义：先画出来再说） */
export function readCachedConvs(meId) {
  try {
    const rows = meId ? cachePeek(cacheKey("dm:convs", meId)) : null;
    return Array.isArray(rows) ? rows : [];
  } catch (e) { return []; }
}

/** 读某会话的本地全量历史（IndexedDB）；返回 { msgs, serverDone } */
export async function readCachedMessages(convId) {
  try {
    const rec = await idbLoad(convId);
    return { msgs: Array.isArray(rec.msgs) ? rec.msgs : [], serverDone: !!rec.serverDone };
  } catch (e) { return { msgs: [], serverDone: false }; }
}
