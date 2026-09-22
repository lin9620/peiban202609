<script setup>
import { ref, computed, watch } from "vue";
import { useRouter, useRoute } from "vue-router";
import { NButton, NInput, NAvatar, NTag, NProgress } from "naive-ui";
import { t } from "../i18n.js";
import { getItem, setItem, removeItem } from "../utils/storage.js";
import { cookbook, removeDish, moodLog, moodStreak, wallet } from "../stores/petStore.js";
import { isMobileNav } from "../stores/uiStore.js";
import { todayKey } from "../utils/daily.js";
import {
  cloud, cloudSignOut,
  cloudUpdatePassword, cloudClearRecovery,
  cloudUpdateNickname, cloudNicknameIsAuto,
} from "../utils/supabase.js";
/* 登录规则（纯函数，Node 单测覆盖）：本地校验 / 昵称兜底 / 邮件链接解析 / 回跳地址 */
import { MIN_PASSWORD, NICK_MAX, passwordProblem } from "../utils/authRules.js";
import { db } from "../utils/api/db.js";
import { cloudFetchUserPosts } from "../utils/wall.js";

/* 心情图标：一律用 Unicode 转义，避免源码中的 emoji 编码损坏 */
const MOOD = ["\u{1F929}", "\u{1F642}", "\u{1F60C}", "\u{1F327}\uFE0F", "\u{1F614}"];
const PAW = "\u{1F43E}";
const HEART = "\u{1F497}";

const NICK_KEY = "wp-nickname";

const nickname = ref(getItem(NICK_KEY) || "");
const draftNick = ref("");
/* 云登录优先；否则退回本地访客昵称 */
const cloudSigned = computed(() => !!(cloud.ready && cloud.user));

/* 与暖心墙同款的三种回应（计数只读展示；点卡片回墙里互动） */
const REACTIONS = [
  { key: "hug", tk: "community.reactHug" },
  { key: "warm", tk: "community.reactWarm" },
  { key: "relate", tk: "community.reactRelate" },
];
const signedIn = computed(() => cloudSigned.value || !!nickname.value.trim());
const displayName = computed(() => (cloudSigned.value ? (cloud.nickname || nickname.value) : nickname.value));
const streak = computed(() => moodStreak());

/* 管理中心入口：仅数据库认定的管理员可见（is_admin()；失败一律当不是）。
 * 跟随登录态重新判定 —— 登录表单就在本页，组件挂载时常常还没登录 / Auth 还没就绪 */
const isAdmin = ref(false);
watch(
  () => [cloud.ready, cloud.user && cloud.user.id],
  async ([ready, uid]) => {
    if (!ready || !uid) {
      isAdmin.value = false;
      return;
    }
    try {
      isAdmin.value = (await db.amAdmin()) === true;
    } catch (e) {
      isAdmin.value = false;
    }
  },
  { immediate: true },
);

/* #9 我在暖心墙的帖子：默认只展示最新 3 条（共有 5），「更多」进 /my-posts 分页看全部 */
const myPosts = ref([]);
const myPostsBusy = ref(false);
watch(
  () => [cloud.ready, cloud.user && cloud.user.id],
  async ([ready, uid]) => {
    if (!ready || !uid) { myPosts.value = []; return; }
    myPostsBusy.value = true;
    try { myPosts.value = (await cloudFetchUserPosts(uid, 3)) || []; }
    catch (e) { myPosts.value = []; }
    myPostsBusy.value = false;
  },
  { immediate: true },
);

/* —— 登录 / 注册 / 忘记密码已独立成页（/login，手机与网页共用）——
 * 本页未登录时只放一张入口卡；老的重置邮件可能回落到 /profile，
 * 所以「重置链接落地 → 设置新密码」的收尾逻辑仍留在这里。 */
const newPass = ref("");
const passBusy = ref(false);
const passMsg = ref("");

/* 页面级提示（保存成功的提示要放在登录卡片外——那时卡片已被隐藏） */
const flash = ref("");

