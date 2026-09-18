<script setup>
/* 管理中心（阶段 2.5）
 * 只是「壳」：能不能进、能看什么、能改什么，全部由数据库的 is_admin()/RLS 把关。
 * 非管理员：is_admin() → false → 只看到「没有权限」，拿不到任何数字。
 */
import { ref, computed, watch } from "vue";
import { useRouter } from "vue-router";
import { NButton, NTag } from "naive-ui";
import { t } from "../i18n.js";
import { cloud } from "../utils/supabase.js";
import { db } from "../utils/api/db.js";
import { fmtNum, fmtBytes, clip, dailySeries, barHeights, sumReactions, dayOf, dayTimeOf } from "../utils/admin.js";

const state = ref("loading"); /* loading | denied | ready | error */
const err = ref("");
const ov = ref(null); /* admin_overview() 的返回 */
const tab = ref("overview");
const posts = ref([]);
const comments = ref([]);
const postsLoaded = ref(false);
const commentsLoaded = ref(false);
/* 用户页签：全量名单分页（100/页，最新在前）；邮箱只在 DB 侧 RPC 里 join auth.users 提供 */
const USERS_PAGE = 100;
const users = ref([]);
const usersLoaded = ref(false);
const usersOffset = ref(0);
const usersTotal = ref(0);
const busy = ref(""); /* 正在操作的行 id（防连点） */
const actionMsg = ref("");
const router = useRouter(); /* #20 帖子行点入：跳到暖心墙原帖 */

const signedIn = computed(() => !!(cloud.ready && cloud.user));

async function load() {
  state.value = "loading";
  err.value = "";
  actionMsg.value = "";
  posts.value = [];
  comments.value = [];
  postsLoaded.value = false;
  commentsLoaded.value = false;
  users.value = [];
  usersLoaded.value = false;
  usersOffset.value = 0;
  usersTotal.value = 0;
  tab.value = "overview";
  if (!signedIn.value) {
    state.value = "denied";
    return;
  }
  try {
    const me = await db.amAdmin();
    if (me !== true) {
      state.value = "denied";
      return;
    }
    ov.value = await db.adminOverview();
    if (!ov.value || ov.value.admin !== true) {
      state.value = "denied";
      return;
    }
    state.value = "ready";
  } catch (e) {
    state.value = "error";
    err.value = (e && e.message) || "error";
  }
}
/* 跟随登录态：直接打开 /admin（书签 / 刷新）时 Auth 可能还没就绪 —— 就绪后自动加载；
 * 确认未登录时显示「没有权限」（保持与旧 onMounted 版本一致的语义） */
watch(signedIn, (ok) => {
  if (ok) load();
  else state.value = "denied";
}, { immediate: true });

function fail(e) {
  actionMsg.value = t("admin.fail", { r: (e && e.message) || "" });
}

/* ── 治理列表（按需拉取） ── */
async function loadPosts() {
  try {
    posts.value = (await db.adminListPosts(50)) || [];
    postsLoaded.value = true;
  } catch (e) {
    fail(e);
  }
}
async function loadComments() {
  try {
    comments.value = (await db.adminListComments(100)) || [];
    commentsLoaded.value = true;
  } catch (e) {
    fail(e);
  }
}
function switchTab(name) {
  tab.value = name;
  if (name === "posts" && !postsLoaded.value) loadPosts();
  if (name === "comments" && !commentsLoaded.value) loadComments();
  if (name === "users" && !usersLoaded.value) loadUsers(0);
}

/* —— 全员公告：走 db.adminBroadcast（RPC 内再查一次 is_admin，前端只是壳） —— */
const announce = ref("");
async function sendBroadcast() {
  const text = announce.value.trim();
  if (!text || busy.value !== "") return;
  busy.value = "broadcast";
  try {
    const r = await db.adminBroadcast(text);
    if (!r || r.admin === false) {
      actionMsg.value = t("admin.broadcast.denied");
    } else {
      actionMsg.value = t("admin.broadcast.done", { n: r.sent || 0 });
      announce.value = "";
    }
  } catch (e) {
    actionMsg.value = t("admin.broadcast.fail", { r: (e && e.message) || "" });
  }
  busy.value = "";
}

/* ── 治理动作 ── */
async function setRemoved(p, removed) {
  if (busy.value) return;
  busy.value = p.id;
  actionMsg.value = "";
  try {
    await db.adminSetPostRemoved(p.id, removed);
    p.removed = removed;
  } catch (e) {
    fail(e);
  } finally {
    busy.value = "";
  }
}
async function delPost(p) {
  if (busy.value) return;
  if (!window.confirm(t("admin.actions.confirmDel"))) return;
  busy.value = p.id;
  actionMsg.value = "";
  try {
    await db.adminDeletePost(p.id);
    posts.value = posts.value.filter((x) => x.id !== p.id);
  } catch (e) {
    fail(e);
  } finally {
    busy.value = "";
  }
}
async function delComment(c) {
  if (busy.value) return;
  busy.value = c.id;
  actionMsg.value = "";
  try {
    await db.adminDeleteComment(c.id);
    comments.value = comments.value.filter((x) => x.id !== c.id);
  } catch (e) {
    fail(e);
  } finally {
    busy.value = "";
  }
}

