<!-- 帖子详情（轮 19 ②）：/post/:id 独立页 —— 完整帖子 + 与暖心墙同款的评论（两级展开）。
     「我的帖子」列表点进来，不再只是跳回暖心墙；数据链：wall.js cloudFetchPost（单帖）+
     cloudFetchComments / cloudInsertComment / cloudDeleteComment / cloudToggleReaction /
     cloudAddView / cloudToggleDislike，全部复用暖心墙现有云端 API（零新迁移、零新 i18n 键）。 -->
<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from "vue";
import { useRoute, useRouter } from "vue-router";
import { NAvatar, NButton, NInput } from "naive-ui";
import { t, i18n } from "../i18n.js";
import { cloud } from "../utils/supabase.js";
/* 轮 84：评论回应（mine 拉取 + 切换）—— import 大括号内不写注释（undef-check 解析器会粘连） */
import {
  cloudFetchPost, cloudFetchProfile, cloudFetchComments, cloudInsertComment,
  cloudDeleteComment, cloudToggleReaction, cloudAddView, cloudToggleDislike,
  cloudFetchMyCommentReactions, cloudToggleCommentReaction,
} from "../utils/wall.js";
/* 轮 84：评论排序 / 回应 / 拷贝文本 */
import {
  normalizeText, MAX_LEN,
  SORT_MODES, sortComments, reactCount, toggleReact, hasReacted as cmtHasReacted,
  postCopyText, commentCopyText,
} from "../utils/comments.js";
import { fmtWhen } from "../utils/wallRules.js";
import { isMobileNav } from "../stores/uiStore.js";
/* 轮 84：…菜单的「拷贝」（WebView 里 navigator.clipboard 缺失时 execCommand 兜底） */
import { copyText } from "../utils/clipboard.js";
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
const openCmt = ref(true);   /* 轮 87：进详情页评论默认展开（load() 已自动拉取评论） */
const cmtDraft = ref("");
const repDraft = ref({});        /* 每个一级评论线程一个草稿（与墙一致） */
const repOpen = ref({});         /* 某一级评论的回复列表展开 */
const repActive = ref("");       /* 就地回复框挂在哪个目标：一级 id 或 一级id:回复id */
const atName = ref("");
const cmtErr = ref("");

/* ═════════ 轮 84 · 评论排序 + 评论回应 + …菜单 ═════════ */

/* 排序只作用于一级评论："new" = 发布时间倒序；"hot" = 心最多（同数看碎心，再按时间倒序） */
const cmtSort = ref("default");
/* 轮 87：一级评论先展示 15 条，下滑接近底部续展 15 条（与暖心墙信息流同手感）；
 * 「查看更多评论」按钮也能续。二级回复仍默认前两条（轮 50 口径不变）。 */
const CMT_PAGE = 15;
const cmtReveal = ref(CMT_PAGE);
watch(cmtSort, () => { cmtReveal.value = CMT_PAGE; });

