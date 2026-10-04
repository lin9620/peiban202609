# 轮 159：暖心墙刷新无效/人人一样 —— sample 批除名边缘缓存 + 首屏挂载改随机批
import io

def edit(p, pairs):
    s = io.open(p, encoding="utf-8").read()
    for old, new in pairs:
        assert s.count(old) == 1, f"{p}: anchor x{s.count(old)}: {old[:70]!r}"
        s = s.replace(old, new)
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)
    print("ok", p)

# ═══ ① worker/api.js：随机批（sample=1）绝不进边缘缓存 ═══
edit("worker/api.js", [
("""export default {
  async fetch(request, env, ctx) {
    const hasCache = typeof caches !== "undefined" && caches && caches.default;
    const cacheable =
      hasCache && request.method === "GET" && cacheablePath(new URL(request.url).pathname)
      && !hasAuth(request);
    if (!cacheable) return handleApi(request, env, ctx);""",
 """export default {
  async fetch(request, env, ctx) {
    const hasCache = typeof caches !== "undefined" && caches && caches.default;
    const u0 = new URL(request.url);
    const cacheable =
      hasCache && request.method === "GET" && cacheablePath(u0.pathname)
      && !hasAuth(request)
      /* 轮 159（用户：「刷新没有用/每个人出现的都一样」）：随机批绝不进缓存——
         sample 的随机结果被边缘缓存 30s = 同一 POP 上所有人拿到同一份「随机」，
         刷新也只是原样回放。随机批每次回源（计数+随机起点两查，成本可接受）；
         普通列表仍是确定性内容，30s 边缘缓存照旧保留。 */
      && u0.searchParams.get("sample") !== "1";
    if (!cacheable) return handleApi(request, env, ctx);"""),
])

# ═══ ② CommunityView.vue：首屏挂载走随机批（7 天池），失败退回最新页 ═══
edit("src/views/CommunityView.vue", [
("""  const fetcher = async () => {
    const rows = await cloudFetchPosts(FEED_PAGE, 0);
    if (!rows) return null;   /* 拉取失败 → 不覆盖、不回写缓存 */
    const counts = await cloudFetchCommentCounts(rows.map((r) => r.dbId)).catch(() => null);
    return { rows, counts: counts || {}, fromFetch: true };
  };""",
 """  const fetcher = async () => {
    /* 轮 159（用户：「每个人暖心墙帖子出现的都一样，不能加个随机数吗」）：挂载改走
       随机批——7 天池随机起点，每人每次进来看到的都不一样（轮 66 注释早写了要这么做，
       代码后来退回了最新页）；随机批失败退回最新页兜底。触底续载照旧按游标拉更早的
       （loadMoreCloud 自带去重+跳页自愈，随机批与后续页少量交叠也不会重复）。 */
    const rows = (await cloudFetchPostsSample(FEED_PAGE).catch(() => null))
      || (await cloudFetchPosts(FEED_PAGE, 0).catch(() => null));
    if (!rows) return null;   /* 拉取失败 → 不覆盖、不回写缓存 */
    const counts = await cloudFetchCommentCounts(rows.map((r) => r.dbId)).catch(() => null);
    return { rows, counts: counts || {}, fromFetch: true };
  };"""),
])
print("ALL 159 EDITS DONE")
