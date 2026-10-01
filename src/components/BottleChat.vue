<script setup>
/* 轮 142 · 私信页「漂流瓶」段中列：**独立的漂流瓶聊天框**
 * ------------------------------------------------------------
 * 与「会话」段的 dm-thread 各自单开、状态不共用（用户口径）：
 * 同一人在两边都出现时，就是两块聊天框各显示同样内容，互不影响。
 * 三种形态：
 *   ① 没选信 → 空态（bottle.chatPick）
 *   ② 待我决定（choose）→ 原信 + 回信 + 「同意 / 拒绝」（同意即建会话 → 转 ③）
 *   ③ 已建会话（accepted）→ 消息流（复用 dm 消息 RPC）+ 输入区（Enter 发送 / Shift+Enter 换行）
 * 其余状态（漂流中 / 等对方同意 / 已留作书信 / 在你手里 / 被捞起）→ 原信 + 状态说明。
 */
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from "vue";
import { NAvatar, NButton, NInput } from "naive-ui";
import { t, i18n } from "../i18n.js";
import { bottleChatState, bottleChatDecide, bottleErrKey } from "../utils/bottle.js";
import * as dmApi from "../utils/dm.js";
import { displayMsg, withDayDividers, canRecall, validateSend, sendErrKey } from "../utils/dmRules.js";
import { refreshBadge } from "../stores/badgeStore.js";

const props = defineProps({
  letter: { type: Object, default: null },   /* 左列选中的漂流瓶记录行（bottle_letters.*） */
  meId: { type: String, default: "" },
  peerName: { type: String, default: "" },   /* 父级解析好的对方昵称（取不到时已兜底） */
});
const emit = defineEmits(["accepted", "peer"]);   /* accepted(convId) / peer({user_id, nickname, ...meta}) */

const state = computed(() => bottleChatState(props.letter, props.meId));
const peerId = computed(() => {
  const l = props.letter;
  if (!l) return "";
  return l.user_id === props.meId ? l.reply_by : l.user_id;
});
const peerInitial = computed(() => (props.peerName || "?").slice(0, 1).toUpperCase());
const statusTk = computed(() => ({
  picked: "bottle.stPicked", inhand: "bottle.stInHand", drifting: "bottle.pending",
  waiting: "bottle.chatWaiting", declined: "bottle.chatDeclined",
}[state.value] || "bottle.pending"));

const convId = computed(() => (props.letter && props.letter.conv_id) || "");
/* 只有「已建会话」才有输入框；待决定/其它状态走说明区 */
const chatting = computed(() => state.value === "accepted" && !!convId.value);

/* ─────────── 消息流（与会话段同款渲染口径，状态独立） ─────────── */
const msgs = ref([]);
const body = ref("");
const sending = ref(false);
const sendErr = ref("");
const loadingMsgs = ref(false);
const hasMore = ref(true);
const oldestId = ref(null);
const listEl = ref(null);
const busyDecide = ref(false);

const flow = computed(() => withDayDividers(msgs.value.map(displayMsg)));

