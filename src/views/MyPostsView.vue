<!-- 我的帖子（共有 5）：/my-posts · 最新 10 条，触底自动续载 10 条（与暖心墙同款交互）。
     数据层复用 cloudFetchUserPosts(offset 分页)；下拉刷新 = 重新拉第 0 页。 -->
<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import { useRoute, useRouter } from "vue-router";
import { NButton, NAvatar } from "naive-ui";
import { t } from "../i18n.js";
import { cloud } from "../utils/supabase.js";
import { cloudFetchUserPosts } from "../utils/wall.js";

/* 与暖心墙同款的三种回应（计数只读展示；点卡片回墙里互动） */
const REACTIONS = [
  { key: "hug", tk: "community.reactHug" },
  { key: "warm", tk: "community.reactWarm" },
  { key: "relate", tk: "community.reactRelate" },
];

const router = useRouter();
const route = useRoute();
const uid = computed(() => (cloud.user && cloud.user.id) || "");
const signedIn = computed(() => !!(cloud.ready && cloud.user));

/* 未登录 → 登录页（轮 17 统一口径）：登录成功按 ?redirect= 回到本页，不再只给一行文字 */
function goSignIn() {
  router.push({ path: "/login", query: { redirect: route.fullPath || "/my-posts" } });
}

const rows = ref([]);
const loading = ref(false);
const done = ref(false);          // 全部载完
let offset = 0;
let gen = 0;

const PAGE = 10;
async function load(append) {
  if (!uid.value || loading.value || (append && done.value)) return;
  const run = ++gen;
  loading.value = true;
  try {
    const got = (await cloudFetchUserPosts(uid.value, PAGE, append ? offset : 0)) || [];
    if (run !== gen) return;
    rows.value = append ? [...rows.value, ...got] : got;
    offset = append ? offset + got.length : got.length;
    if (got.length < PAGE) done.value = true;
  } catch (e) {
    if (run === gen && !append) rows.value = [];
  } finally {
    if (run === gen) loading.value = false;
  }
}
async function refresh() { offset = 0; done.value = false; await load(false); }

watch(uid, () => { offset = 0; done.value = false; rows.value = []; load(false); }, { immediate: true });

/* 触底自动续载（IntersectionObserver，与暖心墙同款） */
const sentEl = ref(null);
let io = null;
onMounted(() => {
  if (typeof IntersectionObserver === "undefined") return;
  io = new IntersectionObserver((es) => {
    for (const e of es) if (e.isIntersecting) load(true);
  }, { rootMargin: "420px 0px" });
  if (sentEl.value) io.observe(sentEl.value);
});
watch(rows, async () => {
  if (!io) return;
  const { nextTick } = await import("vue");
  await nextTick();
  if (sentEl.value) { io.unobserve(sentEl.value); io.observe(sentEl.value); }
});
onBeforeUnmount(() => { if (io) io.disconnect(); });

/* 原生下拉刷新（手机端 6 同款）：touchstart 在顶部下拉 → 松手刷新 */
let pullStart = 0, pulling = false;
const pullDist = ref(0);
function ts(e) { if (window.scrollY <= 0) { pullStart = e.touches[0].clientY; pulling = true; } }
function tm(e) {
  if (!pulling) return;
  const d = e.touches[0].clientY - pullStart;
  if (d > 0 && window.scrollY <= 0) pullDist.value = Math.min(90, d);
  else pulling = false;
}
async function te() {
  if (!pulling) return;
  pulling = false;
  if (pullDist.value >= 62) await refresh();
  pullDist.value = 0;
}

function whenPost(ts) { return new Date(ts).toLocaleDateString(); }
function openWall(p) {
  /* 轮 19：独立详情页（完整帖子 + 评论展开），不再跳回暖心墙信息流 */
  if (p.dbId != null) router.push({ path: `/post/${p.dbId}` });
}
</script>

