/* 私信（/messages 会话列表；/messages/:id 具体会话）
 * ------------------------------------------------------------
 * 大站做法：
 *  - 左列会话列表（头像 / 昵称 / 最后一条预览 / 相对时间 / 未读红点 / 免打扰图标）；
 *  - 搜索框过滤会话；「消息请求」单独分组（陌生人首条消息，同意后才进列表）；
 *  - 右列气泡对话：我的靠右、对方靠左、跨天日期分隔、顶部「加载更早」分页；
 *  - 发送：Enter 发送 / Shift+Enter 换行、乐观上屏 + 发送中/失败标记；
 *  - 撤回（15 分钟内，显示「已撤回」占位）、免打扰、隐藏会话、拉黑/解除；
 *  - 打开会话即抬已读水位（服务端 dm_mark_read）；滚动到底部；仅在可见时轮询新消息。
 */
<script setup>
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch, defineAsyncComponent } from "vue";
import { useRoute, useRouter } from "vue-router";
import { NButton, NInput, NAvatar, NTag } from "naive-ui";
import { t, i18n } from "../i18n.js";
import { cloud } from "../utils/supabase.js";
import * as dmApi from "../utils/dm.js";
import { cacheKey, swr } from "../utils/cache.js";
import {
  previewText, sortConvs, filterConvs, withDayDividers, displayMsg,
  validateSend, sendErrKey, canRecall, relativeTime, rowView,
} from "../utils/dmRules.js";
import { badge, refreshBadge } from "../stores/badgeStore.js";
/* 轮 34：拉黑已全站生效（私信拦截 + 暖心墙内容隐藏）——这里走 userBlocks 的包装，
 * 让「拉黑名单」的内容过滤缓存与私信名单始终是同一份 */
import { blockUser, unblockUser, refreshBlocks } from "../utils/userBlocks.js";
import BottleRecords from "../components/BottleRecords.vue";
import { isMobileNav, pushBack, popBack } from "../stores/uiStore.js";
/* T7 消息 Tab 内分栏（私信 | 通知）：通知段直接复用 NotificationsView
 * （数据层零重写；异步 chunk 不拖慢首屏；挂载即拉第 0 页，配 SWR 缓存秒开） */
const NotificationsView = defineAsyncComponent(() => import("./NotificationsView.vue"));

const route = useRoute();
const router = useRouter();

const convs = ref([]);       // 会话列表
const q = ref("");           // 搜索
const loadingConvs = ref(false);
const failed = ref(false);
const signedIn = computed(() => !!(cloud.ready && cloud.user));

const activeId = ref(String(route.params.id || "")); // 当前会话（空串 = 只看列表）
const msgs = ref([]);        // 当前会话消息（旧→新）
const body = ref("");
const sending = ref(false);
const sendErr = ref("");
const loadingMsgs = ref(false);
const hasMore = ref(true);
const oldestId = ref(null);
const listEl = ref(null);
const meta = ref(null);      // 当前会话元信息（昵称 / 免打扰 / 拉黑 / 消息请求）
const menuFor = ref("");     // 展开操作菜单的会话 id
const fromList = ref(false); // 手机形态：本会话是从会话列表点进来的（← 用 router.back 回列表）

const REQ = "requests";      // 伪会话分组键（消息请求）

/* T8 分栏（手机端 1）：会话 | 漂流瓶 | 通知 三段（仅手机形态渲染分段条）；
 * 进聊天/回列表强制回「会话」段。漂流瓶段 = BottleRecords（原在会话列表底部的记录区，现在独立成段）。 */
const seg = ref("dm");
const dmBadge = computed(() => badge.dm + badge.requests);

/* T7 系统返回键：漂流瓶/通知段是消息 Tab 的**内部层级** → 先回会话段（App 惯例），
 * 已被接管则不再回退路由/最小化 App；离开本页弹栈。
 * 说明：聊天页共用「消息」Tab，但那时 seg 恒为 dm，这里返回 false 交回默认策略。 */
function segBack() {
  if (seg.value === "dm") return false;
  seg.value = "dm";
  return true;
}
const meId = computed(() => (cloud.user && cloud.user.id) || "");

