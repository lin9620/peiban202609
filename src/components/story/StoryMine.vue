<!-- 轮 145 · 故事栏「我的」页签：草稿箱 / 已发布 两个小页签 + 数据面板（总获赞 / 总阅读）
 * 草稿 → 继续写（左栏内编辑）；已发布 → 阅读页。未登录时显示登录引导。 -->
<script setup>
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { t } from "../../i18n.js";
import { storyErrKey } from "../../utils/storyRules.js";
import { storyMine, canStory } from "../../utils/story.js";

const emit = defineEmits(["edit"]);
const router = useRouter();
const signedIn = computed(() => canStory());

const tab = ref("draft");
const drafts = ref([]);
const published = ref([]);
const loading = ref(false);
const err = ref("");

const rows = computed(() => (tab.value === "draft" ? drafts.value : published.value));
const totalLikes = computed(() => published.value.reduce((n, r) => n + (r.like_count || 0), 0));
const totalViews = computed(() => published.value.reduce((n, r) => n + (r.view_count || 0), 0));

async function load() {
  if (!signedIn.value) return;
  loading.value = true;
  err.value = "";
  try {
    const [d, p] = await Promise.all([storyMine("draft"), storyMine("published")]);
    drafts.value = d || [];
    published.value = p || [];
  } catch (e) {
    err.value = t(storyErrKey(e));
  } finally {
    loading.value = false;
  }
}
function openRow(r) {
  if (tab.value === "draft") emit("edit", r);
  else router.push(`/story/${r.id}`);
}
const day = (s) => String(s || "").slice(0, 10);
load();
defineExpose({ load });
</script>

<template>
  <section class="st-mine">
    <p v-if="!signedIn" class="st-hint">{{ t("story.loginNeeded") }}</p>

    <template v-else>
      <div class="st-stats">
        <span class="st-stat"><b>{{ published.length }}</b>{{ t("story.myPublished") }}</span>
        <span class="st-stat"><b>{{ totalLikes }}</b>♥</span>
        <span class="st-stat"><b>{{ totalViews }}</b>👀</span>
      </div>

      <div class="st-modes" role="tablist">
        <button class="st-mode" :class="{ on: tab === 'draft' }" type="button" role="tab"
          :aria-selected="tab === 'draft'" @click="tab = 'draft'">{{ t("story.myDrafts") }}</button>
        <button class="st-mode" :class="{ on: tab === 'published' }" type="button" role="tab"
          :aria-selected="tab === 'published'" @click="tab = 'published'">{{ t("story.myPublished") }}</button>
      </div>

      <ul class="st-mine-list">
        <li v-for="r in rows" :key="r.id" class="st-mine-row" @click="openRow(r)">
          <span class="st-badge" :class="{ 'st-badge--pub': r.status === 'published' }">
            {{ r.status === "published" ? t("story.badgePublished") : t("story.badgeDraft") }}
          </span>
          <span class="st-mine-body">
            <span class="st-mine-name">{{ r.title }}</span>
            <span class="st-hint">
              {{ day(r.updated_at) }} · {{ t("story.chars", { n: r.word_count }) }}
              <template v-if="r.status === 'published'"> · {{ t("story.stats", { likes: r.like_count, views: r.view_count }) }}</template>
            </span>
          </span>
          <span class="st-mine-go">{{ r.status === "published" ? t("story.openStory") : t("story.continueWrite") }}</span>
        </li>
        <li v-if="!rows.length && !loading" class="st-hint">{{ t("story.mineEmpty") }}</li>
      </ul>
      <p v-if="err" class="st-err">{{ err }}</p>
    </template>
  </section>
</template>