<template>
  <!-- 轮 18：下拉刷新此前写了 ts/tm/te 却从未绑到模板（死代码）＝用户看到「完全没做」。
       现在绑上：顶部下拉 → 松手重拉第 0 页。 -->
  <div class="mypage" @touchstart.passive="ts" @touchmove.passive="tm" @touchend.passive="te">
    <header class="mypage-head">
      <button class="mypage-back" @click="router.back()">←</button>
      <h1>{{ t("profile.myPosts") }}</h1>
      <button class="mypage-refresh" :disabled="loading" @click="refresh">↻</button>
    </header>

    <!-- 未登录：给入口（与其他页同口径，登录后按 ?redirect= 回到本页） -->
    <section v-if="!signedIn" class="card mypage-signin">
      <p class="sub">{{ t("notif.needSignIn") }}</p>
      <n-button type="primary" round @click="goSignIn">{{ t("profile.goSignIn") }}</n-button>
    </section>

    <template v-else>
      <!-- 下拉刷新指示条（手机端 6） -->
      <div class="mypage-pull" :style="{ height: pullDist + 'px', opacity: pullDist / 62 }">↓</div>

      <p v-if="loading && !rows.length" class="card sub">…</p>
      <p v-else-if="!rows.length" class="card sub">{{ t("profile.myPostsEmpty") }}</p>

      <!-- 轮 18：与暖心墙完全同款的帖子卡（头像/署名/时间/全文/配图/回应数/浏览数） -->
      <article
        v-for="p in rows" :key="p.id"
        class="post-card card mypage-post" @click="openWall(p)">
        <div class="post-head">
          <n-avatar round :size="42" class="post-avatar">🙂</n-avatar>
          <div class="post-meta">
            <div class="post-name">{{ p.name }}</div>
            <div class="post-time">{{ whenPost(p.ts) }}</div>
          </div>
          <span class="mypage-go">{{ t("community.viewHome") }} →</span>
        </div>
        <p class="post-text">{{ p.text || "🖼️" }}</p>
        <img v-if="p.img" :src="p.img" class="pic" alt="" />
        <div class="react-row">
          <n-button
            v-for="r in REACTIONS" :key="r.key"
            round size="small" quaternary :focusable="false">
            {{ t(r.tk) }} · {{ (p.reacts && p.reacts[r.key]) || 0 }}
          </n-button>
        </div>
        <div v-if="p.stats" class="post-foot">
          <span class="post-views">{{ t("community.views", { n: p.views || 0 }) }}</span>
        </div>
      </article>

      <div ref="sentEl" class="mypage-sentinel"></div>
      <p v-if="loading && rows.length" class="sub" style="text-align: center">…</p>
      <p v-if="done && rows.length" class="notice" style="text-align: center">
        {{ t("notif.noMore") }}
      </p>
      <p v-if="!done && rows.length && !loading" style="text-align: center">
        <n-button round @click="load(true)">{{ t("notif.more") }}</n-button>
      </p>
    </template>
  </div>
</template>

<style scoped>
.mypage-head { display: flex; align-items: center; gap: 10px; margin: 2px 0 12px; }
.mypage-head h1 { font-size: 20px; margin: 0; flex: 1; }
.mypage-back, .mypage-refresh {
  appearance: none; font: inherit; cursor: pointer;
  min-width: 40px; min-height: 40px; border-radius: 999px;
  border: 1px solid rgba(160, 110, 60, .2); background: rgba(255, 255, 255, .7);
  font-weight: 800; font-size: 16px;
}
.mypage-pull { display: flex; align-items: center; justify-content: center; overflow: hidden; color: var(--ink-soft); transition: height .15s ease; }
.mypage-signin { text-align: center; display: grid; gap: 10px; justify-items: center; padding: 18px 14px; }
.mypage-post { cursor: pointer; }
.mypage-go { font-size: 12px; font-weight: 700; color: var(--ink-faint); white-space: nowrap; }
.mypage-sentinel { height: 4px; }
</style>
