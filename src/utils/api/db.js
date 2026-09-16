/* 云端数据访问适配层（阶段 1）
 * ------------------------------------------------------------
 * wall.js 里所有「真正碰云端」的调用都收口到这里：
 *   PostgREST 查询（from/select/insert/delete）、RPC（rpc）、Storage（upload / 公开 URL）。
 * 目的：以后换库或换托管（Hyperdrive 接别的 Postgres、D1、或自建 HTTP API）时，
 *       **只改这一个文件**；上层的业务判断、字段映射、降级策略（都是纯函数、有单测）原样不动。
 *
 * 约定：
 *   1. 这里只做「一次数据访问」：不做业务判断、不写日志、不自行降级 ——
 *      出错一律 throw，由 wall.js 的 try/catch 按原有方式兜底。
 *   2. 返回的就是「行」或「数据」，形状与调用方现在的期待完全一致。
 *   3. 可注入 client（setDbClient）以便单测用假 client 校验「调用形状」，
 *      契约测试见 tools/api-contract-test.mjs —— 换实现后跑它就知道有没有跑偏。
 */
import { getClient } from "../supabase.js";

/** 表名集中在此：换库时只改这里的映射 */
const T = {
  posts: "wall_posts",
  comments: "wall_comments",
  reactions: "wall_reactions",
  profiles: "profiles",
  petProfiles: "pet_profiles",
};
/** 图片桶（帖子配图与宠物图共用；路径前缀 <uid>/ 由 storage 策略授权） */
export const IMAGE_BUCKET = "wall-images";

let injected = null;
/** 单测注入假 client；生产代码不要调用 */
export function setDbClient(client) { injected = client; }

function sb() {
  const c = injected || getClient();
  if (!c) throw new Error("cloud-not-ready");
  return c;
}
/** 统一拆包：有 error 就抛（让上层 catch 降级），否则给 data */
function unwrap(res) {
  if (res && res.error) throw res.error;
  return res ? res.data : null;
}

