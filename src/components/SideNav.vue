<!-- 轮 132 · 桌面端左侧图标导航（参考图 1：窄 rail，图标 + 激活珊瑚胶囊 + 红点徽标）
 * 仅桌面（≥900px）渲染——移动端保持 TabBar + 顶栏不动。 -->
<script setup>
import { useRoute } from "vue-router";
import { t } from "../i18n.js";
import { badge } from "../stores/badgeStore.js";

const route = useRoute();
const items = [
  { to: "/", ico: "🌤️", key: "nav.home" },
  { to: "/pet", ico: "🐾", key: "nav.pet" },
  { to: "/community", ico: "💬", key: "nav.community" },
  { to: "/bottle", ico: "🌊", key: "nav.bottle" },
  { to: "/notifications", ico: "🔔", key: "notif.title", badge: () => badge.notif },
];
const isActive = (to) => (to === "/" ? route.path === "/" : route.path === to || route.path.startsWith(to + "/"));
</script>

<template>
  <nav class="sidenav" aria-label="App">
    <router-link to="/" class="sn-logo" title="Warm Paws">🐾</router-link>
    <router-link
      v-for="it in items" :key="it.to" :to="it.to"
      class="sn-item" :class="{ on: isActive(it.to) }" :title="t(it.key)">
      <span class="sn-ico">{{ it.ico }}</span>
      <span v-if="it.badge && it.badge()" class="sn-badge">{{ it.badge() > 99 ? "99+" : it.badge() }}</span>
    </router-link>
    <span class="sn-spring"></span>
    <router-link
      to="/settings" class="sn-item" :class="{ on: route.path === '/settings' }"
      :title="t('settings.entry')">
      <span class="sn-ico">⚙️</span>
    </router-link>
  </nav>
</template>

<style>
/* 左图标栏：固定贴左，卡片质感（奶油 + 发丝线），激活项珊瑚胶囊 */
.sidenav {
  position: fixed; left: 14px; top: 14px; bottom: 14px; z-index: 90;
  width: 64px; display: flex; flex-direction: column; align-items: center;
  gap: 6px; padding: 10px 8px;
  background: var(--card); border: 1px solid var(--hairline); border-radius: 18px;
}
.sn-logo {
  font-size: 22px; text-decoration: none; width: 42px; height: 42px;
  display: flex; align-items: center; justify-content: center;
  background: var(--accent); border-radius: 12px; margin-bottom: 6px;
}
.sn-item {
  position: relative; width: 44px; height: 44px; flex: none;
  display: flex; align-items: center; justify-content: center;
  font-size: 19px; text-decoration: none; border-radius: 12px;
  transition: background .15s ease, transform .15s var(--like-ease);
}
.sn-item:hover { background: var(--accent-soft); }
.sn-item:active { transform: scale(.92); }
.sn-item.on { background: var(--accent); }
.sn-item.on .sn-ico { filter: grayscale(1) brightness(2.2); }
.sn-badge {
  position: absolute; top: 4px; right: 4px; min-width: 16px; height: 16px;
  padding: 0 4px; border-radius: 999px; background: var(--low); color: #fff;
  font-size: 9.5px; font-weight: 500; line-height: 16px; text-align: center;
}
.sn-spring { flex: 1; }
@media (prefers-reduced-motion: reduce) { .sn-item { transition: none !important; } }
</style>
