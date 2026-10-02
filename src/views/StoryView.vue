<!-- 轮 145 · 故事栏主页（/story）：一体双栏壳 —— 左栏三页签（投稿 | 发现 | 我的），右栏排行榜。
 * 桌面 = 单卡 + 内部分隔线（照私信页轮 142 的一体化惯例）；手机 = 上下堆叠（三页签仍在左栏顶部）。
 * 路由新增必须同步 vite.config.js 的 seoRoutes（否则线上真 404——轮 134 红线）。
 * 轮 148：① 默认页签改为「发现」（原来落在投稿，用户从首页/侧栏进来看到的是空白投稿框）；
 *   ② 手机端排行榜不再被挤到主栏下方（要滑到底才看见），改为第 4 个页签紧邻「我的」；
 *   桌面（≥1100px）仍是左内容右排行榜，页签里的「排行榜」不重复出现。 -->
<script setup>
import { ref } from "vue";
import { useRouter } from "vue-router";
import { t } from "../i18n.js";
import { isMobileNav } from "../stores/uiStore.js";
import StoryEditor from "../components/story/StoryEditor.vue";
import StoryFeed from "../components/story/StoryFeed.vue";
import StoryMine from "../components/story/StoryMine.vue";
import StoryRank from "../components/story/StoryRank.vue";

const router = useRouter();
const tab = ref("discover"); /* 默认「发现」：write | discover | mine | rank（rank 仅手机） */
const editing = ref(null);    /* 我的 → 继续写：把草稿行交给编辑器 */

/* 桌面排行榜在右栏（.story-side），页签里就不重复给一个；只有手机才把榜单收进页签 */
const showRankTab = isMobileNav;
const tabs = [
  { key: "write", tk: "story.tabWrite" },
  { key: "discover", tk: "story.tabDiscover" },
  { key: "mine", tk: "story.tabMine" },
  { key: "rank", tk: "story.tabRank", onlyMobile: true },
];
function onPublished(row) {
  router.push(row && row.id ? `/story/${row.id}` : "/story");
}
function onEdit(row) {
  editing.value = row;
  tab.value = "write";
}
function switchTab(k) {
  if (k === "write" && tab.value !== "write") editing.value = null;   /* 回到空编辑器 */
  tab.value = k;
}
/* 桌面不显示「排行榜」页签（右栏已有），且若已停在 rank 又转宽屏，要回落到「发现」，
   否则主栏和右栏会同时渲染两份榜单。 */
const visibleTabs = () => (showRankTab.value ? tabs : tabs.filter((x) => !x.onlyMobile));
if (!showRankTab.value && tab.value === "rank") tab.value = "discover";
</script>

<template>
  <div class="story-page">
    <header class="story-head">
      <h1 class="story-title">{{ t("story.title") }}</h1>
      <p class="st-sub">{{ t("story.sub") }}</p>
    </header>

    <div class="story-wrap">
      <section class="story-main">
        <div class="st-tabs" role="tablist">
          <button
            v-for="x in visibleTabs()" :key="x.key" class="st-tab" :class="{ on: tab === x.key }"
            type="button" role="tab" :aria-selected="tab === x.key" @click="switchTab(x.key)">
            {{ t(x.tk) }}
          </button>
        </div>

        <StoryEditor
          v-if="tab === 'write'"
          :key="editing ? `edit-${editing.id}` : 'new'"
          :story="editing" @published="onPublished" />
        <StoryFeed v-else-if="tab === 'discover'" />
        <StoryMine v-else-if="tab === 'mine'" @edit="onEdit" />
        <StoryRank v-else-if="tab === 'rank'" />
      </section>

      <!-- 桌面右栏；手机端榜单已进页签，这里不再重复渲染 -->
      <aside v-if="!showRankTab" class="story-side"><StoryRank /></aside>
    </div>
  </div>
</template>
