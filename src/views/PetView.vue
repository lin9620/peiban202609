<script setup>
import { ref, computed, onMounted, onUnmounted } from "vue";
import { t, i18n } from "../i18n.js";
import { stories } from "../data/stories.js";
import { dayIndex } from "../utils/daily.js";
import { SPECIES, PERSONALITIES } from "../data/pets.js";
import {
  petStore, activePet, petUi, say,
  doPlay, doPetting, doClean, toggleSleep, savePet, talkByStatus,
  cookbook, feedDish, removeDish, wallet,
  dailyTasks, claimTasks, TASK_LIST,
} from "../stores/petStore.js";
import PetMotion from "../components/PetMotion.vue";
import FoodPainter from "../components/FoodPainter.vue";
import ShareCard from "../components/ShareCard.vue";
import PostcardCard from "../components/PostcardCard.vue";
import {
  adventure, activePetAway, departAdventure, harvestClover, feedVisitor,
} from "../stores/petStore.js";
import {
  DESTS, SOUVENIRS, TOTAL_SOUVENIRS, souvByKey, visitorByKey,
} from "../data/adventure.js";
import { ACCESSORIES, seasonNow } from "../data/extras.js";
import SeasonFx from "../components/SeasonFx.vue";
import SnackRain from "../components/SnackRain.vue";
import {
  wardrobe, accByKey, buyAccessory, wearAccessory, toggleFramed,
} from "../stores/petStore.js";

import {
  validateImageFile, isSaneShape, isUsableDataUrl, shrinkToDataUrl, MAX_PET_EDGE,
} from "../utils/imaging.js";

const tab = ref("care");

/* —— 零食雨小游戏 —— */
const snackOn = ref(false);

/* —— 领养/创建弹窗 —— */
const showAdopt = ref(false);
const adoptTab = ref("species");   // species | custom
const selectedSpecies = ref("cat");
const newName = ref("");
const newPersona = ref("gentle");
const customImg = ref("");
const customLines = ref(["", "", ""]);
const adoptMsg = ref("");

const maxLevel = computed(() =>
  petStore.pets.length ? Math.max(...petStore.pets.map((p) => p.level)) : 1
);

function canAfford(sp) {
  return wallet.coins >= sp.cost && maxLevel.value >= sp.unlockLv;
}

function confirmAdoptSpecies() {
  const sp = SPECIES.find((s) => s.key === selectedSpecies.value);
  if (!sp || !canAfford(sp)) {
    adoptMsg.value = t("pet.notEnough");
    return;
  }
  wallet.coins -= sp.cost;
  const pet = petStore.adopt(
    sp.key,
    newName.value.trim() || sp.name[i18n.locale] || sp.name.en,
    newPersona.value
  );
  adoptMsg.value = t("pet.adopted", { n: pet.name });
  say(t("pet.adopted", { n: pet.name }), 4000);
  resetForm();
}

const customErr = ref("");
function showCustomErr(tk) {
  customErr.value = tk;
  setTimeout(() => { customErr.value = ""; }, 3200);
}

/* 立绘上传：预检(类型/体积) → 解码 → 体检(比例/像素) → 压到 480px PNG（保透明）→ 可用性校验
   与社区帖图片共用 src/utils/imaging.js，避免超大图撑爆 Canvas 与 localStorage */
