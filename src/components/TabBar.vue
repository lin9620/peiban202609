<script setup>
/* ═══ App 轨道 T5：底部 Tab Bar（5 位，中间 ＋）═══
 * 仅 isApp / 窄屏渲染（App.vue 里 v-if="isMobileNav"）；桌面 ≥900px 永远看不到。
 * 红点口径与桌面顶栏一致：消息 = 私信未读 + 好友申请（badgeStore 30s 轮询）。 */
import { ref, computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Tabbar as VanTabbar, TabbarItem as VanTabbarItem } from "vant";
import "vant/es/tabbar/style/index";
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

/* 轮 191：Vant Tabbar 的 active 下标（路由驱动；点击由 v-model 联动） */
const activeIdx = computed(() => {
  const i = TABS.findIndex((it) => isActive(it));
  return i < 0 ? 0 : i;
});

/* 轮 215 定案：再点当前页 tab = 回到该页**原位置**（不刷新不回顶）。
 * 同路径 push 被 vue-router 忽略 = 点了没反应——本来就在本页，无需动作。 */
function goItem(item) {
  router.push(item.path).catch(() => {});
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
/* 轮 148：故事投稿从 /story 页里搬出来，改挂底部 ＋ 的第三瓣。
 * 原来 /story 顶部操作条直接给「写故事」，等于纯阅读页里塞了个发布入口。 */
function composeStory() {
  close();
  router.push("/story/write").catch(() => {});
}
</script>

<template>
  <van-tabbar v-model="activeIdx" class="tabbar" :placeholder="false" :safe-area-inset-bottom="false" :fixed="true">
    <van-tabbar-item
      v-for="item in TABS.slice(0, 2)" :key="item.path"
      :class="{ active: isActive(item) }" @click="goItem(item)">
      <span class="tab-label">{{ t(item.key) }}</span>
    </van-tabbar-item>

    <button class="tab-compose" :class="{ open }" aria-label="+" @click="toggle">
      <span class="tab-compose-x">
        <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
          <!-- 轮 28：温柔风 ＋（圆角双线，open 时旋转 45° 成 ×，用户反馈爪印含义不明） -->
          <rect x="10.7" y="5.2" width="2.6" height="13.6" rx="1.3" fill="currentColor" />
          <rect x="5.2" y="10.7" width="13.6" height="2.6" rx="1.3" fill="currentColor" />
        </svg>
      </span>
    </button>

    <van-tabbar-item
      v-for="item in TABS.slice(2)" :key="item.path"
      :class="{ active: isActive(item) }"
      :badge="item.badge && dmBadge ? (dmBadge > 99 ? '99+' : String(dmBadge)) : ''"
      @click="goItem(item)">
      <span class="tab-label">{{ t(item.key) }}</span>
    </van-tabbar-item>

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
    <button class="tabbar-opt" @click="composeStory">
        <span class="tabbar-opt-ico">📖</span>
        <span class="tabbar-opt-txt">
          <b>{{ t("tab.composeStory") }}</b>
          <small>{{ t("tab.composeStorySub") }}</small>
        </span>
      </button>
    </div>
  </van-tabbar>
</template>
