<!-- 轮 145 · 故事栏「发现」页签：每日精选卡 + 最新故事流 + 标题/标签搜索（本地过滤已载入的）+ 载入更多
 * 批 2：顶部每日精选（story_featured，无则整卡不渲染，不留空框）。 -->
<script setup>
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { t } from "../../i18n.js";
import { storyErrKey } from "../../utils/storyRules.js";
import { storyRank, storyFeatured } from "../../utils/story.js";

const PAGE = 12;
const router = useRouter();
const rows = ref([]);
const offset = ref(0);
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
const more = computed(() => rows.value.length >= offset.value + PAGE);

async function load() {
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
}
function loadMore() {
  offset.value += PAGE;
  load();
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
    <nav class="st-feed-nav">
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
      v-if="featured" class="st-card st-card--featured" @click="router.push(`/story/${featured.id}`)"
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

    <article v-for="r in shown" :key="r.id" class="st-card" @click="router.push(`/story/${r.id}`)">
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

    <p v-if="!shown.length && !loading" class="st-hint">{{ t("story.rankEmpty") }}</p>
    <button v-if="more" class="st-btn st-btn--ghost" type="button" :disabled="loading" @click="loadMore">
      {{ loading ? t("story.saving") : t("story.openStory") }}
    </button>
    <p v-if="err" class="st-err">{{ err }}</p>
  </section>
</template>
