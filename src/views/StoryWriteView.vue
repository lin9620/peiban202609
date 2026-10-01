<!-- 轮 145 · 全屏写作（/story/write，可带 ?id= 续写草稿）——3 万字要整屏，双栏里放不下。
 * 编辑器与「投稿」页签同一个组件（StoryEditor，full 形态只影响高度与工具条）。 -->
<script setup>
import { onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { t } from "../i18n.js";
import StoryEditor from "../components/story/StoryEditor.vue";
import { storyGet } from "../utils/story.js";

const route = useRoute();
const router = useRouter();
const loaded = ref(false);
const row = ref(null);

onMounted(async () => {
  const id = Number(route.query.id || 0);
  if (id > 0) {
    try { row.value = await storyGet(id); }
    catch (e) { row.value = null; }      /* 取不到就当新稿写，不拦人 */
  }
  loaded.value = true;
});

function onPublished(r) {
  router.push(r && r.id ? `/story/${r.id}` : "/story");
}
</script>

<template>
  <div class="story-write">
    <header class="story-write-head">
      <button class="st-link" type="button" @click="router.push('/story')">
        ← {{ t("story.backToHall") }}
      </button>
    </header>
    <StoryEditor v-if="loaded" :story="row" full @published="onPublished" />
  </div>
</template>
