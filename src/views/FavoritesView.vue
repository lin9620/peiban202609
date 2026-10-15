<!-- 我的收藏（独立页 /favorites，轮 254）：用户拍板「点我的收藏应该去单独一个页面，
     不要在我的页面下面显示」。
     不跟手修复（同轮）：
       ① 挂载同步先读缓存（profile-favs|uid）—— 上一轮在墙上点收藏时 favCacheInsert
          已写穿进这份缓存 → 0ms 看到刚收藏的帖子；
       ② SWR 后台拉云端校正（缓存先渲染、网络回来覆盖回写）；
       ③ 取消收藏乐观移除 + 缓存同步摘除，失败回滚（不再「点了等一下才消失」）。
     ⚠ 本页**故意不进 KeepAlive**（App.vue keepAliveNames 四页不含它）—— 每次进入
     都重新挂载重跑数据，这正是收藏页该有的语义（列表永远是新的）。 -->
<script setup>
import { ref, watch } from "vue";
import { useRouter } from "vue-router";
import { NButton, NAvatar } from "naive-ui";
import { t, i18n } from "../i18n.js";
import { cloud } from "../utils/supabase.js";
import { cloudFavListMine, cloudFavRemove, favCacheRemove } from "../utils/wall.js";
import { cacheKey, cachePeek, cacheSet, swr } from "../utils/cache.js";
import { getItem } from "../utils/storage.js";
import { avatarUrlFor } from "../utils/avatar.js";
/* 轮 288：帖子时间统一到分（fmtWhen），与暖心墙 / 详情页 / 我的页 / 我的帖子同口径，
 * 并把 locale 传进去（此前默认 zh，英文界面会看到中文日期）。 */
import { fmtWhen } from "../utils/wallRules.js";

/* 轮 288：与 WallerView / PostDetailView 同名同口径的时间文案（到分） */
const when = (ts) => fmtWhen(ts, i18n.locale);
const router = useRouter();
const uid = ref((cloud.user && cloud.user.id) || "");
const signedIn = ref(!!(cloud.ready && cloud.user));
const rows = ref([]);
const loading = ref(false);
const msg = ref("");
let gen = 0;

function showMsg(tk) {
  msg.value = tk;
  setTimeout(() => { msg.value = ""; }, 3200);
}

/* 挂载同步秒出：持久 uid 直读缓存（不等 cloud.ready 的启动间隙，与「我的」页轮 206 同法） */
function bootUid() {
  return getItem("wp-uid") || "";
}
function favKey() {
  const u = uid.value || bootUid();
  return u ? cacheKey("profile-favs", u) : "";
}
(() => {
  const snap = cachePeek(favKey());
  if (snap && Array.isArray(snap)) rows.value = snap.filter((r) => r && r.post);
})();

/* 云端就绪/换号 → SWR：缓存先渲染，网络回来覆盖 + 回写 */
watch(
  () => [cloud.ready, cloud.user && cloud.user.id],
  async ([ready, id]) => {
    uid.value = id || "";
    signedIn.value = !!(ready && id);
    if (!ready || !id) return;
    const run = ++gen;
    loading.value = true;
    const consume = (got) => {
      if (run !== gen || !Array.isArray(got)) return;
      rows.value = got.filter((r) => r && r.post);
      loading.value = false;
      try { const k = favKey(); if (k) cacheSet(k, rows.value); } catch (e) { /* 忽略 */ }
    };
    await swr(
      favKey(),
      { cached: consume, fresh: consume },
      async () => (await cloudFavListMine(50)) || [],
    );
    if (run === gen) loading.value = false;
  },
  { immediate: true },
);

/* 取消收藏：乐观移除（0ms 跟手）+ 缓存同步；失败插回原位并提示 */
async function unFav(dbId) {
  const idx = rows.value.findIndex((r) => r.post && r.post.dbId === dbId);
  if (idx < 0) return;
  const removed = rows.value[idx];
  rows.value = rows.value.filter((r) => r.post.dbId !== dbId);
  favCacheRemove(dbId);
  const ok = await cloudFavRemove(dbId);
  if (!ok) {
    const back = rows.value.slice();
    back.splice(Math.min(idx, back.length), 0, removed);
    rows.value = back;
    try { const k = favKey(); if (k) cacheSet(k, rows.value); } catch (e) { /* 忽略 */ }
    showMsg("fav.fail");
    return;
  }
  showMsg("fav.removed");
}

