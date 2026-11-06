<!-- 轮 145 · 故事栏「发现」页签：每日精选卡 + 最新故事流 + 标题/标签搜索（本地过滤已载入的）+ 载入更多
 * 批 2：顶部每日精选（story_featured，无则整卡不渲染，不留空框）。 -->
<script setup>
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { t } from "../../i18n.js";
import { sortByLang, langBadge } from "../../utils/contentLang.js";
import { isMobileNav } from "../../stores/uiStore.js";
import { storyErrKey, appendPage } from "../../utils/storyRules.js";
import { storyRank, storyFeatured } from "../../utils/story.js";
import { swr, cacheKey } from "../../utils/cache.js";
import { setStorySeed } from "../../utils/storySeed.js";

const PAGE = 12;
const router = useRouter();
const rows = ref([]);
const offset = ref(0);
const hasMore = ref(true);
const loading = ref(false);
const err = ref("");
const kw = ref("");
const featured = ref(null);

/* 轮 439：「本语言优先」是排序不是过滤（库里 99% 是中文，硬过滤会白屏）。
   轮 458（用户：「加载更多，排序出现问题了，不是直接出现在最下面」）：
   **排序只在每一页内部做，不能对累加后的整表重排。**
   旧写法把 sortByLang 放在 shown 里对 rows 全表重排 —— 点「加载更多」拿到第二页
   （库里实测 14 篇：首页 12 条里 6 中 6 英，第二页 2 条中文），整表一重排，
   这 2 篇新内容就被提到首页 6 篇英文上面去了，看起来像「插进中间」。
   现在按页排：第一页内部本语言在前，第二页整页接在它下面，翻页永远追加在末尾。 */
const byLang = (list) => sortByLang(list, (r) => r.lang);

const shown = computed(() => {
  const q = kw.value.trim().toLowerCase();
  /* 搜索态不重排也不过滤语言（找东西时要全部、要原始顺序）；
     浏览态直接给 rows —— 顺序已经在入列表时按「每页内本语言优先」定好了。 */
  if (!q) return rows.value;
  return rows.value.filter((r) =>
    String(r.title || "").toLowerCase().includes(q)
    || (Array.isArray(r.tags) ? r.tags : []).some((x) => String(x).toLowerCase().includes(q)));
});
/* 轮396：按钮是否还能翻页由「上一页是否满 12 条」决定，不再拿 rows 和 offset 硬算。
 * 旧算法在点击瞬间 offset 先 +12，rows 还没回来 → 按钮当场消失；若请求挂住/失败，
 * offset 已经前进、按钮也回不来，看起来就是「点了没反应」。 */
const more = computed(() => rows.value.length > 0 && hasMore.value);

/* 翻页请求兜底超时：断网/代理慢时 fetch 可能长时间不 reject，按钮会一直「加载中」。
 * 线上 /sb 代理实测冷启动可到 20s，取 20s，避免把本来会成功的最后 2 篇也掐掉。 */
function withTimeout(p, ms = 20000) {
  let timer = 0;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error("timeout");
      e.timeout = true;
      reject(e);
    }, ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

