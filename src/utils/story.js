/* 故事栏（轮 145 批 1）：云操作封装（规则在 storyRules.js，纯函数可直测）
 * ------------------------------------------------------------
 * 玩法：投稿故事（标题 + 正文 ≤3 万字 + 1~3 标签）→ 发现流阅读 → 点赞 → 四榜。
 * 权限与校验是服务端权威（MIGRATION_story.sql 的 5 个 RPC），前端 validate 只做即时反馈。
 * 走网关时由 Worker /api/story/* 收口（与漂流瓶同惯例）。
 */
import { cloud } from "./supabase.js";
import { db } from "./api/db.js";
import { keys, removeItem, getItem, setItem } from "./storage.js";
import {
  validatePublish, normalizeTags, storyErrKey,
  countChars, readMinutes, TITLE_MAX, BODY_MAX, BODY_MIN, TAGS_MAX, TAG_MAX, SORT_MODES, DEFAULT_MODE,
  PRESET_TAGS,
} from "./storyRules.js";

export {
  storyErrKey, countChars, readMinutes, normalizeTags,
  TITLE_MAX, BODY_MAX, BODY_MIN, TAGS_MAX, TAG_MAX, SORT_MODES, DEFAULT_MODE, PRESET_TAGS,
};

/** 故事栏要登录才能投稿/点赞；浏览公开内容不需要 */
export function canStory() {
  return !!(cloud.ready && cloud.user);
}

/* ── 本地草稿兜底（停手 3 秒自动存；云端 draft 是权威，本地是断网/崩溃保险） ── */
const DRAFT_KEY = "warm-paws-story-draft-v1";
export function saveLocalDraft(d) {
  try { setItem(DRAFT_KEY, JSON.stringify(d)); } catch (e) { /* 存储满等：静默 */ }
}
export function loadLocalDraft() {
  try { const raw = getItem(DRAFT_KEY); return raw ? JSON.parse(raw) : null; }
  catch (e) { return null; }
}
export function clearLocalDraft() {
  try { removeItem(DRAFT_KEY); } catch (e) { /* 静默 */ }
  for (const k of keys("wp-cache:v1:story:")) removeItem(k);   /* 连带清 SWR 旧快照 */
}

/* ══════════ 云操作（失败抛错给调用方展示，校验以服务端为准） ══════════ */

/** 存草稿（宽容：标题可空；服务端同一张表 status=draft）；返回整行 */
export async function storySaveDraft({ id = null, title = "", body = "", tags = [] } = {}) {
  const b = String(body ?? "");
  if (countChars(b) > BODY_MAX) throw new Error("story-too-long");   /* 前端先挡，不白跑一趟 */
  return db.storySaveDraft(id, String(title ?? "").trim(), b, normalizeTags(tags));
}

/** 发布（校验标题/正文/标签 → 通过返回整行；新稿 insert、旧稿 rev+1） */
export async function storyPublish({ id = null, title = "", body = "", tags = [] } = {}) {
  const v = validatePublish({ title, body, tags });
  if (v) {
    /* validate 短码 → 服务端错误码对齐，让 storyErrKey 归类同一套 i18n key */
    throw new Error(v === "bad-title" ? "story-bad-title"
      : v === "empty-body" ? "story-empty-body"
      : v === "too-short" ? "story-too-short"
      : v === "too-long" ? "story-too-long" : "story-bad-tags");
  }
  return db.storyPublish(id, String(title).trim(), String(body), normalizeTags(tags));
}

/** 赞/取消赞：服务端权威（唯一约束防重），返回 true=已赞 false=取消 */
export function storyToggleLike(id) {
  return db.storyToggleLike(id);
}

/** 记一次浏览（同人同故事同日只计一次，服务端去重） */
export function storyAddView(id) {
  return db.storyAddView(id);
}

/** 四榜：mode = random | latest | monthly | tag；tag 配合 tag 模式；period 'YYYY-MM'（月→周只换参数） */
export function storyRank({ mode = DEFAULT_MODE, tag = null, period = null, limit = 20, offset = 0 } = {}) {
  const m = SORT_MODES.includes(mode) ? mode : DEFAULT_MODE;
  return db.storyRank(m, tag, period, limit, offset);
}

/** 单篇详情（published 给所有人；自己的草稿自己可见 —— RLS 裁定） */
export function storyGet(id) {
  return db.storyGet(id);
}

