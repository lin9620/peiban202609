/* 通知中心（/notifications）
 * ------------------------------------------------------------
 * 大站做法逐条落地：
 *  - 分栏（全部 / 评论 / 回应 / 宠物 / 私信 / 系统）各带未读角标；
 *  - 「只看未读」开关；分页「加载更多」；一键全部已读；清空；
 *  - 聚合：「小A 和另外 3 人 …」（连续同类型同帖合并，见 notifyRules.aggregate）；
 *  - 点击一条 = 标记已读 + 跳到原帖详情（/post/:id，轮 241 起；原 /community?post= 只落墙、看不到详情）
 *    或该私信会话（/messages/:id）；
 *  - 偏好开关（评论 / 回应 / 宠物 / 私信）写在页尾，读取走 RPC（缺行 = 全开）。
 * 未登录 / 云端不可用时显示引导，不报错（与站内其他页面一致的降级哲学）。
 */
<script setup>
import { ref, reactive, computed, watch, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { NButton } from "naive-ui";
import { t, i18n } from "../i18n.js";
import { cloud } from "../utils/supabase.js";
import * as notifyApi from "../utils/notify.js";
import { cacheKey, swr, cacheDrop } from "../utils/cache.js";
import { aggregate, kindsFor, itemView, targetOf, idsOf } from "../utils/notifyRules.js";
import {
  needsTranslation, sourceLangOf, translationCacheKey,
} from "../utils/announcement.js";
import { translateAnnouncement, readCachedTranslation, writeCachedTranslation } from "../utils/translate.js";
import { relativeTime } from "../utils/dmRules.js";
import { badge, refreshBadge, badgeLocal } from "../stores/badgeStore.js";

const router = useRouter();
const route = useRoute();

/* 未登录 → 登录页（轮 17 统一口径）：登录成功按 ?redirect= 回到本页，不再绕道「我的」页 */
function goSignIn() {
  router.push({ path: "/login", query: { redirect: route.fullPath || "/notifications" } });
}

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

/* ── 管理员公告：详情弹层 + 按读者语言自动翻译 ─────────────────────
 * 通知列表里的正文只露两行（长公告会被省略号截断），点开弹层看全文；
 * 译文按「原文 + 目标语言」缓存在本机，换语言/重进都不重复调模型。
 * 翻译失败时一律退回原文 —— 公告不能因为模型没开就变成空白。 */
const detail = ref(null);          // { n }：当前打开的系统公告
const trMap = reactive({});        // cacheKey -> 译文
const trBusy = reactive({});       // cacheKey -> true（正在翻）

function systemBody(n) {
  return String((n && n.view && n.view.systemBody) || "").trim();
}

function bodyFor(n) {
  const body = systemBody(n);
  if (!body) return "";
  if (!needsTranslation(body, i18n.locale)) return body;
  return trMap[translationCacheKey(body, i18n.locale)] || body;
}

function isTranslating(n) {
  const body = systemBody(n);
  if (!body || !needsTranslation(body, i18n.locale)) return false;
  return !!trBusy[translationCacheKey(body, i18n.locale)];
}

async function ensureBody(n) {
  const body = systemBody(n);
  if (!body) return;
  if (!needsTranslation(body, i18n.locale)) return;
  const key = translationCacheKey(body, i18n.locale);
  if (trMap[key] || trBusy[key]) return;
  const cached = readCachedTranslation(key);
  if (cached) { trMap[key] = cached; return; }
  trBusy[key] = true;
  try {
    const out = await translateAnnouncement(body, i18n.locale, sourceLangOf(body));
    if (out) {
      trMap[key] = out;
      writeCachedTranslation(key, out);
    }
  } catch (e) {
    /* 静默退回原文：通知中心不因翻译失败弹错/空白 */
  } finally {
    delete trBusy[key];
  }
}

/* 打开公告：标已读 + 打开全文弹层（系统公告没有帖子可跳，别让点击像没反应） */
function openAnnouncement(n) {
  detail.value = { n };
  ensureBody(n);
}

const detailBody = computed(() => (detail.value ? bodyFor(detail.value.n) : ""));
const detailKey = computed(() => {
  const n = detail.value && detail.value.n;
  const body = systemBody(n);
  return body ? translationCacheKey(body, i18n.locale) : "";
});
const detailTranslating = computed(() => !!trBusy[detailKey.value]);
const detailOriginal = computed(() => {
  const n = detail.value && detail.value.n;
  const body = systemBody(n);
  if (!body || !needsTranslation(body, i18n.locale)) return false;
  return !trMap[detailKey.value] && !trBusy[detailKey.value];
});

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
  const markP = notifyApi.mark(ids.length ? { ids } : { ids: [n.id] }).catch(() => {});
  const now = new Date().toISOString();
  const touched = new Set(ids);
  /* 轮 254 · 红点跟手：先数出这组「此前未读」有几条（必须在 map 改 read_at 之前），
   * 本地角标立刻按数递减（0ms 跟手）；等 mark 落库后再拉服务端权威值校正。
   * 旧写法 mark 不 await 就 refresh（并发）→ 拉回旧值，红点好几秒才消（用户实测）。 */
  const wasUnread = rows.value.filter((r) => touched.has(r.id) && !r.read_at).length;
  const dec = Math.max(1, wasUnread);
  n.read_at = n.read_at || now;
  rows.value = rows.value.map((r) => (touched.has(r.id) ? { ...r, read_at: r.read_at || now } : r));
  cacheDrop("notif:");     /* 首屏缓存里的未读标记一并作废，下次进来不会又「复活」 */
  /* 分类计数同步减（分栏角标也跟手）；kind → badge 键映射与 notifyRules kindsFor 同口径 */
  const cat = { comment: "comments", reply: "comments", reaction: "reactions", pet: "pets", system: "system" }[n.kind];
  const patch = { notif: Math.max(0, badge.notif - dec) };
  if (cat) patch[cat] = Math.max(0, badge[cat] - dec);
  badgeLocal(patch);
  refreshBadge({ after: markP });
  /* 管理员公告：点开看全文（含长文），并顺带触发当前语言的自动翻译。
   * 举报处理结果（system 但没有正文）没有可展开的内容，保持原来的「点一下 = 已读」。 */
  if (n.kind === "system" && systemBody(n)) {
    openAnnouncement(n);
    return;
  }
  const tg = targetOf(n);
  if (!tg) return;
  if (tg.type === "bottle") router.push({ name: "messagesList", query: { bottle: String(tg.bottleId) } });
  else if (tg.type === "dm") router.push({ name: "messages", params: { id: String(tg.convId) } });
  else if (tg.type === "user") router.push({ name: "waller", params: { id: tg.userId } });  /* #15 摸宠物等 → TA 的主页 */
  /* 轮 241（用户实报）：帖子互动（点赞/抱抱/评论/回应）要进**帖子详情页**，
   * 旧实现兜底跳 /community?post= 落在暖心墙列表 —— 看不到详情，还得自己找那条帖。
   * PostDetailView 可直达（route.params.id + SWR 本地先出图）。 */
  else router.push({ name: "postDetail", params: { id: String(tg.postId) } });
}

