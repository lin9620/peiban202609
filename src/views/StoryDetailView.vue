<!-- 轮 145 · 故事阅读页（/story/:id）：轻 Markdown 排版 + 点赞（服务端权威）+ 标签 / 相似推荐。
 * Worker 侧 /story/:id 深链会先查存在性（查无维持真 404，软 404 红线），此处只处理「载入后已下架」。 -->
<script setup>
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { t } from "../i18n.js";
import { isMobileNav } from "../stores/uiStore.js";
import { useStoryBack } from "../utils/storyBack.js";
import { renderLiteMd } from "../utils/storyRules.js";
import {
  storyGet, storyToggleLike, storyAddView, storyRank, canStory, storyErrKey, storyToggleBookmark,
} from "../utils/story.js";
import { cacheKey, swr } from "../utils/cache.js";
import { cloud } from "../utils/supabase.js";
import { takeStorySeed, setStorySeed } from "../utils/storySeed.js";
import StoryComments from "../components/story/StoryComments.vue";
import StoryShell from "../components/story/StoryShell.vue";

const route = useRoute();
const router = useRouter();
/* 轮 313：点卡片时列表把那一行当种子递过来 —— 首帧就有标题/作者/标签，正文等 story_get 回来补。
 * setup 就取（不能等到 onMounted 的 load()），否则第一帧仍是空的，等于没提速。 */
const seed0 = takeStorySeed(route.params.id);
const row = ref(seed0);
const ready = ref(!seed0);          /* 权威整行是否到位：种子行没有正文/点赞态，别拿默认值冒充 */
const loading = ref(!seed0);
const liking = ref(false);
const marking = ref(false);
const err = ref("");
const related = ref([]);

const signedIn = computed(() => canStory());
const myId = computed(() => (cloud.user && cloud.user.id) || "");
const html = computed(() => renderLiteMd(row.value ? row.value.body : ""));
const day = (s) => String(s || "").slice(0, 10);
const author = computed(() => (row.value && row.value.nickname) || t("story.anonAuthor"));

/* 轮 313：头部那一行由各段拼出来 —— 种子行可能只有标题（如相关推荐那几行只带 title/nickname），
 * 缺哪段就不拼哪段，不留「· ·」这种空洞。整行到齐时与改动前逐字一致。 */
const metaText = computed(() => {
  const r = row.value || {};
  const segs = [t("story.by", { name: author.value })];
  if (r.published_at) segs.push(day(r.published_at));
  if (r.read_minutes != null) segs.push(t("story.readTime", { n: r.read_minutes }));
  if (r.word_count != null) segs.push(t("story.chars", { n: r.word_count }));
  return segs.join(" · ");
});

async function loadRelated() {
  related.value = [];
  const tag = row.value && Array.isArray(row.value.tags) ? row.value.tags[0] : "";
  if (!tag) return;
  try {
    const data = await storyRank({ mode: "monthly", tag, limit: 4 });
    related.value = (data || []).filter((r) => r.id !== row.value.id).slice(0, 3);
  } catch (e) { /* 推荐失败不影响阅读 */ }
}

async function load() {
  const id = Number(route.params.id);
  const seed = takeStorySeed(id);        /* 详情页内换篇（相关推荐点击）也吃得上种子 */
  if (seed) { row.value = seed; ready.value = false; }
  loading.value = !row.value;
  err.value = "";
  related.value = [];
  /* 轮 313：整篇进 SWR（键带用户域 —— 行里有 liked/marked 属个人信息，换账号不串）。
   * 命中缓存 = 二次点开同一篇几乎零等待；没命中 = 种子先把头部画出来，正文等这一次请求。 */
  await swr(
    cacheKey("story", id, myId.value),
    {
      cached: (d) => { if (d) { row.value = d; ready.value = true; loading.value = false; } },
      fresh: (d) => { if (d) { row.value = d; ready.value = true; } },
      /* 无缓存且拉失败 = 原来的错误口径；有种子时把种子留在屏上（标题还在，比整页跳没强） */
      onError: (e) => { err.value = t(storyErrKey(e)); if (!seed) row.value = null; },
    },
    () => storyGet(id),
  );
  loading.value = false;
  if (ready.value && row.value) {
    loadRelated();
    storyAddView(id).catch(() => {});     /* 浏览计数失败无声（不打扰阅读） */
  } else if (!err.value) {
    /* story_get 回空 = 未发布/已下架：落回「这篇不在了」（种子行不能继续挂着） */
    row.value = null;
  }
}

async function like() {
  if (!signedIn.value || !row.value || liking.value) return;
  liking.value = true;
  try {
    const on = await storyToggleLike(row.value.id);
    row.value.liked = !!on;
    row.value.like_count = Math.max(0, (row.value.like_count || 0) + (on ? 1 : -1));
  } catch (e) {
    err.value = t(storyErrKey(e));
  } finally {
    liking.value = false;
  }
}

