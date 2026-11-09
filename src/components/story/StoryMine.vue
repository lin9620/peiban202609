<!-- 轮 145 · 故事栏「我的」页签：草稿箱 / 已发布 / 书架 三个小页签 + 数据面板
 * 批 2：数据面板改走服务端 story_my_stats（篇数/获赞/阅读/评论/收藏 + 最高赞一篇，口径统一）；
 *      书架走 story_bookmark_list。未登录时显示登录引导。 -->
<script setup>
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { useDialog } from "naive-ui";
import { t } from "../../i18n.js";
import { storyErrKey } from "../../utils/storyRules.js";
import {
  storyMine, storyBookmarkList, storyMyStats, storyDeleteDraft, storyDeletePublished,
  storySetBookmark, loadLocalDraft, clearLocalDraft, canStory,
} from "../../utils/story.js";
import { setStorySeed } from "../../utils/storySeed.js";

const emit = defineEmits(["edit"]);
const router = useRouter();
const dialog = useDialog();
const signedIn = computed(() => canStory());

const tab = ref("draft");
const drafts = ref([]);
const published = ref([]);
const shelf = ref([]);
const stats = ref(null);
const loading = ref(false);
const err = ref("");
const deleting = ref(null);
const unbookmarking = ref(null);

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
  if (tab.value === "draft") { emit("edit", r); return; }
  if (!r || r.id == null) return;
  setStorySeed(r);   /* 轮 313：已发布/书架行也带标题 → 详情页首帧就有内容 */
  router.push(`/story/${r.id}`);
}
/** 删草稿：只对草稿行显示按钮；先走主题弹窗确认，再乐观移除，失败放回并提示。 */
function removeDraft(r) {
  if (!r || r.id == null || deleting.value != null) return;
  dialog.warning({
    title: t("story.deleteDraft"),
    content: t("story.deleteDraftConfirm"),
    positiveText: t("common.delete"),
    negativeText: t("common.cancel"),
    positiveButtonProps: { type: "error" },
    onPositiveClick: () => doRemoveDraft(r),
  });
}
async function doRemoveDraft(r) {
  const id = r.id;
  const prevDrafts = drafts.value;
  const prevStats = stats.value;
  deleting.value = id;
  err.value = "";
  drafts.value = drafts.value.filter((x) => x.id !== id);
  if (stats.value) {
    stats.value = {
      ...stats.value,
      draft_count: Math.max(0, Number(stats.value.draft_count || 0) - 1),
    };
  }
  try {
    await storyDeleteDraft(id);
    /* 本地兜底草稿若指向刚删的这篇，一并清掉，避免下次打开又“复活” */
    const local = loadLocalDraft();
    if (local && Number(local.id) === Number(id)) clearLocalDraft();
  } catch (e) {
    drafts.value = prevDrafts;
    stats.value = prevStats;
    err.value = t(storyErrKey(e));
  } finally {
    deleting.value = null;
  }
}
/** 删已发布：同样先确认，再乐观移除；成功后轻量刷新数据面板（最高赞那篇可能被删）。 */
function removePublished(r) {
  if (!r || r.id == null || deleting.value != null) return;
  dialog.warning({
    title: t("story.deleteStory"),
    content: t("story.deleteStoryConfirm"),
    positiveText: t("common.delete"),
    negativeText: t("common.cancel"),
    positiveButtonProps: { type: "error" },
    onPositiveClick: () => doRemovePublished(r),
  });
}
async function doRemovePublished(r) {
  const id = r.id;
  const prevPublished = published.value;
  const prevStats = stats.value;
  deleting.value = id;
  err.value = "";
  published.value = published.value.filter((x) => x.id !== id);
  if (stats.value) {
    stats.value = {
      ...stats.value,
      published_count: Math.max(0, Number(stats.value.published_count || 0) - 1),
      total_likes: Math.max(0, Number(stats.value.total_likes || 0) - Number(r.like_count || 0)),
      total_views: Math.max(0, Number(stats.value.total_views || 0) - Number(r.view_count || 0)),
      total_comments: Math.max(0, Number(stats.value.total_comments || 0) - Number(r.comment_count || 0)),
    };
  }
  try {
    await storyDeletePublished(id);
  } catch (e) {
    published.value = prevPublished;
    stats.value = prevStats;
    err.value = t(storyErrKey(e));
    return;
  } finally {
    deleting.value = null;
  }
  /* 删除已成功；面板刷新失败不能把行放回来（否则会出现「删了又出现」）。 */
  const st = await storyMyStats().catch(() => null);
  if (st) stats.value = st;
}
/** 书架取消收藏：不弹窗（可再收藏回来），乐观移除，失败放回。 */
async function removeShelf(r) {
  if (!r || r.id == null || unbookmarking.value != null) return;
  const id = r.id;
  const prevShelf = shelf.value;
  const prevStats = stats.value;
  unbookmarking.value = id;
  err.value = "";
  shelf.value = shelf.value.filter((x) => x.id !== id);
  if (stats.value) {
    stats.value = {
      ...stats.value,
      bookmark_count: Math.max(0, Number(stats.value.bookmark_count || 0) - 1),
    };
  }
  try {
    await storySetBookmark(id, false);
  } catch (e) {
    shelf.value = prevShelf;
    stats.value = prevStats;
    err.value = t(storyErrKey(e));
  } finally {
    unbookmarking.value = null;
  }
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
          <span v-if="tab === 'draft'" class="st-mine-go">{{ t("story.continueWrite") }}</span>
          <!-- 已发布 / 书架：把原来的「阅读」位置换成删除 / 取消收藏；点按钮不冒泡到整行阅读。 -->
          <button
            v-else-if="tab === 'published'" class="st-btn st-btn--ghost st-btn--mark st-mine-del st-mine-act"
            type="button" :disabled="deleting === r.id" :title="t('story.deleteStoryConfirm')"
            @click.stop="removePublished(r)">{{ t("story.deleteStory") }}</button>
          <button
            v-else class="st-btn st-btn--ghost st-btn--mark st-mine-act" type="button"
            :disabled="unbookmarking === r.id" :title="t('story.unbookmark')"
            @click.stop="removeShelf(r)">{{ t("story.unbookmark") }}</button>
          <!-- 轮 391：草稿行补删除入口；点按钮不冒泡到整行的“继续写”。 -->
          <button
            v-if="tab === 'draft'" class="st-btn st-btn--ghost st-btn--mark st-mine-del st-mine-act" type="button"
            :disabled="deleting === r.id" :title="t('story.deleteDraftConfirm')"
            @click.stop="removeDraft(r)">{{ t("story.deleteDraft") }}</button>
          <!-- 轮 150：已发布的故事也要能改。服务端 story_publish 的 else 分支本来就允许改已发布的
               （status <> 'removed'，且 published_at 用 coalesce 保住原发布时间），这里只补 UI 入口。
               草稿行点整行就已进编辑器，所以只给它挂“删除”，不再重复挂“修改”。 -->
          <button
            v-if="tab === 'published'" class="st-btn st-btn--ghost st-btn--mark st-mine-act" type="button"
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
