<!-- 轮 131 · 石头剪刀布 vs 宠物（清单 #20）——纯前端小游戏
 * 宠物按性格加权出拳（rpsRules.PET_MOVE_WEIGHTS：高冷爱出石头）；
 * 赢 +2 / 平 +1 金币（与「陪它玩」同档），每日前 10 局有彩头（防刷）；
 * 玩一局计入「陪它玩一次」任务（markTask("play")，petStore 同一本账）。
 * 出拳/结果用 transitions/icon-swap（缩放+模糊换图标）。 -->
<script setup>
import { ref, computed } from "vue";
import { t } from "../i18n.js";
import { activePet, wallet, say, markTask, petStore } from "../stores/petStore.js";
import { todayKey } from "../utils/daily.js";
import { getItem, setItem } from "../utils/storage.js";
import { petMove, judge, coinFor, canPlay, RPS_MOVES, RPS_DAILY_MAX } from "../utils/rpsRules.js";

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
  setTimeout(() => { busy.value = false; }, 350);   /* icon-swap 动画窗 */
}
</script>

<template>
  <section class="card rps">
    <div class="row-between">
      <h2>{{ t("rps.title") }}</h2>
      <span class="rps-plays">{{ t("rps.plays", { n: plays, max: RPS_DAILY_MAX }) }}</span>
    </div>
    <p class="sub">{{ limited ? t("rps.limit", { n: plays }) : t("rps.hint") }}</p>

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
</template>

<style>
.rps { margin-top: 14px; }
.rps-plays { font-size: 11px; color: var(--ink-faint); font-weight: 500; }
.rps-arena {
  display: flex; align-items: center; justify-content: space-between;
  margin: 12px 0 10px; gap: 8px;
}
.rps-side { display: flex; flex-direction: column; align-items: center; gap: 6px; min-width: 64px; }
.rps-face { font-size: 11px; font-weight: 500; color: var(--ink-soft); }
.rps-hand {
  font-size: 40px; line-height: 1; width: 64px; height: 64px;
  display: flex; align-items: center; justify-content: center;
  background: #fff; border-radius: 16px; box-shadow: var(--shadow-sm);
}
.rps-idle { opacity: .5; }
/* icon-swap（transitions/icon-swap.md）：换图标 = 缩放 + 模糊浮现 */
.t-icon-swap { animation: t-icon-swap .32s var(--like-ease); }
@keyframes t-icon-swap { from { transform: scale(1.45) rotate(6deg); filter: blur(6px); opacity: .2; } to { transform: scale(1) rotate(0); filter: blur(0); opacity: 1; } }
.rps-mid { display: flex; flex-direction: column; align-items: center; gap: 5px; min-width: 72px; }
.rps-result { font-size: 14px; font-weight: 500; color: var(--ink); }
.rps-win { color: var(--good); }
.rps-lose { color: var(--low); }
.rps-draw { color: var(--ink-soft); }
.rps-coin { font-size: 12px; font-weight: 500; color: var(--accent-deep); }
.rps-btns { display: flex; gap: 8px; }
.rps-btn {
  flex: 1; display: flex; flex-direction: column; align-items: center; gap: 3px;
  font-family: inherit; font-size: 11.5px; font-weight: 500; color: var(--ink-soft);
  background: var(--accent-soft); border: 1px solid var(--hairline);
  border-radius: 12px; padding: 9px 4px; cursor: pointer;
  transition: transform .15s var(--like-ease), border-color .15s ease;
}
.rps-btn-ico { font-size: 24px; line-height: 1.1; }
.rps-btn:hover:not(:disabled) { border-color: var(--accent); transform: translateY(-2px); }
.rps-btn:active:not(:disabled) { transform: scale(.95); }
.rps-btn.picked { border-color: var(--accent); color: var(--ink); }
.rps-btn:disabled { opacity: .5; cursor: default; }
@media (prefers-reduced-motion: reduce) {
  .t-icon-swap, .rps-btn:hover:not(:disabled), .rps-btn:active:not(:disabled) { animation: none !important; transform: none !important; }
}
</style>
