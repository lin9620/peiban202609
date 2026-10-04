# 轮 167c：登录页三稿——年轻人审美：全屏渐变 + 毛玻璃卡 + 渐变爪印贴纸 + 漂浮小表情
import io

def edit(p, pairs):
    s = io.open(p, encoding="utf-8").read()
    for old, new in pairs:
        assert s.count(old) == 1, f"{p}: anchor x{s.count(old)}: {old[:70]!r}"
        s = s.replace(old, new)
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)
    print("ok", p)

LV = "src/views/LoginView.vue"

# ═══ ① 徽章：渐变爪印贴纸 + 漂浮小表情；标题整条渐变字 ═══
edit(LV, [
("""    <div class="login-badge anim d0" aria-hidden="true">
      <svg viewBox="0 0 64 64">
        <ellipse cx="23" cy="19" rx="6.2" ry="8.2" transform="rotate(-16 23 19)" />
        <ellipse cx="41" cy="19" rx="6.2" ry="8.2" transform="rotate(16 41 19)" />
        <ellipse cx="10.5" cy="30" rx="5.4" ry="7" transform="rotate(-38 10.5 30)" />
        <ellipse cx="53.5" cy="30" rx="5.4" ry="7" transform="rotate(38 53.5 30)" />
        <path d="M32 29.5c8.6 0 15.6 5.8 15.6 13 0 6.8-5.9 11.9-15.6 11.9S16.4 49.3 16.4 42.5c0-7.2 7-13 15.6-13z" />
      </svg>
    </div>
    <h1 class="login-title anim d1">{{ t("login.title") }}</h1>""",
 """    <div class="login-badge anim d0">
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
    <h1 class="login-title anim d1">{{ t("login.title") }}</h1>"""),
])

# ═══ ② 主按钮挂渐变 class（登录/注册/保存/发链接 4 处） ═══
edit(LV, [
("""        <n-button type="primary" round size="large" block :loading="authBusy" @click="doAuth">""",
 """        <n-button type="primary" class="auth-cta" round size="large" block :loading="authBusy" @click="doAuth">"""),
("""        <n-button type="primary" round size="large" block :loading="forgotBusy" @click="doForgot">""",
 """        <n-button type="primary" class="auth-cta" round size="large" block :loading="forgotBusy" @click="doForgot">"""),
("""      <n-button type="primary" round size="large" block :loading="passBusy" @click="doSetPassword">""",
 """      <n-button type="primary" class="auth-cta" round size="large" block :loading="passBusy" @click="doSetPassword">"""),
("""      <n-button type="primary" round size="large" block @click="continueAsGuest">""",
 """      <n-button type="primary" class="auth-cta" round size="large" block @click="continueAsGuest">"""),
])