function goSignIn() {
  router.push({ path: "/login", query: { redirect: "/favorites" } });
}
function openPost(dbId) {
  router.push({ path: `/post/${dbId}` });
}
function refresh() {
  const run = ++gen;
  loading.value = true;
  cloudFavListMine(50).then((got) => {
    if (run !== gen) return;
    rows.value = (got || []).filter((r) => r && r.post);
    try { const k = favKey(); if (k) cacheSet(k, rows.value); } catch (e) { /* 忽略 */ }
    loading.value = false;
  }).catch(() => { if (run === gen) loading.value = false; });
}
</script>

<template>
  <div class="favpage">
    <header class="favpage-head">
      <button class="favpage-back" @click="router.back()">←</button>
      <h1>{{ t("fav.title") }}</h1>
      <button class="favpage-refresh" :disabled="loading" :aria-label="t('community.refreshBtn')" @click="refresh">↻</button>
    </header>

    <!-- 未登录：与其他页同口径（登录后按 ?redirect= 回本页） -->
    <section v-if="!signedIn" class="card favpage-signin">
      <p class="sub">{{ t("notif.needSignIn") }}</p>
      <n-button type="primary" round @click="goSignIn">{{ t("profile.goSignIn") }}</n-button>
    </section>

    <template v-else>
      <p v-if="loading && !rows.length" class="card sub">…</p>
      <p v-else-if="!rows.length" class="card sub">{{ t("fav.empty") }}</p>

      <article
        v-for="r in rows" :key="r.post.dbId"
        class="post-card card favpage-card" @click="openPost(r.post.dbId)">
        <div class="post-head">
          <n-avatar round :size="42" class="post-avatar"
            :src="avatarUrlFor(r.post.userId) || undefined">
            <template v-if="!avatarUrlFor(r.post.userId)" #default>🙂</template>
            <template v-else #fallback>🙂</template>
          </n-avatar>
          <div class="post-meta">
            <div class="post-name">{{ r.post.name }}</div>
            <div class="post-time">{{ when(r.post.ts) }}</div>
          </div>
        </div>
        <p class="post-text">{{ r.post.text || "🖼️" }}</p>
        <img loading="lazy" v-if="r.post.img" :src="r.post.img" class="pic" alt="" />
        <div class="favpage-foot">
          <span v-if="msg" class="favpage-msg">{{ t(msg) }}</span>
          <button class="favpage-unfav" @click.stop="unFav(r.post.dbId)">
            {{ t("fav.remove") }}
          </button>
        </div>
      </article>
    </template>
  </div>
</template>

<style scoped>
.favpage-head { display: flex; align-items: center; gap: 10px; margin: 2px 0 12px; }
.favpage-head h1 { font-size: 20px; margin: 0; flex: 1; }
.favpage-back, .favpage-refresh {
  appearance: none; font: inherit; cursor: pointer;
  min-width: 40px; min-height: 40px; border-radius: 999px;
  border: 1px solid rgba(160, 110, 60, .2); background: rgba(255, 255, 255, .7);
  font-weight: 500; font-size: 16px;
}
.favpage-signin { text-align: center; display: grid; gap: 10px; justify-items: center; padding: 18px 14px; }
.favpage-card { cursor: pointer; }
.favpage-foot { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
.favpage-msg { font-size: 12px; font-weight: 600; color: var(--good); }
.favpage-unfav {
  margin-left: auto; appearance: none; font: inherit; cursor: pointer;
  padding: 6px 14px; border-radius: 999px;
  border: 1px solid rgba(160, 110, 60, .25);
  background: transparent; color: var(--ink-soft);
  font-size: 12.5px; font-weight: 500;
  transition: all .18s ease;
}
.favpage-unfav:hover { color: var(--low); border-color: var(--low); }
html[data-theme="night"] .favpage-back, html[data-theme="night"] .favpage-refresh {
  background: rgba(30, 35, 64, .6); border-color: rgba(255, 255, 255, .14);
}
</style>
