<script setup>
import { computed, ref, watch, onMounted, onBeforeUnmount, nextTick } from "vue";
import { useRoute } from "vue-router";
import { t } from "../i18n.js";
import { cloud } from "../utils/supabase.js";
import { bottleRecords, bottleChatDecide, bottleChatState, bottleErrKey, sortBottleMine, bottlePendingCount, bottleLetterExcerpt,
  /* 轮448：手机端「消息 → 漂流瓶」也能撤回/隐藏自己投的信 */
  canWithdrawLetter, canHideLetter,
} from "../utils/bottle.js";
import { useLetterOps } from "../utils/letterOps.js";
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
/* 轮 494：状态胶囊的文案/色调。choose 与 accepted 原来只靠下面的按钮表达，
 * 收进胶囊后，扫一眼左边一列就能读完「哪封待决定、哪封能进去聊」。 */
const stateChip = (row) => {
  const s = state(row);
  if (s === "choose") return t("bottle.stDecide");
  if (s === "accepted") return t("bottle.stAccepted");
  return t(stateTk(row));
};
const stateTone = (row) => ({ choose: "wait" }[state(row)] || "");
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
/* ═════════ 轮448 · 作者撤回 / 隐藏自己投的信（手机端「消息 → 漂流瓶」） ═════════
 * 用户报障：这里看不到撤回按钮 —— 轮446 只做了 /bottle 独立页的记录卡，
 * 而从底部导航「消息 → 漂流瓶」进来的其实是本组件。
 * 判据与 SQL 的 where 逐条对应（utils/bottle.js 的两个 can*），动作层在 utils/letterOps.js：
 *   还在海里 → 撤回；已经进了别人手里 → 只能隐藏（不影响对方，回信和聊天都还在）。
 * 撤回**不退还**今日投信次数。
 */
