<!-- 温暖漂流瓶（T6 抽件）：写信投海 / 捞信回信放回 / 记录两栏分页（本地优先缓存）。
     桌面首页收尾与手机「漂流瓶」联（默认联）共用同一组件。 -->
<script setup>
import { ref, computed, watch, onMounted } from "vue";
import { useRouter } from "vue-router";
import { NButton, NInput } from "naive-ui";
import { t } from "../i18n.js";
import { todayKey } from "../utils/daily.js";
import { getItem, setItem } from "../utils/storage.js";
import {
  BOTTLE_BODY_MAX, BOTTLE_SEND_MAX, BOTTLE_FISH_MAX,
  canBottle, bottleErrKey,
  bottleSend, bottleFish, bottleReply, bottleRelease, bottleHeld,
  bottleRecords, bottleChatState, bottleChatDecide,
} from "../utils/bottle.js";
import { relativeTime } from "../utils/dmRules.js";
import { cloud } from "../utils/supabase.js";
import { cacheKey, swr } from "../utils/cache.js";

const router = useRouter();   /* #17 记录里「去聊天」直接进会话页 */
const cloudSigned = computed(() => !!(cloud.ready && cloud.user));
const mailDraft = ref("");
const replyDraft = ref("");
const mailBusy = ref(false);
const mailHint = ref("");
const fishing = ref(false);
const fished = ref(null);       /* 刚捞起、还没处理的这封 */
const held = ref([]);           /* 我之前捞起、还没回的信（换页/刷新后找回来） */

/* 每日次数用本机日键记账（展示用）；超不超由服务端说了算。
 * 键按账号分（修「换账号登录，可捞次数还是上个人的」）：uid 进键名，
 * A/B 两个账号各记各的账，登出换号立刻换账本。 */
const myId = computed(() => (cloud.user && cloud.user.id) || "");
const QUOTA_BASE = "warm-paws-bottle-quota-v1";
const quotaKey = computed(() => `${QUOTA_BASE}:${myId.value || "guest"}`);
function freshQuota() { return { day: todayKey(), sent: 0, fished: 0 }; }
function loadQuota() {
  try {
    const q = JSON.parse(getItem(quotaKey.value));
    return q && q.day === todayKey() ? q : freshQuota();
  } catch (e) { return freshQuota(); }
}
const quota = ref(loadQuota());
const sendLeft = computed(() => Math.max(0, BOTTLE_SEND_MAX - quota.value.sent));
const fishLeft = computed(() => Math.max(0, BOTTLE_FISH_MAX - quota.value.fished));
function bumpQuota(k) {
  if (quota.value.day !== todayKey()) quota.value = freshQuota();
  quota.value[k] += 1;
  setItem(quotaKey.value, JSON.stringify(quota.value));
}
watch(myId, () => { quota.value = loadQuota(); fished.value = null; });

const tray = computed(() => fished.value || held.value[0] || null);

async function refreshBottle() {
  if (!cloudSigned.value) return;
  /* #17 记录区改走 bottleRecords 分类分页；这里只管「捞起的信」找回（tray） */
  await swr(
    cacheKey("bottle:held", myId.value),
    {
      cached: (rows) => { held.value = rows || []; },
      fresh: (rows) => { held.value = rows || []; },
    },
    () => bottleHeld(),
  );
  fished.value = null;
}

async function doSend() {
  const body = mailDraft.value.trim();
  if (!body || sendLeft.value <= 0) return;
  mailBusy.value = true;
  mailHint.value = "";
  try {
    await bottleSend(body);
    mailDraft.value = "";
    bumpQuota("sent");
    await refreshBottle();
  } catch (e) {
    mailHint.value = t(bottleErrKey(e));
  } finally { mailBusy.value = false; }
}

async function doFish() {
  if (fishLeft.value <= 0) return;
  fishing.value = true;
  mailHint.value = "";
  try {
    const l = await bottleFish();
    fished.value = l;
    bumpQuota("fished");
  } catch (e) {
    mailHint.value = t(bottleErrKey(e));
  } finally { fishing.value = false; }
}

async function doReply() {
  const l = tray.value;
  if (!l || !replyDraft.value.trim()) return;
  mailBusy.value = true;
  mailHint.value = "";
  try {
    await bottleReply(l.id, replyDraft.value.trim());
    replyDraft.value = "";
    fished.value = null;
    await refreshBottle();
  } catch (e) {
    mailHint.value = t(bottleErrKey(e));
  } finally { mailBusy.value = false; }
}

