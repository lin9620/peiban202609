<!-- 轮 145 · 故事编辑器（故事栏「投稿」页签 + /story/write 全屏写作 共用）
 * 标题 + 正文（≤3 万字实时计数/阅读时长）+ 标签 chips（1~3 个）+ 写/预览（轻 Markdown）
 * 停手 3 秒自动存草稿：本地存档在前（断网/崩溃保险），云端 draft 在后（登录才有）。
 * 样式统一放 style.css 的「故事栏」段（单一来源，避免同权重双源互相压制）。 -->
<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { t } from "../../i18n.js";
import {
  BODY_MAX, BODY_MIN, TITLE_MAX, TAGS_MAX, TAG_MAX, PRESET_TAGS,
  countChars, readMinutes, normalizeTags, canStory, storyErrKey,
  saveLocalDraft, loadLocalDraft, clearLocalDraft, storySaveDraft, storyPublish,
} from "../../utils/story.js";
import { renderLiteMd } from "../../utils/storyRules.js";

const props = defineProps({
  full: { type: Boolean, default: false },    /* /story/write 全屏形态 */
  story: { type: Object, default: null },     /* 续写：草稿 / 已发布行 */
});
const emit = defineEmits(["published"]);

const router = useRouter();
const signedIn = computed(() => canStory());

const title = ref("");
const body = ref("");
const tags = ref([]);
const tagInput = ref("");
const mode = ref("write");        /* write | preview */
const draftId = ref(null);
const draftStatus = ref("draft"); /* 载入行是不是草稿（已发布行不再自动存草稿） */
const saving = ref(false);
const publishing = ref(false);
const savedAt = ref("");
const restored = ref(false);
const err = ref("");

const chars = computed(() => countChars(body.value));
const minutes = computed(() => readMinutes(body.value));
const over = computed(() => chars.value > BODY_MAX);
const shortOf = computed(() => Math.max(0, BODY_MIN - chars.value));   /* 还差几字 */
const titleLeft = computed(() => TITLE_MAX - countChars(title.value));
const previewHtml = computed(() => renderLiteMd(body.value));
const canPublish = computed(() => signedIn.value && !!title.value.trim()
  && chars.value >= BODY_MIN && !over.value && tags.value.length > 0 && !publishing.value);

/* 禁用原因清单：灰按钮必须能说清「还差什么」。
   原来只给第一条（whyDisabled 单串），用户补完第一条后又灰一次、提示却换了内容，
   像是坏了 —— 一次性列全更省事。全满足时给一句确认，让用户敢按。 */
const blockers = computed(() => {
  const list = [];
  if (!signedIn.value) list.push(t("story.needLogin"));
  if (!title.value.trim()) list.push(t("story.needTitle"));
  if (chars.value <= 0) list.push(t("story.needBody"));
  else if (shortOf.value > 0) list.push(t("story.needMore", { n: shortOf.value }));
  if (over.value) list.push(t("story.tooLong"));
  if (!tags.value.length) list.push(t("story.needTag"));
  return list;
});
const whyDisabled = computed(() => {
  if (publishing.value) return t("story.publishing2");
  return blockers.value[0] || "";
});
/* 只提示「本次编辑会话里刚被卡住的原因」，别一进页面就甩一屏未登录+缺标题 */
const touched = ref(false);
watch([title, body, tags], () => { touched.value = true; }, { deep: true });
const showWhy = computed(() => !publishing.value && (touched.value || err.value));

const snapshot = () => ({
  id: draftId.value,
  title: title.value.trim(),
  body: body.value,
  tags: tags.value.slice(),
});
const nowLabel = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/* 停手 3 秒自动存：本地恒存；云端只在草稿阶段存（published 行要走发布 RPC 才动） */
let timer = 0;
async function autosave() {
  const snap = snapshot();
  saveLocalDraft(snap);
  if (!signedIn.value) return;
  if (!draftId.value && !snap.title && !snap.body) return;   /* 全空不建云端行 */
  if (draftId.value && draftStatus.value !== "draft") return;
  saving.value = true;
  try {
    const row = await storySaveDraft(snap);
    const r = Array.isArray(row) ? row[0] : row;
    if (r && r.id) { draftId.value = r.id; draftStatus.value = "draft"; }
    savedAt.value = nowLabel();
  } catch (e) {
    /* 自动存失败不打扰：本地已存，正式提交时再报错 */
  } finally {
    saving.value = false;
  }
}