# ═══ ③ 样式整体替换（v3） ═══
s = io.open(LV, encoding="utf-8").read()
i = s.index("<style scoped>")
s = s[:i] + '''<style scoped>
/* 轮 167c：登录页三稿——给年轻人的：全屏珊瑚→樱粉→丁香渐变打底、毛玻璃卡、
 * 渐变爪印贴纸 + 漂浮小表情、渐变标题字与渐变主按钮、TabBar 收起全屏登录。 */
.login-page {
  max-width: 420px; margin: 0 auto; position: relative;
  min-height: calc(100dvh - 120px);
  display: flex; align-items: center; justify-content: center;
  padding: 48px 6px 28px;
}
/* 渐变打底铺满整个视口（fixed inset 0），main 内边距不再漏白框 */
.login-blob {
  position: fixed; inset: 0; pointer-events: none;
  background: linear-gradient(158deg, #fff1e4 0%, #ffe3da 32%, #ffdcec 60%, #e7ddff 100%);
}
html[data-theme="night"] .login-blob {
  background: linear-gradient(158deg, #1d2140 0%, #231e42 55%, #2a2145 100%);
}
.login-back {
  position: absolute; top: 12px; left: 8px; z-index: 2;
  appearance: none; font: inherit; cursor: pointer;
  min-width: 40px; min-height: 40px; border-radius: 999px;
  border: none; background: rgba(255, 255, 255, .65);
  font-weight: 500; font-size: 16px; color: var(--ink);
  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
  transition: transform .15s ease;
}
.login-back:active { transform: scale(.94); }
.login-wrap { width: 100%; display: flex; flex-direction: column; }

/* 品牌徽章：毛玻璃白圆 + 渐变爪印，斜一点更俏皮；落下弹一下，之后持续轻晃 */
.login-badge {
  position: relative;
  width: 92px; height: 92px; border-radius: 32px;
  margin: 0 auto 16px; display: grid; place-items: center;
  background: rgba(255, 255, 255, .82);
  border: 1.5px solid rgba(255, 255, 255, .95);
  box-shadow: 0 16px 34px rgba(226, 112, 106, .22);
  transform: rotate(-4deg);
  backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
  animation: badge-drop .6s cubic-bezier(.34, 1.56, .64, 1) both;
}
.login-badge svg { width: 56px; height: 56px; animation: paw-breathe 3.4s ease-in-out infinite; }
@keyframes badge-drop {
  from { transform: translateY(-20px) rotate(-14deg) scale(.6); opacity: 0; }
  to { transform: translateY(0) rotate(-4deg) scale(1); opacity: 1; }
}
@keyframes paw-breathe {
  0%, 100% { transform: scale(1) rotate(0deg); }
  50% { transform: scale(1.06) rotate(-2.5deg); }
}
.sticker { position: absolute; pointer-events: none; font-size: 19px;
  filter: drop-shadow(0 2px 4px rgba(0, 0, 0, .1)); animation: st-float 2.8s ease-in-out infinite alternate; }
.st1 { top: -12px; right: -16px; animation-delay: .4s; }
.st2 { bottom: -10px; left: -18px; font-size: 16px; animation-delay: 1.2s; }
@keyframes st-float {
  from { transform: translateY(-4px) rotate(-8deg); }
  to { transform: translateY(4px) rotate(8deg); }
}

/* 标题：渐变字，醒目不老气 */
.login-title {
  font-size: 25px; font-weight: 800; letter-spacing: .01em;
  text-align: center; margin: 0 0 8px;
  background: linear-gradient(120deg, #ff8a4c 10%, #e76a9a 78%);
  -webkit-background-clip: text; background-clip: text; color: transparent;
}
.login-sub {
  margin: 0 18px 20px; text-align: center;
  color: #8a7a70; font-size: 13.5px; line-height: 1.65; font-weight: 500;
}
html[data-theme="night"] .login-sub { color: var(--ink-soft); }

/* 表单卡：毛玻璃浮在渐变上 */
.login-card {
  background: rgba(255, 255, 255, .74);
  border: 1.5px solid rgba(255, 255, 255, .85);
  border-radius: 28px;
  box-shadow: 0 18px 44px rgba(226, 112, 106, .18);
  backdrop-filter: blur(22px) saturate(1.35);
  -webkit-backdrop-filter: blur(22px) saturate(1.35);
  padding: 18px 16px 14px;
  display: flex; flex-direction: column; gap: 10px;
}
html[data-theme="night"] .login-card { background: rgba(38, 44, 78, .72); border-color: rgba(139, 156, 232, .3); }
.login-card-title { font-size: 16px; font-weight: 600; color: var(--ink); margin: 0 0 2px; }

/* 分段：登录 | 注册（渐变滑块） */
.auth-tabs {
  position: relative; display: grid; grid-template-columns: 1fr 1fr;
  background: rgba(255, 255, 255, .65); border-radius: 999px; padding: 4px; margin-bottom: 2px;
}
html[data-theme="night"] .auth-tabs { background: rgba(139, 156, 232, .16); }
.auth-tab-pill {
  position: absolute; top: 4px; left: 4px;
  width: calc(50% - 4px); height: calc(100% - 8px);
  background: linear-gradient(135deg, #ff9f5a, #e76a9a);
  border-radius: 999px;
  box-shadow: 0 4px 12px rgba(231, 106, 154, .35);
  transition: transform .26s cubic-bezier(.22, .61, .36, 1);
}
.auth-tab-pill.right { transform: translateX(100%); }
.auth-tabs button {
  appearance: none; font: inherit; cursor: pointer; border: none; background: none;
  min-height: 38px; border-radius: 999px; font-size: 14px; font-weight: 700;
  color: var(--ink-soft); position: relative; z-index: 1; transition: color .2s ease;
}
.auth-tabs button.on { color: #fff; }

/* 主按钮：渐变 + 彩色投影（naive 的实底色被渐变图盖住） */
.login-card .auth-cta, .login-card .n-button--primary-type {
  background-image: linear-gradient(135deg, #ff9f5a, #e76a9a);
  border: none;
  box-shadow: 0 8px 20px rgba(231, 106, 154, .32);
}
.login-card .auth-cta:hover { box-shadow: 0 10px 24px rgba(231, 106, 154, .4); }

.auth-links { display: flex; justify-content: center; }
.auth-link {
  appearance: none; border: none; background: none; font: inherit; cursor: pointer;
  color: #8a7a70; font-size: 13px; font-weight: 600; padding: 2px 8px; border-radius: 8px;
  transition: color .15s ease;
}
.auth-link:hover { color: #e76a9a; }
html[data-theme="night"] .auth-link { color: var(--ink-soft); }
.hint-min { margin: -2px 2px 0; font-size: 11.5px; color: var(--ink-faint); text-align: center; }
.login-foot { margin: 16px 10px 0; text-align: center; font-size: 12px; color: #9a8a80; line-height: 1.6; }
html[data-theme="night"] .login-foot { color: var(--ink-faint); }
.login-card .oauth-google { width: 100%; background: rgba(255, 255, 255, .8); }

/* 入场动画：徽章落下 → 标题/说明/卡片/页脚 逐层浮入 */
.anim { animation: login-in .5s cubic-bezier(.22, .61, .36, 1) both; }
.d1 { animation-delay: .1s; }
.d2 { animation-delay: .16s; }
.d3 { animation-delay: .22s; }
.d4 { animation-delay: .32s; }
@keyframes login-in {
  from { opacity: 0; transform: translateY(14px); }
  to { opacity: 1; transform: translateY(0); }
}
@media (prefers-reduced-motion: reduce) {
  .login-page .anim, .login-page .login-badge svg, .login-page .sticker { animation: none !important; }
}
</style>
'''
io.open(LV, "w", encoding="utf-8", newline="\n").write(s)
print("LoginView v3 done")
