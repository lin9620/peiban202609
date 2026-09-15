/* 暖心墙评论：纯逻辑层（不依赖 Vue / 浏览器，便于 Node 单元测试） */

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

/** 某帖的评论列表（永远返回数组） */
export function listComments(store, post) {
  const k = postKey(post);
  const arr = store && store[k];
  return Array.isArray(arr) ? arr : [];
}

/** 评论数（不把内部标记算进去） */
export function countComments(store, post) {
  return listComments(store, post).length;
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

/**
 * 新增评论（返回新 store，不修改入参）
 * @returns {{ ok: boolean, reason?: string, store: object }}
 */
export function addComment(store, post, { name, text, now = Date.now() } = {}) {
  const clean = normalizeText(text);
  if (!clean) return { ok: false, reason: "empty", store };
  if (!post) return { ok: false, reason: "no-post", store };

  const k = postKey(post);
  const next = { ...store };
  const arr = Array.isArray(next[k]) ? next[k].slice() : [];
  if (arr.length >= MAX_PER_POST) return { ok: false, reason: "full", store };

  arr.push({
    id: now + "-" + Math.random().toString(36).slice(2, 7),
    name: String(name || "Guest"),
    ts: now,
    text: clean,
  });
  next[k] = arr;
  return { ok: true, store: next };
}

/** 删除评论（返回新 store，不修改入参） */
export function removeComment(store, post, commentId) {
  const k = postKey(post);
  const next = { ...store };
  next[k] = listComments(store, post).filter((c) => c.id !== commentId);
  if (!next[k].length) delete next[k];
  return next;
}

/** 帖子总数（用户帖 + 示例帖） */
export function allPosts(myPosts) {
  return Array.isArray(myPosts) ? myPosts.slice() : [];
}