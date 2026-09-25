import io

# ① Worker：sample 模式（数总数 → 随机起点取一页）
p = "worker/api.js"
s = io.open(p, encoding="utf-8").read()

old = """async function listPosts(env, request, uid, limit, offset, beforeId = 0) {"""
new = """/* 轮 64：sample 随机一批（「换一批」）——先数 7 天池总量（count=exact + Range 0-0，微小查询），
   再随机起点取一页。两次微小上游调用，不用全表排序。 */
async function samplePosts(env, request, limit, since) {
  const base = ["select=id", "removed=eq.false"];
  if (since) base.push(`created_at=gte.${encodeURIComponent(since)}`);
  const c = await upstream(env, request, restUrl(env, TABLE.posts, [...base, "order=created_at.desc"].join("&")), { headers: { prefer: "count=exact", range: "0-0" } });
  if (!c || !c.ok) return fail(502, "upstream-unreachable");
  const total = parseInt(((c.headers.get("content-range") || "").split("/")[1] || "0"), 10) || 0;
  const maxOff = Math.max(0, total - limit);
  const off = Math.floor(Math.random() * (maxOff + 1));
  const qs = [...base, "order=created_at.desc", `limit=${limit}`, off > 0 ? `offset=${off}` : ""].filter(Boolean).join("&");
  const res = await upstream(env, request, restUrl(env, TABLE.posts, qs));
  if (!res || !res.ok) return fail(502, "upstream-unreachable");
  return new Response(await res.text(), { status: res.status, headers: { "content-type": "application/json" } });
}

async function listPosts(env, request, uid, limit, offset, beforeId = 0) {"""
assert s.count(old) == 1
s = s.replace(old, new)

old = """          if (m === "GET") {
            const bidRaw = q.get("before_id") || "";
            const bid = /^\\d+$/.test(bidRaw) ? Number(bidRaw) : 0;
            return listPosts(env, request, "", parseLimit(q.get("limit"), 200), parseOffset(q.get("offset")), bid);
          }"""
new = """          if (m === "GET") {
            const bidRaw = q.get("before_id") || "";
            const bid = /^\\d+$/.test(bidRaw) ? Number(bidRaw) : 0;
            if (q.get("sample") === "1") {
              const since = /^\\d{4}-\\d{2}-\\d{2}T/.test(q.get("since") || "") ? q.get("since") : "";
              return samplePosts(env, request, parseLimit(q.get("limit"), 50), since);
            }
            return listPosts(env, request, "", parseLimit(q.get("limit"), 200), parseOffset(q.get("offset")), bid);
          }"""
assert s.count(old) == 1
s = s.replace(old, new)
io.open(p, "w", encoding="utf-8", newline="").write(s)

# ② gateway：listPostsSample
p = "src/utils/api/db.gateway.js"
s = io.open(p, encoding="utf-8").read()
old = """  /** 某用户的帖子（新→旧）；offset = 分页偏移（0/缺省 = 旧行为） */"""
new = """  /** 轮 64：随机换一批（7 天池；Worker 数总量→随机起点，深池也不怕） */
  async listPostsSample(limit, since) {
    return call(`/posts?sample=1&limit=${enc(limit)}${since ? `&since=${enc(since)}` : ""}`);
  },

  /** 某用户的帖子（新→旧）；offset = 分页偏移（0/缺省 = 旧行为） */"""
assert s.count(old) == 1
s = s.replace(old, new)
io.open(p, "w", encoding="utf-8", newline="").write(s)

