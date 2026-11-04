<!-- 轮 145 · 故事阅读页（/story/:id）：轻 Markdown 排版 + 点赞（服务端权威）+ 标签 / 相似推荐。
 * Worker 侧 /story/:id 深链会先查存在性（查无维持真 404，软 404 红线），此处只处理「载入后已下架」。 -->
<script setup>
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { t } from "../i18n.js";
import { isMobileNav } from "../stores/uiStore.js";
import { useStoryBack } from "../utils/storyBack.js";
import { renderLiteMd, applyStoryToggle } from "../utils/storyRules.js";
import {
  storyGet, storyAddView, storyRank, canStory, storyErrKey,
  storySetLike, storySetBookmark, storyMyFlags,
} from "../utils/story.js";
import { cacheKey, swr, cacheMerge } from "../utils/cache.js";
import { createWriteQueue } from "../utils/reactQueue.js";
import { createTapGuard } from "../utils/tapGuard.js";
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
/* 轮 321：点赞/收藏改成「乐观更新」——点击即刻翻转本地状态（按钮当场变色、计数当场 ±1），
 * 落库由 writeQueue 串行 + 幂等「设置」语义收敛；失败才回滚。
 * 原来那两个「请求中」flag（liking/marking）随之作废：按钮不再 :disabled，连点继续跟手。 */
/* 就近提示（轮 321）：错误不再只丢到页面底部那条 err —— 点赞/收藏失败时
 * 提示要出现在按钮旁边，否则用户根本看不到「刚才那次没成」。 */
const actErr = ref("");
const err = ref("");
const related = ref([]);

/* 轮 321：写操作收敛器（与墙贴 CommunityView 同一套 reactQueue）。
 * claim → 乐观翻转 → push(落库) → 响应回来 isLatest 才回写权威值。
 * 同一把 key 串行：连点不会并发撞车；旧响应作废：先发后到的响应不回写覆盖新意图。 */
const writeQueue = createWriteQueue();
/* 用户拍板 A：同一颗按钮 350ms 内的第二下直接丢弃（点赞/收藏各一把 key）。 */
const tapGuard = createTapGuard(350);

/* 轮 321：等待落库确认期间的本地乐观态（key → 目标态）。
 * 为什么要留一份：详情页整篇走 SWR，后台 fresh 回来的数据里 liked/marked 还是旧值，
 * 直接覆盖会把用户刚点的按钮闪回未点赞 —— 合并时把「还没确认的乐观态」叠回去。 */
const pendingFlags = ref({});

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
  actErr.value = "";
  /* 换篇了：上一份的「待确认乐观态」不能带过来（会盖到新篇的赞/藏上） */
  if (!row.value || row.value.id !== id) pendingFlags.value = {};
  related.value = [];
  /* 轮 313：整篇进 SWR（键带用户域 —— 行里有 liked/marked 属个人信息，换账号不串）。
   * 命中缓存 = 二次点开同一篇几乎零等待；没命中 = 种子先把头部画出来，正文等这一次请求。 */
  await swr(
    cacheKey("story", id, myId.value),
    {
      /* 轮 321：SWR 回来的数据里 liked/marked 可能还是旧值（用户刚点过、服务端还没落库完），
         直接覆盖会把按钮闪回未点赞 → 合并时把「待确认的乐观态」叠回去。 */
      cached: (d) => { if (d) { row.value = mergePending(d); ready.value = true; loading.value = false; } },
      fresh: (d) => { if (d) { row.value = mergePending(d); ready.value = true; } },
      /* 无缓存且拉失败 = 原来的错误口径；有种子时把种子留在屏上（标题还在，比整页跳没强） */
      onError: (e) => { err.value = t(storyErrKey(e)); if (!seed) row.value = null; },
    },
    () => storyGet(id),
  );
  loading.value = false;
  if (ready.value && row.value) {
    loadRelated();
    storyAddView(id).catch(() => {});     /* 浏览计数失败无声（不打扰阅读） */
    loadFlags(id);                       /* 补收藏初态（story_get 未必带 marked） */
  } else if (!err.value) {
    /* story_get 回空 = 未发布/已下架：落回「这篇不在了」（种子行不能继续挂着） */
    row.value = null;
  }
}

/**
 * 补「我赞了/收藏了哪些」初态（轮 321）。
 * 为什么需要：服务端 story_get 早期版本只带 liked、不带 marked → 收藏星永远不亮；
 * 批 3 迁移跑过后 story_get 已自带 marked，这里就只是兜底（多一次很轻的往返）。
 * 拿不到（老库 + 迁移没跑）→ 保持原样，不影响点赞/收藏本身。
 */
async function loadFlags(id) {
  try {
    const flags = await storyMyFlags([id]);
    if (!flags || !flags.length || !row.value || row.value.id !== id) return;
    const f = flags[0];
    const patch = {};
    if (typeof f.liked === "boolean") patch.liked = f.liked;
    if (typeof f.marked === "boolean") patch.marked = f.marked;
    if (!Object.keys(patch).length) return;
    /* 别盖掉用户刚点、还没落库确认的乐观态 */
    const merged = mergePending({ ...row.value, ...patch });
    row.value = merged;
    syncCache({ liked: merged.liked, marked: merged.marked });
  } catch (e) { /* 初态拿不到：不影响主流程 */ }
}

/* 轮 321：等待落库确认期间，本地乐观态（key → 目标态）已在上方声明（pendingFlags）。

/**
 * 把「还没落库确认的乐观态」叠到服务端行上（幂等：服务端已经是目标态时不会重复加计数）。
 */
