<script setup>
/* 零食雨：宠物张嘴接住从天而降的食物（优先你亲手画的料理） */
import { ref, computed, onBeforeUnmount, onMounted } from "vue";
import { t } from "../i18n.js";
import { SPECIES } from "../data/pets.js";
import { activePet, cookbook, applySnackRain } from "../stores/petStore.js";
import { getItem, setItem } from "../utils/storage.js";
import {
  GAME_SECONDS, MAX_MISSED, difficulty, spawnItem, advanceY,
  isCaught, isMissed,
} from "../utils/snackGame.js";

const emit = defineEmits(["close"]);

const BEST_KEY = "wp-snackrain-best";
const PET_HALF_W = 0.085;   // 接住判定的宠物半宽（比例）

/* 阶段机：idle 说明 → playing 游戏中 → over 结算 */
const phase = ref("idle");
const score = ref(0);
const missed = ref(0);
const left = ref(GAME_SECONDS);
const best = ref(Number(getItem(BEST_KEY)) || 0);
const newBest = ref(false);
const reward = ref(null);

/* 宠物形象：自定义立绘 > 物种 emoji */
const petImg = computed(() => (activePet.value && activePet.value.custom && activePet.value.custom.img) || "");
const petFace = computed(() => {
  const p = activePet.value;
  const s = p && SPECIES.find((x) => x.key === p.species);
  return (s && s.emoji) || "\u{1F43E}";
});

/* 运行时状态 */
const items = ref([]);
const petX = ref(0.5);
const fx = ref([]);
const happy = ref(0);
const dishCount = ref(0);

let raf = 0, last = 0, spawnAcc = 0, elapsed = 0, fxId = 0;
let keyL = false, keyR = false;
let dishPool = [];

function onKey(e) {
  const on = e.type === "keydown";
  if (e.key === "ArrowLeft" || e.key === "a" || e.key === "A") keyL = on;
  if (e.key === "ArrowRight" || e.key === "d" || e.key === "D") keyR = on;
}

function onMove(e) {
  if (phase.value !== "playing") return;
  const el = e.currentTarget;
  if (!el || !el.getBoundingClientRect) return;
  const rect = el.getBoundingClientRect();
  if (!rect.width) return;
  petX.value = Math.min(0.94, Math.max(0.06, (e.clientX - rect.left) / rect.width));
}

function loop(ts) {
  if (phase.value !== "playing") return;
  if (!last) last = ts;
  const dt = Math.min(0.05, (ts - last) / 1000);
  last = ts;
  elapsed += dt;
  left.value = Math.max(0, GAME_SECONDS - elapsed);

  if (keyL) petX.value = Math.max(0.06, petX.value - dt * 0.95);
  if (keyR) petX.value = Math.min(0.94, petX.value + dt * 0.95);

  spawnAcc += dt;
  let iv = difficulty(elapsed);
  while (spawnAcc >= iv) {
    spawnAcc -= iv;
    items.value.push(spawnItem(Math.random, elapsed, dishPool.length, dishPool));
  }

  const keep = [];
  for (const it of items.value) {
    it.y = advanceY(it, dt);
    if (isCaught(it, petX.value, PET_HALF_W)) {
      score.value += it.value;
      happy.value++;
      const fid = "f" + fxId++;
      fx.value.push({ id: fid, x: it.x, text: "+" + it.value });
      setTimeout(() => { fx.value = fx.value.filter((f) => f.id !== fid); }, 700);
    } else if (isMissed(it)) {
      missed.value++;
    } else {
      keep.push(it);
    }
  }
  items.value = keep;

  if (missed.value >= MAX_MISSED || elapsed >= GAME_SECONDS) { finish(); return; }
  raf = requestAnimationFrame(loop);
}

function cleanup() {
  cancelAnimationFrame(raf);
  window.removeEventListener("keydown", onKey);
  window.removeEventListener("keyup", onKey);
}

