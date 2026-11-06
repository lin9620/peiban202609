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
import {
  bottleRecords, bottleChatState, bottleErrKey, sortBottleMine, bottlePendingCount, bottleLetterExcerpt,
  /* 轮448：左列也能撤回/隐藏 —— 判据与 /bottle 记录卡共用同一对纯函数（与 SQL where 逐条对应） */
  canWithdrawLetter, canHideLetter,
} from "../utils/bottle.js";
import { useLetterOps } from "../utils/letterOps.js";
import { cacheKey, cachePeek, cacheSet } from "../utils/cache.js";
import { cloudFetchProfile } from "../utils/wall.js";
import { relativeTime } from "../utils/dmRules.js";
import { refreshBadge } from "../stores/badgeStore.js";
import { avatarUrlFor } from "../utils/avatar.js";   /* 轮 238:萌宠头像池 */

const props = defineProps({
  /* 父级当前选中的信（受控）：用于行选中态；切换页签/刷新后由父级对齐 */
  selectedId: { type: [Number, String], default: null },
});
const emit = defineEmits(["select", "pending", "removed"]);   /* (row, nickname) / (count) / (letterId) */

const userId = computed(() => (cloud.user && cloud.user.id) || "");
const PAGE = 30;
const ALL_LIMIT = 200;   /* 「我发布的」一次取全量（与 /bottle 页一致），待决定的信才能全局置顶 */
const rows = ref([]);
const mineAll = ref([]);
const names = ref({});          /* peerId → 昵称（解析一次后缓存） */
const mine = ref(true);         /* 默认「我发布的」（与 /bottle 页一致） */
const loading = ref(false);
const error = ref("");
const more = ref(false);
let offset = 0;
let generation = 0;
let timer = null;
let errAt = 0;   /* 轮 338：上次出错时刻 —— 自动刷新别在 15s 超时后又立刻重试（会把提示闪没） */

const pendingCount = computed(() => bottlePendingCount(mineAll.value, userId.value));
watch(pendingCount, (n) => emit("pending", n), { immediate: true });
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
/* 轮398：列表摘要固定取原信正文前缀——旧写法 row.reply || row.body 会拿回信顶替，
 * 回信一短就完全看不出是哪封信；正文为空才退回回信。 */
const preview = (row) => bottleLetterExcerpt(row.body, 52) || bottleLetterExcerpt(row.reply, 52);
const when = (row) => relativeTime(row.reply_at || row.held_at || row.created_at, Date.now(), t);

/* 昵称：只对屏上这些人查，查过就缓存（失败静默 → 走兜底名）。
 * 轮 338：并发 4 路 —— 原来一条一条 await，30 行就是 30 个来回，
 * 慢网下「名单」要等半分钟；而且它挂在 load 的 loading 后面，刷新键一直按不动。 */
async function resolveNames(list) {
  const owner = userId.value;
  const todo = [];
  for (const row of list) {
    const id = peerId(row);
    if (id && names.value[id] === undefined && !todo.includes(id)) todo.push(id);
  }
  if (!todo.length) return;
  let i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const id = todo[i++];
      let nick = "";
      try { const p = await cloudFetchProfile(id); nick = (p && p.nickname) || ""; } catch (e) { nick = ""; }
      if (owner !== userId.value) return;
      names.value = { ...names.value, [id]: nick };
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, todo.length) }, worker));
}

/* 轮 338：记录也走 SWR —— 上次拉到的列表先画出来（切到漂流瓶段不再对着
 * 「正在找回…」干等），网络回来再覆盖。key 刻意不用 `bottle:` 前缀：
 * purgeLegacyBottleLocals 会按 `wp-cache:v1:bottle:` 清老账本，别把新缓存一起清掉。 */
