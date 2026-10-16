<!-- Turnstile 人机验证挂件（轮 311 · P2）
     用法：<turnstile-gate v-model="token" :sitekey="SITEKEY" />；提交前要求 token 非空
     （登录/注册：先打 /api/turnstile/verify 再走 Auth；举报：token 随 body 透传给 Worker）。
     sitekey 未配置（空串）时整个组件不渲染 = 功能零打扰 —— 用户在 Cloudflare 面板建好
     widget 并把 VITE_TURNSTILE_SITEKEY 写进 .env 后才启用。
     widget 用显式渲染（render=explicit），失败/过期回调把 token 清空，父组件 ref.reset() 可重置。 -->
<script setup>
import { ref, onMounted } from "vue";

const props = defineProps({
  /* Cloudflare Turnstile widget 的 sitekey；空 = 不渲染（功能关闭） */
  sitekey: { type: String, default: "" },
});
const emit = defineEmits(["update:modelValue"]);

const box = ref(null);
let widgetId = null;

function reset() {
  emit("update:modelValue", "");
  try { if (window.turnstile && widgetId != null) window.turnstile.reset(widgetId); } catch (e) { /* 已销毁 */ }
}

function mountWidget() {
  if (!props.sitekey || !box.value || !window.turnstile) return;
  try {
    widgetId = window.turnstile.render(box.value, {
      sitekey: props.sitekey,
      callback: (tok) => emit("update:modelValue", tok),
      "expired-callback": () => emit("update:modelValue", ""),
      "error-callback": () => emit("update:modelValue", ""),
    });
  } catch (e) { /* widget 挂了不挡提交路径——服务端 secret 未配时本就不强制 */ }
}

onMounted(() => {
  if (!props.sitekey) return;
  if (window.turnstile) { mountWidget(); return; }
  const s = document.createElement("script");
  s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
  s.async = true;
  s.onload = mountWidget;
  s.onerror = () => { /* CDN 挂了：widget 不出现，token 恒空；配了 secret 的端会由服务端 403 拦下重试 */ };
  document.head.appendChild(s);
});

defineExpose({ reset });
</script>

<template>
  <div v-if="sitekey" ref="box" class="ts-gate"></div>
</template>

<style scoped>
.ts-gate { display: flex; justify-content: center; margin: 8px 0; }
</style>
