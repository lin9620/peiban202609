<!-- 温暖漂流瓶（T6 抽件）：写信投海 / 捞信回信放回 / 记录两栏分页（本地优先缓存）。
     桌面首页收尾与手机「漂流瓶」联（默认联）共用同一组件。 -->
<script setup>
import { ref, computed, watch, onMounted } from "vue";
import { useRouter } from "vue-router";
import { NButton, NInput, NModal } from "naive-ui";
import { t } from "../i18n.js";
import { todayKey } from "../utils/daily.js";
import { getItem, setItem } from "../utils/storage.js";
import {
  BOTTLE_BODY_MAX, BOTTLE_SEND_MAX, BOTTLE_FISH_MAX,
  canBottle, bottleErrKey,
  bottleSend, bottleFish, bottleReply, bottleRelease, bottleHeld, bottleQuota,
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

/* 待处理信箱（轮 18）：新捞的 + 之前捞起没回的，合并去重逐封处理。
 * 旧版只显示一封、且手里压着一封就禁捞新信——「每天能捞 7 次」被做成了
 * 「捞 1 次就被锁」。现在多封并存互不阻塞，捞瓶按钮只看剩余次数。 */
const pending = ref([]);
function mergePending() {
  const map = new Map();
  for (const l of held.value) map.set(l.id, l);
  if (fished.value && fished.value.id) map.set(fished.value.id, fished.value);
  pending.value = [...map.values()];
}

/* 轮 22/25：捞信结果一律居中弹窗——捞到（就地回信/放回）、没捞到、限额，全部有明确反馈；
 * 「先收着，稍后回」按用户要求移除（捞到就当场回信或放回，不许囤） */
const fishPop = ref({ show: false, mode: "msg", letter: null, msg: "" });
/* 轮 26：捞信悬死兜底（毫秒）——正常一网 1-3s；超时只是给出口，不给「永远转圈」死局 */
const FISH_TIMEOUT = 8000;

/* 每日次数：本地账本只做乐观显示，服务端 bottle_quota() 才是权威（轮 18 修
 * 「下面显示还能捞 2 瓶、上面却说次数用完」——次数原来记在本机 localStorage，
 * 网页和 App 各记各的账，跨端必然打架；现在以 RPC 为准，未跑新迁移时退回本地账） */
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
const quotaRemote = ref(null);
async function syncQuota() {
  try {
    const q = await bottleQuota();
    if (q && typeof q.fished === "number" && typeof q.sent === "number") quotaRemote.value = q;
  } catch (e) { /* 未跑 MIGRATION_bottle_quota_fishfix.sql → 静默退回本地账本 */ }
}
const sendLeft = computed(() => {
  const q = quotaRemote.value;
  return Math.max(0, BOTTLE_SEND_MAX - (q ? q.sent : quota.value.sent));
});
const fishLeft = computed(() => {
  const q = quotaRemote.value;
  return Math.max(0, BOTTLE_FISH_MAX - (q ? q.fished : quota.value.fished));
});
function bumpQuota(k) {
  if (quota.value.day !== todayKey()) quota.value = freshQuota();
  quota.value[k] += 1;
  setItem(quotaKey.value, JSON.stringify(quota.value));
  /* 远端账本乐观 +1，随后 syncQuota 用服务端值校正 */
  if (quotaRemote.value && typeof quotaRemote.value[k] === "number") {
    quotaRemote.value = { ...quotaRemote.value, [k]: quotaRemote.value[k] + 1 };
  }
}
/* 登录就绪/换号 → 账本重置 + 自动加载（修「首次进主页漂流瓶记录空白，必须手动点刷新」：
 * 旧版只在 onMounted 拉一次，那时会话往往还没就绪，拉了个空就再也不拉了） */
watch([cloudSigned, myId], () => {
  quota.value = loadQuota();
  quotaRemote.value = null;
  fished.value = null;
  recPage.value = 0;
  if (cloudSigned.value) {
    refreshBottle();
    loadRecords(true);
    syncQuota();
  }
});

async function refreshBottle() {
  if (!cloudSigned.value) return;
  /* #17 记录区改走 bottleRecords 分类分页；这里只管「捞起未回的信」找回（待处理信箱） */
  await swr(
    cacheKey("bottle:held", myId.value),
    {
      cached: (rows) => { held.value = rows || []; },
      fresh: (rows) => { held.value = rows || []; },
    },
    () => bottleHeld(),
  );
  fished.value = null;
  mergePending();
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
    syncQuota();
    await refreshBottle();
  } catch (e) {
    const k = bottleErrKey(e);
    mailHint.value = t(k);
    /* 轮 20：限额报错 = 服务端账本与显示错位的信号 → 立刻拉服务端次数对齐显示 */
    if (k === "bottle.errSendLimit") syncQuota();
  } finally { mailBusy.value = false; }
}