# ③ supabase：listPostsSample（直连=本地调试用）
p = "src/utils/api/db.supabase.js"
s = io.open(p, encoding="utf-8").read()
old = """  /** 某用户的帖子（新→旧）；同样带 removed 兼容。offset = 分页偏移（0/缺省 = 旧行为） */"""
new = """  /** 轮 64：随机换一批（先 count 总量 → 随机起点 range 一页；与网关 sample 同语义） */
  async listPostsSample(limit, since) {
    let cq = sb().from(T.posts).select("id", { count: "exact", head: true }).eq("removed", false);
    if (since) cq = cq.gte("created_at", since);
    const { count, error } = await cq;
    if (error) return unwrap(Promise.resolve({ error }));
    const total = Number(count) || 0;
    const maxOff = Math.max(0, total - Number(limit));
    const off = Math.floor(Math.random() * (maxOff + 1));
    let res = await sb().from(T.posts).select("*").eq("removed", false).order("created_at", { ascending: false }).range(off, off + Number(limit) - 1);
    if (res && res.error) {
      res = await sb().from(T.posts).select("*").order("created_at", { ascending: false }).range(off, off + Number(limit) - 1);
    }
    return unwrap(Promise.resolve(res));
  },

  /** 某用户的帖子（新→旧）；同样带 removed 兼容。offset = 分页偏移（0/缺省 = 旧行为） */"""
assert s.count(old) == 1
s = s.replace(old, new)
io.open(p, "w", encoding="utf-8", newline="").write(s)

# ④ wall.js：cloudFetchPostsSample（回应数富化与 cloudFetchPosts 同款）
p = "src/utils/wall.js"
s = io.open(p, encoding="utf-8").read()
old = """/** 发布帖子；imageDataUrl 可空。返回视图帖子或 null */"""
new = """/** 轮 64：随机换一批（7 天池；作者/回应数富化与 cloudFetchPosts 同款） */
export async function cloudFetchPostsSample(limit = 50) {
  if (!canReadWall()) return null;
  try {
    const since = new Date(Date.now() - 7 * 86400000).toISOString();
    const rows = await db.listPostsSample(Number(limit) > 0 ? Number(limit) : 50, since);
    let reactions = {};
    try {
      const ids = (rows || []).map((x) => x.id);
      const rk = ids.length ? await db.listReactionsByPosts(ids) : [];
      reactions = aggregateReactions(rk || [], cloud.user ? cloud.user.id : "");
    } catch (e) { /* 回应拉取失败不阻塞帖子 */ }
    return rowsToPosts(rows || [], reactions, publicUrl);
  } catch (e) {
    console.warn("[cloud] fetchPostsSample:", e);
    return null;
  }
}

/** 发布帖子；imageDataUrl 可空。返回视图帖子或 null */"""
assert s.count(old) == 1
s = s.replace(old, new)
io.open(p, "w", encoding="utf-8", newline="").write(s)

# ⑤ CommunityView：刷新流程升级（新帖→新增提示；无新帖→随机换一批）
p = "src/views/CommunityView.vue"
s = io.open(p, encoding="utf-8").read()

old = '  cloudFetchPosts, cloudInsertPost, cloudFetchComments, cloudInsertComment,'
new = '  cloudFetchPosts, cloudFetchPostsSample, cloudInsertPost, cloudFetchComments, cloudInsertComment,'
assert s.count(old) == 1
s = s.replace(old, new)

old = """const refreshNote = ref(false);
const freshLanded = ref(false);"""
if s.count(old) == 1:
    s = s.replace(old, """const refreshNote = ref(false);
const freshLanded = ref(false);
const newestSeenTs = ref(0);   /* 轮 64：见过的最新帖 ts——下拉时对比才知道有没有新帖 */""")
else:
    old2 = """const refreshNote = ref(false);"""
    assert s.count(old2) == 1
    s = s.replace(old2, """const refreshNote = ref(false);
const newestSeenTs = ref(0);   /* 轮 64：见过的最新帖 ts——下拉时对比才知道有没有新帖 */""")

old = """    if (box.fromFetch) {
      /* 本轮 fetch 的结果：游标=末条 dbId（id<游标 取下一页）；页不满=服务器已到底 */
      feedCursor.value = box.rows.length ? box.rows[box.rows.length - 1].dbId : feedCursor.value;
      cloudDone.value = box.rows.length < FEED_PAGE;
    } else {
      /* 旧/外来缓存盒：仅展示快照——游标清空、不算到底（loadMoreCloud 的去重+跳页会自愈错位） */
      feedCursor.value = null;
      cloudDone.value = false;
    }"""
