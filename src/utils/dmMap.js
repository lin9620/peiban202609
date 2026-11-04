/* 轮 327 · 会话页组件（vue-advanced-chat）的数据映射 —— 纯函数，零依赖，Node 里直接测。
 *
 * 为什么单独一层：换 UI 只该换「画」的部分。**本地缓存（微信式）一行不改**：
 *   · 会话列表 ← SWR localStorage（dm:convs|<meId>，首帧同步渲染）
 *   · 历史消息 ← IndexedDB 全量库（wp-dm-full，离线可翻）
 * 这一层只做字段翻译：我们的 conv/msg 行 → 组件的 room/message 行。
 * 不新增第二份缓存，也不写任何库（只读）。
 */

/* 日期标签：今天 / 昨天 / 8月20日（跨年补年份） */
export function dayLabel(iso, nowMs = Date.now()) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return "";
  const now = new Date(nowMs);
  const day0 = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day0(now) - day0(d)) / 86400000);
  if (diff === 0) return "今天";
  if (diff === 1) return "昨天";
  const base = `${d.getMonth() + 1}月${d.getDate()}日`;
  return d.getFullYear() === now.getFullYear() ? base : `${d.getFullYear()}年${base}`;
}

/* 时刻：HH:mm（本地时区） */
export function timeLabel(iso) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/* 会话行 → room（组件的会话列表项）
 * 入参 c：现网 conv 行 { conv_id, other_id, nickname, unread, last_preview, last_message_at, created_at, ... }
 * avatarOf(uid)：调用方注入（proto 页传 avatarUrlFor），本层不引 UI 依赖
 */
export function convToRoom(c, { meId = "", avatarOf = () => "" } = {}) {
  if (!c || c.conv_id == null) return null;
  const at = c.last_message_at || c.created_at || "";
  const peerId = c.other_id || "";
  const name = c.nickname || "会话";
  const unread = Number(c.unread) || 0;
  return {
    roomId: String(c.conv_id),
    roomName: name,
    avatar: avatarOf(peerId) || "",
    unreadCount: unread,
    /* 免打扰 / 拉黑：给组件头的「…」菜单用（room-actions 的标题随状态变） */
    muted: !!c.muted,
    blocked: !!c.blocked,
    /* 组件按 index 排会话（倒序）：直接用服务端/本地的最新消息时间 */
    index: Date.parse(at) || 0,
    lastMessage: {
      _id: "last-" + c.conv_id,
      content: String(c.last_preview || ""),
      senderId: c.last_sender || peerId,
      username: "",
      timestamp: timeLabel(at),
      seen: unread === 0,
      new: unread > 0,
    },
    users: [
      /* 现网没有在线状态（presence）—— 不要塞 state:"online"，否则每个会话都亮绿点、
         聊天页标题写「在线」，等于对用户撒谎（轮 332 真浏览器截图里一眼看到）。 */
      { _id: peerId || "peer", username: name, avatar: avatarOf(peerId) || "" },
      { _id: meId || "me", username: "我", avatar: avatarOf(meId) || "" },
    ],
  };
}

/* 一批会话 → rooms（丢掉坏行、按 index 倒序，组件默认 rooms-order=desc） */
export function convsToRooms(convs, opts = {}) {
  const list = Array.isArray(convs) ? convs : [];
  return list
    .filter((c) => c && c.conv_id != null && c.accepted !== false && !c.blocked)
    .map((c) => convToRoom(c, opts))
    .filter(Boolean)
    .sort((a, b) => b.index - a.index);
}

/* 消息行 → message（组件的消息项）
 * 现网行：{ id, sender, body, image_path, created_at, deleted_at, pending, failed }
 * 语义对齐现网「显示态」：撤回 → 组件内置的 deleted 灰色占位（文案走 text-messages.MESSAGE_DELETED）；
 * 失败 → 红色可点重发图标；待发 → 单灰勾。
 */
export function rowToMessage(m, { nameOf = () => "", meId = "", canRecall = null } = {}) {
  if (!m || m.id == null) return null;
  const recalled = !!m.deleted_at;
  const hasImage = !recalled && !!m.image_path;
  /* 轮 341：消息菜单只留「撤回」，而撤回有两条硬规矩 —— 只能撤自己的、且 15 分钟内。
     传了 canRecall 就按这条消息算一次；不能撤的 disableActions=true（组件连 ⋯ 都不出）。 */
  const recallable = canRecall ? !!canRecall(m, meId) : true;
  return {
    _id: String(m.id),
    /* 轮 352：行 key 用「发送时就定下的稳定值」（m.key），没有才退回 id。
       组件只拿 indexId 当 v-for key —— 乐观行确认后 id 由负数变正式 id，key 一变
       整行会重挂（淡出 + 淡入 + 多滚一次底 = 「发送成功之后会跳」）。 */
    indexId: m.key != null ? m.key : m.id,
    content: recalled ? "" : (hasImage && !m.body ? "[图片]" : String(m.body || "")),
    senderId: String(m.sender || ""),
    username: nameOf(m.sender) || "",
    date: dayLabel(m.created_at),
    timestamp: timeLabel(m.created_at),
    system: false,
    saved: !m.pending,
    distributed: !m.pending && !m.failed,
    seen: !!m.seen,
    deleted: recalled,
    failure: !!m.failed,
    /* 轮 341：不能撤回的（别人的 / 超 15 分钟 / 在飞 / 失败 / 已撤回）不出消息菜单 */
    disableActions: !recallable,
    disableReactions: true,
  };
}