async function markAll() {
  const markP = notifyApi.mark({ all: true }).catch(() => { });
  const now = new Date().toISOString();
  rows.value = rows.value.map((r) => ({ ...r, read_at: r.read_at || now }));
  cacheDrop("notif:");      /* 首屏缓存里还存着未读标记，一并作废 */
  /* 轮 254：角标 0ms 清零（全部已读语义），mark 落库后 refreshBadge 校正 */
  badgeLocal({
    notif: 0, comments: 0, reactions: 0, pets: 0, system: 0,
  });
  refreshBadge({ after: markP });
}

async function clearAll() {
  const clearP = notifyApi.clearAll().catch(() => { });
  cacheDrop("notif:");
  load(true);
  badgeLocal({ notif: 0, comments: 0, reactions: 0, pets: 0, system: 0 });
  refreshBadge({ after: clearP });
}

/* 列表上屏 / 切换语言时，把系统公告补翻成当前语言（同一段原文只翻一次） */
watch(
  [shown, () => i18n.locale],
  () => {
    for (const n of shown.value) {
      if (n.kind === "system") ensureBody(n);
    }
  },
  { immediate: true },
);

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

    <!-- 未登录：不报错，给入口（登录后按 ?redirect= 回到本页） -->
    <section v-if="!signedIn" class="card notif-empty">
      <p class="sub">{{ t("notif.needSignIn") }}</p>
      <n-button type="primary" round @click="goSignIn">{{ t("profile.goSignIn") }}</n-button>
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
            <!-- 轮 238 · 公告正文：system 通知的 meta.body 在这里露出（此前模板只有「管理员公告」四个字，用户收了提示看不到内容）。
                 正文按读者当前语言自动翻译；列表只露两行，点整行看全文弹层。 -->
            <p v-if="n.kind === 'system' && systemBody(n)" class="sub notif-quote">{{ bodyFor(n) }}</p>
            <p v-else-if="n.post_body" class="sub notif-quote">{{ n.post_body }}</p>
            <span v-if="n.kind === 'system' && systemBody(n)" class="notif-readfull">
              {{ isTranslating(n) ? t("notif.translating") : t("notif.readFull") }} <span aria-hidden="true">›</span>
            </span>
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

    <!-- 公告全文：长文不再被列表的单行省略号吃掉；点遮罩/关闭/× 都能退出。
         Teleport 到 body —— 通知中心可能挂在带 transform 的容器里（首页三联），
         留在原地会让 position:fixed 的遮罩被包含块裁切。 -->
    <Teleport to="body">
      <div v-if="detail" class="announce-mask" @click.self="detail = null">
        <section class="announce-card" role="dialog" aria-modal="true" :aria-label="t('notif.system')">
          <header class="announce-head">
            <div>
              <p class="announce-kicker">📢 {{ t("notif.system") }}</p>
              <p class="sub announce-time">{{ when(detail.n.created_at) }}</p>
            </div>
            <button class="announce-x" :aria-label="t('common.close')" @click="detail = null">×</button>
          </header>
          <div class="announce-body">{{ detailBody }}</div>
          <p v-if="detailTranslating" class="sub announce-note">{{ t("notif.translating") }}</p>
          <p v-else-if="detailOriginal" class="sub announce-note">{{ t("notif.original") }}</p>
          <footer class="announce-foot">
            <n-button size="small" round type="primary" @click="detail = null">{{ t("common.close") }}</n-button>
          </footer>
        </section>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* 聚合徽标：这行代表同键的 N 条原始通知；点一下整组一起消未读 */
