<!-- 轮 145 · 批 2：故事评论区（列表 / 发评论 / 删评论）
 * 服务端权威：≤1000 字校验、只能评已发布、评论作者或故事作者可删（story_delete_comment 裁定）。
 * 未登录显示引导；发送中禁用防连点；失败保留输入内容不丢稿。
 * 轮 321：发送改成「乐观上屏」—— 写入成功即把这条评论立刻插到列表顶部，
 * 不再 await load() 全量重拉（跨境弱网下那是又一趟几百 ms~数秒的等待，
 * 用户看到的就是「发出去了但什么都没变」）。后台静默刷新做校对。 -->
<script setup>
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { t } from "../../i18n.js";
import { storyErrKey } from "../../utils/storyRules.js";
import {
  storyCommentList, storyAddComment, storyDeleteComment, canStory, COMMENT_MAX,
} from "../../utils/story.js";
import { cloud } from "../../utils/supabase.js";

const props = defineProps({ storyId: { type: [Number, String], required: true } });
const router = useRouter();

const signedIn = computed(() => canStory());
const rows = ref([]);
const loading = ref(false);
/* 轮 322：拆成两个独立的忙态 ——
   旧写法只有一个 sending，同时管「发评论」和「删评论」，于是：
     ① 发一条评论的往返期间，发送按钮变灰 → 不能连发第二条（体感「卡住」）；
     ② 删除按钮上绑的是 :disabled="sending" → 只要有评论在飞，
        列表里【所有】删除按钮一起变灰，用户以为功能坏了。
   拆开后：发评论不影响删评论，删评论也不影响发评论。
   （全局 sending 已移除 —— 每条评论各自 pending / 各自 deleting，按条锁） */
/** 正在删除的评论 id 集合（按条锁，不牵连别的评论的删除按钮） */
const deleting = ref({});
const err = ref("");
const draft = ref("");

const used = computed(() => String(draft.value ?? "").trim().length);
const over = computed(() => used.value > COMMENT_MAX);
/* 轮 322：去掉 !sending —— 允许连发多条（每条各自乐观上屏、各自 pending） */
const canSend = computed(() => signedIn.value && !over.value && used.value > 0);
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

/* 轮 321：静默刷新（后台校对用）—— 不清错误提示、不改 loading 指示，
   避免用户正在看「发送中」时列表整体闪一下。失败静默（已有乐观态可看）。
   轮 322：合并时保留「还在飞的 pending 评论」—— 旧写法直接整体替换 rows，
   连发两条时，第一条还没落库就被服务端列表冲掉 → 用户以为「发丢了」。 */
async function refreshQuiet() {
  try {
    const server = (await storyCommentList(Number(props.storyId), 100)) || [];
    const pending = rows.value.filter((x) => x.pending);
    if (pending.length) {
      const seen = new Set(server.map((x) => x.body));
      rows.value = [...server, ...pending.filter((x) => !seen.has(x.body))];
    } else {
      rows.value = server;
    }
  } catch (e) { /* 静默：乐观态已经在屏上 */ }
}

/**
 * 发评论（轮 321：乐观上屏）。
 * 旧写法：await storyAddComment(...) → await load()（全量重拉 100 条），
 *   弱网下这一趟能把「发出去」的反馈拖到好几秒之后。
 * 新写法：
 *   ① 点发送的【瞬间】就把这条插进列表（pending 态，淡化显示）—— 用户马上看到自己发了；
 *   ② 写入成功 → 换成真 id；写入失败 → 把这条撤掉、把稿还回输入框（不丢用户的字）。
 *   ③ 背景里静默刷新一次做校对（权威排序/计数），不阻塞 UI。
 */
