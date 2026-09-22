/* 通知中心业务规则（纯函数，阶段 4）
 * ------------------------------------------------------------
 * 与 dmRules.js 同一哲学：能离线算出的都在这里，便于单测（tools/notify-test.mjs）。
 * 通知类型（与 MIGRATION 的 notif_kind 约束同源）：comment | reply | reaction | pet | dm | system
 * 分类栏映射：comments=[comment,reply] reactions=[reaction,pet] pets=[pet] dms=[dm] system=[system]
 */

export const KINDS = ["comment", "reply", "reaction", "pet", "dm", "system"];

/** 分栏 → kinds 白名单（传给 notifPage 的 p_kinds）。
 *  #23：私信（dm）退出通知中心——它有自己的聊天页与角标，这里不再展示，
 *  所以「全部」也传**非 dm 白名单**（不再用 null=不过滤，防止老库残留的 dm 行冒出来）。
 *  数据层的 notif_kind 白名单仍含 dm（迁移 notifications_drop_dm 在库里拦生成），前端只是不消费。 */
export function kindsFor(tab) {
  switch (tab) {
    case "comments":  return "comment,reply";
    case "reactions": return "reaction,pet";
    case "pets":      return "pet";
    case "system":    return "system";
    default:          return "comment,reply,reaction,pet,system"; // all（含未知分栏兜底；永不含 dm）
  }
}

/** 校验类型值（写入侧防御） */
export function isKind(k) {
  return KINDS.includes(k);
}

/** 未读数对象兜底：缺字段补 0，负数截 0 */
export function normUnread(u) {
  const o = u && typeof u === "object" ? u : {};
  const n = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  return {
    total:     n(o.total),
    comments:  n(o.comments),
    reactions: n(o.reactions),
    pets:      n(o.pets),
    dms:       n(o.dms),
    system:    n(o.system),
  };
}

/** 聚合键：同帖 + 同类型（反应再按种类细分）合并「多人做了同一件事」
 *  dm / system 不聚合（每条都是独立事件）；无帖子的通知也不聚合。 */
export function aggKey(n) {
  if (!n) return "";
  if (n.kind === "dm" || n.kind === "system" || !n.post_id) return `solo:${n.id}`;
  const extra = n.kind === "reaction" ? `:${(n.meta && n.meta.reaction) || ""}` : "";
  return `${n.kind}:${n.post_id}${extra}`;
}

/** 时间倒序聚合：连续同键的通知合并为一条带 count 的展示项
 *  返回 [{ ...first, count, actor 列表, ids:[组内所有通知 id] }]；输入须新→旧。
 *  `ids` 是给「点一条 = 整组一起标已读」用的（用户反馈：列表只显示 3 条，
 *  角标却还挂着十几条 —— 正是因为一次点击只标了组里第一条）。 */
export function aggregate(list) {
  const arr = Array.isArray(list) ? list : [];
  const out = [];
  const index = new Map(); // key → out 下标
  for (const n of arr) {
    const k = aggKey(n);
    if (!k.startsWith("solo:")) {
      const i = index.get(k);
      if (i !== undefined) {
        const cur = out[i];
        cur.count += 1;
        if (n.id != null) cur.ids.push(n.id);
        if (n.actor_name && !cur.actors.includes(n.actor_name)) cur.actors.push(n.actor_name);
        if (n.read_at == null) cur.read_at = null; // 任一未读即整组未读
        continue;
      }
      const item = {
        ...n, count: 1,
        ids: n.id != null ? [n.id] : [],
        actors: n.actor_name ? [n.actor_name] : [],
      };
      index.set(k, out.length);
      out.push(item);
    } else {
      out.push({
        ...n, count: 1,
        ids: n.id != null ? [n.id] : [],
        actors: n.actor_name ? [n.actor_name] : [],
      });
    }
  }
  return out;
}

/** 一条展示项（可能是聚合组）涉及的全部通知 id —— 标已读用；空/异常一律给空数组 */
export function idsOf(n) {
  if (!n) return [];
  if (Array.isArray(n.ids) && n.ids.length) return n.ids.filter((x) => x != null);
  return n.id != null ? [n.id] : [];
}

/** 展示文案装配的原料：{ key, params } —— i18n 键 + 插值参数（视图层只管 t()） */
export function itemView(n, myName = "") {
  if (!n) return null;
  const who = n.actor_name || "";
  const others = Math.max(0, (n.count || 1) - 1);
  const post = n.post_body || "";
  const comment = n.comment_body || "";
  const preview = (n.meta && n.meta.preview) || "";
  const systemBody = (n.meta && n.meta.body) || "";
  const reaction = (n.meta && n.meta.reaction) || "";
  const petKind = (n.meta && n.meta.pet_kind) || "";
  const base = { who, others, post, comment, preview, systemBody, reaction, petKind };
  switch (n.kind) {
    case "comment":  return { ...base, key: "notif.comment", unread: n.read_at == null };
    case "reply":    return { ...base, key: "notif.reply",   unread: n.read_at == null };
    case "reaction": return { ...base, key: "notif.reaction", unread: n.read_at == null };
    case "pet":      return { ...base, key: "notif.pet",      unread: n.read_at == null };
    case "dm":       return { ...base, key: n.meta?.event === "bottle_reply" ? "bottle.notifyReply" : n.meta?.event === "bottle_chat" ? "bottle.notifyChat" : "notif.dm", unread: n.read_at == null };
    /* 轮 33：举报处理结果通知（meta.event = report_handled）—— 独立文案，与公告类 system 区分 */
    case "system":   return { ...base, key: n.meta && n.meta.event === "report_handled" ? "notif.reportDone" : "notif.system", unread: n.read_at == null };
    default:         return { ...base, key: "notif.fallback", unread: n.read_at == null };
  }
}

/** 点击落点：dm → 会话；其余有 post → 帖子；否则原地 */
export function targetOf(n) {
  if (!n) return null;
  if (n.kind === "dm" && ["bottle_reply", "bottle_chat"].includes(n.meta?.event) && n.meta?.bottle_id) {
    return { type: "bottle", bottleId: n.meta.bottle_id };
  }
  if (n.kind === "dm" && n.conv_id != null) return { type: "dm", convId: n.conv_id };
  /* #15 「谁摸了你的宠物」这类互动没有帖子可跳 → 进对方的用户主页 */
  if (n.kind === "pet" && n.actor_id) return { type: "user", userId: n.actor_id };
  if (n.post_id != null) return { type: "post", postId: n.post_id };
  return null;
}

/** 偏好展示态（缺行 = 全开，与 notif_prefs_get 对齐） */
export function normPrefs(p) {
  const o = p && typeof p === "object" ? p : {};
  const b = (v) => v !== false;
  return {
    comments:  b(o.comments),
    reactions: b(o.reactions),
    pets:      b(o.pets),
    dms:       b(o.dms),
  };
}
