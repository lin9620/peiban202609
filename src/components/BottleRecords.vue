<script setup>
import { computed, ref, watch, onMounted, onBeforeUnmount, nextTick } from "vue";
import { useRoute } from "vue-router";
import { t } from "../i18n.js";
import { cloud } from "../utils/supabase.js";
import { bottleRecords, bottleChatDecide, bottleChatState, bottleErrKey, sortBottleMine, bottlePendingCount, bottleLetterExcerpt } from "../utils/bottle.js";
/* 轮 338：记录 SWR —— 上次的列表先画，网络回来再覆盖（key 不占用 `bottle:` 前缀） */
import { cacheKey, cachePeek, cacheSet } from "../utils/cache.js";
/* 轮 319：记录卡长文本折叠（与 BottleView 同款口径） */
import { needsFold, foldKey, isOverflowing } from "../utils/foldText.js";
import { refreshBadge } from "../stores/badgeStore.js";

const emit = defineEmits(["open", "pending"]);
const route = useRoute();
const userId = computed(() => cloud.user?.id || "");
const focusId = computed(() => typeof route.query.bottle === "string" ? route.query.bottle : "");
const PAGE = 30;
const ALL_LIMIT = 200;   /* 「我发布的」一次取全量（沿用 /bottle 页口径），才能把待决定的信全局置顶 */
const rows = ref([]);
const mineAll = ref([]);
const focused = ref(null);
/* 轮 70：区分「我发布的 / 我捞到的」——按钮切换（默认我发布的）；深链信件不受页签限制 */
const mine = ref(true);
const loading = ref(false);
const busy = ref("");
const error = ref("");
const more = ref(false);
let offset = 0;
let generation = 0;
let timer;
let errAt = 0;   /* 轮 338：上次出错时刻（自动刷新冷却用） */
const pendingCount = computed(() => bottlePendingCount(mineAll.value, userId.value));
watch(pendingCount, (n) => emit("pending", n), { immediate: true });
const state = (row) => bottleChatState(row, userId.value);
const displayed = computed(() => {
  if (!focused.value) return rows.value;
  const f = focused.value;
  const rest = rows.value.filter((r) => r.id !== f.id);
  if (state(f) === "choose") return [f, ...rest];
  /* 轮 374：深链只保证「这封看得到」，不能把待决定的信挤到后面；
     先 choose，再深链信，最后其余。 */
  return [
    ...rest.filter((r) => state(r) === "choose"),
    f,
    ...rest.filter((r) => state(r) !== "choose"),
  ];
});
/* 轮 338：记录也走 SWR（与桌面 BottleChatList 同一个 key 口径） */
const ck = () => cacheKey("dm:bottle-records", userId.value, mine.value ? "mine" : "held");
function paintCache() {
  if (!userId.value) return;
  const d = cachePeek(ck());
  if (!Array.isArray(d) || !d.length) return;
  if (mine.value) {
    /* 轮 374：缓存可能是旧版本写的「时间序」，首屏也要先按 choose 置顶，
       不能等网络回来才排；否则弱网/超时下用户一直看到待决定的信不在最前。 */
    const all = sortBottleMine(d, userId.value);
    mineAll.value = all;
    rows.value = all.slice(0, PAGE);
    offset = rows.value.length;
    more.value = all.length > offset;
  } else {
    rows.value = d;
    offset = d.length;
    more.value = d.length >= PAGE;
  }
}
/* 状态 → 文案 key（轮 18：picked/inhand 两态补上——此前信被捞起一律显示「漂流中」，无指引） */
const stateTk = (row) => ({
  picked: "bottle.stPicked", inhand: "bottle.stInHand", drifting: "bottle.pending",
  waiting: "bottle.chatWaiting", declined: "bottle.chatDeclined",
}[state(row)] || "bottle.pending");
/* 轮398：标题不再写「我投的信 / 来自海里的一封信」，改成信文前缀——
 * 同一页几封信时一眼能认出是哪封；正文仍只在展开后出现，不做全文重复。 */
const letterTitle = (row) => bottleLetterExcerpt(row.body)
  || t(row.user_id === userId.value ? "bottle.myLetter" : "bottle.fromSea");

