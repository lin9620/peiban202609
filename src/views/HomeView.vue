<script setup>
import { ref, computed, onMounted, watch } from "vue";
import { useRouter } from "vue-router";
import { NButton, NInput, NTag } from "naive-ui";
import { t, i18n } from "../i18n.js";
import { stories } from "../data/stories.js";
import { dayIndex, todayKey } from "../utils/daily.js";
import { getItem, setItem, removeItem } from "../utils/storage.js";
import { checkInMood, moodStreak, activePet, activePetAway } from "../stores/petStore.js";
import {
  BOTTLE_BODY_MAX, BOTTLE_SEND_MAX, BOTTLE_FISH_MAX,
  canBottle, bottleErrKey,
  bottleSend, bottleFish, bottleReply, bottleRelease, bottleHeld,
  bottleRecords, bottleChatState,
} from "../utils/bottle.js";
import { relativeTime } from "../utils/dmRules.js";
import { seasonNow } from "../data/extras.js";
import { cloud } from "../utils/supabase.js";
import { cloudSetStatus, cloudFetchStatusCounts, cloudFetchProfile } from "../utils/wall.js";
import { errorKind } from "../utils/wallRules.js";
import { STATUS_KEYS, statusFresh } from "../utils/statuses.js";
import SeasonFx from "../components/SeasonFx.vue";
import PetMotion from "../components/PetMotion.vue";
import ShareCard from "../components/ShareCard.vue";

/* —— 问候语（跟随本地时间）—— */
const greeting = computed(() => {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return t("home.morning");
  if (h >= 12 && h < 18) return t("home.afternoon");
  if (h >= 22 || h < 5) return t("home.nightOwl");
  return t("home.evening");
});

/* —— 今日内容（按日期轮换）—— */
const todayStory = computed(() => stories[dayIndex(stories.length)]);
const story = computed(() =>
  i18n.locale === "zh" ? todayStory.value.zh : todayStory.value.en
);
const quote = computed(() =>
  i18n.locale === "zh" ? todayStory.value.quote.zh : todayStory.value.quote.en
);

/* —— 陪你大厅（#4 状态上云：本机兜底 + 云端同步/广播）—— */
const myStatus = ref(getItem("wp-status") || "");
const myStatusHint = ref("");   // "" | "sync"（网络/被拒）| "setup"（未跑迁移，功能未开启）
const statusCounts = ref(null);  // 只有 { status, count }，不含昵称或用户 ID
const statusBusy = ref(false);
let statusRevision = 0;
const isMember = computed(() => !!(cloud.user && cloud.user.id));

/* 状态 key → 当前语言文案（云端只存 key；非常规 key 原样显示） */
function statusLabel(k) {
  return STATUS_KEYS.includes(k) ? t("home.companions." + k) : (k || "");
}

async function refreshStatusCounts() {
  statusCounts.value = await cloudFetchStatusCounts();
}

/* 选状态：再点一次清除；登录用户同步上云（RLS self update），游客只留本机 */
async function setStatus(k) {
  if (statusBusy.value) return;
  statusRevision++;
  statusBusy.value = true;
  const next = myStatus.value === k ? "" : k;
  myStatus.value = next;
  myStatusHint.value = "";
  if (next) setItem("wp-status", next);
  else removeItem("wp-status");
  /* 失败原因分类：未跑迁移 → 「功能还没开启」，其余 → 「同步没成功」（状态都先留本机） */
  if (isMember.value && !(await cloudSetStatus(next || null))) {
    myStatusHint.value = errorKind(cloud.error) === "not-migrated" ? "setup" : "sync";
  }
  await refreshStatusCounts();
  statusBusy.value = false;
}

/* 只查询自己的档案恢复选中态；大厅不再下载个人列表。 */
async function refreshMyStatus() {
  const revision = ++statusRevision;
  const uid = cloud.user && cloud.user.id;
  if (!uid || !cloud.ready) return;
  const profile = await cloudFetchProfile(uid);
  if (!profile || revision !== statusRevision || uid !== (cloud.user && cloud.user.id)) return;
  const fresh = statusFresh(profile.status_at) && STATUS_KEYS.includes(profile.status) ? profile.status : "";
  myStatus.value = fresh;
  if (fresh) setItem("wp-status", fresh);
  else removeItem("wp-status");
}
watch(() => [cloud.ready, cloud.user && cloud.user.id], () => {
  refreshMyStatus();
  refreshStatusCounts();
}, { immediate: true });

