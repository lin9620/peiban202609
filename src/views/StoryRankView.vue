<!-- 轮 148：从页签壳拆成独立页（/story/rank）。发现页顶部操作条进入。
 * 原来手机端它是第 4 页签、桌面是右栏（<1100px 被挤到主栏下方），现在统一成一个整屏页面。 -->
<script setup>
import { useRouter } from "vue-router";
import { t } from "../i18n.js";
import { useStoryBack } from "../utils/storyBack.js";
import StoryShell from "../components/story/StoryShell.vue";
import StoryRank from "../components/story/StoryRank.vue";

const router = useRouter();
const { storyBack } = useStoryBack(router);
</script>

<template>
  <StoryShell active="rank">
    <div class="story-page">
      <header class="story-head">
        <div class="story-head-row">
          <h1 class="story-title">{{ t("story.tabRank") }}</h1>
          <nav class="story-acts">
            <button class="st-btn st-btn--ghost st-btn--mark" type="button"
              @click="router.push('/story')">{{ t("story.tabDiscover") }}</button>
          </nav>
        </div>
        <p class="st-sub">{{ t("story.rankSub") }}</p>
      </header>

      <section class="story-main story-main--solo">
        <StoryRank />
      </section>
    </div>
  </StoryShell>
</template>