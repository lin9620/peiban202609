<script setup>
import { ref, computed, watch } from "vue";
import LottiePet from "./LottiePet.vue";
import { petUi } from "../stores/petStore.js";

const props = defineProps({
  pet: { type: Object, required: true },
});

/** 用户上传的二次元立绘 */
const isCustom = computed(() => !!(props.pet.custom && props.pet.custom.img));

/* 点击跳跃（CSS 驱动，兼容 Lottie 与自定义立绘） */
const hopOn = ref(false);
watch(() => petUi.happyTick, () => {
  hopOn.value = false;
  requestAnimationFrame(() => { hopOn.value = true; });
  setTimeout(() => { hopOn.value = false; }, 620);
});
</script>

<template>
  <div
    class="pet-motion"
    :class="{ sleeping: pet.sleeping, happy: hopOn, custom: isCustom }">
    <template v-if="isCustom">
      <img :src="pet.custom.img" class="custom-img" :alt="pet.name" draggable="false" />
      <div v-if="pet.sleeping" class="custom-sleep"><span>💤</span></div>
    </template>
    <LottiePet v-else :species="pet.species" :sleeping="pet.sleeping" />
  </div>
</template>

<style>
.pet-motion { position: relative; width: 100%; }

/* 睡眠提示：整体压暗一点点（眼睛由 Lottie 的 sleep 变体负责闭眼） */
.pet-motion.sleeping { filter: brightness(.94) saturate(.9); }

.pet-motion.happy { animation: petHop .6s ease; }
@keyframes petHop {
  0%, 100% { transform: translateY(0); }
  30% { transform: translateY(-26px) rotate(-3deg); }
  60% { transform: translateY(0) scale(1.03, .96); }
  80% { transform: translateY(-8px); }
}

/* —— 自定义二次元立绘 —— */
.pet-motion.custom .custom-img {
  width: 100%; max-height: 250px;
  object-fit: contain;
  filter: drop-shadow(0 10px 14px rgba(90, 60, 30, .18));
  animation: petFloat 3.4s ease-in-out infinite;
  transform-origin: 50% 90%;
  user-select: none;
}
@keyframes petFloat {
  0%, 100% { transform: translateY(0) rotate(0deg); }
  50% { transform: translateY(-9px) rotate(-1.2deg); }
}

.pet-motion.custom.happy .custom-img { animation: petWiggle .6s ease; }
@keyframes petWiggle {
  0%, 100% { transform: translateY(0) rotate(0); }
  25% { transform: translateY(-18px) rotate(-4deg) scale(1.04); }
  55% { transform: translateY(0) rotate(3deg); }
  80% { transform: translateY(-6px) rotate(-2deg); }
}

.pet-motion.custom.sleeping .custom-img {
  animation: none;
  filter: brightness(.72) saturate(.75) drop-shadow(0 10px 14px rgba(90, 60, 30, .18));
}

.custom-sleep { position: absolute; top: 6%; right: 14%; font-size: 30px; animation: petBob 1.8s ease-in-out infinite; }
@keyframes petBob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-7px); } }
</style>