watch([title, body, tags], () => {
  err.value = "";
  clearTimeout(timer);
  timer = setTimeout(autosave, 3000);
}, { deep: true });

function addTag() {
  const v = tagInput.value.trim();
  tagInput.value = "";
  if (!v) return;
  tags.value = normalizeTags([...tags.value, v]);
}
function removeTag(i) {
  tags.value = tags.value.filter((_, k) => k !== i);
}
function onTagKey(e) {
  if (e.key === "Enter" || e.key === "," || e.key === "，") { e.preventDefault(); addTag(); }
  else if (e.key === "Backspace" && !tagInput.value && tags.value.length) removeTag(tags.value.length - 1);
}

/* 点预设标签：一键加入；已加/满 3 个则禁用，不做静默失败 */
function pickPreset(tag) {
  if (tags.value.length >= TAGS_MAX) return;
  const norm = normalizeTags([tag])[0];
  if (!norm || tags.value.includes(norm)) return;
  tags.value = normalizeTags([...tags.value, norm]);
}
const hasTag = (tag) => tags.value.includes(normalizeTags([tag])[0] || tag);

async function publish() {
  err.value = "";
  if (!signedIn.value) { err.value = t("story.errAuth"); return; }
  publishing.value = true;
  try {
    const row = await storyPublish(snapshot());
    const r = Array.isArray(row) ? row[0] : row;
    clearLocalDraft();
    title.value = ""; body.value = ""; tags.value = []; draftId.value = null;
    draftStatus.value = "draft"; savedAt.value = "";
    emit("published", r);
  } catch (e) {
    err.value = t(storyErrKey(e));
  } finally {
    publishing.value = false;
  }
}

function toFullscreen() {
  const url = draftId.value ? `/story/write?id=${draftId.value}` : "/story/write";
  router.push(url);
}

onMounted(() => {
  if (props.story) {
    title.value = props.story.title || "";
    body.value = props.story.body || "";
    tags.value = Array.isArray(props.story.tags) ? props.story.tags.slice(0, TAGS_MAX) : [];
    draftId.value = props.story.id || null;
    draftStatus.value = props.story.status === "published" ? "published" : "draft";
    return;
  }
  const local = loadLocalDraft();
  if (local && (local.title || local.body)) {
    title.value = local.title || "";
    body.value = local.body || "";
    tags.value = Array.isArray(local.tags) ? local.tags.slice(0, TAGS_MAX) : [];
    draftId.value = local.id || null;
    restored.value = true;
  }
});

onBeforeUnmount(() => {
  clearTimeout(timer);
  if (title.value.trim() || body.value) saveLocalDraft(snapshot());
});
</script>

