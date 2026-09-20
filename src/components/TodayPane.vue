<!-- 首页「今日」联（T6 抽件）：主视觉 + 陪你大厅 + 心情打卡 + 语录/故事 + 分享卡。
     桌面首页与手机三联共用；「去宠物」只发事件，落点（/pet 路由 or 宠物联）由父层定。 -->
<script setup>
import { ref, computed, watch } from "vue";
import { NButton, NTag } from "naive-ui";
import { t, i18n } from "../i18n.js";
import { stories } from "../data/stories.js";
import { dayIndex, todayKey } from "../utils/daily.js";
import { getItem, setItem, removeItem } from "../utils/storage.js";
import { checkInMood, moodStreak, activePet, activePetAway } from "../stores/petStore.js";
import { seasonNow } from "../data/extras.js";
import { cloud } from "../utils/supabase.js";
import { cloudSetStatus, cloudFetchStatusCounts, cloudFetchProfile } from "../utils/wall.js";
import { errorKind } from "../utils/wallRules.js";
import { STATUS_KEYS, statusFresh } from "../utils/statuses.js";
import { isMobileNav } from "../stores/uiStore.js";
import SeasonFx from "./SeasonFx.vue";
import PetMotion from "./PetMotion.vue";
import ShareCard from "./ShareCard.vue";

const emit = defineEmits(["go-pet"]);

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
</script>

<template>
  <div>
    <!-- ═══ 主视觉：宠物在你身边（手机端 5：今日联不再放宠物卡 —— 宠物有自己的联，去掉这屏的空白与毛玻璃） ═══ -->
    <section v-if="!isMobileNav" class="hero">
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
          <n-button type="primary" size="large" round @click="$emit('go-pet')">
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

      <!-- 大厅仅展示分类人数；手机端 8：人数胶囊可点 —— 点了就把自己也设成同款状态（跟手反馈） -->
      <div v-if="statusCounts" class="hall-others">
        <span class="sec-label">{{ t("home.companions.othersTitle") }}</span>
        <div class="hall-pill-row">
          <button
            v-for="row in statusCounts" :key="row.status" type="button"
            class="hall-pill hall-pill--tap" :class="{ on: myStatus === row.status }"
            :disabled="statusBusy"
            @click="setStatus(row.status)">
            <span>{{ statusLabel(row.status) }}</span>
            <b>{{ t("home.companions.peopleCount", { n: row.count }) }}</b>
          </button>
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

    <ShareCard v-if="showShare" :quote="quote" :pet="pet" @close="showShare = false" />

  </div>
</template>
