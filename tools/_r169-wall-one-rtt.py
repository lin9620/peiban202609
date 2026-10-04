# 轮 169：暖心墙刷新请求合并——/api/wall/refresh 一次打包（最新+随机+回应+评论数），弱网 5 RTT→1
import io

def edit(p, pairs):
    s = io.open(p, encoding="utf-8").read()
    for old, new in pairs:
        assert s.count(old) == 1, f"{p}: anchor x{s.count(old)}: {old[:70]!r}"
        s = s.replace(old, new)
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)
    print("ok", p)

# ═══ ① worker/api.js：wallRefresh 函数 + 路由 ═══
edit("worker/api.js", [
("""const REACT_SEL = `select=${encodeURIComponent("post_id,user_id,kind")}`;""",
 """const REACT_SEL = `select=${encodeURIComponent("post_id,user_id,kind")}`;

/** ═══ 轮 169 · 暖心墙刷新合并包 ═══
 * 弱网真凶：刷新要串行跑 4~5 个网络来回（最新页→它的回应→随机批→它的回应→评论数），
 * 每个 RTT 在手机 4G 上都是 1s+。这里在 Worker 内并行打上游、打包一次回给客户端：
 * 手机只剩 1 个来回。响应 = { posts(最新4钉顶+随机批去重), reactions(明细,客户端聚合
 * 出计数与 mine), commentCounts({post_id: n}) }。随机+含用户身份混合 → 不进边缘缓存。 */
async function wallRefresh(env, request, limit) {
  const now = Date.now();
  const anchor = new Date(now - 7 * 86400000 + Math.random() * 7 * 86400000).toISOString();
  const base = ["select=*", "removed=eq.false", "order=created_at.desc", `limit=${limit}`];
  const [a, b] = await Promise.all([
    upstream(env, request, restUrl(env, TABLE.posts, base.join("&"))),
    upstream(env, request, restUrl(env, TABLE.posts, [...base, `created_at=lte.${encodeURIComponent(anchor)}`].join("&"))),
  ]);
  if (!a || !a.ok) return fail(502, "upstream-unreachable");
  let latest = [], batch = [];
  try { latest = JSON.parse(await a.text()) || []; } catch (e) { latest = []; }
  if (b && b.ok) { try { batch = JSON.parse(await b.text()) || []; } catch (e) { batch = []; } }
  /* 最新 4 条钉顶（新帖必现），随机批去重填充 */
  const seen = new Set();
  const merged = [];
  for (const r of latest.slice(0, 4)) if (r && r.id != null && !seen.has(r.id)) { seen.add(r.id); merged.push(r); }
  for (const r of batch) if (r && r.id != null && !seen.has(r.id)) { seen.add(r.id); merged.push(r); }
  for (const r of latest) if (r && r.id != null && !seen.has(r.id)) { seen.add(r.id); merged.push(r); }
  const ids = merged.map((r) => r.id).filter((x) => x != null);
  const [rk, cm] = await Promise.all([
    ids.length ? listReactionsByPosts(env, request, ids) : null,
    ids.length ? listCommentPostIds(env, request, ids, 2000) : null,
  ]);
  if (!rk || !rk.ok || !cm || !cm.ok) return fail(502, "upstream-unreachable");
  let reactions = [], cmtRows = [];
  try { reactions = JSON.parse(await rk.text()) || []; } catch (e) { reactions = []; }
  try { cmtRows = JSON.parse(await cm.text()) || []; } catch (e) { cmtRows = []; }
  const commentCounts = {};
  for (const c of cmtRows) if (c && c.post_id != null) commentCounts[c.post_id] = (commentCounts[c.post_id] || 0) + 1;
  return json({ posts: merged, reactions, commentCounts });
}"""),
("""      /* —— 帖子 —— */
      if (seg[0] === "posts") {""",
 """      /* —— 暖心墙刷新合并包（轮 169）—— */
      if (seg[0] === "wall" && seg[1] === "refresh") {
        if (m === "GET") return wallRefresh(env, request, parseLimit(q.get("limit"), 20));
        return fail(405, "bad-method");
      }

      /* —— 帖子 —— */
      if (seg[0] === "posts") {"""),
])

# ═══ ② db 两通道：gateway 一发直取；supabase 直连同形组合 ═══
edit("src/utils/api/db.gateway.js", [
("""  async listPosts(limit, opts = {}) {""",
 """  /** 轮 169：暖心墙刷新合并包（最新+随机+回应明细+评论数一次回） */
  async wallRefresh(limit) {
    return call(`/wall/refresh?limit=${enc(limit)}`);
  },

  async listPosts(limit, opts = {}) {"""),
])

