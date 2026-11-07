<!-- 帖子评论区（与暖心墙卡片同款）· 轮 460
     ------------------------------------------------------------
     用户：「我的页面，点击我的帖子，没有评论啊，需要跟暖心墙那一样啊，现在什么都没有」

     事实核查：暖心墙每张帖子卡都带「说点温柔的话…」入口 + 「💬 N 条评论 ▾」+ 展开的评论列表；
     而「我的帖子」(/my-posts) 与「我的」页内嵌帖子卡只有「浏览数 / 删除」两块 —— 一个评论元素都没有。

     这里把这套补上，**不另立规则**：
       · 排序/软删/两级结构/计数口径全部调 utils/comments.js 的同一批纯函数
       · 读、写、回应、删除全部走 wall.js 与暖心墙同一个云端接口
       · 样式沿用全局 .cmt-* 类（style.css / glass.css），外观天然一致
     与详情页的分工：卡片里只露前 3 条一级评论（WALL_TOP_LIMIT），再多就「查看更多评论 →」进详情 ——
     与暖心墙卡片完全同口径，避免一页帖子把几百条评论全铺出来。
-->
<script setup>
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { t, i18n } from "../i18n.js";
import { cloud } from "../utils/supabase.js";
import { isMobileNav } from "../stores/uiStore.js";
import { swr } from "../utils/cache.js";
import {
  cmtCacheKey, cmtCacheSet, cloudFetchComments,
  cloudInsertComment, cloudToggleCommentReaction, cloudDeleteComment,
} from "../utils/wall.js";
/* 一屏多张卡各自的评论数合并成一次批量请求（见 commentCountQueue 注释） */
import { requestCommentCount, setCommentCount, peekCommentCount } from "../utils/commentCountQueue.js";
import { filterBlocked } from "../utils/userBlocks.js";
import {
  MAX_LEN, normalizeText, renderTops, renderReplies, pageReplies,
  displayCount, canDelete, wallTopComments, hasMoreComments,
  reactCount, hasReacted, toggleReact, applyCommentReactionResult, markDeleted,
} from "../utils/comments.js";
import { fmtWhen } from "../utils/wallRules.js";
import WpComposer from "./WpComposer.vue";

const props = defineProps({
  post: { type: Object, default: null },
});

const router = useRouter();
const signedIn = computed(() => !!(cloud.ready && cloud.user));
const myId = computed(() => (cloud.user && cloud.user.id) || "");
const dbId = computed(() => (props.post && props.post.dbId != null ? props.post.dbId : null));

const open = ref(false);
const rows = ref([]);          /* 该帖全部评论（一级 + 二级，含软删行，渲染时才过滤） */
const loaded = ref(false);     /* 是否已真正拉到过评论（空列表 ≠ 没拉过，两者显示口径不同） */
const cloudTotal = ref(0);     /* 云端聚合数：还没展开时用它显示「N 条评论」，不能先摆 0 */
const loading = ref(false);
const err = ref("");

/* 一级评论显示前 3 条（暖心墙同款），其余进详情 */
const tops = computed(() => wallTopComments(renderTops(rows.value)));
const hasMore = computed(() => hasMoreComments(renderTops(rows.value)));
/* 拉到过就以本地列表为准（云端刚删完就是 0）；没拉过先用云端聚合数，不能先摆 0 */
const count = computed(() => displayCount(loaded.value ? rows.value : undefined, cloudTotal.value));

const when = (ts) => fmtWhen(ts, i18n.locale);

/* ── 展开/收起 ─────────────────────────────────────────────── */
function toggle() {
  open.value = !open.value;
  if (open.value && !rows.value.length && !loading.value) loadThread();
}

/* ── 取数 ──────────────────────────────────────────────────── */
async function loadThread() {
  const id = dbId.value;
  if (id == null) return;
  loading.value = true;
  err.value = "";
  swr(
    cmtCacheKey(id),
    {
      cached: (list) => {
        if (Array.isArray(list)) { rows.value = filterBlocked(list); loaded.value = true; loading.value = false; }
      },
      fresh: (list) => {
        loading.value = false;
        if (!Array.isArray(list)) return;
        rows.value = filterBlocked(list);
        loaded.value = true;
        /* 我的回应高亮由云端后台补（wall.js 挂的 mineReady），回来后重算一次响应式 */
        if (list.mineReady) list.mineReady.then(() => { rows.value = rows.value.slice(); }).catch(() => {});
      },
      onError: () => { loading.value = false; },
    },
    /* cloudFetchComments 失败返回 null（不抛），swr 对 null 不调 hooks —— 复位塞进 fetcher */
    () => cloudFetchComments(id).then((r) => { loading.value = false; return r; }),
  );
}

