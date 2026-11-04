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
  /* 轮 376：旧版本/手改过的 localStorage 可能混进 null 或没有 id 的坏行；
   * 旧版直接 sort 会 TypeError，整个聊天页在 loadMessages 里炸掉（白屏）。 */
  const byId = new Map();
  for (const m of (v && Array.isArray(v.msgs) ? v.msgs : [])) {
    /* 轮 377：网关有时回字符串 id，本地/RPC 有时是数字；String 归一后再去重，
     * 否则同一条会以 12 和 "12" 两行出现。 */
    if (m && m.id != null) byId.set(String(m.id), m);
  }
  const msgs = [...byId.values()];
  return { msgs: msgs.sort((a, b) => (a.id || 0) - (b.id || 0)), more: v ? !!v.more : true };
}

/** 写本地消息库（全量替换，裁最旧）
 *  轮 376：裁剪前先按「正式行 id 升序、待发/失败行压尾」排 —— 直接 slice(-MAX)
 *  假设入参是时间序，但确认行晚回来/补拉历史会让 raw 数组暂时乱序；更糟的是
 *  负数失败行在 id 序最前，会被 400 条上限先裁掉。排序后裁，失败行和最新消息都保住。 */
export function dmStoreSave(me, conv, msgs, more) {
  if (!me || !conv || !Array.isArray(msgs) || !msgs.length) return;
  try {
    /* 轮 376：先按 id 去重（同一条被追加/确认/回填重复写进来时只留最新字段），
     * 再排序、裁剪。旧版不去重，旧版列表会看到同一句话出现两次。 */
    const byId = new Map();
    for (const m of msgs) if (m && m.id != null) byId.set(String(m.id), m);
    const ordered = [...byId.values()].sort((a, b) => {
      const ap = a && a.id < 0 ? 1 : 0;
      const bp = b && b.id < 0 ? 1 : 0;
      if (ap !== bp) return ap - bp;
      return (Number(a && a.id) || 0) - (Number(b && b.id) || 0);
    });
    /* 轮 376：一旦真的裁过，哪怕调用方传 more=false，也必须保留「还有更早历史」，
     * 否则翻到 400 条上限后再也上滑不动（旧版只在服务端说 more 时写 true）。 */
    setJSON(KEY(me, conv), { msgs: ordered.slice(-MAX), more: !!more || ordered.length > MAX });
  } catch (e) { /* 存储满等：静默 */ }
}

/** 按 id 去重合并（并集），id 升序 */
export function dmStoreMerge(a, b) {
  const map = new Map();
  for (const m of a || []) if (m && m.id != null) map.set(String(m.id), m);
  for (const m of b || []) if (m && m.id != null) map.set(String(m.id), m);
  return [...map.values()].sort((x, y) => (x.id || 0) - (y.id || 0));
}

/** 轮 355：非当前会话收到实时新消息 → 并进该会话本地库（只在该会话**已有历史**时写）。
 *  为什么必须有历史才写：本地库是「进会话第一帧」的唯一来源，loadMessages 会把它当完整历史
 *  直接渲染，网络回来只走 mergeTail 往尾部并（不会把更早的历史插到前面）。
 *  如果只写这一条新消息，进会话会先看到「孤零零一条」，随后网络回来的更早记录被追加到它
 *  后面 —— 顺序直接错。没有历史就不写，交给进会话时的网络整窗拉取。
 *  @returns {boolean} 是否写入
 */
export function dmStoreAppend(me, conv, row) {
  if (!me || !conv || !row || row.id == null) return false;
  const cur = dmStoreLoad(me, conv);
  /* 轮377：只有负数失败草稿不算“已有历史”。若把实时尾部写进这种库，
   * 本地库就从“没有正数行”变成“有正数行”，进会话时 IDB 全量首帧会被跳过，
   * 用户只能先看到一条孤零零的实时消息。等进会话时由网络整窗拉取。 */
  if (!cur.msgs.some((m) => Number(m && m.id) > 0)) return false;
  dmStoreSave(me, conv, dmStoreMerge(cur.msgs, [row]), cur.more);
  return true;
}

/** 轮 375：发送确认行 → 无论该会话有没有历史都写进本地库。
 *  发送和「别人发来的尾部」不同：这是一条已知完整的服务端行，不是半截窗口；
 *  用户发完立刻返回/切会话时，旧代码只在 onSameConv 时保存，确认行就丢了，
 *  再点进来只能等一次跨境 dm_list_messages（用户报障「消息没了，很久才出现」）。
 *  没有历史也先存这一条，进会话后网络回来会按 created_at 排到正确位置。 */
export function dmStoreUpsert(me, conv, row) {
  if (!me || !conv || !row || row.id == null) return false;
  const cur = dmStoreLoad(me, conv);
  dmStoreSave(me, conv, dmStoreMerge(cur.msgs, [row]), cur.more);
  return true;
}

/** 轮 376：把本地临时行（负数 id）换成服务端确认行（正数 id）。
 *  发送时乐观行会先落本地库，确认回来必须把旧负数行摘掉，否则再进会话
 *  会同时看到「发送中」和「已发送」两条。 */
export function dmStoreReplace(me, conv, oldId, row) {
  if (!me || !conv || !row || row.id == null) return false;
  const cur = dmStoreLoad(me, conv);
  const rest = oldId == null ? cur.msgs : cur.msgs.filter((m) => String(m.id) !== String(oldId));
  dmStoreSave(me, conv, dmStoreMerge(rest, [row]), cur.more);
  return true;
}

/** 轮 376：重发前摘掉旧失败行；只剩这一行时连键一起删，避免留下空壳。 */
export function dmStoreRemove(me, conv, id) {
  if (!me || !conv || id == null) return false;
  const cur = dmStoreLoad(me, conv);
  const next = cur.msgs.filter((m) => String(m.id) !== String(id));
  if (!next.length) {
    try { removeItem(KEY(me, conv)); } catch (e) { /* 忽略 */ }
    return true;
  }
  dmStoreSave(me, conv, next, cur.more);
  return true;
}

/** 删会话时清库 */
export function dmStoreDrop(me, conv) {
  try { removeItem(KEY(me, conv)); } catch (e) { /* 忽略 */ }
}