/* —— 心情打卡 —— */
const checkedToday = ref(getItem("wp-mood-" + todayKey()) !== null);
const justDone = ref(false);
const streak = computed(() => moodStreak());

function moodPick(i) {
  if (checkedToday.value) return;
  if (checkInMood(i)) {
    setItem("wp-mood-" + todayKey(), String(i));
    checkedToday.value = true;
    justDone.value = true;
    setTimeout(() => { justDone.value = false; }, 3000);
  }
}

/* —— 分享卡片 / 宠物 —— */
const showShare = ref(false);
const pet = computed(() => activePet.value);
const isAway = activePetAway;

/* —— 季节彩蛋 —— */
const season = seasonNow();
const seasonName = computed(() => season.name[i18n.locale] || season.name.en);

/* —— 温暖漂流瓶（#6）：写信投进海里，其他用户捞起回信或放回 —— */
const router = useRouter();   /* #17 记录里「去聊天」直接进会话页 */
const cloudSigned = computed(() => !!(cloud.ready && cloud.user));
const mailDraft = ref("");
const replyDraft = ref("");
const mailBusy = ref(false);
const mailHint = ref("");
const fishing = ref(false);
const fished = ref(null);       /* 刚捞起、还没处理的这封 */
const held = ref([]);           /* 我之前捞起、还没回的信（换页/刷新后找回来） */

/* 每日次数用本机日键记账（展示用）；超不超由服务端说了算 */
const QUOTA_KEY = "warm-paws-bottle-quota-v1";
function loadQuota() {
  try {
    const q = JSON.parse(getItem(QUOTA_KEY));
    return q && q.day === todayKey() ? q : { day: todayKey(), sent: 0, fished: 0 };
  } catch (e) { return { day: todayKey(), sent: 0, fished: 0 }; }
}
const quota = ref(loadQuota());
const sendLeft = computed(() => Math.max(0, BOTTLE_SEND_MAX - quota.value.sent));
const fishLeft = computed(() => Math.max(0, BOTTLE_FISH_MAX - quota.value.fished));
function bumpQuota(k) {
  if (quota.value.day !== todayKey()) quota.value = { day: todayKey(), sent: 0, fished: 0 };
  quota.value[k] += 1;
  setItem(QUOTA_KEY, JSON.stringify(quota.value));
}

const tray = computed(() => fished.value || held.value[0] || null);

