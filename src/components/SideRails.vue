<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { t, i18n } from "../i18n.js";
import { SPECIES } from "../data/pets.js";
import { todayKey } from "../utils/daily.js";
import { getItem, setItem } from "../utils/storage.js";
import {
  activePet, petUi, say, doPetting, feedDish, cookbook,
  adventure, harvestClover, feedVisitor, checkInMood,
  dailyTasks, claimTasks, claimableCoins, TASK_LIST,
} from "../stores/petStore.js";
import { visitorByKey } from "../data/adventure.js";
import { GENTLE_SLIPS } from "../data/gentleSlips.js";
import { slipFor, bumpSlipStreak, splitHm, bottleLeft } from "../utils/railRules.js";
import { BOTTLE_SEND_MAX, BOTTLE_FISH_MAX, bottleQuota, bottleHeld } from "../utils/bottle.js";
import { copyText } from "../utils/clipboard.js";
import { cloud } from "../utils/supabase.js";

/* —— 左栏：伙伴角 —— */
const emoji = computed(() => {
  const s = SPECIES.find((x) => x.key === (activePet.value && activePet.value.species));
  return s ? s.emoji : "\u{1F431}";
});
const away = computed(
  () => adventure.status === "away" && activePet.value && adventure.petId === activePet.value.id
);
const nowTick = ref(Date.now());
let timer = setInterval(() => { nowTick.value = Date.now(); }, 1000);
onUnmounted(() => clearInterval(timer));

const remainText = computed(() => {
  const s = Math.max(0, Math.ceil((adventure.returnsAt - nowTick.value) / 1000));
  return s >= 60 ? t("adventure.timeM", { m: Math.ceil(s / 60) }) : t("adventure.timeS", { s });
});
const visitor = computed(() => visitorByKey(adventure.visitor || ""));
const bars = computed(() => {
  const p = activePet.value;
  if (!p) return [];
  return [
    { ico: "\u{1F35A}", val: Math.round(p.hunger) },
    { ico: "\u{1F497}", val: Math.round(p.mood) },
    { ico: "\u{1F4A7}", val: Math.round(p.clean) },
    { ico: "\u26A1", val: Math.round(p.energy) },
  ];
});
function quickPet() {
  const p = activePet.value;
  if (p && !p.sleeping && !away.value) doPetting();
}
function quickFeed() {
  const p = activePet.value;
  if (!p || p.sleeping || away.value) return;
  if (!cookbook.length) { say(t("rail.noDish"), 3000); return; }
  feedDish(cookbook[0]);
}
function quickHarvest() { harvestClover(); }

/* —— 右栏：呼吸放松 —— */
const PH = [
  { sec: 4, k: "grow", label: () => t("rail.bIn") },
  { sec: 4, k: "hold", label: () => t("rail.bHold") },
  { sec: 4, k: "shrink", label: () => t("rail.bOut") },
];
const breathing = ref(false);
const phaseIdx = ref(0);
const phaseLeft = ref(4);
const breaths = ref(0);
let bTimer = null;
function startBreathe() {
  breathing.value = true;
  phaseIdx.value = 0; phaseLeft.value = PH[0].sec; breaths.value = 0;
  bTimer = setInterval(() => {
    phaseLeft.value--;
    if (phaseLeft.value <= 0) {
      phaseIdx.value = (phaseIdx.value + 1) % PH.length;
      phaseLeft.value = PH[phaseIdx.value].sec;
      if (phaseIdx.value === 0) breaths.value++;
    }
  }, 1000);
}
function stopBreathe() { breathing.value = false; clearInterval(bTimer); }
onUnmounted(() => clearInterval(bTimer));
const phaseLabel = computed(() => (breathing.value ? PH[phaseIdx.value].label() : t("rail.breathe")));

/* —— 暖心飘带：轮 118 移除（与今日温柔签重复，且部分 stories 条目缺 zh 文案会漏英文）—— */

/* —— 心情速记 —— */
const MOODS = ["\u{1F929}", "\u{1F642}", "\u{1F60C}", "\u{1F327}\uFE0F", "\u{1F614}"];
const checkedToday = ref(getItem("wp-mood-" + todayKey()) !== null);
function moodPick(i) {
  if (checkedToday.value) return;
  if (checkInMood(i)) {
    setItem("wp-mood-" + todayKey(), String(i));
    checkedToday.value = true;
  }
}

/* ═══ 轮 117 · 侧栏新卡片（与主页面共用同一套 store/规则，不造第二本账） ═══ */

/* —— 左栏：今日温柔任务（与宠物页同一套任务与领取）—— */
const TASK_META = { feed: "🍚", mood: "🌻", draw: "🎨", play: "🎾", adv: "🎒" };
const taskRows = computed(() =>
  TASK_LIST.map((x) => ({ ...x, ico: TASK_META[x.key] || "✨" })));
