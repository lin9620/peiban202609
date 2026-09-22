<!-- 登录页（/login）：手机 + 网页共用。
     把原来长在「我的」页里的登录 / 注册 / 忘记密码 / Google / 重置密码整体搬来独立成页，
     未登录时的所有 needSignIn 提示都可以指向这里；登录成功后按 redirect 回跳。 -->
<script setup>
import { ref, computed, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { NButton, NInput } from "naive-ui";
import { t } from "../i18n.js";
import { getItem, setItem } from "../utils/storage.js";
import {
  cloud, cloudSignUp, cloudSignIn,
  cloudResetPassword, cloudUpdatePassword, cloudSignInWithGoogle, cloudClearRecovery,
} from "../utils/supabase.js";
import { MIN_PASSWORD, emailProblem, passwordProblem } from "../utils/authRules.js";

const route = useRoute();
const router = useRouter();
const cloudSigned = computed(() => !!(cloud.ready && cloud.user));

/* —— 登录成功后的回跳 ——
 * ?redirect=/xxx 只认站内路径（防开放跳转）；Google OAuth 往返会丢 query，
 * 所以跳 Google 前先把目标存进 sessionStorage，回来后取回并清掉。 */
const REDIRECT_KEY = "wp-auth-redirect";
function target() {
  const q = typeof route.query.redirect === "string" ? route.query.redirect : "";
  const ok = q.startsWith("/") && !q.startsWith("//") ? q : "";
  const saved = getItem(REDIRECT_KEY) || "";
  const pick = ok || saved;
  return pick || "/profile";
}
function clearSavedRedirect() {
  try { sessionStorage.removeItem(REDIRECT_KEY); } catch (e) { /* 忽略 */ }
}
function goTarget() {
  const dest = target();
  clearSavedRedirect();
  router.replace(dest).catch(() => {});
}
/* 已登录再进登录页（Google 回跳 / 冷启动带会话）→ 直接回跳，不在这里停留。
 * 例外：重置密码落地（cloud.recovery）时虽然是已登录会话，
 * 但用户是来「设置新密码」的，跳走会把这个表单吞掉。 */
watch(
  () => [cloud.ready, cloud.user && cloud.user.id, cloud.recovery],
  ([ready, uid, recovering]) => { if (ready && uid && !recovering) goTarget(); },
  { immediate: true },
);

/* —— 邮箱登录 / 注册 —— */
const authMode = ref("signin");
const authEmail = ref("");
const authPass = ref("");
const authNick = ref("");
const authBusy = ref(false);
const authMsg = ref("");
const authOk = ref(false);

/* —— 忘记密码（?forgot=1 直达发链接表单，「我的」页重置失效卡的入口） —— */
const forgot = ref(typeof route.query.forgot === "string");
const forgotBusy = ref(false);
const forgotMsg = ref("");
const forgotOk = ref(false);

/* —— 重置链接落地：设置新密码 —— */
const newPass = ref("");
const passBusy = ref(false);
const passMsg = ref("");

function clearAuthMsg() { authMsg.value = ""; authOk.value = false; }

function switchAuthMode() {
  authMode.value = authMode.value === "signin" ? "signup" : "signin";
  forgot.value = false;
  clearAuthMsg();
}
async function doAuth() {
  if (authBusy.value) return;
  const email = authEmail.value.trim();
  const bad = emailHint(email) || passHint(authPass.value);
  if (bad) { authOk.value = false; authMsg.value = bad; return; }
  authBusy.value = true;
  clearAuthMsg();
  const r = authMode.value === "signup"
    ? await cloudSignUp(email, authPass.value, authNick.value.trim())
    : await cloudSignIn(email, authPass.value);
  authBusy.value = false;
  if (!r.ok) {
    authOk.value = false;
    /* 轮 30：连续错 5 次锁 12 小时——专属文案（剩余小时数），不再透传原始错误 */
    authMsg.value = r.reason === "locked"
      ? t("profile.lockedOut", { h: r.hours || 12 })
      : t("profile.authFail", { r: r.reason || "unknown" });
    return;
  }
  if (r.needVerify) {
    authOk.value = true;
    authMsg.value = t("profile.verifySent");
    return;
  }
  cloudClearRecovery();   /* 轮 20 兜底：密码登录成功 ⇒ 不可能是恢复流程，残留恢复态一并清掉 */
  goTarget();   /* 登录成功（watch 也会触发，这里显式走一遍保证顺滑） */
}

function startForgot() {
  forgot.value = true;
  forgotMsg.value = "";
  forgotOk.value = false;
  clearAuthMsg();
}
function cancelForgot() {
  forgot.value = false;
  forgotMsg.value = "";
  forgotOk.value = false;
  clearAuthMsg();
}
async function doForgot() {
  if (forgotBusy.value) return;
  const bad = emailHint(authEmail.value);
  if (bad) { forgotOk.value = false; forgotMsg.value = bad; return; }
  forgotBusy.value = true;
  forgotMsg.value = "";
  forgotOk.value = false;
  const r = await cloudResetPassword(authEmail.value.trim());
  forgotBusy.value = false;
  if (!r.ok) { forgotMsg.value = t("profile.authFail", { r: r.reason || "unknown" }); return; }
  forgotOk.value = true;
  forgotMsg.value = t("profile.forgotSent");
}

async function doSetPassword() {
  if (passBusy.value) return;
  const bad = passHint(newPass.value);
  if (bad) { passMsg.value = bad; return; }
  passBusy.value = true;
  passMsg.value = "";
  const r = await cloudUpdatePassword(newPass.value);
  passBusy.value = false;
  if (!r.ok) { passMsg.value = t("profile.authFail", { r: r.reason || "unknown" }); return; }
  newPass.value = "";
  cloudClearRecovery();
  goTarget();   /* 密码已重置 = 已登录，回跳 */
}
function leaveRecovery() {
  newPass.value = "";
  passMsg.value = "";
  cloudClearRecovery();
}

/* —— Google 一键登录：整页跳去 Google；往返后 query 会丢，先存好回跳目标 —— */
const googleBusy = ref(false);
const googleMsg = ref("");
async function doGoogle() {
  if (googleBusy.value) return;
  try { setItem(REDIRECT_KEY, target()); } catch (e) { /* 存不上就算了 */ }
  googleBusy.value = true;
  googleMsg.value = "";
  const r = await cloudSignInWithGoogle();
  googleBusy.value = false;
  if (!r.ok) googleMsg.value = t("profile.authFail", { r: r.reason || "unknown" });
}
/* 轮 31：App 端走「App 内授权窗口 → 回跳 App」——点按钮那一刻不算失败，
 * 失败发生在回来之后（用户取消 / 令牌缺失 / 建会话报错），由 supabase.js 写进 cloud.appAuthErr。 */
watch(() => cloud.appAuthErr, (v) => {
  if (v) googleMsg.value = t("profile.appGoogleFail", { r: v });
});

/* —— 本地模式（云端未就绪）：起个访客昵称 —— */
const draftNick = ref("");
function continueAsGuest() {
  const n = draftNick.value.trim();
  if (!n) return;
  try { setItem("wp-nickname", n); } catch (e) { /* 忽略 */ }
  goTarget();
}

function goBack() {
  /* 有历史就退回去；直链进来（无历史）就回「我的」页 */
  if (typeof window !== "undefined" && window.history.state && window.history.state.back != null) {
    router.back();
  } else {
    router.replace("/profile").catch(() => {});
  }
}


function emailHint(email) {
  const p = emailProblem(email);
  if (!p) return "";
  return p === "missing" ? t("profile.needEmail") : t("profile.badEmail");
}
function passHint(pass) {
  const p = passwordProblem(pass);
  if (!p) return "";
  return p === "missing" ? t("profile.needPass") : t("profile.shortPass", { n: MIN_PASSWORD });
}
</script>

<template>
  <div class="login-page">
    <header class="login-head">
      <button class="login-back" aria-label="back" @click="goBack">&#8592;</button>
      <h1>{{ t("login.title") }}</h1>
    </header>
    <p class="sub login-sub">{{ t("login.sub") }}</p>

    <!-- 重置邮件失效（链接被用过 / 已过期）：如实说明，并给一条重新发的路 -->
    <section v-if="cloud.ready && !cloudSigned && cloud.recoveryErr && !cloud.recovery" class="card auth-card">
      <h2>{{ t("profile.resetLinkBad") }}</h2>
      <p class="notice">{{ t("profile.resetLinkBadWhy", { r: cloud.recoveryErr }) }}</p>
      <div style="margin-top: 12px">
        <n-button type="primary" round @click="startForgot">{{ t("profile.forgotTitle") }}</n-button>
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

    <!-- 云端登录 / 注册 -->
    <section v-else-if="cloud.ready && !cloudSigned" class="card auth-card">
      <div class="row-between">
        <h2>{{ t("profile.authTitle") }}</h2>
        <n-button v-if="!forgot" quaternary size="small" @click="switchAuthMode">
          {{ authMode === "signin" ? t("profile.toSignUp") : t("profile.toSignIn") }}
        </n-button>
      </div>

      <!-- Google 一键登录（忘记密码时先不需要它，避免歧义） -->
      <template v-if="!forgot">
        <button type="button" class="oauth-google" :disabled="googleBusy" @click="doGoogle">
          <span class="oauth-g" aria-hidden="true">G</span>
          <span>{{ googleBusy ? t("profile.googleBusy") : t("profile.googleSignIn") }}</span>
        </button>
        <p class="or-line"><span>{{ t("profile.orEmail") }}</span></p>
      </template>

      <!-- 忘记密码：只发链接，别让人以为密码已经改了 -->
      <template v-if="forgot">
        <h2 class="auth-sub">{{ t("profile.forgotTitle") }}</h2>
        <p class="notice" style="margin-top: 4px">{{ t("profile.forgotHint") }}</p>
      </template>

      <div class="q-input" :style="forgot ? 'margin-top: 12px' : ''">
        <n-input v-model:value="authEmail" round size="large"
          :placeholder="t('profile.authEmail')" @keyup.enter="forgot ? doForgot() : doAuth()" />
      </div>

      <template v-if="!forgot">
        <div class="q-input" style="margin-top: 8px">
          <n-input v-model:value="authPass" type="password" round size="large" show-password-on="click"
            :placeholder="t('profile.authPass')" @keyup.enter="doAuth" />
        </div>
        <div v-if="authMode === 'signup'" class="q-input" style="margin-top: 8px">
          <n-input v-model:value="authNick" round size="large"
            :placeholder="t('common.nickname')" @keyup.enter="doAuth" />
        </div>
        <div class="auth-actions">
          <n-button type="primary" round size="large" :loading="authBusy" @click="doAuth">
            {{ authMode === "signin" ? t("common.signIn") : t("common.signUp") }}
          </n-button>
          <n-button v-if="authMode === 'signin'" quaternary round @click="startForgot">
            {{ t("profile.forgot") }}
          </n-button>
        </div>
        <p class="notice" :class="{ bad: authMsg && !authOk, good: authOk }">
          {{ authMsg || t("common.localMode") }}
        </p>
        <p class="hint-min">{{ t("profile.passRule", { n: MIN_PASSWORD }) }}</p>
      </template>

      <template v-else>
        <div class="auth-actions">
          <n-button type="primary" round size="large" :loading="forgotBusy" @click="doForgot">
            {{ t("profile.forgotSend") }}
          </n-button>
          <n-button quaternary round @click="cancelForgot">{{ t("common.cancel") }}</n-button>
        </div>
        <p class="notice" :class="{ bad: forgotMsg && !forgotOk, good: forgotOk }">
          {{ forgotMsg || t("profile.forgotHint2") }}
        </p>
      </template>

      <p v-if="googleMsg" class="notice bad">{{ googleMsg }}</p>
    </section>

    <!-- 本地模式（云端未就绪）：起个访客昵称继续玩 -->
    <section v-if="!cloud.ready" class="card">
      <h2>{{ t("login.guestTitle") }}</h2>
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
  </div>
</template>

<style scoped>
.login-page { max-width: 560px; margin: 0 auto; }
.login-head { display: flex; align-items: center; gap: 10px; margin: 2px 0 6px; }
.login-head h1 { font-size: 20px; margin: 0; flex: 1; }
.login-back {
  appearance: none; font: inherit; cursor: pointer;
  min-width: 40px; min-height: 40px; border-radius: 999px;
  border: 1px solid rgba(160, 110, 60, .2); background: rgba(255, 255, 255, .7);
  font-weight: 800; font-size: 16px;
}
.login-sub { margin: 0 2px 14px; }
.auth-sub { margin: 6px 0 0; }
</style>