const canOp = (row) => !!mine.value && (canWithdrawLetter(row) || canHideLetter(row, userId.value));
function dropRow(id) {
  const keep = (x) => String(x.id) !== String(id);
  mineAll.value = mineAll.value.filter(keep);
  rows.value = rows.value.filter(keep);
  if (focused.value && String(focused.value.id) === String(id)) focused.value = null;
  offset = Math.max(0, offset - 1);
  more.value = mineAll.value.length > offset;
}
const {
  flash: opFlash, busyFor: opBusyFor, withdraw: withdrawRow, hide: hideRow,
} = useLetterOps({
  onDone: (id) => { dropRow(id); refreshBadge(); },
  onError: (k) => { error.value = k; },
});

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
    <!-- 轮 494：标题 / 提示 / 刷新归位到一条轴线上（刷新不再是虚线胶囊） -->
    <div class="br-head">
      <h2 id="bottle-records-title" class="br-head-title">{{ t("bottle.recordsTitle") }}</h2>
      <button type="button" class="br-refresh" :class="{ 'is-busy': loading }"
        :disabled="loading || !!busy" @click="load()">
        <svg class="br-refresh-ico" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1" />
          <path d="M20.5 4.6V10h-5.4" />
        </svg>
        <span>{{ t("bottle.refreshRecords") }}</span>
      </button>
    </div>
    <p class="br-hint">{{ t("bottle.recordsHint") }}</p>
    <!-- 轮 70：区分「我发布的 / 我捞到的」——点按钮切换（默认我发布的；深链信件始终置顶显示）
         轮 494：两个独立胶囊改成一条分段控件，选中项有明确的「亮起来」的底。 -->
    <div class="br-seg" role="tablist">
      <button type="button" class="br-seg-btn" :class="{ on: mine }" role="tab" :aria-selected="mine" @click="setMine(true)">
        {{ t("bottle.mineTab") }}
        <span v-if="pendingCount" class="br-badge">{{ pendingCount > 99 ? "99+" : pendingCount }}</span>
      </button>
      <button type="button" class="br-seg-btn" :class="{ on: !mine }" role="tab" :aria-selected="!mine" @click="setMine(false)">{{ t("bottle.heldTab") }}</button>
    </div>
    <p v-if="opFlash" class="br-flash" role="status">{{ opFlash }}</p>
    <p v-if="error" role="alert" class="br-alert">{{ t(error) }}</p>
    <p v-if="loading && !displayed.length" class="br-empty" role="status">{{ t("bottle.recordsLoading") }}</p>
    <p v-else-if="!displayed.length && !error" class="br-empty">{{ t(mine ? "bottle.mineEmpty" : "bottle.heldEmpty") }}</p>
    <article v-for="row in displayed" :key="row.id" class="bottle-record" :class="{ focused: row.id === focusId, needs: state(row) === 'choose' }">
      <!-- 轮 319：details 展开（display 可见）后才测得准折叠溢出 → toggle 补测 -->
      <details :open="row.id === focusId || state(row) === 'choose'" @toggle="nextTick(measureFolds)">
        <summary>
          <span v-if="state(row) === 'choose'" class="bottle-need-dot" :title="t('bottle.stDecide')" aria-hidden="true"></span>
          <span class="bottle-record-title">{{ letterTitle(row) }}</span>
          <span class="bottle-record-open-label">{{ row.user_id === userId ? t("bottle.myLetter") : t("bottle.fromSea") }}</span>
        </summary>
        <div class="br-body">
          <p
            class="bottle-record-text" :ref="foldRef(foldKey(row.id, 'body'))"
            :class="{ 'fold-clamp': needsFold(row.body) && !foldIsOpen(row.id, 'body'), 'fold-fade': foldBtn(row.id, 'body') && !foldIsOpen(row.id, 'body') }">{{ row.body }}</p>
          <button v-if="foldBtn(row.id, 'body')" type="button" class="fold-more" @click="toggleFold(row.id, 'body')">
            {{ foldIsOpen(row.id, "body") ? t("bottle.foldLess") : t("bottle.foldMore", { n: row.body.length }) }}
          </button>
          <template v-if="row.reply">
            <b class="br-reply-label">{{ t(row.reply_by === userId.value ? "bottle.replyMine" : "bottle.replyFrom") }}</b>
            <p
              class="bottle-record-text" :ref="foldRef(foldKey(row.id, 'reply'))"
              :class="{ 'fold-clamp': needsFold(row.reply) && !foldIsOpen(row.id, 'reply'), 'fold-fade': foldBtn(row.id, 'reply') && !foldIsOpen(row.id, 'reply') }">{{ row.reply }}</p>
            <button v-if="foldBtn(row.id, 'reply')" type="button" class="fold-more" @click="toggleFold(row.id, 'reply')">
              {{ foldIsOpen(row.id, "reply") ? t("bottle.foldLess") : t("bottle.foldMore", { n: row.reply.length }) }}
            </button>
          </template>
        </div>
      </details>
      <!-- 轮 494：状态胶囊与撤回/隐藏落在同一行 —— 原来状态、撤回各占一块，
           撤回还是一颗裸红字飘在右下角，卡片里三处重量全散开。 -->
      <div class="br-foot">
        <span class="br-state" :class="stateTone(row)">{{ stateChip(row) }}</span>
        <div v-if="canOp(row)" class="br-ops">
          <button v-if="canWithdrawLetter(row)" type="button" class="bottle-op bottle-op-danger"
            :disabled="opBusyFor(row)" @click="withdrawRow(row)">{{ t("bottle.withdraw") }}</button>
          <button v-else type="button" class="bottle-op"
            :disabled="opBusyFor(row)" @click="hideRow(row)">{{ t("bottle.hide") }}</button>
        </div>
      </div>
      <div v-if="state(row) === 'choose'" class="br-acts">
        <button type="button" class="br-btn br-btn--main" :disabled="!!busy" @click="decide(row, true)">{{ t("bottle.chatAccept") }}</button>
        <button type="button" class="br-btn" :disabled="!!busy" @click="decide(row, false)">{{ t("bottle.chatDecline") }}</button>
      </div>
      <button v-else-if="state(row) === 'accepted'" type="button" class="br-btn br-btn--main br-btn--wide" @click="emit('open', row.conv_id)">{{ t("bottle.chatOpen") }}</button>
    </article>
    <button v-if="more" type="button" class="br-more" :disabled="loading" @click="load(true)">{{ t("bottle.recordsMore") }}</button>
  </section>
</template>

<style scoped>
/* ═════════ 轮 494 · 漂流瓶记录段重排 ═════════
 * 用户「这个页面各种按钮布局也太丑了，重新更改设计一些」。
 * 原实现的三处硬伤：
 *   ① 标题 / 状态 / 撤回散落在卡片的三个角落，撤回是一颗裸红字飘在右下角；
 *   ② 「刷新记录」是全局 .dm-act 的虚线胶囊，夹在实体标题旁边像草稿；
 *   ③ 两个页签是不同重量的独立胶囊（选中那个还是 accent 实心底 + ink-soft 字，
 *      夜间主题下 #8b9ce8 配 #a9b1d6 只有 1.4:1，基本看不清）。
 * 另外 .bottle-record 原来写 `border: 1px solid var(--line)`，而 --line 这个变量
 * 从来没定义过 —— 整条 border 简写失效，卡片根本没有边框，只剩一圈空白。
 *
 * 现在：一列轴线走到底 —— 标题行(chevron + 标题 + 类型) / 正文 / 状态行(胶囊 + 撤回)。
 * 所有动作都右对齐在同一条切线上，卡片恢复柔底 + 发丝边。
 * 类名 .bottle-record / .bottle-record-text / .bottle-record-title 不改：
 * bottle-gap-test（轮429 按钮贴正文）与 bottle-test（轮398 折叠标题）按名锁着。 */
