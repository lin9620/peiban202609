<!-- 首页（/）
 * ------------------------------------------------------------
 * 桌面（≥900px）：只有「今日的暖爪」（轮 140 用户要求：底部漂流瓶整块去掉 —— 漂流瓶走
 *   /bottle 独立页，左导航直达）。
 * 手机 / App（T6 三联容器）：顶部频道条（今日 · 漂流瓶 · 宠物 · 故事）+ 横滑四联，默认「今日」；
 *   TabBar ＋ 钮「投漂流瓶」跳 /?tab=bottle → 这里消费成初始联；宠物联禁滑动穿透（画板/零食雨手势优先）。
 *   轮 147：故事联紧邻漂流瓶右侧（宠物 | 今日 | 漂流瓶 | 故事），卡片点进 /story/:id，
 *   联尾两个钮分别去 /story/write（写）与 /story（全站页，含「我的」与四榜）。
-->
<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick, defineAsyncComponent } from "vue";
import { useRoute, useRouter } from "vue-router";
import { t } from "../i18n.js";
import { isMobileNav } from "../stores/uiStore.js";
import { HOME_PANES, paneFromQuery, paneIndex, swipeDir } from "../utils/panes.js";
import TodayPane from "../components/TodayPane.vue";
import BottleView from "../components/BottleView.vue";

/* 宠物联懒挂载：PetView 是重件（Lottie / 画板 / 零食雨），首次切到宠物联才拉 chunk，
 * 挂过就保留不卸载（避免来回切反复重建动画状态）。 */
const PetView = defineAsyncComponent(() => import("./PetView.vue"));

/* 故事联懒挂载：轮 147 加在漂流瓶右侧。StoryFeed 是网络件（要拉云端数据），
 * 首次切到故事联才拉 chunk，挂过就保留（同宠物联口径）。 */
const StoryPane = defineAsyncComponent(() => import("../components/story/StoryFeed.vue"));

const route = useRoute();
const router = useRouter();

const pane = ref(paneFromQuery(route.query.tab));
const idx = computed(() => paneIndex(pane.value));
const petMounted = ref(pane.value === "pet");
const storyMounted = ref(pane.value === "story");

/* /?tab=xxx 变化（＋ 钮投瓶 / 深链）→ 切联；桌面忽略（不消费 query） */
watch(() => route.query.tab, (v) => {
  if (isMobileNav.value) setPane(paneFromQuery(v), false);
});

function setPane(k, scroll = true) {
  if (k === "pet") petMounted.value = true;
  if (k === "story") storyMounted.value = true;
  if (pane.value === k) return;
  pane.value = k;
  /* 轮 152：联位置同步进地址栏（replaceState 不堆历史）——否则从故事联进 /story/mine
     再返回时，首页按默认联重建 = 「返回跑到今日/漂流瓶」（用户实测）。 */
  if (isMobileNav.value) {
    const q = { ...route.query, tab: k };
    router.replace({ query: q }).catch(() => {});
  }
  if (scroll) window.scrollTo(0, 0);
}

/* hero 的「去宠物」：手机 → 切宠物联；桌面 → 跳 /pet 路由（原行为） */
function goPet() {
  if (isMobileNav.value) setPane("pet");
  else router.push("/pet");
}

/* 横滑手势：先辨轴（纵向让位页面滚动），横向达阈值才切联。
 * 宠物联（轮 19 起在第 0 位）：画板 / 零食雨 / 按钮上的触摸不抢（手势优先），
 * 滑动边界由通用逻辑按 HOME_PANES 顺序处理（右滑→今日、到头不动）。 */
let sx = 0, sy = 0, swiping = false, axis = "", petGuard = false;
const PET_GUARD_SEL = "canvas, button, a, input, textarea, select, .sr-overlay, .painter-bar, .swatch";
function onTouchStart(e) {
  const t0 = e.touches[0];
  sx = t0.clientX; sy = t0.clientY; swiping = true; axis = "";
  petGuard = false;
  if (pane.value === "pet") {
    const el = e.target;
    petGuard = !!(el && el.closest && el.closest(PET_GUARD_SEL));
  }
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
  if (petGuard || axis !== "x") return;
  const t0 = e.changedTouches[0];
  const dir = swipeDir(t0.clientX - sx, 0);
  if (dir === 1 && idx.value < HOME_PANES.length - 1) setPane(HOME_PANES[idx.value + 1].k);
  else if (dir === -1 && idx.value > 0) setPane(HOME_PANES[idx.value - 1].k);
}

/* 轨道高度跟随当前联（手机端 5）：原来 track 高 = 最高联，矮联下方一大片空白。
 * 用 ResizeObserver 量当前联的实际高度 → 钉在 track 上，切联/内容变化都跟手。 */
const paneEls = ref([]);
const trackH = ref("");
let ro = null;
/* 轮 163：track 高度 = max(联内容高, 视口剩余高)——内容短的联（如故事）下方空白也要
   进横滑手势面，不然手指落在空白处滑不动（用户实测：故事联下方空白滑不了）。
   预留 78px 底部导航 + safe-area 与 .shell--mobile-nav main 的 padding-bottom 同源。 */
function measure() {
  /* 轮 166b：track 恢复内容高（stretch 方案撤了——长空白难看）。手势面在 home3，
     内容以下的空白照样能滑，track 高度不再需要撑屏 */
  const el = paneEls.value[idx.value];
  if (el) trackH.value = Math.max(120, Math.round(el.offsetHeight)) + "px";
}
watch(idx, async () => { await nextTick(); measure(); });
onMounted(() => {
  measure();
  if (typeof ResizeObserver !== "undefined") {
    ro = new ResizeObserver(measure);
    paneEls.value.forEach((el) => el && ro.observe(el));
  }
});
onBeforeUnmount(() => {
  if (ro) ro.disconnect();
});
</script>

<template>
  <!-- 桌面：只有今日联（轮 140 用户要求：把底部漂流瓶整块去掉 —— 漂流瓶已有独立页 /bottle，
       左导航直达；手机三联里的「漂流瓶」联保持不动） -->
  <div v-if="!isMobileNav">
    <TodayPane @go-pet="goPet" />
  </div>

  <!-- 手机 / App：频道条 + 三联横滑 -->
  <div v-else class="home3"
    @touchstart.passive="onTouchStart"
    @touchmove.passive="onTouchMove"
    @touchend.passive="onTouchEnd">
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
      :style="{ transform: 'translateX(' + idx * -100 + '%)', height: trackH }">
      <!-- 轮 19 联序：宠物 | 今日 | 漂流瓶（默认停今日：纯本地秒开，漂流瓶不吃开局延迟） -->
      <div class="home-pane home-pane--pet" :ref="(el) => (paneEls[0] = el)">
        <PetView v-if="petMounted" />
        <div v-else class="home-pane-lazy"><span>🐾</span></div>
      </div>
      <div class="home-pane" :ref="(el) => (paneEls[1] = el)"><TodayPane @go-pet="goPet" /></div>
      <div class="home-pane" :ref="(el) => (paneEls[2] = el)"><BottleView /></div>
      <!-- 轮 147：故事联（紧邻漂流瓶，左滑一格到）—发现流。
           轮 148：联尾按钮整个撤掉 —— 投稿走底部 ＋ 第三瓣，排行榜走故事页顶部操作条，
           联内本身就是发现流，再挂按钮只会多出第三处重复入口。 -->
      <div class="home-pane" :ref="(el) => (paneEls[3] = el)">
        <StoryPane v-if="storyMounted" />
        <div v-else class="home-pane-lazy"><span>📖</span></div>
      </div>
    </div>
  </div>
</template>