/** 收藏/取消：服务端权威（主键防重），本地只翻转那颗星 */
async function mark() {
  if (!signedIn.value || !row.value || marking.value) return;
  marking.value = true;
  try {
    row.value.marked = !!(await storyToggleBookmark(row.value.id));
  } catch (e) {
    err.value = t(storyErrKey(e));
  } finally {
    marking.value = false;
  }
}

/* 轮 313：相关推荐那几行只带 id/标题/作者，也够把详情页头部先画出来（缺的段模板自己略过） */
function openRelated(r) {
  if (!r || r.id == null) return;
  setStorySeed(r);
  router.push(`/story/${r.id}`);
}

/* ── 返回：一律回发现页，不用router.back() ──
 * 物理返回键在 App.vue 里对非ROOT_VIEWS 一律 router.back()，而/story 是独立路由
 * （不在 ROOT_VIEWS 里），back() 会退回浏览历史的上一页 —— 往往是你之前待过的首页今日/漂流瓶联，
 * 于是「详情页返回跑到了今日或漂流瓶」。这里改用共享的 useStoryBack：
 * replace 到 /story，既修正落点，又不留多余历史记录（连按多次返回不会一层层回退）。
 * mine / rank 页共用同一份逻辑，避免三处各写一遍监听、以后只改一处。 */
const { storyBack: back } = useStoryBack(router, "/story");
onMounted(load);
/* 轮 313：用户域也进依赖 —— 冷启动深链（App 被通知/外链直接拉进 /story/:id）时 setup 阶段登录态
 * 还没落位、缓存键不带用户域；登录态一到就按带域的键重取一次，点赞/收藏态才是本人的。
 * 普通路径（在 App 里点卡片）myId 早就稳定，不会多打一枪。 */
watch([() => route.params.id, myId], load);
</script>

<template>
  <StoryShell active="story">
    <div class="story-read">
      <!-- 轮 235：**App 端去掉这个「回故事栏」按钮** —— App 的返回走物理返回键/手势，
           左上角再挂一个返回钮不符合 App 的操作逻辑（用户点名去掉）。
           桌面端保留（桌面没有物理返回键，只能点它）。 -->
      <button v-if="!isMobileNav" class="st-link" type="button" @click="back">← {{ t("story.backToHall") }}</button>

    <article v-if="row" class="st-read-card">
      <h1 class="st-read-title">{{ row.title }}</h1>
      <p class="st-read-meta">{{ metaText }}</p>
      <p class="st-card-tags">
        <span v-for="tg in (row.tags || [])" :key="tg" class="st-tag-sm">#{{ tg }}</span>
      </p>

      <!-- 轮 313：正文没回来前先把这一格占住（种子只带列表字段，没有 body）。
           有缓存整行时 ready=true，第一帧就是完整正文，与改动前一致。 -->
      <div v-if="ready" class="st-read-body" v-html="html"></div>
      <p v-else class="st-hint">{{ t("story.loadingBody") }}</p>
      <p v-if="ready && !String(row.body || '').trim()" class="st-hint">{{ t("story.emptyBody") }}</p>

      <footer v-if="ready" class="st-read-foot">
        <!-- 这两个是「开关型」按钮：默认 ghost（透明底），操作过才实心。
             原来直接用 st-btn → 未点赞也是实心橙，与「已点赞」只差一个色阶，视觉上分不出来。 -->
        <button class="st-btn st-btn--ghost" :class="{ 'st-btn--on': row.liked }" type="button" :disabled="liking || !signedIn" @click="like">
          ♥ {{ row.liked ? t("story.liked") : t("story.like") }} {{ row.like_count }}
        </button>
        <button
          class="st-btn st-btn--ghost st-btn--mark" :class="{ 'st-btn--on': row.marked }" type="button"
          :disabled="marking || !signedIn" @click="mark"
        >★ {{ row.marked ? t("story.marked") : t("story.mark") }}</button>
        <span class="st-hint">{{ t("story.stats", { likes: row.like_count, views: row.view_count }) }}</span>
      </footer>
      <p v-if="!signedIn" class="st-hint">{{ t("story.loginNeeded") }}</p>

      <StoryComments v-if="row.status === 'published'" :story-id="row.id" />
    </article>

    <p v-else-if="!loading" class="st-hint">{{ t("story.notFound") }}</p>

    <section v-if="related.length" class="st-related">
      <h2 class="st-rank-title">{{ t("story.related") }}</h2>
      <ul class="st-rank-list">
        <li v-for="r in related" :key="r.id" class="st-rank-row" @click="openRelated(r)">
          <span class="st-rank-body">
            <span class="st-rank-name">{{ r.title }}</span>
            <span class="st-rank-meta">{{ t("story.by", { name: r.nickname || t("story.anonAuthor") }) }}</span>
          </span>
          <span class="st-rank-like">♥ {{ r.like_count }}</span>
        </li>
      </ul>
    </section>

    <p v-if="err" class="st-err">{{ err }}</p>
    </div>
  </StoryShell>
</template>
