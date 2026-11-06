<!-- 我的关注（独立页 /following，轮447）
     口径：关注 = 我的阅读列表，不是社交关系。
       · 被关注者读不到这份名单（RLS）、也不会收到任何通知 → 页面顶部常驻一句说明，
         否则用户会默认「我关注了他，他应该知道」，然后期待回关，落空后产生怨气；
       · 不显示粉丝数、不做粉丝列表（见 docs/PLAN-wall-follow.md 第一节）；
       · 排序按「最近发帖」倒序 —— 按关注时间排，用户会看到一屏「关注了但再也不发帖的人」。
     ⚠ 本页**故意不进 KeepAlive**（与 FavoritesView 同款）：每次进入都重新拉，
       关注/取关状态永远是新的。 -->
<script setup>
import { ref, computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import { NAvatar, NButton } from "naive-ui";
import { t, i18n } from "../i18n.js";
import { cloud } from "../utils/supabase.js";
import { followState, refreshFollows, unfollowUser, followErrKey } from "../utils/follows.js";
import { avatarUrlFor } from "../utils/avatar.js";
import { fmtWhen } from "../utils/wallRules.js";

const router = useRouter();
const signedIn = computed(() => !!(cloud.ready && cloud.user));
const rows = computed(() => followState.rows);
const loading = ref(false);
const err = ref(false);
const msg = ref("");

/* 两步确认：取关后这个人就从列表里消失了，手滑代价不对称（关注则随时能反悔，不用确认） */
const arm = ref("");
let armTimer = 0;
function askUnfollow(r) {
  if (arm.value !== r.user_id) {
    arm.value = r.user_id;
    clearTimeout(armTimer);
    armTimer = setTimeout(() => { arm.value = ""; }, 4000);
    return;
  }
  doUnfollow(r);
}
async function doUnfollow(r) {
  clearTimeout(armTimer);
  arm.value = "";
  try {
    await unfollowUser(r.user_id);
    msg.value = t("follow.unfollowed");
  } catch (e) {
    const k = followErrKey(e);
    if (k) msg.value = t(k);
  }
  setTimeout(() => { msg.value = ""; }, 2600);
}

async function refresh() {
  loading.value = true;
  err.value = false;
  try {
    await refreshFollows(true);
    err.value = !!followState.error;
  } catch (e) {
    err.value = true;
  } finally {
    loading.value = false;
  }
}
onMounted(refresh);

function openHome(id) {
  if (id) router.push({ path: `/u/${id}` });
}
function goSignIn() {
  router.push({ path: "/login", query: { redirect: "/following" } });
}
const when = (ts) => fmtWhen(ts, i18n.locale);
</script>

<template>
  <div class="followpage">
    <header class="favpage-head">
      <button class="favpage-back" @click="router.back()">←</button>
      <h1>{{ t("follow.listTitle") }}</h1>
      <button class="favpage-refresh" :disabled="loading" :aria-label="t('community.refreshBtn')" @click="refresh">↻</button>
    </header>

    <!-- 整套设计的支点：一句话把「单向、静默」说清楚，消除全部预期差 -->
    <p class="follow-note-card">{{ t("follow.listNote") }}</p>

    <section v-if="!signedIn" class="card favpage-signin">
      <p class="sub">{{ t("notif.needSignIn") }}</p>
      <n-button type="primary" round @click="goSignIn">{{ t("profile.goSignIn") }}</n-button>
    </section>

    <template v-else>
      <p v-if="loading && !rows.length" class="card sub">…</p>

      <section v-else-if="err" class="card favpage-signin">
        <p class="sub">{{ t("follow.feedFail") }}</p>
        <n-button round @click="refresh">{{ t("follow.retry") }}</n-button>
      </section>

      <section v-else-if="!rows.length" class="card favpage-signin">
        <p class="sub">{{ t("follow.listEmpty") }}</p>
        <p class="sub">{{ t("follow.listEmptyHint") }}</p>
        <n-button type="primary" round @click="router.push('/community')">{{ t("follow.browseBtn") }}</n-button>
      </section>

      <template v-else>
        <p v-if="msg" class="follow-flash">{{ msg }}</p>
        <article v-for="r in rows" :key="r.user_id" class="follow-card card" @click="openHome(r.user_id)">
          <n-avatar round :size="44" class="post-avatar" :src="avatarUrlFor(r.user_id) || undefined">
            <template v-if="!avatarUrlFor(r.user_id)" #default>🙂</template>
            <template v-else #fallback>🙂</template>
          </n-avatar>
          <div class="follow-id">
            <div class="follow-name">{{ r.nickname || "Guest" }}</div>
            <div class="follow-sub">
              <span>{{ r.post_count == null ? "—" : t("follow.postsCount", { n: r.post_count }) }}</span>
              <span v-if="r.last_post_at"> · {{ t("follow.lastPost", { d: when(r.last_post_at) }) }}</span>
              <span v-else> · {{ t("follow.neverPosted") }}</span>
            </div>
          </div>
          <button
            class="follow-un" :class="{ armed: arm === r.user_id }"
            :title="arm === r.user_id ? t('follow.unfollowArm') : t('follow.unfollow')"
            @click.stop="askUnfollow(r)">
            {{ arm === r.user_id ? t("follow.unfollowArm") : t("follow.following") }}
          </button>
        </article>
      </template>
    </template>
  </div>
</template>
