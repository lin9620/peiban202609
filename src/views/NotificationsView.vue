/* 通知中心（/notifications）
 * ------------------------------------------------------------
 * 大站做法逐条落地：
 *  - 分栏（全部 / 评论 / 回应 / 宠物 / 私信 / 系统）各带未读角标；
 *  - 「只看未读」开关；分页「加载更多」；一键全部已读；清空；
 *  - 聚合：「小A 和另外 3 人 …」（连续同类型同帖合并，见 notifyRules.aggregate）；
 *  - 点击一条 = 标记已读 + 跳到原帖（/community?post=帖子id）或该私信会话（/messages/:id）；
 *  - 偏好开关（评论 / 回应 / 宠物 / 私信）写在页尾，读取走 RPC（缺行 = 全开）。
 * 未登录 / 云端不可用时显示引导，不报错（与站内其他页面一致的降级哲学）。
 */
<script setup>
import { ref, computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import { NButton } from "naive-ui";
import { t } from "../i18n.js";
import { cloud } from "../utils/supabase.js";
import * as notifyApi from "../utils/notify.js";
import { cacheKey, swr, cacheDrop } from "../utils/cache.js";
import { aggregate, kindsFor, itemView, targetOf, idsOf } from "../utils/notifyRules.js";
import { relativeTime } from "../utils/dmRules.js";
import { badge, refreshBadge } from "../stores/badgeStore.js";

const router = useRouter();

const TABS = [
  { key: "all", tk: "notif.tabAll" },
  { key: "comments", tk: "notif.tabComments" },
  { key: "reactions", tk: "notif.tabReactions" },
  { key: "pets", tk: "notif.tabPets" },
  { key: "system", tk: "notif.tabSystem" },
];
const PAGE = 20;   /* #14 每页 20 条，手动翻页（不再一次拉 30 条往下堆） */

const tab = ref("all");
const unreadOnly = ref(false);
const rows = ref([]);        // 原始通知（当前页，新→旧）
const page = ref(0);         // #14 当前页码（0 起）
const loading = ref(false);
const done = ref(false);     // 当前页不满 → 没有下一页了
const failed = ref(false);
const signedIn = computed(() => !!(cloud.ready && cloud.user));

/* 分栏未读：全部 = 通知表未读（私信不在通知中心，#23 —— 私信未读只看导航 💬 角标） */
const counts = computed(() => ({
  all: badge.notif,
  comments: badge.comments,
  reactions: badge.reactions,
  pets: badge.pets,
  system: badge.system,
}));

/* 展示项：先聚合，再装配文案（模板不写任何句子） */
const shown = computed(() =>
  aggregate(rows.value).map((n) => ({ ...n, view: itemView(n) })));

/* 偏好开关已移到设置页（#13）；这里只负责列表、分栏与翻页 */

/* #14 分页：每次只取一页（20 条）；reset 回到第 0 页 */
async function load(reset = false) {
  if (!signedIn.value || loading.value) return;
  loading.value = true;
  const target = reset ? 0 : page.value;
  if (reset) { failed.value = false; done.value = false; }
  const applyRows = (got) => {
    rows.value = got;
    page.value = target;
    done.value = got.length < PAGE;
  };
  await swr(
    /* 只缓存第 0 页（进页首屏）；翻页走网络 */
    reset ? cacheKey("notif:p0", (cloud.user && cloud.user.id) || "", tab.value, unreadOnly.value ? 1 : 0) : null,
    {
      cached: (got) => { applyRows(got); loading.value = false; },
      fresh: applyRows,
      onError: () => { failed.value = true; applyRows([]); },
    },
    () => notifyApi.page({
      offset: target * PAGE, limit: PAGE, kinds: kindsFor(tab.value), unreadOnly: unreadOnly.value,
    }),
  );
  loading.value = false;
}

/* 翻页（#14）：手动点击才加载下一页/上一页 */
function goPage(delta) {
  const next = page.value + delta;
  if (next < 0 || (delta > 0 && done.value)) return;
  page.value = next;   /* load(false) 以 page.value 为目标页 */
  load(false);
}

function pickTab(k) {
  if (tab.value === k) return;
  tab.value = k;
  load(true);
}
function toggleUnread() {
  unreadOnly.value = !unreadOnly.value;
  load(true);
}

const when = (ts) => relativeTime(ts, Date.now(), t);

/** 一条通知的正文：i18n 键 + 插值（谁 / 另外几人 / 帖子摘要 / 评论摘要） */
function line(n) {
  const v = n.view || {};
  return t(v.key, {
    who: v.who || t("notif.someone"),
    others: v.others,
    post: v.post || "",
    comment: v.comment || "",
    preview: v.preview || "",
    body: v.systemBody || "",
    reaction: v.reaction ? t(`notif.react.${v.reaction}`) : "",
    pet: v.petKind ? t(`notif.petKind.${v.petKind}`) : "",
  });
}

async function openItem(n) {
  /* 点一条 = 把这一整组（聚合里的所有原始通知）一起标已读。
   * 用户反馈：「一进去十几条通知，列表只显示 3 条」—— 旧版只标了组里第一条，
   * 剩下的十几条未读还挂在角标上，看着就是「读了也不消」。 */
  const ids = idsOf(n);
  notifyApi.mark(ids.length ? { ids } : { ids: [n.id] }).catch(() => {});
  const now = new Date().toISOString();
  n.read_at = n.read_at || now;
  const touched = new Set(ids);
  rows.value = rows.value.map((r) => (touched.has(r.id) ? { ...r, read_at: r.read_at || now } : r));
  cacheDrop("notif:");     /* 首屏缓存里的未读标记一并作废，下次进来不会又「复活」 */
  refreshBadge();
  const tg = targetOf(n);
  if (!tg) return;
  if (tg.type === "bottle") router.push({ name: "messagesList", query: { bottle: String(tg.bottleId) } });
  else if (tg.type === "dm") router.push({ name: "messages", params: { id: String(tg.convId) } });
  else if (tg.type === "user") router.push({ name: "waller", params: { id: tg.userId } });  /* #15 摸宠物等 → TA 的主页 */
  else router.push({ path: "/community", query: { post: String(tg.postId) } });
}

async function markAll() {
  try { await notifyApi.mark({ all: true }); } catch (e) { /* 静默 */ }
  const now = new Date().toISOString();
  rows.value = rows.value.map((r) => ({ ...r, read_at: r.read_at || now }));
  cacheDrop("notif:");      /* 首屏缓存里还存着未读标记，一并作废 */
  refreshBadge();
}

async function clearAll() {
  try { await notifyApi.clearAll(); } catch (e) { /* 静默 */ }
  cacheDrop("notif:");
  load(true);
  refreshBadge();
}

onMounted(async () => {
  if (!signedIn.value) return;
  load(true);
  refreshBadge();
});
</script>

<template>
  <div class="notif-page">
    <section class="card notif-head">
      <h1 class="notif-title">🔔 {{ t("notif.title") }}</h1>
      <p class="sub">{{ t("notif.intro") }}</p>

      <div class="notif-tabs">
        <button
          v-for="x in TABS" :key="x.key"
          class="notif-tab" :class="{ on: tab === x.key }"
          @click="pickTab(x.key)">
          {{ t(x.tk) }}
          <span v-if="counts[x.key]" class="notif-count">{{ counts[x.key] }}</span>
        </button>
      </div>

      <div class="notif-actions">
        <button class="notif-act" :class="{ on: unreadOnly }" @click="toggleUnread">
          {{ unreadOnly ? t("notif.unreadOnlyOn") : t("notif.unreadOnly") }}
        </button>
        <button class="notif-act" :disabled="!rows.length" @click="markAll">{{ t("notif.markAll") }}</button>
        <button class="notif-act" :disabled="!rows.length" @click="clearAll">{{ t("notif.clear") }}</button>
      </div>
    </section>

    <!-- 未登录：不报错，给入口 -->
    <section v-if="!signedIn" class="card notif-empty">
      <p class="sub">{{ t("notif.needSignIn") }}</p>
      <n-button type="primary" round @click="router.push('/profile')">{{ t("nav.profile") }}</n-button>
    </section>

    <template v-else>
      <p v-if="failed" class="notice">{{ t("notif.loadFail") }}</p>

      <ul class="notif-list">
        <li
          v-for="n in shown" :key="n.id"
          class="notif-item card" :class="{ unread: n.read_at == null }"
          @click="openItem(n)">
          <span class="notif-icon">{{ n.kind === "dm" ? "\uD83D\uDCE8" : n.kind === "pet" ? "🐾"
            : n.kind === "reaction" ? "🤗" : n.kind === "system" ? "📢" : "💬" }}</span>
          <div class="notif-body">
            <p class="notif-line">{{ line(n) }}</p>
            <p v-if="n.post_body" class="sub notif-quote">{{ n.post_body }}</p>
            <p class="sub notif-time">{{ when(n.created_at) }}</p>
          </div>
          <!-- 这一行是几条通知合并的（用户反馈：一进去十几条，列表只见 3 条 —— 把数亮出来） -->
          <span v-if="n.count > 1" class="notif-times">×{{ n.count }}</span>
          <span v-if="n.read_at == null" class="notif-dot" :title="t('notif.unread')"></span>
        </li>
      </ul>

      <p v-if="!shown.length && !loading" class="sub notif-empty">{{ t("notif.empty") }}</p>

      <div class="notif-foot">
        <n-button size="small" round :disabled="page <= 0 || loading" @click="goPage(-1)">
          ← {{ t("notif.prev") }}
        </n-button>
        <span class="sub notif-pageinfo">{{ t("notif.pageInfo", { p: page + 1 }) }}</span>
        <n-button size="small" round :disabled="done || loading" @click="goPage(1)">
          {{ t("notif.next") }} →
        </n-button>
      </div>
    </template>

    <router-link class="notif-back" to="/">{{ "← " + t("nav.home") }}</router-link>
  </div>
</template>

<style scoped>
/* 聚合徽标：这行代表同键的 N 条原始通知；点一下整组一起消未读 */
.notif-times {
  flex: none; align-self: center; margin-left: 6px;
  font-size: 11.5px; font-weight: 800; color: var(--ink-soft);
  background: rgba(160, 110, 60, .1); border-radius: 999px; padding: 3px 9px;
}
</style>