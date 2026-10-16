<!-- 登录页（/login）：手机 + 网页共用。
     把原来长在「我的」页里的登录 / 注册 / 忘记密码 / Google / 重置密码整体搬来独立成页，
     未登录时的所有 needSignIn 提示都可以指向这里；登录成功后按 redirect 回跳。 -->
<script setup>
import { ref, computed, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { NButton, NInput } from "naive-ui";
import { t } from "../i18n.js";
import { getItem, setItem } from "../utils/storage.js";
import { isApp, tabbarSuppressed } from "../stores/uiStore.js";
import {
  cloud, cloudSignUp, cloudSignIn,
  cloudResetPassword, cloudUpdatePassword, cloudSignInWithGoogle, cloudClearRecovery,
} from "../utils/supabase.js";
import { MIN_PASSWORD, emailProblem, passwordProblem } from "../utils/authRules.js";
import { db } from "../utils/api/db.js";
import TurnstileGate from "../components/TurnstileGate.vue";   /* 轮 311 · P2 人机门槛 */

const route = useRoute();
const router = useRouter();
/* 轮 167b：登录页压掉底部 TabBar（全屏登录形态，像正经 App） */
import { onMounted, onBeforeUnmount } from "vue";
onMounted(() => { tabbarSuppressed.value = true; });
onBeforeUnmount(() => { tabbarSuppressed.value = false; });
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
/* 轮 311 · P2：Turnstile 人机门槛 —— sitekey 未配置（VITE_TURNSTILE_SITEKEY 空）时
 * 整条链路零打扰（widget 不渲染、校验函数直通）。注册/登录/忘记密码共用一个 widget：
 * token 先打 /api/turnstile/verify（Worker 用服务端 secret 校验），通过才调 Auth。
 * 服务端兜底：Worker 侧举报强制校验 + 统一限流闸；这里是挡脚本化注册的第一道门。 */
const env = import.meta.env || {};
const TS_SITEKEY = String(env.VITE_TURNSTILE_SITEKEY || "").trim();
const tsToken = ref("");
const tsGate = ref(null);
async function passTurnstile() {
  if (!TS_SITEKEY) return true;                       /* 未启用：直通 */
  if (!tsToken.value) { authOk.value = false; authMsg.value = t("common.turnstileFirst"); return false; }
  try {
    const r = await db.turnstileVerify(tsToken.value);
    if (r && r.ok === true) return true;
  } catch (e) { /* 落到下面统一失败提示 */ }
  authOk.value = false;
  authMsg.value = t("common.turnstileFail");
  try { if (tsGate.value) tsGate.value.reset(); } catch (e) { /* 已卸载 */ }
  return false;
}
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

/* 轮250（全局巡检实证「没成功：email rate limit」）：reason 里混着 Supabase 英文原文，
 * 原样塞进 authFail 会把英文透给用户。常见原因本地化；未知兜底仍透原码（保可诊断性）。 */
function authErrText(r) {
  const s = String(r || "unknown");
  if (/rate.?limit|too many/i.test(s)) return t("profile.errRateLimit");
  if (/invalid login|invalid.*credential|wrong password/i.test(s)) return t("profile.errBadCreds");
  if (/already (been )?registered|user already/i.test(s)) return t("profile.errEmailTaken");
  if (/password.*(short|weak)|at least 6/i.test(s)) return t("profile.errWeak");
  if (/not.?confirmed|confirm.*email|verification/i.test(s)) return t("profile.errNotConfirm");
  if (/network|failed to fetch|fetch failed/i.test(s)) return t("profile.errNetwork");
  return t("profile.authFail", { r: s });
}

function switchAuthMode() {
  authMode.value = authMode.value === "signin" ? "signup" : "signin";
  forgot.value = false;
  clearAuthMsg();
}
/* 轮 167：分段登录/注册切换（指定目标态；切走时一并清错误与忘记密码态） */
function setMode(m) {
  if (authMode.value === m) { forgot.value = false; clearAuthMsg(); return; }
  authMode.value = m;
  forgot.value = false;
  clearAuthMsg();
}
async function doAuth() {
  if (authBusy.value) return;
  const email = authEmail.value.trim();
  const bad = emailHint(email) || passHint(authPass.value);
  if (bad) { authOk.value = false; authMsg.value = bad; return; }
  if (!(await passTurnstile())) return;   /* 轮 311 · P2：人机门槛不过不调 Auth */
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
      : authErrText(r.reason);
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
  if (!(await passTurnstile())) return;   /* 轮 311 · P2：找回密码同样是匿名入口，同过门槛 */
  forgotBusy.value = true;
  forgotMsg.value = "";
  forgotOk.value = false;
  const r = await cloudResetPassword(authEmail.value.trim());
  forgotBusy.value = false;
  if (!r.ok) { forgotMsg.value = authErrText(r.reason); return; }
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
  if (!r.ok) { passMsg.value = authErrText(r.reason); return; }
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
  if (!r.ok) googleMsg.value = authErrText(r.reason);
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
/* 轮 314（用户截图：规则提示别常驻，输入不达标时再提示）：
 * 空着不提示（还没开始输入，那不是「不达标」）；一旦输入却不足 6 位就在框下出现。
 * 判据直接复用 passwordProblem（纯函数），与提交校验、服务端口径同一套，不会长出第二个标准。 */
const passShort = computed(() => passwordProblem(authPass.value) === "short");
</script>

<template>
  <div class="login-page">
    <button class="login-back" aria-label="back" @click="goBack">&#8592;</button>

    <div class="login-wrap">
    <div class="login-paw anim d0" aria-hidden="true">
      <svg viewBox="0 0 64 64">
        <g fill="var(--accent)">
          <ellipse cx="23" cy="19" rx="6.2" ry="8.2" transform="rotate(-16 23 19)" />
          <ellipse cx="41" cy="19" rx="6.2" ry="8.2" transform="rotate(16 41 19)" />
          <ellipse cx="10.5" cy="30" rx="5.4" ry="7" transform="rotate(-38 10.5 30)" />
          <ellipse cx="53.5" cy="30" rx="5.4" ry="7" transform="rotate(38 53.5 30)" />
          <path d="M32 29.5c8.6 0 15.6 5.8 15.6 13 0 6.8-5.9 11.9-15.6 11.9S16.4 49.3 16.4 42.5c0-7.2 7-13 15.6-13z" />
        </g>
      </svg>
    </div>
    <h1 class="login-title anim d0">{{ t("login.title") }}</h1>
    <p class="login-sub anim d1">{{ t("login.sub") }}</p>

    <!-- 重置邮件失效（链接被用过 / 已过期）：如实说明，并给一条重新发的路 -->
    <section v-if="cloud.ready && !cloudSigned && cloud.recoveryErr && !cloud.recovery" class="login-box anim d3">
      <h2 class="login-card-title">{{ t("profile.resetLinkBad") }}</h2>
      <p class="notice">{{ t("profile.resetLinkBadWhy", { r: cloud.recoveryErr }) }}</p>
      <n-button type="primary" round block @click="startForgot">{{ t("profile.forgotTitle") }}</n-button>
    </section>

    <!-- 重置链接已生效：设置新密码（保存后即为登录状态） -->
    <section v-else-if="cloud.ready && cloud.recovery" class="login-box anim d3">
      <h2 class="login-card-title">{{ t("profile.setPassTitle") }}</h2>
      <p class="notice">{{ t("profile.setPassHint") }}</p>
      <n-input v-model:value="newPass" type="password" round size="large" show-password-on="click"
        :placeholder="t('profile.newPass')" @keyup.enter="doSetPassword" />
      <n-button type="primary" class="auth-cta" round size="large" block :loading="passBusy" @click="doSetPassword">
        {{ t("profile.savePass") }}
      </n-button>
      <div class="auth-links">
        <button type="button" class="auth-link" @click="leaveRecovery">{{ t("profile.backToSignIn") }}</button>
      </div>
      <p v-if="passMsg" class="notice bad">{{ passMsg }}</p>
    </section>

    <!-- 云端登录 / 注册 -->
    <section v-else-if="cloud.ready && !cloudSigned" class="anim d2">
      <!-- 分段：登录 | 注册（忘记密码态收起，让位给说明标题） -->
      <h2 v-if="forgot" class="login-box-title">{{ t("profile.forgotTitle") }}</h2>

      <!-- Google 一键登录（忘记密码时先不需要它，避免歧义）。
           轮 63：Google 禁止 WebView 内登录（防钓鱼），App 内最佳形态是 Chrome Custom Tabs，
           而它依赖设备上有支持 CCT 的浏览器（无 Chrome 的国产 ROM 会回退外部浏览器）——
           提前一句话给预期：会打开浏览器，登录完自动回来（深链回跳，轮 31 的中转页链路）。 -->
      <template v-if="!forgot">
        <button type="button" class="oauth-google" :disabled="googleBusy" @click="doGoogle">
          <span class="oauth-g" aria-hidden="true">G</span>
          <span>{{ googleBusy ? t("profile.googleBusy") : t("profile.googleSignIn") }}</span>
        </button>
        <p v-if="isApp" class="oauth-hint">{{ t("profile.googleAppHint") }}</p>
        <p class="or-line"><span>{{ t("profile.orEmail") }}</span></p>
      </template>
      <p v-if="forgot" class="notice">{{ t("profile.forgotHint") }}</p>

      <n-input v-model:value="authEmail" type="email" round size="large"
        :placeholder="t('profile.authEmail')" @keyup.enter="forgot ? doForgot() : doAuth()" />

      <!-- 轮 311 · P2：人机验证（sitekey 未配置时不渲染；登录/注册/找回密码共用） -->
      <turnstile-gate ref="tsGate" v-model="tsToken" :sitekey="TS_SITEKEY" />

      <template v-if="!forgot">
        <n-input v-model:value="authPass" type="password" round size="large" show-password-on="click"
          :placeholder="t('profile.authPass')" @keyup.enter="doAuth" />
        <!-- 轮 314b（用户截图：红框圈住「忘记密码?」+ 箭头指向密码框 → 「让他贴着密码框。右下」）：
             原来它挂在登录按钮下面居中，离密码框隔着一个按钮；现在贴着密码框右下（右对齐）。
             注意：这行插在「密码框」与「登录按钮」中间，会打断 .n-input + .n-button 的 10px 间距规则，
             已在 scoped 样式里用 .forgot-row + .n-button 补回来（见下方注释）。 -->
        <div v-if="authMode === 'signin'" class="forgot-row">
          <button type="button" class="auth-link" @click="startForgot">{{ t("profile.forgot") }}</button>
        </div>
        <n-input v-if="authMode === 'signup'" v-model:value="authNick" round size="large"
          :placeholder="t('common.nickname')" @keyup.enter="doAuth" />
        <n-button type="primary" class="auth-cta" round size="large" block :loading="authBusy" @click="doAuth">
          {{ authMode === "signin" ? t("common.signIn") : t("common.signUp") }}
        </n-button>
        <p v-if="authMsg" class="notice" :class="{ bad: !authOk, good: authOk }">{{ authMsg }}</p>
        <!-- 轮 314：规则提示改成「输入不达标才出现」（原来常驻一行，用户看着像已经在报错了） -->
        <p v-if="passShort" class="hint-min hint-min--warn">{{ t("profile.passRule", { n: MIN_PASSWORD }) }}</p>
      </template>

      <template v-else>
        <n-button type="primary" class="auth-cta" round size="large" block :loading="forgotBusy" @click="doForgot">
          {{ t("profile.forgotSend") }}
        </n-button>
        <div class="auth-links">
          <button type="button" class="auth-link" @click="cancelForgot">{{ t("common.cancel") }}</button>
        </div>
        <p v-if="forgotMsg" class="notice" :class="{ bad: !forgotOk, good: forgotOk }">{{ forgotMsg }}</p>
      </template>

      <p v-if="googleMsg" class="notice bad">{{ googleMsg }}</p>
    </section>

    <!-- 本地模式（云端未就绪）：起个访客昵称继续玩 -->
    <section v-if="!cloud.ready" class="login-box anim d3">
      <h2 class="login-card-title">{{ t("login.guestTitle") }}</h2>
      <n-input v-model:value="draftNick" round size="large"
        :placeholder="t('common.nickname')" @keyup.enter="continueAsGuest" />
      <n-button type="primary" class="auth-cta" round size="large" block @click="continueAsGuest">
        {{ t("common.save") }}
      </n-button>
    </section>

    <div v-if="cloud.ready && !cloudSigned && !cloud.recovery" class="auth-switch anim d3">
      <span>{{ authMode === "signin" ? t("profile.toSignUp") : t("profile.toSignIn") }}</span>
      <button type="button" class="auth-switch-btn"
        @click="setMode(authMode === 'signin' ? 'signup' : 'signin')">
        {{ authMode === "signin" ? t("common.signUp") : t("common.signIn") }}
      </button>
    </div>
    <p class="login-agree anim d3">
      {{ t("login.agreePre") }}
      <router-link to="/privacy" class="agree-link">{{ t("login.agreeLink") }}</router-link>
    </p>
    </div>
  </div>
</template>

<style scoped>
/* 轮 167d：登录页终稿——纯白极简（用户定调）：白底 + 超大黑粗标题 + 一抹珊瑚色。
 * 没有卡片壳：表单直接落在白底上，靠间距分组；输入框极淡灰填充。 */
.login-page {
  max-width: 400px; margin: 0 auto; position: relative;
  min-height: calc(100dvh - 120px);
  display: flex; flex-direction: column; justify-content: center;
  padding: 48px 24px 28px;
}
.login-back {
  position: absolute; top: 12px; left: 8px; z-index: 2;
  appearance: none; font: inherit; cursor: pointer;
  min-width: 40px; min-height: 40px; border-radius: 999px;
  border: none; background: #f4f4f2;
  font-weight: 500; font-size: 16px; color: var(--ink);
  transition: transform .15s ease, background-color .15s ease;
}
.login-back:hover { background: #ececea; }
.login-back:active { transform: scale(.94); }
html[data-theme="night"] .login-back { background: rgba(139, 156, 232, .14); }

/* 极小爪印：一行品牌暗示，不做大徽章 */
.login-paw { display: flex; justify-content: center; margin-bottom: 12px; }
.login-paw svg { width: 30px; height: 30px; }

/* 超大黑粗标题 */
.login-title {
  font-size: 28px; font-weight: 800; letter-spacing: -.015em;
  color: var(--ink); text-align: center; margin: 0 0 10px;
}
.login-sub {
  margin: 0 6px 28px; text-align: center;
  color: var(--ink-soft); font-size: 13.5px; line-height: 1.65;
}

/* 表单分组：不画卡，靠间距；输入框极淡灰填充 */
.login-page .n-input { --n-border-radius: 14px; background: #f6f6f5; }
html[data-theme="night"] .login-page .n-input { background: rgba(139, 156, 232, .12); }
.n-input + .n-input, .n-input + .n-button, .n-button + .n-input { margin-top: 10px; }

/* 主按钮：珊瑚色实底 + 14px 圆角 + 粗字 */
.login-page .n-button--primary-type {
  border-radius: 14px !important; font-weight: 700;
  background-color: var(--accent-deep) !important;
}
.login-page .n-button--primary-type:hover { background-color: var(--accent) !important; }

.auth-links { display: flex; justify-content: center; margin-top: 2px; }
.auth-link {
  appearance: none; border: none; background: none; font: inherit; cursor: pointer;
  color: var(--ink-soft); font-size: 13px; padding: 2px 8px; border-radius: 8px;
  transition: color .15s ease;
}
.auth-link:hover { color: var(--accent-deep); }
.hint-min { margin: 2px 2px 0; font-size: 11.5px; color: var(--ink-faint); text-align: center; }
/* 轮 314（用户截图定稿两处）：
 * ① 密码规则提示只在「输入不达标」时出现 → 出现即用品牌色，明确是提醒而不是常驻说明；
 * ② 「或使用邮箱」要加宽的是**中间那段**（实测整条分隔线与 Google 按钮/输入框同为 309px，
 *    宽度本来就是齐的）：把两侧线与文字的间距放宽、字号抬一档，字不再贴着线。 */
.hint-min--warn { color: var(--accent-deep); }
/* 轮 314c（用户：或使用邮箱 跟下面邮箱框的距离要加大，「起码跟上面的距离一样」）：
 * 实测改前 上=14px、**下=0px**（邮箱框直接顶在分隔线底边上）——全局 .or-line 只有 margin:14px 0 0。
 * 这里补成上下对称的 14px（本规则特异性高于全局那条，生效的就是它）。 */
.login-page .or-line { margin: 14px 0; gap: 20px; font-size: 12px; }
/* 轮 314b（用户：忘记密码?「让他贴着密码框。右下」）：
 * ① 贴着密码框右下：右对齐、只留 4px 呼吸（原来居中挂在登录按钮下面，隔着一个按钮那么远）；
 * ② 这行夹在「密码框」与「登录按钮」中间 → .n-input + .n-button 那条 10px 间距规则失效，
 *    这里补回来，否则按钮会直接贴上来；③ 链接自带 8px 内边距，往右拽回 6px 让文字与输入框右缘齐平。 */
.forgot-row { display: flex; justify-content: flex-end; margin: 4px -6px 0 0; }
.forgot-row + .n-button { margin-top: 10px; }
.login-agree { margin: 22px 10px 0; text-align: center; font-size: 12px; color: var(--ink-faint); }
.agree-link { color: var(--ink-soft); text-decoration: underline; text-underline-offset: 2px; }
.agree-link:hover { color: var(--accent-deep); }
.login-page .oauth-google { width: 100%; }

/* 底部切换：一句话 + 高亮动作词 */
.auth-switch {
  margin-top: 20px; text-align: center; font-size: 13.5px; color: var(--ink-soft);
  display: flex; justify-content: center; align-items: center; gap: 6px;
}
.auth-switch-btn {
  appearance: none; border: none; background: none; font: inherit; cursor: pointer;
  color: var(--accent-deep); font-weight: 700; padding: 2px 4px;
}
.auth-switch-btn:hover { text-decoration: underline; }

/* 细线盒（重置密码等低频态）：极淡边框，不抢戏 */
.login-box {
  border: 1px solid var(--hairline); border-radius: 18px; padding: 18px 16px 14px;
  display: flex; flex-direction: column; gap: 10px;
}
.login-box-title { font-size: 16px; font-weight: 700; color: var(--ink); margin: 0 0 2px; }

/* 入场：整块轻浮入，不抢戏 */
.anim { animation: login-in .45s cubic-bezier(.22, .61, .36, 1) both; }
.d1 { animation-delay: .07s; }
.d2 { animation-delay: .13s; }
.d3 { animation-delay: .19s; }
@keyframes login-in {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}
@media (prefers-reduced-motion: reduce) {
  .login-page .anim { animation: none !important; }
}
</style>
