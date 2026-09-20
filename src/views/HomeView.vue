<!-- 首页（/）
 * ------------------------------------------------------------
 * 桌面（≥900px）：「今日的暖爪」+ 漂流瓶 上下排列 —— 原 HomeView 布局零变化（抽件后拼回）。
 * 手机 / App（T6 三联容器）：顶部频道条（今日 · 漂流瓶 · 宠物）+ 横滑三联，默认「漂流瓶」；
 *   TabBar ＋ 钮「投漂流瓶」跳 /?tab=bottle → 这里消费成初始联；宠物联禁滑动穿透（画板/零食雨手势优先）。
-->
<script setup>
import { ref, computed, watch, defineAsyncComponent } from "vue";
import { useRoute, useRouter } from "vue-router";
import { t } from "../i18n.js";
import { isMobileNav } from "../stores/uiStore.js";
import { HOME_PANES, paneFromQuery, paneIndex, swipeDir } from "../utils/panes.js";
import TodayPane from "../components/TodayPane.vue";
import BottleView from "../components/BottleView.vue";

/* 宠物联懒挂载：PetView 是重件（Lottie / 画板 / 零食雨），首次切到宠物联才拉 chunk，
 * 挂过就保留不卸载（避免来回切反复重建动画状态）。 */
const PetView = defineAsyncComponent(() => import("./PetView.vue"));

const route = useRoute();
const router = useRouter();

const pane = ref(paneFromQuery(route.query.tab));
const idx = computed(() => paneIndex(pane.value));
const petMounted = ref(pane.value === "pet");

/* /?tab=xxx 变化（＋ 钮投瓶 / 深链）→ 切联；桌面忽略（不消费 query） */
watch(() => route.query.tab, (v) => {
  if (isMobileNav.value) setPane(paneFromQuery(v), false);
});

function setPane(k, scroll = true) {
  if (k === "pet") petMounted.value = true;
  if (pane.value === k) return;
  pane.value = k;
  if (scroll) window.scrollTo(0, 0);
}

/* hero 的「去宠物」：手机 → 切宠物联；桌面 → 跳 /pet 路由（原行为） */
function goPet() {
  if (isMobileNav.value) setPane("pet");
  else router.push("/pet");
}

/* 横滑手势：先辨轴（纵向让位页面滚动），横向达阈值才切联；
 * 宠物联整段禁用滑动穿透 —— 画板 / 零食雨的手势优先（D3），切联走频道条。 */
let sx = 0, sy = 0, swiping = false, axis = "";
function onTouchStart(e) {
  if (pane.value === "pet") return;
  const t0 = e.touches[0];
  sx = t0.clientX; sy = t0.clientY; swiping = true; axis = "";
}
function onTouchMove(e) {
  if (!swiping) return;
  const t0 = e.touches[0];
  const dx = t0.clientX - sx, dy = t0.clientY - sy;
  if (!axis && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
    axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
    if (axis === "y") swiping = false;   /* 纵向 → 交还页面滚动 */
  }
}
function onTouchEnd(e) {
  if (!swiping) return;
  swiping = false;
  if (axis !== "x") return;
  const t0 = e.changedTouches[0];
  const dir = swipeDir(t0.clientX - sx, 0);
  if (dir === 1 && idx.value < HOME_PANES.length - 1) setPane(HOME_PANES[idx.value + 1].k);
  else if (dir === -1 && idx.value > 0) setPane(HOME_PANES[idx.value - 1].k);
}
</script>

<template>
  <!-- 桌面：原首页布局零变化（今日联 + 漂流瓶联 顺序拼回） -->
  <div v-if="!isMobileNav">
    <TodayPane @go-pet="goPet" />
    <BottleView />
  </div>

  <!-- 手机 / App：频道条 + 三联横滑 -->
  <div v-else class="home3">
    <div class="home-chips" role="tablist">
      <button
        v-for="p in HOME_PANES" :key="p.k" type="button" role="tab"
        class="home-chip" :class="{ on: pane === p.k }"
        :aria-selected="pane === p.k"
        @click="setPane(p.k)">
        {{ t(p.tk) }}
      </button>
    </div>

    <div
      class="home-track"
      :style="{ transform: 'translateX(' + idx * -100 + '%)' }"
      @touchstart.passive="onTouchStart"
      @touchmove.passive="onTouchMove"
      @touchend.passive="onTouchEnd">
      <div class="home-pane"><TodayPane @go-pet="goPet" /></div>
      <div class="home-pane"><BottleView /></div>
      <div class="home-pane home-pane--pet">
        <PetView v-if="petMounted" />
        <div v-else class="home-pane-lazy"><span>🐾</span></div>
      </div>
    </div>
  </div>
</template>