async function send() {
  if (!canSend.value) return;
  const body = String(draft.value ?? "").trim();
  err.value = "";
  /* 临时 id 用负数（真实 id 是 bigint identity，恒为正）—— 不会和服务端 id 撞 */
  const tmpId = -Date.now() - rows.value.filter((x) => x.pending).length;
  const mine = {
    id: tmpId,
    user_id: (cloud.user && cloud.user.id) || "",
    nickname: cloud.nickname || "",
    body,
    created_at: new Date().toISOString(),
    mine: true,
    pending: true,          /* 发送中标记：样式上淡化，等服务端确认 */
  };
  /* ① 乐观上屏：点下去立刻出现在列表末尾（服务端按 created_at asc 排，新评论在最后） */
  rows.value = [...rows.value, mine];
  draft.value = "";
  /* 轮 322：连发不再被 sending 拦 —— 每条评论各自 pending、各自等结果。
     失败只撤掉【自己那一条】，并把稿还回输入框（不丢用户的字）；
     别人的评论仍在飞时失败，不会误伤别人的那条。 */
  try {
    const realId = await storyAddComment(Number(props.storyId), body);
    /* ② 成功：换成真 id（去掉 pending 淡化） */
    rows.value = rows.value.map((x) => (
      x.id === tmpId ? { ...x, id: realId != null ? realId : tmpId, pending: false } : x
    ));
    /* ③ 背景里静默刷新做校对（权威排序/计数），不阻塞 UI */
    refreshQuiet();
  } catch (e) {
    /* 失败：撤掉这条临时评论，并把稿还给用户（他的字不该丢）
       轮 322：连发期间用户可能已经写了新草稿 —— 失败的那条【垫在最前】追加，
       不覆盖新字（直接 draft.value = body 会把新草稿冲掉 = 又一次「丢稿」）。 */
    rows.value = rows.value.filter((x) => x.id !== tmpId);
    if (!draft.value) draft.value = body;
    else draft.value = `${body}\n${draft.value}`;
    err.value = t(storyErrKey(e));
  }
}

/** 删评论（轮 322：乐观删除 + 按条锁 —— 别的评论的删除按钮不再一起变灰） */
async function del(c) {
  if (!c || c.pending || deleting.value[c.id]) return;
  deleting.value = { ...deleting.value, [c.id]: true };
  err.value = "";
  const snapshot = rows.value;
  /* 乐观删除：点下去这条当场消失（不用等网络），失败再放回来 */
  rows.value = rows.value.filter((x) => x.id !== c.id);
  try {
    await storyDeleteComment(c.id);
  } catch (e) {
    rows.value = snapshot;
    err.value = t(storyErrKey(e));
  } finally {
    const next = { ...deleting.value };
    delete next[c.id];
    deleting.value = next;
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
      <!-- 轮 321：发送中不再锁输入框 —— 草稿已经即时上屏，用户可以接着写下一条；
           旧写法锁住整个输入框，弱网下等于「页面卡死几秒」。 -->
      <textarea
        v-model="draft" class="st-cmt-input" rows="3" :maxlength="COMMENT_MAX + 200"
        :placeholder="t('story.commentPh')"
      ></textarea>
      <div class="st-cmt-actions">
        <span class="st-hint" :class="{ 'st-cmt-over': over }">{{ used }} / {{ COMMENT_MAX }}</span>
        <!-- 轮 322：按钮文案不再随「有评论在飞」变化 —— 旧写法只要有一条评论在往返，
             文案就变成「保存中」且按钮变灰，用户想连发第二条却发不了（体感「卡住」）。
             现在文案恒定，点击永远可用；每条评论自己在列表里以 pending 淡化表示在飞。 -->
        <button class="st-btn" type="button" :disabled="!canSend" @click="send">
          {{ t("story.commentSend") }}
        </button>
      </div>
    </div>
    <p v-else class="st-hint">
      <button class="st-link" type="button" @click="router.push('/login')">{{ t("story.loginToComment") }}</button>
    </p>

    <ul class="st-cmt-list">
      <li v-for="c in rows" :key="c.id" class="st-cmt-row" :class="{ 'st-cmt-row--pending': c.pending }">
        <span class="st-cmt-main">
          <span class="st-cmt-name">
            {{ nickname(c) }}
            <span v-if="c.mine" class="st-cmt-me">{{ t("story.myCommentBadge") }}</span>
          </span>
          <span class="st-cmt-body">{{ c.body }}</span>
          <span class="st-hint">{{ time(c.created_at) }}</span>
        </span>
        <!-- 轮 322：删除按钮只锁【自己这一条】（deleting[c.id]），不再被全局 sending 牵连 ——
             旧写法只要有任意一条评论在飞，列表里所有删除按钮一起变灰。 -->
        <button v-if="c.mine && !c.pending" class="st-cmt-del" type="button" :disabled="!!deleting[c.id]" @click="del(c)">
          {{ t("story.commentDelete") }}
        </button>
      </li>
      <li v-if="!rows.length && !loading" class="st-hint">{{ t("story.commentEmpty") }}</li>
    </ul>

    <p v-if="err" class="st-err">{{ err }}</p>
  </section>
</template>