async function doFish() {
  if (fishLeft.value <= 0) return;
  fishing.value = true;
  mailHint.value = "";
  /* 轮 26：按下**瞬间**就弹「撒网中」——不再等网络回来才有反应（反馈 <100ms，
   * 出信快慢交给网络，正常一网 1-3s，用户要求 3s 内有结果）。 */
  fishPop.value = { show: true, mode: "fishing", letter: null, msg: "" };
  try {
    const l = await Promise.race([
      bottleFish(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("bottle-slow")), FISH_TIMEOUT)),
    ]);
    if (!l || !l.id) {
      /* 竞态兜底（轮 18）：服务端抢占落空返回空 → 明示「海里暂时没信」，绝不扣次数 */
      mailHint.value = t("bottle.errEmpty");
      fishPop.value = { show: true, mode: "msg", letter: null, msg: t("bottle.errEmpty") };
      return;
    }
    fished.value = l;
    /* 轮 21 口径修正：捞到**不扣**次数——「捞到且回信」才扣 1 次。
     * 客户端记账搬到 doReply，服务端记账搬到 bottle_reply()（见
     * MIGRATION_bottle_reply_quota.sql）；这里只同步一次服务端权威值。 */
    mergePending();
    syncQuota();
    /* 轮 22：捞到了 → 居中弹窗直接展示这封信（可就地回信/放回，不再让人猜捞没捞到） */
    fishPop.value = { show: true, mode: "got", letter: l, msg: "" };
  } catch (e) {
    const k = String(e && e.message) === "bottle-slow" ? "bottle.errSlow" : bottleErrKey(e);
    mailHint.value = t(k);
    /* 轮 22：点了捞却没动静的几类原因（海里空/今天用完/囤太多）也弹窗说清 */
    fishPop.value = { show: true, mode: "msg", letter: null, msg: t(k) };
    /* 轮 20：限额报错 → 立即同步服务端次数（一次点击内对齐，不再「显示还能捞但说用完」） */
    if (k === "bottle.errFishLimit") syncQuota();
  } finally { fishing.value = false; }
}

/* 回信/放回按信独立操作：待处理信箱可同时有多封，互不阻塞 */
const replyDrafts = ref({});
const busyId = ref("");
/* 轮 24c：记录卡上「回信」→ 卡内展开输入框（replyOpen = 该信 id） */
const replyOpen = ref("");
function openReply(l) {
  if (!l) return;
  fishPop.value.show = false;
  replyOpen.value = replyOpen.value === l.id ? "" : l.id;
}
async function doReply(l) {
  const body = String(replyDrafts.value[l.id] || "").trim();
  if (!l || !body || busyId.value) return;
  busyId.value = l.id;
  mailHint.value = "";
  try {
    await bottleReply(l.id, body);
    replyDrafts.value = { ...replyDrafts.value, [l.id]: "" };
    fished.value = null;
    replyOpen.value = "";
    held.value = held.value.filter((x) => x.id !== l.id);
    bumpQuota("fished");        /* 轮 21：回信成功才记一次（服务端 bottle_reply 同口径） */
    mergePending();
    syncQuota();
    fishPop.value.show = false;   /* 轮 22：在弹窗里回的信 → 弹窗关闭 */
    await refreshBottle();
  } catch (e) {
    mailHint.value = t(bottleErrKey(e));
  } finally { busyId.value = ""; }
}