.bottle-records { margin-top: 0; padding-top: 0; }

/* ── 头部：标题 + 刷新 ── */
.br-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.br-head-title { font-size: 15px; font-weight: 700; color: var(--ink); letter-spacing: 0; }
.br-hint { margin-top: 4px; font-size: 12px; line-height: 1.55; color: var(--ink-faint); }
.br-refresh {
  flex: 0 0 auto; display: inline-flex; align-items: center; gap: 5px;
  appearance: none; font-family: inherit; cursor: pointer;
  padding: 6px 12px; border-radius: 999px;
  font-size: 12px; font-weight: 600; white-space: nowrap;
  color: var(--ink-soft); background: var(--wash-mid); border: 1px solid var(--hairline);
  transition: color .16s ease, background .16s ease, border-color .16s ease;
}
.br-refresh:hover:not(:disabled) { color: var(--accent-deep); background: var(--accent-soft); border-color: var(--accent); }
.br-refresh:disabled { opacity: .55; cursor: default; }
.br-refresh-ico {
  width: 13px; height: 13px; flex: 0 0 13px;
  fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round;
}
.br-refresh.is-busy .br-refresh-ico { animation: br-spin .9s linear infinite; }
@keyframes br-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .br-refresh.is-busy .br-refresh-ico { animation: none; } }

/* ── 分段控件（我发布的 / 我捞到的）── */
.br-seg {
  display: inline-flex; gap: 2px; margin: 10px 0 2px; padding: 3px;
  border-radius: 999px; background: var(--wash); border: 1px solid var(--hairline);
}
.br-seg-btn {
  appearance: none; font-family: inherit; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  min-width: 88px; padding: 5px 15px; border: none; border-radius: 999px; background: none;
  font-size: 12.5px; font-weight: 600; color: var(--ink-soft);
  transition: color .16s ease, background .16s ease, box-shadow .16s ease;
}
/* 选中用 accent 系浅底 + 正文色（不是 accent 实底配白/灰字）：
   cream/mint/sakura/lavender/night 五套主题下文字对比都在 8:1 以上；
   再补一圈 accent 内描边，选中项才从容器里「浮」出来。 */
.br-seg-btn.on {
  color: var(--ink); background: var(--accent-soft); font-weight: 700;
  box-shadow: inset 0 0 0 1px var(--accent), var(--shadow-sm);
}
.br-badge {
  min-width: 16px; height: 16px; padding: 0 4px; border-radius: 999px;
  background: #f2603f; color: #fff; font-size: 10px; font-weight: 600;
  line-height: 16px; text-align: center;
}

/* ── 提示 / 空态 ── */
.br-flash { margin-top: 8px; font-size: 12px; font-weight: 600; color: var(--accent-deep); }
.br-alert { margin-top: 8px; font-size: 12px; font-weight: 600; color: var(--low); }
.br-empty { padding: 40px 0 28px; text-align: center; font-size: 13px; color: var(--ink-faint); }

/* ── 记录卡 ── */
.bottle-record {
  margin-top: 12px; padding: 12px 14px;
  border: 1px solid var(--hairline); border-radius: 16px;
  background: var(--wash);
  transition: background .18s ease, border-color .18s ease, box-shadow .18s ease;
}
/* 待我决定的信：左侧竖一条 accent，比整圈描边安静，也不会跟 focused 抢 */
.bottle-record.needs { border-color: rgba(204, 120, 92, .4); box-shadow: inset 3px 0 0 var(--accent); }
.bottle-record.focused { border-color: var(--accent); background: var(--wash-mid); }
/* 轮 429：用户「进入漂流瓶聊天那个按钮跟上面靠的太近了」。
   全局 `* { margin: 0 }` 把 details 里最后一段的段间距清了，
   分界线加在 details 上（内容区 → 动作区的分界）。 */
.bottle-record > details { margin-bottom: 12px; }
.bottle-record > details:last-child { margin-bottom: 0; }

/* 折叠头：原生 ▶ 换成自绘 chevron（大小/颜色/角度都受控），展开时翻转 */
.bottle-record summary {
  display: flex; align-items: center; gap: 8px;
  min-height: 22px; list-style: none; cursor: pointer;
  font-size: 14px; font-weight: 600; color: var(--ink);
  overflow-wrap: anywhere;
}
.bottle-record summary::-webkit-details-marker { display: none; }
.bottle-record summary::before {
  content: ""; flex: 0 0 6px; width: 6px; height: 6px;
  border-right: 1.7px solid var(--ink-faint);
  border-bottom: 1.7px solid var(--ink-faint);
  transform: rotate(45deg);
  transition: transform .22s ease;
}
.bottle-record details[open] > summary::before { transform: rotate(-135deg); }
.bottle-record .bottle-need-dot { flex: 0 0 auto; margin-right: 0; }