/* #15 点头像/名字进对方主页（列表行与聊天头部共用） */
function goUser(id) {
  if (id) router.push({ name: "waller", params: { id } });
}

/* 常规会话 / 消息请求 分组（被拉黑的会话在 rowView 里把未读清零） */
const normal = computed(() => sortConvs(filterConvs(convs.value.filter((c) => c.accepted !== false), q.value)).map(rowView));
const requests = computed(() => sortConvs(filterConvs(convs.value.filter((c) => c.accepted === false), q.value)).map(rowView));

/* 带日期分隔的消息流 */
const flow = computed(() => withDayDividers(msgs.value.map(displayMsg)));

const activeConv = computed(() =>
  convs.value.find((c) => String(c.conv_id) === String(activeId.value)) || null);
const title = computed(() =>
  (meta.value && meta.value.nickname) || (activeConv.value && activeConv.value.nickname) || "");

/* 是否可以直接发：对方不是待处理请求、双方都没拉黑 */
const canType = computed(() => {
  if (!activeId.value) return false;
  const c = activeConv.value || meta.value || {};
  if (c.blocked) return false;
  if (c.accepted === false) return false;
  return true;
});
const blockedByMe = computed(() => !!(activeConv.value || meta.value || {}).blocked);

/* #19 已拉黑列表：集中查看、逐个解除（RPC dm_blocks / dm_unblock；拉黑本身零通知） */
const showBlocked = ref(false);
const blockedRows = ref([]);
const blockedBusy = ref("");
async function loadBlocked() {
  try { blockedRows.value = (await dmApi.blocks()) || []; }
  catch (e) { blockedRows.value = []; }
}
async function unblockOne(b) {
  blockedBusy.value = b.user_id;
  try {
    /* 轮 34：走 userBlocks 包装 —— 私信名单与暖心墙内容过滤缓存同步更新，
     * 解除后 TA 的帖子/评论在墙里立刻恢复显示，不用刷新页面 */
    await unblockUser(b.user_id);
    blockedRows.value = blockedRows.value.filter((x) => x.user_id !== b.user_id);
    await loadConvsImplicit();   /* 解除后会话恢复可见 */
  } catch (e) { /* 静默，行保留 */ }
  finally { blockedBusy.value = ""; }
}
function toggleBlockedPanel() {
  showBlocked.value = !showBlocked.value;
  if (showBlocked.value) loadBlocked();
}

/* ─────────── 数据加载 ─────────── */

async function loadConvs() {
  if (!signedIn.value) return;
  loadingConvs.value = true;
  /* 本地优先（SWR）：有缓存先渲染不闪「载入中」，后台刷新；换账号靠 key 里的 uid 隔离 */
  await swr(
    cacheKey("dm:convs", meId.value),
    {
      cached: (rows) => { convs.value = rows; loadingConvs.value = false; },
      fresh: (rows) => { convs.value = rows; failed.value = false; },
      onError: () => { failed.value = true; },
    },
    () => dmApi.listConvs(200, 0),
  );
  loadingConvs.value = false;
}

async function openBottleChat(id) {
  await loadConvs();
  await openConv(String(id));
}

async function loadMeta(id) {
  try { meta.value = await dmApi.convMeta(id); } catch (e) { /* 用列表里的行兜底 */ }
}

async function loadMessages(id, { before = null } = {}) {
  if (!id) return;
  loadingMsgs.value = true;
  const applyRows = (rows) => {
    /* 服务端返回新→旧：反转为旧→新（渲染顺序） */
    const asc = rows.slice().reverse();
    if (before == null) msgs.value = asc;
    else msgs.value = asc.concat(msgs.value);
    hasMore.value = rows.length === 30;
    oldestId.value = msgs.value.length ? msgs.value[0].id : null;
  };
  await swr(
    before == null ? cacheKey("dm:msgs", meId.value, id) : null,  /* 只缓存首屏；翻历史页不缓存 */
    {
      cached: (rows) => { applyRows(rows); loadingMsgs.value = false; scrollBottom(); },
      fresh: (rows) => {
        /* 刚发的乐观消息（负数临时 id）还在屏上 → 这轮先不覆盖，交给 5s 轮询 / send 后的重载 */
        if (msgs.value.some((m) => m.id < 0)) return;
        applyRows(rows);
      },
      onError: () => applyRows([]),
    },
    () => dmApi.listMessages(id, { before, limit: 30 }),
  );
  loadingMsgs.value = false;
}