const clock = (ts) => {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const dayLabel = (ts) => new Date(ts).toLocaleDateString(
  i18n.locale === "zh" ? "zh-CN" : "en-US", { year: "numeric", month: "short", day: "numeric" });

function scrollBottom(smooth = false) {
  nextTick(() => {
    const el = listEl.value;
    if (!el) return;
    if (smooth && el.scrollTo) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    else el.scrollTop = el.scrollHeight;
  });
}

async function loadMessages(id, { before = null } = {}) {
  if (!id) return;
  loadingMsgs.value = true;
  try {
    const rows = (await dmApi.listMessages(id, { before, limit: 30 })) || [];
    const asc = rows.slice().reverse();
    if (before == null) msgs.value = asc;
    else msgs.value = asc.concat(msgs.value);
    hasMore.value = rows.length === 30;
    oldestId.value = msgs.value.length ? msgs.value[0].id : null;
  } catch (e) {
    if (before == null) msgs.value = [];
  }
  loadingMsgs.value = false;
}

async function syncMeta() {
  if (!convId.value) return;
  try { emit("peer", await dmApi.convMeta(convId.value)); } catch (e) { /* 用左列名字兜底 */ }
}

/* 选中一封信 → 已建会话就拉消息并抬已读；其它状态只发一次 peer（资料卡用左列名字） */
async function onLetter() {
  msgs.value = [];
  body.value = "";
  sendErr.value = "";
  if (!props.letter) return;
  if (peerId.value) emit("peer", { user_id: peerId.value, nickname: props.peerName });
  if (!chatting.value) return;
  await Promise.all([loadMessages(convId.value), syncMeta()]);
  scrollBottom();
  dmApi.markRead(convId.value).catch(() => {});
  refreshBadge();
}
watch(() => [props.letter && props.letter.id, convId.value], onLetter, { immediate: true });

async function decide(accept) {
  if (busyDecide.value || !props.letter) return;
  busyDecide.value = true;
  try {
    const result = await bottleChatDecide(props.letter.id, accept);
    if (!result || !["accepted", "declined"].includes(result.decision)) throw new Error("bottle-invalid-result");
    props.letter.chat_decision = result.decision;
    props.letter.conv_id = result.conv_id;
    refreshBadge();
    if (result.decision === "accepted" && result.conv_id) emit("accepted", result.conv_id);
  } catch (e) {
    sendErr.value = t(bottleErrKey(e));
  } finally {
    busyDecide.value = false;
  }
}

async function send() {
  const err = validateSend(body.value, null);
  if (err) { sendErr.value = t(err); return; }
  const text = body.value.trim();
  const id = convId.value;
  if (!id) return;
  body.value = "";
  sendErr.value = "";
  sending.value = true;
  const temp = {
    id: -Date.now(), sender: props.meId, body: text, image_path: null,
    created_at: new Date().toISOString(), pending: true,
  };
  msgs.value = msgs.value.concat([temp]);
  scrollBottom(true);
  try {
    await dmApi.send(id, text, null);
    await loadMessages(id);
    scrollBottom(true);
    refreshBadge();
  } catch (e) {
    msgs.value = msgs.value.map((m) => (m.id === temp.id ? { ...m, pending: false, failed: true } : m));
    sendErr.value = t(sendErrKey(e));
  }
  sending.value = false;
}

async function recall(m) {
  try {
    await dmApi.recall(m, props.meId);
    msgs.value = msgs.value.map((x) =>
      (x.id === m.id ? { ...x, deleted_at: new Date().toISOString(), body: "", image_path: null } : x));
  } catch (e) {
    const late = e && String(e.message || e).includes("too-late");
    sendErr.value = t(late ? "dm.errTooLate" : "dm.errNetwork");
  }
}

/* 可见时 5s 轮询（与私信同节拍；只在本段已建会话时跑） */
let timer = null;
async function tick() {
  if (typeof document !== "undefined" && document.hidden) return;
  if (!chatting.value) return;
  const prev = msgs.value.length ? msgs.value[msgs.value.length - 1].id : null;
  try {
    const got = (await dmApi.listMessages(convId.value, { before: null, limit: 30 })) || [];
    const asc = got.slice().reverse();
    if (asc.length && (!prev || asc[asc.length - 1].id !== prev)) {
      const el = listEl.value;
      const nearBottom = !el || (el.scrollHeight - el.scrollTop - el.clientHeight) < 120;
      msgs.value = asc;
      if (nearBottom) scrollBottom(true);
      dmApi.markRead(convId.value).catch(() => {});
      refreshBadge();
    }
  } catch (e) { /* 静默 */ }
}
onMounted(() => { timer = setInterval(tick, 5000); });
onBeforeUnmount(() => { clearInterval(timer); });
</script>

<template>
  <section class="card dm-thread bchat">
    <p v-if="!letter" class="sub dm-empty bchat-empty">{{ t("bottle.chatPick") }}</p>

    <template v-else>
      <header class="dm-thread-head">
        <n-avatar round :size="40" class="dm-msg-avatar">{{ peerInitial }}</n-avatar>
        <b class="dm-name">{{ props.peerName || t("bottle.peerFallback") }}</b>
        <span class="bchat-tag">{{ t("bottle.title") }}</span>
        <span class="dm-spacer"></span>
      </header>

      <!-- ② 待我决定 / 其它状态：原信 + 回信 + 说明（无输入框） -->
      <div v-if="!chatting" class="dm-scroll bchat-letter">
        <article class="bchat-card">
          <b class="sub">{{ letter.user_id === meId ? t("bottle.myLetter") : t("bottle.fromSea") }}</b>
          <p class="bchat-text">{{ letter.body }}</p>
        </article>
        <article v-if="letter.reply" class="bchat-card">
          <b class="sub">{{ t(letter.reply_by === meId ? "bottle.replyMine" : "bottle.replyFrom") }}</b>
          <p class="bchat-text">{{ letter.reply }}</p>
        </article>
        <template v-if="state === 'choose'">
          <p class="sub">{{ t("bottle.chatQuestion") }}</p>
          <p v-if="sendErr" class="sub dm-err">{{ sendErr }}</p>
          <div class="bchat-decide">
            <n-button type="primary" round size="small" :loading="busyDecide" @click="decide(true)">
              {{ t("bottle.chatAccept") }}
            </n-button>
            <button class="dm-act" :disabled="busyDecide" @click="decide(false)">{{ t("bottle.chatDecline") }}</button>
          </div>
        </template>
        <p v-else class="sub">{{ t(statusTk) }}</p>
      </div>

      <!-- ③ 已建会话：消息流 + 输入区（与「会话」段各自独立） -->
      <template v-else>
        <div ref="listEl" class="dm-scroll">
          <div class="dm-topmore">
            <button v-if="hasMore && oldestId" class="dm-act" :disabled="loadingMsgs"
              @click="loadMessages(convId, { before: oldestId })">{{ t("dm.older") }}</button>
            <span v-else class="sub">{{ t("dm.reachTop") }}</span>
          </div>

          <template v-for="it in flow" :key="it.key">
            <div v-if="it.type === 'day'" class="dm-day"><span>{{ dayLabel(it.ts) }}</span></div>
            <div v-else class="dm-line" :class="{ mine: it.msg.sender === meId }">
              <n-avatar v-if="it.msg.sender !== meId" round :size="30" class="dm-msg-avatar">{{ peerInitial }}</n-avatar>
              <div class="dm-msg-col">
                <div class="dm-bubble" :class="{ recalled: it.msg.recalled, failed: it.msg.failed }">
                  <p v-if="it.msg.recalled" class="dm-recalled">{{ t("dm.recalled") }}</p>
                  <p v-else class="dm-text">{{ it.msg.body }}</p>
                </div>
                <span class="dm-stamp">
                  {{ it.msg.pending ? t("dm.sending") : it.msg.failed ? t("dm.sendFailed") : clock(it.msg.created_at) }}
                  <button
                    v-if="canRecall(it.msg, meId) && !it.msg.pending"
                    class="dm-recall" :title="t('dm.recall')"
                    @click="recall(it.msg)">{{ t("dm.recall") }}</button>
                </span>
              </div>
            </div>
          </template>

          <p v-if="!flow.length && !loadingMsgs" class="sub dm-empty">{{ t("dm.noMessages") }}</p>
        </div>

        <footer class="dm-compose">
          <p class="sub dm-hint">{{ t("dm.hint") }}</p>
          <p v-if="sendErr" class="sub dm-err">{{ sendErr }}</p>
          <div class="dm-input-row">
            <n-input
              v-model:value="body" type="textarea" :autosize="{ minRows: 1, maxRows: 6 }" :maxlength="2000"
              :placeholder="t('dm.placeholder')" @keydown.enter.exact.prevent="send" />
            <n-button type="primary" round size="small" :loading="sending" :disabled="!body.trim()" @click="send">
              {{ t("dm.send") }}
            </n-button>
          </div>
        </footer>
      </template>
    </template>
  </section>
</template>

