<!-- 轮 145 · 故事榜（故事栏右栏）：推荐 / 最新 / 月赞 / 标签 四页签
 *   推荐 = 服务端窗口内质量加权洗牌（5 分钟一换种子）；「换一批」= 在洗牌序里翻页（offset 递增），
 *   不需要改 RPC；翻到底自动回第一批。
 *   标签 = 热门标签云（当期赞数 + 篇数）；点某个标签 → 下面出该标签的月赞排行。 -->
<script setup>
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { t } from "../../i18n.js";
import { RANK_TABS, periodKey, storyErrKey } from "../../utils/storyRules.js";
import { storyRank } from "../../utils/story.js";
import { setStorySeed } from "../../utils/storySeed.js";

const router = useRouter();
const PAGE = 12;

const mode = ref("random");
const offset = ref(0);
const rows = ref([]);
const tagCloud = ref([]);
const activeTag = ref("");
const tagRows = ref([]);
const loading = ref(false);
const err = ref("");

const tabs = computed(() => RANK_TABS.map((x) => ({ mode: x.mode, label: t(x.tk) })));
const medal = (i) => (i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : String(i + 1));

function pick(data) {
  const list = Array.isArray(data) ? data : [];
  if (mode.value === "tag") { tagCloud.value = list; return; }
  rows.value = list;
}
async function load() {
  loading.value = true;
  err.value = "";
  try {
    pick(await storyRank({
      mode: mode.value,
      /* 四榜主列表一律不按标签过滤；标签过滤只发生在 pickTag 的下钻请求里。
         原来这里写的是 `mode === "monthly" && activeTag.value`，但切到 monthly 时
         watch 已把 activeTag 清空 → 恒为 false，是一段永不生效的死条件。 */
      tag: null,
      period: periodKey(),
      limit: PAGE,
      offset: mode.value === "tag" ? 0 : offset.value,
    }));
  } catch (e) {
    err.value = t(storyErrKey(e));
    if (mode.value === "tag") tagCloud.value = []; else rows.value = [];
  } finally {
    loading.value = false;
  }
}
/* 换一批（推荐页签专用）：在洗牌序里往后翻一整页；不足一页说明翻到底了 → 回第一批 */
function shuffle() {
  offset.value = rows.value.length < PAGE ? 0 : offset.value + PAGE;
  load();
}
watch(mode, () => { offset.value = 0; activeTag.value = ""; tagRows.value = []; load(); });

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
    <h2 class="st-rank-title">{{ t("story.rankTitle") }}</h2>
    <div class="st-rank-tabs" role="tablist">
      <button
        v-for="x in tabs" :key="x.mode" class="st-rank-tab" :class="{ on: mode === x.mode }"
        type="button" role="tab" :aria-selected="mode === x.mode" @click="mode = x.mode">
        {{ x.label }}
      </button>
    </div>

    <!-- 标签模式：先出标签云 -->
    <div v-if="mode === 'tag'" class="st-cloud">
      <button
        v-for="r in tagCloud" :key="r.title" class="st-cloud-tag"
        :class="{ on: activeTag === r.title }" type="button" :aria-pressed="activeTag === r.title"
        @click="pickTag(r.title)">
        #{{ r.title }} <em>{{ r.view_count }}</em>
      </button>
      <p v-if="!tagCloud.length && !loading" class="st-hint">{{ t("story.rankEmpty") }}</p>
    </div>

    <ol v-if="mode !== 'tag'" class="st-rank-list">
      <li v-for="(r, i) in rows" :key="r.id" class="st-rank-row" @click="open(r)">
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
      <li v-for="(r, i) in tagRows" :key="r.id" class="st-rank-row" @click="open(r)">
        <span class="st-rank-no">{{ medal(i) }}</span>
        <span class="st-rank-body">
          <span class="st-rank-name">{{ r.title }}</span>
          <span class="st-rank-meta">{{ t("story.by", { name: r.nickname || t("story.anonAuthor") }) }}</span>
        </span>
        <span class="st-rank-like">♥ {{ r.like_count }}</span>
      </li>
      <li v-if="!tagRows.length" class="st-hint">{{ t("story.rankEmpty") }}</li>
    </ol>

    <button v-if="mode === 'random'" class="st-btn st-btn--ghost st-shuffle" type="button" @click="shuffle">
      ↻ {{ t("story.rankShuffle") }}
    </button>
    <p v-if="err" class="st-err">{{ err }}</p>
  </section>
</template>
