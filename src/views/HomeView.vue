<script setup>
import { ref, computed, onMounted } from "vue";
import { NButton, NInput, NTag } from "naive-ui";
import { t, i18n } from "../i18n.js";
import { stories, prompts } from "../data/stories.js";
import { dayIndex, todayKey } from "../utils/daily.js";
import { getItem, setItem, removeItem } from "../utils/storage.js";
import { checkInMood, moodStreak, activePet, activePetAway, mailbox, sendLetter } from "../stores/petStore.js";
import { seasonNow } from "../data/extras.js";
import { cloud } from "../utils/supabase.js";
import { cloudSetStatus, cloudFetchStatuses } from "../utils/wall.js";
import { errorKind } from "../utils/wallRules.js";
import { STATUS_KEYS } from "../utils/statuses.js";
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
const others = ref([]);          // 大厅里其他人的近 24h 状态（云端）
const isMember = computed(() => !!(cloud.user && cloud.user.id));

/* 状态 key → 当前语言文案（云端只存 key；非常规 key 原样显示） */
function statusLabel(k) {
  return STATUS_KEYS.includes(k) ? t("home.companions." + k) : (k || "");
}

/* 相对时间：状态都是近 24h 的，分钟/小时两档足够 */
function agoLabel(iso) {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "";
  const m = Math.max(1, Math.round((Date.now() - ts) / 60000));
  return m < 60
    ? t("home.companions.agoMin", { n: m })
    : t("home.companions.agoHour", { n: Math.round(m / 60) });
}

/* 选状态：再点一次清除；登录用户同步上云（RLS self update），游客只留本机 */
async function setStatus(k) {
  const next = myStatus.value === k ? "" : k;
  myStatus.value = next;
  myStatusHint.value = "";
  if (next) setItem("wp-status", next);
  else removeItem("wp-status");
  /* 失败原因分类：未跑迁移 → 「功能还没开启」，其余 → 「同步没成功」（状态都先留本机） */
  if (isMember.value && !(await cloudSetStatus(next || null))) {
    myStatusHint.value = errorKind(cloud.error) === "not-migrated" ? "setup" : "sync";
  }
}

/* 进大厅先对表：云端是登录用户的权威状态（含 24h 过期自动隐去）；同时拉其他人的近况 */
onMounted(async () => {
  const rows = await cloudFetchStatuses(12);
  if (!rows) return; /* 云端不可用 / 未登录游客看不到流 → 保持本机行为 */
  const myId = cloud.user && cloud.user.id;
  if (myId) {
    const mine = rows.find((r) => r.id === myId);
    const fresh = (mine && mine.status) || "";
    myStatus.value = fresh;
    if (fresh) setItem("wp-status", fresh);
    else removeItem("wp-status");
  }
  others.value = rows.filter((r) => !myId || r.id !== myId);
});

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

/* —— 每日一问 —— */
const prompt = computed(() => {
  const p = prompts[dayIndex(prompts.length)];
  return i18n.locale === "zh" ? p.zh : p.en;
});

const ANSWERS_KEY = "warm-paws-answers-v1";
function loadAnswers() {
  try { return JSON.parse(getItem(ANSWERS_KEY)) || {}; }
  catch (e) { return {}; }
}
const answers = ref(loadAnswers());
const myAnswer = computed(() => answers.value[todayKey()] || "");
const draft = ref("");
const answered = ref(false);

function submitAnswer() {
  const text = draft.value.trim();
  if (!text) return;
  answers.value[todayKey()] = text;
  setItem(ANSWERS_KEY, JSON.stringify(answers.value));
  answered.value = true;
  setTimeout(() => { answered.value = false; }, 2500);
}

/* —— 分享卡片 / 宠物 —— */
const showShare = ref(false);
const pet = computed(() => activePet.value);
const isAway = activePetAway;

/* —— 季节彩蛋 —— */
const season = seasonNow();
const seasonName = computed(() => season.name[i18n.locale] || season.name.en);

/* —— 温暖信箱 —— */
const mailDraft = ref("");
const mailSent = ref(false);
function sendLetterNow() {
  if (!sendLetter(mailDraft.value)) return;
  mailDraft.value = "";
  mailSent.value = true;
  setTimeout(() => { mailSent.value = false; }, 4000);
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

      <!-- 其他人的近况：近 24h 内在大厅设过状态的人（云端；过期自动隐去） -->
      <div v-if="others.length" class="hall-others">
        <span class="sec-label">{{ t("home.companions.othersTitle") }}</span>
        <div class="hall-pill-row">
          <span v-for="o in others" :key="o.id" class="hall-pill">
            <b>{{ o.nickname || t("home.companions.anon") }}</b>
            <span>{{ statusLabel(o.status) }}</span>
            <span class="hall-ago">{{ agoLabel(o.status_at) }}</span>
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

    <!-- ═══ 每日一问 ═══ -->
    <section class="card">
      <h2>{{ t("home.dailyQ.title") }}</h2>
      <p class="q-prompt">{{ prompt }}</p>

      <div v-if="!myAnswer" class="q-input">
        <n-input
          v-model:value="draft"
          round size="large"
          :placeholder="t('home.dailyQ.placeholder')"
          @keyup.enter="submitAnswer" />
        <n-button type="primary" round size="large" @click="submitAnswer">
          {{ t("home.dailyQ.submit") }}
        </n-button>
      </div>

      <div v-else class="qa-answer">
        <span class="sec-label">{{ t("home.dailyQ.mine") }}</span>
        {{ myAnswer }}
      </div>

      <p v-if="answered" class="streak-note" style="color: var(--good); font-weight: 700">
        {{ t("home.dailyQ.thanks") }}
      </p>
      <p class="notice">{{ t("home.dailyQ.signInHint") }}</p>
    </section>

    <!-- ═══ 温暖信箱 ═══ -->
    <section class="card mail-card">
      <h2>{{ t("mail.title") }}</h2>
      <p class="sub">{{ t("mail.sub", { n: pet ? pet.name : t("pet.title") }) }}</p>
      <n-input
        v-model:value="mailDraft"
        type="textarea" :rows="3"
        :placeholder="t('mail.placeholder')" />
      <div class="mail-send">
        <n-button type="primary" round @click="sendLetterNow">{{ t("mail.send") }}</n-button>
      </div>
      <p v-if="mailSent" class="streak-note" style="color: var(--good); font-weight: 700">
        {{ t("mail.sent", { n: pet ? pet.name : "" }) }}
      </p>

      <div v-if="mailbox.letters.length" class="mail-list">
        <div v-for="l in mailbox.letters.slice(0, 5)" :key="l.id" class="mail-item">
          <div class="m-q">{{ l.text }}</div>
          <div v-if="l.reply" class="m-a">
            <span class="m-who">{{ t("mail.replyFrom", { n: pet ? pet.name : "" }) }}</span>
            <span class="m-body">{{ l.reply }}</span>
          </div>
          <div v-else class="m-wait">{{ t("mail.pending") }}</div>
        </div>
      </div>
    </section>

    <ShareCard v-if="showShare" :quote="quote" :pet="pet" @close="showShare = false" />
  </div>
</template>