async function doRelease() {
  const l = tray.value;
  if (!l) return;
  try {
    await bottleRelease(l.id);
    fished.value = null;
    await refreshBottle();
  } catch (e) {
    mailHint.value = t(bottleErrKey(e));
  }
}

onMounted(() => { refreshBottle(); loadRecords(true); });

/* —— 漂流瓶记录（#17）：我发布的 / 我捞到的 两类，按发布时间新→旧，10 条一页 —— */
const REC_PAGE = 10;
const recTab = ref("mine");      /* mine = 我发布的；held = 我捞到的 */
const recRows = ref([]);
const recPage = ref(0);
const recDone = ref(false);
const recLoading = ref(false);

async function loadRecords(reset = false) {
  if (!cloudSigned.value || recLoading.value) return;
  recLoading.value = true;
  const target = reset ? 0 : recPage.value;
  const applyRows = (got) => {
    recRows.value = got;
    recPage.value = target;
    recDone.value = got.length < REC_PAGE;
  };
  await swr(
    reset ? cacheKey("bottle:rec", myId.value, recTab.value) : null,  /* 只缓存每栏第 0 页 */
    {
      cached: (got) => { applyRows(got); recLoading.value = false; },
      fresh: applyRows,
      onError: () => { recRows.value = []; recDone.value = true; },
    },
    () => bottleRecords(null, target * REC_PAGE, {
      mine: recTab.value === "mine", limit: REC_PAGE,
    }),
  );
  recLoading.value = false;
}
function switchRecTab(x) {
  if (recTab.value === x) return;
  recTab.value = x;
  loadRecords(true);
}
function recPageGo(d) {
  const next = recPage.value + d;
  if (next < 0 || (d > 0 && recDone.value)) return;
  recPage.value = next;
  loadRecords(false);
}
const whenRec = (ts) => relativeTime(ts, Date.now(), t);

/* 我发布的一封的当前状态：被捞走 / 已有回信 / 还在海里；我捞到的：已回信 / 在我手里 / 已放回 */
function recState(l) {
  if (recTab.value === "mine") {
    /* 收到回信还没决定 → 直接在这条记录上给「同意 / 拒绝」按钮（用户反馈：点不了=没用） */
    if (bottleChatState(l, myId.value) === "choose") return "bottle.stDecide";
    if (l.status === "answered") return "bottle.stReplied";
    if (l.status === "held") return "bottle.stPicked";
    return "bottle.stSea";
  }
  if (l.reply_by === myId.value) return "bottle.stAnswered";
  if (l.status === "held") return "bottle.stInHand";
  return "bottle.stReleased";
}
/* 点击记录进聊天：仅双方确认建立会话后（数据库裁定，按钮只对 accepted 出现） */
function canChat(l) {
  return bottleChatState(l, myId.value) === "accepted" && !!l.conv_id;
}
function openRec(l) {
  if (canChat(l)) router.push({ name: "messages", params: { id: String(l.conv_id) } });
}
/* 在记录列表里直接决定要不要和 TA 聊（不必再跑去消息页找那张卡片） */
const recBusy = ref("");
const recErr = ref("");
async function decideRec(l, accept) {
  if (recBusy.value) return;
  recBusy.value = l.id;
  recErr.value = "";
  try {
    const r = await bottleChatDecide(l.id, accept);
    if (!r || !["accepted", "declined"].includes(r.decision)) throw new Error("bottle-invalid-result");
    l.chat_decision = r.decision;
    if (r.conv_id) l.conv_id = r.conv_id;
    if (r.decision === "accepted" && r.conv_id) {
      router.push({ name: "messages", params: { id: String(r.conv_id) } });
    }
  } catch (e) {
    recErr.value = t(bottleErrKey(e));
  } finally { recBusy.value = ""; }
}
</script>

