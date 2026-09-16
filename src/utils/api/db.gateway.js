/* 云端数据访问适配层 —— API 网关实现（阶段 2）
 * ------------------------------------------------------------
 * 与 db.supabase.js 完全同一契约（方法 / 参数 / 返回 / 错误上抛），区别只在传输：
 * 所有请求打同源 /api/*，由 worker/api.js 翻译到 Supabase REST / Storage。
 * 构建时 VITE_API_GATEWAY=1 → api/db.js 选择器启用本实现。
 *
 * 约定（与直连实现一致）：
 *   1. 只做「一次数据访问」，不判断业务、不自行降级 —— 出错一律 throw，上层 try/catch 兜底；
 *   2. 行不存在 → null（由 Worker 把 PostgREST 的 PGRST116 翻成 200 null）；
 *   3. 鉴权：每次请求带 Authorization: Bearer <当前用户 JWT>（api/authToken.js），
 *      未登录则不带 → Worker 以 anon key 调上游 → 能读到什么由 RLS 决定。
 *
 * 契约测试：tools/gateway-contract-test.mjs（前端侧形状）——
 * 换后端实现时先跑它 + tools/worker-test.mjs（Worker 侧形状），两端都对上才算没跑偏。
 */
import { getClient } from "../supabase.js";
import { getAuthToken } from "./authToken.js";

const BASE = "/api";

let probe = null;
/** 单测注入「auth 就绪」探针；生产代码不要调用（与 db.supabase 的 setDbClient 对称） */
export function setGatewayAuthProbe(fn) {
  probe = typeof fn === "function" ? fn : null;
}
function authReady() {
  return !!(probe ? probe() : getClient());
}

/** 鉴权 + 内容类型头；token 有就带，绝不抛错 */
function authHeaders(extra = {}) {
  const h = { ...extra };
  const t = getAuthToken();
  if (t) h.authorization = `Bearer ${t}`;
  return h;
}

/** 一次网关调用：非 2xx → throw（消息取错误体的 message/error），2xx 空 body → null */
async function call(path, { method = "GET", body, headers } = {}) {
  if (!authReady()) throw new Error("cloud-not-ready");
  let res;
  try {
    const isBytes = body instanceof ArrayBuffer || body instanceof Uint8Array;
    res = await fetch(BASE + path, {
      method,
      headers: authHeaders({
        ...(body !== undefined && !isBytes ? { "content-type": "application/json" } : {}),
        ...(headers || {}),
      }),
      body: body === undefined ? undefined : isBytes ? body : JSON.stringify(body),
    });
  } catch (e) {
    throw new Error("gateway-unreachable");
  }
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch (e) { data = null; }
  }
  if (!res.ok) {
    const msg = (data && (data.message || data.error)) || `HTTP ${res.status}`;
    throw new Error(String(msg));
  }
  return data;
}

const enc = encodeURIComponent;
/** in-list 查询参数：与 supabase-js 相同的 in.("a","b") 语义 */
const idsParam = (ids) => enc(`in.(${ids.map((x) => `"${x}"`).join(",")})`);

