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

/* 存储结构：{ __seeded: true, <postKey>: [comment, ...] }
   __seeded 保证示例评论只写入一次 —— 否则用户删掉后刷新又会出现。 */
const SEED_FLAG = "__seeded";
const SEED_META = "__meta";

/* 示例帖的示范评论（首次访问时写入，之后可正常删除） */
export const SEEDS = {
  s1: {
    en: "Welcome home! Softest corner of the internet indeed.",
    zh: "欢迎回家！这里确实是互联网上最温柔的角落。",
  },
  s2: {
    en: "Hug back. Next week will be kinder to you.",
    zh: "抱抱你。下周一定会更温柔的。",
  },
  s3: {
    en: "Soup too salty, but the company was just right.",
    zh: "汤咸了没关系，陪伴刚刚好。",
  },
};

/* 帖子主键：示例帖用字符串 id，用户帖用数字 id 的字符串形式 */
export function postKey(post) {
  if (!post) return "";
  return post.sample ? String(post.id) : String(post.id);
}

/** 首次访问时注入示范评论；已注入过则原样返回（幂等） */
export function seedComments(raw, locale = "en", now = Date.now()) {
  const store = raw && typeof raw === "object" ? { ...raw } : {};
  if (store[SEED_FLAG]) return store;

  let i = 0;
  for (const [pid, text] of Object.entries(SEEDS)) {
    if (!Array.isArray(store[pid])) store[pid] = [];
    store[pid].unshift({
      id: pid + "-seed-" + i,
      seed: true,
      name: "Mochi",
      ts: now - 43200000 - i * 3600000,
      text: locale === "zh" ? text.zh : text.en,
    });
    i++;
  }
  store[SEED_FLAG] = true;
  store[SEED_META] = { seededAt: now };
  return store;
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

/** 评论数（不把内部标记算进去；含回复，与「N 条评论」的语义一致） */
export function countComments(store, post) {
  return listComments(store, post).length;
}

/**
 * 评论区标题上的计数：
 *   - 该帖评论已拉到本地（listed 是数组）→ 以本地列表为准（增删即时反映）
 *   - 还没拉过（云端帖进页面时）→ 先用云端聚合出来的总数，不再显示成 0
 * 修复的 bug：登录用户进页面时云端帖评论数一直是 0，必须点开评论才冒出来。
 */
export function displayCount(listed, cloudCount = 0) {
  if (Array.isArray(listed)) return listed.length;
  const n = Number(cloudCount);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 是否可以删除：
 *  - 云端评论（comment.cloud）：与当前登录 userId 比对（RLS 双保险）
 *  - 本地评论：与当前昵称比对（未登录访客按当前昵称判定）
 */
export function canDelete(comment, nickname, userId = "") {
  if (!comment) return false;
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

/** 删除评论（返回新 store，不修改入参）；删一级评论时它的回复一并删除（与云端 FK 级联一致） */
export function removeComment(store, post, commentId) {
  const k = postKey(post);
  const next = { ...store };
  next[k] = listComments(store, post).filter((c) => c.id !== commentId && c.parentId !== commentId);
  if (!next[k].length) delete next[k];
  return next;
}

/** 帖子总数（用户帖 + 示例帖） */
export function allPosts(myPosts) {
  return Array.isArray(myPosts) ? myPosts.slice() : [];
}