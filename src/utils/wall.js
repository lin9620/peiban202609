/* 暖心墙云端数据层（第二批）
 * ------------------------------------------------------------
 * 上半部分是纯映射函数（不碰网络，Node 可单测）；
 * 下半部分是云操作（全部 try/catch，失败返回 null，由调用方降级）。
 * 数据表结构见根目录 SUPABASE_SETUP.sql。
 */

import { getClient, cloud } from "./supabase.js";
import { normalizeText } from "./comments.js";

/* ══════════ 纯函数：DB 行 → 视图模型（与本地帖子结构对齐） ══════════ */

/**
 * @param {Array} rows  wall_posts 行（snake_case）
 * @param {Object} reactions  aggregateReactions() 的输出：Map[postId] → {hug,warm,relate,dislike,mine}
 * @param {(path: string) => string} imageUrlFor  把 Storage 路径换成公开 URL
 * @returns {Array} 视图帖子：{ id, name, text, img, ts, reacts, mine, views, dislikes, removed, cloud, userId, imagePath }
 */
export function rowsToPosts(rows, reactions = {}, imageUrlFor = () => "") {
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => {
    const ag = reactions[r.id] || {};
    /* 厌恶数优先用表里的 dislikes 列（服务端维护、权威）；没迁移时退回回应行聚合值 */
    const dislikes = r.dislikes != null ? Math.max(0, Number(r.dislikes) || 0) : (ag.dislike || 0);
    return {
      id: "c" + r.id,                       // 云端帖 id 加前缀，避免与本地数字 id 撞 key
      dbId: r.id,
      name: r.author_name || "Guest",
      text: r.body || "",
      img: r.image_path ? imageUrlFor(r.image_path) : "",
      ts: Date.parse(r.created_at) || Date.now(),
      reacts: {
        hug: (ag.hug) || 0,
        warm: (ag.warm) || 0,
        relate: (ag.relate) || 0,
        dislike: dislikes,
      },
      mine: { ...EMPTY_MINE, ...(ag.mine || {}) },
      views: Math.max(0, Number(r.views) || 0),      // 浏览数（未迁移时为 0）
      dislikes,
      removed: r.removed === true,                   // 假删除：达到下架线的帖子
      /* 这一行数据是否来自「已跑迁移」的库：否则界面上别显示假的 0 次浏览/0 厌恶 */
      stats: r.views != null || r.dislikes != null || r.removed != null,
      cloud: true,
      userId: r.user_id,
      imagePath: r.image_path || "",
    };
  });
}

/** 回应的空状态：每种回应「我点过没有」 */
const EMPTY_MINE = { hug: false, warm: false, relate: false, dislike: false };

/**
 * 聚合回应行 → { [postId]: { hug, warm, relate, dislike, mine: {...} } }
 * @param {Array} rows wall_reactions 行
 * @param {string} userId 当前用户（判定 mine）
 */
export function aggregateReactions(rows, userId = "") {
  const out = {};
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    const o = out[r.post_id] || (out[r.post_id] = { hug: 0, warm: 0, relate: 0, dislike: 0, mine: { ...EMPTY_MINE } });
    if (o[r.kind] !== undefined) o[r.kind]++;
    if (userId && r.user_id === userId && o.mine[r.kind] !== undefined) o.mine[r.kind] = true;
  }
  return out;
}

/** 云端评论行 → 视图评论（对齐本地评论结构；userId 用于删除权限判定） */
export function rowsToComments(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => ({
    id: "c" + r.id,
    dbId: r.id,
    name: r.author_name || "Guest",
    text: r.body || "",
    ts: Date.parse(r.created_at) || Date.now(),
    cloud: true,
    userId: r.user_id,
    /* 二级评论：parent_id 是 DB 主键，这里统一加上 c 前缀，和 id 命名保持一致 */
    parentId: r.parent_id ? "c" + r.parent_id : null,
    replyTo: r.reply_to_name || "",
  }));
}