const ck = () => cacheKey("dm:bottle-records", userId.value, mine.value ? "mine" : "held");
function paintCache() {
  if (!userId.value) return;
  const d = cachePeek(ck());
  if (!Array.isArray(d) || !d.length) return;
  if (mine.value) {
    /* 轮 374：缓存首屏同样按 choose 置顶（桌面左列与手机记录卡同一口径），
       避免旧缓存的时间序在弱网/超时下一直显示成「待决定的信不在最前」。 */
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

async function load(append = false) {
  if (!userId.value || loading.value) return;
  const run = ++generation;
  loading.value = true;
  error.value = "";
  try {
    /* 「我发布的」全量已在内存：加载更多只切片，不再回源。 */
    if (append && mine.value && mineAll.value.length) {
      const next = Math.min(mineAll.value.length, offset + PAGE);
      rows.value = mineAll.value.slice(0, next);
      offset = rows.value.length;
      more.value = mineAll.value.length > offset;
      resolveNames(rows.value);
      return;
    }
    if (mine.value) {
      const got = await bottleRecords(null, 0, { mine: true, limit: ALL_LIMIT });
      if (run !== generation) return;
      const all = sortBottleMine(Array.isArray(got) ? got : [], userId.value);
      mineAll.value = all;
      const next = append ? Math.min(all.length, offset + PAGE) : PAGE;
      rows.value = all.slice(0, next);
      offset = rows.value.length;
      more.value = all.length > offset;
      cacheSet(ck(), all);
    } else {
      const pageOffset = append ? offset : 0;
      const got = await bottleRecords(null, pageOffset, { mine: false, limit: PAGE });
      if (run !== generation) return;
      const list = Array.isArray(got) ? got : [];
      rows.value = append ? [...new Map([...rows.value, ...list].map((r) => [r.id, r])).values()] : list;
      offset = pageOffset + list.length;
      more.value = list.length === PAGE;
      cacheSet(ck(), rows.value);
    }
    loading.value = false;          /* 名单在后台补，不再让刷新键陪着等 */
    resolveNames(rows.value);       /* 不 await：失败静默，名字到了自己会渲染 */
  } catch (e) {
    if (run === generation) { error.value = bottleErrKey(e); errAt = Date.now(); }
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
  paintCache();
  load();
}
function setMine(v) {
  if (mine.value === v) return;
  mine.value = v;
  reset();
}
/* ═════════ 轮448 · 作者撤回 / 隐藏自己投的信（桌面左列） ═════════
 * 用户报障：「消息 - 漂流瓶」里看不到撤回按钮 —— 轮446 只做到了 /bottle 页的记录卡，
 * 桌面端这份行式列表漏了。判据仍是 utils/bottle.js 的两个 can* 纯函数
 * （与 bottle_letter_delete/_hide 的 where 逐条对应），动作层统一在 utils/letterOps.js：
 *   还在海里 → 撤回（从海里消失，不会再被捞到）；已进别人手里 → 只能隐藏。
 * 撤回**不退还**今日投信次数 —— 投递是动作成本，退还等于可以无限试写。
 */
const canOp = (row) => !!mine.value && (canWithdrawLetter(row) || canHideLetter(row, userId.value));

/* 从两处列表里摘掉同一条：mineAll 是全量、rows 是屏上切片。
 * 摘完重新切一刀补齐行数，避免「撤回一条，列表整块往上跳一格」。
 * 正好撤回的是中列正在看的那封 → 通知父级清掉选中，中列回到「点一封信看看」空态。 */
function dropRow(id) {
  const keep = (x) => String(x.id) !== String(id);
  mineAll.value = mineAll.value.filter(keep);
  rows.value = mineAll.value.slice(0, Math.max(PAGE, rows.value.length));
  offset = rows.value.length;
  more.value = mineAll.value.length > offset;
  if (String(props.selectedId) === String(id)) emit("removed", id);
}

const {
  flash: opFlash, busyFor: opBusyFor, withdraw: withdrawRow, hide: hideRow,
} = useLetterOps({
  onDone: (id) => { dropRow(id); refreshBadge(); },
  onError: (k) => { error.value = k; },
});

/* 桌面端「同意/拒绝」发生在中列 BottleChat；决定后让左列重拉，红点/置顶立即消失。 */
defineExpose({ reload: () => load() });
function pick(row) {
  emit("select", row, peerName(row));
  if (state(row) === "choose") refreshBadge();   /* 点开待决定的信 = 处理中，红点随后由父级刷新 */
}
function refreshVisible() {
  if (document.hidden || loading.value || offset > 30) return;
  /* 轮 338：刚超时过就先别自动重试 —— 15s 的定时器正好会撞上 15s 超时，
   * 提示会闪一下又被「重试中」盖掉，用户只看到刷新键一直灰着。 */
  if (error.value && Date.now() - errAt < 30000) return;
  load();
}

watch(userId, () => { mineAll.value = []; }, { immediate: true });
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
    <!-- 轮447：原来这里的 br-tabs 是无效类 —— 它只定义在 BottleRecords 的 scoped 里，
         本组件拿不到；真正的样式由全局 .bcl-tabs 提供（display/gap 与它等价）。 -->
    <div class="bcl-tabs" role="tablist">
      <button class="dm-seg-btn bcl-tab" :class="{ on: mine }" role="tab" :aria-selected="mine" @click="setMine(true)">
        {{ t("bottle.mineTab") }}
        <span v-if="pendingCount" class="notif-count">{{ pendingCount > 99 ? "99+" : pendingCount }}</span>
      </button>
      <button class="dm-seg-btn bcl-tab" :class="{ on: !mine }" role="tab" :aria-selected="!mine" @click="setMine(false)">
        {{ t("bottle.heldTab") }}
      </button>
    </div>

    <p v-if="opFlash" class="sub bcl-flash" role="status">{{ opFlash }}</p>
    <p v-if="error" role="alert" class="notice">{{ t(error) }}</p>
    <p v-if="loading && !rows.length" class="sub" role="status">{{ t("bottle.recordsLoading") }}</p>
    <p v-else-if="!rows.length && !error" class="sub dm-empty">
      {{ t(mine ? "bottle.mineEmpty" : "bottle.heldEmpty") }}
    </p>

    <div
      v-for="row in rows" :key="row.id" role="listitem"
      class="bcl-row" :class="{ on: String(row.id) === String(props.selectedId), needs: state(row) === 'choose' }"
      @click="pick(row)">
      <n-avatar round :size="38" class="post-avatar" :src="avatarUrlFor(peerId(row)) || undefined"><template v-if="!avatarUrlFor(peerId(row))" #default>{{ initial(row) }}</template><template v-else #fallback>{{ initial(row) }}</template></n-avatar>
      <div class="bcl-body">
        <div class="bcl-top">
          <b class="dm-name">
            <span v-if="state(row) === 'choose'" class="bottle-need-dot" :title="t('bottle.stDecide')" aria-hidden="true"></span>
            {{ peerName(row) }}
          </b>
          <span class="sub dm-time">{{ when(row) }}</span>
        </div>
        <p class="sub bcl-preview" :title="row.body">{{ preview(row) }}</p>
        <div class="bcl-state">
          <span class="bcl-chip" :class="{ wait: state(row) === 'choose' }">{{ t(stateTk(row)) }}</span>
          <!-- 轮448：作者操作 —— 还在海里 → 撤回；已进别人手里 → 只有隐藏。
               必须 @click.stop：整行是选中态的点击区，否则点撤回顺带把信选中了。 -->
          <span v-if="canOp(row)" class="bcl-ops">
            <button v-if="canWithdrawLetter(row)" type="button" class="bottle-op bottle-op-danger"
              :disabled="opBusyFor(row)" @click.stop="withdrawRow(row)">{{ t("bottle.withdraw") }}</button>
            <button v-else type="button" class="bottle-op"
              :disabled="opBusyFor(row)" @click.stop="hideRow(row)">{{ t("bottle.hide") }}</button>
          </span>
        </div>
      </div>
    </div>

    <button v-if="more" class="dm-act bcl-more" :disabled="loading" @click="load(true)">
      {{ t("bottle.recordsMore") }}
    </button>
    <button class="dm-act bcl-more" :disabled="loading" @click="load()">{{ t("bottle.refreshRecords") }}</button>
  </div>
</template>
