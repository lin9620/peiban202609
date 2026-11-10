<!-- 轮 131 · 石头剪刀布 vs 宠物（清单 #20）——纯前端小游戏
 * 宠物按性格加权出拳（rpsRules.PET_MOVE_WEIGHTS：高冷爱出石头）；
 * 赢 +2 / 平 +1 金币（与「陪它玩」同档），每日前 10 局有彩头（防刷）；
 * 玩一局计入「陪它玩一次」任务（markTask("play")，petStore 同一本账）。
 * 入口已从宠物页内联大卡片改成「小游戏」弹层，和零食雨并排，页面不再被拉长。 -->
<script setup>
import { ref, computed, onBeforeUnmount } from "vue";
import { t } from "../i18n.js";
import { activePet, wallet, say, markTask, petStore } from "../stores/petStore.js";
import { todayKey } from "../utils/daily.js";
import { getItem, setItem } from "../utils/storage.js";
import { petMove, judge, coinFor, canPlay, RPS_MOVES, RPS_DAILY_MAX } from "../utils/rpsRules.js";

const emit = defineEmits(["close"]);

const HAND_EMOJI = { rock: "✊", scissors: "✌️", paper: "✋" };

const playsKey = "wp-rps-" + todayKey();
const plays = ref(Number(getItem(playsKey)) || 0);
const myHand = ref("");
const petHand = ref("");
const outcome = ref("");       /* win / lose / draw */
const busy = ref(false);
const earned = ref(0);         /* 本局金币（展示用） */

const limited = computed(() => !canPlay(plays.value));
const petKey = computed(() => (activePet.value && activePet.value.personality) || "");
const progress = computed(() => Math.min(100, (plays.value / RPS_DAILY_MAX) * 100));

let resetTimer = 0;

function pick(move) {
  if (busy.value || !activePet.value) return;
  if (!canPlay(plays.value)) { say(t("rps.limit", { n: plays.value })); return; }
  busy.value = true;
  myHand.value = move;
  petHand.value = petMove(petKey.value);
  outcome.value = judge(move, petHand.value);
  const coin = coinFor(outcome.value);
  if (coin > 0) {
    wallet.coins += coin;
    earned.value = coin;
  } else {
    earned.value = 0;
  }
  markTask("play");                    /* 玩一局 = 陪它玩一次（同一本任务账） */
  petStore.save();
  plays.value += 1;
  setItem(playsKey, String(plays.value));
  say(t(outcome.value === "win" ? "rps.sayLose" : outcome.value === "lose" ? "rps.sayWin" : "rps.sayDraw"));
  resetTimer = setTimeout(() => { busy.value = false; }, 350);   /* icon-swap 动画窗 */
}

onBeforeUnmount(() => clearTimeout(resetTimer));
</script>