/** 我的投稿：status = 'draft' | 'published'，新→旧 */
export function storyMine(status = null) {
  return db.storyMine(status);
}

/** 删除草稿：服务端只允许删自己的 status='draft'，已发布故事不会走到这里 */
export function storyDeleteDraft(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw new Error("story-not-found");
  return db.storyDeleteDraft(n);
}

/* ══════════ 批 2：评论 / 书架 / 每日精选 / 数据面板（RPC 8-15） ══════════ */

/** 评论上限（与 SQL 端 story_add_comment 的 char_length>1000 同口径，前端先挡） */
export const COMMENT_MAX = 1000;

/** 评论列表（published 全员可读；mine 字段供前端标「我的」） */
export function storyCommentList(id, limit = 50) {
  return db.storyCommentList(id, limit);
}

/** 发评论：空白/超长前端先挡（省一趟往返），最终以服务端为准 */
export function storyAddComment(id, body) {
  const b = String(body ?? "").trim();
  if (!b) throw new Error("story-comment-empty");
  if (countChars(b) > COMMENT_MAX) throw new Error("story-comment-long");
  return db.storyAddComment(id, b);
}

/** 删评论（评论作者或故事作者，服务端裁定） */
export function storyDeleteComment(id) {
  return db.storyDeleteComment(id);
}

/** 收藏/取消：true=已收藏 false=已取消 */
export function storyToggleBookmark(id) {
  return db.storyToggleBookmark(id);
}

/* ══════════ 批 3：幂等「设置」语义（轮 321：详情页乐观更新要它） ══════════ */

/* 批 3 迁移（story_set_like / story_set_bookmark）没跑时的兜底：
   老库只有「翻转」语义 —— 先翻一次看现状，与目标不一致就再翻一次校准回去。
   结果与幂等设置一致（只是多一趟往返），前端那套「设成目标态」的逻辑照样成立。 */
async function setLikeFallback(id, on) {
  const now = await db.storyToggleLike(id);
  if (!!now === !!on) return { ok: true, count: null };
  const back = await db.storyToggleLike(id);
  return { ok: true, count: null, flipped: !!back };
}
async function setBookmarkFallback(id, on) {
  const now = await db.storyToggleBookmark(id);
  if (!!now === !!on) return { ok: true, count: null };
  const back = await db.storyToggleBookmark(id);
  return { ok: true, count: null, flipped: !!back };
}

/**
 * 赞：设成目标态（幂等）。
 * 与 storyToggleLike 的区别：toggle 是「翻一下」，set 是「设成 on」——
 * 前端做乐观更新时必须用 set，否则失败重试会把状态翻反（点一下赞 → 又变回没赞）。
 * @param {number} id 故事 id
 * @param {boolean} on 目标态
 * @returns {Promise<{ok:boolean,count:number|null}>} count = 服务端权威赞数（拿不到 null）
 */
export async function storySetLike(id, on) {
  try {
    return await db.storySetLike(id, on);
  } catch (e) {
    if (/story-set-like-missing/.test(String(e?.message ?? e))) return setLikeFallback(id, on);
    throw e;
  }
}

/**
 * 收藏：设成目标态（幂等）。
 * @returns {Promise<{ok:boolean,count:number|null}>} count = 服务端权威收藏数
 */
export async function storySetBookmark(id, on) {
  try {
    return await db.storySetBookmark(id, on);
  } catch (e) {
    if (/story-set-bookmark-missing/.test(String(e?.message ?? e))) return setBookmarkFallback(id, on);
    throw e;
  }
}

/**
 * 我赞了/收藏了哪些（批量一次往返）。
 * @returns {Promise<Array|null>} [{ story_id, liked, marked }]；拿不到（老库）→ null
 */
export function storyMyFlags(ids) {
  return db.storyMyFlags(ids);
}

/** 我的书架（收藏时间倒序） */
export function storyBookmarkList(limit = 30, offset = 0) {
  return db.storyBookmarkList(limit, offset);
}

/** 每日精选（没有则 null —— 空数组已归一成 null，调用方不用判两种形态） */
export function storyFeatured() {
  return db.storyFeatured();
}

/** 我的数据面板（篇数/获赞/阅读/评论/收藏 + 最高赞一篇；无则 null） */
export function storyMyStats() {
  return db.storyMyStats();
}
