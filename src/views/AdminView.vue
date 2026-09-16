<script setup>
/* 管理中心（阶段 2.5）
 * 只是「壳」：能不能进、能看什么、能改什么，全部由数据库的 is_admin()/RLS 把关。
 * 非管理员：is_admin() → false → 只看到「没有权限」，拿不到任何数字。
 */
import { ref, computed, onMounted } from "vue";
import { NButton, NTag } from "naive-ui";
import { t } from "../i18n.js";
import { cloud } from "../utils/supabase.js";
import { db } from "../utils/api/db.js";
import { fmtNum, fmtBytes, clip, dailySeries, barHeights, sumReactions, dayOf } from "../utils/admin.js";

const state = ref("loading"); /* loading | denied | ready | error */
const err = ref("");
const ov = ref(null); /* admin_overview() 的返回 */
const tab = ref("overview");
const posts = ref([]);
const comments = ref([]);
const postsLoaded = ref(false);
const commentsLoaded = ref(false);
const busy = ref(""); /* 正在操作的行 id（防连点） */
const actionMsg = ref("");

const signedIn = computed(() => !!(cloud.ready && cloud.user));

async function load() {
  state.value = "loading";
  err.value = "";
  actionMsg.value = "";
  posts.value = [];
  comments.value = [];
  postsLoaded.value = false;
  commentsLoaded.value = false;
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
onMounted(load);

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

/* ── 派生（脏数据兜底在 admin.js） ── */
const cards = computed(() => {
  const o = ov.value || {};
  return [
    { label: t("admin.cards.users"), value: fmtNum(o.users_total), sub: `${t("admin.cards.usersToday")} ${fmtNum(o.users_today)}` },
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

<!-- __TPL__ -->
