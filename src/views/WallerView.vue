<!-- 墙上的主页：/u/:id —— 点暖心墙的头像/昵称进来，看 TA 的帖子、宠物与手绘厨房（访客可互动） -->
<script setup>
import { ref, reactive, computed, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { NAvatar } from "naive-ui";
import { t, i18n } from "../i18n.js";
import {
  cloudFetchProfile, cloudFetchUserPosts, cloudGetPetHome, cloudPetInteract,
} from "../utils/wall.js";
import { visibleOnly, ANON_KEY, fmtWhen } from "../utils/wallRules.js";
import { cacheKey, swr } from "../utils/cache.js";   /* 轮 158：主页聚合 SWR */
import { avatarUrlFor } from "../utils/avatar.js";   /* 轮 238:萌宠头像池 */
import { setPostNav } from "../utils/postNav.js";    /* 轮 279:进详情前存列表快照,左右滑用 */
import { scopeGetRaw } from "../utils/userScope.js";
/* 轮 33：全站拉黑（复用 dm_blocks；拉黑后 TA 的内容在我这边隐藏） */
import { blockUser, unblockUser, isBlocked, refreshBlocks } from "../utils/userBlocks.js";
/* 轮447：关注（单向、静默）。拉黑时连带取关，避免「关注列表里有个已拉黑的人」。 */
import {
  isFollowing, followUser, unfollowUser, refreshFollows, followErrKey, dropFollowQuietly,
} from "../utils/follows.js";
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
const dmSlow = ref(false);
const dmMsg = ref("");
let dmSlowTimer = 0;
const isSelf = computed(() => !!(cloud.user && cloud.user.id === uid));
const canDm = computed(() => !!(cloud.ready && cloud.user && uid && !isSelf.value));

/* 轮397：线上 /sb 代理实测 5~20s，旧按钮只置灰不改字，用户看起来就是「点了没反应」。
 * 这里给打开会话一个兜底超时，并在 2.5s 后补一句慢网提示；成功/失败都恢复按钮可点。 */
function withTimeout(p, ms = 25000) {
  let timer = 0;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error("timeout");
      e.timeout = true;
      reject(e);
    }, ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/* 轮 271：点 TA 的帖子（正文/图）进详情页（/post/:id）——与暖心墙轮 84 同款口径：
 * cloudFetchUserPosts 返回 rowsToPosts 同款行（dbId 恒有）；没 dbId 的行不响应。 */
function goDetail(p) {
  if (!p || p.dbId == null) return;
  setPostNav(posts.value);   /* 轮 279：TA 的帖子列表快照,详情页左右滑用 */
  router.push({ name: "postDetail", params: { id: p.dbId } });
}

async function startDm() {
  if (dmBusy.value || !canDm.value) return;
  dmBusy.value = true;
  dmSlow.value = false;
  dmMsg.value = "";
  dmSlowTimer = setTimeout(() => { dmSlow.value = true; }, 2500);
  try {
    const convId = await withTimeout(openConv(uid));
    if (convId) router.push({ name: "messages", params: { id: String(convId) } });
    else dmMsg.value = t("dm.errNetwork");
  } catch (e) {
    dmMsg.value = t(sendErrKey(e));
  } finally {
    clearTimeout(dmSlowTimer);
    dmSlow.value = false;
    dmBusy.value = false;
  }
}

/* —— 拉黑（轮 33）：一个「拉黑」全站生效 —— 私信拦截（dm RPC）+ 暖心墙内容对我隐藏
 *   （userBlocks 过滤层）；两步确认防手滑；对方不知情、无任何通知。 —— */
const blockArm = ref(false);      /* 两步确认：第一次点进入待确认态，再点才真拉黑 */
const blockBusy = ref(false);
const isBlockedHere = computed(() => isBlocked(uid));
async function toggleBlock() {
  if (blockBusy.value || !canDm.value) return;
  if (!isBlockedHere.value && !blockArm.value) {
    blockArm.value = true;
    setTimeout(() => { blockArm.value = false; }, 4000);   /* 4s 不确认就自动复位 */
    return;
  }
  blockBusy.value = true;
  blockArm.value = false;
  try {
    if (isBlockedHere.value) await unblockUser(uid);
    else {
      await blockUser(uid, name.value);
      /* 轮447：拉黑 = 不想再看到这个人 → 连带取关（失败忽略，渲染层还有 filterBlocked 兜底）。
         不这样做，/following 里会留一个点进去显示「已拉黑」的幽灵。 */
      dropFollowQuietly(uid);
    }
  } catch (e) { dmMsg.value = t("dm.errNetwork"); }
  blockBusy.value = false;
}

/* ── 轮447 · 关注 ──
 * 单向、静默：对方永远不知道，也不会收到通知 —— 所以这里刻意不给任何
 * 「TA 会看到」的暗示，按钮文案就是「关注 / 已关注」。
 * 取关要两步确认（关注可以随时反悔，取关后这个人就从我的列表里消失了，手滑代价不对称）。 */
const followBusy = ref(false);
const followArm = ref(false);
const followMsg = ref("");
const isFollowingHere = computed(() => isFollowing(uid));
/* 已拉黑的人不给关注按钮（拉黑语义就是「不想再看到」）；自己的主页也不给 */
const canFollow = computed(() => !!uid && !isSelf.value && !isBlockedHere.value);
async function toggleFollow() {
  if (followBusy.value || !canFollow.value) return;
  if (!(cloud.ready && cloud.user)) {              /* 未登录：先去登录，回来还能点 */
    router.push({ path: "/login", query: { next: route.fullPath } });
    return;
  }
  if (isFollowingHere.value && !followArm.value) {
    followArm.value = true;
    setTimeout(() => { followArm.value = false; }, 4000);
    return;
  }
  followBusy.value = true;
  followArm.value = false;
  followMsg.value = "";
  try {
    if (isFollowingHere.value) await unfollowUser(uid);
    else await followUser(uid, name.value);
  } catch (e) {
    const k = followErrKey(e);
    if (k) {
      followMsg.value = t(k);
      setTimeout(() => { followMsg.value = ""; }, 3200);
    }
  }
  followBusy.value = false;
}

const prof = ref(null);        // profiles 行：{ nickname, created_at, status, status_at }
const posts = ref([]);         // TA 的帖子（已排除下架的）
const loading = ref(true);
const failed = ref(false);     // 档案与帖子都拿不到才算真失败

const petHome = ref(null);     // 云端宠物主页：{ pet, dishes, counts }；null = 云端不可用（未迁移等）
/* 轮454：菜图加载失败（Storage 对象被删、网络断、脏 dataURL 漏网）→ 记 id，改画占位。
 * 不这样做，浏览器会直接画破图标 + alt 文字，一屏看着像页面坏了。 */
const dishBroken = reactive({});
function markDishBroken(id) { dishBroken[id] = true; }
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
  refreshBlocks();   /* 轮 33：名单就绪（拉黑按钮的「已拉黑」态靠它） */
  refreshFollows();  /* 轮447：关注状态（按钮「已关注」态靠它；有本地快照，不闪） */
  /* 轮 158：资料+帖子+宠物家园三路聚合整体走 SWR——二次进页本地直出，
   * 不再干等三个 RPC 排队；拉黑名单刷新后 fresh 会把过滤后的帖子纠正回来 */
  let applied = false;
  const apply = ({ pf, ps, ph }) => {
    prof.value = pf || { nickname: "", created_at: null };
    posts.value = visibleOnly(ps || []);
    petHome.value = ph; /* null = 未迁移/查询失败 → 区块显示「准备中」；pet 为空 → 「还没带宠物来」 */
    applied = true;
  };
  await swr(
    cacheKey("waller:home", uid),
    {
      cached: (d) => { apply(d); loading.value = false; },
      fresh: apply,
    },
    async () => {
      const [pf, ps, ph] = await Promise.all([
        cloudFetchProfile(uid), cloudFetchUserPosts(uid), cloudGetPetHome(uid),
      ]);
      /* 原口径：资料与帖子都拿不到 = 查无此人/网络挂 → failed（null 让 swr 不覆盖不落缓存） */
      if (pf === null && ps === null) return null;
      return { pf, ps, ph };
    },
  );
  loading.value = false;
  if (!applied) failed.value = true;
});
</script>

