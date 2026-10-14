/* ═══ 轮 269 · 私信实时通道（Supabase Realtime，前台秒达）═══
 * A 发消息 → B 的 dm_messages INSERT 事件走 WebSocket 推送，亚秒级亮红点/上屏
 * （轮询时代：在看的会话 ~5s、别处 ~30s；用户问「A 发了 B 多久才收到通知」）。
 * 收到事件后做两件事：
 *  ① refreshBadge() —— 行级未读映射随 dm_unread_total 回来（轮 268），行红点即亮；
 *  ② 若 MessagesView 正打开该会话 → onActiveInsert 回调（mergeTail 即时上屏）。
 * 设计红线：
 *  - 自己发的消息事件直接丢弃（发送时已乐观上屏，不需要回显）；
 *  - RLS 做天然隔离（messages read participant）：只能收到自己参与会话的行；
 *  - 无连接 / 断线 / 未登录 = 静默不工作，原轮询兜底不变——实时通道绝不做唯一数据源。
 */
import { getClient, cloud } from "./supabase.js";
import { refreshBadge } from "../stores/badgeStore.js";

let channel = null;
let startedUid = "";
const activeHandlers = new Set();

/** 注册「正打开会话收到新消息」回调（MessagesView 用）；返回注销函数 */
export function onDmInsert(fn) {
  if (typeof fn !== "function") return () => {};
  activeHandlers.add(fn);
  return () => { activeHandlers.delete(fn); };
}

function handleInsert(row) {
  if (!row || row.sender == null || row.conv_id == null) return;
  const me = (cloud.user && cloud.user.id) || "";
  if (me && String(row.sender) === String(me)) return;   /* 自己发的回显：已乐观上屏 */
  try { refreshBadge(); } catch (e) { /* 角标随后自有轮询兜底 */ }
  for (const fn of [...activeHandlers]) {
    try { fn(row); } catch (e) { /* 某个回调挂了不影响其他 */ }
  }
}

/** 登录后调用（与 startBadge 同位置）；同 uid 重复调用直接返回 */
export function startDmRealtime() {
  const uid = (cloud.user && cloud.user.id) || "";
  if (!uid) return false;
  if (channel && startedUid === uid) return true;
  stopDmRealtime();
  let sb = null;
  try { sb = getClient(); } catch (e) { sb = null; }
  if (!sb) return false;
  startedUid = uid;
  try {
    channel = sb
      .channel(`dm-inbox:${uid}`)
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "dm_messages" },
        (payload) => handleInsert(payload && payload.new))
      .subscribe();
  } catch (e) {
    channel = null;
    startedUid = "";
    return false;   /* 建通道失败 = 当没这功能，轮询继续 */
  }
  return true;
}

/** 登出 / 卸载时调用 */
export function stopDmRealtime() {
  try {
    const sb = getClient();
    if (sb && channel) sb.removeChannel(channel);
  } catch (e) { /* 忽略 */ }
  channel = null;
  startedUid = "";
}