/* —— 评论回应（与暖心墙同口径：乐观翻转 → RPC 权威计数覆盖 → 失败回滚） —— */
const cmtReactBusy = ref({});
function cmtReacted(cm, kind) { return cmtHasReacted(cm, kind); }
async function cmtReact(cm, kind) {
  if (!cm || cm.dbId == null || cmtReactBusy.value[cm.id]) return;
  if (!signedIn.value) { hint.value = t("community.reactSignIn"); return; }
  cmtReactBusy.value = { ...cmtReactBusy.value, [cm.id]: true };
  const prevReacts = { ...(cm.reacts || {}) };
  const prevMine = [...(cm.myReacts || [])];
  const wasOn = prevMine.includes(kind);
  const opt = toggleReact(cm, kind, !wasOn);
  cm.reacts = opt.reacts;
  cm.myReacts = opt.myReacts;
  const res = await cloudToggleCommentReaction(cm.dbId, kind);
  if (res && res.ok) {
    /* 服务端权威计数覆盖乐观值；on 只描述本次点击的 kind（两种可同时点亮，与帖子回应同口径） */
    cm.reacts = { heart: res.hearts, broken: res.brokens };
    cm.myReacts = res.on ? [...new Set([...prevMine, kind])] : prevMine.filter((x) => x !== kind);
  } else {
    cm.reacts = prevReacts;
    cm.myReacts = prevMine;
    hint.value = t("community.reactFail");
  }
  const next = { ...cmtReactBusy.value };
  delete next[cm.id];
  cmtReactBusy.value = next;
}
/* 评论加载后补拉「我点过的」；失败静默（只少高亮，不影响计数展示） */
async function loadCmtMine(rows) {
  const ids = (Array.isArray(rows) ? rows : []).filter((r) => r.dbId != null).map((r) => r.dbId);
  if (!ids.length || !myId.value) return;
  const mine = await cloudFetchMyCommentReactions(ids, myId.value);
  if (!mine) return;
  const map = {};
  for (const r of mine) { (map[r.comment_id] = map[r.comment_id] || []).push(r.kind); }
  for (const cm of comments.value) { if (map[cm.dbId]) cm.myReacts = map[cm.dbId]; }
}

/* —— …菜单（帖子右上角 / 每条评论右上角：举报迁入 + 拷贝；同一时刻最多开一个） —— */
const moreKey = ref("");
const moreTarget = ref(null);   /* { type, reportable, dbId, label, copy } */
function togglePostMore() {
  moreKey.value = moreKey.value === "post" ? "" : "post";
  moreTarget.value = {
    type: "post", reportable: !!post.value && canReportPost(), dbId: post.value && post.value.dbId,
    label: post.value ? post.value.text || "" : "", copy: postCopyText(post.value),
  };
}
function toggleCmtMore(cm) {
  const k = "cmt:" + cm.id;
  moreKey.value = moreKey.value === k ? "" : k;
  moreTarget.value = { type: "comment", reportable: canReportCmt(cm), dbId: cm.dbId, label: cm.text || "", copy: commentCopyText(cm) };
}
function closeMore() { moreKey.value = ""; }
/* 轮 87：去掉全屏遮罩（.card 的 backdrop-filter 造出堆叠上下文，遮罩盖住菜单 →
 * 举报/拷贝点击全被吞掉）。改 document 级点击收起，动作不受影响。 */
watch(moreKey, (v) => {
  if (typeof document === "undefined") return;
  if (v) document.addEventListener("click", closeMore);
  else document.removeEventListener("click", closeMore);
});
function moreReport() {
  const t0 = moreTarget.value;
  closeMore();
  if (!t0 || !t0.reportable || t0.dbId == null) return;
  reportTarget.value = { type: t0.type, id: t0.dbId, label: t0.label };
  reportShow.value = true;
}
async function moreCopy() {
  const t0 = moreTarget.value;
  closeMore();
  const ok = await copyText(t0 ? t0.copy : "");
  hint.value = ok ? t("common.copied") : t("common.copyFail");
  setTimeout(() => { hint.value = ""; }, 2500);
}

/* 轮 87：手机端统一回复输入条（用户反馈：逐条内联回复框在手机上没法用）——
 * 点「回复」只在底部弹出一条输入条，发送在右下角；桌面保持就地内联框不变。
 * repActive 形如 "cmId" 或 "cmId:rpId"，从这里反查回复目标。 */
const barCm = computed(() => comments.value.find((c) => c.id === String(repActive.value).split(":")[0]) || null);
const barRp = computed(() => {
  if (!String(repActive.value).includes(":")) return null;
  const rid = String(repActive.value).split(":")[1];
  return comments.value.find((c) => c.id === rid) || null;
});
const barInput = ref(null);
watch(repActive, async () => {
  if (!repActive.value || !isMobileNav.value) return;
  await nextTick();
  try { if (barInput.value) barInput.value.focus(); } catch (e) { /* 无焦点环境忽略 */ }
});
function sendBar() { if (barCm.value) sendCmt(barCm.value, barRp.value); }

