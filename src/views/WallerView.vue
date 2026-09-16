<!-- 墙上的主页：/u/:id —— 点暖心墙的头像/昵称进来，看 TA 的帖子与收到的温暖 -->
<script setup>
import { ref, computed, onMounted } from "vue";
import { useRoute } from "vue-router";
import { NAvatar } from "naive-ui";
import { t, i18n } from "../i18n.js";
import { cloudFetchProfile, cloudFetchUserPosts } from "../utils/wall.js";
import { visibleOnly } from "../utils/wallRules.js";

const route = useRoute();
const uid = String(route.params.id || "");

const prof = ref(null);        // profiles 行：{ nickname, created_at }
const posts = ref([]);         // TA 的帖子（已排除下架的）
const loading = ref(true);
const failed = ref(false);     // 档案与帖子都拿不到才算真失败

/* 昵称：档案优先，档案缺失时用最新一帖的署名兜底 */
const name = computed(() =>
  (prof.value && prof.value.nickname) ||
  (posts.value[0] && posts.value[0].name) || "Guest");
const initial = computed(() => name.value.slice(0, 1).toUpperCase());

const joinedAt = computed(() => {
  const iso = prof.value && prof.value.created_at;
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
});

const when = (ts) =>
  new Date(ts).toLocaleDateString(i18n.locale === "zh" ? "zh-CN" : "en-US",
    { year: "numeric", month: "short", day: "numeric" });

/* 收到的温暖：TA 帖子上的真实回应求和（不掺别人的，不算浏览；统计窗口为最近 50 条帖子） */
const sumOf = (kind) =>
  posts.value.reduce((n, p) => n + ((p.reacts && p.reacts[kind]) || 0), 0);

onMounted(async () => {
  if (!uid) { failed.value = true; loading.value = false; return; }
  const [pf, ps] = await Promise.all([cloudFetchProfile(uid), cloudFetchUserPosts(uid)]);
  if (pf === null && ps === null) failed.value = true;
  prof.value = pf || { nickname: "", created_at: null };
  posts.value = visibleOnly(ps || []);
  loading.value = false;
});
</script>

<template>
  <div class="waller">
    <!-- 主页头：头像 + 昵称 + 加入时间 -->
    <section class="card waller-head">
      <n-avatar round :size="72" class="post-avatar">
        {{ failed ? "?" : loading ? "…" : initial }}
      </n-avatar>
      <div class="waller-id">
        <span class="sec-label">{{ t("waller.title") }}</span>
        <h2 v-if="failed" style="margin: 2px 0 0">{{ t("waller.loadFail") }}</h2>
        <h2 v-else style="margin: 2px 0 0">{{ loading ? "…" : name }}</h2>
        <p v-if="!failed && joinedAt" class="sub" style="margin: 4px 0 0">
          &#128062; {{ t("waller.joined", { d: joinedAt }) }}
        </p>
      </div>
    </section>

    <!-- 收到的温暖（来自 TA 帖子上的真实回应） -->
    <div v-if="!failed && !loading" class="waller-stats">
      <div class="card stat"><b>{{ posts.length }}</b><span>{{ t("waller.posts") }}</span></div>
      <div class="card stat"><b>{{ sumOf("hug") }}</b><span>{{ t("waller.hugs") }}</span></div>
      <div class="card stat"><b>{{ sumOf("warm") }}</b><span>{{ t("waller.warms") }}</span></div>
      <div class="card stat"><b>{{ sumOf("relate") }}</b><span>{{ t("waller.relates") }}</span></div>
    </div>

    <!-- TA 的帖子（只读展示；下架的不显示） -->
    <template v-if="!failed">
      <article v-for="p in posts" :key="p.id" class="post-card card">
        <div class="post-head">
          <n-avatar round :size="40" class="post-avatar">{{ initial }}</n-avatar>
          <div class="post-meta">
            <div class="post-name">{{ name }}</div>
            <div class="post-time">{{ when(p.ts) }}</div>
          </div>
        </div>
        <p class="post-text" v-if="p.text">{{ p.text }}</p>
        <img v-if="p.img" :src="p.img" class="pic" alt="" />
        <div class="react-row">
          <span class="r-chip">&#129726; {{ p.reacts.hug || 0 }}</span>
          <span class="r-chip">&#9728;&#65039; {{ p.reacts.warm || 0 }}</span>
          <span class="r-chip">&#129309; {{ p.reacts.relate || 0 }}</span>
          <span v-if="p.stats" class="r-chip r-chip-views">
            &#128065; {{ t("community.views", { n: p.views || 0 }) }}
          </span>
        </div>
      </article>
      <p v-if="!loading && !posts.length" class="sub waller-empty">{{ t("waller.empty") }}</p>
    </template>

    <router-link class="waller-back" to="/community">&#8592; {{ t("nav.community") }}</router-link>
  </div>
</template>
