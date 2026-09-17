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
import { NButton, NSwitch, NTag } from "naive-ui";
import { t } from "../i18n.js";
import { cloud } from "../utils/supabase.js";
import * as notifyApi from "../utils/notify.js";
import { aggregate, kindsFor, itemView, targetOf, normPrefs } from "../utils/notifyRules.js";
import { relativeTime } from "../utils/dmRules.js";
import { badge, refreshBadge } from "../stores/badgeStore.js";

const router = useRouter();

const TABS = [
  { key: "all", tk: "notif.tabAll" },
  { key: "comments", tk: "notif.tabComments" },
  { key: "reactions", tk: "notif.tabReactions" },
  { key: "pets", tk: "notif.tabPets" },
  { key: "dms", tk: "notif.tabDms" },
  { key: "system", tk: "notif.tabSystem" },
];
const PAGE = 30;

const tab = ref("all");
const unreadOnly = ref(false);
const rows = ref([]);        // 原始通知（新→旧）
const offset = ref(0);
const loading = ref(false);
const done = ref(false);     // 没有更多了
const failed = ref(false);
const signedIn = computed(() => !!(cloud.ready && cloud.user));

/* 分栏未读：全部 = 通知未读 + 私信未读（与导航角标同口径） */
const counts = computed(() => ({
  all: badge.notif + badge.dm,
  comments: badge.comments,
  reactions: badge.reactions,
  pets: badge.pets,
  dms: badge.dm,
  system: badge.system,
}));

/* 展示项：先聚合，再装配文案（模板不写任何句子） */
const shown = computed(() =>
  aggregate(rows.value).map((n) => ({ ...n, view: itemView(n) })));

const prefs = ref(normPrefs(null));

async function load(reset = false) {
  if (!signedIn.value || loading.value) return;
  loading.value = true;
  if (reset) { rows.value = []; offset.value = 0; done.value = false; failed.value = false; }
  let got = [];
  try {
    got = await notifyApi.page({
      offset: offset.value, limit: PAGE, kinds: kindsFor(tab.value), unreadOnly: unreadOnly.value,
    }) || [];
  } catch (e) {
    failed.value = true;
    got = [];
  }
  if (got.length) {
    rows.value = offset.value === 0 ? got : rows.value.concat(got);
    offset.value += got.length;
  }
  if (got.length < PAGE) done.value = true;
  loading.value = false;
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
  notifyApi.mark({ ids: [n.id] }).catch(() => {});
  n.read_at = n.read_at || new Date().toISOString();
  refreshBadge();
  const tg = targetOf(n);
  if (!tg) return;
  if (tg.type === "bottle") router.push({ name: "messagesList", query: { bottle: String(tg.bottleId) } });
  else if (tg.type === "dm") router.push({ name: "messages", params: { id: String(tg.convId) } });
  else router.push({ path: "/community", query: { post: String(tg.postId) } });
}

async function markAll() {
  try { await notifyApi.mark({ all: true }); } catch (e) { /* 静默 */ }
  const now = new Date().toISOString();
  rows.value = rows.value.map((r) => ({ ...r, read_at: r.read_at || now }));
  refreshBadge();
}

async function clearAll() {
  try { await notifyApi.clearAll(); } catch (e) { /* 静默 */ }
  load(true);
  refreshBadge();
}

async function savePrefs(next) {
  prefs.value = normPrefs(next);
  try { await notifyApi.prefsSet(prefs.value); } catch (e) { /* 静默 */ }
}

onMounted(async () => {
  if (!signedIn.value) return;
  load(true);
  refreshBadge();
  try { prefs.value = normPrefs(await notifyApi.prefsGet()); } catch (e) { /* 保持全开 */ }
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
          <span v-if="n.read_at == null" class="notif-dot" :title="t('notif.unread')"></span>
        </li>
      </ul>

      <p v-if="!shown.length && !loading" class="sub notif-empty">{{ t("notif.empty") }}</p>

      <div class="notif-foot">
        <n-button v-if="!done" round :loading="loading" @click="load(false)">{{ t("notif.more") }}</n-button>
        <span v-else-if="shown.length" class="sub">{{ t("notif.noMore") }}</span>
      </div>

      <!-- 通知偏好：改一次存一次；缺行 = 全开 -->
      <section class="card notif-prefs">
        <h2>{{ t("notif.prefs") }}</h2>
        <p class="sub">{{ t("notif.prefsHint") }}</p>
        <label class="notif-pref">
          <span>{{ t("notif.prefComments") }}</span>
          <n-switch :value="prefs.comments" @update:value="(v) => savePrefs({ ...prefs, comments: v })" />
        </label>
        <label class="notif-pref">
          <span>{{ t("notif.prefReactions") }}</span>
          <n-switch :value="prefs.reactions" @update:value="(v) => savePrefs({ ...prefs, reactions: v })" />
        </label>
        <label class="notif-pref">
          <span>{{ t("notif.prefPets") }}</span>
          <n-switch :value="prefs.pets" @update:value="(v) => savePrefs({ ...prefs, pets: v })" />
        </label>
        <label class="notif-pref">
          <span>{{ t("notif.prefDms") }}</span>
          <n-switch :value="prefs.dms" @update:value="(v) => savePrefs({ ...prefs, dms: v })" />
        </label>
        <n-tag round size="small" :bordered="false" class="soft-tag">{{ t("notif.prefsSaved") }}</n-tag>
      </section>
    </template>

    <router-link class="notif-back" to="/">{{ "← " + t("nav.home") }}</router-link>
  </div>
</template>