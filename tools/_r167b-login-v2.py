# 轮 167b：登录页二稿——SVG 爪印徽章 + 柔光斑背景 + 白卡投影 + 居中构图（用户：丑啊）
import io

def edit(p, pairs):
    s = io.open(p, encoding="utf-8").read()
    for old, new in pairs:
        assert s.count(old) == 1, f"{p}: anchor x{s.count(old)}: {old[:70]!r}"
        s = s.replace(old, new)
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)
    print("ok", p)

LV = "src/views/LoginView.vue"

# ═══ ① 模板：品牌块简化（徽章+标题+副标题，去重复品牌字），加柔光斑 ═══
edit(LV, [
("""  <div class="login-page">
    <button class="login-back" aria-label="back" @click="goBack">&#8592;</button>

    <!-- 品牌头：爪印 + 名字 + 一句话 -->
    <div class="login-hero anim d0">
      <div class="login-paw" aria-hidden="true">🐾</div>
      <div class="login-brand">{{ t("brand") }}</div>
      <div class="login-tag">{{ t("tagline") }}</div>
    </div>
    <h1 class="login-title anim d1">{{ t("login.title") }}</h1>
    <p class="login-sub anim d2">{{ t("login.sub") }}</p>""",
 """  <div class="login-page">
    <div class="login-blob b1" aria-hidden="true"></div>
    <div class="login-blob b2" aria-hidden="true"></div>
    <button class="login-back" aria-label="back" @click="goBack">&#8592;</button>

    <div class="login-wrap">
    <!-- 品牌徽章：干净的单色 SVG 爪印（emoji 各端渲染不一，弃用） -->
    <div class="login-badge anim d0" aria-hidden="true">
      <svg viewBox="0 0 64 64">
        <ellipse cx="23" cy="19" rx="6.2" ry="8.2" transform="rotate(-16 23 19)" />
        <ellipse cx="41" cy="19" rx="6.2" ry="8.2" transform="rotate(16 41 19)" />
        <ellipse cx="10.5" cy="30" rx="5.4" ry="7" transform="rotate(-38 10.5 30)" />
        <ellipse cx="53.5" cy="30" rx="5.4" ry="7" transform="rotate(38 53.5 30)" />
        <path d="M32 29.5c8.6 0 15.6 5.8 15.6 13 0 6.8-5.9 11.9-15.6 11.9S16.4 49.3 16.4 42.5c0-7.2 7-13 15.6-13z" />
      </svg>
    </div>
    <h1 class="login-title anim d1">{{ t("login.title") }}</h1>
    <p class="login-sub anim d2">{{ t("login.sub") }}</p>"""),
("""    <p class="login-foot anim d4">{{ t("common.localMode") }}</p>
  </div>
</template>""",
 """    <p class="login-foot anim d4">{{ t("common.localMode") }}</p>
    </div>
  </div>
</template>"""),
])

# ═══ ② 样式整体替换 ═══
s = io.open(LV, encoding="utf-8").read()
i = s.index("<style scoped>")
s = s[:i] + '''<style scoped>
/* 轮 167b：登录页二稿——居中构图 + 柔光斑 + 白卡投影 + SVG 爪印徽章。
 * 一稿被用户打回（emoji 爪印廉价、米卡米底没对比、构图平）。 */
.login-page {
  max-width: 420px; margin: 0 auto; position: relative;
  min-height: calc(100dvh - 120px);
  display: flex; align-items: center; justify-content: center;
  padding: 56px 6px 20px; overflow: hidden;
}
.login-blob { position: absolute; border-radius: 50%; pointer-events: none; }
.login-blob.b1 {
  width: 300px; height: 300px; top: -90px; left: -110px;
  background: var(--accent); opacity: .13; filter: blur(44px);
}
.login-blob.b2 {
  width: 330px; height: 330px; bottom: -120px; right: -120px;
  background: var(--lilac, #b7a6e8); opacity: .2; filter: blur(52px);
}
.login-back {
  position: absolute; top: 12px; left: 8px; z-index: 2;
  appearance: none; font: inherit; cursor: pointer;
  min-width: 40px; min-height: 40px; border-radius: 999px;
  border: 1px solid var(--hairline); background: rgba(255, 255, 255, .8);
  font-weight: 500; font-size: 16px; color: var(--ink);
  transition: background-color .15s ease, transform .15s ease;
}
.login-back:hover { background: #fff; }
.login-back:active { transform: scale(.94); }
.login-wrap { width: 100%; display: flex; flex-direction: column; }

/* 品牌徽章：白圆 + 单色爪印，落下来轻轻一弹，之后缓慢呼吸 */
.login-badge {
  width: 88px; height: 88px; border-radius: 30px;
  margin: 0 auto 16px; display: grid; place-items: center;
  background: #fff; border: 1px solid var(--hairline);
  box-shadow: 0 12px 30px rgba(20, 20, 19, .10);
  animation: badge-drop .6s cubic-bezier(.34, 1.56, .64, 1) both;
}
.login-badge svg { width: 54px; height: 54px; fill: var(--accent); animation: paw-breathe 3.6s ease-in-out infinite; }
@keyframes badge-drop {
  from { transform: translateY(-18px) scale(.7); opacity: 0; }
  to { transform: translateY(0) scale(1); opacity: 1; }
}
@keyframes paw-breathe {
  0%, 100% { transform: scale(1) rotate(0deg); }
  50% { transform: scale(1.05) rotate(-2.5deg); }
}
.login-title {
  font-family: var(--font-display); font-size: 24px; font-weight: 600;
  color: var(--ink); text-align: center; margin: 0 0 8px; letter-spacing: .01em;
}
.login-sub {
  margin: 0 18px 20px; text-align: center;
  color: var(--ink-soft); font-size: 13.5px; line-height: 1.65;
}

/* 表单卡：白底 + 发丝线 + 柔投影，浮在光斑上 */
.login-card {
  background: #fff; border: 1px solid var(--hairline); border-radius: 22px;
  box-shadow: 0 14px 38px rgba(20, 20, 19, .09);
  padding: 18px 16px 14px;
  display: flex; flex-direction: column; gap: 10px;
}
.login-card-title { font-size: 16px; font-weight: 600; color: var(--ink); margin: 0 0 2px; }
html[data-theme="night"] .login-card { background: var(--card); }

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
.login-foot { margin: 16px 10px 0; text-align: center; font-size: 12px; color: var(--ink-faint); line-height: 1.6; }
.login-card .oauth-google { width: 100%; }

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
  .login-page .anim, .login-page .login-badge svg { animation: none !important; }
}
</style>
'''
io.open(LV, "w", encoding="utf-8", newline="\n").write(s)
print("LoginView v2 done")
