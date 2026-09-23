<!-- 温暖漂流瓶（T6 抽件）：写信投海 / 捞信回信放回 / 记录两栏分页。
     轮 37 起**全线上**：次数、托盘、记录一律现拉服务器（本机不再留次数账本、不再用
     SWR 快照顶显示），页面里没有一份「本地缓存」决定行为。
     桌面首页收尾与手机「漂流瓶」联（默认联）共用同一组件。 -->
<script setup>
import { ref, computed, watch, onMounted } from "vue";
import { useRouter } from "vue-router";
import { NButton, NInput, NModal } from "naive-ui";
import { t } from "../i18n.js";
import {
  BOTTLE_BODY_MAX, BOTTLE_SEND_MAX, BOTTLE_FISH_MAX,
  bottleErrKey,
  bottleSend, bottleFish, bottleReply, bottleRelease, bottleHeld, bottleQuota,
  bottleRecords, bottleChatState, bottleChatDecide, purgeLegacyBottleLocals,
} from "../utils/bottle.js";
import { relativeTime } from "../utils/dmRules.js";
import { cloud } from "../utils/supabase.js";

const router = useRouter();   /* #17 记录里「去聊天」直接进会话页 */
const cloudSigned = computed(() => !!(cloud.ready && cloud.user));
const mailDraft = ref("");
const replyDraft = ref("");
const mailBusy = ref(false);
const mailHint = ref("");
const fishing = ref(false);
const fished = ref(null);       /* 刚捞起、还没处理的这封 */
const held = ref([]);           /* 我之前捞起、还没回的信（换页/刷新后找回来） */
const trayErr = ref("");        /* 托盘读取失败提示（轮 37：直连服务器，失败如实说，不用旧快照顶） */

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

/* ════════ 每日次数：唯一真相是服务端 bottle_quota()（轮 37）════════
 * 用户点名「什么每天捞 7 瓶、写 3 瓶，老老实实改成线上」。此前本机留着一本乐观
 * 账（`warm-paws-bottle-quota-v1:<uid>`）：服务端值还没回来（或拉不到）时它顶上去
 * 显示满额 3 封 / 7 瓶 —— 于是「明明用完了还显示还能捞 7 次」；账本本身也跨不了端
 * （网页与 App 各记各的）。现在本机不再存任何次数：
 *   · 显示只认服务端值：没拉到 = null = 界面写「次数同步中…」，绝不编数字；
 *   · 发信/捞信/回信成功后一律重新拉服务端值，客户端不做 +1、不留账本；
 *   · 拉不到（网络/未跑迁移）也不拦操作，如实提示「次数以服务器为准」，
 *     真限额由 SQL RPC 的 bottle-limit-* 兜底 —— 前端永远不替服务端做减法。 */
const myId = computed(() => (cloud.user && cloud.user.id) || "");
const quota = ref(null);        /* { sent, fished } —— 只可能是服务端返回的值 */
const quotaErr = ref("");       /* 拉不到时的 i18n key（提示用，不拦操作） */
async function syncQuota() {
  if (!cloudSigned.value) { quota.value = null; quotaErr.value = ""; return; }
  try {
    const q = await bottleQuota();
    if (!q || typeof q.sent !== "number" || typeof q.fished !== "number") {
      quota.value = null;
      quotaErr.value = "bottle.quotaUnavailable";
      return;
    }
    quota.value = { sent: q.sent, fished: q.fished };
    quotaErr.value = "";
  } catch (e) {
    quota.value = null;
    quotaErr.value = "bottle.quotaUnavailable";
  }
}
const sendLeft = computed(() => (quota.value ? Math.max(0, BOTTLE_SEND_MAX - quota.value.sent) : null));
const fishLeft = computed(() => (quota.value ? Math.max(0, BOTTLE_FISH_MAX - quota.value.fished) : null));
/* 次数文案：拿到服务端值才显示数字；没拿到就说「同步中」（不编满额数字骗用户） */
const sendText = (v) => (v === null ? t("bottle.quotaSyncing") : t("bottle.leftSend", { n: v }));
const fishText = (v) => (v === null ? t("bottle.quotaSyncing") : t("bottle.leftFish", { n: v }));
/* 登录就绪/换号 → 次数与托盘一律重读（修「首次进主页漂流瓶记录空白，必须手动点刷新」：
 * 旧版只在 onMounted 拉一次，那时会话往往还没就绪，拉了个空就再也不拉了）。
 * 轮 41（真根因）：这个 watch 原来**没开 immediate** —— App 启动路径是
 * 「splash 等 initCloud 就绪 → 再挂 HomeView/BottleView」，会话先于组件就绪，
 * watch 永不触发 → 次数/托盘/记录一次都不查，直到点「捞一瓶」才第一次发请求
 * （用户报「进首页不提前查、点漂流瓶一直出不来」）。immediate: true = 组件一挂载
 * 就按当前会话状态查一遍；BottleView 随首页常挂载，所以效果就是「进首页就查好」。 */
watch([cloudSigned, myId], () => {
  quota.value = null;      /* 换人就先清空：绝不拿上一个人的次数顶着显示 */
  quotaErr.value = "";
  fished.value = null;
  recPage.value = 0;
  if (cloudSigned.value) {
    refreshBottle();
    loadRecords(true);
    syncQuota();
  }
}, { immediate: true });

