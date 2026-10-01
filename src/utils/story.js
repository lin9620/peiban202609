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
  countChars, readMinutes, TITLE_MAX, BODY_MAX, TAGS_MAX, TAG_MAX, SORT_MODES, DEFAULT_MODE,
} from "./storyRules.js";

export {
  storyErrKey, countChars, readMinutes, normalizeTags,
  TITLE_MAX, BODY_MAX, TAGS_MAX, TAG_MAX, SORT_MODES, DEFAULT_MODE,
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