/* —— 改昵称（Google 首登提示 + 任何时候可改） ——
 * 昵称还是 Google 自动兜底时就一直给一个紧凑入口（提示语 + 「改一改」），
 * 点开才出现输入框；改成功（或本来就不是自动昵称）框就不出现。设置页里也常驻可改。 */
const nickEdit = ref(false);
const nickDraft = ref("");
const nickBusy = ref(false);
const nickMsg = ref("");
const nickAuto = ref(false);

function nickProblem(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return t("profile.needNick");
  if (s.length > NICK_MAX) return t("profile.nickLong", { n: NICK_MAX });
  return "";
}
function startNickEdit() {
  nickDraft.value = cloud.nickname || "";
  nickMsg.value = "";
  nickEdit.value = true;
}
function cancelNickEdit() {
  nickEdit.value = false;
  nickDraft.value = "";
  nickMsg.value = "";
}
async function saveNick() {
  if (nickBusy.value) return;
  const bad = nickProblem(nickDraft.value);
  if (bad) { nickMsg.value = bad; return; }
  nickBusy.value = true;
  nickMsg.value = "";
  const r = await cloudUpdateNickname(nickDraft.value);
  nickBusy.value = false;
  if (!r.ok) { nickMsg.value = t("profile.authFail", { r: r.reason || "unknown" }); return; }
  /* 成功：署名键与云端同步（syncNickname 走 cloud.nickname），提示框收起 */
  syncNickname();
  nickAuto.value = false;
  nickEdit.value = false;
  nickDraft.value = "";
  flash.value = r.synced
    ? t("profile.nickSavedSynced", { p: r.posts || 0, c: r.comments || 0 })
    : t("profile.nickSavedOld");
}
/* 登录态变化时判定：昵称是否仍是 Google 自动兜底 */
watch(
  () => [cloud.ready, cloud.user && cloud.user.id, cloud.nickname],
  async ([ready, uid]) => {
    nickAuto.value = !!(ready && uid) && cloudNicknameIsAuto();
    if (!(ready && uid)) cancelNickEdit();
  },
  { immediate: true },
);

function syncNickname() {
  if (cloud.nickname) { nickname.value = cloud.nickname; setItem(NICK_KEY, cloud.nickname); }
}
/* —— 登录 / 注册已独立成页（/login，手机与网页共用）——
 * 本页未登录时只放一张入口卡；重置密码落地（cloud.recovery）的收尾仍在这里处理，
 * 因为老的重置邮件可能回落到 /profile。 */
const router = useRouter();
const route = useRoute();

function goSignIn(withForgot = false) {
  /* 把当前位置带过去：登录成功后回到原来的页面（默认 /profile）；
   * withForgot = 重置链接失效场景 → 直达「忘记密码」表单
   * 轮 21 加固：只有**显式 true** 才算忘记密码。此处用 === true 兜住
   * 「模板 @click 不带括号 → MouseEvent 被当实参」这类误传（真根因见本函数调用处注释）。 */
  const here = route.fullPath || "/profile";
  const query = withForgot === true ? { redirect: here, forgot: "1" } : { redirect: here };
  router.push({ path: "/login", query });
}

/* 密码本地校验（与 /login 同一套规则；权威判断始终在服务端） */
function passHint(pass) {
  const p = passwordProblem(pass);
  if (!p) return "";
  return p === "missing" ? t("profile.needPass") : t("profile.shortPass", { n: MIN_PASSWORD });
}

/* —— 重置链接已生效：设置新密码 —— */
async function doSetPassword() {
  if (passBusy.value) return;
  const bad = passHint(newPass.value);
  if (bad) { passMsg.value = bad; return; }
  passBusy.value = true;
  passMsg.value = "";
  const r = await cloudUpdatePassword(newPass.value);
  passBusy.value = false;
  if (!r.ok) { passMsg.value = t("profile.authFail", { r: r.reason || "unknown" }); return; }
  syncNickname();
  newPass.value = "";
  cloudClearRecovery();
  flash.value = t("profile.resetDone");
}
function leaveRecovery() {
  newPass.value = "";
  passMsg.value = "";
  cloudClearRecovery();
}

