<!-- 轮 145 · 故事栏「发现」页签：每日精选卡 + 最新故事流 + 标题/标签搜索（本地过滤已载入的）+ 载入更多
 * 批 2：顶部每日精选（story_featured，无则整卡不渲染，不留空框）。 -->
<script setup>
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { t } from "../../i18n.js";
import { isMobileNav } from "../../stores/uiStore.js";
import { storyErrKey } from "../../utils/storyRules.js";
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

const shown = computed(() => {
  const q = kw.value.trim().toLowerCase();
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
        const list = data || [];
        rows.value = list;
        offset.value = list.length;
        hasMore.value = list.length >= PAGE;
        err.value = "";
      },
      fresh: (data) => {
        const list = data || [];
        if (first) {
          rows.value = list;
          offset.value = list.length;
        } else {
          rows.value = rows.value.concat(list);
          offset.value += list.length;
        }
        hasMore.value = list.length >= PAGE;
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
    <p class="st-sub st-feed-sub">{{ t("story.feedSub") }}</p>

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
        · {{ t("story.readTime", { n: r.read_minutes }) }}
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
