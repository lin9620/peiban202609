# 轮 158：全站加载优化（故事流/帖子详情/他人主页 SWR 本地直出 + 骨架屏 + 路由 chunk 空闲预热）
import io

def edit(p, pairs):
    s = io.open(p, encoding="utf-8").read()
    for old, new in pairs:
        assert s.count(old) == 1, f"{p}: anchor x{s.count(old)}: {old[:70]!r}"
        s = s.replace(old, new)
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)
    print("ok", p)

# ═══ ① StoryFeed.vue：首屏 SWR + 精选缓存 + 骨架屏 ═══
edit("src/components/story/StoryFeed.vue", [
("""import { storyErrKey } from "../../utils/storyRules.js";
import { storyRank, storyFeatured } from "../../utils/story.js";""",
 """import { storyErrKey } from "../../utils/storyRules.js";
import { storyRank, storyFeatured } from "../../utils/story.js";
import { swr, cacheKey } from "../../utils/cache.js";"""),
("""async function load() {
  loading.value = true;
  err.value = "";
  try {
    const data = await storyRank({ mode: "latest", limit: PAGE, offset: offset.value });
    rows.value = offset.value === 0 ? (data || []) : rows.value.concat(data || []);
  } catch (e) {
    err.value = t(storyErrKey(e));
  } finally {
    loading.value = false;
  }
}
/** 精选取不到就整卡隐藏（不报错 —— 它是点缀，不是主功能） */
async function loadFeatured() {
  try { featured.value = await storyFeatured(); } catch (e) { featured.value = null; }
}""",
 """async function load() {
  loading.value = true;
  err.value = "";
  const first = offset.value === 0;
  /* 轮 158：首屏 SWR 本地直出——进故事联不再干等网络（故事流是公共内容，键不带用户域）；
   * 翻页照旧不缓存、拼尾。发布后父级调 load() 刷新：缓存先出、新内容由 fresh 纠正。 */
  await swr(
    first ? cacheKey("story:feed:latest") : null,
    {
      cached: (data) => { rows.value = data || []; loading.value = false; },
      fresh: (data) => { rows.value = first ? (data || []) : rows.value.concat(data || []); },
      onError: (e) => { err.value = t(storyErrKey(e || new Error("network"))); },
    },
    () => storyRank({ mode: "latest", limit: PAGE, offset: offset.value }),
  );
  loading.value = false;
}
/** 精选取不到就整卡隐藏（不报错 —— 它是点缀，不是主功能） */
async function loadFeatured() {
  await swr(
    cacheKey("story:featured"),
    {
      cached: (v) => { if (v) featured.value = v; },
      fresh: (v) => { featured.value = v || null; },
    },
    () => storyFeatured().catch(() => null),
  );
}"""),
("""    <p v-if="!shown.length && !loading" class="st-hint">{{ t("story.rankEmpty") }}</p>""",
 """    <!-- 轮 158：首访无缓存时的骨架占位（三张 shimmer 卡），不再整块空白干等 -->
    <div v-if="loading && !shown.length" class="st-skel" aria-hidden="true">
      <div v-for="i in 3" :key="i" class="st-skel-card"></div>
    </div>
    <p v-if="!shown.length && !loading" class="st-hint">{{ t("story.rankEmpty") }}</p>"""),
])

# ═══ ② PostDetailView.vue：帖子主体 SWR ═══
edit("src/views/PostDetailView.vue", [
("""import { fmtWhen } from "../utils/wallRules.js";""",
 """import { fmtWhen } from "../utils/wallRules.js";
import { cacheKey, swr, cacheSet } from "../utils/cache.js";   /* 轮 158：帖子主体 SWR */"""),
("""  loading.value = true;
  failed.value = false;
  gone.value = false;
  const p = await cloudFetchPost(uid.value);
  if (!p) { failed.value = true; loading.value = false; return; }
  post.value = p;
  loading.value = false;""",
 """  loading.value = true;
  failed.value = false;
  gone.value = false;
  /* 轮 158：帖子主体 SWR——从墙/我的/主页点进来，本地先出上次的帖子立刻能读，
   * 后台拉新数据纠正（回应数/浏览数以 fresh 为准）。null = 查无此帖/网络挂 → 原failed口径 */
  await swr(
    cacheKey("wall:post", uid.value),
    {
      cached: (p) => { if (p) { post.value = p; loading.value = false; } },
      fresh: (p) => { if (p) { post.value = p; loading.value = false; } },
    },
    () => cloudFetchPost(uid.value),
  );
  if (!post.value) { failed.value = true; loading.value = false; return; }
  loading.value = false;"""),
("""async function refetch() {
  const p = await cloudFetchPost(uid.value);
  if (!p) { gone.value = true; post.value = null; return; }
  post.value = p;
}""",
 """async function refetch() {
  const p = await cloudFetchPost(uid.value);
  if (!p) { gone.value = true; post.value = null; return; }
  post.value = p;
  cacheSet(cacheKey("wall:post", uid.value), p);   /* 轮 158：操作后的最新态回写缓存 */
}"""),
])