function continueAsGuest() {
  const n = draftNick.value.trim();
  if (!n) return;
  nickname.value = n;
  setItem(NICK_KEY, n);
}

async function signOut() {
  if (cloudSigned.value) await cloudSignOut();
  removeItem(NICK_KEY);
  nickname.value = "";
  /* 退出时把残留的提示与「设置新密码」界面一起收掉 */
  flash.value = "";
  leaveRecovery();
}

/* 最近 30 天日历 */
const cells = computed(() => {
  const out = [];
  const d = new Date();
  d.setDate(d.getDate() - 29);
  for (let i = 0; i < 30; i++) {
    const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    const idx = moodLog[key];
    out.push({
      key,
      idx: idx === undefined ? -1 : idx,
      emoji: idx === undefined ? "" : MOOD[idx],
      today: key === todayKey(),
    });
    d.setDate(d.getDate() + 1);
  }
  return out;
});

const loggedDays = computed(() => cells.value.filter((c) => c.emoji).length);

/* 明亮心情（开心 / 不错）占比 */
const brightRatio = computed(() => {
  const vals = cells.value.filter((c) => c.idx >= 0);
  if (!vals.length) return 0;
  const good = vals.filter((c) => c.idx <= 1).length;
  return Math.round((good / vals.length) * 100);
});
</script>