function scrollBottom(smooth = false) {
  nextTick(() => {
    const el = listEl.value;
    if (!el) return;
    if (smooth && el.scrollTo) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    else el.scrollTop = el.scrollHeight;
  });
}

async function openConv(id) {
  seg.value = "dm";
  menuFor.value = "";
  const same = String(activeId.value) === String(id);
  activeId.value = String(id);
  /* 双形态导航（微信式）：
   *  - 手机形态：聊天是独立整屏页 → push，历史保留列表 → ← 钮 / 系统返回键都能回列表；
   *  - 桌面形态：列表与聊天同页双列 → replace，点会话不污染浏览器历史（原行为不变）。 */
  if (isMobileNav.value) {
    if (!same) fromList.value = true;
    router.push({ name: "messages", params: { id: String(id) } }).catch(() => {});
  } else {
    router.replace({ name: "messages", params: { id: String(id) } }).catch(() => {});
  }
  meta.value = null;
  await Promise.all([loadMessages(activeId.value), loadMeta(activeId.value)]);
  scrollBottom();
  dmApi.markRead(id).catch(() => {});
  refreshBadge();
}

/* ← 返回会话列表（手机形态）：从列表点进来 → 退一步（不留多余历史）；
 * 直链进来（通知中心 / 瓶子记录）→ 直接跳列表。 */
function backToList() {
  if (fromList.value) {
    fromList.value = false;
    router.back();
    return;
  }
  router.push({ name: "messagesList" }).catch(() => {});
}

/* ─────────── 发送 / 撤回 ─────────── */

async function send() {
  const err = validateSend(body.value, null);
  if (err) { sendErr.value = t(err); return; }
  const text = body.value.trim();
  const convId = activeId.value;
  body.value = "";
  sendErr.value = "";
  sending.value = true;
  /* 乐观上屏：临时 id 为负，服务端确认后整段重载 */
  const temp = {
    id: -Date.now(), sender: meId.value, body: text, image_path: null,
    created_at: new Date().toISOString(), pending: true,
  };
  msgs.value = msgs.value.concat([temp]);
  scrollBottom(true);
  try {
    await dmApi.send(convId, text, null);
    await loadMessages(convId);
    scrollBottom(true);
    const row = convs.value.find((c) => String(c.conv_id) === String(convId));
    if (row) { row.last_preview = text.slice(0, 80); row.last_message_at = new Date().toISOString(); }
    refreshBadge();
  } catch (e) {
    msgs.value = msgs.value.map((m) => (m.id === temp.id ? { ...m, pending: false, failed: true } : m));
    sendErr.value = t(sendErrKey(e));
  }
  sending.value = false;
}

async function recall(m) {
  try {
    await dmApi.recall(m, meId.value);
    msgs.value = msgs.value.map((x) =>
      (x.id === m.id ? { ...x, deleted_at: new Date().toISOString(), body: "", image_path: null } : x));
  } catch (e) {
    const late = e && String(e.message || e).includes("too-late");
    sendErr.value = t(late ? "dm.errTooLate" : "dm.errNetwork");
  }
  menuFor.value = "";
}

/* ────────── 会话操作：请求 / 免打扰 / 隐藏 / 拉黑 ─────────── */

async function acceptReq(c) {
  try { await dmApi.accept(c.conv_id); } catch (e) { /* 静默 */ }
  /* 关键：改的是 convs.value 里的原始行（computed requests/normal 都从它过滤）。
   * 之前改的是 rowView 生成的展示拷贝 → 列表纹丝不动，按钮一直挂在原地（用户实测）。 */
  const row = convs.value.find((x) => String(x.conv_id) === String(c.conv_id));
  if (row) row.accepted = true;
  if (meta.value && String(meta.value.conv_id) === String(c.conv_id)) meta.value.accepted = true;
  refreshBadge();
}

