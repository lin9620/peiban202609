/* 云端数据访问适配层 —— 直连 Supabase 实现（阶段 2 从 db.js 拆出）
 * ------------------------------------------------------------
 * 本文件是 api/db.js 选择器的「直连模式」实现：前端用 supabase-js 直接访问
 * PostgREST / Storage（默认模式，行为与阶段 1 完全一致）。
 * 网关模式实现见 db.gateway.js（同源 /api/*，由 worker/api.js 翻译到上游）。
 *
 * wall.js 里所有「真正碰云端」的调用都收口到这组实现：
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

/* ──────── 基础设施 ──────── */

let injected = null; // 单测注入口（tools/api-contract-test.mjs）
/** 单测注入假 client；生产代码不要调用 */
export function setDbClient(client) {
  injected = client || null;
}

function sb() {
  const c = injected || getClient();
  if (!c) throw new Error("cloud-not-ready");
  return c;
}

/** supabase-js 返回 { data, error }：有错一律上抛（降级策略在 wall.js / 上游，不在这里） */
async function unwrap(p) {
  const r = await p;
  if (r && r.error) throw r.error;
  return r ? r.data : null;
}

export const db = {
  /** 云端是否可用（不发请求、不抛错）：wall.js 的 canReadWall/canUseWall 用它做降级开关 */
  ready() {
    return !!(injected || getClient());
  },

  /* ══════════ 帖子 ══════════ */

  /** 最近 limit 条（新→旧）；removed 列不存在（老库）时退回不带该过滤的查询 */
  async listPosts(limit) {
    let res = await sb().from(T.posts).select("*").eq("removed", false).order("created_at", { ascending: false }).limit(limit);
    if (res && res.error) {
      res = await sb().from(T.posts).select("*").order("created_at", { ascending: false }).limit(limit);
    }
    return unwrap(Promise.resolve(res));
  },

  /** 某用户的帖子（新→旧）；同样带 removed 兼容 */
  async listPostsByUser(userId, limit) {
    let res = await sb().from(T.posts).select("*").eq("user_id", userId).eq("removed", false).order("created_at", { ascending: false }).limit(limit);
    if (res && res.error) {
      res = await sb().from(T.posts).select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(limit);
    }
    return unwrap(Promise.resolve(res));
  },

  /** 发帖：返回插入后的整行 */
  insertPost(row) {
    return unwrap(sb().from(T.posts).insert(row).select("*").single());
  },

  /** 公开档案（昵称 / 加入时间 / 陪你大厅状态）；行不存在返回 null；老库无状态列时退回两列查询 */
  async getProfile(userId) {
    let res = await sb().from(T.profiles).select("nickname,created_at,status,status_at").eq("id", userId).maybeSingle();
    if (res && res.error) {
      res = await sb().from(T.profiles).select("nickname,created_at").eq("id", userId).maybeSingle();
    }
    return unwrap(Promise.resolve(res));
  },

  /** 我的陪你大厅状态上云：只写 status / status_at（RLS self update 兜底：只能写自己）；status=null 清除 */
  setStatus(userId, status) {
    return unwrap(sb().from(T.profiles).update({ status, status_at: new Date().toISOString() }).eq("id", userId));
  },

  /** 大厅里的近期状态：status 非空且 status_at ≥ since，新→旧 */
  listRecentStatuses(limit, since) {
    return unwrap(
      sb().from(T.profiles).select("id,nickname,status,status_at")
        .not("status", "is", null).gte("status_at", since)
        .order("status_at", { ascending: false }).limit(limit),
    );
  },

  /** 大厅只取四类精确人数，不下载个人资料，也不受分页上限影响。 */
  async countRecentStatuses(since) {
    return Promise.all(["working", "studying", "sleepless", "chilling"].map(async (status) => {
      const r = await sb().from(T.profiles).select("id", { count: "exact", head: true })
        .eq("status", status).gte("status_at", since);
      if (r.error) throw r.error;
      if (!Number.isSafeInteger(r.count) || r.count < 0) throw new Error("invalid-status-count");
      return { status, count: r.count };
    }));
  },

  /* ══════════ 评论 ══════════ */

  /** 某帖的评论（旧→新） */
  listComments(postId, limit) {
    return unwrap(sb().from(T.comments).select("*").eq("post_id", postId).order("created_at", { ascending: true }).limit(limit));
  },

  /** 发表评论 / 回复：返回插入后的整行 */
  insertComment(row) {
    return unwrap(sb().from(T.comments).insert(row).select("*").single());
  },

  /** 只取 post_id，用于聚合「每帖几条」（含回复） */
  listCommentPostIds(postIds, limit) {
    return unwrap(sb().from(T.comments).select("post_id").in("post_id", postIds).limit(limit));
  },

  /** 删除评论（RLS 兜底：只能删自己的） */
  deleteComment(id) {
    return unwrap(sb().from(T.comments).delete().eq("id", id));
  },

  /* ══════════ 回应（抱抱 / 暖暖 / 同感 / 厌恶） ══════════ */

  /** 一次取多帖的回应（动态流用；只查当前窗口内的帖子） */
  listReactionsByPosts(postIds) {
    return unwrap(sb().from(T.reactions).select("post_id,user_id,kind").in("post_id", postIds));
  },

  /** 取某帖全部回应（切换后重拉权威计数用） */
  listReactionsByPost(postId) {
    return unwrap(sb().from(T.reactions).select("post_id,user_id,kind").eq("post_id", postId));
  },

  /** 我有没有点过这一种回应；无记录返回 null */
  findReaction({ postId, userId, kind }) {
    return unwrap(sb().from(T.reactions).select("post_id").eq("post_id", postId).eq("user_id", userId).eq("kind", kind).maybeSingle());
  },

  insertReaction(row) {
    return unwrap(sb().from(T.reactions).insert(row));
  },

  deleteReaction({ postId, userId, kind }) {
    return unwrap(sb().from(T.reactions).delete().eq("post_id", postId).eq("user_id", userId).eq("kind", kind));
  },

  /* ══════════ RPC：服务端权威逻辑（去重 / 计数 / 自动下架） ══════════ */

  /** 记一次浏览（同访客同日只计一次，服务端去重） */
  addView(postId, viewer) {
    return unwrap(sb().rpc("wall_add_view", { p_post: postId, p_viewer: viewer }));
  },

  /** 切换厌恶（服务端计数，达 1% 时把帖子假删除） */
  toggleDislike(postId) {
    return unwrap(sb().rpc("wall_toggle_dislike", { p_post: postId }));
  },

  /** 访客互动（摸摸头 / 投喂；同访客同日同类型只计一次） */
  petInteract(ownerId, kind, viewer) {
    return unwrap(sb().rpc("pet_interact", { p_owner: ownerId, p_kind: kind, p_viewer: viewer }));
  },

  /* ══════════ 温暖漂流瓶（#6：写/捞/回/放回/我的信/我捞到的） ══════════ */

  /** 投一封信进海里（每日 3 封由 RPC 里数 created_day 把关） */
  bottleSend(body) {
    return unwrap(sb().rpc("bottle_send", { p_body: body }));
  },

  /** 随机捞一封（不是自己的；捞起即独占，48h 不处理自动回海） */
  bottleFish() {
    return unwrap(sb().rpc("bottle_fish"));
  },

  /** 给手里这封写回信（只有当前持有者能回） */
  bottleReply(id, reply) {
    return unwrap(sb().rpc("bottle_reply", { p_id: id, p_reply: reply }));
  },

  /** 不想回，放回海里 */
  bottleRelease(id) {
    return unwrap(sb().rpc("bottle_release", { p_id: id }));
  },

  bottleRecords(id = null, offset = 0) {
    return unwrap(sb().rpc("bottle_records", { p_id: id, p_offset: offset }));
  },
  bottleChatDecide(id, accept) {
    return unwrap(sb().rpc("bottle_chat_decide", { p_id: id, p_accept: accept }));
  },

  /** 我投的信（含收到的回信），新→旧 */
  bottleMine() {
    return unwrap(sb().rpc("bottle_mine"));
  },

  /** 我捞到、还没回的信（换页/刷新后找回来） */
  bottleHeld() {
    return unwrap(sb().rpc("bottle_held"));
  },

  /* ══════════ 宠物主页（展示镜像 + 计数独立列） ══════════ */

  /** 取宠物主页行（行不存在返回 null）；pats/feeds 列缺失（老库）时退回只读 data */
  async getPetProfile(userId) {
    let res = await sb().from(T.petProfiles).select("data,pats,feeds").eq("user_id", userId).maybeSingle();
    if (res && res.error) {
      res = await sb().from(T.petProfiles).select("data").eq("user_id", userId).maybeSingle();
    }
    return unwrap(Promise.resolve(res));
  },

  /** 主人推送展示镜像：只写 user_id/data/updated_at —— 绝不覆盖 pats/feeds 计数列（红线） */
  upsertPetProfile(userId, data, updatedAt) {
    return unwrap(sb().from(T.petProfiles).upsert({ user_id: userId, data, updated_at: updatedAt }));
  },

  /* ══════════ 管理员（RLS is_admin 兜底；页面只是壳） ══════════ */

  /** 我是不是管理员（rpc is_admin，标量布尔） */
  amAdmin() {
    return unwrap(sb().rpc("is_admin"));
  },

  /** 看板总览（rpc admin_overview 的 jsonb；非管理员得到 {admin:false}） */
  adminOverview() {
    return unwrap(sb().rpc("admin_overview"));
  },

  /** 治理列表：用户分页（昵称/邮箱/ID/注册时间；邮箱只在 DB 侧 join auth.users 提供） */
  adminUsersPage(offset, limit) {
    return unwrap(sb().rpc("admin_users_page", { p_offset: offset, p_limit: limit }));
  },

  /** 治理列表：最新帖子（含已下架；可见性由 RLS 管理员策略放行） */
  adminListPosts(limit) {
    return unwrap(
      sb().from(T.posts)
        .select("id,user_id,author_name,body,image_path,views,dislikes,removed,created_at")
        .order("created_at", { ascending: false })
        .limit(limit),
    );
  },

  /** 下架 / 恢复帖子（更新 removed；RLS 管理员 update 策略兜底） */
  adminSetPostRemoved(id, removed) {
    return unwrap(sb().from(T.posts).update({ removed }).eq("id", id));
  },

  /** 删除帖子（FK 级联清评论/回应；RLS 管理员 delete 策略兜底） */
  adminDeletePost(id) {
    return unwrap(sb().from(T.posts).delete().eq("id", id));
  },

  /** 治理列表：最新评论（含二级回复） */
  adminListComments(limit) {
    return unwrap(
      sb().from(T.comments)
        .select("id,post_id,parent_id,user_id,author_name,body,created_at")
        .order("created_at", { ascending: false })
        .limit(limit),
    );
  },

  /** 删除评论（二级回复靠 parent_id FK 级联；RLS 管理员 delete 策略兜底） */
  adminDeleteComment(id) {
    return unwrap(sb().from(T.comments).delete().eq("id", id));
  },
  /* ══════════ 私信（阶段 4：写路径全部走 RPC，表直写被 RLS 拒绝） ══════════ */

  /** 找或建与某用户的会话 → {conv_id} */
  dmOpen(otherId) {
    return unwrap(sb().rpc("dm_open", { p_other: otherId }));
  },

  /** 会话列表（对方昵称/未读/预览/我方状态一次聚合） */
  dmListConvs(limit, offset) {
    return unwrap(sb().rpc("dm_list_convs", { p_limit: limit, p_offset: offset }));
  },

  /** 消息分页（游标 before = 上一页最小 id；返回新→旧，客户端反转） */
  dmListMessages(convId, before, limit) {
    return unwrap(sb().rpc("dm_list_messages", { p_conv: convId, p_before: before ?? null, p_limit: limit }));
  },

  /** 单会话元信息（深链直达用） */
  dmConvMeta(convId) {
    return unwrap(sb().rpc("dm_conv_meta", { p_conv: convId }));
  },

  /** 发消息：正文与图片至少其一（图片为 Storage 路径） */
  dmSend(convId, body, image) {
    return unwrap(sb().rpc("dm_send", { p_conv: convId, p_body: body, p_image: image ?? null }));
  },

  /** 已读：抬到本会话最新一条 */
  dmMarkRead(convId) {
    return unwrap(sb().rpc("dm_mark_read", { p_conv: convId }));
  },

  /** 隐藏 / 取消隐藏 / 免打扰 / 接受消息请求 */
  dmHide(convId) {
    return unwrap(sb().rpc("dm_hide", { p_conv: convId }));
  },

  dmUnhide(convId) {
    return unwrap(sb().rpc("dm_unhide", { p_conv: convId }));
  },

  dmMute(convId, on) {
    return unwrap(sb().rpc("dm_mute", { p_conv: convId, p_on: !!on }));
  },

  dmAccept(convId) {
    return unwrap(sb().rpc("dm_accept", { p_conv: convId }));
  },

  /** 撤回（15 分钟内、作者本人） */
  dmRecall(msgId) {
    return unwrap(sb().rpc("dm_recall", { p_msg: msgId }));
  },

  /** 拉黑 / 解除拉黑 / 名单 */
  dmBlock(userId) {
    return unwrap(sb().rpc("dm_block", { p_user: userId }));
  },

  dmUnblock(userId) {
    return unwrap(sb().rpc("dm_unblock", { p_user: userId }));
  },

  dmBlocks() {
    return unwrap(sb().rpc("dm_blocks"));
  },

  /** 未读总览 {total, requests}（导航角标轮询用） */
  dmUnreadTotal() {
    return unwrap(sb().rpc("dm_unread_total"));
  },

  /* ══════════ 通知中心（阶段 4） ══════════ */

  /** 分页：既支持对象参数 {offset,limit,kinds,unread}，也支持位置参数；kinds 可传数组（拼接为逗号串） */
  notifPage(q, limitB, kindsB, unreadB) {
    const o = q && typeof q === "object" && !Array.isArray(q) ? q : { offset: q, limit: limitB, kinds: kindsB, unread: unreadB };
    const kinds = Array.isArray(o.kinds) ? o.kinds.filter(Boolean).join(",") : (o.kinds || null);
    return unwrap(sb().rpc("notif_page", {
      p_offset: o.offset ?? 0, p_limit: o.limit ?? 30, p_kinds: kinds ?? null, p_unread: !!o.unread,
    }));
  },

  /** 各分类未读数 {total, comments, reactions, pets, dms, system} */
  notifUnread() {
    return unwrap(sb().rpc("notif_unread"));
  },

  /** 标记已读：all=true 全部；否则按 id 列表 */
  notifMark(ids, all) {
    return unwrap(sb().rpc("notif_mark", { p_ids: all ? null : ids, p_all: !!all }));
  },

  /** 通知偏好（缺行 = 全开） */
  notifPrefsGet() {
    return unwrap(sb().rpc("notif_prefs_get"));
  },

  /** 保存偏好（对象参数；布尔强制） */
  notifPrefsSet(prefs) {
    return unwrap(sb().rpc("notif_prefs_set", {
      p_comments: prefs.comments !== false,
      p_reactions: prefs.reactions !== false,
      p_pets: prefs.pets !== false,
      p_dms: prefs.dms !== false,
    }));
  },

  /** 管理员公告 → 全员 system 通知（非管理员得到 {admin:false}） */
  adminBroadcast(body) {
    return unwrap(sb().rpc("admin_broadcast", { p_body: body }));
  },

  /** 清空我的全部通知（返回 {ok, removed}） */
  notifClear() {
    return unwrap(sb().rpc("notif_clear"));
  },

  /* ══════════ 图片（Storage） ══════════ */

  /** 上传字节：路径约定 <uid>/... 由 storage 策略按第一段授权 */
  async uploadImage(path, bytes, { mime, upsert = false } = {}) {
    const { error } = await sb().storage.from(IMAGE_BUCKET).upload(path, bytes, { contentType: mime, upsert });
    if (error) throw error;
  },

  /** Storage 路径 → 公开 URL；不可用时给空串（同步、不发请求、不抛错） */
  imageUrl(path) {
    const c = injected || getClient();
    if (!c || !path) return "";
    try {
      const { data } = c.storage.from(IMAGE_BUCKET).getPublicUrl(path);
      return (data && data.publicUrl) || "";
    } catch (e) {
      return "";
    }
  },
};