export const db = {
  /* ══════════ 能力探测（不发请求、不抛错） ══════════ */

  /** 云端网关是否就绪：配置齐了（或测试注入了假 client）即真。调用方用它决定能否发起数据访问 */
  ready() {
    return !!(injected || getClient());
  },

  /* ══════════ 帖子 ══════════ */

  /**
   * 最近 limit 条（新→旧）。
   * 先带 removed 过滤（跑过迁移才有这一列）；列不存在时退回不过滤的查询。
   */
  async listPosts(limit) {
    const c = sb();
    const base = () => c.from(T.posts).select("*");
    let res = await base().eq("removed", false).order("created_at", { ascending: false }).limit(limit);
    if (res.error) res = await base().order("created_at", { ascending: false }).limit(limit);
    return unwrap(res);
  },

  /** 某用户的帖子（新→旧；removed 兼容同上） */
  async listPostsByUser(userId, limit) {
    const c = sb();
    const base = () => c.from(T.posts).select("*").eq("user_id", userId);
    let res = await base().eq("removed", false).order("created_at", { ascending: false }).limit(limit);
    if (res.error) res = await base().order("created_at", { ascending: false }).limit(limit);
    return unwrap(res);
  },

  /** 发帖：返回插入后的整行 */
  async insertPost(row) {
    return unwrap(await sb().from(T.posts).insert(row).select("*").single());
  },

  /** 公开档案（昵称 / 加入时间）；行不存在返回 null */
  async getProfile(userId) {
    return unwrap(
      await sb().from(T.profiles).select("nickname,created_at").eq("id", userId).maybeSingle(),
    );
  },

  /* ══════════ 评论 ══════════ */

  /** 某帖的评论（旧→新） */
  async listComments(postId, limit) {
    return unwrap(
      await sb().from(T.comments).select("*").eq("post_id", postId)
        .order("created_at", { ascending: true }).limit(limit),
    );
  },

  /** 发表评论 / 回复：返回插入后的整行 */
  async insertComment(row) {
    return unwrap(await sb().from(T.comments).insert(row).select("*").single());
  },

  /** 只取 post_id，用于聚合「每帖几条」（含回复） */
  async listCommentPostIds(postIds, limit) {
    return unwrap(
      await sb().from(T.comments).select("post_id").in("post_id", postIds).limit(limit),
    );
  },

  /** 删除评论（RLS 兜底：只能删自己的） */
  async deleteComment(id) {
    unwrap(await sb().from(T.comments).delete().eq("id", id));
  },

  /* ═════════ 回应（抱抱 / 暖暖 / 同感 / 厌恶） ══════════ */

  /** 一次取多帖的回应（动态流用；只查当前窗口内的帖子） */
  async listReactionsByPosts(postIds) {
    return unwrap(
      await sb().from(T.reactions).select("post_id,user_id,kind").in("post_id", postIds),
    );
  },

  /** 取某帖全部回应（切换后重拉权威计数用） */
  async listReactionsByPost(postId) {
    return unwrap(
      await sb().from(T.reactions).select("post_id,user_id,kind").eq("post_id", postId),
    );
  },

  /** 我有没有点过这一种回应；无记录返回 null */
  async findReaction({ postId, userId, kind }) {
    return unwrap(
      await sb().from(T.reactions).select("post_id")
        .eq("post_id", postId).eq("user_id", userId).eq("kind", kind).maybeSingle(),
    );
  },

  async insertReaction(row) {
    unwrap(await sb().from(T.reactions).insert(row));
  },

  async deleteReaction({ postId, userId, kind }) {
    unwrap(
      await sb().from(T.reactions).delete()
        .eq("post_id", postId).eq("user_id", userId).eq("kind", kind),
    );
  },

  /* ══════════ RPC：服务端权威逻辑（去重 / 计数 / 自动下架） ══════════ */

  /** 记一次浏览（同访客同日只计一次，服务端去重） */
  async addView(postId, viewer) {
    return unwrap(await sb().rpc("wall_add_view", { p_post: postId, p_viewer: viewer }));
  },

  /** 切换厌恶（服务端计数，达 1% 时把帖子假删除） */
  async toggleDislike(postId) {
    return unwrap(await sb().rpc("wall_toggle_dislike", { p_post: postId }));
  },

  /** 访客互动（摸摸头 / 投喂；同访客同日同类型只计一次） */
  async petInteract(ownerId, kind, viewer) {
    return unwrap(
      await sb().rpc("pet_interact", { p_owner: ownerId, p_kind: kind, p_viewer: viewer }),
    );
  },

  /* ══════════ 宠物主页（展示镜像 + 计数独立列） ══════════ */

  /**
   * 取宠物主页行（行不存在返回 null）。
   * 先带 pats/feeds 计数列；老库还没补列时退回只读 data
   * —— 调用方拿到 counts=0，但主页区块照常出现（不整块消失）。
   */
  async getPetProfile(userId) {
    const c = sb();
    const res = await c.from(T.petProfiles).select("data,pats,feeds").eq("user_id", userId).maybeSingle();
    if (!res.error) return res.data || null;
    return unwrap(await c.from(T.petProfiles).select("data").eq("user_id", userId).maybeSingle());
  },

  /** 主人推送展示镜像：只写 data（pats/feeds 是访客计数，绝不能被这次覆盖动到） */
  async upsertPetProfile(userId, data, updatedAt) {
    unwrap(
      await sb().from(T.petProfiles).upsert({ user_id: userId, data, updated_at: updatedAt }),
    );
  },

  /* ══════════ 图片（Storage） ═════════ */

  /** 上传字节：路径约定 <uid>/... 由 storage 策略按第一段授权 */
  async uploadImage(path, bytes, { mime, upsert = false } = {}) {
    unwrap(
      await sb().storage.from(IMAGE_BUCKET).upload(path, bytes, { contentType: mime, upsert }),
    );
  },

  /** Storage 路径 → 公开 URL（纯字符串拼接，不发请求；不可用时给空串） */
  imageUrl(path) {
    try {
      const { data } = sb().storage.from(IMAGE_BUCKET).getPublicUrl(path);
      return (data && data.publicUrl) || "";
    } catch (e) {
      return "";
    }
  },
};