edit("src/utils/api/db.supabase.js", [
("""  listReactionsByPosts(postIds) {""",
 """  /** 轮 169：暖心墙刷新合并包（直连模式同形组合；网关模式在 Worker 内并行） */
  async wallRefresh(limit) {
    const anchor = new Date(Date.now() - 7 * 86400000 + Math.random() * 7 * 86400000).toISOString();
    const [a, b] = await Promise.all([
      unwrap(sb().from(T.posts).select("*").eq("removed", false).order("created_at", { ascending: false }).limit(limit)),
      unwrap(sb().from(T.posts).select("*").eq("removed", false).lte("created_at", anchor).order("created_at", { ascending: false }).limit(limit)),
    ]);
    const seen = new Set();
    const merged = [];
    for (const r of (a || []).slice(0, 4)) if (r && r.id != null && !seen.has(r.id)) { seen.add(r.id); merged.push(r); }
    for (const r of b || []) if (r && r.id != null && !seen.has(r.id)) { seen.add(r.id); merged.push(r); }
    for (const r of a || []) if (r && r.id != null && !seen.has(r.id)) { seen.add(r.id); merged.push(r); }
    const ids = merged.map((r) => r.id).filter((x) => x != null);
    const [rk, cm] = await Promise.all([
      ids.length ? unwrap(sb().from(T.reactions).select("post_id,user_id,kind").in("post_id", ids)) : Promise.resolve([]),
      ids.length ? unwrap(sb().from(T.comments).select("post_id").in("post_id", ids).limit(2000)) : Promise.resolve([]),
    ]);
    const commentCounts = {};
    for (const c of cm || []) if (c && c.post_id != null) commentCounts[c.post_id] = (commentCounts[c.post_id] || 0) + 1;
    return { posts: merged, reactions: rk || [], commentCounts };
  },

  listReactionsByPosts(postIds) {"""),
])

# ═══ ③ wall.js：cloudFetchWallRefresh 客户端组装（回应聚合/rowsToPosts/计数） ═══
edit("src/utils/wall.js", [
("""export async function cloudFetchCommentCounts(dbPostIds) {""",
 """/** 轮 169：刷新合并包——一个请求拿全（最新+随机+回应明细+评论数），弱网少 4 个来回 */
export async function cloudFetchWallRefresh(limit = 20) {
  if (!canReadWall()) return null;
  try {
    const pack = await db.wallRefresh(Number(limit) > 0 ? Number(limit) : 20);
    if (!pack || !Array.isArray(pack.posts)) return null;
    const reactions = aggregateReactions(pack.reactions || [], cloud.user ? cloud.user.id : "");
    const rows = rowsToPosts(pack.posts || [], reactions, publicUrl);
    return { rows, counts: pack.commentCounts || {} };
  } catch (e) {
    console.warn("[cloud] wallRefresh:", e);
    return null;
  }
}

export async function cloudFetchCommentCounts(dbPostIds) {"""),
])

# ═══ ④ CommunityView：刷新/首屏都走合并包（单请求） ═══
edit("src/views/CommunityView.vue", [
("""import {
  cloudFetchPosts, cloudFetchPostsSample, cloudInsertPost, cloudFetchComments, cloudInsertComment,""",
 """import {
  cloudFetchPosts, cloudFetchPostsSample, cloudFetchWallRefresh, cloudInsertPost, cloudFetchComments, cloudInsertComment,"""),
("""  const fetcher = async () => {
    /* 轮 159（用户：「每个人暖心墙帖子出现的都一样，不能加个随机数吗」）：挂载改走
       随机批——7 天池随机起点，每人每次进来看到的都不一样（轮 66 注释早写了要这么做，
       代码后来退回了最新页）；随机批失败退回最新页兜底。触底续载照旧按游标拉更早的
       （loadMoreCloud 自带去重+跳页自愈，随机批与后续页少量交叠也不会重复）。 */
    const rows = (await cloudFetchPostsSample(REFRESH_PAGE).catch(() => null))
      || (await cloudFetchPosts(REFRESH_PAGE, 0).catch(() => null));
    if (!rows) return null;   /* 拉取失败 → 不覆盖、不回写缓存 */
    const counts = await cloudFetchCommentCounts(rows.map((r) => r.dbId)).catch(() => null);
    return { rows, counts: counts || {}, fromFetch: true };
  };""",
 """  const fetcher = async () => {
    /* 轮 169：首屏也走合并包（一个请求：最新+随机+回应+评论数），弱网少 4 个来回；
       失败退回旧两段式（最新页）兜底。触底续载照旧按游标拉更早的。 */
    const pack = await cloudFetchWallRefresh(REFRESH_PAGE).catch(() => null);
    if (pack && Array.isArray(pack.rows) && pack.rows.length) {
      return { rows: pack.rows, counts: pack.counts || {}, fromFetch: true };
    }
    const rows = await cloudFetchPosts(REFRESH_PAGE, 0).catch(() => null);
    if (!rows) return null;   /* 拉取失败 → 不覆盖、不回写缓存 */
    const counts = await cloudFetchCommentCounts(rows.map((r) => r.dbId)).catch(() => null);
    return { rows, counts: counts || {}, fromFetch: true };
  };"""),
("""    const pull = Promise.all([
      cloudFetchPosts(REFRESH_PAGE, 0).catch(() => null),
      cloudFetchPostsSample(REFRESH_PAGE).catch(() => null),
    ]).then(([posts, batch]) => ({
      posts: Array.isArray(posts) ? posts : null,
      batch: Array.isArray(batch) ? batch : null,
    }));
    const box = await Promise.race([pull, new Promise((res) => setTimeout(() => res(null), 8000))]).catch(() => null);""",
 """    /* 轮 169：刷新只有一个请求了——worker 打包「最新+随机+回应+评论数」一次回；
       新帖必现（最新 4 条钉顶），其余随机换一批。 */
    const pull = cloudFetchWallRefresh(REFRESH_PAGE).catch(() => null).then((pack) =>
      pack && Array.isArray(pack.rows) ? { rows: pack.rows, counts: pack.counts || {} } : null);
    const box = await Promise.race([pull, new Promise((res) => setTimeout(() => res(null), 8000))]).catch(() => null);"""),
])
print("PART A DONE")
