<script setup>
import { ref, computed, onMounted, onUnmounted } from "vue";
import { t, i18n } from "../i18n.js";
import { SPECIES } from "../data/pets.js";
import { stories } from "../data/stories.js";
import { todayKey } from "../utils/daily.js";
import { getItem, setItem } from "../utils/storage.js";
import {
  activePet, petUi, say, doPetting, feedDish, cookbook,
  adventure, harvestClover, feedVisitor, checkInMood,
} from "../stores/petStore.js";
import { visitorByKey } from "../data/adventure.js";

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

/* —— 暖心飘带 —— */
const quotes = stories.map((s) => (i18n.locale === "zh" ? s.quote.zh : s.quote.en));
const qi = ref(0);
let qTimer = setInterval(() => { qi.value = (qi.value + 1) % quotes.length; }, 6000);
onUnmounted(() => clearInterval(qTimer));
const quoteNow = computed(() => quotes[qi.value] || "");

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
</script>

<template>
  <div class="rail rail-left">
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
      </template>
    </div>
  </div>

  <div class="rail rail-right">
    <div class="rail-card">
      <div class="rail-head">{{ t("rail.healing") }}</div>
      <div class="breathe">
        <div class="b-circle" :class="breathing ? PH[phaseIdx].k : ''"></div>
        <p class="b-label">{{ phaseLabel }}</p>
        <button class="ra" @click="breathing ? stopBreathe() : startBreathe()">
          {{ breathing ? t("rail.stop") : t("rail.start") }}
        </button>
        <p v-if="breaths > 0" class="b-count">{{ t("rail.breaths", { n: breaths }) }}</p>
      </div>

      <div class="rail-head" style="margin-top: 14px">{{ t("rail.ticker") }}</div>
      <transition name="fade" mode="out-in">
        <p :key="qi" class="tk-quote">{{ quoteNow }}</p>
      </transition>

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
/* 两侧玩法栏：≥1280px 宽屏显示，窄屏自动隐藏 */
.rail { position: fixed; top: 92px; width: 212px; z-index: 60; display: none; }
.rail-left { left: calc(50% - 622px); }
.rail-right { right: calc(50% - 622px); }
@media (min-width: 1280px) { .rail { display: block; } }

.rail-card {
  background: var(--glass);
  backdrop-filter: blur(16px) saturate(1.3);
  -webkit-backdrop-filter: blur(16px) saturate(1.3);
  border: 1px solid rgba(255, 255, 255, .75);
  border-radius: 22px; padding: 14px;
  box-shadow: var(--shadow); max-height: 82vh; overflow: auto;
}
.rail-head { font-size: 11px; font-weight: 800; letter-spacing: 1.5px; text-transform: uppercase; color: var(--ink-faint); }
.rail-pet { display: flex; align-items: center; gap: 9px; margin: 10px 0 6px; }
.rp-emoji { font-size: 34px; }
.rp-id { display: flex; flex-direction: column; line-height: 1.25; }
.rp-id b { font-size: 14px; }
.rp-id span { font-size: 11px; color: var(--ink-soft); font-weight: 700; }
.rail-speech {
  font-size: 11.5px; line-height: 1.55; color: var(--ink);
  background: #fff; border-radius: 12px; padding: 8px 10px;
  box-shadow: var(--shadow-sm); margin-bottom: 8px;
}
.rail-bars { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; }
.rb { display: flex; align-items: center; gap: 6px; }
.rb-ico { font-size: 12px; width: 16px; }
.rb-track { flex: 1; height: 7px; border-radius: 99px; background: rgba(160, 110, 60, .14); overflow: hidden; }
.rb-fill { height: 100%; border-radius: 99px; background: linear-gradient(90deg, #ffc38f, #ff9f5a); transition: width .6s ease; }
.rail-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.ra {
  font-family: inherit; font-size: 11.5px; font-weight: 800; color: var(--ink);
  background: #fff; border: 1.5px solid rgba(160, 110, 60, .18);
  border-radius: 999px; padding: 6px 11px; cursor: pointer; transition: all .2s ease;
}
.ra:hover:not(:disabled) { border-color: var(--accent); color: var(--accent-deep); transform: translateY(-1px); }
.ra:disabled { opacity: .45; cursor: default; }
.ra.tiny { padding: 4px 9px; font-size: 11px; }
.rail-away {
  margin-top: 10px; font-size: 11.5px; font-weight: 800; text-align: center;
  color: var(--accent-deep); background: var(--accent-soft);
  border-radius: 12px; padding: 7px 8px;
}
.rail-visitor { display: flex; align-items: center; justify-content: space-between; margin-top: 10px; }
.rv-ico { font-size: 24px; animation: cloverSway 3s ease-in-out infinite; }

.breathe { text-align: center; margin-top: 12px; }
.b-circle {
  width: 64px; height: 64px; margin: 0 auto; border-radius: 50%;
  background: radial-gradient(circle at 32% 30%, var(--accent-soft), var(--accent));
  box-shadow: 0 6px 18px rgba(255, 159, 90, .4);
  transform: scale(.78); transition: transform 3.9s ease-in-out;
}
.b-circle.grow { transform: scale(1.32); }
.b-circle.hold { transform: scale(1.32); }
.b-circle.shrink { transform: scale(.78); }
.b-label { font-size: 12.5px; font-weight: 800; color: var(--ink-soft); margin: 10px 0 8px; min-height: 18px; }
.b-count { font-size: 11px; color: var(--ink-faint); font-weight: 700; margin-top: 8px; }
.tk-quote { font-size: 12px; line-height: 1.7; color: var(--ink); font-weight: 600; margin-top: 8px; min-height: 58px; }
.mq-row { display: flex; gap: 5px; flex-wrap: wrap; margin-top: 8px; }
.mq {
  font-size: 19px; background: #fff; border: 1.5px solid rgba(160, 110, 60, .15);
  border-radius: 12px; padding: 4px 7px; cursor: pointer; transition: all .2s ease;
  font-family: inherit;
}
.mq:hover:not(:disabled) { transform: translateY(-2px) scale(1.08); border-color: var(--accent); }
.mq:disabled { opacity: .55; cursor: default; }
</style>