<template>
  <div class="waller">
    <!-- 主页头：头像 + 昵称 + 加入时间 -->
    <section class="card waller-head">
      <n-avatar round :size="72" class="post-avatar" :src="avatarUrlFor(uid) || undefined"><template v-if="!avatarUrlFor(uid)" #default>{{ failed ? "?" : loading ? "…" : initial }}</template><template v-else #fallback>{{ failed ? "?" : loading ? "…" : initial }}</template>
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
        <!-- 轮447 · 关注（排在最前 = 主按钮）：单向静默，对方不知情，所以不加任何「TA 会看到」的暗示 -->
        <div v-if="!failed && !loading && !isSelf" class="waller-dm">
          <button
            v-if="canFollow" class="waller-act waller-follow"
            :class="{ on: isFollowingHere, armed: followArm }"
            :disabled="followBusy" :aria-busy="followBusy"
            :title="isFollowingHere ? t('follow.unfollowArm') : t('follow.followHint')"
            @click="toggleFollow">
            {{ followBusy ? t("follow.busy")
              : followArm ? t("follow.unfollowArm")
              : isFollowingHere ? "✓ " + t("follow.following") : "+ " + t("follow.follow") }}
          </button>
          <!-- 发私信：登录且非本人主页才有；失败原因按 dmRules.sendErrKey 映射 -->
          <button v-if="canDm" class="waller-act" :disabled="dmBusy" :aria-busy="dmBusy" @click="startDm">
            {{ dmBusy ? t("dm.opening") : "✉️ " + t("dm.sendTo") }}
          </button>
          <button
            v-if="canDm"
            class="waller-act waller-block" :class="{ armed: blockArm, blocked: isBlockedHere }"
            :disabled="blockBusy" @click="toggleBlock">
            {{ isBlockedHere ? t("wall.unblock") : (blockArm ? t("wall.blockConfirm") : t("wall.block")) }}
          </button>
          <span v-if="followMsg" class="sub" style="margin: 6px 0 0">{{ followMsg }}</span>
          <span v-else-if="dmMsg" class="sub" style="margin: 6px 0 0">{{ dmMsg }}</span>
          <span v-else-if="dmBusy && dmSlow" class="sub" style="margin: 6px 0 0">{{ t("dm.openingSlow") }}</span>
          <span v-else-if="isBlockedHere" class="sub" style="margin: 6px 0 0">{{ t("wall.blockedTip") }}</span>
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
          <img v-if="d.img && !dishBroken[d.id]" :src="d.img" :alt="d.name" loading="lazy" draggable="false"
            @error="markDishBroken(d.id)" />
          <span v-else class="dish-noimg" :title="t('waller.dishNoImg')" aria-hidden="true">&#128396;</span>
          <figcaption>{{ d.name }}</figcaption>
          <button class="dish-feed" :disabled="interactBusy" @click="interact('feed', d.name)">
            {{ t("waller.feed") }}
          </button>
        </figure>
      </div>
    </section>

    <!-- TA 的帖子（只读展示；下架的不显示） -->
    <template v-if="!failed">
      <article v-for="p in posts" :key="p.id" class="post-card card" @click="goDetail(p)">
        <div class="post-head">
          <n-avatar round :size="40" class="post-avatar" :src="avatarUrlFor(uid) || undefined"><template v-if="!avatarUrlFor(uid)" #default>{{ initial }}</template><template v-else #fallback>{{ initial }}</template></n-avatar>
          <div class="post-meta">
            <div class="post-name">{{ name }}</div>
            <div class="post-time">{{ when(p.ts) }}</div>
          </div>
        </div>
        <p class="post-text go-detail" v-if="p.text" @click="goDetail(p)">{{ p.text }}</p>
        <img loading="lazy" v-if="p.img" :src="p.img" class="pic go-detail" alt="" @click="goDetail(p)" />
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

<style scoped>
/* 拉黑按钮（轮 33）：平时低调；待确认态变警示色；已拉黑态常显可撤销 */
.waller-block { color: var(--ink-faint); }
.waller-block.armed { color: var(--low); font-weight: 500; }
.waller-block.blocked { color: var(--low); }
</style>
