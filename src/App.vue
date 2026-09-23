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
import { isApp, isMobileNav, runBack } from "./stores/uiStore.js";
import {
  wallet, moodStreak, petNotices, dismissPetNotice,
} from "./stores/petStore.js";
import { cloud, initCloud, cloudHandleAppRedirect, isAppAuthRedirect } from "./utils/supabase.js";
import { setUserScope } from "./utils/userScope.js";
import { cacheDrop, cacheKey, swr } from "./utils/cache.js";
import * as dmApi from "./utils/dm.js";
import { bottleQuota, bottleHeld } from "./utils/bottle.js";
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

/* 手机形态的整屏页（微信式）＝ 聊天页（/messages/:id）+ 独立发帖页（/compose）：
 * 底部 TabBar 与页脚一并让位，返回靠页内 ← 钮与系统返回键。
 * 桌面双列同页 / 桌面发布框不触发（isMobileNav=false，桌面零变化）。 */
const inChat = computed(() => isMobileNav.value
  && ((route.name === "messages" && !!route.params.id) || route.name === "compose"));

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
let authUrlHandle = null;   /* 轮 31：谷歌登录回跳监听（App 端） */

/* —— 启动页预热（轮 24）：与 MessagesView.loadConvs 同款 key + fetcher ——
 * 启动页期间把会话列表缓存刷新好，用户点进消息 Tab 时 cached 直接命中（秒开最新列表）。 */
async function prefetchConvs() {
  if (!(cloud.ready && cloud.user)) return;
  try {
    await swr(cacheKey("dm:convs", cloud.user.id), {}, () => dmApi.listConvs(200, 0));
  } catch (e) { /* 预热失败不影响启动 */ }
}

/* —— 轮 41：漂流瓶预热 —— 启动期就把「今日次数 + 手里的信」查上（用户要求：
 * 「点击首页的时候就把这数据提前查好，而不是点击漂流瓶之后一直出不来」）。
 * 与首页三联**同源函数**（bottle.js 单飞合并）：BottleView 挂载时 join 的就是
 * 这次在途请求，不发双份。只发请求、不写任何本机存储（轮 37 全线上口径不变），
 * 失败静默（界面自己会如实报错）。fire-and-forget：不阻塞启动页放行。 */
async function prefetchBottle() {
  if (!(cloud.ready && cloud.user)) return;
  try { await Promise.all([bottleQuota(), bottleHeld()]); } catch (e) { /* 预热失败不影响启动 */ }
}

/* 关闭启动页：淡出后从 DOM 摘掉（静态层在 #app 外，Vue 挂载不影响它） */
function removeSplash() {
  const el = document.getElementById("app-splash");
  if (!el) return;
  el.classList.add("out");
  setTimeout(() => { try { el.remove(); } catch (e) { /* 已被移除 */ } }, 400);
}

