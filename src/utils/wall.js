/* 暖心墙云端数据层（第二批）
 * ------------------------------------------------------------
 * 上半部分是纯映射函数（不碰网络，Node 可单测）；
 * 下半部分是云操作（全部 try/catch，失败返回 null，由调用方降级）。
 * 数据表结构见根目录 SUPABASE_SETUP.sql。
 */

import { cloud } from "./supabase.js";
import { normalizeText } from "./comments.js";
import { isUsableDataUrl } from "./imaging.js";
/* 所有云端数据访问都走适配层：换库 / 换托管时只改 utils/api/db.js（见那里的文件头说明） */
import { db } from "./api/db.js";

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

/** Storage 路径 → 公开 URL（转发适配层；不可用时给空串，绝不打断渲染） */
function publicUrl(path) {
  return db.imageUrl(path);
}

/** 匿名可读：云端配置就绪即可读（RLS 对 anon 放行 SELECT，见 SUPABASE_SETUP.sql） */
export function canReadWall() {
  return !!(db.ready() && cloud.ready);
}

export function canUseWall() {
  return !!(db.ready() && cloud.user);
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
  try {
    const n = Number(limit) > 0 ? Number(limit) : SORT_WINDOW;
    const posts = await db.listPosts(n);
    let reactions = {};
    try {
      /* 只查当前窗口内这些帖的回应；全表 limit(2000) 会随用户增长漏算（P1 修复） */
      const ids = (posts || []).map((x) => x.id);
      const rk = ids.length ? await db.listReactionsByPosts(ids) : [];
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
  try {
    let imagePath = null;
    if (imageDataUrl) imagePath = await cloudUploadImage(imageDataUrl);
    const data = await db.insertPost({
      user_id: cloud.user.id,
      author_name: name || "Guest",
      body: clean || "\u{1F5BC}\uFE0F",
      image_path: imagePath,
    });
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
  try {
    const data = await db.listComments(dbPostId, 200);
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
  try {
    const row = { post_id: dbPostId, user_id: cloud.user.id, author_name: name || "Guest", body: clean };
    if (parentId != null && parentId !== "") row.parent_id = parentId;
    if (replyToName) row.reply_to_name = String(replyToName).slice(0, 40);
    const data = await db.insertComment(row);
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
  try {
    const data = await db.listCommentPostIds(ids, 2000);
    return countsFromRows(data || []);
  } catch (e) {
    console.warn("[cloud] fetchCommentCounts:", e);
    return null;
  }
}

/** 删除自己的评论（RLS 兜底），返回是否成功 */
export async function cloudDeleteComment(dbCommentId) {
  if (!canUseWall()) return false;
  try {
    await db.deleteComment(dbCommentId);
    return true;
  } catch (e) {
    console.warn("[cloud] deleteComment:", e);
    return false;
  }
}

/** 切换回应：已点 → 取消；未点 → 加上。返回最新计数或 null */
export async function cloudToggleReaction(dbPostId, kind) {
  if (!canUseWall()) return null;
  try {
    const uid = cloud.user.id;
    /* 先看我点过没：查询失败就当「没点过」（与原有行为一致，不因一次抖动中断这次操作） */
    let existing = null;
    try { existing = await db.findReaction({ postId: dbPostId, userId: uid, kind }); } catch (e) { /* 视为未点过 */ }
    if (existing) {
      await db.deleteReaction({ postId: dbPostId, userId: uid, kind });
    } else {
      await db.insertReaction({ post_id: dbPostId, user_id: uid, kind });
    }
    /* 重拉该帖回应，返回权威计数；重拉失败不影响「本次切换已生效」 */
    let rk = [];
    try { rk = (await db.listReactionsByPost(dbPostId)) || []; } catch (e) { /* 退化成默认计数 */ }
    const ag = aggregateReactions(rk, uid);
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
  try {
    const m = /^data:image\/(\w+);base64,(.+)$/.exec(dataUrl);
    if (!m) return null;
    const ext = m[1] === "jpeg" ? "jpg" : m[1];
    const bin = atob(m[2]);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const path = `${cloud.user.id}/${Date.now()}.${ext}`;
    await db.uploadImage(path, buf, { mime: `image/${m[1]}`, upsert: false });
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
  try {
    const data = await db.addView(dbPostId, String(viewer || "").slice(0, 64));
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
  try {
    const data = await db.toggleDislike(dbPostId);
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

/* ═════════ 墙上的主页（/u/:id）：点帖子头像/昵称进入 ══════════ */

/**
 * 拉取某用户的公开档案（昵称 / 加入时间）。
 * profiles 对匿名可读（RLS：readable by all），游客也能看主页。
 * @param {string} userId
 * @returns {Promise<{nickname:string, created_at:string|null}|null>} null = 查询失败
 */
export async function cloudFetchProfile(userId) {
  if (!canReadWall() || !userId) return null;
  try {
    const data = await db.getProfile(userId);
    /* 档案行不存在（极早期注册用户）不算失败，给空档案让页面用帖子署名兜底 */
    return data || { nickname: "", created_at: null };
  } catch (e) {
    console.warn("[cloud] fetchProfile:", e);
    return null;
  }
}

/**
 * 拉取某用户在暖心墙的帖子（新→旧；未下架优先口径与动态流一致：
 * 已跑迁移时数据库直接过滤 removed，未跑迁移时由调用方 visibleOnly 兜底）。
 * @param {string} userId
 * @param {number} [limit] 默认 50
 */
export async function cloudFetchUserPosts(userId, limit = 50) {
  if (!canReadWall() || !userId) return null;
  try {
    const n = Number(limit) > 0 ? Number(limit) : 50;
    const posts = await db.listPostsByUser(userId, n);
    let reactions = {};
    try {
      const ids = (posts || []).map((x) => x.id);
      const rk = ids.length ? await db.listReactionsByPosts(ids) : [];
      reactions = aggregateReactions(rk || [], cloud.user ? cloud.user.id : "");
    } catch (e) { /* 回应拉取失败不阻塞帖子 */ }
    return rowsToPosts(posts || [], reactions, publicUrl);
  } catch (e) {
    console.warn("[cloud] fetchUserPosts:", e);
    return null;
  }
}

/* ═════════ 主页的伙伴：宠物 + 手绘厨房（镜像同步 + 访客互动） ══════════ */

/** 主页展示的手绘料理上限（菜图是 320×240 JPEG dataURL，12 道已够一屏，也控住快照体积） */
export const PET_HOME_DISH_LIMIT = 12;
/** 单张菜图 dataURL 的长度上限（异常大的直接跳过，不拖垮整个快照） */
const DISH_IMG_MAX = 200000;
/** 单张图「引用」的长度上限：dataURL 走 DISH_IMG_MAX；Storage 路径（<uid>/pet-<hash>.jpg ≈ 50 字符）*/
export const PET_IMG_PATH_MAX = 200;
/**
 * 一行 data 的体积安全阀（约 1.8MB，给 D1 的 2MB 单行硬限制留余量）。
 * 图片正常都已外置（行里只有短路径）；只有「上传失败降级保留 dataURL」时才可能触顶。
 */
export const PET_DATA_MAX = 1800000;

/**
 * 图片引用是否合法（纯函数）。两种合法形态：
 *   1) dataURL：data:image/png|jpeg|webp;base64,… 且 ≤ DISH_IMG_MAX（本地新建 / 上传失败的降级残留）
 *   2) Storage 相对路径：`<uid>/pet-<hash>.<ext>`（已外置的正常形态，与 storage 策略前缀一致）
 * 外部 URL（含 `://`）、空串、含空白、多段或含 `..` 的伪路径一律拒绝 —— 不让垃圾进云端。
 */
export function isImageRef(ref) {
  if (typeof ref !== "string" || !ref) return false;
  if (ref.startsWith("data:")) return isUsableDataUrl(ref) && ref.length <= DISH_IMG_MAX;
  if (ref.length > PET_IMG_PATH_MAX || ref.includes("://") || /\s/.test(ref)) return false;
  const segs = ref.split("/");
  return segs.length === 2 && segs.every((s) => !!s && s !== "." && s !== "..");
}

/** dataURL 内容哈希（FNV-1a 32 位十六进制）：同一张图稳定得到同一个文件名，重传即幂等覆盖 */
export function imgRefHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * 解析 dataURL → { mime, ext, bytes, hash, size }；非图片 / 超限 / 解码失败 → null。
 * 只对 base64 段做哈希，同图不同前缀也算同一张图。
 */
export function parseImageDataUrl(dataUrl, max = DISH_IMG_MAX) {
  if (!isUsableDataUrl(dataUrl) || dataUrl.length > max) return null;
  const m = /^data:(image\/[\w+.-]+);base64,(.*)$/.exec(dataUrl);
  if (!m) return null;
  let bytes;
  try {
    if (typeof atob === "function") {
      const bin = atob(m[2]);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else {
      bytes = new Uint8Array(globalThis.Buffer.from(m[2], "base64"));
    }
  } catch (e) {
    return null;
  }
  if (!bytes.length) return null;
  const ext = m[1] === "image/jpeg" ? "jpg" : m[1].split("/").pop();
  return { mime: m[1], ext, bytes, hash: imgRefHash(m[2]), size: bytes.length };
}

/**
 * 图片字段 → 可直接喂 <img src> 的值（纯函数）：
 *   老数据 / 降级残留的 dataURL → 原样；完整 URL → 原样；Storage 路径 → toUrl() 换成公开 URL。
 */
export function resolvePetImg(ref, toUrl) {
  if (typeof ref !== "string" || !ref) return "";
  if (ref.startsWith("data:") || ref.includes("://")) return ref;
  return typeof toUrl === "function" ? toUrl(ref) || "" : "";
}

/**
 * 行体积安全阀（纯函数）：图片外置后 data 里只有短路径，正常永不触发。
 * 万一降级保留了超大 dataURL，按「先丢尾部菜图、再丢立绘」裁到预算内 —— 宁丢图，不丢整行
 * （行写不进去等于这个用户的宠物主页全丢）。
 * @returns {{payload: object, dropped: number}} dropped = 被丢掉的图片数（0 表示原样未动）
 */
export function shrinkPetPayload(payload, maxBytes = PET_DATA_MAX) {
  const size = (p) => JSON.stringify(p).length;
  if (!payload || typeof payload !== "object") return { payload, dropped: 0 };
  if (size(payload) <= maxBytes) return { payload, dropped: 0 };
  const out = {
    pet: payload.pet && typeof payload.pet === "object" ? { ...payload.pet } : null,
    dishes: (Array.isArray(payload.dishes) ? payload.dishes : []).map((d) => ({ ...d })),
    updated: payload.updated,
  };
  let dropped = 0;
  for (let i = out.dishes.length - 1; i >= 0 && size(out) > maxBytes; i--) {
    if (String(out.dishes[i].img || "").startsWith("data:")) { out.dishes[i].img = ""; dropped++; }
  }
  if (size(out) > maxBytes && out.pet && out.pet.custom && String(out.pet.custom.img || "").startsWith("data:")) {
    out.pet.custom = null;
    dropped++;
  }
  /* 兜底：连图都没有还超限（几乎不可能）→ 只留宠物本体 */
  if (size(out) > maxBytes) {
    out.dishes = [];
    if (out.pet) out.pet.custom = null;
  }
  return { payload: out, dropped };
}

/**
 * 清洗手绘料理列表：只留有效的 {id,name,img,effort}，截到上限。
 * img 允许两种形态：dataURL（本地刚画完 / 上传失败降级）或 Storage 路径（已外置）。
 * 纯函数（单测覆盖：非图片 dataURL / 超长图 / 外部 URL / 脏字段都被过滤）。
 */
export function cleanDishes(list, limit = PET_HOME_DISH_LIMIT) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const d of list) {
    if (!d || typeof d !== "object") continue;
    const img = typeof d.img === "string" ? d.img : "";
    if (!isImageRef(img)) continue;
    out.push({
      id: String(d.id == null ? "" : d.id).slice(0, 40),
      name: String(d.name == null ? "" : d.name).slice(0, 30),
      img,
      effort: Math.max(0, Number(d.effort) || 0),
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 宠物主页快照（发到云端的「最小公开面」）：
 * 只带展示需要的字段，不带亲密度/金币/心情日记等私人数据，
 * 也不带互动计数 —— counts 存在 pet_profiles 的 pats/feeds 独立列里，
 * 主人每次同步都会整体覆盖 data，带上就会把访客攒的计数清零。
 * @returns {object|null}
 */
export function petHomeSnapshot(pet, dishes, now = Date.now()) {
  if (!pet || typeof pet !== "object") return null;
  /* 立绘只收合法图片引用（dataURL 或已外置的 Storage 路径）；超长 dataURL 直接丢弃，不给行留隐患 */
  const customImg =
    pet.custom && typeof pet.custom === "object" && typeof pet.custom.img === "string" ? pet.custom.img : "";
  const custom = isImageRef(customImg) ? { img: customImg } : null;
  return {
    pet: {
      species: String(pet.species || "cat").slice(0, 20),
      name: String(pet.name || "Guest").slice(0, 30),
      personality: String(pet.personality || "").slice(0, 30),
      level: Math.max(1, Number(pet.level) || 1),
      sleeping: pet.sleeping === true,
      custom, // 用户上传的立绘（dataURL）
    },
    dishes: cleanDishes(dishes),
    updated: now,
  };
}

/**
 * 互动计数：读 pet_profiles 的独立列 pats / feeds（不是 data 里的字段）。
 * 纯函数：行缺失 / 脏值一律归 0（单测覆盖）。
 * 独立成列的原因：主人同步是整体覆盖 data，计数若写进 data 会被覆盖成 0。
 */
export function petCounts(row) {
  const r = row && typeof row === "object" ? row : {};
  return {
    pats: Math.max(0, Number(r.pats) || 0),
    feeds: Math.max(0, Number(r.feeds) || 0),
  };
}

/**
 * 统一云端快照的形状（行不存在/字段缺失都给默认值；计数取独立列）。
 * 图片字段统一转成可直接显示的 URL：老数据是 dataURL（原样），新数据是 Storage 路径（拼公开 URL）。
 */
function petHomeFromData(row) {
  const d = row && row.data && typeof row.data === "object" ? row.data : {};
  const pet = d.pet && typeof d.pet === "object" ? { ...d.pet } : null;
  if (pet) {
    const img = pet.custom && typeof pet.custom === "object" ? resolvePetImg(pet.custom.img, publicUrl) : "";
    pet.custom = img ? { img } : null;
  }
  return {
    pet,
    dishes: (Array.isArray(d.dishes) ? d.dishes : []).map((x) => ({
      ...x,
      img: resolvePetImg(x && x.img, publicUrl),
    })),
    counts: petCounts(row),
    updated: Number(d.updated) || 0,
  };
}

/**
 * 拉某用户的宠物主页（匿名可读；未跑迁移 → null，调用方隐藏区块即可）。
 */
export async function cloudGetPetHome(userId) {
  if (!canReadWall() || !userId) return null;
  try {
    /* 适配层内部已处理「老库没补 pats/feeds 列」的退回查询（计数归 0，区块照常出现） */
    return petHomeFromData(await db.getPetProfile(userId));
  } catch (e) {
    console.warn("[cloud] getPetHome:", e);
    return null;
  }
}

/** 会话内：同一张图（内容哈希）只上传一次，省流量也避免重复覆盖同名对象 */
const petImgUploaded = new Map();

/**
 * 宠物图上传：dataURL → Storage 路径 `<uid>/pet-<hash>.<ext>`。
 * 与墙图同桶同前缀约定（storage 策略按 (storage.foldername(name))[1] = auth.uid() 授权），
 * 因此不需要新增任何 SQL / 策略；同一张图重传是幂等覆盖（upsert）。
 * 失败返回 null —— 调用方降级保留 dataURL（图不丢，只是行变大，见 shrinkPetPayload）。
 * @returns {Promise<string|null>} Storage 路径
 */
export async function cloudUploadPetImage(dataUrl) {
  if (!canUseWall()) return null;
  const parsed = parseImageDataUrl(dataUrl);
  if (!parsed) return null;
  const hit = petImgUploaded.get(parsed.hash);
  if (hit) return hit;
  try {
    const path = `${cloud.user.id}/pet-${parsed.hash}.${parsed.ext}`;
    await db.uploadImage(path, parsed.bytes, { mime: parsed.mime, upsert: true });
    petImgUploaded.set(parsed.hash, path);
    return path;
  } catch (e) {
    console.warn("[cloud] uploadPetImage:", e);
    cloud.error = e && e.message ? e.message : String(e);
    return null;
  }
}

/** 单个引用外置：dataURL → Storage 路径；已经是路径 / 上传失败 → 原样返回（失败不阻断整次同步） */
async function externalizePetImg(ref) {
  if (typeof ref !== "string" || !ref.startsWith("data:")) return ref;
  const path = await cloudUploadPetImage(ref);
  return path || ref;
}

/**
 * 组装要写进 data 的展示面：图片外置（dataURL → Storage 路径）→ 白名单字段 → 行体积安全阀。
 * pet 字段逐项白名单化（与 petHomeSnapshot 同一套规则，双层保险），
 * 永不带 counts —— 那是 pet_profiles 的独立列，主人同步绝不能覆盖。
 */
async function toCloudPetData(snapshot) {
  const petIn = snapshot.pet && typeof snapshot.pet === "object" ? snapshot.pet : null;
  let pet = null;
  if (petIn) {
    const customIn =
      petIn.custom && typeof petIn.custom === "object" && typeof petIn.custom.img === "string"
        ? petIn.custom.img
        : "";
    const img = await externalizePetImg(customIn);
    pet = {
      species: String(petIn.species || "cat").slice(0, 20),
      name: String(petIn.name || "Guest").slice(0, 30),
      personality: String(petIn.personality || "").slice(0, 30),
      level: Math.max(1, Number(petIn.level) || 1),
      sleeping: petIn.sleeping === true,
      custom: isImageRef(img) ? { img } : null,
    };
  }
  const dishes = cleanDishes(snapshot.dishes);
  await Promise.all(
    dishes.map(async (d) => {
      const img = await externalizePetImg(d.img);
      d.img = isImageRef(img) ? img : "";
    }),
  );
  return {
    pet,
    dishes: dishes.filter((d) => d.img),
    updated: Number(snapshot.updated) || Date.now(),
  };
}

/**
 * 推送我的宠物主页快照（登录才可用；RLS 只许写自己的行）。
 * 只写 data（pet/dishes/updated）：图片实体在 Storage（这里只存路径），
 * pats/feeds 是访客互动计数（独立列），两者都不会被这次覆盖动到。
 */
export async function cloudSavePetHome(snapshot) {
  if (!canUseWall() || !snapshot || typeof snapshot !== "object") return false;
  try {
    const payload = await toCloudPetData(snapshot);
    const { payload: fitted, dropped } = shrinkPetPayload(payload);
    if (dropped) console.warn("[cloud] savePetHome: 图片外置失败导致行超预算，已丢弃图片数 =", dropped);
    await db.upsertPetProfile(cloud.user.id, fitted, new Date().toISOString());
    return true;
  } catch (e) {
    console.warn("[cloud] savePetHome:", e);
    return false;
  }
}

/**
 * 访客互动（摸摸头 / 投喂）：服务端按 访客+UTC日+类型 去重，计数存主人档案里。
 * @param {string} ownerId 主人 uid
 * @param {"pat"|"feed"} kind
 * @param {string} viewer 访客标识（登录 = uid，游客 = 本机匿名 id）
 * @returns {Promise<{counted:boolean,pats:number,feeds:number}|null>}
 */
export async function cloudPetInteract(ownerId, kind, viewer = "") {
  if (!canReadWall() || !ownerId) return null;
  if (kind !== "pat" && kind !== "feed") return null;
  try {
    const data = await db.petInteract(ownerId, kind, String(viewer || "").slice(0, 64));
    if (!data || data.ok === false) return null;
    /* 兼容两种返回：{counts:{pats,feeds}}（当前）与顶层 {pats,feeds}（老版本） */
    const c = data.counts && typeof data.counts === "object" ? data.counts : data;
    return {
      counted: data.counted === true,
      pats: Math.max(0, Number(c.pats) || 0),
      feeds: Math.max(0, Number(c.feeds) || 0),
    };
  } catch (e) {
    /* 未跑迁移 → null，UI 提示功能未启用 */
    console.warn("[cloud] petInteract:", e);
    return null;
  }
}

/* —— 本地 → 云端 的防抖镜像队列（petStore 的 savePet/saveCookbook 会调用） —— */
let petSyncTimer = null;
let petSyncGet = null;
let petSyncBusy = false;

/**
 * 登记一个快照工厂并在 delay 毫秒后推送到云端（连续保存只推最后一次）。
 * 不依赖 petStore（由调用方传入取快照的函数），避免循环依赖；
 * 未登录时到点自动跳过 —— 下次保存再试。
 */
export function queuePetHomeSync(getSnapshot, delay = 4000) {
  if (typeof getSnapshot !== "function") return;
  petSyncGet = getSnapshot;
  if (petSyncTimer) clearTimeout(petSyncTimer);
  petSyncTimer = setTimeout(async () => {
    petSyncTimer = null;
    if (!petSyncGet || petSyncBusy || !canUseWall()) return;
    const snap = petSyncGet();
    if (!snap) return;
    petSyncBusy = true;
    try { await cloudSavePetHome(snap); } finally { petSyncBusy = false; }
  }, Math.max(500, delay));
}
