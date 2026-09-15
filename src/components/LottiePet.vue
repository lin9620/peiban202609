<script setup>
/**
 * Lottie 宠物渲染器
 * - 预设宠物：用 src/utils/lottiePet.js 生成的 Lottie 动画（会呼吸/眨眼/摇尾/抖耳朵）
 * - 若 src/data/lottieAssets.js 登记了真实素材，则优先使用素材
 * - 睡觉状态自动切换到 sleep 变体（闭眼 + 缓慢呼吸）
 */
import { ref, onMounted, onBeforeUnmount, watch } from "vue";
import lottie from "lottie-web";
import { petAnimation } from "../utils/lottiePet.js";
import lottieAssets from "../data/lottieAssets.js";

const props = defineProps({
  species: { type: String, required: true },
  sleeping: { type: Boolean, default: false },
});

const host = ref(null);
let anim = null; // 非响应式，避免 Vue 代理 lottie 实例

function animationData() {
  return lottieAssets[props.species] || petAnimation(props.species, props.sleeping ? "sleep" : "idle");
}

function destroy() {
  if (anim) { anim.destroy(); anim = null; }
}

function mount() {
  destroy();
  if (!host.value) return;
  let data = null;
  try {
    data = animationData();
  } catch (e) {
    console.warn("[Warm Paws] 生成宠物动画失败：", e);
    return;
  }
  if (!data) return;
  try {
    anim = lottie.loadAnimation({
      container: host.value,
      renderer: "svg",
      loop: true,
      autoplay: true,
      animationData: data,
      rendererSettings: { progressiveLoad: false, preserveAspectRatio: "xMidYMid meet" },
    });
  } catch (e) {
    console.warn("[Warm Paws] Lottie 渲染失败，已降级为静态显示：", e);
    anim = null;
  }
}

onMounted(mount);
watch(() => [props.species, props.sleeping], mount);
onBeforeUnmount(destroy);
</script>

<template>
  <div ref="host" class="lottie-pet"></div>
</template>

<style>
.lottie-pet { width: 100%; line-height: 0; }
.lottie-pet svg { width: 100%; height: auto; display: block; overflow: visible; }
</style>