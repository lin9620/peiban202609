<!-- 轮 148：从页签壳拆成独立页（/story/mine）。发现页顶部操作条进入。
 * 「继续写草稿」跳 /story/write?id=（全屏写作页本来就支持 ?id=），不再靠父子事件传行。 -->
<script setup>
import { useRouter } from "vue-router";
import { t } from "../i18n.js";
import StoryShell from "../components/story/StoryShell.vue";
import StoryMine from "../components/story/StoryMine.vue";

const router = useRouter();
function onEdit(row) {
  router.push(row && row.id ? `/story/write?id=${row.id}` : "/story/write");
}
</script>

<template>
  <StoryShell active="mine">
    <div class="story-page">
      <header class="story-head">
        <div class="story-head-row">
          <h1 class="story-title">{{ t("story.tabMine") }}</h1>
          <nav class="story-acts">
            <button class="st-btn st-btn--ghost st-btn--mark" type="button"
              @click="router.push('/story')">{{ t("story.tabDiscover") }}</button>
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