/* 轮398：标题只占一行，超出用省略号；展开后正文才完整出现。 */
.bottle-record-title {
  flex: 1 1 auto; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* 展开后正文已经完整出现：标题退回类型标签，避免同一段文字又当标题又当正文。
   标签做纯文字（不再做成淡紫胶囊）—— 展开态那行只有 chevron + 这几个字，
   加个底会让人以为它是个能点的按钮。 */
.bottle-record-open-label {
  display: none; flex: 0 0 auto;
  font-size: 11.5px; font-weight: 600; letter-spacing: .02em;
  color: var(--ink-faint);
}
.bottle-record details[open] .bottle-record-title { display: none; }
.bottle-record details[open] .bottle-record-open-label { display: inline-block; }

.br-body { margin-top: 10px; }
.bottle-record-text {
  font-size: 13.5px; line-height: 1.75; color: var(--ink-soft);
  white-space: pre-wrap; overflow-wrap: anywhere;
}
.br-reply-label {
  display: block; margin-top: 12px;
  font-size: 11.5px; font-weight: 600; color: var(--accent-deep);
}
.bottle-record .fold-more { margin-top: 4px; font-size: 12px; }

/* ── 状态行：状态胶囊 ←→ 撤回/隐藏 ── */
.br-foot { display: flex; align-items: center; gap: 8px; }
.br-state {
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  padding: 2px 9px; border-radius: 999px;
  font-size: 11px; font-weight: 600; line-height: 1.7;
  color: var(--ink-soft); background: var(--wash-mid); border: 1px solid var(--hairline);
}
.br-state.wait { color: var(--accent-deep); background: var(--accent-soft); border-color: rgba(204, 120, 92, .35); }
.br-ops { margin-left: auto; flex: 0 0 auto; display: flex; align-items: center; gap: 6px; }
/* 撤回/隐藏：从「裸红字」变成有边界的低频小按钮，hover 才转实心红 */
.br-ops .bottle-op {
  padding: 3px 10px; border-radius: 8px;
  font-size: 11.5px; font-weight: 600;
  color: var(--ink-soft); background: var(--wash-mid); border: 1px solid var(--hairline);
}
.br-ops .bottle-op:hover:not(:disabled) { color: var(--accent-deep); background: var(--accent-soft); border-color: var(--accent); }
.br-ops .bottle-op-danger { color: var(--low); background: transparent; border-color: rgba(198, 69, 69, .28); }
.br-ops .bottle-op-danger:hover:not(:disabled) { color: #fff; background: var(--low); border-color: var(--low); }

/* ── 动作区 ── */
.br-acts { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px; }
.br-btn {
  appearance: none; font-family: inherit; cursor: pointer;
  height: 36px; padding: 0 12px; border-radius: 10px;
  font-size: 13px; font-weight: 600;
  color: var(--ink-soft); background: var(--wash-mid); border: 1px solid var(--hairline);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  transition: color .16s ease, background .16s ease, border-color .16s ease;
}
.br-btn:hover:not(:disabled) { color: var(--ink); border-color: var(--ink-faint); }
/* 主按钮默认跟全站口径一样用白字（.dm-act.primary 同源）；
   只有夜间主题要换深墨字 —— accent 在那里是淡紫 #8b9ce8，白字只有 2.6:1，
   「进入漂流瓶聊天」会糊成一片（用户报的就是夜间截图）。 */
.br-btn--main { color: #fff; background: var(--accent); border-color: transparent; }
.br-btn--main:hover:not(:disabled) { color: #fff; background: var(--accent-deep); }
html[data-theme="night"] .br-btn--main,
html[data-theme="night"] .br-btn--main:hover:not(:disabled) { color: #171a33; }
.br-btn--wide { display: block; width: 100%; margin-top: 10px; }
.br-btn:disabled { opacity: .5; cursor: default; }

.br-more {
  display: block; width: 100%; margin-top: 12px; height: 38px;
  appearance: none; font-family: inherit; cursor: pointer;
  border-radius: 12px; border: 1px solid var(--hairline);
  background: var(--wash); color: var(--ink-soft);
  font-size: 13px; font-weight: 600;
  transition: color .16s ease, border-color .16s ease, background .16s ease;
}
.br-more:hover:not(:disabled) { color: var(--accent-deep); background: var(--accent-soft); border-color: var(--accent); }
.br-more:disabled { opacity: .5; cursor: default; }
</style>
