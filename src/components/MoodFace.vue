<!-- 心情打卡表情（轮 150）：手绘感线性脸，替掉原先的系统 emoji（🤩🙂😌🌧️😔）。
     设计取向：统一 24×24 视框、2px 圆头线条、无填充腮红，脸型/眼/嘴各按情绪区分；
     颜色交给 CSS（currentColor + --mf-accent），选中态由父级 .mood-face.is-on 提亮。
     kind: low 低落 / tired 疲惫 / calm 平静 / happy 开心 / steady 很稳 -->
<template>
  <svg class="mood-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <!-- 脸廓 -->
    <circle class="mf-ring" cx="12" cy="12" r="10.2" />

    <template v-if="kind === 'low'">
      <path class="mf-eye" d="M6.6 10.4c.8.9 1.9.9 2.7 0M14.7 10.4c.8.9 1.9.9 2.7 0" />
      <path class="mf-mouth" d="M8.6 16.4c1.1-1.5 5.7-1.5 6.8 0" />
      <path class="mf-drop" d="M18.6 6.2c.7 1.1 1.1 1.7 1.1 2.3a1.1 1.1 0 0 1-2.2 0c0-.6.4-1.2 1.1-2.3z" />
    </template>

    <template v-else-if="kind === 'tired'">
      <path class="mf-eye" d="M6.4 10.6h3.2M14.4 10.6h3.2" />
      <path class="mf-mouth" d="M9.4 16.2c.9-.9 4.3-.9 5.2 0" />
      <path class="mf-z" d="M17.4 5.2h3l-3 3.2h3" />
    </template>

    <template v-else-if="kind === 'calm'">
      <path class="mf-eye" d="M6.8 10.8c.7-.6 1.9-.6 2.6 0M14.6 10.8c.7-.6 1.9-.6 2.6 0" />
      <path class="mf-mouth" d="M9.2 15.4c1-1.1 4.6-1.1 5.6 0" />
    </template>

    <template v-else-if="kind === 'happy'">
      <path class="mf-eye" d="M6.4 11.2c.9-1.5 2.5-1.5 3.4 0M14.2 11.2c.9-1.5 2.5-1.5 3.4 0" />
      <path class="mf-mouth" d="M7.8 14.6c1.4 2.2 7 2.2 8.4 0" />
      <circle class="mf-blush" cx="6.2" cy="14.2" r="1.15" />
      <circle class="mf-blush" cx="17.8" cy="14.2" r="1.15" />
    </template>

    <template v-else>
      <path class="mf-eye" d="M7.4 11.6h.9M15.7 11.6h.9" />
      <path class="mf-mouth" d="M9.4 15.2c1-1.3 4.2-1.3 5.2 0" />
      <circle class="mf-blush" cx="6.4" cy="14" r="1" />
      <circle class="mf-blush" cx="17.6" cy="14" r="1" />
    </template>
  </svg>
</template>

<script setup>
defineProps({ kind: { type: String, required: true } });
</script>

<!-- 轮 155：脸部件样式收进组件本体（此前锁在 .mood-face 父类下，日历直接用时
     SVG 落回黑填充默认 —— 用户截图实锤黑点）。颜色走 --mf-ink + currentColor，
     选中态仍由外层 .mood-face.is-on 换变量。 -->
<style>
.mood-svg { width: 34px; height: 34px; display: block; transition: transform .18s ease; }
.mood-svg .mf-ring { fill: none; stroke: var(--mf-ink, #8d8378); stroke-width: 1.5; }
.mood-svg .mf-eye,
.mood-svg .mf-mouth { fill: none; stroke: var(--mf-ink, #8d8378); stroke-width: 1.6; stroke-linecap: round; }
.mood-svg .mf-blush { fill: #f0a9a0; opacity: .55; }
.mood-svg .mf-drop { fill: #9dc3d8; opacity: .8; }
.mood-svg .mf-z { fill: none; stroke: var(--mf-ink, #8d8378); stroke-width: 1.3; stroke-linecap: round; stroke-linejoin: round; }
</style>