new = """    if (box.fromFetch) {
      /* 本轮 fetch 的结果：游标=末条 dbId（id<游标 取下一页）；页不满=服务器已到底 */
      feedCursor.value = box.rows.length ? box.rows[box.rows.length - 1].dbId : feedCursor.value;
      cloudDone.value = box.rows.length < FEED_PAGE;
      newestSeenTs.value = Math.max(newestSeenTs.value, ...box.rows.map((p) => p.ts || 0));
    } else {
      /* 旧/外来缓存盒：仅展示快照——游标清空、不算到底（loadMoreCloud 的去重+跳页会自愈错位） */
      feedCursor.value = null;
      cloudDone.value = false;
    }"""
assert s.count(old) == 1
s = s.replace(old, new)

old = """  if (fresh) {
    /* 下拉刷新：强制取新（绕过缓存），失败时保留旧列表（与「不覆盖」同语义）。
       轮 61：提示必须说实话——之前「已刷新」无条件显示，拉取失败也谎报成功（用户实测怒斥）。
       成功时对比刷新前最新 ts：有新帖报条数，没新帖如实说「已刷新」，失败明说再试。 */
    const prevNewest = newestSeenTs.value;
    const box = await fetcher();
    if (box) {
      consume(box);
      reveal.value = PAGE_SIZE;
      const freshRows = box.rows.filter((p) => (p.ts || 0) > prevNewest);
      refreshNote.value = freshRows.length
        ? t("community.refreshNew", { n: freshRows.length })
        : t("community.refreshed");
    } else {
      refreshNote.value = t("community.refreshFail");
    }
    setTimeout(() => { refreshNote.value = false; }, 2500);
  } else {"""
new = """  if (fresh) {
    /* 下拉刷新：强制取新（绕过缓存），失败时保留旧列表（与「不覆盖」同语义）。
       轮 61：提示说实话（成功有新/无新、失败，各自如实）。
       轮 64（用户拍板「下拉就刷新一批内容」）：**没有新帖时不再原样返回，随机换一批**
       （7 天池随机起点）——静态数据下刷新也能看到不同的内容。 */
    const prevNewest = newestSeenTs.value;
    const box = await fetcher();
    if (box) {
      consume(box);
      reveal.value = PAGE_SIZE;
      const freshRows = box.rows.filter((p) => (p.ts || 0) > prevNewest);
      if (freshRows.length) {
        refreshNote.value = t("community.refreshNew", { n: freshRows.length });
      } else {
        const batch = await cloudFetchPostsSample(FEED_PAGE);
        if (batch && batch.length) {
          consume({ rows: batch, counts: {}, fromFetch: true });
          refreshNote.value = t("community.refreshBatch");
        } else {
          refreshNote.value = t("community.refreshed");
        }
      }
    } else {
      refreshNote.value = t("community.refreshFail");
    }
    setTimeout(() => { refreshNote.value = false; }, 2500);
  } else {"""
assert s.count(old) == 1
s = s.replace(old, new)
io.open(p, "w", encoding="utf-8", newline="").write(s)

# ⑥ i18n：refreshBatch 双语成对
p = "src/i18n.js"
s = io.open(p, encoding="utf-8").read()
old = '      refreshFail: "Couldn\\u2019t refresh — try again",'
if s.count(old) != 1:
    old = '      refreshFail: "Couldn\'t refresh — try again",'
if s.count(old) != 1:
    import re as _re
    mfail = _re.search(r'refreshFail: "[^"]+",', s)
    old = mfail.group(0)
s = s.replace(old, old + '\n      refreshBatch: "Refreshed ✓ · a new batch for you",', 1)
z = _re.search(r'refreshFail: "[^"]+",', s[s.find(old) + len(old):])
zfull = z.group(0)
s = s.replace(zfull, zfull + '\n      refreshBatch: "已刷新 ✓ 换了一批内容",', 1)
io.open(p, "w", encoding="utf-8", newline="").write(s)
print("all ok")
