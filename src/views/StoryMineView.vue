<!-- 轮 148：从页签壳拆成独立页（/story/mine）。发现页顶部操作条进入。
 * 「继续写草稿」跳 /story/write?id=（全屏写作页本来就支持 ?id=），不再靠父子事件传行。 -->
<script setup>
import { useRouter } from "vue-router";
import { t } from "../i18n.js";
import { isMobileNav } from "../stores/uiStore.js";
import { useStoryBack } from "../utils/storyBack.js";
import StoryShell from "../components/story/StoryShell.vue";
import StoryMine from "../components/story/StoryMine.vue";

const router = useRouter();
function onEdit(row) {
  router.push(row && row.id ? `/story/write?id=${row.id}` : "/story/write");
}
/* 物理返回键接管：见 utils/storyBack.js 的注释（否则会退回首页今日/漂流瓶联） */
const { storyBack } = useStoryBack(router);
</script>

<template>
  <StoryShell active="mine">
    <div class="story-page">
      <header class="story-head">
        <div class="story-head-row">
          <h1 class="story-title">{{ t("story.tabMine") }}</h1>
          <!-- 轮 153（用户要求）：App/窄屏去掉「发现」按钮 —— 顶部四联频道条里的「故事」已高亮，
               点它即可回发现页（StoryShell.go("story")），物理返回键也回 /story，不会困死。
               桌面端保持原样。注意 storyBack 仍是必留的：它同时是物理返回键的接管入口
               （useStoryBack，见 utils/storyBack.js），按钮只是它的桌面端出口。 -->
          <nav v-if="!isMobileNav" class="story-acts">
            <button class="st-btn st-btn--ghost st-btn--mark" type="button"
              @click="storyBack">{{ t("story.tabDiscover") }}</button>
          </nav>
        </div>
        <p class="st-sub">{{ t("story.mineSub") }}</p>
      </header>

      <section class="story-main story-main--solo">
        <StoryMine @edit="onEdit" />
      </section>
    </div>
  </StoryShell>
</template>