<template>
  <div>
    <!-- 账户 -->
    <section class="card profile-head">
      <n-avatar round :size="64" class="profile-avatar">
        {{ signedIn ? displayName.slice(0, 1).toUpperCase() : PAW }}
      </n-avatar>
      <div class="profile-id">
        <span class="sec-label">{{ t("profile.title") }}</span>
        <h2 v-if="signedIn">{{ t("profile.hello", { n: displayName }) }}</h2>
        <h2 v-else>{{ t("profile.notSigned") }}</h2>
        <p class="sub" style="margin: 4px 0 0">
          {{ cloud.ready
            ? (cloudSigned ? t("profile.cloudSignedIn") : t("profile.cloudReady"))
            : t("profile.authLocal") }}
        </p>
      </div>
      <div class="profile-actions">
        <n-tag v-if="cloudSigned" round :bordered="false" class="soft-tag">
          &#9729;&#xFE0F; {{ t("common.signIn") }}
        </n-tag>
        <template v-if="signedIn">
          <n-tag v-if="streak > 0" round :bordered="false" class="soft-tag">
            {{ t("home.mood.streak", { n: streak }) }}
          </n-tag>
          <n-button quaternary round @click="signOut">{{ t("common.signOut") }}</n-button>
        </template>
        <router-link v-if="isAdmin" to="/admin" class="admin-entry">
          {{ t("admin.entry") }}
        </router-link>
        <!-- T7 我的 Tab 整合：手机形态顶栏已隐藏（金币/连签原本在桌面顶栏）→ 钱包挪进「我的」头部 -->
        <n-tag v-if="isMobileNav" round :bordered="false" class="soft-tag">
          &#128176; {{ wallet.coins }}
        </n-tag>
        <!-- #13 设置入口：皮肤 / 语言 / 通知偏好都收在设置页 -->
        <router-link to="/settings" class="admin-entry">
          ⚙️ {{ t("settings.entry") }}
        </router-link>
      </div>
    </section>

    <!-- 改昵称：Google 首登自动昵称 → 常驻紧凑提示；点「改一改」出现输入框。
         保存走 profiles self update（RLS），署名/主页/头像即时生效 -->
    <section v-if="cloudSigned && (nickAuto || nickEdit)" class="card nick-box">
      <div class="row-between">
        <span class="sec-label">{{ t("profile.nickTitle") }}</span>
        <n-button v-if="!nickEdit" quaternary size="small" round @click="startNickEdit">
          {{ t("profile.nickChange") }}
        </n-button>
        <n-button v-else quaternary size="small" round :disabled="nickBusy" @click="cancelNickEdit">
          {{ t("common.cancel") }}
        </n-button>
      </div>
      <p class="sub">{{ nickAuto ? t("profile.nickAutoHint") : t("profile.nickHint") }}</p>
      <div v-if="nickEdit" class="nick-row">
        <n-input
          v-model:value="nickDraft" :placeholder="displayName"
          :maxlength="NICK_MAX" :disabled="nickBusy" @keyup.enter="saveNick" />
        <n-button type="primary" :loading="nickBusy" @click="saveNick">
          {{ t("profile.nickSave") }}
        </n-button>
      </div>
      <p v-if="nickMsg" class="streak-note">{{ nickMsg }}</p>
    </section>

    <!-- #9 我在暖心墙的帖子（共有 5：默认最新 3 条 + 「更多」→ /my-posts 分页看全部） -->
    <section v-if="cloudSigned" class="card">
      <div class="row-between">
        <h2>{{ t("profile.myPosts") }}</h2>
        <router-link class="my-posts-link" to="/my-posts">{{ t("profile.more") }} →</router-link>
      </div>
      <p v-if="myPostsBusy" class="sub">…</p>
      <p v-else-if="!myPosts.length" class="sub">{{ t("profile.myPostsEmpty") }}</p>
      <!-- 轮 18：与暖心墙完全同款的帖子卡（头像/署名/时间/全文/配图/回应数/浏览数）；
           轮 20：整卡点击进独立详情页 /post/:id（完整帖子+评论展开），不再跳回暖心墙列表 -->
      <div v-else class="my-posts">
        <router-link
          v-for="p in myPosts" :key="p.id"
          class="post-card card my-post" :to="'/post/' + p.dbId">
          <div class="post-head">
            <n-avatar round :size="42" class="post-avatar">🙂</n-avatar>
            <div class="post-meta">
              <div class="post-name">{{ p.name }}</div>
              <div class="post-time">{{ new Date(p.ts).toLocaleDateString() }}</div>
            </div>
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
        </router-link>
      </div>
    </section>

    <!-- 刚完成动作的提示（如「新密码已保存」）—— 放在登录卡片外：成功后那张卡片会被隐藏 -->
    <section v-if="flash" class="card auth-flash">{{ flash }}</section>

    <!-- 重置邮件失效（链接被用过 / 已过期）：如实说明，并给一条重新发的路 -->
    <section v-if="cloud.ready && !cloudSigned && cloud.recoveryErr && !cloud.recovery" class="card auth-card">
      <h2>{{ t("profile.resetLinkBad") }}</h2>
      <p class="notice">{{ t("profile.resetLinkBadWhy", { r: cloud.recoveryErr }) }}</p>
      <div style="margin-top: 12px">
        <n-button type="primary" round @click="goSignIn(true)">{{ t("profile.forgotTitle") }}</n-button>
      </div>
    </section>

    <!-- 重置链接已生效：设置新密码（保存后即为登录状态） -->
    <section v-else-if="cloud.ready && cloud.recovery" class="card auth-card">
      <h2>{{ t("profile.setPassTitle") }}</h2>
      <p class="notice">{{ t("profile.setPassHint") }}</p>
      <div class="q-input" style="margin-top: 12px">
        <n-input v-model:value="newPass" type="password" round size="large" show-password-on="click"
          :placeholder="t('profile.newPass')" @keyup.enter="doSetPassword" />
      </div>
      <div class="auth-actions">
        <n-button type="primary" round size="large" :loading="passBusy" @click="doSetPassword">
          {{ t("profile.savePass") }}
        </n-button>
        <n-button quaternary round @click="leaveRecovery">{{ t("profile.backToSignIn") }}</n-button>
      </div>
      <p v-if="passMsg" class="notice bad">{{ passMsg }}</p>
    </section>

    <!-- 未登录：登录 / 注册已独立成页（/login，手机与网页共用）；这里只留一张入口卡 -->
    <section v-else-if="cloud.ready && !cloudSigned" class="card auth-card">
      <h2>{{ t("profile.authTitle") }}</h2>
      <p class="sub" style="margin-top: 6px">{{ t("settings.tapToLogin") }}</p>
      <div class="auth-actions">
        <!-- 轮 21 根因修复：@click="goSignIn" 不带括号时 Vue 会把 MouseEvent 当第一实参传入，
             withForgot 收到 truthy → 跳 /login?forgot=1 → 用户点「去登录」直接看到忘记密码页。
             必须显式传 false（函数内也加了 === true 兜底，双保险）。 -->
        <n-button type="primary" round size="large" @click="goSignIn(false)">
          {{ t("profile.goSignIn") }}
        </n-button>
      </div>
    </section>

    <!-- 起昵称（本地模式，或登录前的访客身份） -->
    <section v-if="!cloud.ready && !signedIn" class="card">
      <h2>{{ t("profile.setNick") }}</h2>
      <div class="q-input" style="margin-top: 12px">
        <n-input
          v-model:value="draftNick" round size="large"
          :placeholder="t('common.nickname')"
          @keyup.enter="continueAsGuest" />
        <n-button type="primary" round size="large" @click="continueAsGuest">
          {{ t("common.save") }}
        </n-button>
      </div>
      <p class="notice">{{ t("common.localMode") }}</p>
    </section>

    <!-- 心情日历 -->
    <section class="card">
      <div class="row-between">
        <h2>{{ t("profile.moodCal") }}</h2>
        <n-tag round size="small" :bordered="false" class="soft-tag">
          {{ t("profile.days") }}
        </n-tag>
      </div>

      <div class="stat-row">
        <div class="stat">
          <b>{{ loggedDays }}</b>
          <span>{{ t("profile.daysLogged") }}</span>
        </div>
        <div class="stat-growth">
          <n-progress
            type="line" :percentage="brightRatio" :height="8" :show-indicator="false"
            color="#FF9F5A" rail-color="rgba(160,110,60,.12)" />
          <span class="stat-cap">{{ t("profile.brightDays") }} · {{ brightRatio }}%</span>
        </div>
      </div>

      <div class="mood-cal">
        <div
          v-for="c in cells" :key="c.key"
          class="mood-cell" :class="{ has: c.emoji, today: c.today }">
          {{ c.emoji }}
        </div>
      </div>
      <p class="cal-legend">{{ t("profile.moodEmpty") }}</p>
    </section>

    <!-- 我的食谱（共有 6）：原版卡片（♥用心度 + 可删）——标题行的「去厨房 →」跳宠物页食谱 Tab -->
    <section class="card">
      <div class="row-between">
        <h2>{{ t("profile.myBook") }}</h2>
        <router-link class="my-posts-link" to="/pet?tab=book">{{ t("profile.bookOpen") }} →</router-link>
      </div>
      <p v-if="!cookbook.length" class="sub">{{ t("profile.bookEmpty") }}</p>
      <div v-else class="book-grid">
        <div v-for="d in cookbook" :key="d.id" class="dish">
          <img :src="d.img" :alt="d.name" />
          <div class="name">{{ d.name }}</div>
          <div class="row">
            <span class="notice" style="margin: 0">{{ HEART }} {{ d.effort }}%</span>
            <n-button quaternary size="tiny" @click="removeDish(d.id)">
              {{ t("common.delete") }}
            </n-button>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.my-posts-link { text-decoration: none; }
.my-posts { display: flex; flex-direction: column; gap: 10px; margin-top: 10px; }
.my-post {
  display: block; text-decoration: none; color: inherit;
}
.my-post:hover { background: var(--accent-soft); }
/* 轮 18：卡片结构与暖心墙完全同款（.post-card/.post-head/.post-text/.pic/.react-row 全局类），
   这里只保留链接化外观；旧的 mp-* 缩略样式随结构一起退役 */
</style>