# ═══ ③ WallerView.vue：三路聚合整体 SWR ═══
edit("src/views/WallerView.vue", [
("""import { visibleOnly, ANON_KEY, fmtWhen } from "../utils/wallRules.js";""",
 """import { visibleOnly, ANON_KEY, fmtWhen } from "../utils/wallRules.js";
import { cacheKey, swr } from "../utils/cache.js";   /* 轮 158：主页聚合 SWR */"""),
("""onMounted(async () => {
  if (!uid) { failed.value = true; loading.value = false; return; }
  refreshBlocks();   /* 轮 33：名单就绪（拉黑按钮的「已拉黑」态靠它） */
  const [pf, ps, ph] = await Promise.all([
    cloudFetchProfile(uid), cloudFetchUserPosts(uid), cloudGetPetHome(uid),
  ]);
  if (pf === null && ps === null) failed.value = true;
  prof.value = pf || { nickname: "", created_at: null };
  posts.value = visibleOnly(ps || []);
  petHome.value = ph; /* null = 未迁移/查询失败 → 区块显示「准备中」；pet 为空 → 「还没带宠物来」 */
  loading.value = false;
});""",
 """onMounted(async () => {
  if (!uid) { failed.value = true; loading.value = false; return; }
  refreshBlocks();   /* 轮 33：名单就绪（拉黑按钮的「已拉黑」态靠它） */
  /* 轮 158：资料+帖子+宠物家园三路聚合整体走 SWR——二次进页本地直出，
   * 不再干等三个 RPC 排队；拉黑名单刷新后 fresh 会把过滤后的帖子纠正回来 */
  let applied = false;
  const apply = ({ pf, ps, ph }) => {
    prof.value = pf || { nickname: "", created_at: null };
    posts.value = visibleOnly(ps || []);
    petHome.value = ph; /* null = 未迁移/查询失败 → 区块显示「准备中」；pet 为空 → 「还没带宠物来」 */
    applied = true;
  };
  await swr(
    cacheKey("waller:home", uid),
    {
      cached: (d) => { apply(d); loading.value = false; },
      fresh: apply,
    },
    async () => {
      const [pf, ps, ph] = await Promise.all([
        cloudFetchProfile(uid), cloudFetchUserPosts(uid), cloudGetPetHome(uid),
      ]);
      /* 原口径：资料与帖子都拿不到 = 查无此人/网络挂 → failed（null 让 swr 不覆盖不落缓存） */
      if (pf === null && ps === null) return null;
      return { pf, ps, ph };
    },
  );
  loading.value = false;
  if (!applied) failed.value = true;
});"""),
])

# ═══ ④ App.vue：首绘后空闲预热高频路由 chunk ═══
edit("src/App.vue", [
("""  await Promise.race([boot, new Promise((r) => setTimeout(r, 2500))]);
  removeSplash();""",
 """  await Promise.race([boot, new Promise((r) => setTimeout(r, 2500))]);
  removeSplash();
  /* 轮 158：首绘后空闲预热高频路由 chunk（社区/私信/我的/帖子详情/宠物/故事流）——
   * 切联/切 tab 不再现等 chunk 下载；rIC 空闲才跑（4s 兜底），不抢首屏带宽 */
  const warmChunks = () => {
    import("./views/CommunityView.vue");
    import("./views/MessagesView.vue");
    import("./views/ProfileView.vue");
    import("./views/PostDetailView.vue");
    import("./views/PetView.vue");
    import("./components/story/StoryFeed.vue");
  };
  if (typeof requestIdleCallback === "function") requestIdleCallback(warmChunks, { timeout: 4000 });
  else setTimeout(warmChunks, 2500);"""),
])

# ═══ ⑤ style.css：骨架屏样式（挨着 .st-hint） ═══
edit("src/style.css", [
(""".st-hint { color: var(--ink-faint); font-size: 12px; }""",
 """.st-hint { color: var(--ink-faint); font-size: 12px; }
/* 轮 158：故事流骨架屏（首访无缓存时占位，shimmer 动画）；warm 配色跟随主题墨色 */
.st-skel { display: grid; gap: 10px; }
.st-skel-card {
  height: 88px; border-radius: 16px;
  background: linear-gradient(100deg, rgba(141, 131, 120, .10) 40%, rgba(141, 131, 120, .18) 50%, rgba(141, 131, 120, .10) 60%);
  background-size: 200% 100%;
  animation: st-skel-shine 1.2s ease-in-out infinite;
}
@keyframes st-skel-shine { to { background-position: -200% 0; } }"""),
])
print("ALL 158 EDITS DONE")