const tops = computed(() => {
  const list = comments.value.filter((c) => !c.parentId);
  /* 轮 90：默认 = 自然顺序（与暖心墙评论一致：旧→新，不滤不限——评论不是帖子，不用 7 天推荐池）；
     最新 = 时间倒序 */
  return cmtSort.value === "new" ? sortComments(list, "new") : list;
});
const shownTops = computed(() => tops.value.slice(0, cmtReveal.value));
/* 轮 87：下滑接近底部续展一级评论（与暖心墙信息流同手感；查看更多评论按钮同效） */
function onWallScroll() {
  if (cmtReveal.value >= tops.value.length) return;
  if (window.innerHeight + window.scrollY >= document.documentElement.offsetHeight - 700) {
    cmtReveal.value = Math.min(cmtReveal.value + CMT_PAGE, tops.value.length);
  }
}
onMounted(() => window.addEventListener("scroll", onWallScroll, { passive: true }));
onUnmounted(() => window.removeEventListener("scroll", onWallScroll));
const repsOf = (cm) => comments.value.filter((c) => c.parentId === cm.id);
/* 轮 50：与暖心墙同口径——二级回复默认显示前两条，>2 条点「N 条回复」展开全部 */
const visibleReps = (cm) => (repOpen.value[cm.id] ? repsOf(cm) : repsOf(cm).slice(0, 2));
const countN = computed(() => comments.value.length);
const canDel = (cm) => !!(cm && cm.cloud && myId.value && cm.userId === myId.value);

function loadComments() {
  if (!post.value || !post.value.dbId) return;
  cmtLoading.value = true;
  cloudFetchComments(post.value.dbId).then((rows) => {
    cmtLoading.value = false;
    if (Array.isArray(rows)) {
      comments.value = filterBlocked(rows);
      loadCmtMine(comments.value);   /* 轮 84：补拉「我点过的评论回应」（高亮用，失败静默） */
      focusTargetComment();   /* 轮 89：带 cid 进入 → 展开目标线程并滚动定位 */
    }
  });
}

/* 轮 89：墙内「查看全部回复」带 cid 跳转进来 → 展开目标线程 + 滚动定位。
 * 目标一级评论可能在推荐池（7 天）之外 → 先切「最新」保证可见，并把 reveal 撑到它的位置。 */
