<!-- 轮 148 重做：/story = 纯阅读的「发现」页，不再是投稿|发现|我的 的页签壳。
 * 起因：用户从首页「故事」进来，看到的是一排页签 + 默认落点猜错，等于「进来不是我要的」。
 * 现在首页故事联、侧栏「故事栏」、深链 /story 三处落点统一 = 发现页（每日精选 + 最新流 + 搜索）。
 * 「投稿 / 我的 / 排行榜」不再是页签，改为顶部操作条三个入口，各走独立路由：
 *   /story/write（全屏写作）、/story/mine（草稿箱/书架/数据面板）、/story/rank（四榜）。
 * 新增路由必须同步 vite.config.js 的 seoRoutes（轮 134 红线：没有预渲染文件线上真 404）。 -->
<script setup>
import { useRouter } from "vue-router";
import { t } from "../i18n.js";
import { isMobileNav } from "../stores/uiStore.js";
import StoryShell from "../components/story/StoryShell.vue";
import StoryFeed from "../components/story/StoryFeed.vue";

const router = useRouter();
</script>

<template>
  <StoryShell active="story">
    <div class="story-page story-page--read">
      <header class="story-head">
        <div class="story-head-row">
          <!-- 手机端不显示「故事栏」大标题：顶部四联频道条里「故事」已经高亮，
               再来一个 26px 标题是重复信息（用户要求去掉）。桌面端保留。 -->
          <h1 v-if="!isMobileNav" class="story-title">{{ t("story.title") }}</h1>
          <nav class="story-acts">
            <!-- 轮 148：投稿入口搬到底部 ＋ 第三瓣，纯阅读页里不再放发布按钮 -->
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