const doneCount = computed(() => TASK_LIST.filter((x) => dailyTasks[x.key]).length);
const claimable = computed(() => claimableCoins());
const claimedNote = ref(0);
function doClaim() {
  const c = claimTasks();
  if (c > 0) {
    claimedNote.value = c;
    say(t("tasks.claimed", { c: c }), 3200);
  }
}

/* —— 左栏：今日陪伴（挂页即陪伴；按天累计在 localStorage，可见时每 30 秒记一笔）—— */
const accomKey = "wp-accomp-" + todayKey();
const accomSec = ref(Number(getItem(accomKey)) || 0);
function accomTick() {
  if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
  accomSec.value = (Number(accomSec.value) || 0) + 30;
  setItem(accomKey, String(accomSec.value));
}
let aTimer = setInterval(accomTick, 30000);
onUnmounted(() => clearInterval(aTimer));
const accomHm = computed(() => splitHm(accomSec.value));
const companionText = computed(() =>
  accomHm.value.h > 0
    ? t("rail.timeHm", { h: accomHm.value.h, m: accomHm.value.m })
    : t("rail.timeM", { m: accomHm.value.m }));

/* —— 右栏：今日温柔签（每天确定性一签；连续收集天数按天推进）—— */
const slip = computed(() => slipFor(GENTLE_SLIPS, todayKey()));
const slipText = computed(() => {
  const s = slip.value;
  if (!s) return "";
  return i18n.locale === "zh" ? s.zh : s.en;
});
const slipStreak = ref((() => {
  const raw = getItem("wp-slip-streak");
  try { return JSON.parse(raw) || {}; } catch (e) { return {}; }
})());
if (slip.value) {
  const next = bumpSlipStreak(slipStreak.value, todayKey());
  if (next.last !== slipStreak.value.last || next.count !== slipStreak.value.count) {
    slipStreak.value = next;
    setItem("wp-slip-streak", JSON.stringify(next));
  }
}
const slipCopied = ref(false);
async function copySlip() {
  const okCopy = await copyText(slipText.value);
  if (okCopy) {
    slipCopied.value = true;
    setTimeout(() => { slipCopied.value = false; }, 2000);
  }
}

/* —— 右栏：海边来信（漂流瓶小卡；服务端权威次数，与首页同一本账）—— */
const signedIn = computed(() => !!(cloud.ready && cloud.user));
const btLeft = ref({ send: 0, fish: 0 });
const btHeld = ref(0);
async function loadBottle() {
  if (!signedIn.value) return;
  try {
    const [q, held] = await Promise.all([bottleQuota(), bottleHeld()]);
    btLeft.value = bottleLeft(q, BOTTLE_SEND_MAX, BOTTLE_FISH_MAX);
    btHeld.value = Array.isArray(held) ? held.length : 0;
  } catch (e) { /* 静默：小卡片不弹错 */ }
}
onMounted(loadBottle);
watch(signedIn, loadBottle);
</script>