/**
 * 评论行 → 「每帖评论条数」表： { [postId]: n }
 * 进页面时用它一次性把评论数显示出来（不必等用户点开评论区再拉）
 * @param {Array} rows wall_comments 行（至少含 post_id）
 */
export function countsFromRows(rows) {
  const out = {};
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    if (r && r.post_id != null) out[r.post_id] = (out[r.post_id] || 0) + 1;
  }
  return out;
}

/** 本地帖能否在云端删除：自己的帖子/评论（与 RLS 双保险） */
export function canDeleteCloud(item, userId = "") {
  return !!(item && item.cloud && userId && item.userId === userId);
}

/* ══════════ 云操作（下半部分） ══════════ */

function publicUrl(path) {
  const sb = getClient();
  try {
    const { data } = sb.storage.from("wall-images").getPublicUrl(path);
    return (data && data.publicUrl) || "";
  } catch (e) { return ""; }
}

/** 匿名可读：云端配置就绪即可读（RLS 对 anon 放行 SELECT，见 SUPABASE_SETUP.sql） */
export function canReadWall() {
  const sb = getClient();
  return !!(sb && cloud.ready);
}

export function canUseWall() {
  const sb = getClient();
  return !!(sb && cloud.user);
}

/** 排序窗口：热度排序在这批帖内进行（比一屏 30 条宽，够体现「最多的排前面」） */
export const SORT_WINDOW = 200;

/**
 * 拉取帖子（含回应聚合），失败返回 null。
 *   - 按发布时间倒序取最近 limit 条
 *   - 已跑迁移：由数据库排除「假删除」（下架）的帖子；未跑迁移：退回客户端过滤
 * @param {number} [limit] 默认 SORT_WINDOW（排序用的大窗口）
 */
export async function cloudFetchPosts(limit = SORT_WINDOW) {
  if (!canReadWall()) return null;
  const sb = getClient();
  try {
    const n = Number(limit) > 0 ? Number(limit) : SORT_WINDOW;
    /* 先带 removed 过滤（迁移后才有这一列）；42703 列不存在时退回不带过滤的查询 */
    let res = await sb
      .from("wall_posts")
      .select("*")
      .eq("removed", false)
      .order("created_at", { ascending: false })
      .limit(n);
    if (res.error) {
      res = await sb
        .from("wall_posts")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(n);
    }
    const { data: posts, error } = res;
    if (error) throw error;
    let reactions = {};
    try {
      /* 只查当前窗口内这些帖的回应；全表 limit(2000) 会随用户增长漏算（P1 修复） */
      const ids = (posts || []).map((x) => x.id);
      const { data: rk } = ids.length
        ? await sb.from("wall_reactions").select("post_id,user_id,kind").in("post_id", ids)
        : { data: [] };
      reactions = aggregateReactions(rk || [], cloud.user ? cloud.user.id : "");
    } catch (e) { /* 回应拉取失败不阻塞帖子 */ }
    return rowsToPosts(posts || [], reactions, publicUrl);
  } catch (e) {
    console.warn("[cloud] fetchPosts:", e);
    cloud.error = e && e.message ? e.message : String(e);
    return null;
  }
}

/** 发布帖子；imageDataUrl 可空。返回视图帖子或 null */
export async function cloudInsertPost({ text, imageDataUrl, name }) {
  if (!canUseWall()) return null;
  const clean = String(text || "").trim().slice(0, 1000);
  if (!clean && !imageDataUrl) return null;
  const sb = getClient();
  try {
    let imagePath = null;
    if (imageDataUrl) imagePath = await cloudUploadImage(imageDataUrl);
    const { data, error } = await sb
      .from("wall_posts")
      .insert({ user_id: cloud.user.id, author_name: name || "Guest", body: clean || "\u{1F5BC}\uFE0F", image_path: imagePath })
      .select("*")
      .single();
    if (error) throw error;
    const view = rowsToPosts([data], {}, publicUrl)[0];
    view.img = imageDataUrl && !view.img ? imageDataUrl : view.img; // 上传失败时仍可本地预览
    return view;
  } catch (e) {
    console.warn("[cloud] insertPost:", e);
    cloud.error = e && e.message ? e.message : String(e);
    return null;
  }
}

