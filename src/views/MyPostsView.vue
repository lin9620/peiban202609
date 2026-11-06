<!-- 我的帖子（共有 5）：/my-posts · 最新 10 条，触底自动续载 10 条（与暖心墙同款交互）。
     数据层复用 cloudFetchUserPosts(offset 分页)；下拉刷新 = 重新拉第 0 页。 -->
<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import { useRoute, useRouter } from "vue-router";
import { NButton, NAvatar, useDialog } from "naive-ui";
import { t, i18n } from "../i18n.js";
import { cloud } from "../utils/supabase.js";
import { cloudFetchUserPosts, cloudDeletePost } from "../utils/wall.js";
import { cacheKey, cachePatch, cacheSet, cacheDrop, swr } from "../utils/cache.js";
import { avatarUrlFor } from "../utils/avatar.js";   /* 轮 238:萌宠头像池 */
import { setPostNav } from "../utils/postNav.js";    /* 轮 279:进详情前存列表快照,左右滑用 */
import { onPostReaction, patchPostList } from "../utils/postReactionSync.js";

/* 轮 286:帖子时间接上统一的格式化函数 —— 此前这里是个裸 toLocaleDateString(),
 * 只出「2026/10/14」,连时分都没有。
 * 轮 288:三处个人页（我的页/我的帖子/收藏页）**统一到分**,与暖心墙、详情页同口径,
 * 顺带把 locale 传进去(此前默认 zh,英文界面会看到中文日期)。 */
import { fmtWhen } from "../utils/wallRules.js";

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

  /* 翻页：直接走网络（与暖心墙同口径，翻页不缓存） */
  if (append) {
    loading.value = true;
    try {
      const got = (await cloudFetchUserPosts(uid.value, PAGE, offset)) || [];
      if (run !== gen) return;
      rows.value = [...rows.value, ...got];
      offset += got.length;
      if (got.length < PAGE) done.value = true;
    } catch (e) {
      /* 翻页失败静默保留已载内容 */
    } finally {
      if (run === gen) loading.value = false;
    }
    return;
  }

  /* 轮 36：首屏本地优先（与暖心墙同款 SWR）——缓存快照先渲染（秒开），云端回来
   * 覆盖并回写；失败/空不覆盖。此前每次进页都白屏等网络，「不跟手」清单之一。 */
  loading.value = true;
  const consume = (d) => {
    if (run !== gen || !Array.isArray(d)) return;
    rows.value = d;
    offset = d.length;
    done.value = d.length < PAGE;   /* 缓存不足一页 ≈ 没有更多 */
    loading.value = false;
  };
  await swr(
    cacheKey("myposts", uid.value),
    { cached: consume, fresh: consume },
    async () => {
      const got = await cloudFetchUserPosts(uid.value, PAGE, 0);
      return got && got.length ? got : null;
    },
  );
  if (run === gen) loading.value = false;
}
async function refresh() { offset = 0; done.value = false; await load(false); }

watch(uid, () => { offset = 0; done.value = false; rows.value = []; load(false); }, { immediate: true });