/* ── 用户名单（分页 100/页，最新在前） ── */
async function loadUsers(offset = usersOffset.value) {
  try {
    const r = await db.adminUsersPage(offset, USERS_PAGE);
    if (!r || r.admin !== true) throw new Error("denied");
    users.value = Array.isArray(r.users) ? r.users : [];
    usersTotal.value = Number(r.total) || 0;
    usersOffset.value = offset;
    usersLoaded.value = true;
  } catch (e) {
    fail(e);
  }
}
function pageUsers(delta) {
  const next = usersOffset.value + delta * USERS_PAGE;
  if (next < 0 || (delta > 0 && next >= usersTotal.value)) return;
  loadUsers(next);
}
const usersRange = computed(() => ({
  a: usersTotal.value > 0 ? usersOffset.value + 1 : 0,
  b: Math.min(usersOffset.value + USERS_PAGE, usersTotal.value),
}));

/* ── 派生（脏数据兜底在 admin.js） ── */
const cards = computed(() => {
  const o = ov.value || {};
  return [
    { label: t("admin.cards.users"), value: fmtNum(o.users_total), sub: `${t("admin.cards.usersToday")} ${fmtNum(o.users_today)}`, clickable: true },
    { label: t("admin.cards.posts"), value: fmtNum(o.posts_total), sub: `${t("admin.cards.postsToday")} ${fmtNum(o.posts_today)} · ${t("admin.cards.removed")} ${fmtNum(o.posts_removed)}` },
    { label: t("admin.cards.comments"), value: fmtNum(o.comments_total), sub: `${t("admin.cards.commentsToday")} ${fmtNum(o.comments_today)}` },
    { label: t("admin.cards.views"), value: fmtNum(o.views_total), sub: "" },
    { label: t("admin.cards.pets"), value: fmtNum(o.pets_total), sub: `${t("admin.cards.pats")} ${fmtNum(o.pats_total)} · ${t("admin.cards.feeds")} ${fmtNum(o.feeds_total)}` },
    { label: t("admin.cards.storage"), value: fmtBytes(o.storage_bytes), sub: `${fmtNum(o.storage_objects)} files` },
  ];
});
const react = computed(() => sumReactions(ov.value && ov.value.reactions));
const trend = computed(() => dailySeries(ov.value && ov.value.daily, 14));
const trends = computed(() => [
  { label: t("admin.trend.posts"), bars: barHeights(trend.value, "posts") },
  { label: t("admin.trend.users"), bars: barHeights(trend.value, "users") },
  { label: t("admin.trend.comments"), bars: barHeights(trend.value, "comments") },
]);
const topPosts = computed(() => (Array.isArray(ov.value && ov.value.top_posts) ? ov.value.top_posts : []));
const recentUsers = computed(() => (Array.isArray(ov.value && ov.value.recent_users) ? ov.value.recent_users : []));
</script>

