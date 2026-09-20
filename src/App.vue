<script setup>
import { computed, ref, onMounted, onErrorCaptured, onBeforeUnmount, watch } from "vue";
import {
  NConfigProvider, NMessageProvider, NDialogProvider, NTag, NButton,
} from "naive-ui";
import { useRoute, useRouter } from "vue-router";
import { App as CapApp } from "@capacitor/app";
import { t } from "./i18n.js";
import SideRails from "./components/SideRails.vue";
import TabBar from "./components/TabBar.vue";
import { isApp, isMobileNav } from "./stores/uiStore.js";
import {
  wallet, moodStreak, petNotices, dismissPetNotice,
} from "./stores/petStore.js";
import { cloud, initCloud } from "./utils/supabase.js";
import { cacheDrop } from "./utils/cache.js";
import { badge, startBadge, stopBadge } from "./stores/badgeStore.js";
/* 皮肤/语言：状态在 uiStore（与「设置」页共用）；App 只消费主题 */
import { naiveTheme, naiveOverrides } from "./stores/uiStore.js";

const NAV = [
  { to: "/", key: "nav.home" },
  { to: "/pet", key: "nav.pet" },
  { to: "/community", key: "nav.community" },
  { to: "/profile", key: "nav.profile" },
];

const route = useRoute();
const router = useRouter();

/* 手机形态的聊天页（/messages/:id）= 微信式整屏：底部 TabBar 与页脚让位，
 * 返回靠聊天页的 ← 钮与系统返回键。桌面双列同页不触发（isMobileNav=false）。 */
const inChat = computed(() => isMobileNav.value && route.name === "messages" && !!route.params.id);

/* 私信 / 通知角标：登录后由 badgeStore 每 30s 智能轮询（后台暂停）。
 * #14：红点只挂在聊天入口（💬）——🔔 不再显示红点，通知进页面看。 */
const dmBadge = computed(() => badge.dm + badge.requests);

const streak = computed(() => moodStreak());

/* —— 宠物登录通知（#2）：死亡哀悼 / 初始宠物降级 / 食物过期 —— 全局浮层 */
const noticeIcon = { dead: "🕯️", decay: "📉", expired: "🥣" };
function noticeText(n) {
  if (n.kind === "dead") return t("pet.notice.dead", { name: n.name });
  if (n.kind === "decay") return t("pet.notice.decay", { name: n.name, from: n.from, to: n.to });
  if (n.kind === "expired") return t("pet.notice.expired", { n: n.n });
  return "";
}

/* 云端探测（未配置时静默保持本地模式） */
const cloudSigned = computed(() => !!(cloud.ready && cloud.user));

/* ─── T9 · 安卓系统返回键（App 内导航与原生一致）───
 * 手机形态导航 = 「Tab 根视图 + push 二级页」：
 *   聊天页 / 其他二级页（他人主页 · 设置 · 通知…）→ 回上一页
 *   四个 Tab 根视图 → 最小化到桌面（Android 惯例；不误退出、后台保留） */
const ROOT_VIEWS = ["home", "community", "messagesList", "profile"];
let backHandle = null;

onMounted(async () => {
  initCloud();
  if (!isApp) return; /* 浏览器里没有系统返回键 */
  try {
    backHandle = await CapApp.addListener("backButton", () => {
      if (inChat.value || !ROOT_VIEWS.includes(route.name)) {
        router.back();
        return;
      }
      CapApp.minimizeApp();
    });
  } catch (e) { /* 插件缺失（网页调试）时静默 */ }
});
onBeforeUnmount(() => { if (backHandle) backHandle.remove(); });

/* 登录态变化 → 起停角标轮询（未登录不轮询，省流量）；
 * 登出 → 清掉个人域缓存（私信 / 通知 / 漂流瓶是个人数据，不留在设备上） */
watch(cloudSigned, (v) => {
  if (v) { startBadge(); return; }
  stopBadge();
  cacheDrop("dm:");
  cacheDrop("notif:");
  cacheDrop("bottle:");
}, { immediate: true });
onBeforeUnmount(() => { stopBadge(); });

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

        <div class="shell" :class="{ 'shell--mobile-nav': isMobileNav, 'shell--chat': inChat }">
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
              <!-- #24 云按钮已移除：与导航「我的」重复，登录态在「我的」页看 -->
              <!-- 私信 / 通知：只有登录后才显示（未登录没有收件人身份） -->
              <router-link v-if="cloudSigned" to="/messages" class="icon-link" :title="t('dm.title')">
                <span class="icon-emoji">💬</span>
                <span v-if="dmBadge" class="icon-badge">{{ dmBadge > 99 ? "99+" : dmBadge }}</span>
              </router-link>
              <!-- #14 通知入口不再挂红点；皮肤/语言移到「设置」页（#13） -->
              <router-link v-if="cloudSigned" to="/notifications" class="icon-link" :title="t('notif.title')">
                <span class="icon-emoji">🔔</span>
              </router-link>
            </div>
          </header>

          <main>
            <!-- 宠物系统通知浮层（#2：死亡哀悼 / 初始宠物降级 / 食物过期） -->
            <transition-group name="notice" tag="div" class="pet-notice-stack">
              <div v-for="(n, i) in petNotices" :key="n.kind + '-' + i" class="pet-notice">
                <span class="pet-notice-icon">{{ noticeIcon[n.kind] || "🐾" }}</span>
                <span class="pet-notice-text">{{ noticeText(n) }}</span>
                <button class="pet-notice-close" @click="dismissPetNotice(i)">✕</button>
              </div>
            </transition-group>

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

        <TabBar v-if="isMobileNav && !inChat" />
        <SideRails v-if="!isMobileNav" />
      </n-dialog-provider>
    </n-message-provider>
  </n-config-provider>
</template>