# 轮 167：登录页重设计——品牌头/居中卡片/分段切换/入场动画（逻辑全保留）
import io

def edit(p, pairs):
    s = io.open(p, encoding="utf-8").read()
    for old, new in pairs:
        assert s.count(old) == 1, f"{p}: anchor x{s.count(old)}: {old[:70]!r}"
        s = s.replace(old, new)
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)
    print("ok", p)

LV = "src/views/LoginView.vue"

# ═══ ① script：加 setMode（分段切换用；原 switchAuthMode 保留给旧入口兼容，但模板改用 setMode） ═══
edit(LV, [
("""function switchAuthMode() {
  authMode.value = authMode.value === "signin" ? "signup" : "signin";
  forgot.value = false;
  clearAuthMsg();
}""",
 """function switchAuthMode() {
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
}"""),
])

# ═══ ② template + style 整体重写（script 到 </script> 为止不动） ═══
s = io.open(LV, encoding="utf-8").read()
idx = s.index("</script>")
s_head = s[: idx + len("</script>")]
s_new = s_head + '''

<template>
  <div class="login-page">
    <button class="login-back" aria-label="back" @click="goBack">&#8592;</button>

    <!-- 品牌头：爪印 + 名字 + 一句话 -->
    <div class="login-hero anim d0">
      <div class="login-paw" aria-hidden="true">🐾</div>
      <div class="login-brand">{{ t("brand") }}</div>
      <div class="login-tag">{{ t("tagline") }}</div>
    </div>
    <h1 class="login-title anim d1">{{ t("login.title") }}</h1>
    <p class="login-sub anim d2">{{ t("login.sub") }}</p>

    <!-- 重置邮件失效（链接被用过 / 已过期）：如实说明，并给一条重新发的路 -->
    <section v-if="cloud.ready && !cloudSigned && cloud.recoveryErr && !cloud.recovery" class="login-card anim d3">
      <h2 class="login-card-title">{{ t("profile.resetLinkBad") }}</h2>
      <p class="notice">{{ t("profile.resetLinkBadWhy", { r: cloud.recoveryErr }) }}</p>
      <n-button type="primary" round block @click="startForgot">{{ t("profile.forgotTitle") }}</n-button>
    </section>

    <!-- 重置链接已生效：设置新密码（保存后即为登录状态） -->
    <section v-else-if="cloud.ready && cloud.recovery" class="login-card anim d3">
      <h2 class="login-card-title">{{ t("profile.setPassTitle") }}</h2>
      <p class="notice">{{ t("profile.setPassHint") }}</p>
      <n-input v-model:value="newPass" type="password" round size="large" show-password-on="click"
        :placeholder="t('profile.newPass')" @keyup.enter="doSetPassword" />
      <n-button type="primary" round size="large" block :loading="passBusy" @click="doSetPassword">
        {{ t("profile.savePass") }}
      </n-button>
      <div class="auth-links">
        <button type="button" class="auth-link" @click="leaveRecovery">{{ t("profile.backToSignIn") }}</button>
      </div>
      <p v-if="passMsg" class="notice bad">{{ passMsg }}</p>
    </section>

    <!-- 云端登录 / 注册 -->
    <section v-else-if="cloud.ready && !cloudSigned" class="login-card anim d3">
      <!-- 分段：登录 | 注册（忘记密码态收起，让位给说明标题） -->
      <div v-if="!forgot" class="auth-tabs" role="tablist">
        <span class="auth-tab-pill" :class="{ right: authMode === 'signup' }" aria-hidden="true"></span>
        <button type="button" role="tab" :aria-selected="authMode === 'signin'"
          :class="{ on: authMode === 'signin' }" @click="setMode('signin')">{{ t("common.signIn") }}</button>
        <button type="button" role="tab" :aria-selected="authMode === 'signup'"
          :class="{ on: authMode === 'signup' }" @click="setMode('signup')">{{ t("common.signUp") }}</button>
      </div>
      <h2 v-else class="login-card-title">{{ t("profile.forgotTitle") }}</h2>

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

      <n-input v-model:value="authEmail" round size="large"
        :placeholder="t('profile.authEmail')" @keyup.enter="forgot ? doForgot() : doAuth()" />

      <template v-if="!forgot">
        <n-input v-model:value="authPass" type="password" round size="large" show-password-on="click"
          :placeholder="t('profile.authPass')" @keyup.enter="doAuth" />
        <n-input v-if="authMode === 'signup'" v-model:value="authNick" round size="large"
          :placeholder="t('common.nickname')" @keyup.enter="doAuth" />
        <n-button type="primary" round size="large" block :loading="authBusy" @click="doAuth">
          {{ authMode === "signin" ? t("common.signIn") : t("common.signUp") }}
        </n-button>
        <div v-if="authMode === 'signin'" class="auth-links">
          <button type="button" class="auth-link" @click="startForgot">{{ t("profile.forgot") }}</button>
        </div>
        <p v-if="authMsg" class="notice" :class="{ bad: !authOk, good: authOk }">{{ authMsg }}</p>
        <p class="hint-min">{{ t("profile.passRule", { n: MIN_PASSWORD }) }}</p>
      </template>

      <template v-else>
        <n-button type="primary" round size="large" block :loading="forgotBusy" @click="doForgot">
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
    <section v-if="!cloud.ready" class="login-card anim d3">
      <h2 class="login-card-title">{{ t("login.guestTitle") }}</h2>
      <n-input v-model:value="draftNick" round size="large"
        :placeholder="t('common.nickname')" @keyup.enter="continueAsGuest" />
      <n-button type="primary" round size="large" block @click="continueAsGuest">
        {{ t("common.save") }}
      </n-button>
    </section>

    <p class="login-foot anim d4">{{ t("common.localMode") }}</p>
  </div>
</template>

<style scoped>
/* 轮 167：登录页重设计——品牌头 + 居中卡片 + 分段切换 + 入场动画。
 * 全宽改成居中窄列：登录页就该是一张居中的表单卡（用户实测「完全不像正常 App 登录页」）。 */
.login-page {
  max-width: 400px; margin: 0 auto;
  min-height: calc(100dvh - 120px);
  display: flex; flex-direction: column; justify-content: center;
  padding: 60px 4px 24px; position: relative;
}
.login-back {
  position: absolute; top: 12px; left: 8px; z-index: 2;
  appearance: none; font: inherit; cursor: pointer;
  min-width: 40px; min-height: 40px; border-radius: 999px;
  border: 1px solid var(--hairline); background: var(--wash);
  font-weight: 500; font-size: 16px; color: var(--ink);
  transition: background-color .15s ease, transform .15s ease;
}
.login-back:hover { background: var(--wash-mid); }
.login-back:active { transform: scale(.94); }

/* 品牌头 */
.login-hero { display: flex; flex-direction: column; align-items: center; gap: 5px; margin-bottom: 14px; }
.login-paw {
  width: 76px; height: 76px; border-radius: 26px;
  display: grid; place-items: center; font-size: 40px;
  background: var(--accent-soft); border: 1px solid var(--hairline);
  box-shadow: var(--shadow-sm);
  animation: paw-breathe 3.4s ease-in-out infinite;
}
.login-brand { font-family: var(--font-display); font-size: 26px; font-weight: 600; color: var(--ink); letter-spacing: .02em; }
.login-tag { font-size: 12.5px; color: var(--ink-faint); letter-spacing: .05em; }
.login-title { font-size: 19px; font-weight: 600; color: var(--ink); margin: 2px 0 4px; text-align: center; }
.login-sub { margin: 0 10px 18px; text-align: center; color: var(--ink-soft); font-size: 13.5px; line-height: 1.6; }

/* 表单卡 */
.login-card {
  background: var(--card); border: 1px solid var(--hairline); border-radius: 20px;
  box-shadow: var(--shadow-sm);
  padding: 18px 16px 14px;
  display: flex; flex-direction: column; gap: 10px;
}
.login-card-title { font-size: 16px; font-weight: 600; color: var(--ink); margin: 0 0 2px; }

/* 分段：登录 | 注册 */
.auth-tabs {
  position: relative; display: grid; grid-template-columns: 1fr 1fr;
  background: var(--wash); border-radius: 999px; padding: 4px; margin-bottom: 2px;
}
.auth-tab-pill {
  position: absolute; top: 4px; left: 4px;
  width: calc(50% - 4px); height: calc(100% - 8px);
  background: var(--accent); border-radius: 999px;
  transition: transform .26s cubic-bezier(.22, .61, .36, 1);
}
.auth-tab-pill.right { transform: translateX(100%); }
.auth-tabs button {
  appearance: none; font: inherit; cursor: pointer; border: none; background: none;
  min-height: 38px; border-radius: 999px; font-size: 14px; font-weight: 600;
  color: var(--ink-soft); position: relative; z-index: 1; transition: color .2s ease;
}
.auth-tabs button.on { color: #fff; }

.auth-links { display: flex; justify-content: center; }
.auth-link {
  appearance: none; border: none; background: none; font: inherit; cursor: pointer;
  color: var(--ink-soft); font-size: 13px; padding: 2px 8px; border-radius: 8px;
  transition: color .15s ease;
}
.auth-link:hover { color: var(--accent-deep); }
.hint-min { margin: -2px 2px 0; font-size: 11.5px; color: var(--ink-faint); text-align: center; }
.login-foot { margin: 16px 8px 0; text-align: center; font-size: 12px; color: var(--ink-faint); line-height: 1.6; }
.login-card .oauth-google { width: 100%; }

/* 入场动画：品牌 → 标题 → 说明 → 卡片 → 页脚 逐层浮入 */
.anim { animation: login-in .5s cubic-bezier(.22, .61, .36, 1) both; }
.d0 { animation-delay: .02s; }
.d1 { animation-delay: .08s; }
.d2 { animation-delay: .14s; }
.d3 { animation-delay: .2s; }
.d4 { animation-delay: .3s; }
@keyframes login-in {
  from { opacity: 0; transform: translateY(14px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes paw-breathe {
  0%, 100% { transform: scale(1) rotate(0deg); }
  50% { transform: scale(1.06) rotate(-3deg); }
}
@media (prefers-reduced-motion: reduce) {
  .login-page .anim, .login-page .login-paw { animation: none !important; }
}
</style>
'''
io.open(LV, "w", encoding="utf-8", newline="\n").write(s_new)
print("LoginView redesigned")
