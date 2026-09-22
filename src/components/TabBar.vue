<script setup>
/* ═══ App 轨道 T5：底部 Tab Bar（5 位，中间 ＋）═══
 * 仅 isApp / 窄屏渲染（App.vue 里 v-if="isMobileNav"）；桌面 ≥900px 永远看不到。
 * 红点口径与桌面顶栏一致：消息 = 私信未读 + 好友申请（badgeStore 30s 轮询）。 */
import { ref, computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { t } from "../i18n.js";
import { badge } from "../stores/badgeStore.js";

const route = useRoute();
const router = useRouter();

const dmBadge = computed(() => badge.dm + badge.requests);

const TABS = [
  { path: "/", icon: "🏠", key: "tab.home", exact: true },
  { path: "/community", icon: "🧱", key: "tab.community" },
  { path: "/messages", icon: "💬", key: "tab.messages", badge: true },
  { path: "/profile", icon: "👤", key: "tab.profile" },
];

function isActive(item) {
  if (item.exact) return route.path === "/";
  return route.path === item.path || route.path.startsWith(item.path + "/");
}

/* —— 中间 ＋ 钮：上弹两瓣（投漂流瓶 / 发暖心墙帖）—— */
const open = ref(false);
function toggle() { open.value = !open.value; }
function close() { open.value = false; }
function composeBottle() {
  close();
  /* T6 三联容器消费 tab=bottle 切到漂流瓶联；在 T6 落地前先回首页（漂流瓶区块在首页内） */
  router.push({ path: "/", query: { tab: "bottle" } }).catch(() => {});
}
function composePost() {
  close();
  /* 手机端 3：发布统一走独立发布页（大输入框，一次写完） */
  router.push("/compose").catch(() => {});
}
</script>

<template>
  <nav class="tabbar" aria-label="App">
    <router-link
      v-for="item in TABS.slice(0, 2)" :key="item.path"
      :to="item.path" class="tab-item" :class="{ active: isActive(item) }">
      <span class="tab-label">{{ t(item.key) }}</span>
    </router-link>

    <button class="tab-compose" :class="{ open }" aria-label="+" @click="toggle">
      <span class="tab-compose-x">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <!-- 爪印：主掌 + 三趾（与品牌 🐾 呼应，替代生硬的 ＋） -->
          <ellipse cx="12" cy="14.6" rx="4.6" ry="3.9" fill="currentColor" />
          <circle cx="6.6" cy="9.4" r="1.9" fill="currentColor" />
          <circle cx="10.4" cy="6.8" r="2.0" fill="currentColor" />
          <circle cx="14.8" cy="6.9" r="1.9" fill="currentColor" />
          <circle cx="18.2" cy="9.8" r="1.7" fill="currentColor" />
        </svg>
      </span>
    </button>

    <router-link
      v-for="item in TABS.slice(2)" :key="item.path"
      :to="item.path" class="tab-item" :class="{ active: isActive(item) }">
      <span class="tab-label">{{ t(item.key) }}</span>
      <span v-if="item.badge && dmBadge" class="tab-badge">{{ dmBadge > 99 ? "99+" : dmBadge }}</span>
    </router-link>

    <!-- ＋ 弹层：遮罩点击关闭，两瓣创作入口 -->
    <div v-if="open" class="tabbar-mask" @click="close"></div>
    <div v-if="open" class="tabbar-sheet">
      <button class="tabbar-opt" @click="composeBottle">
        <span class="tabbar-opt-ico">🌊</span>
        <span class="tabbar-opt-txt">
          <b>{{ t("tab.composeBottle") }}</b>
          <small>{{ t("tab.composeBottleSub") }}</small>
        </span>
      </button>
      <button class="tabbar-opt" @click="composePost">
        <span class="tabbar-opt-ico">✍️</span>
        <span class="tabbar-opt-txt">
          <b>{{ t("tab.composePost") }}</b>
          <small>{{ t("tab.composePostSub") }}</small>
        </span>
      </button>
    </div>
  </nav>
</template>