/* 计数：还没展开就要显示正确的「N 条评论」（暖心墙轮 328 的口径）
 * 一屏十几张卡时不能各拉一次 —— 走 commentCountQueue 合并成一批 */
async function loadCount() {
  const id = dbId.value;
  if (id == null) return;
  const hit = peekCommentCount(id);
  if (hit !== undefined) { cloudTotal.value = hit; return; }
  const n = await requestCommentCount(id);
  if (n !== undefined && dbId.value === id) cloudTotal.value = n;
}

onMounted(() => { loadCount(); });
watch(dbId, () => {
  /* 同一张卡换了帖子（列表复用）→ 全部复位，别把上一条的评论留在屏上 */
  open.value = false;
  rows.value = [];
  loaded.value = false;
  cloudTotal.value = 0;
  err.value = "";
  loadCount();
});

/* ── 写/删之后本地计数即时同步 ────────────────────────────── */
function syncTotal() {
  const id = dbId.value;
  if (id == null) return;
  loaded.value = true;
  /* 云端聚合数口径 = 一级 + 回复的活评论条数，本地按同一口径数（软删/临时行不计） */
  cloudTotal.value = rows.value.filter((c) => c && !c.deleted && !c.pending).length;
  setCommentCount(id, cloudTotal.value);   /* 回到列表别再显示旧数 */
  cmtCacheSet(id, rows.value.filter((c) => !c.pending));
}

/* ── 发表 ──────────────────────────────────────────────────── */
const mainDraft = ref("");
const repDraft = ref("");
const repTarget = ref(null);      /* { id, dbId, name } —— 回复哪条评论 */
const barOpen = ref(false);       /* 手机端底部输入条 */

const phMain = computed(() => (repTarget.value ? t("comment.replyPh", { n: repTarget.value.name }) : t("comment.placeholder")));

async function send(text, parent) {
  const id = dbId.value;
  const body = normalizeText(text);
  if (id == null || !body) return;
  if (!signedIn.value) { err.value = t("community.commentSignIn"); return; }

  const at = parent ? (parent.at || "") : "";
  const tmp = {
    id: "t" + Date.now(), dbId: null,
    name: cloud.nickname || "Guest", text: body, ts: Date.now(),
    cloud: true, userId: myId.value,
    parentId: parent ? parent.id : null, replyTo: at,
    reacts: { heart: 0, broken: 0 }, myReacts: [], pending: true,
  };
  const before = rows.value;
  rows.value = [...rows.value, tmp];
  if (!open.value) open.value = true;

  try {
    const created = await cloudInsertComment(id, body, cloud.nickname || "Guest", {
      parentId: parent ? parent.dbId : null,
      replyToName: at,
    });
    if (!created) throw new Error("insert-failed");
    rows.value = rows.value.map((c) => (c.id === tmp.id ? created : c));
    syncTotal();
  } catch (e) {
    rows.value = before;                          /* 回滚乐观行 */
    err.value = t("comment.fail");
    setTimeout(() => { err.value = ""; }, 3200);
    return;
  }
  /* 成功后清空对应草稿 + 收起回复态 */
  if (parent) {
    repDraft.value = "";
    repTarget.value = null;
    if (parent.id) repsOpen.value = { ...repsOpen.value, [parent.id]: true };
  } else {
    mainDraft.value = "";
  }
  barOpen.value = false;
}

function sendMain() {
  send(barOpen.value ? barText.value : mainDraft.value, null);
}
function sendReply(cm) {
  /* at 只有「回复某条二级回复」时才有值 —— 回复一级评论视觉上已经挨着作者，不再 @ 一遍（暖心墙同口径） */
  send(barOpen.value ? barText.value : repDraft.value, { id: cm.id, dbId: cm.dbId, name: cm.name, at: cm.at || "" });
}

