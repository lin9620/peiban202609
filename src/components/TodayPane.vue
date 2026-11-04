<!-- 首页「今日」联（T6 抽件）：主视觉 + 陪你大厅 + 心情打卡 + 语录/故事 + 分享卡。
     桌面首页与手机三联共用；「去宠物」只发事件，落点（/pet 路由 or 宠物联）由父层定。 -->
<script setup>
import { ref, computed, watch, onMounted, onUnmounted, onActivated } from "vue";
import { NButton, NTag } from "naive-ui";
import MoodFace from "./MoodFace.vue";
import { t, i18n } from "../i18n.js";
import { stories } from "../data/stories.js";
import { dayIndex, todayKey } from "../utils/daily.js";
import { getItem, setItem, removeItem } from "../utils/storage.js";
import { checkInMood, moodLog, moodStreak, activePet, activePetAway } from "../stores/petStore.js";
import { seasonNow } from "../data/extras.js";
import { cloud } from "../utils/supabase.js";
import { cloudSetStatus, cloudFetchStatusCounts, cloudFetchProfile } from "../utils/wall.js";
import { errorKind } from "../utils/wallRules.js";
import {
  STATUS_KEYS, statusFresh, statusCountsCanApply, statusCountsDue,
} from "../utils/statuses.js";
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
/* 轮 209：先渲染上次缓存的计数（本地秒出），网络回来原地更新——
 * 之前每次进入都从 0 等网络（用户实测「慢一拍，影响使用」）。 */
try { statusCounts.value = JSON.parse(getItem("wp-status-counts") || "null"); } catch (e) { /* 忽略 */ }
let statusCountsBusy = false;   /* 轮 238：计数刷新在途标记（并发触发不叠请求） */
let statusRevision = 0;
/* 轮 366：连点时「先落库、再刷新」会按每次点击各刷一趟 —— 第一笔 PATCH 回来时，
 * 服务端还停在第一笔，刷新会把后面几笔的本地预扣打回去（用户实测：选中「随便待着」，
 * 下面却还是上一格的数字，要等最后一笔 PATCH 回来才自己对齐）。
 * 用两个序号把「最后一次点击」和「已落库的最后一次」分开：
 *  - 快照回来若期间又点了，或最后一笔还没落库，直接丢弃；
 *  - 绝不让旧服务端快照覆盖新预扣。
 * 轮 367：用户选「稳定快照」——点状态只本地 ±1，**不在这里拉服务端**；
 * 计数只在进入/回到页面时拉，同一页面 30s 内最多一次（见 statusCountsDue）。 */
let statusWriteSeq = 0;
let statusAppliedSeq = 0;
let statusCountsLastFetchAt = 0;
const isMember = computed(() => !!(cloud.user && cloud.user.id));

/* 状态 key → 当前语言文案（云端只存 key；非常规 key 原样显示） */
function statusLabel(k) {
  return STATUS_KEYS.includes(k) ? t("home.companions." + k) : (k || "");
}

async function refreshStatusCounts() {
  /* 轮 238：在途不叠请求。
   * 轮 366：还有本地点击没落库时先不拉 —— 拉回来的是旧快照，会盖掉新预扣。
   * 轮 367：稳定快照。点状态不走这里；只有进入/回到页面（onActivated /
   * visibilitychange / focus）才拉，且同一页面 30s 内最多一次。
   * 并发触发直接忽略（不排队）：既然只认「稳定快照」，同一时刻只需要一趟。 */
  if (!cloud.ready) return;
  if (statusCountsBusy) return;
  if (statusAppliedSeq !== statusWriteSeq) return;
  if (!statusCountsDue(statusCountsLastFetchAt)) return;
  statusCountsLastFetchAt = Date.now();
  statusCountsBusy = true;
  try {
    const seq = statusWriteSeq;
    const got = await cloudFetchStatusCounts();
    if (got && statusCountsCanApply(seq, statusWriteSeq, statusAppliedSeq)) {
      statusCounts.value = got;
      statusCountsLastFetchAt = Date.now();
      try { setItem("wp-status-counts", JSON.stringify(got)); } catch (e) { /* 忽略 */ }
    } else if (got && seq !== statusWriteSeq) {
      /* 快照发出后又点了：这份是旧快照，丢掉；下次进入/回到页面再对账。 */
      statusCountsLastFetchAt = 0;
    }
  } finally { statusCountsBusy = false; }
}

/* 选状态：再点一次清除；登录用户同步上云（RLS self update），游客只留本机。
 * 轮 238：本地状态**先翻转、界面先动**，云端 PATCH 转后台**串行队列**——
 * 旧版 statusBusy 锁要等串行网络请求才放（生产代理下一次 7s+），
 * 四个按钮点一次就暗住十几秒（用户实测）。PATCH 按点击顺序入队，不会乱序。
 * 轮 291（用户：「这个点击切换，速度非常慢，你测一下」）：数字也不等网络——
 * 我必然站在自己那一格的计数里，离开 -1、进来 +1（下限 0）。
 * 轮 367：用户选「稳定快照」，所以点完**不拉服务端**；本地预扣一直保持到
 * 下次进入/回到页面，再用服务端快照对账。 */