/** 拉取某帖评论（旧→新），失败返回 null */
export async function cloudFetchComments(dbPostId) {
  if (!canReadWall()) return null;
  const sb = getClient();
  try {
    const { data, error } = await sb
      .from("wall_comments")
      .select("*")
      .eq("post_id", dbPostId)
      .order("created_at", { ascending: true })
      .limit(200);
    if (error) throw error;
    return rowsToComments(data || []);
  } catch (e) {
    console.warn("[cloud] fetchComments:", e);
    return null;
  }
}

/**
 * 发表评论（parentId 为空 = 一级评论；有值 = 二级回复，传被回复评论的 DB id）
 * @param {object} [opts] { parentId, replyToName } —— replyToName 只在回复「别人的回复」时给，用于显示 @谁
 * @returns {Promise<object|null>} 视图评论
 */
export async function cloudInsertComment(dbPostId, text, name, { parentId = null, replyToName = "" } = {}) {
  if (!canUseWall()) return null;
  const clean = normalizeText(text);
  if (!clean) return null;
  const sb = getClient();
  try {
    const row = { post_id: dbPostId, user_id: cloud.user.id, author_name: name || "Guest", body: clean };
    if (parentId != null && parentId !== "") row.parent_id = parentId;
    if (replyToName) row.reply_to_name = String(replyToName).slice(0, 40);
    const { data, error } = await sb
      .from("wall_comments")
      .insert(row)
      .select("*")
      .single();
    if (error) throw error;
    return rowsToComments([data])[0];
  } catch (e) {
    console.warn("[cloud] insertComment:", e);
    cloud.error = e && e.message ? e.message : String(e);
    return null;
  }
}

/**
 * 拉取「当前页这些帖」各自的评论条数（含回复），失败返回 null
 * 修复：以前评论数要等用户点开评论区、拉到评论明细才知道，进页面时一直显示 0
 * @param {number[]} dbPostIds
 * @returns {Promise<Object|null>} { [postId]: n }
 */
export async function cloudFetchCommentCounts(dbPostIds) {
  if (!canReadWall()) return null;
  const ids = Array.isArray(dbPostIds) ? dbPostIds.filter((x) => x != null) : [];
  if (!ids.length) return {};
  const sb = getClient();
  try {
    const { data, error } = await sb
      .from("wall_comments")
      .select("post_id")
      .in("post_id", ids)
      .limit(2000);
    if (error) throw error;
    return countsFromRows(data || []);
  } catch (e) {
    console.warn("[cloud] fetchCommentCounts:", e);
    return null;
  }
}

/** 删除自己的评论（RLS 兜底），返回是否成功 */
export async function cloudDeleteComment(dbCommentId) {
  if (!canUseWall()) return false;
  const sb = getClient();
  try {
    const { error } = await sb.from("wall_comments").delete().eq("id", dbCommentId);
    return !error;
  } catch (e) {
    console.warn("[cloud] deleteComment:", e);
    return false;
  }
}