<template>
  <div class="rail rail-right">
    <div class="rail-card">
      <div class="rail-head">{{ t("rail.companion") }}</div>
      <template v-if="activePet">
        <div class="rail-pet">
          <span class="rp-emoji">{{ emoji }}</span>
          <div class="rp-id">
            <b>{{ activePet.name }}</b>
            <span>Lv.{{ activePet.level }}</span>
          </div>
        </div>
        <div v-if="petUi.speech" class="rail-speech">{{ petUi.speech }}</div>
        <div class="rail-bars">
          <div v-for="b in bars" :key="b.ico" class="rb">
            <span class="rb-ico">{{ b.ico }}</span>
            <div class="rb-track"><div class="rb-fill" :style="{ width: b.val + '%' }"></div></div>
          </div>
        </div>
        <div class="rail-actions">
          <button class="ra" :disabled="away" @click="quickPet">{{ t("rail.quickPet") }}</button>
          <button class="ra" :disabled="away" @click="quickFeed">{{ t("rail.quickFeed") }}</button>
          <button class="ra" @click="quickHarvest">{{ "\u{1F340}" }} {{ adventure.clovers }}</button>
        </div>
        <div v-if="away" class="rail-away">{{ t("adventure.backIn", { t: remainText }) }}</div>
        <div v-else-if="visitor" class="rail-visitor">
          <span class="rv-ico">{{ visitor.ico }}</span>
          <button class="ra tiny" @click="feedVisitor()">{{ t("adventure.feedVisitor") }}</button>
        </div>

        <!-- 轮 117：今日温柔任务（与宠物页同一套任务/领取，侧栏直达） -->
        <div class="rail-head" style="margin-top: 14px">{{ t("tasks.title") }}</div>
        <div class="tk-list">
          <div v-for="x in taskRows" :key="x.key" class="tk-row" :class="{ done: dailyTasks[x.key] }">
            <span class="tk-ico">{{ x.ico }}</span>
            <span class="tk-label">{{ t("tasks." + x.key) }}</span>
            <span class="tk-coin">💰{{ x.coin }}</span>
            <span class="tk-state">{{ dailyTasks[x.key] ? "✓" : "·" }}</span>
          </div>
        </div>
        <button v-if="claimable > 0" class="ra wide" @click="doClaim">
          {{ t("tasks.claim", { c: claimable }) }}
        </button>
        <p v-else-if="claimedNote > 0" class="b-count">
          <svg class="t-check" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12.5 9.5 18 20 6.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
          {{ t("tasks.claimed", { c: claimedNote }) }}
        </p>
        <p class="b-count">{{ t("tasks.progress", { done: doneCount, total: TASK_LIST.length }) }}</p>

        <!-- 轮 117：今日陪伴（挂页即陪伴，按天累计） -->
        <div class="ac-strip">🐾 {{ t("rail.companionTime", { t: companionText }) }}</div>
      </template>
    </div>

    <div class="rail-card" style="margin-top: 12px">
      <div class="rail-head">{{ t("rail.healing") }}</div>

      <!-- 轮 117：今日温柔签（每天一签，连集天数 + 一键抄录） -->
      <div class="slip" v-if="slipText">
        <p class="slip-text">{{ slipText }}</p>
        <div class="slip-foot">
          <span class="b-count">{{ t("rail.slipStreak", { n: slipStreak.count }) }}</span>
          <button class="ra tiny" @click="copySlip">{{ slipCopied ? t("rail.slipCopied") : t("common.copy") }}</button>
        </div>
      </div>

      <!-- 轮 117：海边来信（漂流瓶次数与手里的信，与首页同一本账；未登录不渲染） -->
      <template v-if="signedIn">
        <div class="rail-head" style="margin-top: 14px">{{ t("rail.bottleTitle") }}</div>
        <div class="bt">
          <p class="bt-line">{{ t("rail.bottleLeft", { n: btLeft.send, m: btLeft.fish }) }}</p>
          <p v-if="btHeld > 0" class="bt-line bt-warn">{{ t("rail.bottleHeld", { n: btHeld }) }}</p>
          <router-link class="ra wide bt-go" to="/">{{ t("rail.bottleGo") }}</router-link>
        </div>
      </template>

      <div class="breathe" style="margin-top: 14px">
        <div class="b-circle" :class="breathing ? PH[phaseIdx].k : ''"></div>
        <p class="b-label">{{ phaseLabel }}</p>
        <button class="ra" @click="breathing ? stopBreathe() : startBreathe()">
          {{ breathing ? t("rail.stop") : t("rail.start") }}
        </button>
        <p v-if="breaths > 0" class="b-count">{{ t("rail.breaths", { n: breaths }) }}</p>
      </div>

      <div class="rail-head" style="margin-top: 14px">{{ t("rail.moodQuick") }}</div>
      <div class="mq-row">
        <button
          v-for="(m, i) in MOODS" :key="i"
          class="mq" :disabled="checkedToday" @click="moodPick(i)">{{ m }}</button>
      </div>
      <p v-if="checkedToday" class="b-count">{{ t("home.mood.again") }}</p>
    </div>
  </div>
</template>

<style>
/* 两侧玩法栏：轮 132 收拢为右缘一列（≥1100px 显示；组件内样式是权威份——style.css 里曾有一份拷贝导致双源漂移，已删） */
.rail {
  position: fixed; right: 16px; top: 14px; bottom: 14px; width: 212px; z-index: 60;
  display: none; flex-direction: column; gap: 12px;
  overflow-y: auto; scrollbar-width: none; -ms-overflow-style: none;
}
.rail::-webkit-scrollbar { display: none; }
@media (min-width: 1100px) { .rail { display: flex; } }

