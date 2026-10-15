/* 暖心墙评论：纯逻辑层（不依赖 Vue / 浏览器，便于 Node 单元测试）
 * ------------------------------------------------------------
 * 二级评论（和大多数评论区一样）：
 *   一级评论 parentId = null；回复挂在被回复的一级评论下（parentId = 一级 id）。
 *   回复「回复」时不产生第三层 —— 仍挂在同一个一级评论下，用 replyTo 记下 @谁。
 *   好处：渲染永远只有两层（不会层层缩进缩到看不见），云端也只有一层自关联 FK。
 */

export const CMT_KEY = "warm-paws-comments-v1";
export const MAX_LEN = 200;
export const MAX_PER_POST = 100;

/* 存储结构：{ <postKey>: [comment, ...] }
   轮 146：示例帖下线，示范评论机制（seedComments/SEEDS/SEED_FLAG/SEED_META）整体移除。
   老用户 localStorage 里若已存在 __seeded/__meta 与 s1..s3 残留条目，读侧无影响
   （listComments 只按 postKey 取，残留键永远匹配不到任何真实帖 id），也不再主动清理。 */

/* 帖子主键：帖子 id 统一转字符串（用户帖是数字 id，示例帖下线后不再有字符串 id） */
export function postKey(post) {
  if (!post) return "";
  return String(post.id);
}

/**
 * 某帖的评论列表（永远返回数组）
 * @param {string|null|undefined} parentId
 *   - 省略 → 该帖全部评论（含回复；向后兼容旧调用）
 *   - null → 只取一级评论
 *   - 评论 id → 只取挂在该评论下的回复（二级）
 */
export function listComments(store, post, parentId) {
  const k = postKey(post);
  const arr = store && store[k];
  const all = Array.isArray(arr) ? arr : [];
  if (parentId === undefined) return all;
  return all.filter((c) => (c.parentId || null) === (parentId || null));
}

/** 一级评论（不含回复），评论区主列表用它渲染 */
export function topComments(store, post) {
  return listComments(store, post, null);
}

/** 某条评论下的回复（二级） */
export function repliesOf(store, post, commentId) {
  return listComments(store, post, commentId);
}

/** 某条一级评论下的回复数（列表里显示「N 条回复」） */
export function replyCount(store, post, commentId) {
  return repliesOf(store, post, commentId).length;
}

/** 评论数（不把内部标记算进去；含回复，与「N 条评论」的语义一致；软删行也算 —— 要按渲染口径数请用 liveComments） */
export function countComments(store, post) {
  return listComments(store, post).length;
}

/* ══════════ 轮 285 · 软删口径（删一级评论不再连带删掉它的二级回复） ══════════
 * 数据库侧：wall_comments.parent_id 是 on delete cascade —— 原来删一级评论是物理 DELETE，
 *           回复被数据库一起带走（用户反馈：b 删了，c/d/e 的评论全丢）。
 * 本侧配套：删评论改成「标记 deleted」，行不消失；下面这组纯函数定死**渲染与计数口径**：
 *   · 计数：软删的行不算「N 条评论」；
 *   · 一级评论：删了但下面还有没删的回复 → 留成「该评论已删除」占位（回复照常挂它下面）；
 *              删了且没有活着的回复了 → 整条不渲染（不留空墓碑）；
 *   · 二级回复：删了直接不渲染（两级封顶，回复下面不会再有下级）。
 * 全部是「数组 → 数组」的纯函数，两个视图共用，Node 单测直接锁口径（tools/comment-test.mjs）。 */

/** 这条评论是不是已删除（脏值安全：数字/undefined/null 都不算） */
export function isDeleted(c) {
  return !!(c && c.deleted);
}

/** 存活的评论（不含软删行）——「N 条评论」的计数口径 */
export function liveComments(all) {
  return (Array.isArray(all) ? all : []).filter((c) => !isDeleted(c));
}

/**
 * 评论区标题上的计数：
 *   - 该帖评论已拉到本地（listed 是数组）→ 以本地列表为准（增删即时反映；软删行不计）
 *   - 还没拉过（云端帖进页面时）→ 先用云端聚合出来的总数，不再显示成 0
 * 修复的 bug：登录用户进页面时云端帖评论数一直是 0，必须点开评论才冒出来。
 */
