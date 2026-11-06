<script setup>
/* ═══ App 轨道 T5：底部 Tab Bar（5 位，中间 ＋）═══
 * 仅 isApp / 窄屏渲染（App.vue 里 v-if="isMobileNav"）；桌面 ≥900px 永远看不到。
 * 红点口径与桌面顶栏一致：消息 = 私信未读 + 好友申请 + 漂流瓶待决定 + 未读通知
 * （轮452 起含通知；store 里那个 msgBadge 是唯一来源，别再在这儿手拼）。 */
import { ref, computed, watch, onBeforeUnmount } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Tabbar as VanTabbar, TabbarItem as VanTabbarItem } from "vant";
import "vant/es/tabbar/style/index";
import { t } from "../i18n.js";
import { msgBadge } from "../stores/badgeStore.js";
import { retapTab, pushBack, popBack } from "../stores/uiStore.js";

const route = useRoute();
const router = useRouter();

/* 轮 417：用户要「只要文字，不要图标」。
 * 纯文字的问题不是「没图标所以空」，而是**五项里只有中间一个是实心色块**，
 * 视线全被那颗大圆球吸走，两侧的字轻到像没画完。
 * 解法不是加图标，而是给文字本身加重：选中项垫一枚柔色胶囊、字号提到 13.5，',
 * 再把圆钮从 46 收到 38 —— 让「选中的字」和「主操作圆」落在同一个重量带上。 */
const TABS = [
  { path: "/", key: "tab.home", exact: true },
  { path: "/community", key: "tab.community" },
  { path: "/messages", key: "tab.messages", badge: true },
  { path: "/profile", key: "tab.profile" },
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

/* 轮 232 修正：再点当前页 tab = **回到顶部 + 刷新**（主流做法：微信/知乎/小红书都是这样）。
 * 轮 215 曾定「回原位置、不刷新不回顶」，可同路径 router.push 会被 vue-router 忽略 ——
 * 实际效果是**点了完全没反应**（用户实测反馈）。改成发 retapTab 信号，由页面自己接：
 * 暖心墙接了「滚回顶部 + 取新一批」（见 CommunityView）。 */
function goItem(item) {
  close(); /* 弹层开着时点页签：先收起弹层（点当前页签不会改路由，watch 兜不住这一支） */
  if (isActive(item)) { retapTab(item.path); return; }
  router.push(item.path).catch(() => {});
}

/* —— 中间 ＋ 钮：上弹三瓣（投漂流瓶 / 发暖心墙帖 / 写故事）—— */
const open = ref(false);
function toggle() { open.value = !open.value; }
function close() { open.value = false; }

/* ═══ 轮 415 · 弹层的三处收口 ═══
 * ① 系统返回键先关弹层，而不是把页面退回上一页 —— 走 uiStore 的拦截栈，
 *    App.vue 的 backButton 监听会先问栈顶（返回 true = 已处理）。
 * ② 路由一变就关：弹层开着点底部页签跳转，旧版会带着一层遮罩跟到新页面。
 * ③ 组件卸载时把拦截器摘掉，别在栈里留一个永远不弹的闭包。 */
const backFn = () => {
  if (!open.value) return false;
  open.value = false;
  return true;
};
watch(open, (v) => { if (v) pushBack(backFn); else popBack(backFn); });
watch(() => route.fullPath, () => { if (open.value) open.value = false; });
onBeforeUnmount(() => popBack(backFn));

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
      :badge="item.badge && msgBadge ? (msgBadge > 99 ? '99+' : String(msgBadge)) : ''"
      @click="goItem(item)">
      <span class="tab-label">{{ t(item.key) }}</span>
    </van-tabbar-item>
  </van-tabbar>

  <!-- ＋ 弹层：遮罩点击关闭，三瓣创作入口
       ⚠️ 轮 415：必须 Teleport 到 body。
       胶囊自己有 `backdrop-filter`，按 CSS 规范它会给 position:fixed 的后代当包含块，
       于是 `inset: 0` 的遮罩被解析成「胶囊那么大」（实测 372×54），
       `left/right: 0` 的弹层宽度也跟着胶囊算 —— 点外面关不掉、胶囊自己被蒙黑、位置贴不住底。 -->
  <Teleport to="body">
    <div v-if="open" class="tabbar-mask" @click="close"></div>
    <div v-if="open" class="tabbar-sheet" role="dialog" aria-modal="true" aria-label="创作">
      <button class="tabbar-opt" @click="composeBottle">
        <span class="tabbar-opt-ico" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" focusable="false">
            <path d="M9.5 3h5" />
            <path d="M10.5 3v3.1c0 .5-.2 1-.6 1.4l-1.2 1.2c-.4.4-.7 1.1-.7 1.7V19a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-8.6c0-.6-.3-1.3-.7-1.7l-1.2-1.2c-.4-.4-.6-.9-.6-1.4V3" />
            <path d="M8 14.5h8" />
            <path d="M10 17.2c.6.5 1.3.8 2 .8s1.4-.3 2-.8" />
          </svg>
        </span>
        <span class="tabbar-opt-txt">
          <b>{{ t("tab.composeBottle") }}</b>
          <small>{{ t("tab.composeBottleSub") }}</small>
        </span>
      </button>
      <button class="tabbar-opt" @click="composePost">
        <span class="tabbar-opt-ico" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" focusable="false">
            <path d="M21 11.5a8.5 8.5 0 0 1-12.5 7.5L4 20l1.2-4.4A8.5 8.5 0 1 1 21 11.5Z" />
            <path d="M12.5 15s-2.8-1.6-2.8-3.3c0-.9.7-1.6 1.6-1.6.5 0 1 .2 1.2.7.2-.5.7-.7 1.2-.7.9 0 1.6.7 1.6 1.6 0 1.7-2.8 3.3-2.8 3.3Z" />
          </svg>
        </span>
        <span class="tabbar-opt-txt">
          <b>{{ t("tab.composePost") }}</b>
          <small>{{ t("tab.composePostSub") }}</small>
        </span>
      </button>
      <button class="tabbar-opt" @click="composeStory">
        <span class="tabbar-opt-ico" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" focusable="false">
            <path d="M3.5 5.5A2.5 2.5 0 0 1 6 3h5.2v16H6a2.5 2.5 0 0 0-2.5 2.5V5.5Z" />
            <path d="M20.5 5.5A2.5 2.5 0 0 0 18 3h-5.2v16H18a2.5 2.5 0 0 1 2.5 2.5V5.5Z" />
            <path d="M6.5 7.5h2M15.5 7.5h2M6.5 10.5h2M15.5 10.5h2" />
          </svg>
        </span>
        <span class="tabbar-opt-txt">
          <b>{{ t("tab.composeStory") }}</b>
          <small>{{ t("tab.composeStorySub") }}</small>
        </span>
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.tabbar-opt-ico {
  flex: 0 0 38px;
  width: 38px;
  height: 38px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
  background: var(--accent-soft, #f5f0e8);
  color: var(--accent-deep, #a9583e);
}
.tabbar-opt-ico svg { width: 22px; height: 22px; display: block; }
</style>