function onStart() {
  cleanup();
  dishPool = cookbook.filter((d) => d && d.img).slice(0, 12);
  dishCount.value = dishPool.length;
  items.value = []; fx.value = [];
  score.value = 0; missed.value = 0; elapsed = 0; spawnAcc = 0; last = 0;
  left.value = GAME_SECONDS; newBest.value = false; reward.value = null;
  phase.value = "playing";
  window.addEventListener("keydown", onKey);
  window.addEventListener("keyup", onKey);
  raf = requestAnimationFrame(loop);
}

function finish() {
  cleanup();
  phase.value = "over";
  items.value = [];
  reward.value = applySnackRain(score.value);
  if (score.value > best.value) {
    best.value = score.value; newBest.value = true;
    try { setItem(BEST_KEY, String(best.value)); } catch (e) {}
  }
}

onBeforeUnmount(cleanup);

/* 进入时先算出手绘料理数量，说明页的提示才准确 */
onMounted(() => {
  dishPool = cookbook.filter((d) => d && d.img).slice(0, 12);
  dishCount.value = dishPool.length;
});

/* —— 内联样式助手 —— */
const itemStyle = (it) => ({ left: (it.x * 100) + "%", top: (Math.max(0, it.y) * 100) + "%" });
</script>

<template>
  <div class="sr-overlay">
    <div class="sr-top">
      <span class="sr-chip">⭐ {{ score }}</span>
      <span class="sr-chip">⏱ {{ Math.ceil(left) }}s</span>
      <span class="sr-chip" :class="{ bad: missed >= MAX_MISSED - 2 }">💔 {{ missed }}/{{ MAX_MISSED }}</span>
      <button class="sr-x" :title="t('common.close')" @click="emit('close')">✕</button>
    </div>

    <!-- 开始说明 -->
    <div v-if="phase === 'idle'" class="sr-card">
      <h2>{{ t("pet.snack.title") }}</h2>
      <p class="sr-sub">{{ t("pet.snack.howto") }}</p>
      <p class="sr-hint">
        {{ dishCount > 0 ? t("pet.snack.hasDish", { n: dishCount }) : t("pet.snack.noDish") }}
      </p>
      <button class="sr-btn" @click="onStart">{{ t("pet.snack.start") }}</button>
      <p class="sr-best">🏆 {{ t("pet.snack.best") }}: {{ best }}</p>
    </div>

    <!-- 游戏中 -->
    <div
      v-else-if="phase === 'playing'"
      class="sr-arena"
      @pointermove="onMove" @pointerdown="onMove">
      <div v-for="it in items" :key="it.id" class="sr-item" :style="itemStyle(it)">
        <img v-if="it.kind === 'dish' && it.img" :src="it.img" alt="" draggable="false" />
        <span v-else>{{ it.emoji }}</span>
      </div>
      <div v-for="f in fx" :key="f.id" class="sr-fx" :style="{ left: (f.x * 100) + '%' }">{{ f.text }}</div>
      <div :key="happy" class="sr-pet bounce" :style="{ left: (petX * 100) + '%' }">
        <img v-if="petImg" :src="petImg" alt="" draggable="false" />
        <span v-else>{{ petFace }}</span>
      </div>
    </div>

    <!-- 结算 -->
    <div v-else class="sr-card">
      <h2>{{ t("pet.snack.over") }}</h2>
      <p class="sr-score">⭐ {{ score }}</p>
      <p v-if="newBest" class="sr-newbest">🎉 {{ t("pet.snack.newBest") }}</p>
      <ul class="sr-reward">
        <li>💰 +{{ (reward && reward.coins) || 0 }}</li>
        <li>🍖 +{{ (reward && reward.hunger) || 0 }}</li>
        <li>💛 +{{ (reward && reward.mood) || 0 }}</li>
        <li>✨ +{{ (reward && reward.exp) || 0 }} EXP</li>
      </ul>
      <p class="sr-best">🏆 {{ t("pet.snack.best") }}: {{ best }}</p>
      <div class="sr-row">
        <button class="sr-btn" @click="onStart">{{ t("pet.snack.again") }}</button>
        <button class="sr-btn ghost" @click="emit('close')">{{ t("common.close") }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sr-overlay {
  position: fixed; inset: 0; z-index: 90;
  background: rgba(38, 30, 22, .58); backdrop-filter: blur(7px);
  display: flex; align-items: center; justify-content: center;
  font-family: inherit;
}
.sr-top {
  position: fixed; top: 14px; left: 0; right: 0;
  display: flex; gap: 8px; justify-content: center; align-items: center;
}
.sr-chip {
  background: var(--glass-strong, #fff); color: var(--ink, #4a3b2f);
  border-radius: 999px; padding: 6px 14px; font-weight: 700;
  box-shadow: 0 4px 14px rgba(40, 28, 16, .18); font-size: 15px;
}
.sr-chip.bad { background: #fde8e8; color: #c04747; }
.sr-x {
  border: 0; cursor: pointer; background: var(--glass-strong, #fff); color: var(--ink, #4a3b2f);
  width: 34px; height: 34px; border-radius: 50%; font-size: 16px; margin-left: 6px;
  box-shadow: 0 4px 14px rgba(40, 28, 16, .18);
}
.sr-card {
  background: var(--glass-strong, #fff); color: var(--ink, #4a3b2f);
  border-radius: 24px; padding: 30px 34px; text-align: center; max-width: 420px;
  box-shadow: 0 20px 60px rgba(30, 20, 10, .35);
}
.sr-card h2 { margin: 0 0 8px; }
.sr-sub { margin: 0 0 6px; opacity: .85; line-height: 1.55; }
.sr-hint { margin: 0 0 16px; font-size: 13px; opacity: .6; }
.sr-btn {
  border: 0; cursor: pointer; border-radius: 999px; padding: 11px 30px;
  font-size: 16px; font-weight: 700; color: #fff;
  background: linear-gradient(135deg, #FF9F5A, #F0842F);
  box-shadow: 0 8px 20px rgba(240, 132, 47, .35);
}
.sr-btn.ghost { background: transparent; color: var(--ink, #4a3b2f); box-shadow: inset 0 0 0 2px rgba(120, 100, 80, .25); }
.sr-best { margin: 14px 0 0; font-size: 13px; opacity: .65; }
.sr-score { font-size: 44px; font-weight: 800; margin: 4px 0; color: #F0842F; }
.sr-newbest { color: #46A78E; font-weight: 700; margin: 0 0 6px; }
.sr-reward { list-style: none; padding: 0; margin: 8px 0 4px; display: flex; gap: 12px; justify-content: center; font-weight: 700; }
.sr-row { display: flex; gap: 10px; justify-content: center; margin-top: 16px; }

.sr-arena { position: absolute; inset: 0; touch-action: none; overflow: hidden; }
.sr-item {
  position: absolute; transform: translate(-50%, -50%);
  font-size: 34px; line-height: 1; pointer-events: none;
  filter: drop-shadow(0 4px 6px rgba(0, 0, 0, .25));
}
.sr-item img {
  width: 46px; height: 46px; object-fit: contain;
  border-radius: 12px; background: rgba(255, 255, 255, .85);
  box-shadow: 0 4px 12px rgba(0, 0, 0, .2);
}
.sr-fx {
  position: absolute; top: 80%; transform: translateX(-50%);
  font-weight: 800; font-size: 20px; color: #ffd76a;
  text-shadow: 0 2px 6px rgba(0, 0, 0, .4);
  pointer-events: none; animation: srUp .7s ease-out forwards;
}
.sr-pet {
  position: absolute; bottom: 4%; transform: translateX(-50%);
  font-size: 72px; line-height: 1; pointer-events: none;
  filter: drop-shadow(0 8px 14px rgba(0, 0, 0, .3));
}
.sr-pet img { width: 96px; height: 96px; object-fit: contain; }
.sr-pet.bounce { animation: srBounce .3s ease; }
@keyframes srBounce { 0% { transform: translateX(-50%) scale(1); } 40% { transform: translateX(-50%) scale(1.12, .9); } 100% { transform: translateX(-50%) scale(1); } }
@keyframes srUp { 0% { opacity: 1; margin-top: 0; } 100% { opacity: 0; margin-top: -56px; } }
</style>
