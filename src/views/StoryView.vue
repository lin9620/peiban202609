<!-- 轮 148 重做：/story = 纯阅读的「发现」页，不再是投稿|发现|我的 的页签壳。
 * 起因：用户从首页「故事」进来，看到的是一排页签 + 默认落点猜错，等于「进来不是我要的」。
 * 现在首页故事联、侧栏「故事栏」、深链 /story 三处落点统一 = 发现页（每日精选 + 最新流 + 搜索）。
 * 「写故事 / 我的 / 排行榜」不再是页签，改为顶部操作条三个入口，各走独立路由：
 *   /story/write（全屏写作）、/story/mine（草稿箱/书架/数据面板）、/story/rank（四榜）。
 *   轮 392：用户反馈桌面故事页找不到写作入口，顶部恢复「写故事」主按钮；
 *   手机端仍走底部 ＋ 第三瓣，避免与 StoryFeed 联内导航重复。
 * 新增路由必须同步 vite.config.js 的 seoRoutes（轮 134 红线：没有预渲染文件线上真 404）。 -->
<script setup>
import { onMounted, onBeforeUnmount } from "vue";
import { useRoute, useRouter } from "vue-router";
import { t } from "../i18n.js";
import { isMobileNav } from "../stores/uiStore.js";
import { restoreWhenTall } from "../utils/scrollMem.js";
import StoryShell from "../components/story/StoryShell.vue";
import StoryFeed from "../components/story/StoryFeed.vue";

const router = useRouter();
const route = useRoute();

/* 轮495：从具体故事返回本页时位置要还在（用户：「来回切，位置不变」）。
 * 本页不在 KeepAlive 名单里（每次进来都重新拉列表），所以不能用 restoreScroll 一刀切 ——
 * 挂载那一瞬文档还没长够，会被浏览器钳回顶部。restoreWhenTall 会等到列表长够再落位。
 * 用户一碰屏幕就取消，别跟人抢滚动。 */
let stopRestore = null;
onMounted(() => {
  stopRestore = restoreWhenTall(route.path);
  window.addEventListener("touchstart", cancelRestore, { passive: true });
  window.addEventListener("wheel", cancelRestore, { passive: true });
});
function cancelRestore() { if (stopRestore) { stopRestore(); stopRestore = null; } }
onBeforeUnmount(() => {
  cancelRestore();
  window.removeEventListener("touchstart", cancelRestore);
  window.removeEventListener("wheel", cancelRestore);
});
</script>

<template>
  <StoryShell active="story">
    <div class="story-page story-page--read">
      <!-- 手机端整块页头不渲染：顶部四联频道条里「故事」已经高亮，
           标题、写故事/排行榜/我的、副标题都会和联内重复。
           手机端只留 StoryFeed 里 discoverSub 一行；桌面端保留完整页头。 -->
      <header v-if="!isMobileNav" class="story-head">
        <div class="story-head-row">
          <h1 class="story-title">{{ t("story.title") }}</h1>
          <nav class="story-acts">
            <button class="st-btn st-btn--mark" type="button"
              @click="router.push('/story/write')">{{ t("story.writeStory") }}</button>
            <button class="st-btn st-btn--ghost st-btn--mark" type="button"
              @click="router.push('/story/rank')">{{ t("story.tabRank") }}</button>
            <button class="st-btn st-btn--ghost st-btn--mark" type="button"
              @click="router.push('/story/mine')">{{ t("story.tabMine") }}</button>
          </nav>
        </div>
        <p class="st-sub">{{ t("story.sub") }}</p>
      </header>

      <section class="story-main story-main--solo">
        <StoryFeed />
      </section>
    </div>
  </StoryShell>
</template>
