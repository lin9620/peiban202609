# 轮 170 part B：wallRefresh 改走 RPC + 热路径去 select * + wall.js 适配 + 测试更新 + SETUP 同步
import io

def edit(p, pairs):
    s = io.open(p, encoding="utf-8").read()
    for old, new in pairs:
        assert s.count(old) == 1, f"{p}: anchor x{s.count(old)}: {old[:70]!r}"
        s = s.replace(old, new)
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)
    print("ok", p)

# ═══ ① worker/api.js ═══
edit("worker/api.js", [
# wallRefresh：四查询编排 → 单次 RPC 透传
("""async function wallRefresh(env, request, limit) {
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
}""",
 """async function wallRefresh(env, request, limit) {
  /* 轮 170：改走 SQL RPC（wall_feed_page）——最新/随机/回应计数/评论数在一条 SQL 里
   * CTE + GROUP BY JOIN 聚合成型，一个上游查询出整个合并包（此前 4 查询的编排挪进数据库）。 */
  return rpc(env, request, "wall_feed_page", { p_limit: limit });
}"""),
# listPosts / samplePosts：select=* → 显式列
("""async function listPosts(env, request, uid, limit, offset, beforeId = 0) {
  const base = ["select=*"];""",
 """/* 轮 170：feed/列表用显式列（rowsToPosts 消费字段全覆盖），不再 select * */
const POST_COLS_ENC = encodeURIComponent("id,user_id,author_name,body,image_path,created_at,views,dislikes,removed");

async function listPosts(env, request, uid, limit, offset, beforeId = 0) {
  const base = [`select=${POST_COLS_ENC}`];"""),
("""  const base = ["select=*", "removed=eq.false", "order=created_at.desc", `limit=${limit}`];
""",
 """  const base = [`select=${POST_COLS_ENC}`, "removed=eq.false", "order=created_at.desc", `limit=${limit}`];
"""),
])

# ═══ ② db.supabase.js：wallRefresh 改 RPC + listPosts 显式列 ═══
edit("src/utils/api/db.supabase.js", [
("""  /** 轮 169：暖心墙刷新合并包（直连模式同形组合；网关模式在 Worker 内并行） */
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
  },""",
 """  /** 轮 170：暖心墙刷新合并包——直连模式也走 RPC（一条 SQL 出整个合并包） */
  async wallRefresh(limit) {
    return unwrap(sb().rpc("wall_feed_page", { p_limit: limit }));
  },"""),
("""    const q = (withRemoved) => {
      let base = sb().from(T.posts).select("*");""",
 """    const q = (withRemoved) => {
      /* 轮 170：显式列，不再 select *（rowsToPosts 消费字段全覆盖） */
      let base = sb().from(T.posts).select("id,user_id,author_name,body,image_path,created_at,views,dislikes,removed");"""),
])

# ═══ ③ wall.js：合并包形状适配（latest/random 钉顶合并 + react map 直用） ═══
edit("src/utils/wall.js", [
("""/** 轮 169：刷新合并包——一个请求拿全（最新+随机+回应明细+评论数），弱网少 4 个来回 */
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
}""",
 """/** 轮 169/170：刷新合并包——一个请求拿全（最新+随机+回应计数+我的回应+评论数）。
 * RPC 已在 SQL 里按帖聚合好（wall_feed_page），客户端只做「最新 4 条钉顶 + 随机批去重」。 */
export async function cloudFetchWallRefresh(limit = 20) {
  if (!canReadWall()) return null;
  try {
    const pack = await db.wallRefresh(Number(limit) > 0 ? Number(limit) : 20);
    if (!pack || !Array.isArray(pack.latest) || !Array.isArray(pack.random)) return null;
    const seen = new Set();
    const merged = [];
    for (const r of pack.latest.slice(0, 4)) if (r && r.id != null && !seen.has(r.id)) { seen.add(r.id); merged.push(r); }
    for (const r of pack.random) if (r && r.id != null && !seen.has(r.id)) { seen.add(r.id); merged.push(r); }
    for (const r of pack.latest) if (r && r.id != null && !seen.has(r.id)) { seen.add(r.id); merged.push(r); }
    const rows = rowsToPosts(merged, pack.react || {}, publicUrl);
    return { rows, counts: pack.comment || {} };
  } catch (e) {
    console.warn("[cloud] wallRefresh:", e);
    return null;
  }
}"""),
])

# ═══ ④ SUPABASE_SETUP.sql 同步（文件尾追加轮 170 段） ═══
SETUP = "SUPABASE_SETUP.sql"
s = io.open(SETUP, encoding="utf-8").read()
if "wall_feed_page" not in s:
    idxs = io.open("MIGRATION_perf_indexes.sql", encoding="utf-8").read()
    fn = io.open("MIGRATION_wall_feed_page.sql", encoding="utf-8").read()
    s = s.rstrip() + "\n\n-- ═══════════ 轮 170 · 性能补丁（索引 + feed 单查询 RPC，与两个 MIGRATION 文件同步）═══════════\n\n" + idxs + "\n" + fn
    io.open(SETUP, "w", encoding="utf-8", newline="\n").write(s)
    print("ok SUPABASE_SETUP.sql (+轮170 段)")
else:
    print("  skip SETUP: already synced")
print("PART B DONE")
