<!-- 轮 145 · 故事栏「我的」页签：草稿箱 / 已发布 / 书架 三个小页签 + 数据面板
 * 批 2：数据面板改走服务端 story_my_stats（篇数/获赞/阅读/评论/收藏 + 最高赞一篇，口径统一）；
 *      书架走 story_bookmark_list。未登录时显示登录引导。 -->
<script setup>
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { t } from "../../i18n.js";
import { storyErrKey } from "../../utils/storyRules.js";
import { storyMine, storyBookmarkList, storyMyStats, canStory } from "../../utils/story.js";

const emit = defineEmits(["edit"]);
const router = useRouter();
const signedIn = computed(() => canStory());

const tab = ref("draft");
const drafts = ref([]);
const published = ref([]);
const shelf = ref([]);
const stats = ref(null);
const loading = ref(false);
const err = ref("");

const rows = computed(() => {
  if (tab.value === "draft") return drafts.value;
  if (tab.value === "published") return published.value;
  return shelf.value;
});
/** 面板数字优先用服务端汇总；未加载出来时退回本地求和（首帧不空） */
const panel = computed(() => ({
  pub: stats.value ? Number(stats.value.published_count || 0) : published.value.length,
  draft: stats.value ? Number(stats.value.draft_count || 0) : drafts.value.length,
  likes: stats.value ? Number(stats.value.total_likes || 0)
    : published.value.reduce((n, r) => n + (r.like_count || 0), 0),
  views: stats.value ? Number(stats.value.total_views || 0)
    : published.value.reduce((n, r) => n + (r.view_count || 0), 0),
  comments: stats.value ? Number(stats.value.total_comments || 0) : 0,
  saved: stats.value ? Number(stats.value.bookmark_count || 0) : shelf.value.length,
  bestTitle: stats.value ? stats.value.best_title : "",
  bestLikes: stats.value ? Number(stats.value.best_likes || 0) : 0,
}));

async function load() {
  if (!signedIn.value) return;
  loading.value = true;
  err.value = "";
  try {
    const [d, p, sh, st] = await Promise.all([
      storyMine("draft"), storyMine("published"), storyBookmarkList(50, 0), storyMyStats(),
    ]);
    drafts.value = d || [];
    published.value = p || [];
    shelf.value = sh || [];
    stats.value = st || null;
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
const saved = (s) => day(s);
load();
defineExpose({ load });
</script>

<template>
  <section class="st-mine">
    <p v-if="!signedIn" class="st-hint">{{ t("story.loginNeeded") }}</p>

    <template v-else>
      <div class="st-stats">
        <span class="st-stat"><b>{{ panel.pub }}</b>{{ t("story.myPublished") }}</span>
        <span class="st-stat"><b>{{ panel.likes }}</b>♥</span>
        <span class="st-stat"><b>{{ panel.views }}</b>👀</span>
        <span class="st-stat"><b>{{ panel.comments }}</b>💬</span>
        <span class="st-stat"><b>{{ panel.saved }}</b>★</span>
      </div>
      <p v-if="panel.bestTitle" class="st-hint st-mine-best">
        {{ t("story.myBest", { title: panel.bestTitle, n: panel.bestLikes }) }}
      </p>

      <div class="st-modes" role="tablist">
        <button class="st-mode" :class="{ on: tab === 'draft' }" type="button" role="tab"
          :aria-selected="tab === 'draft'" @click="tab = 'draft'">
          {{ t("story.myDrafts") }}<template v-if="panel.draft"> · {{ panel.draft }}</template>
        </button>
        <button class="st-mode" :class="{ on: tab === 'published' }" type="button" role="tab"
          :aria-selected="tab === 'published'" @click="tab = 'published'">{{ t("story.myPublished") }}</button>
        <button class="st-mode" :class="{ on: tab === 'shelf' }" type="button" role="tab"
          :aria-selected="tab === 'shelf'" @click="tab = 'shelf'">{{ t("story.myShelf") }}</button>
      </div>

      <ul class="st-mine-list">
        <li v-for="r in rows" :key="r.id" class="st-mine-row" @click="openRow(r)">
          <span v-if="tab !== 'draft'" class="st-badge st-badge--pub">★</span>
          <span v-else class="st-badge" :class="{ 'st-badge--pub': r.status === 'published' }">
            {{ r.status === "published" ? t("story.badgePublished") : t("story.badgeDraft") }}
          </span>
          <span class="st-mine-body">
            <span class="st-mine-name">{{ r.title }}</span>
            <span class="st-hint">
              <template v-if="tab === 'shelf'">
                {{ t("story.shelfSavedAt", { d: saved(r.saved_at) }) }} · {{ t("story.stats", { likes: r.like_count, views: r.view_count }) }}
              </template>
              <template v-else>
                {{ day(r.updated_at) }} · {{ t("story.chars", { n: r.word_count }) }}
                <template v-if="r.status === 'published'"> · {{ t("story.stats", { likes: r.like_count, views: r.view_count }) }}</template>
              </template>
            </span>
          </span>
          <span class="st-mine-go">{{ r.status === "published" || tab === 'shelf' ? t("story.openStory") : t("story.continueWrite") }}</span>
          <!-- 轮 150：已发布的故事也要能改。服务端 story_publish 的 else 分支本来就允许改已发布的
               （status <> 'removed'，且 published_at 用 coalesce 保住原发布时间），这里只补 UI 入口。
               只给已发布行挂按钮：草稿行点整行就已进编辑器，再挂一个是重复入口。 -->
          <button
            v-if="tab === 'published'" class="st-btn st-btn--ghost st-btn--mark" type="button"
            @click.stop="emit('edit', r)">{{ t("story.editStory") }}</button>
        </li>
        <li v-if="!rows.length && !loading" class="st-hint">
          {{ tab === "shelf" ? t("story.shelfEmpty") : t("story.mineEmpty") }}
        </li>
      </ul>
      <p v-if="err" class="st-err">{{ err }}</p>
    </template>
  </section>
</template>