async function load(append = false) {
  if (!userId.value || loading.value) return;
  const run = ++generation;
  loading.value = true;
  error.value = "";
  try {
    /* 「我发布的」已在内存里：加载更多只是本地切片，不再回源。 */
    if (append && mine.value && mineAll.value.length) {
      const next = Math.min(mineAll.value.length, offset + PAGE);
      rows.value = mineAll.value.slice(0, next);
      offset = rows.value.length;
      more.value = mineAll.value.length > offset;
      return;
    }
    const selectedP = focusId.value ? bottleRecords(focusId.value) : Promise.resolve([]);
    if (mine.value) {
      const [page, selected] = await Promise.all([
        bottleRecords(null, 0, { mine: true, limit: ALL_LIMIT }), selectedP,
      ]);
      if (run !== generation) return;
      const all = sortBottleMine(Array.isArray(page) ? page : [], userId.value);
      mineAll.value = all;
      const next = append ? Math.min(all.length, offset + PAGE) : PAGE;
      rows.value = all.slice(0, next);
      focused.value = selected?.[0] || null;
      offset = rows.value.length;
      more.value = all.length > offset;
      cacheSet(ck(), all);
    } else {
      const pageOffset = append ? offset : 0;
      const [page, selected] = await Promise.all([
        bottleRecords(null, pageOffset, { mine: false, limit: PAGE }), selectedP,
      ]);
      if (run !== generation) return;
      const got = Array.isArray(page) ? page : [];
      rows.value = append ? [...new Map([...rows.value, ...got].map((r) => [r.id, r])).values()] : got;
      focused.value = selected?.[0] || null;
      offset = pageOffset + got.length;
      more.value = got.length === PAGE;
      cacheSet(ck(), rows.value);
    }
    if (focusId.value && !focused.value) error.value = "bottle.chatUnavailable";
  } catch (e) {
    if (run === generation) { error.value = bottleErrKey(e); errAt = Date.now(); }
  } finally {
    if (run === generation) loading.value = false;
  }
}
async function decide(row, accept) {
  if (busy.value || state(row) !== "choose") return;
  const owner = userId.value;
  const run = generation;
  busy.value = row.id;
  error.value = "";
  try {
    const result = await bottleChatDecide(row.id, accept);
    if (owner !== userId.value || run !== generation) return;
    if (!result || !["accepted", "declined"].includes(result.decision)) throw new Error("bottle-invalid-result");
    row.chat_decision = result.decision;
    row.conv_id = result.conv_id;
    refreshBadge();
    if (result.decision === "accepted" && result.conv_id) emit("open", result.conv_id);
  } catch (e) {
    if (owner === userId.value && run === generation) error.value = bottleErrKey(e);
  } finally { if (run === generation) busy.value = ""; }
}
function reset() {
  generation++;
  busy.value = "";
  rows.value = [];
  focused.value = null;
  loading.value = false;
  more.value = false;
  error.value = "";
  offset = 0;
  paintCache();
  load();
}
function setMine(v) {
  if (mine.value === v) return;
  mine.value = v;
  reset();   /* 切页签 = 换过滤口径，重置分页重拉 */
}

/* ═══ 轮 319 · 长文本折叠（信文/回信各钳 4 行，真溢出才给「展开全文」） ═══
 * 与 BottleView 同款口径（foldText 纯层共用）。本组件外层是 <details>：
 * 折叠态内容 display:none 测不准 → 行数据到位后测一次、details 展开（@toggle）再补测。 */
const foldOpen = ref({});
const foldOver = ref({});
const foldEls = new Map();
const foldRef = (key) => (el) => { if (el) foldEls.set(key, el); else foldEls.delete(key); };
const foldIsOpen = (id, f) => !!foldOpen.value[foldKey(id, f)];
const foldBtn = (id, f) => !!foldOver.value[foldKey(id, f)];
function toggleFold(id, f) {
  const k = foldKey(id, f);
  foldOpen.value = { ...foldOpen.value, [k]: !foldOpen.value[k] };
}
function measureFolds() {
  const next = { ...foldOver.value };
  let chg = false;
  for (const [k, el] of foldEls) {
    if (!el || !el.clientHeight) continue;   /* display:none（details 收起）测不了，等 toggle 补测 */
    const over = foldOpen.value[k] ? true : isOverflowing(el);
    if (!!next[k] !== over) { next[k] = over; chg = true; }
  }
  if (chg) foldOver.value = next;
}
watch(displayed, () => { nextTick(measureFolds); });
watch(userId, () => { mineAll.value = []; }, { immediate: true });
watch([userId, focusId], reset, { immediate: true });
function refreshVisible() {
  if (document.hidden || busy.value || offset > 30) return;
  /* 轮 338：超时后 30s 内不自动重试，别把「15 秒没回来」的提示闪没 */
  if (error.value && Date.now() - errAt < 30000) return;
  load();
}
onMounted(() => {
  timer = setInterval(refreshVisible, 15000);
  document.addEventListener("visibilitychange", refreshVisible);
});
onBeforeUnmount(() => {
  generation++;
  clearInterval(timer);
  document.removeEventListener("visibilitychange", refreshVisible);
});
</script>