async function doRelease(l) {
  if (!l || busyId.value) return;
  busyId.value = l.id;
  try {
    await bottleRelease(l.id);
    fished.value = null;
    held.value = held.value.filter((x) => x.id !== l.id);
    mergePending();
    fishPop.value.show = false;   /* 轮 22：在弹窗里放回的信 → 弹窗关闭 */
    await refreshBottle();
  } catch (e) {
    mailHint.value = t(bottleErrKey(e));
  } finally { busyId.value = ""; }
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
        <n-button round :loading="fishing" :disabled="fishLeft <= 0" @click="doFish">
          {{ "\u{1F9CA}" }} {{ t("bottle.fish") }}
        </n-button>
        <span class="m-count">{{ t("bottle.leftFish", { n: fishLeft }) }}</span>
      </div>
      <p class="notice">{{ t("bottle.rules", { w: BOTTLE_SEND_MAX, f: BOTTLE_FISH_MAX }) }}</p>

      <!-- 捞到的信（可同时持有几封，逐封回信或放回；捞新信不需要先处理手里的） -->
      <div v-for="l in pending" :key="l.id" class="bottle-tray">
        <div class="m-q">{{ l.body }}</div>
        <span class="m-who">{{ t("bottle.fromSea") }}</span>
        <n-input
          v-model:value="replyDrafts[l.id]"
          type="textarea" :rows="2" :maxlength="BOTTLE_BODY_MAX"
          :placeholder="t('bottle.replyPlaceholder')" />
        <div class="mail-send">
          <n-button type="primary" size="small" round
            :disabled="busyId === l.id || !String(replyDrafts[l.id] || '').trim()"
            @click="doReply(l)">
            {{ t("bottle.reply") }}
          </n-button>
          <n-button quaternary size="small" round :disabled="busyId === l.id" @click="doRelease(l)">
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
          <!-- 轮 24c：押在手里的信，操作按钮直接放在记录卡上（此前只在顶部托盘/弹窗里，用户找不到） -->
          <div v-if="recTab === 'held' && l.status === 'held'" class="mail-send" @click.stop>
            <n-button type="primary" size="small" round
              :disabled="busyId === l.id"
              @click="openReply(l)">
              {{ t("bottle.reply") }}
            </n-button>
            <n-button quaternary size="small" round
              :disabled="busyId === l.id"
              @click="doRelease(l)">
              {{ t("bottle.release") }}
            </n-button>
          </div>
          <div v-if="replyOpen === l.id && recTab === 'held' && l.status === 'held'" class="mail-send" style="flex-direction: column; align-items: stretch; gap: 6px" @click.stop>
            <n-input
              v-model:value="replyDrafts[l.id]"
              type="textarea" :rows="3" :maxlength="BOTTLE_BODY_MAX"
              :placeholder="t('bottle.replyPlaceholder')" />
            <n-button type="primary" size="small" round
              :disabled="busyId === l.id || !String(replyDrafts[l.id] || '').trim()"
              @click="doReply(l)">
              {{ t("bottle.replySend") }}
            </n-button>
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

    <!-- 轮 22：捞信结果居中弹窗（手机端核心反馈）——捞到可就地回信 / 放回海里（「先收着」已按用户要求移除） -->
    <n-modal v-model:show="fishPop.show" preset="card" style="max-width: 88vw"
      :closable="false" :mask-closable="false" :close-on-esc="false"
      :title="fishPop.mode === 'got' ? t('bottle.gotTitle') : (fishPop.mode === 'fishing' ? t('bottle.fishing') : t('bottle.popNotice'))">
      <template v-if="fishPop.mode === 'fishing'">
        <div class="fish-wait">
          <span class="fw-rod">🎣</span>
          <p class="fw-sub">{{ t("bottle.fishingSub") }}</p>
        </div>
      </template>
      <template v-else-if="fishPop.mode === 'got' && fishPop.letter">
        <div class="m-q" style="font-size: 16px; line-height: 1.6">{{ fishPop.letter.body }}</div>
        <span class="m-who">{{ t("bottle.fromSea") }}</span>
        <n-input
          v-model:value="replyDrafts[fishPop.letter.id]"
          type="textarea" :rows="3" :maxlength="BOTTLE_BODY_MAX"
          :placeholder="t('bottle.replyPlaceholder')" style="margin-top: 10px" />
        <div class="mail-send" style="margin-top: 8px">
          <n-button type="primary" round
            :disabled="busyId === fishPop.letter.id || !String(replyDrafts[fishPop.letter.id] || '').trim()"
            @click="doReply(fishPop.letter)">
            {{ t("bottle.reply") }}
          </n-button>
          <n-button quaternary round :disabled="busyId === fishPop.letter.id" @click="doRelease(fishPop.letter)">
            {{ t("bottle.release") }}
          </n-button>
        </div>
      </template>
      <template v-else>
        <p style="margin: 2px 0 14px; white-space: pre-wrap">{{ fishPop.msg }}</p>
        <n-button type="primary" round @click="fishPop.show = false">{{ t("common.gotIt") }}</n-button>
      </template>
    </n-modal>
  </section>
</template>
