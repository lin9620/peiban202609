<!-- 轮 145 · 故事栏主页（/story）：一体双栏壳 —— 左栏三页签（投稿 | 发现 | 我的），右栏排行榜。
 * 桌面 = 单卡 + 内部分隔线（照私信页轮 142 的一体化惯例）；手机 = 上下堆叠（三页签仍在左栏顶部）。
 * 路由新增必须同步 vite.config.js 的 seoRoutes（否则线上真 404——轮 134 红线）。 -->
<script setup>
import { ref } from "vue";
import { useRouter } from "vue-router";
import { t } from "../i18n.js";
import StoryEditor from "../components/story/StoryEditor.vue";
import StoryFeed from "../components/story/StoryFeed.vue";
import StoryMine from "../components/story/StoryMine.vue";
import StoryRank from "../components/story/StoryRank.vue";

const router = useRouter();
const tab = ref("write");     /* write | discover | mine */
const editing = ref(null);    /* 我的 → 继续写：把草稿行交给编辑器 */

const tabs = [
  { key: "write", tk: "story.tabWrite" },
  { key: "discover", tk: "story.tabDiscover" },
  { key: "mine", tk: "story.tabMine" },
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
            v-for="x in tabs" :key="x.key" class="st-tab" :class="{ on: tab === x.key }"
            type="button" role="tab" :aria-selected="tab === x.key" @click="switchTab(x.key)">
            {{ t(x.tk) }}
          </button>
        </div>

        <StoryEditor
          v-if="tab === 'write'"
          :key="editing ? `edit-${editing.id}` : 'new'"
          :story="editing" @published="onPublished" />
        <StoryFeed v-else-if="tab === 'discover'" />
        <StoryMine v-else @edit="onEdit" />
      </section>

      <aside class="story-side"><StoryRank /></aside>
    </div>
  </div>
</template>