async function rejectReq(c) {
  try { await dmApi.hide(c.conv_id); } catch (e) { /* 静默 */ }
  convs.value = convs.value.filter((x) => x.conv_id !== c.conv_id);
  refreshBadge();
}

async function toggleMute(c) {
  const on = !c.muted;
  try { await dmApi.mute(c.conv_id, on); } catch (e) { /* 静默 */ }
  c.muted = on;
  menuFor.value = "";
}

async function hideConv(c) {
  try { await dmApi.hide(c.conv_id); } catch (e) { /* 静默 */ }
  convs.value = convs.value.filter((x) => x.conv_id !== c.conv_id);
  if (String(activeId.value) === String(c.conv_id)) {
    activeId.value = "";
    router.replace({ name: "messagesList" }).catch(() => {});
  }
  menuFor.value = "";
  refreshBadge();
}

async function toggleBlock(c) {
  const blocked = (activeConv.value || meta.value || {}).blocked;
  try {
    /* 轮 34：拉黑=全站生效（私信 + 暖心墙内容过滤），缓存同步走 userBlocks */
    if (blocked) await unblockUser(c.other_id);
    else await blockUser(c.other_id);
  } catch (e) { /* 静默 */ }
  menuFor.value = "";
  await loadConvs();
  refreshBadge();
}

/* ─────────── 轮询（只在可见 + 有会话时跑） ─────────── */

let timer = null;
async function tick() {
  if (typeof document !== "undefined" && document.hidden) return;
  if (!signedIn.value) return;
  await loadConvsImplicit();
  if (!activeId.value) return;
  const prev = msgs.value.length ? msgs.value[msgs.value.length - 1].id : null;
  try {
    const got = (await dmApi.listMessages(activeId.value, { before: null, limit: 30 })) || [];
    const asc = got.slice().reverse();
    if (asc.length && (!prev || asc[asc.length - 1].id !== prev)) {
      const el = listEl.value;
      const nearBottom = !el || (el.scrollHeight - el.scrollTop - el.clientHeight) < 120;
      msgs.value = asc;
      if (nearBottom) scrollBottom(true);
      dmApi.markRead(activeId.value).catch(() => {});
      refreshBadge();
    }
  } catch (e) { /* 静默 */ }
}

/* 轮询里的列表刷新：不动 loadingConvs，避免列表闪「载入中」 */
async function loadConvsImplicit() {
  try {
    convs.value = (await dmApi.listConvs(200, 0)) || [];
  } catch (e) { /* 静默 */ }
}

function onVisible() {
  if (typeof document !== "undefined" && !document.hidden) tick();
}

onMounted(async () => {
  pushBack(segBack);
  if (!signedIn.value) return;
  refreshBlocks();   /* 轮 34：进消息页同步拉黑名单（内容过滤与私信名单同源） */
  await loadConvs();
  if (activeId.value) await openConv(activeId.value);
  timer = setInterval(tick, 5000);
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
});

onBeforeUnmount(() => {
  popBack(segBack);
  clearInterval(timer);
  if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
});

/* 地址栏变了（通知中心点私信跳进来 / ← 钮 / 系统返回键）→ 切会话或回列表 */
watch(() => route.params.id, (v) => {
  const id = String(v || "");
  if (id) {
    if (id !== activeId.value) openConv(id);
    return;
  }
  /* 回到列表：清空当前会话（手机形态下 .dm-list 立刻接管整屏）+ 回私信段 */
  activeId.value = "";
  msgs.value = [];
  meta.value = null;
  fromList.value = false;
  seg.value = "dm";
});

const when = (ts) => relativeTime(ts, Date.now(), t);
/* ── 轮 19④：分栏左右滑（像首页三联那样：左滑去右边的栏，右滑去左边的栏）──
 * 顺序与顶部按钮一致：漂流瓶 | 会话 | 通知；只认横向主轴，纵向滚动不受影响；
 * 会话打开时列表整页隐藏（v-show=false），天然不触发，不会把聊天页滑走。 */