.rail-card {
  background: var(--glass);
  backdrop-filter: blur(16px) saturate(1.3);
  -webkit-backdrop-filter: blur(16px) saturate(1.3);
  border: 1px solid rgba(255, 255, 255, .75);
  border-radius: 22px; padding: 12px;
  box-shadow: var(--shadow); max-height: calc(100vh - 112px); overflow-y: auto;
  scrollbar-width: none; -ms-overflow-style: none;
}
.rail-card::-webkit-scrollbar { display: none; }
.rail-head { font-size: 11px; font-weight: 500; letter-spacing: 1.5px; text-transform: uppercase; color: var(--ink-faint); }
.rail-pet { display: flex; align-items: center; gap: 9px; margin: 10px 0 6px; }
.rp-emoji { font-size: 34px; }
.rp-id { display: flex; flex-direction: column; line-height: 1.25; }
.rp-id b { font-size: 14px; }
.rp-id span { font-size: 11px; color: var(--ink-soft); font-weight: 500; }
.rail-speech {
  font-size: 11.5px; line-height: 1.55; color: var(--ink);
  background: #fff; border-radius: 12px; padding: 8px 10px;
  box-shadow: var(--shadow-sm); margin-bottom: 8px;
}
.rail-bars { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; }
.rb { display: flex; align-items: center; gap: 6px; }
.rb-ico { font-size: 12px; width: 16px; }
.rb-track { flex: 1; height: 7px; border-radius: 99px; background: rgba(160, 110, 60, .14); overflow: hidden; }
.rb-fill { height: 100%; border-radius: 99px; background: var(--accent); transition: width .6s ease; }
.rail-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.ra {
  font-family: inherit; font-size: 11.5px; font-weight: 500; color: var(--ink);
  background: #fff; border: 1.5px solid rgba(160, 110, 60, .18);
  border-radius: 999px; padding: 6px 11px; cursor: pointer; transition: all .2s ease;
}
.ra:hover:not(:disabled) { border-color: var(--accent); color: var(--accent-deep); transform: translateY(-1px); }
.ra:disabled { opacity: .45; cursor: default; }
.ra.tiny { padding: 4px 9px; font-size: 11px; }
.rail-away {
  margin-top: 10px; font-size: 11.5px; font-weight: 500; text-align: center;
  color: var(--accent-deep); background: var(--accent-soft);
  border-radius: 12px; padding: 7px 8px;
}
.rail-visitor { display: flex; align-items: center; justify-content: space-between; margin-top: 10px; }
.rv-ico { font-size: 24px; animation: cloverSway 3s ease-in-out infinite; }

.breathe { text-align: center; margin-top: 12px; }
.b-circle {
  width: 46px; height: 46px; margin: 0 auto; border-radius: 50%;
  background: radial-gradient(circle at 32% 30%, var(--accent-soft), var(--accent));
  box-shadow: 0 6px 18px rgba(255, 159, 90, .4);
  transform: scale(.78); transition: transform 3.9s ease-in-out;
}
.b-circle.grow { transform: scale(1.32); }
.b-circle.hold { transform: scale(1.32); }
.b-circle.shrink { transform: scale(.78); }
.b-label { font-size: 12.5px; font-weight: 500; color: var(--ink-soft); margin: 10px 0 8px; min-height: 18px; }
.b-count { font-size: 11px; color: var(--ink-faint); font-weight: 500; margin-top: 8px; }
.mq-row { display: flex; gap: 5px; flex-wrap: wrap; margin-top: 8px; }
.mq {
  font-size: 19px; background: #fff; border: 1.5px solid rgba(160, 110, 60, .15);
  border-radius: 12px; padding: 4px 7px; cursor: pointer; transition: all .2s ease;
  font-family: inherit;
}
.mq:hover:not(:disabled) { transform: translateY(-2px) scale(1.08); border-color: var(--accent); }
.mq:disabled { opacity: .55; cursor: default; }

/* ═══ 轮 117 · 侧栏新卡片 ═══ */
/* 今日温柔任务 */
.tk-list { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; }
.tk-row {
  display: flex; align-items: center; gap: 5px; font-size: 11.5px; font-weight: 500;
  color: var(--ink-soft); background: rgba(255, 255, 255, .55);
  border-radius: 10px; padding: 5px 7px;
}
.tk-row.done { color: var(--ink-faint); text-decoration: line-through; }
.tk-ico { font-size: 13px; }
.tk-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tk-coin { font-size: 10px; color: var(--ink-faint); font-weight: 500; }
.tk-state { width: 12px; text-align: center; color: var(--accent-deep); font-weight: 500; }
.ra.wide { display: block; width: 100%; text-align: center; margin-top: 8px; }
.ac-strip {
  margin-top: 12px; font-size: 11px; font-weight: 500; text-align: center;
  color: var(--accent-deep); background: var(--accent-soft);
  border-radius: 12px; padding: 6px 8px;
}
/* 今日温柔签 */
.slip {
  margin-top: 10px; background: #fff; border-radius: 14px; padding: 11px 12px;
  box-shadow: var(--shadow-sm); border: 1px dashed rgba(160, 110, 60, .22);
}
.slip-text { font-size: 12px; line-height: 1.75; font-weight: 500; color: var(--ink); }
.slip-foot { display: flex; align-items: center; justify-content: space-between; margin-top: 7px; }
/* 海边来信 */
.bt { margin-top: 8px; }
.bt-line { font-size: 11.5px; font-weight: 500; color: var(--ink-soft); line-height: 1.6; }
.bt-line.bt-warn { color: var(--accent-deep); }
.bt-go { text-decoration: none; margin-top: 7px; }
</style>