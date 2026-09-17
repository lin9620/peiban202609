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
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { NButton, NInput, NAvatar, NTag } from "naive-ui";
import { t, i18n } from "../i18n.js";
import { cloud } from "../utils/supabase.js";
import * as dmApi from "../utils/dm.js";
import {
  previewText, sortConvs, filterConvs, withDayDividers, displayMsg,
  validateSend, sendErrKey, canRecall, relativeTime, rowView,
} from "../utils/dmRules.js";
import { refreshBadge } from "../stores/badgeStore.js";
import BottleRecords from "../components/BottleRecords.vue";

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

const REQ = "requests";      // 伪会话分组键（消息请求）
const meId = computed(() => (cloud.user && cloud.user.id) || "");

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

/* ─────────── 数据加载 ─────────── */

async function loadConvs() {
  if (!signedIn.value) return;
  loadingConvs.value = true;
  try {
    convs.value = (await dmApi.listConvs(200, 0)) || [];
    failed.value = false;
  } catch (e) {
    failed.value = true;
  }
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
  let got = [];
  try {
    got = (await dmApi.listMessages(id, { before, limit: 30 })) || [];
  } catch (e) { got = []; }
  /* 服务端返回新→旧：反转为旧→新（渲染顺序） */
  const asc = got.slice().reverse();
  if (before == null) msgs.value = asc;
  else msgs.value = asc.concat(msgs.value);
  hasMore.value = got.length === 30;
  oldestId.value = msgs.value.length ? msgs.value[0].id : null;
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
  menuFor.value = "";
  activeId.value = String(id);
  router.replace({ name: "messages", params: { id: String(id) } }).catch(() => {});
  meta.value = null;
  await Promise.all([loadMessages(activeId.value), loadMeta(activeId.value)]);
  scrollBottom();
  dmApi.markRead(id).catch(() => {});
  refreshBadge();
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
  c.accepted = true;
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
    if (blocked) await dmApi.unblock(c.other_id);
    else await dmApi.block(c.other_id);
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
  if (!signedIn.value) return;
  await loadConvs();
  if (activeId.value) await openConv(activeId.value);
  timer = setInterval(tick, 5000);
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
});

onBeforeUnmount(() => {
  clearInterval(timer);
  if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
});

/* 地址栏变了（通知中心点私信跳进来）→ 切会话 */
watch(() => route.params.id, (v) => {
  const id = String(v || "");
  if (id && id !== activeId.value) openConv(id);
});

const when = (ts) => relativeTime(ts, Date.now(), t);
const clock = (ts) => {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const dayLabel = (ts) => new Date(ts).toLocaleDateString(
  i18n.locale === "zh" ? "zh-CN" : "en-US", { year: "numeric", month: "short", day: "numeric" });
</script>

<template>
  <div class="dm-page">
    <section class="card dm-head">
      <h1 class="dm-title">💬 {{ t("dm.title") }}</h1>
      <p class="sub">{{ t("dm.intro") }}</p>
    </section>

    <section v-if="!signedIn" class="card dm-empty">
      <p class="sub">{{ t("dm.needSignIn") }}</p>
      <n-button type="primary" round @click="router.push('/profile')">{{ t("nav.profile") }}</n-button>
    </section>

    <div v-else class="dm-wrap">
      <!-- 左列：会话列表 -->
      <aside class="card dm-list">
        <n-input v-model:value="q" size="small" round clearable :placeholder="t('dm.search')" class="dm-search" />

        <p v-if="failed" class="notice">{{ t("dm.loadFail") }}</p>

        <!-- 消息请求：陌生人首条消息，同意才进列表 -->
        <template v-if="requests.length">
          <div class="dm-sec">
            <span class="sec-label">{{ t("dm.requests") }}</span>
            <span class="notif-count">{{ requests.length }}</span>
          </div>
          <div v-for="c in requests" :key="'r' + c.conv_id" class="dm-row req">
            <n-avatar round :size="38" class="post-avatar">{{ (c.nickname || "?").slice(0, 1).toUpperCase() }}</n-avatar>
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
            <n-avatar round :size="38" class="post-avatar">{{ (c.nickname || "?").slice(0, 1).toUpperCase() }}</n-avatar>
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
        <BottleRecords @open="openBottleChat" />
      </aside>

      <!-- 右列：当前会话 -->
      <section class="card dm-thread">
        <template v-if="activeId">
          <header class="dm-thread-head">
            <b class="dm-name">{{ title || t("dm.someone") }}</b>
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
                :placeholder="t('dm.placeholder')"
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

    <router-link class="dm-back" to="/">{{ "← " + t("nav.home") }}</router-link>
  </div>
</template>