async function refreshBottle() {
  if (!cloudSigned.value) return;
  /* #17 记录区改走 bottleRecords 分类分页；这里只管「捞起未回的信」找回（待处理信箱）。
   * 轮 37：不再先渲染本机快照（原来 swr 会先闪一份旧托盘）——手里的信必须是服务器
   * 此刻的真实持有，否则换号/换端会看到不属于自己的待回信。 */
  try {
    const rows = await bottleHeld();
    held.value = Array.isArray(rows) ? rows : [];
    trayErr.value = "";
  } catch (e) {
    held.value = [];
    trayErr.value = bottleErrKey(e);
  }
  fished.value = null;
  mergePending();
}

async function doSend() {
  const body = mailDraft.value.trim();
  /* sendLeft === null（次数还没同步回来）不拦：交给服务端裁定，限额由 RPC 兜底 */
  if (!body || sendLeft.value === 0) return;
  mailBusy.value = true;
  mailHint.value = "";
  try {
    await bottleSend(body);
    mailDraft.value = "";
    await syncQuota();          /* 轮 37：次数只回读服务端值，本机不做 +1、不留账本 */
    await refreshBottle();
  } catch (e) {
    const k = bottleErrKey(e);
    mailHint.value = t(k);
    /* 轮 20：限额报错 = 服务端账本与显示错位的信号 → 立刻拉服务端次数对齐显示 */
    if (k === "bottle.errSendLimit") syncQuota();
  } finally { mailBusy.value = false; }
}

async function doFish() {
  if (fishLeft.value === 0) return;   /* 未知（null）不拦：真限额由服务端 bottle-limit-fish 兜底 */
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
    /* 轮 21 口径：捞到**不扣**次数——「捞到且回信」才扣 1 次；轮 37 起客户端完全不记账
     * （本机账本已删），这里只回读一次服务端权威值（服务端记账在 bottle_reply()）。 */
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
    /* 轮 21：回信成功才计 1 次（服务端 bottle_reply 盖章）；轮 37 本机不再记账，只回读服务端值 */
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

/* 轮 37：进页面先清掉老版本留在家里的本地漂流瓶数据（次数账本 + SWR 快照），
 * 再全部现拉服务器 —— 页面里不再有任何本地缓存参与显示。 */
onMounted(() => { purgeLegacyBottleLocals(); refreshBottle(); loadRecords(true); });

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
  recErr.value = "";
  const target = reset ? 0 : recPage.value;
  /* 轮 37：记录列表也不再走本机快照（原来每栏第 0 页存一份 SWR 缓存，换号/换端会先闪
   * 别人的或过期的记录）——拉到的就是服务器此刻的记录，失败如实报错，不用旧快照假装成功。 */
  try {
    const got = await bottleRecords(null, target * REC_PAGE, {
      mine: recTab.value === "mine", limit: REC_PAGE,
    });
    const rows = Array.isArray(got) ? got : [];
    recRows.value = rows;
    recPage.value = target;
    recDone.value = rows.length < REC_PAGE;
  } catch (e) {
    recRows.value = [];
    recDone.value = true;
    recErr.value = bottleErrKey(e);
  } finally {
    recLoading.value = false;
  }
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
        <span class="m-count">{{ mailDraft.length }}/{{ BOTTLE_BODY_MAX }} · {{ sendText(sendLeft) }}</span>
        <n-button type="primary" round :disabled="mailBusy || !mailDraft.trim() || sendLeft === 0" @click="doSend">
          {{ t("bottle.send") }}
        </n-button>
      </div>
      <p v-if="quotaErr" class="streak-note hall-warn">{{ t(quotaErr) }}</p>
      <p v-if="mailHint" class="streak-note hall-warn">{{ mailHint }}</p>

      <div class="bottle-sea">
        <span class="sec-label">{{ t("bottle.seaTitle") }}</span>
        <n-button round :loading="fishing" :disabled="fishLeft === 0" @click="doFish">
          {{ "\u{1F9CA}" }} {{ t("bottle.fish") }}
        </n-button>
        <span class="m-count">{{ fishText(fishLeft) }}</span>
      </div>
      <p class="notice">{{ t("bottle.rules", { w: BOTTLE_SEND_MAX, f: BOTTLE_FISH_MAX }) }}</p>

      <!-- 捞到的信（可同时持有几封，逐封回信或放回；捞新信不需要先处理手里的） -->
      <p v-if="trayErr" class="notice">{{ t(trayErr) }}</p>
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

    <!-- 轮 22：捞信结果居中弹窗（手机端核心反馈）——捞到可就地回信 / 放回海里（「先收着」已按用户要求移除）。
         轮 40：宽度必须显式给——n-modal 不给 width 会被容器撑满，原来的 max-width: 88vw
         在手机上≈343px 没事，桌面网页上就是 88vw≈1670px 的巨幕（用户报「弹窗也太大了吧」）。
         min(560px, 100vw-32px)：桌面 560px 居中，手机仍是留 16px 边距的近全宽。 -->
    <n-modal v-model:show="fishPop.show" preset="card" style="width: min(560px, calc(100vw - 32px))"
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
