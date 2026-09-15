<script setup>
import { ref, computed } from "vue";
import { NButton, NInput, NAvatar, NTag, NProgress } from "naive-ui";
import { t } from "../i18n.js";
import { getItem, setItem, removeItem } from "../utils/storage.js";
import { cookbook, removeDish, moodLog, moodStreak } from "../stores/petStore.js";
import { todayKey } from "../utils/daily.js";
import { cloud, cloudSignUp, cloudSignIn, cloudSignOut } from "../utils/supabase.js";

/* 心情图标：一律用 Unicode 转义，避免源码中的 emoji 编码损坏 */
const MOOD = ["\u{1F929}", "\u{1F642}", "\u{1F60C}", "\u{1F327}\uFE0F", "\u{1F614}"];
const PAW = "\u{1F43E}";
const HEART = "\u{1F497}";

const NICK_KEY = "wp-nickname";

const nickname = ref(getItem(NICK_KEY) || "");
const draftNick = ref("");
/* 云登录优先；否则退回本地访客昵称 */
const cloudSigned = computed(() => !!(cloud.ready && cloud.user));
const signedIn = computed(() => cloudSigned.value || !!nickname.value.trim());
const displayName = computed(() => (cloudSigned.value ? (cloud.nickname || nickname.value) : nickname.value));
const streak = computed(() => moodStreak());

/* —— 邮箱登录 / 注册（云端就绪时显示） —— */
const authMode = ref("signin");           // signin | signup
const authEmail = ref("");
const authPass = ref("");
const authNick = ref("");
const authBusy = ref(false);
const authMsg = ref("");
const authOk = ref(false);

function switchAuthMode() {
  authMode.value = authMode.value === "signin" ? "signup" : "signin";
  authMsg.value = "";
  authOk.value = false;
}

async function doAuth() {
  if (authBusy.value) return;
  authBusy.value = true;
  authMsg.value = "";
  authOk.value = false;
  const r = authMode.value === "signup"
    ? await cloudSignUp(authEmail.value.trim(), authPass.value, authNick.value.trim())
    : await cloudSignIn(authEmail.value.trim(), authPass.value);
  authBusy.value = false;
  if (!r.ok) {
    authOk.value = false;
    authMsg.value = t("profile.authFail", { r: r.reason || "unknown" });
    return;
  }
  if (r.needVerify) {
    authOk.value = true;
    authMsg.value = t("profile.verifySent");
    return;
  }
  /* 登录成功：云端昵称同步到本地键，暖心墙署名保持一致 */
  if (cloud.nickname) { nickname.value = cloud.nickname; setItem(NICK_KEY, cloud.nickname); }
  authOk.value = true;
  authMsg.value = t("profile.cloudSignedIn");
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
      </div>
    </section>

    <!-- 云端登录 / 注册（Supabase 已连接且未登录时显示） -->
    <section v-if="cloud.ready && !cloudSigned" class="card">
      <div class="row-between">
        <h2>{{ t("profile.authTitle") }}</h2>
        <n-button quaternary size="small" @click="switchAuthMode">
          {{ authMode === "signin" ? t("profile.toSignUp") : t("profile.toSignIn") }}
        </n-button>
      </div>
      <div class="q-input" style="margin-top: 12px">
        <n-input v-model:value="authEmail" round size="large"
          :placeholder="t('profile.authEmail')" @keyup.enter="doAuth" />
      </div>
      <div class="q-input" style="margin-top: 8px">
        <n-input v-model:value="authPass" type="password" round size="large" show-password-on="click"
          :placeholder="t('profile.authPass')" @keyup.enter="doAuth" />
      </div>
      <div v-if="authMode === 'signup'" class="q-input" style="margin-top: 8px">
        <n-input v-model:value="authNick" round size="large"
          :placeholder="t('common.nickname')" @keyup.enter="doAuth" />
      </div>
      <div style="margin-top: 12px">
        <n-button type="primary" round size="large" :loading="authBusy" @click="doAuth">
          {{ authMode === "signin" ? t("common.signIn") : t("common.signUp") }}
        </n-button>
      </div>
      <p class="notice" :style="authOk ? 'color: var(--good)' : ''">{{ authMsg || t("common.localMode") }}</p>
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

    <!-- 我的食谱 -->
    <section class="card">
      <h2>{{ t("profile.myBook") }}</h2>
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