/* 手机底部条的文字：主评论与「回复某条」共用一条，切目标时换草稿、关闭时写回 */
const barText = ref("");
function openBar(cm = null) {
  if (!signedIn.value) { err.value = t("community.commentSignIn"); open.value = true; return; }
  repTarget.value = cm ? { id: cm.id, dbId: cm.dbId, name: cm.name, at: cm.at || "" } : null;
  barText.value = cm ? repDraft.value : mainDraft.value;
  barOpen.value = true;
}
function closeBar() {
  if (repTarget.value) repDraft.value = barText.value; else mainDraft.value = barText.value;
  barOpen.value = false;
}

/* ── 回复框（桌面就地）────────────────────────────────────── */
const replyBox = ref({});      /* 哪条评论下面开着回复框 */
/* atName 非空 = 回复的是某条二级回复（要 @ 它）；空 = 回复一级评论（不 @） */
function openReply(cm, atName = "") {
  if (!signedIn.value) { err.value = t("community.commentSignIn"); return; }
  if (isMobileNav.value) { openBar({ ...cm, name: atName || cm.name, at: atName || "" }); return; }
  repTarget.value = { id: cm.id, dbId: cm.dbId, name: atName || cm.name, at: atName || "" };
  replyBox.value = { ...replyBox.value, [cm.id]: true };
  repDraft.value = "";
  nextTick(() => {
    const el = document.getElementById("myp-cmtrep-" + (cm.dbId || cm.id));
    if (el && el.scrollIntoView) el.scrollIntoView({ block: "center", behavior: "smooth" });
  });
}
function closeReply(cm) {
  replyBox.value = { ...replyBox.value, [cm.id]: false };
  if (repTarget.value && repTarget.value.id === cm.id) repTarget.value = null;
}

/* ── 二级回复展开 ─────────────────────────────────────────── */
const repShown = ref({});
const repsOpen = ref({});       /* 哪条一级评论的回复列表已展开（区别于上面的回复输入框） */
const repliesOf = (cm) => renderReplies(rows.value, cm.id);
const visibleReplies = (cm) => pageReplies(repliesOf(cm), !!repsOpen.value[cm.id], repShown.value[cm.id]);
const replyHidden = (cm) => (repsOpen.value[cm.id] ? Math.max(0, repliesOf(cm).length - visibleReplies(cm).length) : 0);
function toggleReplies(cm) {
  repsOpen.value = { ...repsOpen.value, [cm.id]: !repsOpen.value[cm.id] };
  repShown.value = { ...repShown.value, [cm.id]: 30 };
}
/* 「N 条回复」一颗按钮三种状态：展开 → 再放一批 → 收起（与暖心墙轮 383 的手感一致） */
function onReplyToggle(cm) {
  if (!repsOpen.value[cm.id]) { toggleReplies(cm); return; }
  if (replyHidden(cm) > 0) { moreReplies(cm); return; }
  toggleReplies(cm);
}
function moreReplies(cm) {
  repShown.value = { ...repShown.value, [cm.id]: (repShown.value[cm.id] || 30) + 30 };
}

/* ── 回应（❤️ / 💔）───────────────────────────────────────── */
async function react(cm, kind) {
  if (!signedIn.value || cm.dbId == null) return;
  const on = !hasReacted(cm, kind);
  rows.value = rows.value.map((c) => (c.id === cm.id ? toggleReact(c, kind, on) : c));
  const res = await cloudToggleCommentReaction(cm.dbId, kind);
  if (!res) {
    rows.value = rows.value.map((c) => (c.id === cm.id ? toggleReact(c, kind, !on) : c));
    return;
  }
  rows.value = rows.value.map((c) => (c.id === cm.id ? applyCommentReactionResult(c, kind, res) : c));
}

/* ── 删除自己的评论（软删：留墓碑给它的回复，与暖心墙轮 285 同口径） ── */
const canDel = (cm) => !!(cm && !cm.pending && cm.dbId != null
  && canDelete(cm, cloud.nickname || "", myId.value));

async function delCmt(cm) {
  const before = rows.value;
  rows.value = markDeleted(rows.value, cm.id);
  const done = await cloudDeleteComment(cm.dbId);
  if (!done) { rows.value = before; return; }
  syncTotal();
}

/* ── 进详情看全部评论 ─────────────────────────────────────── */
function goDetail() {
  if (dbId.value == null) return;
  router.push({ path: `/post/${dbId.value}` });
}
function goProfile(cm) {
  if (!cm || !cm.userId) return;
  router.push({ path: `/u/${cm.userId}` });
}
</script>