async function refreshBottle() {
  if (!cloudSigned.value) return;
  /* #17 记录区改走 bottleRecords 分类分页；这里只管「捞起的信」找回（tray） */
  held.value = await bottleHeld() || [];
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
const myId = computed(() => (cloud.user && cloud.user.id) || "");

async function loadRecords(reset = false) {
  if (!cloudSigned.value || recLoading.value) return;
  recLoading.value = true;
  const target = reset ? 0 : recPage.value;
  try {
    const got = await bottleRecords(null, target * REC_PAGE, {
      mine: recTab.value === "mine", limit: REC_PAGE,
    }) || [];
    recRows.value = got;
    recPage.value = target;
    recDone.value = got.length < REC_PAGE;
  } catch (e) {
    recRows.value = [];
    recDone.value = true;
  } finally { recLoading.value = false; }
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
</script>

<template>
  <div>
    <!-- ═══ 主视觉：宠物在你身边 ═══ -->
    <section class="hero">
      <div class="hero-copy">
        <span class="sec-label">{{ greeting }}</span>
        <h1 class="hero-title">{{ t("home.heroTitle") }}</h1>
        <p class="hero-sub">{{ t("home.heroSub", { n: pet ? pet.name : t("pet.title") }) }}</p>
        <div class="hero-season">
          <n-tag round size="small" :bordered="false" class="soft-tag">
            {{ t("season.now", { s: seasonName }) }}
          </n-tag>
        </div>
        <div class="hero-actions">
          <n-button type="primary" size="large" round @click="$router.push('/pet')">
            {{ t("home.goPet") }}
          </n-button>
          <n-button quaternary size="large" round @click="showShare = true">
            🎁 {{ t("home.share") }}
          </n-button>
        </div>
      </div>

      <div class="hero-stage">
        <div class="stage-glow"></div>
        <SeasonFx v-if="!isAway" :count="8" />
        <div class="stage-pet">
          <PetMotion v-if="pet && !isAway" :pet="pet" />
          <div v-else-if="pet" class="hero-away">
            <span>{{ "\u{1F392}" }}</span>
            <span>{{ t("adventure.awayTitle", { n: pet.name }) }}</span>
          </div>
        </div>
        <div class="stage-shadow"></div>
      </div>
    </section>

    <!-- ═══ 陪你大厅 ═══ -->
    <section class="card hall">
      <div class="row-between">
        <span class="sec-label">{{ t("home.companions.title") }}</span>
        <n-tag round size="small" :bordered="false" class="soft-tag">
          {{ t("home.companions.tag") }}
        </n-tag>
      </div>
      <p class="hall-line">{{ t("home.companions.hall") }}</p>
      <div class="chip-row">
        <n-button
          v-for="k in STATUS_KEYS" :key="k"
          round size="small"
          :type="myStatus === k ? 'primary' : 'default'"
          :quaternary="myStatus !== k"
          :disabled="statusBusy"
          @click="setStatus(k)">
          {{ t("home.companions." + k) }}
        </n-button>
      </div>
      <p v-if="myStatus" class="streak-note">
        {{ t("home.companions.youSet", { s: statusLabel(myStatus) }) }}
      </p>
      <p v-if="myStatusHint === 'setup'" class="streak-note hall-warn">
        {{ t("home.companions.syncNeedSetup") }}
      </p>
      <p v-else-if="myStatusHint === 'sync'" class="streak-note hall-warn">
        {{ t("home.companions.syncFail") }}
      </p>
      <p v-else-if="!isMember" class="streak-note">{{ t("home.companions.loginHint") }}</p>

      <!-- 大厅仅展示分类人数，个人状态在用户主页查看。 -->
      <div v-if="statusCounts" class="hall-others">
        <span class="sec-label">{{ t("home.companions.othersTitle") }}</span>
        <div class="hall-pill-row">
          <span v-for="row in statusCounts" :key="row.status" class="hall-pill">
            <span>{{ statusLabel(row.status) }}</span>
            <b>{{ t("home.companions.peopleCount", { n: row.count }) }}</b>
          </span>
        </div>
      </div>
    </section>

    <!-- ═══ 心情打卡（今天过得怎么样：紧跟「不止你一个人」） ═══ -->
    <section class="card">
      <div class="row-between">
        <h2>{{ t("home.mood.title") }}</h2>
        <n-tag v-if="streak > 0" round size="small" :bordered="false" class="soft-tag">
          {{ t("home.mood.streak", { n: streak }) }}
        </n-tag>
      </div>
      <p class="sub">{{ t("home.mood.subtitle") }}</p>
      <div class="chip-row">
        <n-button
          v-for="(m, i) in t('home.mood.options')" :key="i"
          round size="medium" :disabled="checkedToday"
          :quaternary="!checkedToday"
          @click="moodPick(i)">
          {{ m }}
        </n-button>
      </div>
      <p v-if="justDone" class="streak-note" style="color: var(--good); font-weight: 700">
        {{ t("home.mood.done") }}
      </p>
      <p v-else-if="checkedToday" class="streak-note">{{ t("home.mood.again") }}</p>
    </section>

    <!-- ═══ 语录 + 故事 ═══ -->
    <div class="grid-2">
      <section class="card quote-card">
        <span class="sec-label">{{ t("home.quoteLabel") }}</span>
        <p class="quote-hero">
          <span class="quote-mark">“</span>{{ quote }}<span class="quote-mark">”</span>
        </p>
      </section>

      <section class="card story-card">
        <span class="sec-label">{{ t("home.storyLabel") }}</span>
        <h2 class="story-title">{{ story.title }}</h2>
        <p class="story-body">{{ story.body }}</p>
      </section>
    </div>

    <!-- ═══ 温暖漂流瓶（#6） ═══ -->
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
            <span v-if="canChat(l)" class="bottle-chat">{{ t("bottle.openChat") }} →</span>
          </div>
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

    <ShareCard v-if="showShare" :quote="quote" :pet="pet" @close="showShare = false" />
  </div>
</template>