/* 一批消息 → messages：按发送时间升序、按 id 去重、只取最近 limit 条（组件自己滚到底）
 *
 * 轮 375：不能按 id/indexId 排。线上出现过「今天 14:33」下面跟着「昨天 16:04」：
 * 一条晚确认的消息拿到了更大的 bigserial id，但 created_at 还是发送当时的时间；
 * 按 id 排就会把它放到今天后面，日期分隔也跟着错。显示顺序以 created_at 为准，
 * id/key 只做同一毫秒内的稳定次序。 */
export function rowsToMessages(rows, { nameOf = () => "", meId = "", canRecall = null, limit = 300 } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const at = new Map();
  const uniq = [];
  for (const r of list) {
    /* 轮 377：id 可能是数字或字符串，按 String 去重，避免同一行上屏两次。 */
    const idKey = r && r.id != null ? String(r.id) : "";
    if (!r || r.id == null) continue;
    /* 同 id 后到的行覆盖先到的行：撤回补丁/服务端确认行通常追加在尾部，
     * 若保留第一条，组件会继续画旧的正文。 */
    if (at.has(idKey)) uniq[at.get(idKey)] = r;
    else { at.set(idKey, uniq.length); uniq.push(r); }
  }
  /* 轮382：待发行和确认行共用同一个稳定 key。即使上游因为极端时序把两行都塞进来，
   * 这里也只能留确认后的正数行 —— 组件 indexId 就是 key，两行同 key 会让 v-for 打架。 */
  const keyed = new Map();
  const deduped = [];
  for (const r of uniq) {
    const k = r.key != null && r.key !== "" ? String(r.key) : "";
    if (!k) { deduped.push(r); continue; }
    const atKey = keyed.get(k);
    if (atKey == null) { keyed.set(k, deduped.length); deduped.push(r); continue; }
    const old = deduped[atKey];
    const rDone = Number(r.id) > 0 && !r.pending;
    const oDone = Number(old.id) > 0 && !old.pending;
    if (rDone && !oDone) deduped[atKey] = r;
  }
  const timeOf = (r) => {
    const v = r.created_at;
    const t = typeof v === "number" ? v : Date.parse(v);
    return Number.isFinite(t) ? t : null;
  };
  deduped.sort((a, b) => {
    /* 轮 377：待发/失败行（负数 id）永远压尾部，不能只做同毫秒 tie-breaker。
     * 它们可能带着很早的 created_at（跨午夜、时钟偏差、隔天重进），
     * 按时间排会跑到历史中间；再被 limit 裁掉，用户就看不到失败草稿了。
     * 正式行之间仍严格按 created_at；同一毫秒再按稳定 key/id。 */
    const pa = !!a.pending || Number(a.id) < 0;
    const pb = !!b.pending || Number(b.id) < 0;
    if (pa !== pb) return pa ? 1 : -1;
    const ta = timeOf(a);
    const tb = timeOf(b);
    if (ta != null && tb != null && ta !== tb) return ta - tb;
    if (ta != null && tb == null) return -1;
    if (ta == null && tb != null) return 1;
    return (Number(a.key != null ? a.key : a.id) || 0) - (Number(b.key != null ? b.key : b.id) || 0);
  });
  const out = [];
  /* 轮 377：待发/失败行压在末尾后，若它们的日期早于最后一条正式消息，
   * 组件会再插一个“昨天”分隔符 → 今天后面又出现昨天。把这类行的 date
   * 归到当前最后一天，和旧版 withDayDividers 的守卫同一口径。 */
  let lastDate = "";
  let lastTs = null;
  for (const r of deduped) {
    const v = rowToMessage(r, { nameOf, meId, canRecall });
    if (!v) continue;
    const t = timeOf(r);
    const isPending = !!r.pending || Number(r.id) < 0;
    if (isPending && lastDate && t != null && lastTs != null && t < lastTs && v.date !== lastDate) {
      v.date = lastDate;
    }
    if (v.date && v.date !== lastDate) lastDate = v.date;
    if (t != null && (lastTs == null || t > lastTs)) lastTs = t;
    out.push(v);
  }
  /* 待发行的 id 是负数（乐观上屏），indexId 只作为组件的 v-for key，不参与排序。
     正式行仍用服务端 id；待发行接着前一条往后排一位（多条待发按顺序叠加），
     这样确认后 key 不变、行不重挂。 */
  let lastIndex = 0;
  let seq = 0;
  for (const v of out) {
    if (v.indexId > 0) { lastIndex = v.indexId; seq = 0; }
    else { v.indexId = lastIndex + (++seq) * 0.001; }
  }
  return out.length > limit ? out.slice(out.length - limit) : out;
}
