<!-- 轮 145 · 批 2：故事评论区（列表 / 发评论 / 删评论）
 * 服务端权威：≤1000 字校验、只能评已发布、评论作者或故事作者可删（story_delete_comment 裁定）。
 * 未登录显示引导；发送中禁用防连点；失败保留输入内容不丢稿。 -->
<script setup>
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { t } from "../../i18n.js";
import { storyErrKey } from "../../utils/storyRules.js";
import {
  storyCommentList, storyAddComment, storyDeleteComment, canStory, COMMENT_MAX,
} from "../../utils/story.js";

const props = defineProps({ storyId: { type: [Number, String], required: true } });
const router = useRouter();

const signedIn = computed(() => canStory());
const rows = ref([]);
const loading = ref(false);
const sending = ref(false);
const err = ref("");
const draft = ref("");

const used = computed(() => String(draft.value ?? "").trim().length);
const over = computed(() => used.value > COMMENT_MAX);
const canSend = computed(() => signedIn.value && !sending.value && !over.value && used.value > 0);
/** 删评论按钮只对「我的评论」显示（最终权限由 story_delete_comment 服务端裁定：
 *  评论作者本人或故事作者都能删，后者前端不显示按钮，刷新后服务端仍会放行）。 */

const time = (s) => String(s || "").slice(0, 16).replace("T", " ");

async function load() {
  loading.value = true;
  err.value = "";
  try {
    rows.value = (await storyCommentList(Number(props.storyId), 100)) || [];
  } catch (e) {
    err.value = t(storyErrKey(e));
  } finally {
    loading.value = false;
  }
}

async function send() {
  if (!canSend.value) return;
  sending.value = true;
  err.value = "";
  try {
    await storyAddComment(Number(props.storyId), draft.value);
    draft.value = "";
    await load();
  } catch (e) {
    err.value = t(storyErrKey(e));   /* 失败不清输入：用户的字不该丢 */
  } finally {
    sending.value = false;
  }
}

async function del(c) {
  if (sending.value) return;
  sending.value = true;
  err.value = "";
  try {
    await storyDeleteComment(c.id);
    rows.value = rows.value.filter((x) => x.id !== c.id);
  } catch (e) {
    err.value = t(storyErrKey(e));
  } finally {
    sending.value = false;
  }
}

const nickname = (c) => c.nickname || t("story.anonAuthor");
defineExpose({ load, count: () => rows.value.length });
load();
</script>

<template>
  <section class="st-comments">
    <h2 class="st-rank-title">{{ t("story.comments", { n: rows.length }) }}</h2>

    <div v-if="signedIn" class="st-cmt-form">
      <textarea
        v-model="draft" class="st-cmt-input" rows="3" :maxlength="COMMENT_MAX + 200"
        :placeholder="t('story.commentPh')" :disabled="sending"
      ></textarea>
      <div class="st-cmt-actions">
        <span class="st-hint" :class="{ 'st-cmt-over': over }">{{ used }} / {{ COMMENT_MAX }}</span>
        <button class="st-btn" type="button" :disabled="!canSend" @click="send">
          {{ sending ? t("story.saving") : t("story.commentSend") }}
        </button>
      </div>
    </div>
    <p v-else class="st-hint">
      <button class="st-link" type="button" @click="router.push('/login')">{{ t("story.loginToComment") }}</button>
    </p>

    <ul class="st-cmt-list">
      <li v-for="c in rows" :key="c.id" class="st-cmt-row">
        <span class="st-cmt-main">
          <span class="st-cmt-name">
            {{ nickname(c) }}
            <span v-if="c.mine" class="st-cmt-me">{{ t("story.myCommentBadge") }}</span>
          </span>
          <span class="st-cmt-body">{{ c.body }}</span>
          <span class="st-hint">{{ time(c.created_at) }}</span>
        </span>
        <button v-if="c.mine" class="st-cmt-del" type="button" :disabled="sending" @click="del(c)">
          {{ t("story.commentDelete") }}
        </button>
      </li>
      <li v-if="!rows.length && !loading" class="st-hint">{{ t("story.commentEmpty") }}</li>
    </ul>

    <p v-if="err" class="st-err">{{ err }}</p>
  </section>
</template>