function bumpCounts(prev, next) {
  if (!isMember.value) return;   /* 游客没有 profiles 行，本就不计入大厅统计 */
  const arr = statusCounts.value;
  if (!arr || !arr.length || prev === next) return;
  const delta = Object.create(null);
  if (prev) delta[prev] = (delta[prev] || 0) - 1;
  if (next) delta[next] = (delta[next] || 0) + 1;
  statusCounts.value = arr.map((r) => {
    const d = delta[r.status];
    return d ? { ...r, count: Math.max(0, r.count + d) } : r;
  });
}

let statusSyncChain = Promise.resolve();
function setStatus(k) {
  const prev = myStatus.value;   /* 轮 291：切换前的旧值，给 bumpCounts 记账（离开的那格要 -1） */
  const next = myStatus.value === k ? "" : k;
  const seq = isMember.value ? ++statusWriteSeq : 0;   /* 轮 366：快照对账只认最后一次点击 */
  myStatus.value = next;
  myStatusHint.value = "";
  bumpCounts(prev, next);
  if (next) setItem("wp-status", next);
  else removeItem("wp-status");
  if (!isMember.value) return;   /* 游客只留本机，无云端可同步 */
  statusSyncChain = statusSyncChain
    .then(() => cloudSetStatus(next || null))
    .then((ok) => {
      statusAppliedSeq = seq;
      if (!ok) myStatusHint.value = errorKind(cloud.error) === "not-migrated" ? "setup" : "sync";
      /* 轮 367：稳定快照——点状态只本地 ±1，不在这里拉服务端；
       * 下次进入/回到页面时再对账，避免人数多时一点就跳。 */
    })
    .catch(() => { myStatusHint.value = "sync"; });
}

/* 只查询自己的档案恢复选中态；大厅不再下载个人列表。 */
async function refreshMyStatus() {
  const revision = ++statusRevision;
  const writeSeq = statusWriteSeq;   /* 轮 366：档案回来时若已经点过状态，别把新选择盖回旧值 */
  const uid = cloud.user && cloud.user.id;
  if (!uid || !cloud.ready) return;
  const profile = await cloudFetchProfile(uid);
  if (!profile || revision !== statusRevision || writeSeq !== statusWriteSeq
    || uid !== (cloud.user && cloud.user.id)) return;
  const fresh = statusFresh(profile.status_at) && STATUS_KEYS.includes(profile.status) ? profile.status : "";
  myStatus.value = fresh;
  if (fresh) setItem("wp-status", fresh);
  else removeItem("wp-status");
}
watch(() => [cloud.ready, cloud.user && cloud.user.id], () => {
  refreshMyStatus();
  refreshStatusCounts();
}, { immediate: true });

/* 轮 367：稳定快照的入口。HomeView 在 KeepAlive 里，切回「今天」走 onActivated；
 * 切回浏览器标签/App 走 visibilitychange；桌面切回窗口走 focus。
 * 三处都过 30s 冷却，所以数字不会因为来回切页一直跳。 */
function onPageVisible() {
  if (typeof document !== "undefined" && document.visibilityState === "visible") refreshStatusCounts();
}
onMounted(() => {
  document.addEventListener("visibilitychange", onPageVisible);
  window.addEventListener("focus", onPageVisible);
});
onUnmounted(() => {
  document.removeEventListener("visibilitychange", onPageVisible);
  window.removeEventListener("focus", onPageVisible);
});
onActivated(() => { refreshStatusCounts(); });

/* —— 心情打卡 —— */
const justDone = ref(false);
const streak = computed(() => moodStreak());
/* —— 心情打卡 —— */
/* 轮 150：按钮从 emoji 胶囊换成 MoodFace 手绘线性脸。显示顺序 = i18n home.mood.faceOrder，
 * 每项带 legacyIndex —— 打卡写入的仍是**旧序号**（0~4），历史记录不会因为调顺序而错位。
 * 轮387：今日是否已打卡改看 moodLog（按账号分域、可跨设备拉回），
 * 不再依赖设备级 wp-mood-日期 键——换账号/换设备后那个键会误判「今天已打卡」。 */
const moodFaces = computed(() => t("home.mood.faceOrder"));
const moodPicked = computed(() => moodLog[todayKey()]);
const checkedToday = computed(() => moodPicked.value !== undefined);