<template>
  <div class="admin-page">
    <!-- 非 ready 的三个状态：加载 / 无权限 / 出错 -->
    <section v-if="state === 'loading'" class="card admin-msg">{{ t("admin.loading") }}</section>

    <section v-else-if="state === 'denied'" class="card admin-msg">{{ t("admin.denied") }}</section>

    <section v-else-if="state === 'error'" class="card admin-msg">
      <div>{{ t("admin.fail", { r: err }) }}</div>
      <div style="margin-top: 12px">
        <n-button size="small" round @click="load">{{ t("admin.refresh") }}</n-button>
      </div>
    </section>

    <!-- ready：头卡（标题 + 页签 + 刷新）+ 页签内容 -->
    <template v-else-if="state === 'ready'">
      <section class="card">
        <div class="row-between">
          <h2 style="margin-bottom: 0">{{ t("admin.title") }}</h2>
          <n-button quaternary size="small" :disabled="busy !== ''" @click="load">
            {{ t("admin.refresh") }}
          </n-button>
        </div>
        <div class="admin-tabs">
          <button
            v-for="x in ['overview', 'posts', 'comments']" :key="x"
            class="admin-tab" :class="{ on: tab === x }"
            @click="switchTab(x)">
            {{ t(`admin.tabs.${x}`) }}
          </button>
        </div>
        <p v-if="actionMsg" class="notice" style="margin: 12px 0 0">{{ actionMsg }}</p>
      </section>

      <!-- ── 页签：总览 ── -->
      <template v-if="tab === 'overview'">
        <div class="admin-cards">
          <div
            v-for="c in cards" :key="c.label"
            class="card admin-card" :class="{ click: c.clickable }"
            :title="c.clickable ? t('admin.tabs.users') : undefined"
            @click="c.clickable && switchTab('users')">
            <b>{{ c.value }}</b>
            <span class="admin-card-label">{{ c.label }}</span>
            <span v-if="c.sub" class="admin-card-sub">{{ c.sub }}</span>
          </div>
        </div>

        <div class="admin-grid2">
          <section class="card" style="margin-bottom: 0">
            <h2>{{ t("admin.react.title") }}</h2>
            <div
              v-for="k in ['hug', 'warm', 'relate', 'dislike']" :key="k"
              class="admin-react-row">
              <span class="admin-react-label">{{ t(`admin.react.${k}`) }}</span>
              <span class="admin-bar-track">
                <i :style="{ width: (react.total ? Math.round((react[k] / react.total) * 100) : 0) + '%' }"></i>
              </span>
              <span class="admin-react-n">{{ fmtNum(react[k]) }}</span>
            </div>
          </section>

          <section class="card" style="margin-bottom: 0">
            <h2>{{ t("admin.trend.title") }}</h2>
            <div v-for="g in trends" :key="g.label" class="admin-trend">
              <span class="admin-trend-label">{{ g.label }}</span>
              <div class="admin-bars">
                <i v-for="(b, i) in g.bars" :key="i" :style="{ height: b.h + '%' }" :title="String(b.v)"></i>
              </div>
            </div>
          </section>
        </div>

        <div class="admin-grid2" style="margin-top: 18px">
          <!-- 全员公告：写入 notifications(kind=system)，所有人通知中心可见（RPC 复用 is_admin()） -->
          <section class="card" style="margin-bottom: 0">
            <h2>{{ t("admin.broadcast.title") }}</h2>
            <p class="sub">{{ t("admin.broadcast.hint") }}</p>
            <n-input
              v-model:value="announce" type="textarea" :rows="3" :maxlength="1000"
              :placeholder="t('admin.broadcast.ph')" />
            <div class="row-between" style="margin-top: 10px">
              <span class="sub" style="margin: 0">{{ t("admin.broadcast.count", { n: announce.length }) }}</span>
              <n-button type="primary" size="small" round
                :disabled="!announce.trim() || busy !== ''" @click="sendBroadcast">
                {{ t("admin.broadcast.send") }}
              </n-button>
            </div>
          </section>

          <section class="card" style="margin-bottom: 0">
            <h2>{{ t("admin.top.title") }}</h2>
            <p v-if="!topPosts.length" class="sub">{{ t("admin.empty") }}</p>
            <div v-for="p in topPosts" :key="p.id" class="admin-row">
              <div class="admin-grow">
                <div class="admin-clip">{{ clip(p.body, 60) || "…" }}</div>
                <span class="admin-meta">
                  {{ p.author_name || "?" }} · {{ fmtNum(p.views) }} {{ t("admin.top.views") }} ·
                  {{ fmtNum(p.reactions) }} {{ t("admin.top.react") }}<template v-if="dayOf(p.created_at)"> · {{ dayOf(p.created_at) }}</template>
                </span>
              </div>
              <n-tag v-if="p.removed" size="small" round :bordered="false" type="error">
                {{ t("admin.status.removed") }}
              </n-tag>
            </div>
          </section>

          <section class="card" style="margin-bottom: 0">
            <h2>{{ t("admin.recent.title") }}</h2>
            <p v-if="!recentUsers.length" class="sub">{{ t("admin.empty") }}</p>
            <div v-for="u in recentUsers" :key="u.id" class="admin-row">
              <div class="admin-grow">
                <div class="admin-clip">{{ u.nickname || "?" }}</div>
                <span class="admin-meta">
                  {{ t("admin.recent.posts", { n: fmtNum(u.posts) }) }}<template v-if="dayOf(u.created_at)"> · {{ dayOf(u.created_at) }}</template>
                </span>
              </div>
            </div>
          </section>
        </div>
      </template>
      <!-- ── 页签：帖子治理（下架 / 恢复 / 删除） ── -->
      <section v-else-if="tab === 'posts'" class="card">
        <div class="row-between">
          <h2 style="margin-bottom: 0">{{ t("admin.tabs.posts") }}</h2>
          <n-button quaternary size="small" :disabled="busy !== ''" @click="loadPosts">
            {{ t("admin.refresh") }}
          </n-button>
        </div>
        <p v-if="!posts.length" class="sub" style="margin-top: 12px">
          {{ postsLoaded ? t("admin.empty") : t("admin.loading") }}
        </p>
        <div v-for="p in posts" :key="p.id" class="admin-row">
          <img v-if="p.image_path" :src="db.imageUrl(p.image_path)" class="admin-thumb" alt="" />
          <div
            class="admin-grow admin-open" :title="t('admin.actions.openPost')"
            @click="router.push({ path: '/community', query: { post: String(p.id) } })">
            <div class="admin-clip">{{ clip(p.body, 80) || "…" }}</div>
            <span class="admin-meta">
              {{ p.author_name || "?" }} · {{ fmtNum(p.views) }} {{ t("admin.postsCol.views") }} ·
              {{ t("admin.postsCol.at") }} {{ dayOf(p.created_at) }}
            </span>
          </div>
          <n-tag v-if="p.removed" size="small" round :bordered="false" type="error">
            {{ t("admin.status.removed") }}
          </n-tag>
          <n-tag v-else size="small" round :bordered="false" class="soft-tag">
            {{ t("admin.status.live") }}
          </n-tag>
          <div class="admin-actions">
            <n-button v-if="!p.removed" size="tiny" quaternary :disabled="busy !== ''" @click="setRemoved(p, true)">
              {{ t("admin.actions.takedown") }}
            </n-button>
            <n-button v-else size="tiny" quaternary :disabled="busy !== ''" @click="setRemoved(p, false)">
              {{ t("admin.actions.restore") }}
            </n-button>
            <n-button size="tiny" quaternary type="error" :disabled="busy !== ''" @click="delPost(p)">
              {{ t("admin.actions.del") }}
            </n-button>
          </div>
        </div>
      </section>

      <!-- ── 页签：评论治理（删除） ── -->
      <section v-else-if="tab === 'comments'" class="card">
        <div class="row-between">
          <h2 style="margin-bottom: 0">{{ t("admin.tabs.comments") }}</h2>
          <n-button quaternary size="small" :disabled="busy !== ''" @click="loadComments">
            {{ t("admin.refresh") }}
          </n-button>
        </div>
        <p v-if="!comments.length" class="sub" style="margin-top: 12px">
          {{ commentsLoaded ? t("admin.empty") : t("admin.loading") }}
        </p>
        <div v-for="c in comments" :key="c.id" class="admin-row">
          <div class="admin-grow">
            <div class="admin-clip">{{ clip(c.body, 90) || "…" }}</div>
            <span class="admin-meta">
              {{ c.author_name || "?" }} · {{ t("admin.commentsCol.post") }} {{ String(c.post_id || "").slice(0, 8) }}
              <template v-if="dayOf(c.created_at)"> · {{ dayOf(c.created_at) }}</template>
            </span>
          </div>
          <n-button size="tiny" quaternary type="error" :disabled="busy !== ''" @click="delComment(c)">
            {{ t("admin.actions.del") }}
          </n-button>
        </div>
      </section>

      <!-- ── 页签：用户名单（点总览的「用户」卡进入；100/页，最新在前） ── -->
      <section v-else-if="tab === 'users'" class="card">
        <div class="row-between">
          <h2 style="margin-bottom: 0">{{ t("admin.tabs.users") }}</h2>
          <n-button quaternary size="small" @click="loadUsers()">
            {{ t("admin.refresh") }}
          </n-button>
        </div>
        <p v-if="!users.length" class="sub" style="margin-top: 12px">
          {{ usersLoaded ? t("admin.empty") : t("admin.loading") }}
        </p>
        <div v-else class="admin-row admin-users-head">
          <span class="admin-grow">{{ t("admin.usersCol.nick") }}</span>
          <span class="admin-u-mail">{{ t("admin.usersCol.email") }}</span>
          <span class="admin-u-id">{{ t("admin.usersCol.uid") }}</span>
          <span class="admin-u-at">{{ t("admin.usersCol.at") }}</span>
        </div>
        <div v-for="u in users" :key="u.id" class="admin-row">
          <span class="admin-grow admin-clip">{{ u.nickname || "?" }}</span>
          <span class="admin-u-mail admin-clip" :title="u.email || ''">{{ u.email || "—" }}</span>
          <span class="admin-u-id admin-clip" :title="u.id">{{ u.id }}</span>
          <span class="admin-u-at">{{ dayTimeOf(u.created_at) }}</span>
        </div>
        <div v-if="usersTotal > 0" class="admin-page-bar">
          <n-button size="tiny" quaternary :disabled="usersOffset <= 0" @click="pageUsers(-1)">
            {{ t("admin.page.prev") }}
          </n-button>
          <span class="admin-page-info">
            {{ t("admin.page.info", { a: usersRange.a, b: usersRange.b, n: fmtNum(usersTotal) }) }}
          </span>
          <n-button size="tiny" quaternary :disabled="usersOffset + USERS_PAGE >= usersTotal" @click="pageUsers(1)">
            {{ t("admin.page.next") }}
          </n-button>
        </div>
      </section>
    </template>
  </div>
</template>