<template>
  <section class="bottle-records" aria-labelledby="bottle-records-title">
    <div class="row-between">
      <h2 id="bottle-records-title" class="sec-label">{{ t("bottle.recordsTitle") }}</h2>
      <button class="dm-act" :disabled="loading || !!busy" @click="load()">{{ t("bottle.refreshRecords") }}</button>
    </div>
    <p class="sub">{{ t("bottle.recordsHint") }}</p>
    <!-- 轮 70：区分「我发布的 / 我捞到的」——点按钮切换（默认我发布的；深链信件始终置顶显示） -->
    <div class="br-tabs" role="tablist">
      <button class="br-tab" :class="{ on: mine }" role="tab" :aria-selected="mine" @click="setMine(true)">
        {{ t("bottle.mineTab") }}
        <span v-if="pendingCount" class="notif-count">{{ pendingCount > 99 ? "99+" : pendingCount }}</span>
      </button>
      <button class="br-tab" :class="{ on: !mine }" role="tab" :aria-selected="!mine" @click="setMine(false)">{{ t("bottle.heldTab") }}</button>
    </div>
    <p v-if="error" role="alert" class="notice">{{ t(error) }}</p>
    <p v-if="loading" class="sub" role="status">{{ t("bottle.recordsLoading") }}</p>
    <p v-else-if="!displayed.length && !error" class="sub">{{ t(mine ? "bottle.mineEmpty" : "bottle.heldEmpty") }}</p>
    <article v-for="row in displayed" :key="row.id" class="bottle-record" :class="{ focused: row.id === focusId, needs: state(row) === 'choose' }">
      <!-- 轮 319：details 展开（display 可见）后才测得准折叠溢出 → toggle 补测 -->
      <details :open="row.id === focusId || state(row) === 'choose'" @toggle="nextTick(measureFolds)">
        <summary>
          <span v-if="state(row) === 'choose'" class="bottle-need-dot" :title="t('bottle.stDecide')" aria-hidden="true"></span>
          <span class="bottle-record-title">{{ letterTitle(row) }}</span>
          <span class="bottle-record-open-label">{{ row.user_id === userId ? t("bottle.myLetter") : t("bottle.fromSea") }}</span>
        </summary>
        <p
          class="bottle-record-text" :ref="foldRef(foldKey(row.id, 'body'))"
          :class="{ 'fold-clamp': needsFold(row.body) && !foldIsOpen(row.id, 'body'), 'fold-fade': foldBtn(row.id, 'body') && !foldIsOpen(row.id, 'body') }">{{ row.body }}</p>
        <button v-if="foldBtn(row.id, 'body')" type="button" class="fold-more" @click="toggleFold(row.id, 'body')">
          {{ foldIsOpen(row.id, "body") ? t("bottle.foldLess") : t("bottle.foldMore", { n: row.body.length }) }}
        </button>
        <template v-if="row.reply">
          <b class="sub">{{ t(row.reply_by === userId.value ? "bottle.replyMine" : "bottle.replyFrom") }}</b>
          <p
            class="bottle-record-text" :ref="foldRef(foldKey(row.id, 'reply'))"
            :class="{ 'fold-clamp': needsFold(row.reply) && !foldIsOpen(row.id, 'reply'), 'fold-fade': foldBtn(row.id, 'reply') && !foldIsOpen(row.id, 'reply') }">{{ row.reply }}</p>
          <button v-if="foldBtn(row.id, 'reply')" type="button" class="fold-more" @click="toggleFold(row.id, 'reply')">
            {{ foldIsOpen(row.id, "reply") ? t("bottle.foldLess") : t("bottle.foldMore", { n: row.reply.length }) }}
          </button>
        </template>
      </details>
      <template v-if="state(row) === 'choose'">
        <p class="sub">{{ t("bottle.chatQuestion") }}</p>
        <button class="dm-act primary" :disabled="!!busy" @click="decide(row, true)">{{ t("bottle.chatAccept") }}</button>
        <button class="dm-act" :disabled="!!busy" @click="decide(row, false)">{{ t("bottle.chatDecline") }}</button>
      </template>
      <button v-else-if="state(row) === 'accepted'" class="dm-act primary" @click="emit('open', row.conv_id)">{{ t("bottle.chatOpen") }}</button>
      <p v-else class="sub">{{ t(stateTk(row)) }}</p>
    </article>
    <button v-if="more" class="dm-act" :disabled="loading" @click="load(true)">{{ t("bottle.recordsMore") }}</button>
  </section>
</template>

<style scoped>
/* 轮 358/363：与上方分段条之间只留 .dm-list 的 6px 间距，不再叠 margin/padding。 */
.bottle-records { margin-top: 0; padding-top: 0; }
.bottle-record { margin-top: 12px; padding: 12px; border: 1px solid var(--line); border-radius: 14px; }
.bottle-record.focused { outline: 2px solid currentColor; }
.bottle-record.needs { border-color: rgba(242, 96, 63, .55); }
.bottle-record summary { cursor: pointer; overflow-wrap: anywhere; }
/* 轮398：标题只占一行，超出用省略号；展开后正文才完整出现。 */
.bottle-record-title {
  display: inline-block; max-width: calc(100% - 16px); vertical-align: bottom;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* 展开后正文已经完整出现：标题退回类型标签，避免同一段文字又当标题又当正文。 */
.bottle-record-open-label { display: none; }
.bottle-record details[open] .bottle-record-title { display: none; }
.bottle-record details[open] .bottle-record-open-label { display: inline; }
.bottle-record-text { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.7; }
.br-tabs { display: flex; gap: 8px; margin: 8px 0 10px; }
.br-tab {
  display: inline-flex; align-items: center; gap: 6px;
  border: 1px solid var(--hairline); background: var(--wash);
  color: var(--ink-soft); font-family: inherit; font-weight: 500; font-size: 12.5px;
  padding: 5px 14px; border-radius: 999px; cursor: pointer; transition: all .15s ease;
}
.br-tab.on {
  background: var(--accent);
}
</style>