.notif-times {
  flex: none; align-self: center; margin-left: 6px;
  font-size: 11.5px; font-weight: 500; color: var(--ink-soft);
  background: rgba(160, 110, 60, .1); border-radius: 999px; padding: 3px 9px;
}

/* 系统公告：列表里给一个明确的「可点开」信号 */
.notif-readfull {
  display: inline-block; margin-top: 4px;
  font-size: 11.5px; font-weight: 500; color: var(--accent-deep);
}

/* 公告全文弹层（Teleport 到 body） */
.announce-mask {
  position: fixed; inset: 0; z-index: 3000;
  display: flex; align-items: center; justify-content: center;
  padding: 20px;
  background: rgba(28, 20, 14, .46);
  -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px);
}
.announce-card {
  width: min(560px, 100%);
  max-height: min(82vh, 760px);
  display: flex; flex-direction: column;
  padding: 18px 20px 16px;
  border-radius: 24px;
  background: var(--glass-strong, #fffdf9);
  border: 1px solid rgba(160, 110, 60, .16);
  box-shadow: 0 24px 70px rgba(60, 35, 15, .28);
}
.announce-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.announce-kicker { margin: 0; font-size: 14px; font-weight: 600; color: var(--ink); }
.announce-time { margin: 3px 0 0; font-size: 11.5px; }
.announce-x {
  flex: none; width: 32px; height: 32px; border-radius: 999px;
  border: 1px solid rgba(160, 110, 60, .16); background: transparent;
  color: var(--ink-soft); font-size: 20px; line-height: 1; cursor: pointer;
}
.announce-x:hover { background: rgba(160, 110, 60, .08); color: var(--ink); }
.announce-body {
  flex: 1; min-height: 0; overflow-y: auto;
  margin-top: 12px; padding: 2px 2px 12px;
  font-size: 14px; line-height: 1.75; color: var(--ink);
  white-space: pre-wrap; overflow-wrap: anywhere;
}
.announce-note { margin: 0 0 8px; font-size: 11.5px; }
.announce-foot { display: flex; justify-content: flex-end; padding-top: 10px; border-top: 1px solid rgba(160, 110, 60, .12); }

@media (max-width: 640px) {
  .announce-mask { padding: 14px; align-items: flex-end; }
  .announce-card { max-height: 86vh; border-radius: 22px; padding: 16px 16px 14px; }
  .announce-body { font-size: 13.5px; line-height: 1.7; }
}
</style>