onMounted(async () => {
  /* 轮 24：启动页（index.html 静态层）在「云端会话就绪 + 会话缓存预热」后淡出；
   * 最多等 2.5 秒兜底放行——云端挂了也不能把用户挡在启动页里。 */
  const boot = initCloud()
    .then(() => { prefetchBottle(); return prefetchConvs(); })   /* 轮 41：漂流瓶预热不阻塞，私信照旧等待 */
    .catch(() => { /* 预热失败不挡启动 */ });
  await Promise.race([boot, new Promise((r) => setTimeout(r, 2500))]);
  removeSplash();
  if (!isApp) return; /* 浏览器里没有系统返回键 */
  try {
    backHandle = await CapApp.addListener("backButton", () => {
      /* T7：页面内部层级先接管（消息 Tab 通知段 → 回私信段），再走路由/最小化 */
      if (runBack()) return;
      if (inChat.value || !ROOT_VIEWS.includes(route.name)) {
        router.back();
        return;
      }
      CapApp.minimizeApp();
    });
  } catch (e) { /* 插件缺失（网页调试）时静默 */ }

  /* —— 轮 31：谷歌登录从 App 内授权窗口回到 App ——
   * 中转页（站内 /app-auth）把令牌转交给 net.de5.dale://login，Android 据此拉起本 App：
   *   · App 还活着 → onNewIntent → appUrlOpen 事件；
   *   · App 被杀掉后的冷启动 → 事件不会重放，必须用 getLaunchUrl 把启动 intent 取回来。
   * 两条路都交给 handleAuthUrl：解析令牌 → 建会话（cloud.user 一变，登录页 watch 自动回跳）。 */
  async function handleAuthUrl(u) {
    if (!isAppAuthRedirect(u)) return;
    const r = await cloudHandleAppRedirect(u);
    if (!r.ok) console.warn("[Warm Paws] App 端谷歌登录回跳失败：", r.reason);
  }
  try {
    authUrlHandle = await CapApp.addListener("appUrlOpen", (ev) => { handleAuthUrl(ev && ev.url); });
    const launch = await CapApp.getLaunchUrl();
    if (launch && launch.url) await handleAuthUrl(launch.url);
  } catch (e) { /* 插件缺失（网页调试）时静默 */ }
});
onBeforeUnmount(() => {
  if (backHandle) backHandle.remove();
  if (authUrlHandle) authUrlHandle.remove();
});

/* 登录态变化 → 起停角标轮询（未登录不轮询，省流量）；
 * 登出 → 清掉个人域缓存（私信 / 通知 / 漂流瓶是个人数据，不留在设备上）。
 * 轮 37 起漂流瓶已完全不写本机缓存（全线上），这里的 bottle: 只用于清掉老版本留在
 * 设备上的快照——别删，删了老设备升级后会一直带着那份过期快照。 */
watch(cloudSigned, (v) => {
  if (v) { startBadge(); return; }
  stopBadge();
  cacheDrop("dm:");
  cacheDrop("notif:");
  cacheDrop("bottle:");
}, { immediate: true });
onBeforeUnmount(() => { stopBadge(); });

/* 轮 32：登录态变化 = 换数据域。宠物/金币/手绘厨房/冒险 + 暖心墙本地账全部按 uid 分键
 * （utils/userScope.js），未登录 = guest 域；setUserScope 内部先 flush 旧域再 reload 新域，
 * 同设备换号不再串档（用户报障：新注册的号一进宠物就是 3 级）。 */
watch(() => (cloud.user && cloud.user.id) || "", (uid) => { setUserScope(uid); }, { immediate: true });

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

/* ─── T9 · 冻结过渡自愈（真机空白屏实证）───
 * Vue 过渡的 enter 起点是 rAF 驱动的：App 在后台/被遮挡时（WebView 冻结 rAF）若路由
 * 恰好过渡中，会停在 opacity:0 的 enter-from → 回前台**整页永久空白**。
 * 三道保险：回前台清一次 + 每次路由变更后延迟清一次（正常完成后是无操作）+ 轮询兜底。 */
function scrubStuckFade() {
  document
    .querySelectorAll(".fade-enter-active, .fade-leave-active, .fade-enter-from, .fade-leave-to")
    .forEach((el) => {
      el.classList.remove("fade-enter-active", "fade-leave-active", "fade-enter-from", "fade-leave-to");
    });
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    requestAnimationFrame(scrubStuckFade);
    setTimeout(scrubStuckFade, 120); /* rAF 本身可能还没恢复，再补一刀 */
  }
});
let scrubTimer = 0;
watch(() => route.fullPath, () => {
  clearTimeout(scrubTimer);
  scrubTimer = setTimeout(scrubStuckFade, 700);
});
onBeforeUnmount(() => { clearTimeout(scrubTimer); scrubTimer = 0; });

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
            <!-- 隐私政策入口已挪到「设置」页（手机端 7：页脚只留一句签名）；/privacy 路由保留（Google 审核用） -->
          </footer>
        </div>

        <TabBar v-if="isMobileNav && !inChat" />
        <SideRails v-if="!isMobileNav" />
      </n-dialog-provider>
    </n-message-provider>
  </n-config-provider>
</template>