<template>
  <section class="card mail-card">
    <h2>{{ t("bottle.title") }}</h2>
    <p class="sub">{{ t("bottle.sub") }}</p>

    <template v-if="cloudSigned">
      <n-input
        v-model:value="mailDraft"
        type="textarea" :rows="3" :maxlength="BOTTLE_BODY_MAX"
        :placeholder="t('bottle.placeholder')" />
      <div class="mail-send">
        <span class="m-count">{{ mailDraft.length }}/{{ BOTTLE_BODY_MAX }} · {{ t("bottle.leftSend", { n: sendLeft }) }}</span>
        <n-button type="primary" round :disabled="mailBusy || !mailDraft.trim() || sendLeft <= 0" @click="doSend">
          {{ t("bottle.send") }}
        </n-button>
      </div>
      <p v-if="mailHint" class="streak-note hall-warn">{{ mailHint }}</p>

      <div class="bottle-sea">
        <span class="sec-label">{{ t("bottle.seaTitle") }}</span>
        <n-button round :loading="fishing" :disabled="fishLeft <= 0 || !!tray" @click="doFish">
          {{ "\u{1F9CA}" }} {{ t("bottle.fish") }}
        </n-button>
        <span class="m-count">{{ t("bottle.leftFish", { n: fishLeft }) }}</span>
      </div>
      <p class="notice">{{ t("bottle.rules", { w: BOTTLE_SEND_MAX, f: BOTTLE_FISH_MAX }) }}</p>

      <!-- 捞到的信：回信，或放回海里 -->
      <div v-if="tray" class="bottle-tray">
        <div class="m-q">{{ tray.body }}</div>
        <span class="m-who">{{ t("bottle.fromSea") }}</span>
        <n-input
          v-model:value="replyDraft"
          type="textarea" :rows="2" :maxlength="BOTTLE_BODY_MAX"
          :placeholder="t('bottle.replyPlaceholder')" />
        <div class="mail-send">
          <n-button type="primary" size="small" round :disabled="mailBusy || !replyDraft.trim()" @click="doReply">
            {{ t("bottle.reply") }}
          </n-button>
          <n-button quaternary size="small" round :disabled="mailBusy" @click="doRelease">
            {{ t("bottle.release") }}
          </n-button>
        </div>
      </div>

      <!-- #17 记录：我发布的 / 我捞到的，按发布时间新→旧，10 条一页；能聊天的点进去 -->
      <div class="mail-list">
        <div class="bottle-tabs">
          <button class="bottle-tab" :class="{ on: recTab === 'mine' }" @click="switchRecTab('mine')">
            {{ t("bottle.mineTab") }}
          </button>
          <button class="bottle-tab" :class="{ on: recTab === 'held' }" @click="switchRecTab('held')">
            {{ t("bottle.heldTab") }}
          </button>
        </div>
        <p v-if="recLoading" class="sub">{{ t("bottle.recordsLoading") }}</p>
        <p v-else-if="!recRows.length" class="sub">{{ t("bottle.recordsEmpty") }}</p>
        <div
          v-for="l in recRows" :key="l.id"
          class="mail-item" :class="{ clickable: canChat(l) }"
          @click="openRec(l)">
          <div class="m-q">{{ l.body }}</div>
          <div class="m-meta">
            <span class="m-when">{{ whenRec(recTab === "mine" ? l.created_at : (l.held_at || l.created_at)) }}</span>
            <span class="m-state">{{ t(recState(l)) }}</span>
          </div>
          <div v-if="l.reply" class="m-a">
            <span class="m-who">{{ t("bottle.replyFrom") }}</span>
            <span class="m-body">{{ l.reply }}</span>
          </div>
          <!-- 收到回信还没决定：就在这条记录上直接同意 / 拒绝（同意后进聊天） -->
          <div v-if="bottleChatState(l, myId) === 'choose'" class="mail-send" @click.stop>
            <n-button type="primary" size="small" round :disabled="recBusy === l.id" @click="decideRec(l, true)">
              {{ t("bottle.chatAccept") }}
            </n-button>
            <n-button quaternary size="small" round :disabled="recBusy === l.id" @click="decideRec(l, false)">
              {{ t("bottle.chatDecline") }}
            </n-button>
          </div>
          <span v-if="canChat(l)" class="bottle-chat">{{ t("bottle.openChat") }} →</span>
        </div>
        <p v-if="recErr" class="notice">{{ t(recErr) }}</p>
        <div class="bottle-pager">
          <n-button size="tiny" round :disabled="recPage <= 0 || recLoading" @click="recPageGo(-1)">
            ← {{ t("notif.prev") }}
          </n-button>
          <span class="sub">{{ t("bottle.pageInfo", { p: recPage + 1 }) }}</span>
          <n-button size="tiny" round :disabled="recDone || recLoading" @click="recPageGo(1)">
            {{ t("notif.next") }} →
          </n-button>
        </div>
      </div>
    </template>
    <p v-else class="notice">{{ t("bottle.signInHint") }}</p>
  </section>
</template>
