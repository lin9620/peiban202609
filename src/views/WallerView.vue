<!-- 墙上的主页：/u/:id —— 点暖心墙的头像/昵称进来，看 TA 的帖子、宠物与手绘厨房（访客可互动） -->
<script setup>
import { ref, computed, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { NAvatar } from "naive-ui";
import { t, i18n } from "../i18n.js";
import {
  cloudFetchProfile, cloudFetchUserPosts, cloudGetPetHome, cloudPetInteract,
} from "../utils/wall.js";
import { visibleOnly, ANON_KEY, fmtWhen } from "../utils/wallRules.js";
import { scopeGetRaw } from "../utils/userScope.js";
import { cloud } from "../utils/supabase.js";
import { openConv } from "../utils/dm.js";
import { sendErrKey } from "../utils/dmRules.js";
import { jump } from "../stores/petStore.js";
import { STATUS_KEYS, statusFresh } from "../utils/statuses.js";
import PetMotion from "../components/PetMotion.vue";

const route = useRoute();
const uid = String(route.params.id || "");

/* —— 发私信：登录且不是自己的主页才显示；点一下开/建会话再跳进对话 —— */
const router = useRouter();
const dmBusy = ref(false);
const dmMsg = ref("");
const isSelf = computed(() => !!(cloud.user && cloud.user.id === uid));
const canDm = computed(() => !!(cloud.ready && cloud.user && uid && !isSelf.value));

async function startDm() {
  if (dmBusy.value || !canDm.value) return;
  dmBusy.value = true;
  dmMsg.value = "";
  try {
    const convId = await openConv(uid);
    if (convId) router.push({ name: "messages", params: { id: String(convId) } });
    else dmMsg.value = t("dm.errNetwork");
  } catch (e) {
    dmMsg.value = t(sendErrKey(e));
  }
  dmBusy.value = false;
}

const prof = ref(null);        // profiles 行：{ nickname, created_at, status, status_at }
const posts = ref([]);         // TA 的帖子（已排除下架的）
const loading = ref(true);
const failed = ref(false);     // 档案与帖子都拿不到才算真失败

const petHome = ref(null);     // 云端宠物主页：{ pet, dishes, counts }；null = 云端不可用（未迁移等）
const interactBusy = ref(false);
const interactMsg = ref("");

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

/* 大厅状态徽章：TA 在陪你大厅选的状态，近 24h 内有效（过期自动隐去） */
const profStatus = computed(() => {
  const p = prof.value;
  return p && p.status && statusFresh(p.status_at) ? p.status : "";
});
const statusLabel = (k) => (STATUS_KEYS.includes(k) ? t("home.companions." + k) : (k || ""));

const when = (ts) => fmtWhen(ts, i18n.locale);   /* #25 帖子时间显示到分钟 */

/* 收到的温暖：TA 帖子上的真实回应求和（不掺别人的，不算浏览；统计窗口为最近 50 条帖子） */
const sumOf = (kind) =>
  posts.value.reduce((n, p) => n + ((p.reacts && p.reacts[kind]) || 0), 0);

/* 访客标识：登录用户交给服务端认 uid；游客用本机匿名 id（互动每天每类一次的键）。
 * 匿名 id 按账号域存（轮 32）——只有游客态会走到这行，实际恒落 guest 域。 */
function viewerKey() {
  if (cloud.user && cloud.user.id) return cloud.user.id;
  return scopeGetRaw(ANON_KEY) || "";   /* localStorage 不可用时 scopeGetRaw 自行兜底为空 */
}

/* 摸摸头 / 投喂：动画每次都放；计数由服务端按「访客+日+类型」去重后累加 */
async function interact(kind, dishName = "") {
  if (interactBusy.value || !petHome.value) return;
  interactBusy.value = true;
  jump(); /* 复用全站的开心跳跃动画 */
  const r = await cloudPetInteract(uid, kind, viewerKey());
  if (r) {
    petHome.value.counts = { pats: r.pats, feeds: r.feeds };
    interactMsg.value = !r.counted
      ? t("waller.alreadyToday")
      : kind === "feed" && dishName
        ? t("waller.feedDone", { n: dishName })
        : t("waller.patDone");
  } else {
    interactMsg.value = t("waller.petFail");
  }
  interactBusy.value = false;
  setTimeout(() => { interactMsg.value = ""; }, 3200);
}

onMounted(async () => {
  if (!uid) { failed.value = true; loading.value = false; return; }
  const [pf, ps, ph] = await Promise.all([
    cloudFetchProfile(uid), cloudFetchUserPosts(uid), cloudGetPetHome(uid),
  ]);
  if (pf === null && ps === null) failed.value = true;
  prof.value = pf || { nickname: "", created_at: null };
  posts.value = visibleOnly(ps || []);
  petHome.value = ph; /* null = 未迁移/查询失败 → 区块显示「准备中」；pet 为空 → 「还没带宠物来」 */
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
        <!-- 陪你大厅状态：TA 近 24h 内在大厅选的状态（没设/过期都不显示） -->
        <span v-if="profStatus" class="waller-status">
          {{ statusLabel(profStatus) }}
        </span>
        <!-- 发私信：登录且非本人主页才有；失败原因按 dmRules.sendErrKey 映射 -->
        <div v-if="!failed && !loading && canDm" class="waller-dm">
          <button class="waller-act" :disabled="dmBusy" @click="startDm">✉️ {{ t("dm.sendTo") }}</button>
          <span v-if="dmMsg" class="sub" style="margin: 6px 0 0">{{ dmMsg }}</span>
        </div>
      </div>
    </section>

    <!-- 收到的温暖（来自 TA 帖子上的真实回应） -->
    <div v-if="!failed && !loading" class="waller-stats">
      <div class="card stat"><b>{{ posts.length }}</b><span>{{ t("waller.posts") }}</span></div>
      <div class="card stat"><b>{{ sumOf("hug") }}</b><span>{{ t("waller.hugs") }}</span></div>
      <div class="card stat"><b>{{ sumOf("warm") }}</b><span>{{ t("waller.warms") }}</span></div>
      <div class="card stat"><b>{{ sumOf("relate") }}</b><span>{{ t("waller.relates") }}</span></div>
    </div>

    <!-- TA 的伙伴（访客可以摸摸头 / 投喂；数据是主人登录后自动镜像的公开快照） -->
    <section v-if="!failed && !loading && petHome" class="card waller-pet">
      <span class="sec-label">{{ t("waller.petTitle") }}</span>
      <template v-if="petHome.pet">
        <div class="waller-pet-stage">
          <PetMotion :pet="{ species: petHome.pet.species, name: petHome.pet.name, sleeping: false, custom: petHome.pet.custom }" />
        </div>
        <div class="waller-pet-meta">
          <b>{{ petHome.pet.name }}</b>
          <span class="waller-lv">{{ t("waller.petLevel", { n: petHome.pet.level }) }}</span>
        </div>
        <div class="waller-pet-acts">
          <button class="waller-act" :disabled="interactBusy" @click="interact('pat')">{{ t("waller.pat") }}</button>
          <button class="waller-act" :disabled="interactBusy" @click="interact('feed')">{{ t("waller.feed") }}</button>
        </div>
        <p class="sub waller-pet-counts">
          {{ t("waller.pats", { n: petHome.counts.pats }) }} &#183; {{ t("waller.feeds", { n: petHome.counts.feeds }) }}
        </p>
        <p v-if="interactMsg" class="sub waller-interact-msg">{{ interactMsg }}</p>
      </template>
      <p v-else class="sub waller-empty">{{ t("waller.petNone") }}</p>
    </section>
    <p v-else-if="!failed && !loading" class="sub waller-empty">{{ t("waller.petUnavailable") }}</p>

    <!-- TA 的手绘厨房：点一道菜就等于投喂（互动与摸摸头同一天只各计一次） -->
    <section v-if="!failed && !loading && petHome && petHome.dishes.length" class="card waller-kitchen">
      <span class="sec-label">{{ t("waller.kitchen") }}</span>
      <div class="dish-grid">
        <figure v-for="d in petHome.dishes" :key="d.id" class="dish-card">
          <img :src="d.img" :alt="d.name" loading="lazy" draggable="false" />
          <figcaption>{{ d.name }}</figcaption>
          <button class="dish-feed" :disabled="interactBusy" @click="interact('feed', d.name)">
            {{ t("waller.feed") }}
          </button>
        </figure>
      </div>
    </section>

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
            {{ t("community.views", { n: p.views || 0 }) }}
          </span>
        </div>
      </article>
      <p v-if="!loading && !posts.length" class="sub waller-empty">{{ t("waller.empty") }}</p>
    </template>

    <router-link class="waller-back" to="/community">&#8592; {{ t("nav.community") }}</router-link>
  </div>
</template>
