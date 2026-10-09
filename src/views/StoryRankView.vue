<!-- 轮 148：从页签壳拆成独立页（/story/rank）。发现页顶部操作条进入。
 * 原来手机端它是第 4 页签、桌面是右栏（<1100px 被挤到主栏下方），现在统一成一个整屏页面。 -->
<script setup>
import { useRouter } from "vue-router";
import { t } from "../i18n.js";
import { isMobileNav } from "../stores/uiStore.js";
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
          <!-- 轮 153（用户要求）：App/窄屏去掉「发现」按钮 —— 顶部四联频道条里的「故事」已高亮，
               点它即可回发现页（StoryShell.go("story")），物理返回键也回 /story，不会困死。
               桌面端保持原样（有鼠标时这枚按钮是明确的返回落点）。 -->
          <nav v-if="!isMobileNav" class="story-acts">
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