<template>
  <section class="st-editor" :class="{ 'st-editor--full': full }">
    <header class="st-ed-head">
      <h2 class="st-ed-title">{{ t("story.tabWrite") }}</h2>
      <span v-if="restored" class="st-badge">{{ t("story.badgeDraft") }}</span>
      <span class="st-spring"></span>
      <button v-if="!full" class="st-link" type="button" @click="toFullscreen">{{ t("story.fullscreen") }}</button>
    </header>

    <input
      v-model="title" class="st-title-in" type="text" :maxlength="TITLE_MAX"
      :placeholder="t('story.titlePh')" :aria-label="t('story.titlePh')" />
    <p v-if="titleLeft < 20" class="st-hint">{{ TITLE_MAX - titleLeft }} / {{ TITLE_MAX }}</p>

    <div class="st-modes" role="tablist">
      <button class="st-mode" :class="{ on: mode === 'write' }" type="button" role="tab"
        :aria-selected="mode === 'write'" @click="mode = 'write'">{{ t("story.modeWrite") }}</button>
      <button class="st-mode" :class="{ on: mode === 'preview' }" type="button" role="tab"
        :aria-selected="mode === 'preview'" @click="mode = 'preview'">{{ t("story.modePreview") }}</button>
    </div>

    <textarea
      v-if="mode === 'write'" v-model="body" class="st-body-in" :class="{ 'st-body-in--full': full }"
      :placeholder="t('story.bodyPh')" :aria-label="t('story.bodyPh')"></textarea>
    <div v-else class="st-preview" :class="{ 'st-preview--full': full }" v-html="previewHtml"></div>

    <!-- 正文下限进度：不足100 字才显示，边写边收窄，直到达标自动消失 -->
    <div v-if="shortOf > 0" class="st-minbar" role="status">
      <div class="st-minbar-fill" :style="{ width: Math.min(100, (chars / BODY_MIN) * 100) + '%' }"></div>
      <span class="st-minbar-txt">{{ t("story.minbar", { n: chars, need: shortOf }) }}</span>
    </div>

    <div class="st-tags">
      <span class="st-tag-lead">{{ t("story.tagLabel") }}</span>
      <span v-for="(tg, i) in tags" :key="tg" class="st-tag">
        #{{ tg }}
        <button class="st-tag-x" type="button" :aria-label="t('common.delete')" @click="removeTag(i)">×</button>
      </span>
      <input
        v-model="tagInput" class="st-tag-in" type="text" :maxlength="TAG_MAX"
        :placeholder="tags.length >= TAGS_MAX ? t('story.tagHint') : t('story.tagsPh')"
        :aria-label="t('story.tagLabel')"
        :disabled="tags.length >= TAGS_MAX" @keydown="onTagKey" @blur="addTag" />
    </div>
    <div class="st-presets">
      <button v-for="pt in PRESET_TAGS" :key="pt" type="button" class="st-preset"
        :class="{ 'st-preset--on': hasTag(pt) }"
        :disabled="tags.length >= TAGS_MAX || hasTag(pt)"
        :aria-pressed="hasTag(pt)" @click="pickPreset(pt)">#{{ pt }}</button>
    </div>
    <p class="st-hint">{{ t("story.tagHint") }}</p>
    <!-- 发布条件清单：还差什么逐条列出；全满足时给一句确认（让用户敢按，而不是猜） -->
    <div v-if="showWhy && blockers.length" class="st-why" role="status" aria-live="polite">
      <p class="st-why-t">{{ t("story.whyTitle") }}</p>
      <ul class="st-why-list">
        <li v-for="(b, i) in blockers" :key="i" class="st-why-li">{{ b }}</li>
      </ul>
    </div>
    <p v-else-if="showWhy && canPublish" class="st-why st-why--ok">{{ t("story.readyToPublish") }}</p>

    <footer class="st-ed-foot">
      <span class="st-count" :class="{ 'st-count--over': over }">
        {{ t("story.counter", { n: chars, max: BODY_MAX, min: minutes }) }}
      </span>
      <span class="st-hint">
        <template v-if="saving">{{ t("story.saving") }}</template>
        <template v-else-if="savedAt">{{ t("story.savedAt", { t: savedAt }) }}</template>
      </span>
      <span class="st-spring"></span>
      <button v-if="!full" class="st-btn st-btn--ghost" type="button" @click="autosave">{{ t("story.saveDraft") }}</button>
      <button class="st-btn" type="button" :disabled="!canPublish"
        :title="canPublish ? '' : whyDisabled" :aria-disabled="!canPublish" @click="publish">
        {{ publishing ? t("story.publishing") : t("story.publish") }}
      </button>
    </footer>

    <p v-if="!signedIn" class="st-hint">{{ t("story.loginNeeded") }}</p>
    <p v-if="err" class="st-err">{{ err }}</p>
  </section>
</template>