function pickCustomImg(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const pre = validateImageFile(file);
  if (!pre.ok) return showCustomErr(pre.reason === "too-large" ? "pet.imgTooLarge" : "pet.imgFail");
  const reader = new FileReader();
  reader.onerror = () => showCustomErr("pet.imgFail");
  reader.onload = () => {
    if (!isUsableDataUrl(reader.result)) return showCustomErr("pet.imgFail");
    const img = new Image();
    img.onerror = () => showCustomErr("pet.imgFail");
    img.onload = () => {
      if (!isSaneShape(img.naturalWidth, img.naturalHeight)) return showCustomErr("pet.imgBadShape");
      try {
        const out = shrinkToDataUrl(img, 0.85, "image/png", MAX_PET_EDGE);
        if (!isUsableDataUrl(out)) return showCustomErr("pet.imgFail");
        customImg.value = out;
      } catch (err) {
        showCustomErr("pet.imgFail");
      }
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

function createCustom() {
  if (!customImg.value) return;
  const pet = petStore.adopt(
    "custom",
    newName.value.trim() || "My Character",
    newPersona.value,
    {
      img: customImg.value,
      lines: customLines.value.map((l) => l.trim()).filter(Boolean).slice(0, 3),
    }
  );
  adoptMsg.value = t("pet.created");
  say(t("pet.created"), 4000);
  resetForm();
}

function resetForm() {
  newName.value = "";
  newPersona.value = "gentle";
  customImg.value = "";
  customLines.value = ["", "", ""];
  setTimeout(() => { adoptMsg.value = ""; showAdopt.value = false; }, 1600);
}

/* —— 定时器（心跳计时器已提到 App.vue 全局，避免重复衰减）—— */
let speechTimer;
onMounted(() => {
  const loop = () => {
    if (activePet.value) talkByStatus(activePet.value);
    speechTimer = setTimeout(loop, (16 + Math.floor(Math.random() * 20)) * 1000);
  };
  speechTimer = setTimeout(loop, 7000);
});
onUnmounted(() => {
  clearTimeout(speechTimer);
  savePet();
});

/* —— 粒子 —— */
const fxList = ref([]);
let fxId = 0;
function spawnFx(icons, count = 5) {
  const pool = icons.filter(Boolean);
  if (!pool.length) return;
  for (let i = 0; i < count; i++) {
    const id = fxId++;
    fxList.value.push({ id, ico: pool[i % pool.length], x: 18 + Math.random() * 60, y: 20 + Math.random() * 40, d: i * 90 });
    setTimeout(() => { fxList.value = fxList.value.filter((f) => f.id !== id); }, 1300 + i * 90);
  }
}
function onStageClick() {
  if (!activePet.value || activePet.value.sleeping) return;
  doPetting();
  spawnFx(["💗", "💖", "🐾", "✨"]);
}
function fxDoPlay() { doPlay(); spawnFx(["🎾", "❤️", "🎵", "✨"]); }
function fxClean() { doClean(); spawnFx(["🫧", "🧼", "✨"]); }

const quote = computed(() => {
  const s = stories[dayIndex(stories.length)];
  return i18n.locale === "zh" ? s.quote.zh : s.quote.en;
});
const showShare = ref(false);

const pfillClass = (v) => (v >= 60 ? "" : v >= 30 ? "warn" : "low");

/* —— 四维状态条 —— */
const stats = computed(() => {
  const p = activePet.value;
  if (!p) return [];
  return [
    { key: "hunger", ico: "🍚", val: Math.round(p.hunger) },
    { key: "mood", ico: "💗", val: Math.round(p.mood) },
    { key: "clean", ico: "🫧", val: Math.round(p.clean) },
    { key: "energy", ico: "⚡", val: Math.round(p.energy) },
  ];
});

/* —— 每日温柔任务 —— */
const TASK_META = { feed: "🍚", mood: "\u{1F31E}", draw: "🎨", play: "🎾", adv: "\u{1F392}" };
const taskRows = computed(() =>
  TASK_LIST.map((x) => ({ ...x, ico: TASK_META[x.key] || "✨" }))
);
const doneCount = computed(() => TASK_LIST.filter((x) => dailyTasks[x.key]).length);
const donePct = computed(() => Math.round((doneCount.value / TASK_LIST.length) * 100));
const totalCoins = computed(() =>
  TASK_LIST.reduce((s, x) => s + (dailyTasks[x.key] ? x.coin : 0), 0)
);
const canClaim = computed(() => !dailyTasks.claimed && doneCount.value > 0);
const claimMsg = ref("");

function claim() {
  const n = claimTasks();
  if (n <= 0) return;
  claimMsg.value = t("tasks.claimed");
  spawnFx(["🪙", "✨", "💰"], 4);
  setTimeout(() => { claimMsg.value = ""; }, 2800);
}

/* —— 互动包装 —— */
function feedHint() {
  if (cookbook.length) {
    feedDish(cookbook[0]);
    spawnFx(["🍚", "💗", "✨"], 4);
  } else {
    tab.value = "paint";
    say(t("pet.painter.intro"), 4200);
  }
}
function onDishSaved() {
  say(t("pet.painter.saved"), 3000);
  spawnFx(["🎨", "✨", "🐾"], 4);
}
function onFeedDish(d) {
  feedDish(d);
  spawnFx(["🍚", "💗", "✨"], 4);
}
function openAdopt() {
  adoptMsg.value = "";
  showAdopt.value = true;
}
function emojiOf(key) {
  const s = SPECIES.find((x) => x.key === key);
  return s ? s.emoji : "\u{1F43E}";
}
const personaName = (key) => {
  const p = PERSONALITIES.find((x) => x.key === key);
  return p ? (p.name[i18n.locale] || p.name.en) : key;
};
const speciesName = (key) => {
  const s = SPECIES.find((x) => x.key === key);
  return s ? (s.name[i18n.locale] || s.name.en) : "My Character";
};

/* —— 旅行冒险（旅行青蛙式）—— */
const away = activePetAway;
const advDish = ref(null);
const nowTick = ref(Date.now());
let advTimer;
onMounted(() => {
  advTimer = setInterval(() => { nowTick.value = Date.now(); }, 1000);
});
onUnmounted(() => clearInterval(advTimer));

const remainSec = computed(() => Math.max(0, Math.ceil((adventure.returnsAt - nowTick.value) / 1000)));
const remainText = computed(() => {
  const s = remainSec.value;
  return s >= 60 ? t("adventure.timeM", { m: Math.ceil(s / 60) }) : t("adventure.timeS", { s });
});
const visitorPet = computed(() => visitorByKey(adventure.visitor || ""));
const tripCount = computed(() => adventure.trips);
const souvProgress = computed(
  () => adventure.souvenirs.length + "/" + TOTAL_SOUVENIRS
);
const destIco = computed(() =>
  away.value ? "\u2753" : destByKeySafe(adventure.destKey).ico
);
function destByKeySafe(key) {
  return DESTS.find((d) => d.key === key) || DESTS[0];
}
const petEmojiOf = computed(() =>
  activePet.value ? emojiOf(activePet.value.species) : "\u{1F431}"
);
const souvDex = computed(() => {
  const rows = [];
  for (const d of DESTS) {
    (SOUVENIRS[d.key] || []).forEach((s, idx) => {
      const key = d.key + ":" + idx;
      const owned = adventure.souvenirs.find((x) => x.key === key);
      rows.push({
        key, known: !!owned, ico: s.ico, n: owned ? owned.n : 0,
        name: s.name[i18n.locale] || s.name.en,
      });
    });
  }
  return rows;
});

function harvest() {
  const n = harvestClover();
  if (n > 0) {
    spawnFx(["\u{1F340}", "\u{1FA99}", "\u2728"], 4);
    say(t("adventure.harvested", { n: n * 2 }), 3000);
  }
}
function offerFood() {
  if (!visitorPet.value) return;
  if (!cookbook.length) { say(t("adventure.noDish"), 3500); return; }
  feedVisitor();
  spawnFx(["\u{1F9FA}", "\u{1F497}", "\u2728"], 4);
}
function depart() {
  if (departAdventure(advDish.value)) spawnFx(["\u{1F392}", "\u2728", "\u{1F43E}"], 5);
}
function dismissWelcome() { adventure.welcome = null; }
function gainedNames(keys) {
  return keys.map((k) => {
    const s = souvByKey(k);
    return s ? (s.name[i18n.locale] || s.name.en) : "";
  }).filter(Boolean).join(i18n.locale === "zh" ? "、" : ", ");
}

/* —— 装扮 · 画廊 · 季节 —— */
const season = seasonNow();
const seasonName = computed(() => season.name[i18n.locale] || season.name.en);
const wornAcc = computed(() =>
  activePet.value && activePet.value.wear ? accByKey(activePet.value.wear) : null
);
const accRows = computed(() =>
  ACCESSORIES.map((a) => ({
    ...a,
    owned: wardrobe.owned.includes(a.key),
    worn: !!(activePet.value && activePet.value.wear === a.key),
  }))
);
const framedDishes = computed(() => cookbook.filter((d) => d.framed).slice(0, 4));

function onAccClick(a) {
  if (!a.owned) {
    if (buyAccessory(a.key)) {
      say(t("wardrobe.bought"), 3000);
      spawnFx(["\u2728", "\u{1F451}", "\u{1F33C}"], 4);
    } else {
      say(t("pet.notEnough"), 3200);
    }
  } else {
    wearAccessory(a.key);
  }
}
function onToggleFramed(d) {
  toggleFramed(d.id);
}
</script>

<template>
  <div class="pet-page">
  <div class="park-hero">
    <div>
      <h1 class="park-title">🐾 {{ t("pet.parkTitle") }}</h1>
      <p class="park-sub">{{ t("pet.subtitle") }}</p>
    </div>
    <div class="park-coins">
      <span class="coin-pill">🪙 {{ wallet.coins }}</span>
      <span class="coin-pill">⭐ {{ t("pet.level") }} {{ activePet ? activePet.level : 1 }}</span>
    </div>
  </div>

  <div class="card">
    <h2>{{ t("pet.switchPet") }}</h2>
    <div class="pet-switcher">
      <div
        v-for="p in petStore.pets" :key="p.id" class="p-card"
        :class="{ on: p.id === petStore.activeId }"
        @click="petStore.switchTo(p.id)">
        <img v-if="p.custom && p.custom.img" :src="p.custom.img" class="custom-thumb" alt="" />
        <div v-else class="p-emoji">{{ emojiOf(p.species) }}</div>
        <div class="p-name">{{ p.name }}</div>
        <div class="p-meta">Lv.{{ p.level }}</div>
        <span v-if="p.id === petStore.activeId" class="p-badge">{{ t("pet.active") }}</span>
      </div>

      <div class="p-card add" @click="openAdopt">
        <div class="p-emoji">➕</div>
        <div class="p-name">{{ t("pet.adoptNew") }}</div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="tabs">
      <button class="tab" :class="{ on: tab === 'care' }" @click="tab = 'care'">{{ t("pet.tabs.care") }}</button>
      <button class="tab" :class="{ on: tab === 'adv' }" @click="tab = 'adv'">{{ t("pet.tabs.adv") }}</button>
      <button class="tab" :class="{ on: tab === 'paint' }" @click="tab = 'paint'">{{ t("pet.tabs.paint") }}</button>
      <button class="tab" :class="{ on: tab === 'book' }" @click="tab = 'book'">{{ t("pet.tabs.book") }}</button>
    </div>
<template v-if="tab === 'care' && activePet">
      <div v-if="away" class="away-note">
        {{ t("adventure.awayTitle", { n: activePet.name }) }} · {{ t("adventure.backIn", { t: remainText }) }}
      </div>
      <div v-if="!away" class="pet-stage" @click="onStageClick">
        <div v-if="petUi.speech" class="speech-bubble">{{ petUi.speech }}</div>
        <div v-if="activePet.sleeping" class="zzz"><span>z</span><span>Z</span><span>Z</span></div>
        <PetMotion :pet="activePet" />
        <SeasonFx :count="9" />
        <div v-if="framedDishes.length" class="gallery-strip">
          <span v-for="d in framedDishes" :key="d.id" class="g-frame">
            <img :src="d.img" alt="" />
          </span>
        </div>
        <div v-if="wornAcc" class="acc-wear" :style="{ top: wornAcc.dy + 'px' }">{{ wornAcc.ico }}</div>
        <div class="fx-layer">
          <span
            v-for="f in fxList" :key="f.id" class="fx"
            :style="{ left: f.x + '%', top: f.y + '%', animationDelay: f.d + 'ms' }">{{ f.ico }}</span>
        </div>
      </div>

      <div class="pet-stats">
        <div v-for="s in stats" :key="s.key" class="pstat">
          <span class="ps-ico">{{ s.ico }}</span>
          <span class="ps-label">{{ t("pet.stats." + s.key) }}</span>
          <div class="pbar"><div class="pfill" :class="pfillClass(s.val)" :style="{ width: s.val + '%' }"></div></div>
        </div>
      </div>

      <div class="wardrobe">
        <div class="row-between">
          <span class="sec-label">{{ t("wardrobe.title") }}</span>
          <span class="notice">{{ seasonName }}</span>
        </div>
        <div class="acc-row">
          <button
            v-for="a in accRows" :key="a.key"
            class="acc-chip" :class="{ on: a.worn, locked: !a.owned }"
            @click="onAccClick(a)">
            <span class="a-ico">{{ a.ico }}</span>
            <span class="a-name">{{ a.name[i18n.locale] || a.name.en }}</span>
            <span v-if="!a.owned" class="a-cost">{{ "\u{1FA99}" }}{{ a.cost }}</span>
            <span v-else-if="a.worn" class="a-cost">{{ t("wardrobe.worn") }}</span>
          </button>
        </div>
        <p class="sub">{{ t("wardrobe.hint") }}</p>
      </div>

      <div v-if="!away" class="pet-actions">
        <button class="act" @click="feedHint"><span>{{ "\u{1F35A}" }}</span>{{ t("pet.actions.feed") }}</button>
        <button class="act" @click="fxDoPlay"><span>🎾</span>{{ t("pet.actions.play") }}</button>
        <button class="act" @click="onStageClick"><span>{{ "\u{1F497}" }}</span>{{ t("pet.actions.pet") }}</button>
        <button class="act" @click="fxClean"><span>🫧</span>{{ t("pet.actions.clean") }}</button>
        <button class="act" @click="toggleSleep">
          <span>{{ activePet.sleeping ? "\u2600\uFE0F" : "\u{1F319}" }}</span>
          {{ activePet.sleeping ? t("pet.actions.wake") : t("pet.actions.sleep") }}
        </button>
        <button class="act" @click="snackOn = true"><span>{{ "\u{1F36C}" }}</span>{{ t("pet.snack.btn") }}</button>
        <button class="act" @click="showShare = true"><span>🖼️</span>{{ t("home.share") }}</button>
      </div>
      <p class="streak-note">{{ t("pet.tip") }}</p>
    </template>

    <template v-else-if="tab === 'adv'">
      <!-- 欢迎回家 -->
      <div v-if="adventure.welcome" class="card welcome-banner">
        <h2>{{ t("adventure.welcomeBack", { n: activePet ? activePet.name : "", c: adventure.welcome.coins }) }}</h2>
        <p v-if="adventure.welcome.souvenirs.length" class="sub">
          {{ t("adventure.brought") }}: {{ gainedNames(adventure.welcome.souvenirs) }}
        </p>
        <div class="wb-cards">
          <PostcardCard
            v-for="(c, i) in adventure.postcards.slice(0, 3)" :key="c.ts + '-' + i"
            :card="c" :pet-emoji="emojiOf(c.petSpecies)" :pet-name="activePet ? activePet.name : ''" />
        </div>
        <button class="btn small ghost" style="margin-top: 10px" @click="dismissWelcome">
          {{ t("common.close") }}
        </button>
      </div>

      <!-- 小庭院 -->
      <div class="card">
        <div class="row-between">
          <h2>{{ t("adventure.yard") }}</h2>
          <span class="notice">{{ t("adventure.trips", { n: tripCount }) }}</span>
        </div>
        <p class="sub">{{ t("adventure.cloverTip") }}</p>
        <button class="clover-patch" :disabled="!adventure.clovers" @click="harvest">
          <span
            v-for="i in 8" :key="i"
            class="clover" :class="{ grown: i <= adventure.clovers }">{{ "\u{1F340}" }}</span>
          <span class="clover-count">{{ "\u{1FA99}" }} {{ adventure.clovers }}</span>
        </button>

        <div v-if="visitorPet" class="visitor-chip">
          <span class="v-ico">{{ visitorPet.ico }}</span>
          <div class="v-info">
            <b>{{ t("adventure.visitorHere", { v: visitorPet.name[i18n.locale] || visitorPet.name.en }) }}</b>
            <span>{{ visitorPet.line[i18n.locale] || visitorPet.line.en }}</span>
          </div>
          <button class="btn small" @click="offerFood">{{ t("adventure.feedVisitor") }}</button>
        </div>
      </div>

      <!-- 出发 / 旅行中 -->
      <div class="card">
        <template v-if="!away">
          <h2>{{ t("adventure.prepare", { n: activePet ? activePet.name : "" }) }}</h2>
          <div v-if="cookbook.length" class="carry-row">
            <button
              v-for="d in cookbook.slice(0, 6)" :key="d.id"
              class="carry-chip" :class="{ on: advDish && advDish.id === d.id }"
              @click="advDish = advDish === d ? null : d">
              <img :src="d.img" alt="" /><span>{{ d.name }}</span>
            </button>
          </div>
          <p class="sub">{{ t("adventure.carryFood") }}</p>
          <button class="btn" style="margin-top: 10px" @click="depart">{{ t("adventure.depart") }}</button>
        </template>
        <template v-else>
          <h2>{{ t("adventure.awayTitle", { n: activePet ? activePet.name : "" }) }}</h2>
          <div class="away-road">
            <span class="road-emoji">{{ petEmojiOf }}</span>
            <span class="road-dots">···</span>
            <span class="road-ico">{{ destIco }}</span>
          </div>
          <p class="back-pill">{{ t("adventure.backIn", { t: remainText }) }}</p>
          <p class="sub">{{ t("adventure.awayNote") }}</p>
        </template>
      </div>

      <!-- 旅行相册 -->
      <div class="card">
        <h2>{{ t("adventure.album") }}</h2>
        <p v-if="!adventure.postcards.length" class="sub">{{ t("adventure.albumEmpty") }}</p>
        <div v-else class="album-grid">
          <PostcardCard
            v-for="(c, i) in adventure.postcards" :key="c.ts + '-' + i"
            :card="c" :pet-emoji="emojiOf(c.petSpecies)" :pet-name="activePet ? activePet.name : ''" />
        </div>
      </div>

      <!-- 特产图鉴 -->
      <div class="card">
        <div class="row-between">
          <h2>{{ t("adventure.collection") }}</h2>
          <span class="notice">{{ souvProgress }}</span>
        </div>
        <div class="souv-grid">
          <div
            v-for="item in souvDex" :key="item.key"
            class="souv-cell" :class="{ known: item.known }">
            <span class="s-ico">{{ item.known ? item.ico : "\u2753" }}</span>
            <span class="s-name">{{ item.known ? item.name : t("adventure.unknown") }}</span>
            <span v-if="item.n > 1" class="s-n">×{{ item.n }}</span>
          </div>
        </div>
      </div>
    </template>

    <template v-else-if="tab === 'paint'">
      <p class="sub">{{ t("pet.painter.intro") }}</p>
      <FoodPainter @saved="onDishSaved" />
    </template>

    <template v-else>
      <div v-if="!cookbook.length" class="streak-note">{{ t("pet.painter.empty") }}</div>
      <div v-else class="book-grid">
        <div v-for="d in cookbook" :key="d.id" class="dish">
          <img :src="d.img" :alt="d.name" />
          <div class="name">{{ d.name }}</div>
          <div class="row">
            <button class="btn small" @click="onFeedDish(d)">{{ t("pet.painter.feed") }}</button>
            <button class="btn small ghost" :class="{ 'framed-on': d.framed }" @click="onToggleFramed(d)">
              {{ d.framed ? t("gallery.hung") : t("gallery.hang") }}
            </button>
            <button class="dish-del" @click="removeDish(d.id)">{{ t("common.delete") }}</button>
          </div>
        </div>
      </div>
    </template>
  </div>

  <div class="card">
    <h2>{{ t("tasks.title") }}</h2>
    <div class="task-progress"><div :style="{ width: donePct + '%' }"></div></div>
    <div
      v-for="task in taskRows" :key="task.key" class="task-row"
      :class="{ done: dailyTasks[task.key] }">
      <div class="t-ico">{{ task.ico }}</div>
      <div class="t-name">{{ t("tasks." + task.key) }}</div>
      <div class="t-state">{{ dailyTasks[task.key] ? "\u2705" : "" }}</div>
    </div>
    <button class="btn" style="margin-top: 6px" :disabled="!canClaim" @click="claim">
      {{ claimMsg || t("tasks.claim", { c: totalCoins }) }}
    </button>
  </div>

  <div v-if="showAdopt" class="adopt-mask" @click.self="showAdopt = false">
    <div class="adopt-modal">
      <h3>{{ t("pet.adoptNew") }}</h3>
      <div class="tabs" style="justify-content: center">
        <button class="tab" :class="{ on: adoptTab === 'species' }" @click="adoptTab = 'species'">
          {{ t("pet.tabAdopt") }}
        </button>
        <button class="tab" :class="{ on: adoptTab === 'custom' }" @click="adoptTab = 'custom'">
          {{ t("pet.tabCustom") }}
        </button>
      </div>

      <template v-if="adoptTab === 'species'">
        <div class="adopt-grid">
          <div
            v-for="sp in SPECIES" :key="sp.key" class="adopt-card"
            :class="{ on: selectedSpecies === sp.key, locked: !canAfford(sp) }"
            @click="selectedSpecies = sp.key">
            <div class="a-emoji">{{ sp.emoji }}</div>
            <div class="a-name">{{ sp.name[i18n.locale] || sp.name.en }}</div>
            <div class="a-desc">{{ sp.desc[i18n.locale] || sp.desc.en }}</div>
            <div class="a-meta">{{ t("pet.unlockAt", { lv: sp.unlockLv, c: sp.cost }) }}</div>
          </div>
        </div>
        <button class="btn" style="margin-top: 16px" @click="confirmAdoptSpecies">
          {{ t("pet.adoptNew") }}
        </button>
      </template>

      <template v-else>
        <p class="sub">{{ t("pet.customIntro") }}</p>
        <div class="custom-up">
          <img v-if="customImg" :src="customImg" class="custom-preview" alt="" />
          <label class="btn ghost small">
            {{ t("pet.chooseImg") }}
            <input type="file" accept="image/png,image/jpeg,image/webp" style="display: none" @change="pickCustomImg" />
          </label>
        </div>
        <p v-if="customErr" class="notice" style="color: var(--low); font-weight: 700">{{ t(customErr) }}</p>
        <p class="streak-note">{{ t("pet.linesLabel") }}</p>
        <div class="line-inputs">
          <input
            v-for="(l, i) in customLines" :key="i" v-model="customLines[i]"
            class="input" :placeholder="t('pet.linePh')" />
        </div>
        <button class="btn" style="margin-top: 16px" :disabled="!customImg" @click="createCustom">
          {{ t("pet.create") }}
        </button>
      </template>

      <div style="margin-top: 16px">
        <input v-model="newName" class="input" :placeholder="t('pet.namePh')" />
      </div>
      <p class="streak-note">{{ t("pet.personality") }}</p>
      <div class="persona-row">
        <button
          v-for="pe in PERSONALITIES" :key="pe.key" class="chip"
          :class="{ on: newPersona === pe.key }" @click="newPersona = pe.key">
          {{ pe.emoji }} {{ pe.name[i18n.locale] || pe.name.en }}
        </button>
      </div>
      <p v-if="adoptMsg" class="adopt-msg">{{ adoptMsg }}</p>
      <div class="adopt-row">
        <button class="btn ghost" @click="showAdopt = false">{{ t("common.close") }}</button>
      </div>
    </div>
  </div>

  <ShareCard v-if="showShare" :quote="quote" :pet="activePet" @close="showShare = false" />
  <SnackRain v-if="snackOn" @close="snackOn = false" />
  </div>
</template>

<style>
/* ═══════════ 宠物乐园页头 ═══════════ */
.park-hero {
  display: flex; justify-content: space-between; align-items: flex-start;
  gap: 14px; flex-wrap: wrap; margin-bottom: 18px;
}
.park-title { font-size: 24px; font-weight: 800; letter-spacing: .3px; }
.park-sub { font-size: 13px; color: var(--ink-soft); font-weight: 600; max-width: 470px; margin-top: 2px; }
.park-coins { display: flex; gap: 8px; flex-wrap: wrap; }
.coin-pill {
  background: var(--glass-strong);
  border: 1.5px solid rgba(255, 255, 255, .9);
  border-radius: 999px; padding: 7px 15px;
  font-size: 13px; font-weight: 800;
  box-shadow: var(--shadow-sm);
}

/* 领养卡片 */
.p-card.add { border-style: dashed; border-color: rgba(255, 159, 90, .55); }
.p-card.add .p-name { font-size: 11px; line-height: 1.35; white-space: normal; }

/* 状态条 */
.ps-ico { font-size: 14px; }
.ps-label { min-width: 46px; color: var(--ink-soft); }

/* ═══════════ 领养 / 上传弹窗 ═══════════ */
.adopt-mask {
  position: fixed; inset: 0; z-index: 2000;
  display: flex; align-items: center; justify-content: center;
  background: rgba(60, 40, 20, .42);
  backdrop-filter: blur(3px);
  padding: 16px;
}
.adopt-modal {
  background: #fffdfa; border-radius: 24px; padding: 24px;
  width: min(94vw, 560px); max-height: 88vh; overflow: auto;
  box-shadow: 0 24px 60px rgba(80, 50, 20, .3);
}
.adopt-modal h3 { font-size: 17px; margin-bottom: 14px; text-align: center; font-weight: 800; }
.adopt-row { display: flex; justify-content: center; margin-top: 14px; }
.adopt-msg { font-size: 12.5px; font-weight: 700; color: var(--accent-deep); margin-top: 12px; text-align: center; }

.custom-up { display: flex; align-items: center; gap: 14px; margin-top: 10px; }
.custom-preview {
  width: 96px; height: 96px; object-fit: contain;
  border-radius: 16px; background: #fff;
  border: 2px solid var(--accent-soft);
  box-shadow: var(--shadow-sm);
}

@media (max-width: 560px) {
  .park-title { font-size: 20px; }
  .ps-label { min-width: 38px; }
}
</style>