/** 切换回应：已点 → 取消；未点 → 加上。返回最新计数或 null */
export async function cloudToggleReaction(dbPostId, kind) {
  if (!canUseWall()) return null;
  const sb = getClient();
  try {
    const uid = cloud.user.id;
    const { data: existing } = await sb
      .from("wall_reactions")
      .select("post_id")
      .eq("post_id", dbPostId).eq("user_id", uid).eq("kind", kind)
      .maybeSingle();
    if (existing) {
      const { error } = await sb.from("wall_reactions")
        .delete().eq("post_id", dbPostId).eq("user_id", uid).eq("kind", kind);
      if (error) throw error;
    } else {
      const { error } = await sb.from("wall_reactions")
        .insert({ post_id: dbPostId, user_id: uid, kind });
      if (error) throw error;
    }
    /* 重拉该帖回应，返回权威计数 */
    const { data: rk } = await sb.from("wall_reactions")
      .select("post_id,user_id,kind").eq("post_id", dbPostId);
    const ag = aggregateReactions(rk || [], uid);
    return ag[dbPostId] || { hug: 0, warm: 0, relate: 0, mine: { hug: false, warm: false, relate: false } };
  } catch (e) {
    console.warn("[cloud] toggleReaction:", e);
    cloud.error = e && e.message ? e.message : String(e);
    return null;
  }
}

/** 上传图片（前端已压缩成 dataURL）→ Storage，返回路径或 null */
export async function cloudUploadImage(dataUrl) {
  if (!canUseWall() || !dataUrl) return null;
  const sb = getClient();
  try {
    const m = /^data:image\/(\w+);base64,(.+)$/.exec(dataUrl);
    if (!m) return null;
    const ext = m[1] === "jpeg" ? "jpg" : m[1];
    const bin = atob(m[2]);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const path = `${cloud.user.id}/${Date.now()}.${ext}`;
    const { error } = await sb.storage.from("wall-images")
      .upload(path, buf, { contentType: `image/${m[1]}`, upsert: false });
    if (error) throw error;
    return path;
  } catch (e) {
    console.warn("[cloud] uploadImage:", e);
    cloud.error = e && e.message ? e.message : String(e);
    return null;
  }
}

/* ═════════ 浏览数 / 厌恶（走 RPC，服务端权威） ══════════ */

/**
 * 记一次浏览：同一访客对同一条帖，一天只 +1（服务端 wall_post_views 去重）。
 * 游客也能调（viewer 传本机匿名 id）。
 * @param {number} dbPostId
 * @param {string} viewer 登录用户 = uid；游客 = 匿名 id
 * @returns {Promise<{views:number,dislikes:number,removed:boolean,counted:boolean}|null>}
 */
export async function cloudAddView(dbPostId, viewer = "") {
  if (!canReadWall() || dbPostId == null) return null;
  const sb = getClient();
  try {
    const { data, error } = await sb.rpc("wall_add_view", {
      p_post: dbPostId,
      p_viewer: String(viewer || "").slice(0, 64),
    });
    if (error) throw error;
    if (!data || data.ok === false) return null;
    return {
      views: Math.max(0, Number(data.views) || 0),
      dislikes: Math.max(0, Number(data.dislikes) || 0),
      removed: data.removed === true,
      counted: data.counted === true,
    };
  } catch (e) {
    /* 未跑迁移时这里会 404/PGRST202：静默降级（浏览数就不显示了），不打断阅读 */
    console.warn("[cloud] addView:", e);
    cloud.error = e && e.message ? e.message : String(e);
    return null;
  }
}

/**
 * 切换厌恶（登录用户；RPC 内部计数并在达到 1% 时把帖子下架）。
 * @param {number} dbPostId
 * @returns {Promise<{on:boolean,views:number,dislikes:number,removed:boolean}|null>}
 */
export async function cloudToggleDislike(dbPostId) {
  if (!canUseWall() || dbPostId == null) return null;
  const sb = getClient();
  try {
    const { data, error } = await sb.rpc("wall_toggle_dislike", { p_post: dbPostId });
    if (error) throw error;
    if (!data || data.ok === false) {
      cloud.error = data && data.reason ? data.reason : "dislike failed";
      return null;
    }
    return {
      on: data.on === true,
      views: Math.max(0, Number(data.views) || 0),
      dislikes: Math.max(0, Number(data.dislikes) || 0),
      removed: data.removed === true,
    };
  } catch (e) {
    console.warn("[cloud] toggleDislike:", e);
    cloud.error = e && e.message ? e.message : String(e);
    return null;
  }
}
