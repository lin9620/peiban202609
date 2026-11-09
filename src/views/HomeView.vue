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
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick, defineAsyncComponent, onActivated } from "vue";
import { useRoute, useRouter } from "vue-router";
import { t } from "../i18n.js";
import { restoreScroll } from "../utils/scrollMem.js";
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
/* 轮 482：每个联自己的滚动位置（见 setPane 注释）。
   轮488：恢复不再是「一帧就落」——改成待办 pendingY，等文档长够再落（见 restorePaneY）。 */
const paneScroll = new Map();
let pendingY = null;      /* 要回到的 y；null = 没有待办 */
let pendingUntil = 0;     /* 兜底截止：超时也照落（取文档能给的最大值），不无限等 */

/* /?tab=xxx 变化（＋ 钮投瓶 / 深链）→ 切联；桌面忽略（不消费 query） */
onActivated(() => {
  /* 轮 219：页签回位。
     轮488：回来那一瞬间文档可能还没长回原高度（KeepAlive 重插 + track 还没量），
     一次性 scrollTo 会被钳掉 —— 把 y 也挂成待办，让 measure()/随后几帧补落。 */
  const y = restoreScroll(route.path);
  if (y) {
    pendingY = y;
    pendingUntil = Date.now() + 600;
    pumpRestore();
  }
});

watch(() => route.query.tab, (v) => {
  /* 轮 235 修（真机实测抓到的 URL 污染）：
     从这里点故事卡去 /story/:id 时，route.query.tab 会从 "story" 变成 **undefined**，
     而 paneFromQuery(undefined) 会回退成 DEFAULT_PANE("today") —— 于是本 watch 在**离开首页之后**
     仍然触发 setPane("today")，把目标页的 URL replace 成 /story/2?tab=today（tab 被今天的默认联污染）。
     首页被 KeepAlive 保活、watch 一直活着，所以离开后照样会打这一枪。
     两道门：① 已经不在首页 → 不碰任何 URL；② tab 被移除了 ≠ 切到默认联 → 什么都不做。 */
  if (!isMobileNav.value) return;
  if (route.path !== "/") return;
  if (v == null) return;
  setPane(paneFromQuery(v), false);
});

function setPane(k, scroll = true) {
  if (k === "pet") petMounted.value = true;
  if (k === "story") storyMounted.value = true;
  if (pane.value === k) return;
  /* 轮 482（用户：「点故事阅读了，再点今日，然后再点故事，直接回故事最前面了」）：
   * 四个联共用同一个 window 滚动条（.home3 是 overflow:clip，不建滚动容器），
   * 旧实现切联时无脑 window.scrollTo(0,0) —— 从故事联切去今日就把故事的滚动位置
   * 一起抹掉了，切回来自然在顶上。改成**每个联各记各的**：切走时存当前 y，
   * 切回来后恢复（等 track 高度撑回该联的高度，否则 scrollTo 会被还没长高的文档钳住）。 */
  if (scroll) {
    paneScroll.set(pane.value, window.scrollY);
    pendingY = paneScroll.get(k) ?? 0;
    pendingUntil = Date.now() + 600;
  }
  pane.value = k;
  /* 轮 152：联位置同步进地址栏（replaceState 不堆历史）——否则从故事联进 /story/mine
     再返回时，首页按默认联重建 = 「返回跑到今日/漂流瓶」（用户实测）。 */
  if (isMobileNav.value) {
    const q = { ...route.query, tab: k };
    router.replace({ query: q }).catch(() => {});
  }
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
  /* 轮488：手指一落下就放弃待恢复的位置 —— 回位在这 0.6s 里是慢慢补的，
     用户这时候自己往下滑，绝不能再把他拽回去（不跟用户抢滚动）。 */
  pendingY = null;
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
  if (el) {
    const h = el.offsetHeight;
    /* 轮488：h === 0 = 这一刻还没布局（KeepAlive 把 DOM 从隐藏容器搬回来、切联过渡的
       那一瞬都会读到 0）。**绝不能**在这时把 track 压成 120px —— 文档会当场塌到几百像素，
       浏览器顺手把滚动位置钳到 0，回位也就白做了（真机取证：从故事阅读页返回，位置变 0，
       文档高 2734 → 1889，就是这一塌）。0 直接跳过，等 ResizeObserver 拿到真高度再写。 */
    if (h > 0) trackH.value = Math.max(120, Math.round(h)) + "px";
  }
  /* 轮488：ResizeObserver 也会走到这里 —— 文档一长高就把待恢复的位置补上 */
  restorePaneY();
}

/* ═══ 轮488 · 切联回位：等文档长够再落 ═══
 * 真机取证（无头 Edge 390×844，首页故事联）：停在 700 → 点今日 → 点故事，回来只到 **325**。
 * 原因：nextTick + 一帧 rAF 时 track 高度还是上一个联的（比故事联矮），
 *   scrollTo(700) 被文档高度钳成 325；之后 track 长高了，却再没有人补这一枪。
 * 现在把「要去的 y」留成待办 pendingY：measure()（含 ResizeObserver 回调）与随后几帧都会
 * 再落一次，直到文档高度够 / 或 600ms 兜底到期（到期就取文档能给的最大值，绝不无限等）。 */
function restorePaneY(force = false) {
  if (pendingY == null) return;
  const doc = document.scrollingElement || document.documentElement;
  const max = Math.max(0, (doc && doc.scrollHeight ? doc.scrollHeight : 0) - window.innerHeight);
  const y = pendingY;
  if (!force && max < y - 1 && Date.now() < pendingUntil) return;   /* 还没长够：等下一拍 */
  pendingY = null;
  const top = Math.max(0, Math.min(y, max));
  try { window.scrollTo({ top, left: 0, behavior: "instant" }); } catch (e) { window.scrollTo(0, top); }
}
function pumpRestore() {
  if (pendingY == null) return;
  requestAnimationFrame(() => {
    measure();
    restorePaneY();
    if (pendingY == null) return;
    /* 关键（实测）：.home-track 的高度是带 CSS 过渡的，切联后文档是**慢慢长高**的
       （1889px 要走 ~320ms：1404 → 1654 → 1787 → 1889）。所以不能只补 6 帧就收手 ——
       那 6 帧里文档还没长够，之后没人再落，人就被留在原地看着「回到最前面」。
       改成按截止时间一直补，到期强制落（取文档能给的最大值）。 */
    if (Date.now() < pendingUntil) pumpRestore();
    else restorePaneY(true);
  });
}
watch(idx, async () => {
  await nextTick();
  measure();
  restorePaneY();
  pumpRestore();
});
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