function mergePending(r) {
  const p = pendingFlags.value;
  if (!r || !p || !Object.keys(p).length) return r;
  let out = r;
  for (const k of Object.keys(p)) {
    out = applyStoryToggle(out, k, k === "liked" ? "like_count" : null, p[k]);
  }
  return out;
}

/* ── 点赞/收藏（轮 321：乐观更新 + 幂等落库 + 失败回滚）────────────────
 * 旧写法的问题（用户实测「点了没反应」）：
 *   ① 等服务端 RPC 回来才改 UI → 跨境弱网 0.5~3s 里按钮被 :disabled 锁死、外观一点不变；
 *   ② 连点第二次被 disabled 吞掉 → 用户以为功能坏了；
 *   ③ story_get 不带 marked → 收藏星永远不亮。
 * 新写法：
 *   点一下 → 本地立刻翻转（按钮当场变色、计数当场 ±1）→ 落库按 storyId 串行，
 *   服务端用幂等的「设置」语义（story_set_like / story_set_bookmark），
 *   重复执行结果一致；失败才回滚到服务端最后确认的状态，并在按钮旁提示。
 */

/** 把本地乐观态写回 SWR 快照（下次进详情页不会又变回旧样） */
function syncCache(patch) {
  const id = row.value && row.value.id;
  if (id == null) return;
  cacheMerge(cacheKey("story", id, myId.value), patch);
}

/**
 * 通用「开关型」操作（点赞 / 收藏共用一套）。
 * @param {string} key   开关字段名（liked / marked）
 * @param {string} countKey 计数字段名（收藏无 → null）
 * @param {Function} setOn 落库函数：设成目标态，返回 { ok, count }
 */
function toggleNow(key, countKey, setOn) {
  if (!signedIn.value || !row.value) return;
  const id = row.value.id;
  const qKey = `story:${id}:${key}`;
  /* 用户拍板 A：同一篇的点赞/收藏，350ms 内第二下直接丢弃（不改 UI、不入队、不发请求）。 */
  if (!tapGuard.accept(qKey)) return;
  const target = !row.value[key];          /* 本次意图：翻到哪个态 */
  const seq = writeQueue.claim(qKey);
  const before = { [key]: !!row.value[key] };   /* 回滚用的服务端确认态 */
  if (countKey) before[countKey] = Number(row.value[countKey]) || 0;

  /* ① 乐观翻转：当场生效，不等网络 */
  row.value = applyStoryToggle(row.value, key, countKey, target);
  pendingFlags.value = { ...pendingFlags.value, [key]: target };
  syncCache({ [key]: row.value[key], ...(countKey ? { [countKey]: row.value[countKey] } : {}) });
  actErr.value = "";

  /* ② 落库：同 key 串行；响应回来只有「还是最新意图」才回写 */
  writeQueue.push(qKey, async () => {
    try {
      const r = await setOn(id, target);
      if (!writeQueue.isLatest(qKey, seq)) return;          /* 已被更新的点击取代 → 不回写 */
      /* 服务端已确认这份乐观态 → 撤掉「待确认」标记（后到的 SWR 数据可以直接用） */
      const next = { ...pendingFlags.value };
      delete next[key];
      pendingFlags.value = next;
      /* 服务端给了权威计数就用它（并发点赞时更准） */
      if (r && r.count != null && countKey && row.value && row.value.id === id) {
        row.value = { ...row.value, [countKey]: Number(r.count) || 0 };
        syncCache({ [countKey]: row.value[countKey] });
      }
    } catch (e) {
      if (!writeQueue.isLatest(qKey, seq)) return;
      /* 失败回滚：回到服务端最后确认的状态（别写到别的故事上 —— 期间可能已换页） */
      if (row.value && row.value.id === id) {
        row.value = { ...row.value, ...before };
        syncCache(before);
      }
      const next = { ...pendingFlags.value };
      delete next[key];
      pendingFlags.value = next;
      actErr.value = t(storyErrKey(e));
      err.value = actErr.value;
    }
  });
}

/** 点赞/取消赞（乐观） */
function like() {
  return toggleNow("liked", "like_count", storySetLike);
}

/** 收藏/取消（乐观；服务端幂等设置语义，主键防重） */
function mark() {
  return toggleNow("marked", null, storySetBookmark);
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
             原来直接用 st-btn → 未点赞也是实心橙，与「已点赞」只差一个色阶，视觉上分不出来。
             轮 321：不再 :disabled —— 乐观更新后按钮立刻响应，连点继续跟手
             （旧写法在弱网下把按钮锁死 0.5~3s，用户看到的就是「点了没反应」）。 -->
        <button class="st-btn st-btn--ghost" :class="{ 'st-btn--on': row.liked }" type="button" @click="like">
          ♥ {{ row.liked ? t("story.liked") : t("story.like") }} {{ row.like_count }}
        </button>
        <button
          class="st-btn st-btn--ghost st-btn--mark" :class="{ 'st-btn--on': row.marked }" type="button"
          @click="mark"
        >★ {{ row.marked ? t("story.marked") : t("story.mark") }}</button>
        <span class="st-hint">{{ t("story.stats", { likes: row.like_count, views: row.view_count }) }}</span>
      </footer>
      <!-- 轮 321：点赞/收藏失败提示就近显示（别只丢到页面底部，用户看不到） -->
      <p v-if="actErr" class="st-err st-err--near">{{ actErr }}</p>
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
