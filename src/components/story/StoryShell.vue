<!-- 轮 148 · 故事页共享壳：补上「顶部四联频道条 + 横滑手势」。
 *
 * 为什么需要：/story、/story/mine、/story/rank 是独立路由，不经过 HomeView 的 .home3 容器，
 * 而频道条和手势都写死在 HomeView 里 → 用户反馈「点进相应页面后顶层四个按钮没了」「不能左滑」。
 * 与其把三页塞回首页轨道（会重开一轮数据流、状态难管），不如把这层 UI 抽出来复用。
 *
 * 交互口径与首页保持一致：
 *   - 频道条：四联全在，故事高亮；点某联 → 跳 /?tab=xxx（桌面端不渲染，与 HomeView 同口径）。
 *   - 横滑：阈值/轴向判定复用 panes.js 的 swipeDir（纯函数，已被 home-panes-test 覆盖）。
 *     故事是最后一联，左滑（往下一联）到头不动；右滑回漂流瓶。
 *     在故事页滑动 = 切回首页对应联，因为独立页与首页联是两份 DOM，只能用跳转而非平移。 -->
<script setup>
import { onMounted, onBeforeUnmount, ref } from "vue";
import { useRouter } from "vue-router";
import { t } from "../../i18n.js";
import { isMobileNav } from "../../stores/uiStore.js";
import { HOME_PANES, paneIndex, swipeDir } from "../../utils/panes.js";

const props = defineProps({ active: { type: String, default: "story" } });
const router = useRouter();

/* 故事系里 mine/rank 归到「故事」那一联高亮：它们是故事的子页，不是第五联 */
const here = ref(props.active);
const idx = () => paneIndex(here.value === "mine" || here.value === "rank" ? "story" : here.value);

function go(k) {
  here.value = k;
  if (k === "story") { router.push("/story").catch(() => {}); return; }
  router.push({ path: "/", query: { tab: k } }).catch(() => {});
}

/* ── 横滑手势：与 HomeView 同判定（纵向让位页面滚动，横向过阈值才切） ── */
let sx = 0, sy = 0, swiping = false, axis = "";
/* 卡片、输入框、按钮上的触摸不抢手势（同宠物联 PET_GUARD_SEL 的思路） */
const GUARD = "canvas, button, a, input, textarea, select";
let guard = false;

function onStart(e) {
  if (e.touches.length !== 1) { swiping = false; return; }
  const t0 = e.touches[0];
  sx = t0.clientX; sy = t0.clientY; swiping = true; axis = "";
  const el = e.target;
  guard = !!(el && el.closest && el.closest(GUARD));
}
function onMove(e) {
  if (!swiping) return;
  const t0 = e.touches[0];
  const dx = t0.clientX - sx, dy = t0.clientY - sy;
  if (!axis && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
    axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
    if (axis === "y") swiping = false;
  }
}
function onEnd(e) {
  if (!swiping) return;
  swiping = false;
  if (guard || axis !== "x") return;
  const dir = swipeDir(e.changedTouches[0].clientX - sx, 0);
  if (!dir) return;
  const i = idx();
  const target = dir === 1 ? HOME_PANES[i + 1] : HOME_PANES[i - 1];
  if (target) go(target.k);          /* 到头不动 */
}

onMounted(() => {
  window.addEventListener("touchstart", onStart, { passive: true });
  window.addEventListener("touchmove", onMove, { passive: true });
  window.addEventListener("touchend", onEnd, { passive: true });
});
onBeforeUnmount(() => {
  window.removeEventListener("touchstart", onStart);
  window.removeEventListener("touchmove", onMove);
  window.removeEventListener("touchend", onEnd);
});
</script>

<template>
  <div v-if="isMobileNav" class="story-shell">
    <div class="home-chips" role="tablist">
      <button
        v-for="p in HOME_PANES" :key="p.k" type="button" role="tab"
        class="home-chip" :class="{ on: idx() === paneIndex(p.k) }"
        :aria-selected="idx() === paneIndex(p.k)"
        @click="go(p.k)">
        {{ t(p.tk) }}
      </button>
    </div>
    <slot />
  </div>
  <slot v-else />
</template>