/* 触底自动续载（IntersectionObserver，与暖心墙同款） */
const sentEl = ref(null);
let io = null;
let stopPostReactionSync = null;
onMounted(() => {
  /* 轮 372：详情页改回应 → 本页若还在（返回瞬间）立刻同步；缓存也一并回写，
   * 避免「我的帖子 0 / 详情 2」，或返回后先闪一下 0 再等网络。 */
  stopPostReactionSync = onPostReaction((id, patch) => {
    const u = uid.value;
    if (!u) return;
    const next = patchPostList(rows.value, id, patch);
    if (next !== rows.value) rows.value = next;
    cachePatch(cacheKey("myposts", u), (list) => patchPostList(list, id, patch));
  });
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
onBeforeUnmount(() => {
  if (io) io.disconnect();
  if (stopPostReactionSync) stopPostReactionSync();
  stopPostReactionSync = null;
});

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

/* 轮 288:与 WallerView / PostDetailView 同名同口径的时间文案 */
const when = (ts) => fmtWhen(ts, i18n.locale);
function openWall(p) {
  /* 轮 19：独立详情页（完整帖子 + 评论展开），不再跳回暖心墙信息流 */
  if (p.dbId == null) return;
  setPostNav(rows.value);   /* 轮 279：我的帖子列表快照,详情页左右滑用 */
  cacheSet(cacheKey("wall:post", p.dbId), p);   /* 轮 372：详情 0ms 先渲染正确回应数 */
  router.push({ path: `/post/${p.dbId}` });
}

/* ═════════ 轮446 · 在这页直接删自己的帖子 ═════════
 * 这一页**全是自己的帖子**，不需要「⋯ → 删除」两级菜单，直接给一颗删除按钮。
 * 与暖心墙 / 详情页同一个后端动作（软删 + 置 removed），确认文案也一致。 */
const dialog = useDialog();
const removing = ref(new Set());          /* 正在删的 dbId（按钮 loading / 防连点） */
const delErr = ref("");
function flashDelFail() {
  /* 没有 toast 组件，用一次性的行内提示最省事：把失败塞进墙消息位（本次页面内可见） */
  delErr.value = t("post.deleteFail");
  setTimeout(() => { delErr.value = ""; }, 3200);
}

async function delPost(p) {
  const id = p && p.dbId;
  if (id == null || removing.value.has(id)) return;
  const ok = await new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    dialog.warning({
      title: t("post.deleteTitle"),
      content: t("post.deleteDesc"),
      positiveText: t("post.delete"),
      negativeText: t("common.cancel"),
      onPositiveClick: () => done(true),
      onNegativeClick: () => done(false),
      onClose: () => done(false),
    });
  });
  if (!ok) return;

  removing.value = new Set([...removing.value, id]);
  const prev = rows.value;
  rows.value = prev.filter((x) => String(x.dbId) !== String(id));   /* 乐观移除 */
  try {
    const doneDel = await cloudDeletePost(id);
    if (!doneDel) throw new Error("post-delete-false");
    /* 缓存同步：本页快照 + 详情快照（否则返回列表或再进详情会把已删的帖闪回来） */
    cachePatch(cacheKey("myposts", uid.value), (list) => list.filter((x) => String(x.dbId) !== String(id)));
    cacheDrop(cacheKey("wall:post", id));
  } catch (e) {
    rows.value = prev;    /* 回滚 */
    flashDelFail();
  } finally {
    const n = new Set(removing.value);
    n.delete(id);
    removing.value = n;
  }
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
      <p v-if="delErr" class="notice" style="color: var(--low); font-weight: 600">{{ delErr }}</p>

      <!-- 轮 18：与暖心墙完全同款的帖子卡（头像/署名/时间/全文/配图/回应数/浏览数） -->
      <article
        v-for="p in rows" :key="p.id"
        class="post-card card mypage-post" @click="openWall(p)">
        <div class="post-head">
          <n-avatar round :size="42" class="post-avatar" :src="avatarUrlFor(uid) || undefined"><template v-if="!avatarUrlFor(uid)" #default>🙂</template><template v-else #fallback>🙂</template></n-avatar>
          <div class="post-meta">
            <div class="post-name">{{ p.name }}</div>
            <div class="post-time">{{ when(p.ts) }}</div>
          </div>
          <span class="mypage-go">{{ t("community.viewHome") }} →</span>
        </div>
        <p class="post-text">{{ p.text || "🖼️" }}</p>
        <img loading="lazy" v-if="p.img" :src="p.img" class="pic" alt="" />
        <div class="react-row">
          <n-button
            v-for="r in REACTIONS" :key="r.key"
            round size="small" quaternary :focusable="false">
            {{ t(r.tk) }} · {{ (p.reacts && p.reacts[r.key]) || 0 }}
          </n-button>
        </div>
        <!-- 轮446：浏览数 + 删除（这一页全是自己的帖子，直接给按钮，不再套 ⋯ 菜单） -->
        <div class="mypage-foot">
          <span v-if="p.stats" class="post-views">{{ t("community.views", { n: p.views || 0 }) }}</span>
          <button class="mypage-del" :disabled="removing.has(p.dbId)" @click.stop="delPost(p)">
            {{ removing.has(p.dbId) ? "…" : t("post.delete") }}
          </button>
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
  font-weight: 500; font-size: 16px;
}
.mypage-pull { display: flex; align-items: center; justify-content: center; overflow: hidden; color: var(--ink-soft); transition: height .15s ease; }
.mypage-signin { text-align: center; display: grid; gap: 10px; justify-items: center; padding: 18px 14px; }
.mypage-post { cursor: pointer; }
.mypage-go { font-size: 12px; font-weight: 500; color: var(--ink-faint); white-space: nowrap; }
.mypage-sentinel { height: 4px; }
/* 轮446：卡片底部「浏览数 + 删除」 */
.mypage-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 8px; }
.mypage-del {
  appearance: none; font: inherit; cursor: pointer;
  border: none; background: none; padding: 4px 6px; border-radius: 8px;
  font-size: 12.5px; font-weight: 500; color: var(--low);
}
.mypage-del:hover { background: var(--accent-soft); }
.mypage-del:disabled { opacity: .5; cursor: default; }
</style>