export const db = {
  /* ══════════ 能力探测（不发请求、不抛错） ══════════ */

  /** 网关是否就绪：Auth 客户端就绪即可（网关同源部署；写操作还需要登录，由 wall.js 把关） */
  ready() {
    return authReady();
  },

  /* ══════════ 帖子 ══════════ */

  /** 最近 limit 条（新→旧）；removed 兼容由 Worker 内部处理 */
  async listPosts(limit) {
    return call(`/posts?limit=${enc(limit)}`);
  },

  /** 某用户的帖子（新→旧） */
  async listPostsByUser(userId, limit) {
    return call(`/users/${enc(userId)}/posts?limit=${enc(limit)}`);
  },

  /** 发帖：返回插入后的整行 */
  async insertPost(row) {
    return call("/posts", { method: "POST", body: row });
  },

  /** 公开档案（昵称 / 加入时间）；行不存在返回 null */
  async getProfile(userId) {
    return call(`/users/${enc(userId)}/profile`);
  },

  /* ══════════ 评论 ══════════ */

  /** 某帖的评论（旧→新） */
  async listComments(postId, limit) {
    return call(`/posts/${enc(postId)}/comments?limit=${enc(limit)}`);
  },

  /** 发表评论 / 回复：返回插入后的整行 */
  async insertComment(row) {
    return call("/comments", { method: "POST", body: row });
  },

  /** 只取 post_id，用于聚合「每帖几条」（含回复） */
  async listCommentPostIds(postIds, limit) {
    return call(`/comment-post-ids?ids=${enc(postIds.join(","))}&limit=${enc(limit)}`);
  },

  /** 删除评论（RLS 兜底：只能删自己的） */
  async deleteComment(id) {
    await call(`/comments/${enc(id)}`, { method: "DELETE" });
  },

  /* ═════════ 回应（抱抱 / 暖暖 / 同感 / 厌恶） ══════════ */

  /** 一次取多帖的回应（动态流用；只查当前窗口内的帖子） */
  async listReactionsByPosts(postIds) {
    return call(`/reactions?ids=${enc(postIds.join(","))}`);
  },

  /** 取某帖全部回应（切换后重拉权威计数用） */
  async listReactionsByPost(postId) {
    return call(`/posts/${enc(postId)}/reactions`);
  },

  /** 我有没有点过这一种回应；无记录返回 null */
  async findReaction({ postId, userId, kind }) {
    return call(`/reactions/mine?post_id=${enc(postId)}&user_id=${enc(userId)}&kind=${enc(kind)}`);
  },

  async insertReaction(row) {
    await call("/reactions", { method: "POST", body: row });
  },

  async deleteReaction({ postId, userId, kind }) {
    await call(`/reactions?post_id=${enc(postId)}&user_id=${enc(userId)}&kind=${enc(kind)}`, {
      method: "DELETE",
    });
  },

  /* ══════════ RPC：服务端权威逻辑（去重 / 计数 / 自动下架） ══════════ */

  /** 记一次浏览（同访客同日只计一次，服务端去重） */
  async addView(postId, viewer) {
    return call(`/posts/${enc(postId)}/view`, { method: "POST", body: { viewer } });
  },

  /** 切换厌恶（服务端计数，达 1% 时把帖子假删除） */
  async toggleDislike(postId) {
    return call(`/posts/${enc(postId)}/dislike`, { method: "POST" });
  },

  /** 访客互动（摸摸头 / 投喂；同访客同日同类型只计一次） */
  async petInteract(ownerId, kind, viewer) {
    return call(`/pet/${enc(ownerId)}/interact`, { method: "POST", body: { kind, viewer } });
  },

  /* ══════════ 宠物主页（展示镜像 + 计数独立列） ══════════ */

  /** 取宠物主页行（行不存在返回 null）；pats/feeds 列缺失的兼容由 Worker 内部处理 */
  async getPetProfile(userId) {
    return call(`/pet/${enc(userId)}`);
  },

  /** 主人推送展示镜像：只写 data（pats/feeds 是访客计数，绝不能被这次覆盖动到） */
  async upsertPetProfile(userId, data, updatedAt) {
    await call(`/pet/${enc(userId)}`, {
      method: "PUT",
      body: { user_id: userId, data, updated_at: updatedAt },
    });
  },

  /* ══════════ 管理员（RLS is_admin 兜底；Worker 只翻译） ══════════ */

  /** 我是不是管理员（标量布尔；非管理员得到 false） */
  amAdmin() {
    return call("/admin/me");
  },

  /** 看板总览（非管理员得到 {admin:false}，不泄露任何数字） */
  adminOverview() {
    return call("/admin/overview");
  },

  /** 治理列表：最新帖子（含已下架；可见性由 RLS 管理员策略放行） */
  async adminListPosts(limit) {
    return call(`/admin/posts?limit=${enc(limit)}`);
  },

  /** 下架 / 恢复帖子 */
  adminSetPostRemoved(id, removed) {
    return call(`/admin/posts/${enc(id)}`, { method: "PATCH", body: { removed } });
  },

  /** 删除帖子（子行由 FK 级联清掉） */
  async adminDeletePost(id) {
    await call(`/admin/posts/${enc(id)}`, { method: "DELETE" });
  },

  /** 治理列表：最新评论（含二级回复） */
  async adminListComments(limit) {
    return call(`/admin/comments?limit=${enc(limit)}`);
  },

  /** 删除评论（二级回复由 parent_id FK 级联） */
  async adminDeleteComment(id) {
    await call(`/admin/comments/${enc(id)}`, { method: "DELETE" });
  },

  /* ══════════ 图片（Storage） ═════════ */

  /** 上传字节：路径约定 <uid>/... 由 storage 策略按第一段授权 */
  async uploadImage(path, bytes, { mime, upsert = false } = {}) {
    await call(`/uploads?path=${enc(path)}${upsert ? "&upsert=1" : ""}`, {
      method: "POST",
      body: bytes,
      headers: { "content-type": mime || "application/octet-stream" },
    });
  },

  /** Storage 路径 → 公开 URL（同源 /api/img/* → Worker 302 到 Storage 公开地址；
   *  文件名是内容哈希 → 浏览器可永久缓存；不发请求、不可用时给空串） */
  imageUrl(path) {
    if (!path || typeof path !== "string" || path.includes("..")) return "";
    return `${BASE}/img/${path.split("/").map(enc).join("/")}`;
  },
};