async function load({ append = false } = {}) {
  if (loading.value) return;
  loading.value = true;
  err.value = "";
  const first = !append;
  const pageOffset = first ? 0 : offset.value;
  /* 轮 158：首屏 SWR 本地直出——进故事联不再干等网络（故事流是公共内容，键不带用户域）；
   * 翻页照旧不缓存、拼尾。发布后父级调 load() 刷新：缓存先出、新内容由 fresh 纠正。 */
  await swr(
    first ? cacheKey("story:feed:latest") : null,
    {
      cached: (data) => {
        rows.value = appendPage([], data, byLang);
        offset.value = rows.value.length;
        hasMore.value = rows.value.length >= PAGE;
        err.value = "";
      },
      fresh: (data) => {
        /* 轮 458：排序落在「这一页入列表」这一步（页内排），页与页之间只追加 ——
           拼尾不动已有顺序，见 storyRules.appendPage 的头注释。 */
        const page = Array.isArray(data) ? data : [];
        rows.value = appendPage(first ? [] : rows.value, page, byLang);
        offset.value = first ? page.length : offset.value + page.length;
        hasMore.value = page.length >= PAGE;
        err.value = "";
      },
      onError: (e) => { err.value = t(storyErrKey(e || new Error("network"))); },
    },
    () => withTimeout(storyRank({ mode: "latest", limit: PAGE, offset: pageOffset })),
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
}
function loadMore() {
  if (loading.value || !hasMore.value) return;
  load({ append: true });
}
/* 轮 313：点卡片顺手把这一行当种子递给详情页 —— 列表行本来就带标题/作者/标签/字数/赞看数，
 * 详情页首帧就有内容，不再「点完先空半秒到几秒」。零额外请求。 */
function openStory(r) {
  if (!r || r.id == null) return;
  setStorySeed(r);
  router.push(`/story/${r.id}`);
}
const day = (s) => String(s || "").slice(0, 10);
load();
loadFeatured();
defineExpose({ load, loadFeatured });
</script>

<template>
  <section class="st-feed">
    <!-- 轮 149（用户截图定稿）：联内顶部两枚大钮 —— 排行榜 / 我的。
         轮 148 曾把联尾按钮整个撤掉（认为与底部 ＋ 和故事页重复），用户截图明确要这两枚，按截图恢复。 -->
    <nav v-if="isMobileNav" class="st-feed-nav">
      <button type="button" class="st-feed-navbtn" @click="router.push('/story/rank')">
        {{ t("story.tabRank") }}
      </button>
      <button type="button" class="st-feed-navbtn" @click="router.push('/story/mine')">
        {{ t("story.tabMine") }}
      </button>
    </nav>

    <header class="st-feed-head">
      <p class="st-sub">{{ t("story.discoverSub") }}</p>
      <input v-model="kw" class="st-search" type="search" :placeholder="t('story.searchPh')" />
    </header>

    <article
      v-if="featured" class="st-card st-card--featured" @click="openStory(featured)"
    >
      <p class="st-card-flag">★ {{ t("story.featuredBadge") }}</p>
      <h3 class="st-card-title">{{ featured.title }}</h3>
      <p class="st-card-meta">
        {{ t("story.by", { name: featured.nickname || t("story.anonAuthor") }) }}
        · {{ day(featured.published_at) }} · {{ t("story.readTime", { n: featured.read_minutes }) }}
      </p>
      <p class="st-card-tags">
        <span v-for="tg in (featured.tags || [])" :key="tg" class="st-tag-sm">#{{ tg }}</span>
      </p>
      <p class="st-card-stats">{{ t("story.stats", { likes: featured.like_count, views: featured.view_count }) }}</p>
    </article>

    <article v-for="r in shown" :key="r.id" class="st-card" @click="openStory(r)">
      <h3 class="st-card-title">{{ r.title }}</h3>
      <p class="st-card-meta">
        {{ t("story.by", { name: r.nickname || t("story.anonAuthor") }) }} · {{ day(r.published_at) }}
        · {{ t("story.readTime", { n: r.read_minutes }) }}<span v-if="langBadge(r.lang)" class="lang-tag">{{ langBadge(r.lang) }}</span>
      </p>
      <p class="st-card-tags">
        <span v-for="tg in (r.tags || [])" :key="tg" class="st-tag-sm">#{{ tg }}</span>
      </p>
      <p class="st-card-stats">{{ t("story.stats", { likes: r.like_count, views: r.view_count }) }}</p>
    </article>

    <!-- 轮 277（用户拍板）：首访骨架退役（与暖心墙/消息同口径：去展示留机制）——
         数据不变（缓存秒出、无缓存等网络回来直接出）。 -->
    <p v-if="!shown.length && !loading" class="st-hint">{{ t("story.rankEmpty") }}</p>
    <button v-if="more" class="st-btn st-btn--ghost" type="button" :disabled="loading" @click="loadMore">
      {{ loading ? t("story.loadingMore") : t("story.loadMore") }}
    </button>
    <p v-else-if="rows.length && !hasMore" class="st-hint">{{ t("story.noMore") }}</p>
    <p v-if="err" class="st-err">{{ err }}</p>
  </section>
</template>
