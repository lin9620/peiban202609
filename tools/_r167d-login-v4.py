# 轮 167d：登录页终稿——纯白极简（用户定调）：白底+超大黑粗标题+珊瑚色按钮+极淡灰输入框
import io

def edit(p, pairs):
    s = io.open(p, encoding="utf-8").read()
    for old, new in pairs:
        assert s.count(old) == 1, f"{p}: anchor x{s.count(old)}: {old[:70]!r}"
        s = s.replace(old, new)
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)
    print("ok", p)

LV = "src/views/LoginView.vue"

# ═══ ① 模板：去渐变光斑/贴纸/毛玻璃，回归极简排版 ═══
edit(LV, [
("""  <div class="login-page">
    <div class="login-blob" aria-hidden="true"></div>
    <button class="login-back" aria-label="back" @click="goBack">&#8592;</button>

    <div class="login-wrap">
    <!-- 品牌徽章：干净的单色 SVG 爪印（emoji 各端渲染不一，弃用） -->
    <div class="login-badge anim d0" aria-hidden="true">
      <span class="sticker st1" aria-hidden="true">✨</span>
      <span class="sticker st2" aria-hidden="true">🧡</span>
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <defs>
          <linearGradient id="lg-paw" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#FF9F5A" />
            <stop offset="1" stop-color="#E76A9A" />
          </linearGradient>
        </defs>
        <g fill="url(#lg-paw)">
          <ellipse cx="23" cy="19" rx="6.2" ry="8.2" transform="rotate(-16 23 19)" />
          <ellipse cx="41" cy="19" rx="6.2" ry="8.2" transform="rotate(16 41 19)" />
          <ellipse cx="10.5" cy="30" rx="5.4" ry="7" transform="rotate(-38 10.5 30)" />
          <ellipse cx="53.5" cy="30" rx="5.4" ry="7" transform="rotate(38 53.5 30)" />
          <path d="M32 29.5c8.6 0 15.6 5.8 15.6 13 0 6.8-5.9 11.9-15.6 11.9S16.4 49.3 16.4 42.5c0-7.2 7-13 15.6-13z" />
        </g>
      </svg>
    </div>
    <h1 class="login-title anim d1">{{ t("login.title") }}</h1>
    <p class="login-sub anim d2">{{ t("login.sub") }}</p>""",
 """  <div class="login-page">
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
    <p class="login-sub anim d1">{{ t("login.sub") }}</p>"""),
# 卡片壳 → 极简无卡（登录/注册主段 + 其余段改成细线盒）
("""    <section v-if="cloud.ready && !cloudSigned && cloud.recoveryErr && !cloud.recovery" class="login-card anim d3">""",
 """    <section v-if="cloud.ready && !cloudSigned && cloud.recoveryErr && !cloud.recovery" class="login-box anim d3">"""),
("""    <section v-else-if="cloud.ready && cloud.recovery" class="login-card anim d3">""",
 """    <section v-else-if="cloud.ready && cloud.recovery" class="login-box anim d3">"""),
("""    <section v-else-if="cloud.ready && !cloudSigned" class="login-card anim d3">""",
 """    <section v-else-if="cloud.ready && !cloudSigned" class="anim d2">"""),
("""    <section v-if="!cloud.ready" class="login-card anim d3">""",
 """    <section v-if="!cloud.ready" class="login-box anim d3">"""),
# 分段 tabs → 底部一行切换链接（极简口径）
("""      <div v-if="!forgot" class="auth-tabs" role="tablist">
        <span class="auth-tab-pill" :class="{ right: authMode === 'signup' }" aria-hidden="true"></span>
        <button type="button" role="tab" :aria-selected="authMode === 'signin'"
          :class="{ on: authMode === 'signin' }" @click="setMode('signin')">{{ t("common.signIn") }}</button>
        <button type="button" role="tab" :aria-selected="authMode === 'signup'"
          :class="{ on: authMode === 'signup' }" @click="setMode('signup')">{{ t("common.signUp") }}</button>
      </div>
      <h2 v-else class="login-card-title">{{ t("profile.forgotTitle") }}</h2>""",
 """      <h2 v-if="forgot" class="login-box-title">{{ t("profile.forgotTitle") }}</h2>"""),
# 底部切换链接：第一次来？注册一个账号 / 已有账号？去登录
("""    <p class="login-foot anim d4">{{ t("common.localMode") }}</p>""",
 """    <div v-if="cloud.ready && !cloudSigned && !cloud.recovery" class="auth-switch anim d3">
      <span>{{ authMode === "signin" ? t("profile.toSignUp") : t("profile.toSignIn") }}</span>
      <button type="button" class="auth-switch-btn"
        @click="setMode(authMode === 'signin' ? 'signup' : 'signin')">
        {{ authMode === "signin" ? t("common.signUp") : t("common.signIn") }}
      </button>
    </div>
    <p class="login-foot anim d4">{{ t("common.localMode") }}</p>"""),
])

# ═══ ② style 整体替换（v4 纯白极简） ═══
s = io.open(LV, encoding="utf-8").read()
i = s.index("<style scoped>")
s = s[:i] + '''<style scoped>
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
.login-page .n-input { --n-border-radius: 14px; }
.login-page .n-input { background: #f6f6f5; }
html[data-theme="night"] .login-page .n-input { background: rgba(139, 156, 232, .12); }
.login-page .n-input + .n-input, .n-input + .n-button, .n-button + .n-input { margin-top: 10px; }

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
.login-foot { margin: 22px 10px 0; text-align: center; font-size: 12px; color: var(--ink-faint); line-height: 1.6; }
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
'''
io.open(LV, "w", encoding="utf-8", newline="\n").write(s)
print("LoginView v4 done")
