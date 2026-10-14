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
import { getClient, refreshAccessToken } from "../supabase.js";
import { getAuthToken } from "./authToken.js";

/* 轮 160：单测可注入的「刷新会话」替身；生产走 supabase.js 的 refreshAccessToken */
let refresher = null;
export function setGatewayTokenRefresher(fn) {
  refresher = typeof fn === "function" ? fn : null;
}
async function refreshTokenOnce() {
  if (refresher) return refresher();
  return refreshAccessToken();
}

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

/** 一次网关调用：非 2xx → throw（消息取错误体的 message/error），2xx 空 body → null。
 * 轮 160：带身份的请求吃 401 时——本地会话大概率是「后台刷新失败后一直揣着过期 JWT」
 * （顶栏已显示登录、接口却 401 的假登录态）——强制刷新一次会话（单飞）再重试本请求；
 * 只重试一次（刷新失败 / 仍 401 都按原错误上抛），绝不循环。 */
async function call(path, { method = "GET", body, headers } = {}) {
  if (!authReady()) throw new Error("cloud-not-ready");
  const hadAuth = !!getAuthToken();
  const attempt = async () => {
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
      const err = new Error(String(msg));
      err.status = res.status;
      throw err;
    }
    return data;
  };
  try {
    return await attempt();
  } catch (e) {
    if (e && e.status === 401 && hadAuth) {
      const t = await refreshTokenOnce();
      if (t) return await attempt();   /* authHeaders 每次现取 token → 重试必带新 JWT */
    }
    throw e;
  }
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

  /** 最近 limit 条（新→旧）；removed 兼容由 Worker 内部处理。
   *  轮 56：offset 分页（0/缺省不附参数，契约不变）。轮 62：beforeId 游标——万帖级深翻页成本恒定，优先用它。 */
  /** 轮 169：暖心墙刷新合并包（最新+随机+回应明细+评论数一次回） */
  async wallRefresh(limit) {
    return call(`/wall/refresh?limit=${enc(limit)}`);
  },

  async listPosts(limit, opts = {}) {
    const off = Number(opts.offset) > 0 ? Number(opts.offset) : 0;
    const bid = Number(opts.beforeId) > 0 ? Number(opts.beforeId) : 0;
    return call(`/posts?limit=${enc(limit)}${off ? `&offset=${enc(off)}` : ""}${bid ? `&before_id=${enc(bid)}` : ""}`);
  },

  /** 轮 64：随机换一批（7 天池；Worker 数总量→随机起点，深池也不怕） */
  async listPostsSample(limit, since) {
    return call(`/posts?sample=1&limit=${enc(limit)}${since ? `&since=${enc(since)}` : ""}`);
  },

  /** 某用户的帖子（新→旧）；offset = 分页偏移（0/缺省 = 旧行为） */
  async listPostsByUser(userId, limit, offset = 0) {
    const off = Number(offset) > 0 ? `&offset=${enc(Number(offset))}` : "";
    return call(`/users/${enc(userId)}/posts?limit=${enc(limit)}${off}`);
  },

  /** 单帖（轮 19 帖子详情页）：Worker GET /posts/:id（行不存在返回 null） */
  async getPost(postId) {
    return call(`/posts/${enc(postId)}`);
  },

  /** 发帖：返回插入后的整行 */
  async insertPost(row) {
    return call("/posts", { method: "POST", body: row });
  },

  /* ══════════ 轮 252 ══════════ */

  /** wall_posts 有哪些列（发帖时决定带不带 tags/img_w/img_h；失败一律给空数组=保守走旧载荷）。 */
  probeColumns() {
    return call("/posts/columns").catch(() => []);
  },

  /** 搜索（关键词 + 标签 + before 游标；返回与合并包同形 { posts, react, comment }）。 */
  searchPosts(qs) {
    return call(`/posts/search?${String(qs || "")}`);
  },

  /** 公开档案（昵称 / 加入时间 / 陪你大厅状态）；行不存在返回 null（老库兼容由 Worker 内部处理） */
  async getProfile(userId) {
    return call(`/users/${enc(userId)}/profile`);
  },

  /** 我的陪你大厅状态上云（时间戳由 Worker 盖，body 只带 status）；status=null 清除 */
  async setStatus(userId, status) {
    return call(`/users/${enc(userId)}/status`, { method: "PATCH", body: { status } });
  },

  /** 大厅里的近期状态（24h 窗口的 since 由调用方算好） */
  async listRecentStatuses(limit, since) {
    return call(`/statuses?limit=${enc(limit)}&since=${enc(since)}`);
  },

  async countRecentStatuses(since) {
    return call(`/statuses/counts?since=${enc(since)}`);
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

  /* ══════════ 轮 84 · 评论回应（👍心 / 💔碎心） ══════════ */

  /** 一次取多评论的回应明细（谁点了什么） */
  async listCommentReactions(commentIds) {
    return call(`/comments/reactions?ids=${enc(commentIds.join(","))}`);
  },

  /** 我在这批评论里点过的回应（只回 comment_id,kind） */
  async listMyCommentReactions(commentIds, userId) {
    return call(`/comments/reactions/mine?ids=${enc(commentIds.join(","))}&user_id=${enc(userId)}`);
  },

  /** 切换评论回应；返回服务端权威计数 {ok,on,hearts,brokens}，前端拿返回值覆盖乐观值 */
  async toggleCommentReaction(commentId, kind) {
    return call("/comments/react", { method: "POST", body: { comment_id: commentId, kind } });
  },

  /* ══════════ RPC：服务端权威逻辑（去重 / 计数 / 自动下架） ══════════ */

  /** 记一次浏览（同访客同日只计一次，服务端去重） */
  async addView(postId, viewer) {
    return call(`/posts/${enc(postId)}/view`, { method: "POST", body: { viewer } });
  },

  /** 切换厌恶（服务端计数，达 #26 双档阈值时把帖子假删除：浏览<100 超 3 个 / ≥100 超 0.5%） */
  async toggleDislike(postId) {
    return call(`/posts/${enc(postId)}/dislike`, { method: "POST" });
  },

  /** 访客互动（摸摸头 / 投喂；同访客同日同类型只计一次） */
  async petInteract(ownerId, kind, viewer) {
    return call(`/pet/${enc(ownerId)}/interact`, { method: "POST", body: { kind, viewer } });
  },

  /* ══════════ 温暖漂流瓶（#6：Worker 收口 /api/bottle/*，同名 RPC 在 DB 里） ══════════ */

  /** 投一封信进海里（每日 3 封由服务端把关） */
  bottleSend(body) {
    return call("/bottle/send", { method: "POST", body: { body } });
  },

  /** 随机捞一封（不是自己的；捞起即独占） */
  bottleFish() {
    return call("/bottle/fish", { method: "POST", body: {} });
  },

  /** 给手里这封写回信（只有当前持有者能回） */
  bottleReply(id, reply) {
    return call("/bottle/reply", { method: "POST", body: { id, reply } });
  },

  /** 不想回，放回海里 */
  bottleRelease(id) {
    return call("/bottle/release", { method: "POST", body: { id } });
  },

  bottleRecords(id = null, offset = 0, { mine = null, limit = 0 } = {}) {
    const qs = [`offset=${enc(offset)}`];
    if (id) qs.push(`id=${enc(id)}`);
    if (mine === true || mine === false) qs.push(`mine=${mine}`);
    if (limit > 0) qs.push(`limit=${enc(limit)}`);
    return call(`/bottle/records?${qs.join("&")}`);
  },
  bottleChatDecide(id, accept) {
    return call("/bottle/chat", { method: "POST", body: { id, accept } });
  },

  /** 我投的信（含收到的回信），新→旧 */
  bottleMine() {
    return call("/bottle/mine");
  },

  /** 我捞到、还没回的信 */
  bottleHeld() {
    return call("/bottle/held");
  },

  /** 今日已用次数（服务端权威，UTC 日）：{ sent, fished }（轮 18：跨端不再打架） */
  bottleQuota() {
    return call("/bottle/quota");
  },

  /* ══════════ 故事栏（轮 145：Worker 收口 /api/story/*，同名 RPC 在 DB 里） ══════════ */

  /** 存草稿（宽容：标题可空） */
  storySaveDraft(id, title, body, tags) {
    return call("/story/draft", { method: "POST", body: { id, title, body, tags: tags || [] } });
  },

  /** 发布（服务端校验 标题/正文≤3万/标签1~3） */
  storyPublish(id, title, body, tags) {
    return call("/story/publish", { method: "POST", body: { id, title, body, tags: tags || [] } });
  },

  /** 赞 / 取消赞：true=已赞 false=已取消 */
  storyToggleLike(id) {
    return call("/story/like", { method: "POST", body: { id } });
  },

  /** 记一次浏览（同人同篇同日只计一次） */
  storyAddView(id) {
    return call("/story/view", { method: "POST", body: { id } });
  },

  /** 四榜一条出：mode = random | latest | monthly | tag */
  storyRank(mode, tag, period, limit, offset) {
    const qs = [`mode=${enc(mode)}`, `limit=${enc(limit)}`, `offset=${enc(offset)}`];
    if (tag) qs.push(`tag=${enc(tag)}`);
    if (period) qs.push(`period=${enc(period)}`);
    return call(`/story/rank?${qs.join("&")}`);
  },

  /** 单篇详情（未发布且非本人 → Worker 翻成 200 null） */
  storyGet(id) {
    return call(`/story/${enc(id)}`);
  },

  /** 我的投稿（status 省略 = 草稿 + 已发布） */
  storyMine(status, limit = 30, offset = 0) {
    const qs = [`limit=${enc(limit)}`, `offset=${enc(offset)}`];
    if (status) qs.push(`status=${enc(status)}`);
    return call(`/story/mine?${qs.join("&")}`);
  },

  /* ══════════ 故事栏批 2（轮 145：评论 / 书架 / 每日精选 / 数据面板） ══════════ */

  /** 评论列表 */
  storyCommentList(storyId, limit = 50) {
    return call(`/story/${enc(storyId)}/comments?limit=${enc(limit)}`);
  },

  /** 发评论（≤1000 字，服务端校验） */
  storyAddComment(storyId, body) {
    return call(`/story/${enc(storyId)}/comments`, { method: "POST", body: { body } });
  },

  /** 删评论 */
  storyDeleteComment(id) {
    return call(`/story/comments/${enc(id)}`, { method: "DELETE" });
  },

  /** 收藏/取消：true=已收藏 */
  storyToggleBookmark(id) {
    return call("/story/bookmark", { method: "POST", body: { id } });
  },

  /** 我的书架 */
  storyBookmarkList(limit = 30, offset = 0) {
    return call(`/story/bookmarks?limit=${enc(limit)}&offset=${enc(offset)}`);
  },

  /** 每日精选（无则 200 null） */
  storyFeatured() {
    return call("/story/featured");
  },

  /** 我的数据面板 */
  storyMyStats() {
    return call("/story/stats");
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

  /** 治理列表：用户分页（昵称/邮箱/ID/注册时间；邮箱由 DB 侧 RPC 提供） */
  adminUsersPage(offset, limit) {
    return call(`/admin/users?offset=${enc(offset)}&limit=${enc(limit)}`);
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

  /* ══════════ 举报 / 复核（轮 33；Worker 白名单 /api/reports、/api/admin/reports*） ══════════ */

  /** 提交举报（target_type: post|comment；防刷/去重/评论阈值在 RPC 里） */
  reportCreate(targetType, targetId, reason, detail) {
    return call("/reports", { method: "POST", body: { target_type: targetType, target_id: targetId, reason, detail } });
  },

  /** 举报/复核队列（status: pending|handled；items 带正文与聚合人数） */
  adminReportPage(status, offset, limit) {
    return call(`/admin/reports?status=${enc(status)}&offset=${enc(offset)}&limit=${enc(limit)}`);
  },

  /** 处理一条举报/复核（action: dismiss|remove_post|restore_post|delete_comment|unhide_comment） */
  adminReportHandle(reportId, action, note) {
    return call(`/admin/reports/${enc(reportId)}/handle`, { method: "POST", body: { action, note } });
  },

  /* ══════════ 客户端错误日志（轮 270；只读，写入是匿名信标经 Worker） ══════════ */

  /** 错误日志页：{admin, total, items(最新 N 条), top(按 msg+route 聚合 Top 20)}。
   *  非管理员得到 {admin:false}，不泄露任何内容 —— 判定在 RPC 里的 admin_users。 */
  adminClientLogsPage(offset, limit) {
    return call(`/admin/client-logs?offset=${enc(offset)}&limit=${enc(limit)}`);
  },

  /* ══════════ 私信（阶段 4） ══════════ */

  /** 找或建会话 → {conv_id} */
  async dmOpen(other) {
    return call("/dm", { method: "POST", body: { other } });
  },
  /** 会话列表（一次聚合） */
  async dmListConvs(limit, offset) {
    return call(`/dm/convs?limit=${enc(limit)}&offset=${enc(offset)}`);
  },
  /** 消息分页（游标） */
  async dmListMessages(convId, before, limit) {
    const b = before == null ? "" : `&before=${enc(before)}`;
    return call(`/dm/${enc(convId)}/messages?limit=${enc(limit)}${b}`);
  },
  /** 单会话元信息 */
  async dmConvMeta(convId) {
    return call(`/dm/${enc(convId)}/meta`);
  },
  /** 发消息 */
  async dmSend(convId, body, image) {
    return call(`/dm/${enc(convId)}/messages`, { method: "POST", body: { body, image: image ?? null } });
  },
  /** 已读水位 */
  async dmMarkRead(convId) {
    return call(`/dm/${enc(convId)}/read`, { method: "POST", body: {} });
  },
  /** 隐藏 / 取消隐藏 / 接受 / 免打扰 */
  async dmHide(convId) {
    return call(`/dm/${enc(convId)}/hide`, { method: "POST", body: {} });
  },
  async dmUnhide(convId) {
    return call(`/dm/${enc(convId)}/unhide`, { method: "POST", body: {} });
  },
  async dmAccept(convId) {
    return call(`/dm/${enc(convId)}/accept`, { method: "POST", body: {} });
  },
  async dmMute(convId, on) {
    return call(`/dm/${enc(convId)}/mute`, { method: "POST", body: { on } });
  },
  /** 撤回 */
  async dmRecall(msgId) {
    return call(`/dm/messages/${enc(msgId)}/recall`, { method: "POST", body: {} });
  },
  /** 拉黑名单 / 拉黑 / 解除 */
  async dmBlocks() {
    return call("/dm/blocks");
  },
  async dmBlock(userId) {
    return call("/dm/blocks", { method: "POST", body: { user: userId } });
  },
  async dmUnblock(userId) {
    return call(`/dm/blocks/${enc(userId)}`, { method: "DELETE" });
  },
  /** 未读总览（导航角标） */
  async dmUnreadTotal() {
    return call("/dm/unread");
  },

  /* ══════════ 通知中心（阶段 4） ══════════ */

  /** 通知分页：既支持对象参数 {offset,limit,kinds,unread}，也支持位置参数；kinds 可传数组 */
  async notifPage(q, limitB, kindsB, unreadB) {
    const o = q && typeof q === "object" && !Array.isArray(q) ? q : { offset: q, limit: limitB, kinds: kindsB, unread: unreadB };
    const kinds = Array.isArray(o.kinds) ? o.kinds.filter(Boolean).join(",") : (o.kinds || "");
    const u = o.unread ? "&unread=1" : "";
    return call(`/notifications?offset=${enc(o.offset ?? 0)}&limit=${enc(o.limit ?? 30)}${kinds ? `&kinds=${enc(kinds)}` : ""}${u}`);
  },
  /** 各分类未读数 */
  async notifUnread() {
    return call("/notifications/unread");
  },
  /** 标记已读 */
  async notifMark(ids, all) {
    return call("/notifications/read", {
      method: "POST",
      body: { ids: all ? null : (Array.isArray(ids) && ids.length ? ids : null), all: !!all },
    });
  },
  /** 通知偏好读写 */
  async notifPrefsGet() {
    return call("/notifications/prefs");
  },
  async notifPrefsSet(prefs) {
    return call("/notifications/prefs", {
      method: "POST",
      body: {
        comments: prefs.comments !== false,
        reactions: prefs.reactions !== false,
        pets: prefs.pets !== false,
        dms: prefs.dms !== false,
      },
    });
  },
  /** 轮 238 · 公告分批推送：start 建档 → step 循环推批（幂等可续发）→ list 历史 */
  async adminBroadcastStart(body) {
    return call("/admin/broadcast", { method: "POST", body: { body } });
  },
  async adminBroadcastStep(bid, batch) {
    return call("/admin/broadcast/step", { method: "POST", body: batch ? { bid, batch } : { bid } });
  },
  /** 公告历史（admin_broadcasts_list；非管理员得到空集） */
  async adminBroadcasts(limit = 20, offset = 0) {
    return call(`/admin/broadcast?limit=${limit}&offset=${offset}`, { method: "GET" });
  },

  /* ═══ 轮 238 · App 安装包发布（经 /sb 透传到 Storage；对象名固定 warm-paws.apk）═══ */
  async appReleaseUpload(file) {
    const res = await fetch(`${BASE}/sb/storage/v1/object/app-releases/warm-paws.apk`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/vnd.android.package-archive", "x-upsert": "true" }),
      body: file,
    });
    if (!res.ok) {
      const j = await res.json().catch(() => null);
      throw new Error((j && (j.message || j.error)) || `HTTP ${res.status}`);
    }
    return true;
  },
  async appReleaseMeta() {
    const res = await fetch(`${BASE}/sb/storage/v1/object/list/app-releases`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ prefix: "", limit: 5 }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = await res.json().catch(() => []);
    const row = (Array.isArray(rows) ? rows : []).find((x) => x.name === "warm-paws.apk");
    return row && row.metadata
      ? { sizeMb: (row.metadata.size / 1048576).toFixed(1), when: row.updated_at }
      : null;
  },

  /** 清空我的全部通知 */
  async notifClear() {
    return call("/notifications/clear", { method: "POST", body: {} });
  },

  /* ══════════ 账号（App 轨道 T3：自助删号） ══════════ */

  /** 自助删号：Worker 透传到 delete_my_account RPC（成功后调用方需退出登录） */
  async deleteMyAccount() {
    return call("/account/delete", { method: "POST", body: {} });
  },

  /* ══════════ 图片（Storage） ══════════ */

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

  /* ══════════ 帖子收藏夹（轮 128 / #13：/api/fav/*，RLS 私有） ══════════ */

  /** 我的收藏（含内嵌帖子；被下架/删除的帖 post 为 null，调用方过滤） */
  async wallFavListMine(limit, offset) {
    return call(`/fav?limit=${enc(limit)}&offset=${enc(offset)}`);
  },

  /** 批量查「这些帖子里我收藏了哪些」→ { ids: [...] }（形状与直连的数组在 wall.js 归一） */
  async wallFavCheck(postIds) {
    const ids = (postIds || []).filter((x) => Number.isInteger(x));
    if (!ids.length) return { ids: [] };
    return call(`/fav/check?ids=${enc(ids.join(","))}`);
  },

  /** 收藏（服务端盖章 user_id；重复收藏由 unique 约束幂等） */
  async wallFavAdd(postId) {
    return call("/fav", { method: "POST", body: { post_id: postId } });
  },

  /** 取消收藏 */
  async wallFavRemove(postId) {
    return call(`/fav?post_id=${enc(postId)}`, { method: "DELETE" });
  },
};