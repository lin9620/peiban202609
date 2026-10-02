<!-- 轮 145 · 故事阅读页（/story/:id）：轻 Markdown 排版 + 点赞（服务端权威）+ 标签 / 相似推荐。
 * Worker 侧 /story/:id 深链会先查存在性（查无维持真 404，软 404 红线），此处只处理「载入后已下架」。 -->
<script setup>
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { t } from "../i18n.js";
import { renderLiteMd } from "../utils/storyRules.js";
import {
  storyGet, storyToggleLike, storyAddView, storyRank, canStory, storyErrKey, storyToggleBookmark,
} from "../utils/story.js";
import StoryComments from "../components/story/StoryComments.vue";

const route = useRoute();
const router = useRouter();
const row = ref(null);
const loading = ref(true);
const liking = ref(false);
const marking = ref(false);
const err = ref("");
const related = ref([]);

const signedIn = computed(() => canStory());
const html = computed(() => renderLiteMd(row.value ? row.value.body : ""));
const day = (s) => String(s || "").slice(0, 10);
const author = computed(() => (row.value && row.value.nickname) || t("story.anonAuthor"));

async function loadRelated() {
  related.value = [];
  const tag = row.value && Array.isArray(row.value.tags) ? row.value.tags[0] : "";
  if (!tag) return;
  try {
    const data = await storyRank({ mode: "monthly", tag, limit: 4 });
    related.value = (data || []).filter((r) => r.id !== row.value.id).slice(0, 3);
  } catch (e) { /* 推荐失败不影响阅读 */ }
}

async function load() {
  loading.value = true;
  err.value = "";
  try {
    const id = Number(route.params.id);
    row.value = await storyGet(id);
    if (row.value) {
      loadRelated();
      storyAddView(id).catch(() => {});     /* 浏览计数失败无声（不打扰阅读） */
    }
  } catch (e) {
    err.value = t(storyErrKey(e));
    row.value = null;
  } finally {
    loading.value = false;
  }
}

async function like() {
  if (!signedIn.value || !row.value || liking.value) return;
  liking.value = true;
  try {
    const on = await storyToggleLike(row.value.id);
    row.value.liked = !!on;
    row.value.like_count = Math.max(0, (row.value.like_count || 0) + (on ? 1 : -1));
  } catch (e) {
    err.value = t(storyErrKey(e));
  } finally {
    liking.value = false;
  }
}

/** 收藏/取消：服务端权威（主键防重），本地只翻转那颗星 */
async function mark() {
  if (!signedIn.value || !row.value || marking.value) return;
  marking.value = true;
  try {
    row.value.marked = !!(await storyToggleBookmark(row.value.id));
  } catch (e) {
    err.value = t(storyErrKey(e));
  } finally {
    marking.value = false;
  }
}

onMounted(load);
watch(() => route.params.id, load);
</script>

<template>
  <div class="story-read">
    <button class="st-link" type="button" @click="router.push('/story')">← {{ t("story.backToHall") }}</button>

    <article v-if="row" class="st-read-card">
      <h1 class="st-read-title">{{ row.title }}</h1>
      <p class="st-read-meta">
        {{ t("story.by", { name: author }) }} · {{ day(row.published_at) }}
        · {{ t("story.readTime", { n: row.read_minutes }) }} · {{ t("story.chars", { n: row.word_count }) }}
      </p>
      <p class="st-card-tags">
        <span v-for="tg in (row.tags || [])" :key="tg" class="st-tag-sm">#{{ tg }}</span>
      </p>

      <div class="st-read-body" v-html="html"></div>
      <p v-if="!String(row.body || '').trim()" class="st-hint">{{ t("story.emptyBody") }}</p>

      <footer class="st-read-foot">
        <button class="st-btn" :class="{ 'st-btn--on': row.liked }" type="button" :disabled="liking || !signedIn" @click="like">
          ♥ {{ row.liked ? t("story.liked") : t("story.like") }} {{ row.like_count }}
        </button>
        <button
          class="st-btn st-btn--mark" :class="{ 'st-btn--on': row.marked }" type="button"
          :disabled="marking || !signedIn" @click="mark"
        >★ {{ row.marked ? t("story.marked") : t("story.mark") }}</button>
        <span class="st-hint">{{ t("story.stats", { likes: row.like_count, views: row.view_count }) }}</span>
      </footer>
      <p v-if="!signedIn" class="st-hint">{{ t("story.loginNeeded") }}</p>

      <StoryComments v-if="row.status === 'published'" :story-id="row.id" />
    </article>

    <p v-else-if="!loading" class="st-hint">{{ t("story.notFound") }}</p>

    <section v-if="related.length" class="st-related">
      <h2 class="st-rank-title">{{ t("story.related") }}</h2>
      <ul class="st-rank-list">
        <li v-for="r in related" :key="r.id" class="st-rank-row" @click="router.push(`/story/${r.id}`)">
          <span class="st-rank-body">
            <span class="st-rank-name">{{ r.title }}</span>
            <span class="st-rank-meta">{{ t("story.by", { name: r.nickname || t("story.anonAuthor") }) }}</span>
          </span>
          <span class="st-rank-like">♥ {{ r.like_count }}</span>
        </li>
      </ul>
    </section>

    <p v-if="err" class="st-err">{{ err }}</p>
  </div>
</template>
