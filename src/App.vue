<script setup>
import { computed, ref, onMounted, onErrorCaptured } from "vue";
import {
  NConfigProvider, NMessageProvider, NDialogProvider, NDropdown, NTag, NButton, darkTheme,
} from "naive-ui";
import { t, i18n, setLocale, languages } from "./i18n.js";
import { naiveThemeFor } from "./theme.js";
import { THEMES } from "./data/themes.js";
import SideRails from "./components/SideRails.vue";
import { wallet, moodStreak } from "./stores/petStore.js";
import { cloud, initCloud } from "./utils/supabase.js";

const NAV = [
  { to: "/", key: "nav.home" },
  { to: "/pet", key: "nav.pet" },
  { to: "/community", key: "nav.community" },
  { to: "/profile", key: "nav.profile" },
];

const langOptions = languages.map((l) => ({ label: l.label, key: l.code }));
const currentLang = computed(
  () => (languages.find((l) => l.code === i18n.locale) || languages[0]).label
);

const streak = computed(() => moodStreak());

/* 云端探测（未配置时静默保持本地模式） */
const cloudSigned = computed(() => !!(cloud.ready && cloud.user));
const accountLabel = computed(() =>
  cloudSigned.value ? (cloud.nickname || t("common.guest")) : t("common.signIn"));
onMounted(() => { initCloud(); });

function onLangPick(code) {
  setLocale(code);
}

/* —— UI 主题套件 —— */
const THEME_KEY = "wp-theme";
const themeKey = ref(localStorage.getItem(THEME_KEY) || "cream");
const themeDef = computed(
  () => THEMES.find((x) => x.key === themeKey.value) || THEMES[0]
);
const naiveOverrides = computed(() => naiveThemeFor(themeKey.value));
const naiveTheme = computed(() => (themeDef.value.dark ? darkTheme : null));
const themeOptions = THEMES.map((x) => ({
  label: (x.dark ? "\u{1F319} " : "\u{1F3A8} ") + (x.name[i18n.locale] || x.name.en),
  key: x.key,
}));
function applyTheme(key) {
  themeKey.value = key;
  try { localStorage.setItem(THEME_KEY, key); } catch (e) {}
  document.documentElement.dataset.theme = key;
}
document.documentElement.dataset.theme = themeKey.value;

/* —— 错误边界：某个页面渲染出错时显示提示，而不是整页白屏 —— */
const crashed = ref("");
onErrorCaptured((err) => {
  crashed.value = (err && err.message) || String(err);
  console.error("[Warm Paws] 页面出错：", err);
  return false; // 阻止继续向上冒泡
});

function reload() {
  crashed.value = "";
  window.location.reload();
}
</script>

<template>
  <n-config-provider :theme="naiveTheme" :theme-overrides="naiveOverrides">
    <n-message-provider>
      <n-dialog-provider>
        <div class="orb orb-1"></div>
        <div class="orb orb-2"></div>
        <div class="orb orb-3"></div>

        <div class="shell">
          <header class="topbar">
            <router-link to="/" class="brand">
              <span class="brand-paw">🐾</span>
              <span class="brand-text">
                <strong>{{ t("brand") }}</strong>
                <small>{{ t("tagline") }}</small>
              </span>
            </router-link>

            <nav class="nav">
              <router-link
                v-for="n in NAV" :key="n.to" :to="n.to"
                exact-active-class="active" active-class="active">
                {{ t(n.key) }}
              </router-link>
            </nav>

            <div class="topbar-right">
              <n-tag v-if="streak > 0" round size="small" :bordered="false" class="soft-tag">
                🌱 {{ streak }}
              </n-tag>
              <n-tag round size="small" :bordered="false" class="soft-tag">
                 &#128176; {{ wallet.coins }}
              </n-tag>
              <router-link to="/profile" class="account-link" :title="t('profile.title')">
                <n-tag round size="small" :bordered="false" class="soft-tag" :class="{ signed: cloudSigned }">
                  {{ cloudSigned ? "\u2601\uFE0F" : "\u{1F464}" }} {{ accountLabel }}
                </n-tag>
              </router-link>
              <n-dropdown :options="themeOptions" trigger="click" @select="applyTheme">
                <button class="lang-btn theme-btn" :title="t('theme.pick')">{{ "\u{1F3A8}" }}</button>
              </n-dropdown>
              <n-dropdown :options="langOptions" trigger="click" @select="onLangPick">
                <button class="lang-btn">🌐 {{ currentLang }}</button>
              </n-dropdown>
            </div>
          </header>

          <main>
            <div v-if="crashed" class="crash-box">
              <p class="crash-title">😿 {{ t("common.oops") }}</p>
              <p class="crash-msg">{{ crashed }}</p>
              <n-button type="primary" round @click="reload">{{ t("common.reload") }}</n-button>
            </div>

            <router-view v-else v-slot="{ Component, route }">
              <!-- 包一层 div 作为过渡元素：保证 <transition> 的节点始终是单一元素，避免视图多根节点导致白屏 -->
              <transition name="fade" mode="out-in">
                <div :key="route.path" class="route-wrap">
                  <component :is="Component" />
                </div>
              </transition>
            </router-view>
          </main>

          <footer class="footer">
            <span>{{ t("footerNote") }}</span>
            <!-- 隐私政策入口：常驻页脚，让访客与外部审核都能直接找到（Google 发布要求） -->
            <router-link to="/privacy" class="footer-link">{{ t("privacy.title") }}</router-link>
          </footer>
        </div>

        <SideRails />
      </n-dialog-provider>
    </n-message-provider>
  </n-config-provider>
</template>