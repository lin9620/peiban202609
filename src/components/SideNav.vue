<!-- 轮 132 · 桌面端左侧图标导航（参考图 1：窄 rail，图标 + 激活珊瑚胶囊 + 红点徽标）
 * 仅桌面（≥900px）渲染——移动端保持 TabBar + 顶栏不动。 -->
<script setup>
import { useRoute, useRouter } from "vue-router";
import { t } from "../i18n.js";
import { badge } from "../stores/badgeStore.js";
import { navOpen, toggleNav } from "../stores/uiStore.js";

const route = useRoute();
const items = [
  { to: "/", ico: "🌤️", key: "nav.home" },
  { to: "/pet", ico: "🐾", key: "nav.pet" },
  /* 轮 140（用户要求）：漂流瓶上移到暖心墙之上 */
  { to: "/bottle", ico: "🌊", key: "nav.bottle" },
  { to: "/community", ico: "💬", key: "nav.community" },
  /* 轮 145（用户要求）：故事栏 —— 投稿 / 发现 / 我的（左栏三页签）+ 右栏排行榜 */
  { to: "/story", ico: "📖", key: "nav.story" },
  { to: "/messages", ico: "✉️", key: "dm.title", badge: () => badge.dm + badge.requests },
];
const isActive = (to) => (to === "/" ? route.path === "/" : route.path === to || route.path.startsWith(to + "/"));
const router = useRouter();

/* 轮144（用户口径）：左侧边点「暖心墙」——已在暖心墙页时再点 = 刷新（抄 TabBar 轮100 先例）：
 * 同路径 push 会被 vue-router 忽略（点了没反应）→ 拦下默认导航，推带时间戳的 refresh query，
 * CommunityView 的 watch(route.query.refresh) 强制取新第一页并回顶部。其它按钮/非本页不干预。 */
function onNavClick(it, e) {
  if (it.to !== "/community" || !isActive(it.to)) return;
  e.preventDefault();
  router.push({ path: "/community", query: { refresh: String(Date.now()) } }).catch(() => {});
}
</script>

<template>
  <nav class="sidenav" :class="{ 'sidenav--open': navOpen }" aria-label="App">
    <!-- 轮 138 · 方案 A：🐾 只当开关（展开/收起）；「回首页」交给展开后的品牌行 -->
    <div class="sn-top">
      <button
        class="sn-logo" type="button" :aria-expanded="navOpen"
        :aria-label="t(navOpen ? 'nav.collapse' : 'nav.expand')"
        :title="t(navOpen ? 'nav.collapse' : 'nav.expand')"
        @click="toggleNav()">🐾</button>
      <router-link v-if="navOpen" to="/" class="sn-brand" :title="t('brand')">{{ t("brand") }}</router-link>
    </div>
    <router-link
      v-for="it in items" :key="it.to" :to="it.to"
      class="sn-item" :class="{ on: isActive(it.to) }" :title="t(it.key)"
      @click="onNavClick(it, $event)">
      <span class="sn-ico">{{ it.ico }}</span>
      <span class="sn-label">{{ t(it.key) }}</span>
      <span v-if="it.badge && it.badge()" class="sn-badge">{{ it.badge() > 99 ? "99+" : it.badge() }}</span>
    </router-link>
    <span class="sn-spring"></span>
    <router-link
      to="/settings" class="sn-item" :class="{ on: route.path === '/settings' }"
      :title="t('settings.entry')">
      <span class="sn-ico">⚙️</span>
      <span class="sn-label">{{ t("settings.entry") }}</span>
    </router-link>
  </nav>
</template>

<style>
/* 左图标栏：固定贴左，卡片质感（奶油 + 发丝线），激活项珊瑚胶囊
 * 轮 138：可展开形态（用户方案 A）——🐾 开关把栏从 64px 拉到 212px（= 右栏宽度），
 * 图标旁出现文字；收起态与展开前逐值一致（宽度/间距/居中口径全未动）。 */
.sidenav {
  position: fixed; left: 14px; top: 14px; bottom: 14px; z-index: 90;
  width: 64px; display: flex; flex-direction: column; align-items: center;
  gap: 6px; padding: 10px 8px; overflow: hidden;
  background: var(--card); border: 1px solid var(--hairline); border-radius: 18px;
  transition: width .22s ease, background-color .22s ease, border-color .22s ease;
}
/* 轮 140（用户要求）：展开态去掉「框」的背景与描边 —— 与右栏同口径
 * （右栏 `.rail` 容器本身透明，只有内部卡片有底）；收起态仍保留原卡片质感 */
.sidenav--open { width: 212px; background: transparent; border-color: transparent; }
/* 顶部：爪印开关（收起时宽度自适应 = 仍由栏居中，与原样一致；展开时铺满行首） */
.sn-top { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.sidenav--open .sn-top { width: 100%; }
.sn-logo {
  appearance: none; -webkit-appearance: none; border: 0; padding: 0; cursor: pointer;
  font-size: 22px; width: 42px; height: 42px; flex: none;
  display: flex; align-items: center; justify-content: center;
  background: var(--accent); border-radius: 12px;
}
.sn-logo:active { transform: scale(.94); }
/* 展开后的品牌行 = 回首页入口（爪印只当开关，方案 A） */
.sn-brand {
  font-size: 13.5px; font-weight: 500; color: var(--ink-soft);
  text-decoration: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.sn-brand:hover { color: var(--accent-deep); }
/* 行内文字：收起态 display:none（读屏也不读），展开才显示并淡入 */
.sn-label { display: none; font-size: 14px; font-weight: 500; color: var(--ink); white-space: nowrap; }
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
/* 展开态：每项变整行（图标 + 文字），激活胶囊铺满整行；红点从角标改为行尾 */
.sidenav--open .sn-item { width: 100%; justify-content: flex-start; padding: 0 13px; gap: 10px; }
.sidenav--open .sn-item .sn-label { display: block; animation: snLabel .2s ease .04s both; }
.sidenav--open .sn-item.on .sn-label { color: #fff; }
.sidenav--open .sn-badge { position: static; margin-left: auto; flex: none; }
@keyframes snLabel { from { opacity: 0; transform: translateX(-5px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) {
  .sidenav { transition: none !important; }
  .sn-item { transition: none !important; }
  .sidenav--open .sn-item .sn-label { animation: none !important; }
}
</style>