const SEG_ORDER = ["bottle", "dm", "notif"];
let segX = 0, segY = 0, segArmed = false;
function segTouchStart(e) {
  const t0 = e.touches[0];
  segX = t0.clientX; segY = t0.clientY; segArmed = true;
}
function segTouchMove(e) {
  if (!segArmed) return;
  const t0 = e.touches[0];
  const dx = t0.clientX - segX, dy = t0.clientY - segY;
  if (Math.abs(dx) < 56) return;                  /* 不够长不触发 */
  if (Math.abs(dx) < Math.abs(dy) * 1.4) return;  /* 斜着走＝想滚动，不触发 */
  segArmed = false;                               /* 一次手势只切一栏 */
  if (e.target && e.target.closest && e.target.closest("input, textarea, select")) return;
  const i = SEG_ORDER.indexOf(seg.value);
  const next = dx < 0 ? i + 1 : i - 1;
  if (next >= 0 && next < SEG_ORDER.length) seg.value = SEG_ORDER[next];
}
function segTouchEnd() { segArmed = false; }
const clock = (ts) => {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const dayLabel = (ts) => new Date(ts).toLocaleDateString(
  i18n.locale === "zh" ? "zh-CN" : "en-US", { year: "numeric", month: "short", day: "numeric" });

/* 未登录 → 登录页（轮 17 统一口径）：带当前 fullPath（含会话 id），登录后按 ?redirect=
 * 直接回到原处，不再绕道「我的」页 */
function goSignIn() {
  router.push({ path: "/login", query: { redirect: route.fullPath || "/messages" } });
}
</script>

<template>
  <div class="dm-page">
    <section v-if="!isMobileNav" class="card dm-head">
      <h1 class="dm-title">💬 {{ t("dm.title") }}</h1>
      <p class="sub">{{ t("dm.intro") }}</p>
    </section>

    <section v-if="!signedIn" class="card dm-empty">
      <p class="sub">{{ t("dm.needSignIn") }}</p>
      <n-button type="primary" round @click="goSignIn">{{ t("profile.goSignIn") }}</n-button>
    </section>

    <div v-else class="dm-wrap">
      <!-- 左列：会话列表（手机形态 = 微信式列表页；进入会话后整页让给聊天区） -->
      <aside
        v-show="!isMobileNav || !activeId"
        class="card dm-list"
        :class="{ 'dm-list--seg': isMobileNav && seg === 'notif' }"
        @touchstart.passive="segTouchStart"
        @touchmove.passive="segTouchMove"
        @touchend.passive="segTouchEnd">
        <!-- T8 分栏（仅手机形态）：漂流瓶 | 会话中心 | 通知（红点与桌面顶栏同口径） -->
        <div v-if="isMobileNav" class="dm-seg" role="tablist">
          <button type="button" class="dm-seg-btn" :class="{ on: seg === 'bottle' }" role="tab" :aria-selected="seg === 'bottle'" @click="seg = 'bottle'">
            {{ t("tab.segBottle") }}
          </button>
          <button type="button" class="dm-seg-btn" :class="{ on: seg === 'dm' }" role="tab" :aria-selected="seg === 'dm'" @click="seg = 'dm'">
            {{ t("tab.segDm") }}
            <span v-if="dmBadge" class="notif-count">{{ dmBadge > 99 ? "99+" : dmBadge }}</span>
          </button>
          <button type="button" class="dm-seg-btn" :class="{ on: seg === 'notif' }" role="tab" :aria-selected="seg === 'notif'" @click="seg = 'notif'">
            {{ t("tab.segNotif") }}
            <span v-if="badge.notif" class="notif-count">{{ badge.notif > 99 ? "99+" : badge.notif }}</span>
          </button>
        </div>

        <template v-if="!isMobileNav || seg === 'dm'">
        <n-input v-model:value="q" size="small" round clearable :placeholder="t('dm.search')" class="dm-search" />

        <!-- #19 已拉黑：集中查看 / 解除（拉黑与解除都不通知对方） -->
        <div class="dm-blocked-bar">
          <button class="dm-act" @click="toggleBlockedPanel">
            {{ t("dm.blockedTitle") }}<template v-if="blockedRows.length"> · {{ blockedRows.length }}</template>
          </button>
        </div>
        <div v-if="showBlocked" class="dm-blocked">
          <p class="sub">{{ t("dm.blockedHint") }}</p>
          <p v-if="!blockedRows.length" class="sub">{{ t("dm.blockedEmpty") }}</p>
          <div v-for="b in blockedRows" :key="b.user_id" class="dm-blocked-row">
            <n-avatar round :size="30" class="post-avatar clickable" :title="t('dm.viewHome')" @click="goUser(b.user_id)">
              {{ (b.nickname || "?").slice(0, 1).toUpperCase() }}
            </n-avatar>
            <b class="dm-name">{{ b.nickname || t("dm.someone") }}</b>
            <button class="dm-act" :disabled="blockedBusy === b.user_id" @click="unblockOne(b)">
              {{ t("dm.blockedGo") }}
            </button>
          </div>
        </div>

        <p v-if="failed" class="notice">{{ t("dm.loadFail") }}</p>

        <!-- 消息请求：陌生人首条消息，同意才进列表 -->
        <template v-if="requests.length">
          <div class="dm-sec">
            <span class="sec-label">{{ t("dm.requests") }}</span>
            <span class="notif-count">{{ requests.length }}</span>
          </div>
          <div v-for="c in requests" :key="'r' + c.conv_id" class="dm-row req">
            <n-avatar round :size="38" class="post-avatar clickable" :title="t('dm.viewHome')" @click.stop="goUser(c.other_id)">{{ (c.nickname || "?").slice(0, 1).toUpperCase() }}</n-avatar>
            <div class="dm-row-body">
              <div class="dm-row-top">
                <b class="dm-name">{{ c.nickname }}</b>
                <span class="sub dm-time">{{ when(c.last_message_at || c.created_at) }}</span>
              </div>
              <p class="sub dm-preview">{{ previewText(c.last_preview, t) }}</p>
              <div class="dm-req-acts">
                <button class="dm-act primary" @click="acceptReq(c)">{{ t("dm.accept") }}</button>
                <button class="dm-act" @click="rejectReq(c)">{{ t("dm.reject") }}</button>
              </div>
            </div>
          </div>
        </template>

        <template v-if="normal.length">
          <div class="dm-sec"><span class="sec-label">{{ t("dm.conversations") }}</span></div>
          <div
            v-for="c in normal" :key="c.conv_id"
            class="dm-row" :class="{ on: String(c.conv_id) === String(activeId) }"
            @click="openConv(c.conv_id)">
            <n-avatar round :size="38" class="post-avatar clickable" :title="t('dm.viewHome')" @click.stop="goUser(c.other_id)">{{ (c.nickname || "?").slice(0, 1).toUpperCase() }}</n-avatar>
            <div class="dm-row-body">
              <div class="dm-row-top">
                <b class="dm-name">{{ c.nickname }}</b>
                <span class="sub dm-time">{{ when(c.last_message_at || c.created_at) }}</span>
              </div>
              <p class="sub dm-preview">
                <span v-if="c.muted" class="dm-muted">🔇</span>
                {{ previewText(c.last_preview, t) }}
              </p>
            </div>
            <span v-if="c.unread" class="dm-badge">{{ c.unread > 99 ? "99+" : c.unread }}</span>
            <button class="dm-more" :title="t('dm.more')" @click.stop="menuFor = (menuFor === String(c.conv_id) ? '' : String(c.conv_id))">⋯</button>
            <div v-if="menuFor === String(c.conv_id)" class="dm-menu">
              <button class="dm-menu-item" @click.stop="openConv(c.conv_id); menuFor = ''">{{ t("dm.open") }}</button>
              <button class="dm-menu-item" @click.stop="toggleMute(c)">{{ c.muted ? t("dm.unmute") : t("dm.mute") }}</button>
              <button class="dm-menu-item" @click.stop="hideConv(c)">{{ t("dm.hide") }}</button>
              <button class="dm-menu-item danger" @click.stop="toggleBlock(c)">{{ t("dm.block") }}</button>
            </div>
          </div>
        </template>

        <p v-if="!normal.length && !requests.length && !loadingConvs" class="sub dm-empty">{{ t("dm.empty") }}</p>
        <!-- 漂流瓶记录：桌面仍在会话列表底部（原位）；手机端 1 独立成「漂流瓶」段 -->
        <BottleRecords v-if="!isMobileNav" @open="openBottleChat" />
        </template>
        <BottleRecords v-else-if="seg === 'bottle'" @open="openBottleChat" />
        <NotificationsView v-else-if="seg === 'notif'" class="dm-seg-notif" />
      </aside>

      <!-- 右列：当前会话（手机形态 = 微信式独立聊天页，带返回） -->
      <section v-show="!isMobileNav || !!activeId" class="card dm-thread">
        <template v-if="activeId">
          <header class="dm-thread-head">
            <button v-if="isMobileNav" class="dm-thread-back" @click="backToList">←</button>
            <b class="dm-name dm-peer-link" :title="t('dm.viewHome')" @click="goUser(activeConv && activeConv.other_id)">{{ title || t("dm.someone") }}</b>
            <span v-if="activeConv && activeConv.muted" class="dm-muted">🔇 {{ t("dm.mutedTag") }}</span>
            <n-tag v-if="activeConv && activeConv.accepted === false" round size="small" :bordered="false" class="soft-tag">
              {{ t("dm.requestTag") }}
            </n-tag>
            <span class="dm-spacer"></span>
            <button v-if="activeConv" class="dm-act" @click="toggleBlock(activeConv)">
              {{ (activeConv.blocked) ? t("dm.unblock") : t("dm.block") }}
            </button>
          </header>

          <!-- 消息流 -->
          <div ref="listEl" class="dm-scroll">
            <div class="dm-topmore">
              <button v-if="hasMore && oldestId" class="dm-act" :disabled="loadingMsgs"
                @click="loadMessages(activeId, { before: oldestId })">{{ t("dm.older") }}</button>
              <span v-else class="sub">{{ t("dm.reachTop") }}</span>
            </div>

            <template v-for="it in flow" :key="it.key">
              <div v-if="it.type === 'day'" class="dm-day"><span>{{ dayLabel(it.ts) }}</span></div>
              <div v-else class="dm-line" :class="{ mine: it.msg.sender === meId }">
                <div class="dm-bubble" :class="{ recalled: it.msg.recalled, failed: it.msg.failed }">
                  <p v-if="it.msg.recalled" class="dm-recalled">{{ t("dm.recalled") }}</p>
                  <p v-else class="dm-text">{{ it.msg.body }}</p>
                  <span class="dm-stamp">
                    {{ it.msg.pending ? t("dm.sending") : it.msg.failed ? t("dm.sendFailed") : clock(it.msg.created_at) }}
                  </span>
                </div>
                <button
                  v-if="canRecall(it.msg, meId) && !it.msg.pending"
                  class="dm-recall" :title="t('dm.recall')"
                  @click="recall(it.msg)">{{ t("dm.recall") }}</button>
              </div>
            </template>

            <p v-if="!flow.length && !loadingMsgs" class="sub dm-empty">{{ t("dm.noMessages") }}</p>
          </div>

          <!-- 输入区 -->
          <footer class="dm-compose">
            <p v-if="!canType" class="notice dm-gate">
              {{ blockedByMe ? t("dm.gateBlockedByMe") : t("dm.gateRequest") }}
            </p>
            <template v-else>
              <n-input
                v-model:value="body" type="textarea" :rows="2" :maxlength="2000"
                :placeholder="isMobileNav ? t('dm.placeholderMobile') : t('dm.placeholder')"
                @keydown.enter.exact.prevent="send" />
              <div class="dm-send-row">
                <span class="sub dm-hint">{{ t("dm.hint") }}</span>
                <span v-if="sendErr" class="sub dm-err">{{ sendErr }}</span>
                <n-button type="primary" round size="small" :loading="sending" :disabled="!body.trim()" @click="send">
                  {{ t("dm.send") }}
                </n-button>
              </div>
            </template>
          </footer>
        </template>

        <p v-else class="sub dm-empty">{{ t("dm.pickOne") }}</p>
      </section>
    </div>

    <router-link v-if="!isMobileNav" class="dm-back" to="/">{{ "← " + t("nav.home") }}</router-link>
  </div>
</template>
