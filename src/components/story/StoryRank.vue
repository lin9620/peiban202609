<!-- 轮 145 · 故事榜（故事栏右栏）：推荐 / 最新 / 月赞 / 标签 四页签
 *   推荐 = 服务端「新鲜度阶梯 + 质量加权」洗牌（5 分钟一换种子）：
 *   30 天内的永远排在前面，不够时自动放宽到 90 天 / 一年 / 更早，所以池子里永远有内容。
 *   「换一批」= 在洗牌序里翻页（offset 递增）；翻到底就提示「没有新内容了」，
 *   **不再把同一批内容本地打乱冒充新的**（轮 443 用户明确要求）。
 *   标签 = 热门标签云（当期赞数 + 篇数）；点某个标签 → 下面出该标签的月赞排行。 -->
<script setup>
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { t } from "../../i18n.js";
import { RANK_TABS, periodKey, storyErrKey, shuffleStep } from "../../utils/storyRules.js";
import { storyRank } from "../../utils/story.js";
import { setStorySeed } from "../../utils/storySeed.js";

const router = useRouter();
const PAGE = 12;

const mode = ref("random");
const offset = ref(0);
const rows = ref([]);
const tagCloud = ref([]);
const activeTag = ref("");
const tagQuery = ref("");
const tagRows = ref([]);
/* 标签多起来后不再铺成一大片 pill：搜索 + 限高滚动列表，版面高度只跟 max-height 走 */
const visibleTags = computed(() => {
  const q = tagQuery.value.trim().toLowerCase();
  if (!q) return tagCloud.value;
  return tagCloud.value.filter((r) => String(r.title || "").toLowerCase().includes(q));
});
const loading = ref(false);
const err = ref("");
/* 轮 443：翻到底不再本地重排，而是弹一句「没有新内容了」，2.6 秒后自己消失 */
const noMore = ref(false);
let noMoreTimer = 0;
function showNoMore() {
  noMore.value = true;
  clearTimeout(noMoreTimer);
  noMoreTimer = setTimeout(() => { noMore.value = false; }, 2600);
}
onBeforeUnmount(() => clearTimeout(noMoreTimer));

const tabs = computed(() => RANK_TABS.map((x) => ({ mode: x.mode, label: t(x.tk) })));
const medal = (i) => (i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : String(i + 1));

function pick(data) {
  const list = Array.isArray(data) ? data : [];
  if (mode.value === "tag") { tagCloud.value = list; return; }
  rows.value = list;
}
/** 返回本次拿到的行数，供 shuffle 判断是否翻到了空页。
 *  keepOnEmpty：翻页探测专用 —— 返回空时不要把当前列表清掉，
 *  否则「换一批」会先闪一下「榜单还空着」再回填（几十毫秒也看得见）。 */
async function load({ keepOnEmpty = false } = {}) {
  loading.value = true;
  err.value = "";
  try {
    const data = await storyRank({
      mode: mode.value,
      /* 四榜主列表一律不按标签过滤；标签过滤只发生在 pickTag 的下钻请求里。
         原来这里写的是 `mode === "monthly" && activeTag.value`，但切到 monthly 时
         watch 已把 activeTag 清空 → 恒为 false，是一段永不生效的死条件。 */
      tag: null,
      period: periodKey(),
      limit: PAGE,
      offset: mode.value === "tag" ? 0 : offset.value,
    });
    const n = Array.isArray(data) ? data.length : 0;
    if (!(keepOnEmpty && n === 0)) pick(data);
    return n;
  } catch (e) {
    err.value = t(storyErrKey(e));
    if (mode.value === "tag") tagCloud.value = []; else rows.value = [];
    return 0;
  } finally {
    loading.value = false;
  }
}
/* 换一批（推荐页签专用）
 * 轮 442 修过「点了没反应」：原实现只有一句 offset += PAGE，池子恰好等于一页时
 * （当时线上 12 条 / PAGE 12）会翻到空页，榜单当场变「还空着」。
 * 轮 443 把口径改干净了：
 *   · 服务端 random 模式改成「30 天优先 + 90 天 / 一年 / 更早逐级补位」，
 *     所以池子不再是硬 30 天，内容不够会自己往后放宽 —— 这是「换一批」真正能出东西的前提；
 *   · 前端**不再本地重排**：把同一批内容打乱冒充「新的一批」是骗用户，点开还是那几篇；
 *   · 翻到底就明确提示「没有新内容了」，列表和 offset 都不动。 */
async function shuffle() {
  if (loading.value) return;
  const step = shuffleStep({ loaded: rows.value.length, page: PAGE, offset: offset.value });
  if (step.exhausted) { showNoMore(); return; }
  offset.value = step.offset;
  const n = await load({ keepOnEmpty: true });
  /* 服务端返回空 = 整库都翻完了（阶梯补位在 SQL 里已经做到底，不是 30 天卡住） */
  if (step.offset > 0 && n === 0) showNoMore();
}
watch(mode, () => {
  offset.value = 0;
  activeTag.value = "";
  tagQuery.value = "";
  tagRows.value = [];
  noMore.value = false;
  load();
});

