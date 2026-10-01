<!-- 轮 145 · 故事栏「发现」页签：最新故事流 + 标题/标签搜索（本地过滤已载入的）+ 载入更多 -->
<script setup>
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { t } from "../../i18n.js";
import { storyErrKey } from "../../utils/storyRules.js";
import { storyRank } from "../../utils/story.js";

const PAGE = 12;
const router = useRouter();
const rows = ref([]);
const offset = ref(0);
const loading = ref(false);
const err = ref("");
const kw = ref("");

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
function loadMore() {
  offset.value += PAGE;
  load();
}
const day = (s) => String(s || "").slice(0, 10);
load();
</script>

<template>
  <section class="st-feed">
    <header class="st-feed-head">
      <p class="st-sub">{{ t("story.discoverSub") }}</p>
      <input v-model="kw" class="st-search" type="search" :placeholder="t('story.searchPh')" />
    </header>

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