export function displayCount(listed, cloudCount = 0) {
  if (Array.isArray(listed)) return liveComments(listed).length;
  const n = Number(cloudCount);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 渲染用的一级评论：没删的照常；删了但下面还有活着的回复 → 留成占位；否则整条不渲染 */
export function renderTops(all) {
  const arr = Array.isArray(all) ? all : [];
  return arr.filter((c) => {
    if (!c || typeof c !== "object") return false;  /* 脏行（null/0/"s"）跳过 */
    if (c.parentId) return false;                   /* 只要一级评论 */
    if (!isDeleted(c)) return true;
    return arr.some((r) => r && typeof r === "object" && r.parentId === c.id && !isDeleted(r));
  });
}

/** 渲染用的某一级评论下的二级回复（软删的直接不渲染） */
export function renderReplies(all, topId) {
  const arr = Array.isArray(all) ? all : [];
  return arr.filter((c) => c && typeof c === "object" && c.parentId === topId && !isDeleted(c));
}

/* ══════════ 轮 301 · 回复守卫 + 目标判定（两视图同形逻辑收口） ══════════
 * 背景：CommunityView（replyViaBar/sendCmt）与 PostDetailView（sendCmt）各写了一份
 *   「墓碑能不能回 + 回谁（parentId/replyTo 取谁）」—— 轮 298 刚修过连坐 bug
 *   （判据从「cm 被删没」改成「回复目标被删没」：cm.deleted && !rp 才拦），
 *   两处手写极易再次写岔（比如只改一处、判据回退）。
 * 这里收口成纯函数，视图只调不动行为；单测锁口径（tools/comment-test.mjs G 组）。
 * 注意：墓碑本身被点回复（!rp）仍拦；回墓碑下的活回复（rp 存活）放行 ——
 *   回复仍挂同一一级评论下（parentId = cm.id），@ 的是 rp 作者。 */

/** 能不能对这组目标发起回复：直接回墓碑（cm 删了且没给 rp）→ true（拦），其余 false */
export function replyBlocked(cm, rp = null) {
  return !!(cm && isDeleted(cm) && !rp);
}

/**
 * 回复目标判定：返回 { parentId, replyTo }。
 * parentId 永远是 cm.id（两级封顶，见 addComment T20）；
 * replyTo：有 rp → rp 作者；无 rp → cm 作者（默认，调用方显式传了就用调用方的）。
 */
export function replyTarget(cm, rp = null) {
  if (!cm) return { parentId: null, replyTo: "" };
  const replyTo = rp && rp.name ? String(rp.name)
    : cm && cm.name ? String(cm.name) : "";
  return { parentId: cm.id != null ? cm.id : null, replyTo };
}

/**
 * 组装一条评论/回复的写库载荷（纯函数，不碰网络/存储）。
 * @param {object} opts { postDbId, userId, name, text, cm, rp, at }
 *   cm = 一级评论（可空 = 直接评帖子）；rp = 被回复的二级（可空）；
 *   at = 调用方显式记下的 @ 对象（回复一级时用，优先级高于默认）。
 * 返回 { row, parentDbId, replyTo }：row 直接喂 insertComment；
 * parentDbId/replyTo 给乐观行与 atName 回填用。
 * 两级封顶：parentDbId 永远取 cm.dbId（回 rp 也不产生第三层，见 addComment T20）。
 */
export function buildCommentRow({ postDbId, userId, name, text, cm = null, rp = null, at = "" } = {}) {
  const parentDbId = cm ? (cm.dbId != null ? cm.dbId : null) : null;
  const replyTo = rp && rp.name ? String(rp.name)
    : at ? String(at)
    : cm && cm.name ? String(cm.name) : "";
  return {
    row: {
      post_id: postDbId,
      user_id: userId,
      author_name: name,
      body: normalizeText(text),
      parent_id: parentDbId,
      reply_to_name: replyTo || null,
    },
    parentDbId,
    replyTo,
  };
}

/**
 * 是否可以删除：
 *  - 云端评论（comment.cloud）：与当前登录 userId 比对（RLS 双保险）
 *  - 本地评论：与当前昵称比对（未登录访客按当前昵称判定）
 *  - 已经删过的（软删标记）→ 不给再删一次（墓碑上不渲染任何操作）
 */
export function canDelete(comment, nickname, userId = "") {
  if (!comment || comment.deleted) return false;
  if (comment.cloud) return !!(userId && comment.userId === userId);
  if (!nickname) return false;
  return comment.name === nickname;
}

/** 规范化输入：去空白 + 截断；返回 "" 表示无效输入 */
export function normalizeText(text) {
  const s = String(text == null ? "" : text).trim();
  if (!s) return "";
  return s.slice(0, MAX_LEN);
}

/** 在帖内按 id 找评论（找不到返回 null） */
function findComment(list, id) {
  if (!id) return null;
  return list.find((c) => c.id === id) || null;
}

/**
 * 新增评论（返回新 store，不修改入参）
 * 二级评论规则：
 *   - parentId 省略 → 一级评论（parentId = null）
 *   - 回复一级评论 → parentId = 该一级评论 id
 *   - 回复二级回复 → 仍挂在同一个一级评论下（两级封顶），并记 replyTo = 被回复者昵称
 *   - parentId 指向不存在 / 非本帖的评论 → 退化为一级评论（不产生悬挂节点）
 * @returns {{ ok: boolean, reason?: string, store: object, comment?: object }}
 */
export function addComment(store, post, { name, text, parentId = null, replyTo = "", now = Date.now() } = {}) {
  const clean = normalizeText(text);
  if (!clean) return { ok: false, reason: "empty", store };
  if (!post) return { ok: false, reason: "no-post", store };

  const k = postKey(post);
  const next = { ...store };
  const arr = Array.isArray(next[k]) ? next[k].slice() : [];
  if (arr.length >= MAX_PER_POST) return { ok: false, reason: "full", store };

  const target = findComment(arr, parentId);
  const rootId = target ? (target.parentId || target.id) : null; /* 两级封顶 */
  /* @谁：显式给了就用；回复的是一条二级回复则自动 @这位回复者；直接回复一级作者不冗余 @ */
  const at = rootId
    ? String(replyTo || (target && target.parentId ? target.name : "") || "")
    : "";
  const comment = {
    id: now + "-" + Math.random().toString(36).slice(2, 7),
    name: String(name || "Guest"),
    ts: now,
    text: clean,
    parentId: rootId,
    replyTo: at,
  };
  arr.push(comment);
  next[k] = arr;
  return { ok: true, store: next, comment };
}

/**
 * 数组版标记删除（不改入参；已是 deleted / 找不到 → 返回原数组）。
 * removeComment 的内核 —— 帖子详情页的评论是**平铺数组**（不是按帖分键的 store），直接用它。
 */
export function markDeleted(all, id) {
  const arr = Array.isArray(all) ? all : [];
  const i = arr.findIndex((c) => c && c.id === id);
  if (i < 0 || isDeleted(arr[i])) return arr;
  const next = arr.slice();
  next[i] = { ...arr[i], deleted: true };
  return next;
}

/**
 * 删除评论（返回新 store，不修改入参）。
 *
 * 轮 285 · 改**软删**：不再把行摘掉，改成标记 deleted ——
 *   · 这正是用户要的「把 b 的评论替换成已被删除，但下面二级评论还在」：
 *     原来是 `filter(c => c.id !== id && c.parentId !== id)` 连带把回复一起摘掉
 *     （对应数据库侧 on delete cascade 的物理级联），c/d/e 的回复就这么没了；
 *   · 行留着 → 云端那边写 deleted_at 而不是 DELETE → 级联永不触发；
 *   · 渲染与计数交给 renderTops / renderReplies / liveComments 定口径，
 *     已删的一级评论「还有活回复就留占位、没有就不渲染」。
 * 幂等：已标记的再删一次无变化；id 找不到 → 原样返回。
 */
export function removeComment(store, post, commentId) {
  const k = postKey(post);
  const list = listComments(store, post);
  const target = list.find((c) => c && c.id === commentId);
  if (!target || target.deleted) return store;      /* 没这条 / 已删过 → 什么都不动 */
  const next = { ...store };
  next[k] = markDeleted(list, commentId);
  return next;
}

/** 帖子总数（用户帖 + 示例帖） */
export function allPosts(myPosts) {
  return Array.isArray(myPosts) ? myPosts.slice() : [];
}

/* ══════════ 轮 84 · 评论回应 / 排序 / 墙内前 3 条 ══════════
 * 用户口径：
 *   · 墙内每条帖子的评论**只显前 3 条一级评论**，更多走「查看更多」进详情页
 *   · 详情页可以按「最新 / 最热」排（最热 = 心最多）
 *   · 每条评论在「回复」右边有 👍心 / 💔碎心（带数量）
 * 全部写在这里（组件只做渲染），这样 Node 单测能直接锁住口径。
 */

/** 两种评论回应：心（赞同/温暖）、碎心（心疼/不认同）。与数据库 check 约束同源。 */
export const CMT_REACT_KINDS = ["heart", "broken"];

/** 墙内一级评论默认显示几条 */
export const WALL_TOP_LIMIT = 3;

/** 排序口径：default = 默认（推荐模式，与暖心墙帖子排序同源 —— 视图层用 recommendPosts）；
 * new = 最新（一级评论时间倒序）。轮 87：「最热」按用户反馈移除。 */
export const SORT_MODES = ["default", "new"];

/** 某条评论的回应数（缺字段 → 0；负值/非数字一律归 0，避免脏数据把排序带偏） */
export function reactCount(comment, kind) {
  const r = comment && comment.reacts;
  const n = Number(r && r[kind]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * 我有没有点过这一种回应。
 * 本地评论把「我点过的」存在 myReacts（数组）；云端评论由服务端聚合成 mine（数组）。
 * 两种形状都认，组件与规则层不必区分来源。
 */
export function hasReacted(comment, kind, userId = "") {
  if (!comment) return false;
  const list = Array.isArray(comment.myReacts) ? comment.myReacts
    : Array.isArray(comment.mine) ? comment.mine : [];
  return list.includes(kind);
}

/**
 * 切换某条评论的回应（返回**新的**评论对象，不改入参）——纯函数，便于乐观更新与回滚。
 * on = true → 加一；false → 减一（不会低于 0）。myReacts 同步维护。
 */
export function toggleReact(comment, kind, on) {
  if (!comment || !CMT_REACT_KINDS.includes(kind)) return comment;
  const reacts = { ...(comment.reacts || {}) };
  const now = reactCount(comment, kind);
  reacts[kind] = on ? now + 1 : Math.max(0, now - 1);
  /* 从现有 myReacts/mine 全量出发，只增删本次点击的 kind ——
   * 两种回应可同时点亮（与帖子回应同口径，RPC 也是按 kind 独立切换）；
   * 不能只从「被点击的 kind」重建，否则另一种已点亮的会被悄悄丢掉。 */
  const mine = new Set(
    Array.isArray(comment.myReacts) ? comment.myReacts
      : Array.isArray(comment.mine) ? comment.mine : [],
  );
  if (on) mine.add(kind); else mine.delete(kind);
  return { ...comment, reacts, myReacts: [...mine] };
}

/**
 * 评论列表排序（返回新数组，不改入参）。
 * mode="new"（含未知值）：按 ts 倒序。
 * 轮 87：「最热」移除 —— 默认口径改为推荐模式（视图层直接用 wallRules 的
 * recommendPosts，与暖心墙帖子排序同源），这里只保留时间倒序。
 * ts 非法一律当 0（排到最后），避免一条脏数据把顺序打乱。
 */
export function sortComments(list, mode = "new") {
  const arr = Array.isArray(list) ? list.slice() : [];
  const ts = (c) => (Number.isFinite(Number(c && c.ts)) ? Number(c.ts) : 0);
  return arr.sort((a, b) => ts(b) - ts(a));
}

/** 墙内展示：只取前 WALL_TOP_LIMIT 条一级评论（调用方自己先按口径排序） */
export function wallTopComments(list, limit = WALL_TOP_LIMIT) {
  const arr = Array.isArray(list) ? list : [];
  const n = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : WALL_TOP_LIMIT;
  return arr.slice(0, n);
}

/** 墙内是否需要「查看更多」：一级评论总数超过展示上限时才有 */
export function hasMoreComments(list, limit = WALL_TOP_LIMIT) {
  const arr = Array.isArray(list) ? list : [];
  const n = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : WALL_TOP_LIMIT;
  return arr.length > n;
}

/** 帖子的可复制正文：把帖子结构还原成一段纯文本（拷贝菜单用；无正文给空串） */
export function postCopyText(post) {
  if (!post) return "";
  const parts = [];
  if (post.text) parts.push(String(post.text));
  if (post.img) parts.push(String(post.img));
  return parts.join("\n");
}

/** 评论的可复制正文（拷贝菜单用） */
export function commentCopyText(comment) {
  if (!comment) return "";
  const who = comment.name ? String(comment.name) + "：" : "";
  return who + String(comment.text || "");
}