function moodPick(i) {
  if (checkedToday.value) return;
  if (checkInMood(i)) {
    justDone.value = true;
    /* 轮 51 的「打卡完跳去宠物」已被轮 53 撤销——用户真正要的跳转方向相反：
     * 是从宠物页的任务行跳来这里打卡（见 PetView 任务块轮 53 注释），不是打完卡跳走。 */
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

    <!-- ═══ 顶部问候 ═══
         轮 150（用户手机端截图定稿）：只留「问候 + 一行微文案 + 右上心形钮」。
         原先的长句散文与金币/等级 chip 撤掉 —— 用户原话「不要太多文字了」。
         心形钮 = 分享今日卡片（原来藏在 chip 堆里的入口提到右上角）。 -->
    <header class="card today-hi">
      <div class="today-hi-row">
        <div class="today-hi-txt">
          <h1 class="today-hi-title">{{ greeting }}</h1>
          <p class="today-hi-sub">{{ t("home.hiThere") }}</p>
        </div>
        <button type="button" class="today-hi-heart" :title="t('home.share')" @click="showShare = true">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M12 20.3s-7.4-4.6-7.4-9.5A4.2 4.2 0 0 1 12 7.9a4.2 4.2 0 0 1 7.4 2.9c0 4.9-7.4 9.5-7.4 9.5z" />
          </svg>
        </button>
      </div>
    </header>

    <!-- ═══ 此刻状态 ═══
         轮 150（截图定稿）：四个状态从「一排小胶囊」改成 2×2 大卡（圆形图标 + 名称 + 一行短说明），
         选中态整卡染色 + 暖橘描边。短说明补上了原先缺的「我这会儿在干什么」。 -->
    <section class="card hall">
      <div class="row-between">
        <h2 class="hall-title">{{ t("home.companions.title") }}</h2>
        <span class="sec-label">{{ t("home.companions.pickHint") }}</span>
      </div>
      <div class="status-grid">
        <button
          v-for="k in STATUS_KEYS" :key="k"
          type="button" class="status-card"
          :class="{ 'is-on': myStatus === k }"
          @click="setStatus(k)">
          <span class="status-ico">{{ t("home.companions.ico." + k) }}</span>
          <span class="status-name">{{ t("home.companions.name." + k) }}</span>
          <span class="status-sub">{{ t("home.companions.sub." + k) }}</span>
        </button>
      </div>
      <p v-if="myStatusHint === 'setup'" class="streak-note hall-warn">
        {{ t("home.companions.syncNeedSetup") }}
      </p>
      <p v-else-if="myStatusHint === 'sync'" class="streak-note hall-warn">
        {{ t("home.companions.syncFail") }}
      </p>
      <p v-else-if="!isMember" class="streak-note">{{ t("home.companions.loginHint") }}</p>

      <!-- 大厅此刻 = 纯统计（各状态当前人数），不可点；我选中的状态在这排联动点亮。 -->
      <div v-if="statusCounts && statusCounts.length" class="hall-now">
        <div class="row-between">
          <span class="sec-label">{{ t("home.companions.nowTitle") }}</span>
          <span class="sec-label">{{ t("home.companions.nowSub") }}</span>
        </div>
        <div class="hall-now-row">
          <div
            v-for="row in statusCounts" :key="row.status"
            class="hall-now-cell" :class="{ on: myStatus === row.status }">
            <b>{{ row.count }}</b>
            <span>{{ statusLabel(row.status) }}</span>
          </div>
        </div>
      </div>
    </section>

    <!-- ═══ 心情打卡 ═══
         轮 150（用户截图）：标题右侧只留一个极短说明（记录此刻的你），
         五个按钮从「emoji + 文案」胶囊改成「手绘线性脸 + 下方小字」的圆形格，
         emoji 全部退场（emoji 在不同系统差别太大，也谈不上设计感）。 -->
    <section class="card mood-card">
      <div class="row-between">
        <h2>{{ t("home.mood.title") }}</h2>
        <n-tag v-if="streak > 0" round size="small" :bordered="false" class="soft-tag">
          {{ t("home.mood.streak", { n: streak }) }}
        </n-tag>
        <span v-else class="sec-label">{{ t("home.mood.hintShort") }}</span>
      </div>
      <div class="mood-row">
        <button
          v-for="f in moodFaces" :key="f.kind"
          type="button" class="mood-face"
          :class="{ 'is-on': String(moodPicked) === String(f.legacyIndex) }"
          :disabled="checkedToday"
          :title="t('home.mood.faces.' + f.kind)"
          @click="moodPick(f.legacyIndex)">
          <MoodFace :kind="f.kind" />
          <span class="mood-face-txt">{{ t("home.mood.faces." + f.kind) }}</span>
        </button>
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

    <!-- 轮 175：Teleport to body——ShareCard 遮罩是 position:fixed，而今日联在带 transform 的
         .home-track 里（首页横滑），fixed 会以轨道为定位基准：遮罩罩满整条轨道=今日/宠物两联
         一起变黑，卡片本体飞出屏外（与轮 151/152 领养弹窗同陷阱）。Teleport 出去即正常居中。 -->
    <teleport to="body">
      <ShareCard v-if="showShare" :quote="quote" :pet="pet" @close="showShare = false" />
    </teleport>

  </div>
</template>