<template>
  <div class="post-cmts">
    <!-- 桌面：卡内主评论框（暖心墙轮 109 同位：浏览数/删除之下、评论按钮之上） -->
    <div v-if="!isMobileNav" class="cmt-input cmt-input-top">
      <div v-if="signedIn" class="cmt-input-row">
        <WpComposer v-model="mainDraft" :placeholder="t('comment.placeholder')" :maxlength="MAX_LEN" @send="sendMain" />
      </div>
      <router-link v-else class="bar-signin" to="/profile">{{ t("comment.barSignIn") }}</router-link>
    </div>

    <!-- 手机：卡内占位条（点击弹底部输入条，与暖心墙一致） -->
    <div v-if="isMobileNav" class="cmt-entry" @click="openBar()">
      {{ t("comment.placeholder") }}
    </div>

    <div class="cmt-toggle" @click="toggle">
      <span class="cmt-ico">&#128172;</span> {{ t("comment.count", { n: count }) }}
      <span class="cmt-caret" :class="{ open: open }">&#9662;</span>
    </div>

    <div v-if="open" class="cmt-box">
      <p v-if="err" class="cmt-empty" style="color: var(--low); font-weight: 700">{{ err }}</p>
      <p v-if="loading && !rows.length" class="cmt-empty">{{ t("community.loading") }}</p>
      <p v-else-if="!loading && !tops.length" class="cmt-empty">{{ t("comment.empty") }}</p>

      <div v-for="cm in tops" :key="cm.id" class="cmt-item">
        <template v-if="!cm.deleted">
          <div class="cmt-head">
            <b :class="{ clickable: !!cm.userId }" @click="goProfile(cm)">{{ cm.name }}</b>
            <button v-if="canDel(cm)" class="cmt-del" :title="t('common.delete')" @click.stop="delCmt(cm)">×</button>
          </div>
          <p class="cmt-text">{{ cm.text }}</p>
          <div class="cmt-acts">
            <span class="cmt-time">{{ when(cm.ts) }}</span>
            <button class="cmt-act" @click="openReply(cm)">{{ t("comment.reply") }}</button>
            <button v-if="cm.dbId != null" class="cmt-react t-like" :class="{ on: hasReacted(cm, 'heart') }"
              :title="t('comment.likeT')" :aria-label="t('comment.likeT')" @click="react(cm, 'heart')">
              <span class="t-like-icon">
                <svg class="rc-ico t-like-heart" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21.35 10.55 20.03C5.4 15.36 2 12.27 2 8.5 2 5.41 4.42 3 7.5 3c1.74 0 3.59.94 4.5 2.35C12.91 3.94 14.76 3 16.5 3 19.58 3 22 5.41 22 8.5c0 3.77-3.4 6.86-8.55 11.53L12 21.35z"/></svg>
              </span><i>{{ reactCount(cm, "heart") }}</i>
            </button>
            <button v-if="cm.dbId != null" class="cmt-react t-like" :class="{ on: hasReacted(cm, 'broken') }"
              :title="t('comment.brokenT')" :aria-label="t('comment.brokenT')" @click="react(cm, 'broken')">
              <span class="t-like-icon">
                <svg class="rc-ico t-like-heart" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21.35 10.55 20.03C5.4 15.36 2 12.27 2 8.5 2 5.41 4.42 3 7.5 3c1.74 0 3.59.94 4.5 2.35C12.91 3.94 14.76 3 16.5 3 19.58 3 22 5.41 22 8.5c0 3.77-3.4 6.86-8.55 11.53L12 21.35z"/><path d="M12 6.8 10.4 9.4l2.4 1.5-1.5 2.4 1.1 1.8"/></svg>
              </span><i>{{ reactCount(cm, "broken") }}</i>
            </button>
          </div>
        </template>
        <p v-else class="cmt-text" style="color: var(--low); font-style: italic">{{ t("comment.deleted") }}</p>

        <!-- 桌面：回复框紧跟这条评论（暖心墙轮 110 同位）。
             放在「活评论 / 墓碑」两支之外 —— 墓碑下活着的二级回复点「回复」也要能回
             （暖心墙轮 298 的坑：把回复入口整块拦在 !cm.deleted 里，点 cde 的回复像没反应）。 -->
        <div v-if="replyBox[cm.id] && !isMobileNav" :id="'myp-cmtrep-' + (cm.dbId || cm.id)" class="cmt-input cmt-input-rep">
          <div class="cmt-input-row">
            <WpComposer v-model="repDraft" :placeholder="phMain" :maxlength="MAX_LEN" @send="sendReply(repTarget || cm)" />
          </div>
          <button class="cmt-act" type="button" @click="closeReply(cm)">{{ t("common.close") }}</button>
        </div>

        <!-- 二级回复：默认前 2 条，展开每批 30 -->
        <div v-if="repliesOf(cm).length" class="cmt-reps">
          <div v-for="rp in visibleReplies(cm)" :key="rp.id" class="cmt-rep">
            <div class="cmt-head">
              <b><span :class="{ clickable: !!rp.userId }" @click="goProfile(rp)">{{ rp.name }}</span><span class="cmt-at" v-if="rp.replyTo">@{{ rp.replyTo }}</span></b>
              <button v-if="canDel(rp)" class="cmt-del" :title="t('common.delete')" @click.stop="delCmt(rp)">×</button>
            </div>
            <p class="cmt-text">{{ rp.text }}</p>
            <div class="cmt-acts">
              <span class="cmt-time">{{ when(rp.ts) }}</span>
              <button class="cmt-act" @click="openReply(cm, rp.name)">{{ t("comment.reply") }}</button>
              <button v-if="rp.dbId != null" class="cmt-react t-like" :class="{ on: hasReacted(rp, 'heart') }"
                :title="t('comment.likeT')" :aria-label="t('comment.likeT')" @click="react(rp, 'heart')">
                <span class="t-like-icon">
                  <svg class="rc-ico t-like-heart" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21.35 10.55 20.03C5.4 15.36 2 12.27 2 8.5 2 5.41 4.42 3 7.5 3c1.74 0 3.59.94 4.5 2.35C12.91 3.94 14.76 3 16.5 3 19.58 3 22 5.41 22 8.5c0 3.77-3.4 6.86-8.55 11.53L12 21.35z"/></svg>
                </span><i>{{ reactCount(rp, "heart") }}</i>
              </button>
            </div>
          </div>
          <!-- 收起态本来就露全 2 条以内，没有剩余就不给「展开 0 条」这种假按钮 -->
          <button v-if="repsOpen[cm.id] || repliesOf(cm).length > 2"
            class="cmt-act replies-toggle" type="button" @click="onReplyToggle(cm)">
            {{ repsOpen[cm.id]
              ? (replyHidden(cm) > 0 ? t("comment.moreReplies", { n: Math.min(30, replyHidden(cm)) }) : t("comment.collapseReplies"))
              : (repliesOf(cm).length > 30 ? t("comment.expandBatch", { n: 30 }) : t("comment.expandOthers", { n: Math.max(0, repliesOf(cm).length - 2) })) }}
          </button>
        </div>
      </div>

      <button v-if="hasMore" class="cmt-act" type="button" style="align-self: flex-start" @click="goDetail">
        {{ t("comment.viewMoreCmt") }} →
      </button>
    </div>

    <!-- 手机底部输入条（与暖心墙同款：fixed 在底栏之上，Teleport 到 body 免受卡片/路由过渡的 transform 影响） -->
    <Teleport to="body">
      <div v-if="isMobileNav && barOpen" class="cmt-main-bar">
        <WpComposer v-model="barText" :placeholder="phMain" :maxlength="MAX_LEN"
          @send="repTarget ? sendReply(repTarget) : sendMain()" />
        <button class="cmt-act" type="button" @click="closeBar">{{ t("common.close") }}</button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* 本组件只做少量「放进帖子卡里」的修正，视觉主体全部沿用全局 .cmt-* 类 */
.post-cmts { display: block; }
/* 评论条在卡里跟浏览数同一行距，别把卡片撑太松 */
.post-cmts .cmt-toggle { margin-top: 6px; }
.post-cmts .cmt-toggle:hover { transform: none; }
/* 卡内「关闭」按钮在底部条里靠右站立 */
.cmt-main-bar .cmt-act { flex: none; align-self: center; padding: 6px 10px; }
/* 卡内删除 × 与 ⋯ 同一枚小按钮口径 */
.post-cmts .cmt-del { margin-left: auto; }
</style>
