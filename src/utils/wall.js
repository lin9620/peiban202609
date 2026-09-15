/* 暖心墙云端数据层（第二批）
 * ------------------------------------------------------------
 * 上半部分是纯映射函数（不碰网络，Node 可单测）；
 * 下半部分是云操作（全部 try/catch，失败返回 null，由调用方降级）。
 * 数据表结构见根目录 SUPABASE_SETUP.sql。
 */

import { getClient, cloud } from "./supabase.js";
import { normalizeText } from "./comments.js";

export const PAGE_SIZE = 30;

/* ══════════ 纯函数：DB 行 → 视图模型（与本地帖子结构对齐） ══════════ */

/**
 * @param {Array} rows  wall_posts 行（snake_case）
 * @param {Object} reactions  aggregateReactions() 的输出：Map[postId] → {hug,warm,relate,mine}
 * @param {(path: string) => string} imageUrlFor  把 Storage 路径换成公开 URL
 * @returns {Array} 视图帖子：{ id, name, text, img, ts, reacts, cloud, userId, imagePath }
 */
export function rowsToPosts(rows, reactions = {}, imageUrlFor = () => "") {
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => ({
    id: "c" + r.id,                       // 云端帖 id 加前缀，避免与本地数字 id 撞 key
    dbId: r.id,
    name: r.author_name || "Guest",
    text: r.body || "",
    img: r.image_path ? imageUrlFor(r.image_path) : "",
    ts: Date.parse(r.created_at) || Date.now(),
    reacts: {
      hug: (reactions[r.id] && reactions[r.id].hug) || 0,
      warm: (reactions[r.id] && reactions[r.id].warm) || 0,
      relate: (reactions[r.id] && reactions[r.id].relate) || 0,
    },
    mine: reactions[r.id] ? reactions[r.id].mine : { hug: false, warm: false, relate: false },
    cloud: true,
    userId: r.user_id,
    imagePath: r.image_path || "",
  }));
}

/**
 * 聚合回应行 → { [postId]: { hug, warm, relate, mine: {hug,warm,relate} } }
 * @param {Array} rows wall_reactions 行
 * @param {string} userId 当前用户（判定 mine）
 */
export function aggregateReactions(rows, userId = "") {
  const out = {};
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    const o = out[r.post_id] || (out[r.post_id] = { hug: 0, warm: 0, relate: 0, mine: { hug: false, warm: false, relate: false } });
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
  }));
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

/** 拉取最新帖子（含回应聚合），失败返回 null */
export async function cloudFetchPosts() {
  if (!canReadWall()) return null;
  const sb = getClient();
  try {
    const { data: posts, error } = await sb
      .from("wall_posts")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(PAGE_SIZE);
    if (error) throw error;
    let reactions = {};
    try {
      /* 只查当前页 30 帖的回应；全表 limit(2000) 会随用户增长漏算（P1 修复） */
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

/** 发表评论，返回视图评论或 null */
export async function cloudInsertComment(dbPostId, text, name) {
  if (!canUseWall()) return null;
  const clean = normalizeText(text);
  if (!clean) return null;
  const sb = getClient();
  try {
    const { data, error } = await sb
      .from("wall_comments")
      .insert({ post_id: dbPostId, user_id: cloud.user.id, author_name: name || "Guest", body: clean })
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
