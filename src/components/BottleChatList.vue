<script setup>
/* 轮 142 · 私信页「漂流瓶」段左列（桌面行式列表，参考图 1）
 * ------------------------------------------------------------
 * 与「手机端三段 / /bottle 独立页」的卡片式 BottleRecords **并存**——那两个形态零改动：
 *  - 顶部小页签「我发布的 / 我捞到的」（沿用 bottle.mineTab / heldTab）
 *  - 每行：头像 · 名字 · 状态胶囊 · 信件/回信摘要 · 时间；点行 = 选中（交给中列 BottleChat）
 *  - 名字来源（RPC 只回 bottle_letters.*，没有昵称）：已建会话取 dm 会话昵称 →
 *    否则读 profiles（RLS 全员可读，游客主页同源）→ 再兜底「海里的朋友」（不编造名字）
 */
import { computed, ref, watch, onMounted, onBeforeUnmount } from "vue";
import { NAvatar } from "naive-ui";
import { t } from "../i18n.js";
import { cloud } from "../utils/supabase.js";
import { bottleRecords, bottleChatState, bottleErrKey } from "../utils/bottle.js";
import { cloudFetchProfile } from "../utils/wall.js";
import { relativeTime } from "../utils/dmRules.js";
import { refreshBadge } from "../stores/badgeStore.js";
import { avatarUrlFor } from "../utils/avatar.js";   /* 轮 238:萌宠头像池 */

const props = defineProps({
  /* 父级当前选中的信（受控）：用于行选中态；切换页签/刷新后由父级对齐 */
  selectedId: { type: [Number, String], default: null },
});
const emit = defineEmits(["select"]);   /* (row, nickname) */

const userId = computed(() => (cloud.user && cloud.user.id) || "");
const rows = ref([]);
const names = ref({});          /* peerId → 昵称（解析一次后缓存） */
const mine = ref(true);         /* 默认「我发布的」（与 /bottle 页一致） */
const loading = ref(false);
const error = ref("");
const more = ref(false);
let offset = 0;
let generation = 0;
let timer = null;

const state = (row) => bottleChatState(row, userId.value);
/* 状态 → 文案 key（口径与 BottleRecords 一致，轮 18 两态名词不动） */
const stateTk = (row) => ({
  picked: "bottle.stPicked", inhand: "bottle.stInHand", drifting: "bottle.pending",
  waiting: "bottle.chatWaiting", declined: "bottle.chatDeclined",
  accepted: "bottle.stAccepted", choose: "bottle.stDecide",
}[state(row)] || "bottle.pending");

const peerId = (row) => (row.user_id === userId.value ? row.reply_by : row.user_id);
const peerName = (row) => names.value[peerId(row)] || t("bottle.peerFallback");
const initial = (row) => (peerName(row) || "?").slice(0, 1).toUpperCase();
const preview = (row) => (row.reply || row.body || "").slice(0, 48);
const when = (row) => relativeTime(row.reply_at || row.held_at || row.created_at, Date.now(), t);

/* 昵称：只对屏上这些人查，查过就缓存（失败静默 → 走兜底名） */
async function resolveNames(list) {
  for (const row of list) {
    const id = peerId(row);
    if (!id || names.value[id] !== undefined) continue;
    let nick = "";
    try { const p = await cloudFetchProfile(id); nick = (p && p.nickname) || ""; } catch (e) { nick = ""; }
    names.value = { ...names.value, [id]: nick };
  }
}

async function load(append = false) {
  if (!userId.value || loading.value) return;
  const run = ++generation;
  loading.value = true;
  error.value = "";
  try {
    const pageOffset = append ? offset : 0;
    const got = await bottleRecords(null, pageOffset, { mine: mine.value, limit: 30 });
    if (run !== generation) return;
    const list = Array.isArray(got) ? got : [];
    rows.value = append ? [...new Map([...rows.value, ...list].map((r) => [r.id, r])).values()] : list;
    offset = pageOffset + list.length;
    more.value = list.length === 30;
    await resolveNames(rows.value);
  } catch (e) {
    if (run === generation) error.value = bottleErrKey(e);
  } finally {
    if (run === generation) loading.value = false;
  }
}

function reset() {
  generation++;
  rows.value = [];
  names.value = {};
  loading.value = false;
  more.value = false;
  error.value = "";
  offset = 0;
  load();
}
function setMine(v) {
  if (mine.value === v) return;
  mine.value = v;
  reset();
}
function pick(row) {
  emit("select", row, peerName(row));
  if (state(row) === "choose") refreshBadge();   /* 点开待决定的信 = 处理中，红点随后由父级刷新 */
}
function refreshVisible() {
  if (!document.hidden && !loading.value && offset <= 30) load();
}

watch([userId], reset, { immediate: true });
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
  <div class="bcl" role="list">
    <div class="br-tabs bcl-tabs" role="tablist">
      <button class="dm-seg-btn bcl-tab" :class="{ on: mine }" role="tab" :aria-selected="mine" @click="setMine(true)">
        {{ t("bottle.mineTab") }}
      </button>
      <button class="dm-seg-btn bcl-tab" :class="{ on: !mine }" role="tab" :aria-selected="!mine" @click="setMine(false)">
        {{ t("bottle.heldTab") }}
      </button>
    </div>

    <p v-if="error" role="alert" class="notice">{{ t(error) }}</p>
    <p v-if="loading && !rows.length" class="sub" role="status">{{ t("bottle.recordsLoading") }}</p>
    <p v-else-if="!rows.length && !error" class="sub dm-empty">
      {{ t(mine ? "bottle.mineEmpty" : "bottle.heldEmpty") }}
    </p>

    <div
      v-for="row in rows" :key="row.id" role="listitem"
      class="bcl-row" :class="{ on: String(row.id) === String(props.selectedId) }"
      @click="pick(row)">
      <n-avatar round :size="38" class="post-avatar" :src="avatarUrlFor(peerId(row)) || undefined"><template v-if="!avatarUrlFor(peerId(row))" #default>{{ initial(row) }}</template><template v-else #fallback>{{ initial(row) }}</template></n-avatar>
      <div class="bcl-body">
        <div class="bcl-top">
          <b class="dm-name">{{ peerName(row) }}</b>
          <span class="sub dm-time">{{ when(row) }}</span>
        </div>
        <p class="sub bcl-preview">
          <span class="bcl-chip" :class="{ wait: state(row) === 'choose' }">{{ t(stateTk(row)) }}</span>
          {{ preview(row) }}
        </p>
      </div>
    </div>

    <button v-if="more" class="dm-act bcl-more" :disabled="loading" @click="load(true)">
      {{ t("bottle.recordsMore") }}
    </button>
    <button class="dm-act bcl-more" :disabled="loading" @click="load()">{{ t("bottle.refreshRecords") }}</button>
  </div>
</template>
