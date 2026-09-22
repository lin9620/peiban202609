<!-- 帖子详情（轮 19 ②）：/post/:id 独立页 —— 完整帖子 + 与暖心墙同款的评论（两级展开）。
     「我的帖子」列表点进来，不再只是跳回暖心墙；数据链：wall.js cloudFetchPost（单帖）+
     cloudFetchComments / cloudInsertComment / cloudDeleteComment / cloudToggleReaction /
     cloudAddView / cloudToggleDislike，全部复用暖心墙现有云端 API（零新迁移、零新 i18n 键）。 -->
<script setup>
import { ref, computed, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { NAvatar, NButton, NInput } from "naive-ui";
import { t, i18n } from "../i18n.js";
import { cloud } from "../utils/supabase.js";
import {
  cloudFetchPost, cloudFetchProfile, cloudFetchComments, cloudInsertComment,
  cloudDeleteComment, cloudToggleReaction, cloudAddView, cloudToggleDislike,
} from "../utils/wall.js";
import { normalizeText, MAX_LEN } from "../utils/comments.js";
import { fmtWhen } from "../utils/wallRules.js";
/* 轮 33：举报弹窗 + 全站拉黑过滤（我拉黑的人，TA 的帖子/评论在我这里不显示） */
import ReportDialog from "../components/ReportDialog.vue";
import { filterBlocked, isBlocked } from "../utils/userBlocks.js";

const route = useRoute();
const router = useRouter();
const uid = computed(() => (route.params.id ? String(route.params.id) : ""));
const signedIn = computed(() => !!(cloud.ready && cloud.user));
const myId = computed(() => (cloud.user && cloud.user.id) || "");

const post = ref(null);
const loading = ref(true);
const failed = ref(false);
const gone = ref(false);          /* 操作后帖子被下架（厌恶达线）→ 明示，不再白屏 */
const myProfile = ref(null);
const wallName = computed(() => (myProfile.value && myProfile.value.nickname) || "Guest");

const when = (ts) => fmtWhen(ts, i18n.locale);

async function load() {
  if (!uid.value) { failed.value = true; loading.value = false; return; }
  loading.value = true;
  failed.value = false;
  gone.value = false;
  const p = await cloudFetchPost(uid.value);
  if (!p) { failed.value = true; loading.value = false; return; }
  post.value = p;
  loading.value = false;
  /* 浏览计数（浏览 RPC 幂等：同一人同一天只 +1），随后本地 +1 即时反馈 */
  if (p.dbId) {
    try {
      await cloudAddView(p.dbId, myId.value);
      post.value = { ...post.value, views: (post.value.views || 0) + 1 };
    } catch (e) { /* 计数失败不影响阅读 */ }
  }
  if (myId.value) {
    cloudFetchProfile(myId.value).then((pf) => { if (pf) myProfile.value = pf; });
  }
  loadComments();
}

/* 登录态就绪/变化 → 重拉（拿到 mine 回应标记与本人署名） */
watch(myId, () => {
  if (!post.value) return;
  cloudFetchPost(uid.value).then((p) => { if (p) post.value = p; });
});

watch(uid, load, { immediate: true });

function goBack() {
  const back = typeof history !== "undefined" && history.state && history.state.back;
  if (back != null) router.back();
  else router.push("/community");
}

/* ───────── 回应（抱抱/暖暖/同感）与厌恶：与暖心墙同一套云端 API ───────── */
const REACTIONS = [
  { key: "hug", tk: "community.reactHug" },
  { key: "warm", tk: "community.reactWarm" },
  { key: "relate", tk: "community.reactRelate" },
];
const hasReacted = (k) => !!(post.value && post.value.mine && post.value.mine[k]);
const reactBusy = ref(false);
const hint = ref("");
async function refetch() {
  const p = await cloudFetchPost(uid.value);
  if (!p) { gone.value = true; post.value = null; return; }
  post.value = p;
}
async function react(k) {
  const p = post.value;
  if (!p || reactBusy.value) return;
  if (!signedIn.value) { hint.value = t("community.reactSignIn"); return; }
  reactBusy.value = true;
  hint.value = "";
  try {
    await cloudToggleReaction(p.dbId, k);
    await refetch();
  } catch (e) { hint.value = t("community.reactFail"); }
  reactBusy.value = false;
}
async function dislike() {
  const p = post.value;
  if (!p || reactBusy.value) return;
  if (!signedIn.value) { hint.value = t("community.dislikeSignIn"); return; }
  reactBusy.value = true;
  hint.value = "";
  try {
    await cloudToggleDislike(p.dbId);
    await refetch();
  } catch (e) { hint.value = t("community.dislikeFail"); }
  reactBusy.value = false;
}

/* ───────── 评论（两级：一级评论 + 挂在一级下的回复，与暖心墙同款交互） ───────── */
const comments = ref([]);        /* 扁平视图评论（cloudFetchComments → rowsToComments 输出） */
const cmtLoading = ref(false);
const openCmt = ref(false);
const cmtDraft = ref("");
const repDraft = ref({});        /* 每个一级评论线程一个草稿（与墙一致） */
const repOpen = ref({});         /* 某一级评论的回复列表展开 */
const repActive = ref("");       /* 就地回复框挂在哪个目标：一级 id 或 一级id:回复id */
const atName = ref("");
const cmtErr = ref("");

const tops = computed(() => comments.value.filter((c) => !c.parentId));
const repsOf = (cm) => comments.value.filter((c) => c.parentId === cm.id);
const countN = computed(() => comments.value.length);
const canDel = (cm) => !!(cm && cm.cloud && myId.value && cm.userId === myId.value);

function loadComments() {
  if (!post.value || !post.value.dbId) return;
  cmtLoading.value = true;
  cloudFetchComments(post.value.dbId).then((rows) => {
    cmtLoading.value = false;
    if (Array.isArray(rows)) comments.value = filterBlocked(rows);
  });
}
function toggleCmt() {
  openCmt.value = !openCmt.value;
  if (openCmt.value && !comments.value.length) loadComments();
}
function toggleReplies(cm) {
  repOpen.value = { ...repOpen.value, [cm.id]: !repOpen.value[cm.id] };
}
function startReply(cm, rp = null) {
  if (!signedIn.value) return;
  /* 回复「回复」仍是两级封顶：挂同一级下，@那位回复者（与墙规则一致） */
  atName.value = rp ? rp.name : "";
  repActive.value = rp ? cm.id + ":" + rp.id : cm.id;
}
function cancelReply() {
  repActive.value = "";
  atName.value = "";
}
const repPlaceholder = (cm, rp = null) =>
  t("comment.replyPh", { n: rp ? rp.name : cm.name });
const leftOf = (s) => Math.max(0, MAX_LEN - normalizeText(s).length);
const cmtLeft = computed(() => leftOf(cmtDraft.value));
const repLeft = computed(() => {
  const k = repActive.value.split(":")[0];
  return leftOf(repDraft.value[k] || "");
});

async function sendCmt(cm = null, rp = null) {
  const text = cm ? (repDraft.value[cm.id] || "") : cmtDraft.value;
  if (!normalizeText(text) || !post.value) return;
  if (!signedIn.value) return;   /* #28：云端帖未登录不评论（只存本机会误导） */
  cmtErr.value = "";
  const at = cm ? (rp ? rp.name : atName.value) : "";
  const created = await cloudInsertComment(post.value.dbId, text, wallName.value, {
    parentId: cm ? cm.dbId : null,
    replyToName: at,
  });
  if (!created) { cmtErr.value = t("comment.fail"); return; }
  comments.value = [...comments.value, created];
  if (cm) {
    repDraft.value = { ...repDraft.value, [cm.id]: "" };
    repOpen.value = { ...repOpen.value, [cm.id]: true };
    repActive.value = "";
    atName.value = "";
  } else {
    cmtDraft.value = "";
  }
}

async function delCmt(cm) {
  if (!canDel(cm)) return;
  const done = await cloudDeleteComment(cm.dbId);
  if (!done) return;
  /* 删一级评论连它的回复一起删（与云端 FK 级联一致） */
  comments.value = comments.value.filter(
    (c) => c.id !== cm.id && c.parentId !== cm.id,
  );
  if (repActive.value.split(":")[0] === cm.id) cancelReply();
}

/* ═════════ 举报（轮 33）+ 拉黑隐藏 ═════════ */
const reportShow = ref(false);
const reportTarget = ref(null);
function openReportPost() {
  const p = post.value;
  if (!p || p.dbId == null) return;
  reportTarget.value = { type: "post", id: p.dbId, label: p.text || "" };
  reportShow.value = true;
}
function openReportCmt(cm) {
  /* 云端评论的数字主键在 dbId（id 是带 c 前缀的本地渲染键） */
  if (!cm || !cm.cloud || cm.dbId == null) return;
  reportTarget.value = { type: "comment", id: cm.dbId, label: cm.text || "" };
  reportShow.value = true;
}
const canReportPost = () => !!(post.value && post.value.dbId != null && signedIn.value
  && post.value.userId && post.value.userId !== myId.value);
const canReportCmt = (cm) => !!(cm && cm.cloud && cm.dbId != null && signedIn.value
  && cm.userId && cm.userId !== myId.value);
/* 帖子作者被我拉黑：正文以「已隐藏」呈现（数据还在，取消拉黑即恢复） */
const authorBlocked = computed(() => !!(post.value && isBlocked(post.value.userId)));
</script>

<template>
  <div class="pd">
    <div class="pd-head">
      <button class="pd-back" @click="goBack">&#8249; {{ t("nav.community") }}</button>
    </div>

    <p v-if="loading" class="sub">{{ t("community.loading") }}</p>

    <p v-else-if="failed && !gone" class="card sub" style="text-align:center">
      {{ t("common.oops") }}<br />
      <button class="pd-retry" @click="load">{{ t("common.reload") }}</button>
    </p>

    <template v-else-if="post">
      <p v-if="gone" class="notice">{{ t("community.removed") }}</p>
      <p v-else-if="authorBlocked" class="notice">{{ t("wall.blockedPost") }}</p>

      <article v-if="!authorBlocked" class="post-card card">
        <div class="post-head">
          <n-avatar round :size="42" class="post-avatar">🙂</n-avatar>
          <div class="post-meta">
            <div class="post-name">{{ post.name }}</div>
            <div class="post-time">{{ when(post.ts) }}</div>
          </div>
        </div>

        <p class="post-text">{{ post.text }}</p>
        <img v-if="post.img" :src="post.img" class="pic" alt="" />

        <div class="react-row">
          <n-button v-for="r in REACTIONS" :key="r.key" round size="small" :focusable="false"
            :type="hasReacted(r.key) ? 'primary' : 'default'" :quaternary="!hasReacted(r.key)"
            :title="signedIn ? '' : t('community.reactSignIn')"
            @click="react(r.key)">
            {{ t(r.tk) }} · {{ post.reacts[r.key] }}
          </n-button>
        </div>

        <div v-if="post.stats" class="post-foot">
          <span class="post-views">{{ t("community.views", { n: post.views || 0 }) }}</span>
          <button class="post-dis" :class="{ on: post.mine && post.mine.dislike }"
            :disabled="!signedIn"
            :title="signedIn ? t('community.dislikeHint') : t('community.dislikeSignIn')"
            @click="dislike">
            &#128078; {{ post.reacts.dislike || 0 }}
          </button>
          <button v-if="canReportPost()" class="cmt-act" @click="openReportPost">
            {{ t("report.act") }}
          </button>
        </div>

        <div class="cmt-toggle" @click="toggleCmt">
          <span class="cmt-ico">&#128172;</span> {{ t("comment.count", { n: countN }) }}
          <span class="cmt-caret" :class="{ open: openCmt }">&#9662;</span>
        </div>

        <div v-if="openCmt" class="cmt-box">
          <p v-if="cmtErr" class="cmt-empty" style="color: var(--low); font-weight: 700">{{ cmtErr }}</p>
          <p v-if="cmtLoading && !comments.length" class="cmt-empty">{{ t("community.loading") }}</p>

          <div v-for="cm in tops" :key="cm.id" class="cmt-item">
            <div class="cmt-head">
              <b>{{ cm.name }}</b><span>{{ when(cm.ts) }}</span>
              <button v-if="canDel(cm)" class="cmt-del" :title="t('common.delete')" @click="delCmt(cm)">×</button>
            </div>
            <p class="cmt-text" :title="signedIn ? t('comment.reply') : ''" @click="startReply(cm)">{{ cm.text }}</p>
            <div class="cmt-acts">
              <button v-if="signedIn" class="cmt-act" @click="startReply(cm)">{{ t("comment.reply") }}</button>
              <button v-if="canReportCmt(cm)" class="cmt-act" @click="openReportCmt(cm)">{{ t("report.act") }}</button>
              <button v-if="repsOf(cm).length" class="cmt-act" @click="toggleReplies(cm)">
                {{ t("comment.replies", { n: repsOf(cm).length }) }}
                <i :class="{ open: repOpen[cm.id] }">&#9662;</i>
              </button>
            </div>

            <div v-if="repOpen[cm.id] && repsOf(cm).length" class="cmt-reps">
              <div v-for="rp in repsOf(cm)" :key="rp.id" class="cmt-item">
                <div class="cmt-head">
                  <b>{{ rp.name }}<span v-if="rp.replyTo" class="cmt-at"> @{{ rp.replyTo }}</span></b>
                  <span>{{ when(rp.ts) }}</span>
                  <button v-if="canDel(rp)" class="cmt-del" :title="t('common.delete')" @click="delCmt(rp)">×</button>
                </div>
                <p class="cmt-text" @click="startReply(cm, rp)">{{ rp.text }}</p>
                <div class="cmt-acts">
                  <button v-if="signedIn" class="cmt-act" @click="startReply(cm, rp)">{{ t("comment.reply") }}</button>
                  <button v-if="canReportCmt(rp)" class="cmt-act" @click="openReportCmt(rp)">{{ t("report.act") }}</button>
                </div>
                <div v-if="repActive === cm.id + ':' + rp.id" class="cmt-input cmt-input-in">
                  <n-input v-model:value="repDraft[cm.id]" round size="small"
                    :placeholder="repPlaceholder(cm, rp)" :maxlength="MAX_LEN"
                    @keyup.enter="sendCmt(cm, rp)" />
                  <n-button type="primary" size="small" round @click="sendCmt(cm, rp)">{{ t("common.send") }}</n-button>
                  <n-button quaternary size="small" round @click="cancelReply">{{ t("comment.cancel") }}</n-button>
                  <p class="cmt-left" :class="{ full: repLeft <= 0 }">
                    {{ repLeft <= 0 ? t("comment.full", { n: MAX_LEN }) : t("comment.left", { n: repLeft }) }}
                  </p>
                </div>
              </div>
            </div>

            <div v-if="repActive === cm.id" class="cmt-input cmt-input-in">
              <n-input v-model:value="repDraft[cm.id]" round size="small"
                :placeholder="repPlaceholder(cm)" :maxlength="MAX_LEN"
                @keyup.enter="sendCmt(cm)" />
              <n-button type="primary" size="small" round @click="sendCmt(cm)">{{ t("common.send") }}</n-button>
              <n-button quaternary size="small" round @click="cancelReply">{{ t("comment.cancel") }}</n-button>
              <p class="cmt-left" :class="{ full: repLeft <= 0 }">
                {{ repLeft <= 0 ? t("comment.full", { n: MAX_LEN }) : t("comment.left", { n: repLeft }) }}
              </p>
            </div>
          </div>

          <p v-if="!comments.length && !cmtLoading" class="cmt-empty">{{ t("comment.empty") }}</p>

          <div v-if="!signedIn" class="cmt-input">
            <p class="cmt-empty">
              {{ t("community.commentSignIn") }}
              <router-link class="cmt-login" to="/profile">{{ t("common.signIn") }}</router-link>
            </p>
          </div>
          <div v-else class="cmt-input">
            <n-input v-model:value="cmtDraft" round size="small" :placeholder="t('comment.placeholder')"
              :maxlength="MAX_LEN" @keyup.enter="sendCmt()" />
            <n-button type="primary" size="small" round @click="sendCmt()">{{ t("common.send") }}</n-button>
            <p class="cmt-left" :class="{ full: cmtLeft <= 0 }">
              {{ cmtLeft <= 0 ? t("comment.full", { n: MAX_LEN }) : t("comment.left", { n: cmtLeft }) }}
            </p>
          </div>
        </div>
        <p v-if="hint" class="sub" style="color: var(--low); font-weight: 700">{{ hint }}</p>
      </article>
    </template>

    <!-- 举报弹窗（帖子/评论共用一个实例） -->
    <ReportDialog v-model:show="reportShow" :target="reportTarget" />
  </div>
</template>

<style scoped>
.pd { max-width: 640px; margin: 0 auto; }
.pd-head { margin: 10px 0; }
.pd-back, .pd-retry {
  -webkit-appearance: none; appearance: none; font: inherit; cursor: pointer;
  border: 0; background: transparent; color: var(--ink-soft); font-weight: 700;
  padding: 8px 10px; border-radius: 10px; min-height: 40px;
}
.pd-back:hover, .pd-retry:hover { background: rgba(160, 110, 60, .08); }
.pd-retry { border: 1px solid var(--line); margin-top: 8px; }
.post-card { padding: 14px 16px; }
.post-head { display: flex; align-items: center; gap: 10px; }
.post-meta { flex: 1; min-width: 0; }
.post-name { font-weight: 700; overflow-wrap: anywhere; }
.post-time { font-size: 12px; color: var(--ink-faint); }
.post-text { white-space: pre-wrap; overflow-wrap: anywhere; margin: 10px 0 4px; line-height: 1.7; }
.pic { display: block; max-width: 100%; border-radius: 12px; margin: 8px 0 4px; }
.react-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.post-foot { display: flex; align-items: center; gap: 10px; margin-top: 8px; color: var(--ink-faint); font-size: 12px; }
.post-dis {
  -webkit-appearance: none; appearance: none; border: 0; background: transparent;
  cursor: pointer; color: var(--ink-faint); font: inherit; font-size: 12px;
  padding: 2px 6px; border-radius: 8px;
}
.post-dis.on { color: var(--low); font-weight: 700; }
.post-dis:disabled { cursor: default; opacity: .6; }
.cmt-toggle { display: inline-flex; align-items: center; gap: 6px; margin-top: 10px; cursor: pointer; color: var(--ink-soft); font-weight: 700; }
.cmt-caret { transition: transform .15s ease; display: inline-block; }
.cmt-caret.open, .cmt-act i.open { transform: rotate(180deg); }
.cmt-box { margin-top: 10px; border-top: 1px dashed var(--line); padding-top: 10px; }
.cmt-empty { color: var(--ink-faint); margin: 6px 0; }
.cmt-item { padding: 8px 0; }
.cmt-head { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.cmt-head span { color: var(--ink-faint); font-size: 12px; }
.cmt-del {
  margin-left: auto; -webkit-appearance: none; appearance: none; border: 0;
  background: transparent; color: var(--ink-faint); cursor: pointer; font-size: 15px; line-height: 1;
}
.cmt-del:hover { color: var(--low); }
.cmt-text { margin: 4px 0; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.6; cursor: pointer; }
.cmt-acts { display: flex; gap: 12px; }
.cmt-act {
  -webkit-appearance: none; appearance: none; border: 0; background: transparent;
  color: var(--ink-faint); cursor: pointer; font: inherit; font-size: 12px; padding: 0;
}
.cmt-act:hover { color: var(--ink-soft); }
.cmt-act i { transition: transform .15s ease; display: inline-block; font-style: normal; }
.cmt-at { color: var(--ink-faint); font-weight: 400; }
.cmt-reps { margin-left: 18px; border-left: 2px solid var(--line); padding-left: 10px; }
.cmt-input { display: flex; align-items: center; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.cmt-input-in { margin: 8px 0 2px; }
.cmt-input > .n-input { flex: 1; min-width: 0; }
.cmt-left { font-size: 12px; color: var(--ink-faint); white-space: nowrap; }
.cmt-left.full { color: var(--low); font-weight: 700; }
.cmt-login { font-weight: 700; }
</style>