const focusCid = computed(() => (route.query.cid ? String(route.query.cid) : ""));
async function focusTargetComment() {
  if (!focusCid.value) return;
  cmtSort.value = "new";
  const key = "c" + focusCid.value;
  repOpen.value = { ...repOpen.value, [key]: true };
  await nextTick();
  const idx = tops.value.findIndex((c) => c.id === key);
  if (idx >= 0 && idx >= cmtReveal.value) cmtReveal.value = idx + 1;
  await nextTick();
  if (typeof document !== "undefined") {
    const el = document.getElementById("cmt-" + focusCid.value);
    if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
  }
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
  /* 轮 98：取消按钮已移除 —— 再点同一条的「回复」= 收起该框 */
  const key = rp ? cm.id + ":" + rp.id : cm.id;
  if (repActive.value === key) { repActive.value = ""; atName.value = ""; return; }
  /* 回复「回复」仍是两级封顶：挂同一级下，@那位回复者（与墙规则一致） */
  atName.value = rp ? rp.name : "";
  repActive.value = key;
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
/* 自己的内容不显示举报（不能举报自己）；游客也显示入口——点了弹窗里会提示先登录。 */
const canReportPost = () => !!(post.value && post.value.dbId != null
  && post.value.userId && post.value.userId !== myId.value);
const canReportCmt = (cm) => !!(cm && cm.cloud && cm.dbId != null
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
          <!-- 轮 84：帖子右上角 … 菜单（举报迁入 + 拷贝正文）；post-foot 里原举报按钮移除 -->
          <button class="more-btn" :title="t('comment.more')" :aria-label="t('comment.more')"
            @click.stop="togglePostMore">⋯</button>
          <div v-if="moreKey === 'post'" class="more-pop card" @click.stop>
            <button v-if="canReportPost()" class="more-item" @click="moreReport">{{ t("report.act") }}</button>
            <button class="more-item" @click="moreCopy">{{ t("common.copy") }}</button>
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
            <!-- 轮 84：举报入口迁入帖子右上角 … 菜单，post-foot 只留浏览数与厌恶 -->
          </div>

        <div class="cmt-bar">
          <div class="cmt-toggle" @click="toggleCmt">
            <span class="cmt-ico">&#128172;</span> {{ t("comment.count", { n: countN }) }}
            <span class="cmt-caret" :class="{ open: openCmt }">&#9662;</span>
          </div>
          <!-- 轮 87：评论排序「默认 / 最新」——默认 = 推荐模式（与暖心墙帖子排序同源） -->
          <div class="cmt-sort">
            <button v-for="sm in SORT_MODES" :key="sm" class="sort-btn cmt-sort-btn"
              :class="{ on: cmtSort === sm }" @click="cmtSort = sm">
              {{ t(sm === "default" ? "comment.sortDefault" : "comment.sortNew") }}
            </button>
          </div>
        </div>

        <div v-if="openCmt" class="cmt-box">
          <!-- 轮 93：发评论输入框改为页面底部常驻输入条（cmt-bar-fixed），列表内不再嵌输入框 -->

          <p v-if="cmtErr" class="cmt-empty" style="color: var(--low); font-weight: 700">{{ cmtErr }}</p>
          <p v-if="cmtLoading && !comments.length" class="cmt-empty">{{ t("community.loading") }}</p>

          <div v-for="cm in shownTops" :key="cm.id" class="cmt-item"
            :id="cm.dbId != null ? 'cmt-' + cm.dbId : undefined"
            :class="{ 'cmt-focus': focusCid && String(cm.dbId) === focusCid }">
            <div class="cmt-head">
              <b>{{ cm.name }}</b>
              <button v-if="canDel(cm)" class="cmt-del" :title="t('common.delete')" @click="delCmt(cm)">×</button>
              <!-- 轮 84：评论右上角 … 菜单（举报迁入 + 拷贝） -->
              <button class="cmt-more" :title="t('comment.more')" :aria-label="t('comment.more')"
                @click.stop="toggleCmtMore(cm)">⋯</button>
              <div v-if="moreKey === 'cmt:' + cm.id" class="more-pop card" @click.stop>
                <button v-if="canReportCmt(cm)" class="more-item" @click="moreReport">{{ t("report.act") }}</button>
                <button class="more-item" @click="moreCopy">{{ t("common.copy") }}</button>
              </div>
            </div>
            <p class="cmt-text" :title="signedIn ? t('comment.reply') : ''" @click="startReply(cm)">{{ cm.text }}</p>
            <div class="cmt-acts">
              <!-- 轮 84：时间从评论头移到「回复」左侧 -->
              <span class="cmt-time">{{ when(cm.ts) }}</span>
              <button v-if="signedIn" class="cmt-act" @click="startReply(cm)">{{ t("comment.reply") }}</button>
              <!-- 轮 87：回应图标改空心灰内联 SVG（emoji 太艳丽；点亮 = 深一档灰） -->
              <button v-if="cm.dbId != null" class="cmt-react" :class="{ on: cmtReacted(cm, 'heart') }"
                :disabled="!!cmtReactBusy[cm.id]" :title="t('comment.likeT')" :aria-label="t('comment.likeT')"
                @click="cmtReact(cm, 'heart')"><svg class="rc-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21.35 10.55 20.03C5.4 15.36 2 12.27 2 8.5 2 5.41 4.42 3 7.5 3c1.74 0 3.59.94 4.5 2.35C12.91 3.94 14.76 3 16.5 3 19.58 3 22 5.41 22 8.5c0 3.77-3.4 6.86-8.55 11.53L12 21.35z"/></svg><i>{{ reactCount(cm, "heart") }}</i></button>
              <button v-if="cm.dbId != null" class="cmt-react" :class="{ on: cmtReacted(cm, 'broken') }"
                :disabled="!!cmtReactBusy[cm.id]" :title="t('comment.brokenT')" :aria-label="t('comment.brokenT')"
                @click="cmtReact(cm, 'broken')"><svg class="rc-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21.35 10.55 20.03C5.4 15.36 2 12.27 2 8.5 2 5.41 4.42 3 7.5 3c1.74 0 3.59.94 4.5 2.35C12.91 3.94 14.76 3 16.5 3 19.58 3 22 5.41 22 8.5c0 3.77-3.4 6.86-8.55 11.53L12 21.35z"/><path d="M12 6.8 10.4 9.4l2.4 1.5-1.5 2.4 1.1 1.8"/></svg><i>{{ reactCount(cm, "broken") }}</i></button>
              <!-- 轮 88：「N 条回复」按钮移到回复列表底部（见下方 replies-toggle），操作行只留时间/回复/回应 -->
            </div>

            <div v-if="repsOf(cm).length" class="cmt-reps">
              <div v-for="rp in visibleReps(cm)" :key="rp.id" class="cmt-item">
                <div class="cmt-head">
                  <b>{{ rp.name }}<span v-if="rp.replyTo" class="cmt-at"> @{{ rp.replyTo }}</span></b>
                  <button v-if="canDel(rp)" class="cmt-del" :title="t('common.delete')" @click="delCmt(rp)">×</button>
                  <!-- 轮 84：回复也有 … 菜单 -->
                  <button class="cmt-more" :title="t('comment.more')" :aria-label="t('comment.more')"
                    @click.stop="toggleCmtMore(rp)">⋯</button>
                  <div v-if="moreKey === 'cmt:' + rp.id" class="more-pop card" @click.stop>
                    <button v-if="canReportCmt(rp)" class="more-item" @click="moreReport">{{ t("report.act") }}</button>
                    <button class="more-item" @click="moreCopy">{{ t("common.copy") }}</button>
                  </div>
                </div>
                <p class="cmt-text" @click="startReply(cm, rp)">{{ rp.text }}</p>
                <div class="cmt-acts">
                  <!-- 轮 84：时间移到「回复」左侧 + 轮 87：回应图标改空心灰 -->
                  <span class="cmt-time">{{ when(rp.ts) }}</span>
                  <button v-if="signedIn" class="cmt-act" @click="startReply(cm, rp)">{{ t("comment.reply") }}</button>
                  <button v-if="rp.dbId != null" class="cmt-react" :class="{ on: cmtReacted(rp, 'heart') }"
                    :disabled="!!cmtReactBusy[rp.id]" :title="t('comment.likeT')" :aria-label="t('comment.likeT')"
                    @click="cmtReact(rp, 'heart')"><svg class="rc-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21.35 10.55 20.03C5.4 15.36 2 12.27 2 8.5 2 5.41 4.42 3 7.5 3c1.74 0 3.59.94 4.5 2.35C12.91 3.94 14.76 3 16.5 3 19.58 3 22 5.41 22 8.5c0 3.77-3.4 6.86-8.55 11.53L12 21.35z"/></svg><i>{{ reactCount(rp, "heart") }}</i></button>
                  <button v-if="rp.dbId != null" class="cmt-react" :class="{ on: cmtReacted(rp, 'broken') }"
                    :disabled="!!cmtReactBusy[rp.id]" :title="t('comment.brokenT')" :aria-label="t('comment.brokenT')"
                    @click="cmtReact(rp, 'broken')"><svg class="rc-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21.35 10.55 20.03C5.4 15.36 2 12.27 2 8.5 2 5.41 4.42 3 7.5 3c1.74 0 3.59.94 4.5 2.35C12.91 3.94 14.76 3 16.5 3 19.58 3 22 5.41 22 8.5c0 3.77-3.4 6.86-8.55 11.53L12 21.35z"/><path d="M12 6.8 10.4 9.4l2.4 1.5-1.5 2.4 1.1 1.8"/></svg><i>{{ reactCount(rp, "broken") }}</i></button>
                </div>
                <!-- 轮 97：统一输入条样式（发送在右 + 自动扩行） -->
                <div v-if="!isMobileNav && repActive === cm.id + ':' + rp.id" class="cmt-input cmt-input-in">
                  <div class="cmt-input-row">
                    <n-input v-model:value="repDraft[cm.id]" type="textarea" :autosize="{ minRows: 1, maxRows: 4 }"
                      :placeholder="repPlaceholder(cm, rp)" :maxlength="MAX_LEN" />
                    <n-button type="primary" size="small" round @click="sendCmt(cm, rp)">{{ t("common.send") }}</n-button>
                    </div>
                </div>
              </div>
            </div>

            <!-- 轮 88：展开/收起回复按钮移到回复列表底部（参考主流社区「展开其他 N 条回复 ›」样式） -->
            <button v-if="repsOf(cm).length > 2" class="replies-toggle" @click="toggleReplies(cm)">
              {{ repOpen[cm.id] ? t("comment.collapseReplies") : t("comment.expandOthers", { n: repsOf(cm).length - 2 }) }}
              <i class="rt-arrow">&#8250;</i>
            </button>

            <!-- 轮 97：统一输入条样式 -->
            <div v-if="!isMobileNav && repActive === cm.id" class="cmt-input cmt-input-in">
              <div class="cmt-input-row">
                <n-input v-model:value="repDraft[cm.id]" type="textarea" :autosize="{ minRows: 1, maxRows: 4 }"
                  :placeholder="repPlaceholder(cm)" :maxlength="MAX_LEN" />
                <n-button type="primary" size="small" round @click="sendCmt(cm)">{{ t("common.send") }}</n-button>
                </div>
            </div>
          </div>

          <!-- 轮 87：一级评论未展示完 → 「查看更多评论」续 15 条（此后下滑也会自动续展） -->
          <button v-if="tops.length > shownTops.length" class="cmt-act cmt-viewmore" @click="cmtReveal += CMT_PAGE">
            {{ t("comment.viewMoreCmt") }} <i class="vm-arrow">&#8250;</i>
          </button>

          <p v-if="!comments.length && !cmtLoading" class="cmt-empty">{{ t("comment.empty") }}</p>
        </div>
        <p v-if="hint" class="sub" style="color: var(--low); font-weight: 700">{{ hint }}</p>
      </article>
    </template>

    <!-- 轮 97：评论输入固定底栏（发送常驻右侧；超一行自动扩行；回复时让位给回复弹窗条） -->
    <div v-if="!repActive" class="cmt-bar-fixed">
      <template v-if="signedIn">
        <n-input v-model:value="cmtDraft" type="textarea" :autosize="{ minRows: 1, maxRows: 4 }"
          :placeholder="t('comment.placeholder')" :maxlength="MAX_LEN" />
        <n-button type="primary" size="small" round @click="sendCmt()">{{ t("community.post") }}</n-button>
      </template>
      <router-link v-else class="bar-signin" to="/profile">{{ t("community.commentSignIn") }}</router-link>
    </div>

    <!-- 轮 91：输入条改 3 行文本域（用户反馈：单行小框没法输入），发送在右下角；Enter 换行不再误发送 -->
    <div v-if="repActive && isMobileNav" class="reply-bar">
      <n-input ref="barInput" v-model:value="repDraft[barCm ? barCm.id : '']" type="textarea" :autosize="{ minRows: 1, maxRows: 4 }"
        :placeholder="repPlaceholder(barCm, barRp)" :maxlength="MAX_LEN" />
      <div class="reply-bar-foot">
        <n-button type="primary" size="small" round @click="sendBar">{{ t("common.send") }}</n-button>
      </div>
    </div>

    <!-- 轮 87：…菜单改 document 点击收起（原全屏遮罩会被卡片堆叠上下文盖住，举报/拷贝点了没反应） -->
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
.cmt-login { font-weight: 700; }
</style>