<template>
  <div class="rps-overlay" @click.self="emit('close')">
    <section class="rps-card" role="dialog" aria-modal="true" :aria-label="t('rps.title')">
      <div class="rps-head">
        <div class="rps-head-copy">
          <h2>{{ t("rps.title") }}</h2>
          <p class="rps-sub">{{ limited ? t("rps.limit", { n: plays }) : t("rps.hint", { max: RPS_DAILY_MAX }) }}</p>
        </div>
        <button
          class="rps-x" type="button" :title="t('common.close')" :aria-label="t('common.close')"
          @click="emit('close')">✕</button>
      </div>

      <div class="rps-meter">
        <div class="rps-meter-top">
          <span>{{ t("rps.plays", { n: plays, max: RPS_DAILY_MAX }) }}</span>
          <span class="rps-meter-paw">🐾</span>
        </div>
        <div class="rps-track"><i :style="{ width: progress + '%' }"></i></div>
      </div>

      <div class="rps-arena">
        <div class="rps-side">
          <span class="rps-face">{{ (activePet && activePet.name) || "🐾" }}</span>
          <span
            v-if="petHand" :key="petHand + outcome"
            class="rps-hand t-icon-swap">{{ HAND_EMOJI[petHand] }}</span>
          <span v-else class="rps-hand rps-idle">🐾</span>
        </div>
        <div class="rps-mid">
          <span v-if="outcome" class="rps-result" :class="'rps-' + outcome">{{ t("rps." + outcome) }}</span>
          <span v-else class="rps-vs">VS</span>
          <span v-if="earned > 0" :key="earned" class="t-num-pop rps-coin">+{{ earned }} 💰</span>
        </div>
        <div class="rps-side">
          <span class="rps-face">{{ t("rps.you") }}</span>
          <span
            v-if="myHand" :key="myHand"
            class="rps-hand t-icon-swap">{{ HAND_EMOJI[myHand] }}</span>
          <span v-else class="rps-hand rps-idle">❔</span>
        </div>
      </div>

      <div class="rps-btns">
        <button
          v-for="m in RPS_MOVES" :key="m"
          class="rps-btn" :disabled="busy || limited"
          :class="{ picked: myHand === m }" @click="pick(m)">
          <span class="rps-btn-ico">{{ HAND_EMOJI[m] }}</span>
          <span>{{ t("rps." + m) }}</span>
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.rps-overlay {
  position: fixed; inset: 0; z-index: 90;
  display: flex; align-items: center; justify-content: center;
  padding: 18px; touch-action: none; overscroll-behavior: contain;
  background: rgba(38, 30, 22, .55);
  /* 轮 502：iOS 17 及以下的 Safari 只认带 -webkit- 的写法，裸 backdrop-filter 被整条丢掉，
     遮罩就退成一层实心棕（底下的场景全看不见）。两条并列：能认哪条用哪条，
     都不认还有上面的 background 兜住，不会有中间态。 */
  -webkit-backdrop-filter: blur(7px);
  backdrop-filter: blur(7px);
  font-family: inherit;
}
.rps-card {
  width: min(100%, 430px); max-height: min(92vh, 680px); overflow: auto;
  touch-action: pan-y;
  padding: 20px 20px 18px;
  background: var(--glass-strong, #fff); color: var(--ink, #4a3b2f);
  border: 1px solid rgba(255, 255, 255, .5); border-radius: 28px;
  box-shadow: 0 24px 70px rgba(30, 20, 10, .38);
  animation: rpsIn .22s var(--like-ease, ease-out);
}
@keyframes rpsIn { from { opacity: 0; transform: translateY(12px) scale(.97); } }

.rps-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.rps-head-copy { min-width: 0; }
.rps-head h2 { margin: 0; font-size: 20px; font-weight: 700; line-height: 1.25; }
.rps-sub { margin: 5px 0 0; font-size: 12.5px; font-weight: 500; line-height: 1.5; color: var(--ink-soft); }
.rps-x {
  flex: none; width: 34px; height: 34px; border: 0; border-radius: 50%;
  background: var(--wash-strong); color: var(--ink); font-size: 16px; cursor: pointer;
  box-shadow: var(--shadow-sm);
}

.rps-meter { margin: 14px 0 4px; padding: 10px 12px; border-radius: 16px; background: var(--accent-soft); }
.rps-meter-top { display: flex; align-items: center; justify-content: space-between; font-size: 12px; font-weight: 600; color: var(--ink-soft); }
.rps-meter-paw { font-size: 14px; opacity: .8; }
.rps-track { height: 7px; margin-top: 7px; border-radius: 999px; background: rgba(120, 100, 80, .16); overflow: hidden; }
.rps-track i {
  display: block; height: 100%; border-radius: inherit;
  background: linear-gradient(90deg, var(--accent), var(--accent-deep));
  transition: width .3s ease;
}

.rps-arena { display: flex; align-items: center; justify-content: space-between; margin: 16px 0 14px; gap: 8px; }
.rps-side { display: flex; flex-direction: column; align-items: center; gap: 6px; min-width: 68px; }
.rps-face {
  max-width: 92px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 11px; font-weight: 600; color: var(--ink-soft);
}
.rps-hand {
  font-size: 44px; line-height: 1; width: 72px; height: 72px;
  display: flex; align-items: center; justify-content: center;
  background: var(--wash-strong); border: 1px solid var(--hairline); border-radius: 20px;
  box-shadow: var(--shadow-sm);
}
.rps-idle { opacity: .5; }
/* icon-swap（transitions/icon-swap.md）：换图标 = 缩放 + 模糊浮现 */
.t-icon-swap { animation: t-icon-swap .32s var(--like-ease); }
@keyframes t-icon-swap {
  from { transform: scale(1.45) rotate(6deg); filter: blur(6px); opacity: .2; }
  to { transform: scale(1) rotate(0); filter: blur(0); opacity: 1; }
}
.rps-mid { display: flex; flex-direction: column; align-items: center; gap: 5px; min-width: 72px; }
.rps-result { font-size: 14px; font-weight: 700; color: var(--ink); text-align: center; }
.rps-win { color: var(--good); }
.rps-lose { color: var(--low); }
.rps-draw { color: var(--ink-soft); }
.rps-vs { font-size: 12px; font-weight: 700; letter-spacing: .12em; color: var(--ink-faint); }
.rps-coin { font-size: 12px; font-weight: 600; color: var(--accent-deep); }
.rps-btns { display: flex; gap: 8px; }
.rps-btn {
  flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px;
  font-family: inherit; font-size: 11.5px; font-weight: 600; color: var(--ink-soft);
  background: var(--accent-soft); border: 1px solid var(--hairline);
  border-radius: 16px; padding: 11px 4px; cursor: pointer;
  transition: transform .15s var(--like-ease), border-color .15s ease;
}
.rps-btn-ico { font-size: 28px; line-height: 1.1; }
.rps-btn:hover:not(:disabled) { border-color: var(--accent); transform: translateY(-2px); }
.rps-btn:active:not(:disabled) { transform: scale(.95); }
.rps-btn.picked { border-color: var(--accent); color: var(--ink); }
.rps-btn:disabled { opacity: .5; cursor: default; }

@media (max-width: 380px) {
  .rps-overlay { padding: 10px; }
  .rps-card { padding: 18px 16px 16px; border-radius: 24px; }
  .rps-hand { width: 64px; height: 64px; font-size: 38px; }
  .rps-side { min-width: 60px; }
  .rps-mid { min-width: 62px; }
}
@media (prefers-reduced-motion: reduce) {
  .rps-card, .t-icon-swap, .rps-btn:hover:not(:disabled), .rps-btn:active:not(:disabled) {
    animation: none !important; transform: none !important;
  }
}
</style>