async function pickTag(tag) {
  activeTag.value = activeTag.value === tag ? "" : tag;
  tagRows.value = [];
  if (!activeTag.value) return;
  try {
    /* 档位口径：标签下钻要的是「这个标签下有哪些故事」，不是「这个标签下本月被赞过的故事」。
       monthly 档在 SQL 里是 inner join story_likes + 当月过滤 → 一篇没被赞过的故事会整条消失，
       点进去必然空列表。latest 档同样带 s.tags && array[p_tag] 过滤，且不受点赞数影响。 */
    const data = await storyRank({ mode: "latest", tag: activeTag.value, limit: PAGE });
    tagRows.value = Array.isArray(data) ? data : [];
  } catch (e) { err.value = t(storyErrKey(e)); }
}
/* 轮 313：把榜单行当种子递给详情页（榜单行与发现联同字段）→ 点开先出标题/作者/标签，正文随后 */
function open(r) {
  if (!r || !(Number(r.id) > 0)) return;
  setStorySeed(r);
  router.push(`/story/${r.id}`);
}
load();
</script>

<template>
  <section class="st-rank">
    <!-- 标题已由 /story/rank 页头统一承担，这里不再重复「排行榜」 -->
    <div class="st-rank-tabs" role="tablist">
      <button
        v-for="x in tabs" :key="x.mode" class="st-rank-tab" :class="{ on: mode === x.mode }"
        type="button" role="tab" :aria-selected="mode === x.mode" @click="mode = x.mode">
        {{ x.label }}
      </button>
    </div>

    <!-- 标签模式：搜索 + 限高滚动列表（标签再多也不撑高版面） -->
    <div v-if="mode === 'tag'" class="st-tag-panel">
      <div class="st-tag-head">
        <label class="st-tag-search">
          <svg class="st-tag-search-ico" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="1.6" />
            <path d="m16 16 4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
          </svg>
          <input
            v-model.trim="tagQuery" type="search" class="st-tag-search-in"
            :placeholder="t('story.tagSearch')" :aria-label="t('story.tagSearch')"
          />
        </label>
        <span class="st-tag-total">{{ t("story.tagTotal", { n: visibleTags.length }) }}</span>
      </div>

      <div v-if="tagCloud.length" class="st-tag-list">
        <button
          v-for="r in visibleTags" :key="r.title" class="st-tag-row"
          :class="{ on: activeTag === r.title }" type="button"
          :aria-pressed="activeTag === r.title" @click="pickTag(r.title)">
          <span class="st-tag-name">#{{ r.title }}</span>
          <em>{{ r.view_count }}</em>
        </button>
        <p v-if="!visibleTags.length" class="st-hint st-tag-empty">{{ t("story.tagNone") }}</p>
      </div>
      <p v-else-if="!loading" class="st-hint">{{ t("story.rankEmpty") }}</p>
    </div>

    <ol v-if="mode !== 'tag'" class="st-rank-list">
      <li v-for="(r, i) in rows" :key="r.id" class="st-rank-row"
        :class="{ 'st-rank-row--top': i < 3 }" @click="open(r)">
        <span class="st-rank-no">{{ medal(i) }}</span>
        <span class="st-rank-body">
          <span class="st-rank-name">{{ r.title }}</span>
          <span class="st-rank-meta">{{ t("story.by", { name: r.nickname || t("story.anonAuthor") }) }}</span>
        </span>
        <span class="st-rank-like">♥ {{ r.like_count }}</span>
      </li>
      <li v-if="!rows.length && !loading" class="st-hint">{{ t("story.rankEmpty") }}</li>
    </ol>

    <ol v-else-if="activeTag" class="st-rank-list">
      <li v-for="(r, i) in tagRows" :key="r.id" class="st-rank-row"
        :class="{ 'st-rank-row--top': i < 3 }" @click="open(r)">
        <span class="st-rank-no">{{ medal(i) }}</span>
        <span class="st-rank-body">
          <span class="st-rank-name">{{ r.title }}</span>
          <span class="st-rank-meta">{{ t("story.by", { name: r.nickname || t("story.anonAuthor") }) }}</span>
        </span>
        <span class="st-rank-like">♥ {{ r.like_count }}</span>
      </li>
      <li v-if="!tagRows.length" class="st-hint">{{ t("story.rankEmpty") }}</li>
    </ol>

    <button
      v-if="mode === 'random'" class="st-btn st-btn--ghost st-shuffle" type="button"
      :disabled="loading" @click="shuffle">
      ↻ {{ t("story.rankShuffle") }}
    </button>
    <p v-if="noMore" class="st-hint st-no-more" role="status">{{ t("story.rankNoMore") }}</p>
    <p v-if="err" class="st-err">{{ err }}</p>
  </section>
</template>
