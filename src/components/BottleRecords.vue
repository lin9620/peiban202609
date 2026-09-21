<script setup>
import { computed, ref, watch, onMounted, onBeforeUnmount } from "vue";
import { useRoute } from "vue-router";
import { t } from "../i18n.js";
import { cloud } from "../utils/supabase.js";
import { bottleRecords, bottleChatDecide, bottleChatState, bottleErrKey } from "../utils/bottle.js";
import { refreshBadge } from "../stores/badgeStore.js";

const emit = defineEmits(["open"]);
const route = useRoute();
const userId = computed(() => cloud.user?.id || "");
const focusId = computed(() => typeof route.query.bottle === "string" ? route.query.bottle : "");
const rows = ref([]);
const focused = ref(null);
const loading = ref(false);
const busy = ref("");
const error = ref("");
const more = ref(false);
let offset = 0;
let generation = 0;
let timer;
const displayed = computed(() => focused.value
  ? [focused.value, ...rows.value.filter((r) => r.id !== focused.value.id)] : rows.value);
const state = (row) => bottleChatState(row, userId.value);
/* 状态 → 文案 key（轮 18：picked/inhand 两态补上——此前信被捞起一律显示「漂流中」，无指引） */
const stateTk = (row) => ({
  picked: "bottle.stPicked", inhand: "bottle.stInHand", drifting: "bottle.pending",
  waiting: "bottle.chatWaiting", declined: "bottle.chatDeclined",
}[state(row)] || "bottle.pending");

async function load(append = false) {
  if (!userId.value || loading.value) return;
  const run = ++generation;
  loading.value = true;
  error.value = "";
  try {
    const pageOffset = append ? offset : 0;
    const [page, selected] = await Promise.all([
      bottleRecords(null, pageOffset),
      focusId.value ? bottleRecords(focusId.value) : Promise.resolve([]),
    ]);
    if (run !== generation) return;
    const got = Array.isArray(page) ? page : [];
    rows.value = append ? [...new Map([...rows.value, ...got].map((r) => [r.id, r])).values()] : got;
    focused.value = selected?.[0] || null;
    offset = pageOffset + got.length;
    more.value = got.length === 30;
    if (focusId.value && !focused.value) error.value = "bottle.chatUnavailable";
  } catch (e) {
    if (run === generation) error.value = bottleErrKey(e);
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
  load();
}
watch([userId, focusId], reset, { immediate: true });
function refreshVisible() {
  if (!document.hidden && !busy.value && offset <= 30) load();
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
    <p v-if="error" role="alert" class="notice">{{ t(error) }}</p>
    <p v-if="loading" class="sub" role="status">{{ t("bottle.recordsLoading") }}</p>
    <p v-else-if="!displayed.length && !error" class="sub">{{ t("bottle.recordsEmpty") }}</p>
    <article v-for="row in displayed" :key="row.id" class="bottle-record" :class="{ focused: row.id === focusId }">
      <details :open="row.id === focusId || state(row) === 'choose'">
        <summary>{{ row.user_id === userId ? t("bottle.myLetter") : t("bottle.fromSea") }} · {{ row.body.slice(0, 36) }}</summary>
        <p class="bottle-record-text">{{ row.body }}</p>
        <template v-if="row.reply">
          <b class="sub">{{ t("bottle.replyFrom") }}</b>
          <p class="bottle-record-text">{{ row.reply }}</p>
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
.bottle-records { margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--line); }
.bottle-record { margin-top: 12px; padding: 12px; border: 1px solid var(--line); border-radius: 14px; }
.bottle-record.focused { outline: 2px solid currentColor; }
.bottle-record summary { cursor: pointer; overflow-wrap: anywhere; }
.bottle-record-text { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.7; }
</style>
