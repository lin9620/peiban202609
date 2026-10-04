# 轮 162b：刷新提示升级为暖心系可爱版——爱心弹出扑通跳（ok）/ 星花闪（batch）/ 摇摆！（fail）
import io

def edit(p, pairs):
    s = io.open(p, encoding="utf-8").read()
    for old, new in pairs:
        assert s.count(old) == 1, f"{p}: anchor x{s.count(old)}: {old[:70]!r}"
        s = s.replace(old, new)
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)
    print("ok", p)

MV = "src/views/CommunityView.vue"

# ═══ ① 模板：心形/星花 SVG 替换圆环打勾和 ⇄ 字符 ═══
edit(MV, [
("""        <span v-if="refreshNote === 'ok'" class="rn-ic" aria-hidden="true">
          <svg viewBox="0 0 36 36">
            <circle class="rn-c" cx="18" cy="18" r="14" />
            <path class="rn-t" d="M11.5 18.6l4.6 4.6 8.6-9.8" />
          </svg>
        </span>
        <span v-else-if="refreshNote === 'batch'" class="rn-ic rn-swapic" aria-hidden="true">⇄</span>""",
 """        <span v-if="refreshNote === 'ok'" class="rn-ic" aria-hidden="true">
          <svg class="rn-heart" viewBox="0 0 24 24">
            <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
          </svg>
        </span>
        <span v-else-if="refreshNote === 'batch'" class="rn-ic" aria-hidden="true">
          <svg class="rn-spark" viewBox="0 0 24 24">
            <path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z" />
          </svg>
        </span>"""),
])

# ═══ ② CSS：软药丸底 + 爱心 pop+扑通 + 星花闪 + 失败摇摆 ═══
edit("src/style.css", [
("""/* 轮 162：刷新结果胶囊——圆环打勾（stroke 逐帧描出 + 弹一下）、换一批 ⇄、失败 ！、刷新中转圈 */
.refresh-note {
  display: flex; align-items: center; justify-content: center; gap: 8px;
  margin: 2px 0 8px; font-size: 13px; font-weight: 700; color: var(--ink-soft);
}
.refresh-note.rn-ok { color: var(--good); }
.refresh-note.rn-batch { color: var(--accent-deep); }
.refresh-note.rn-fail { color: var(--low); }
.rn-ic { display: inline-flex; width: 22px; height: 22px; align-items: center; justify-content: center; font-size: 15px; }
.rn-ic svg { width: 22px; height: 22px; animation: rn-pop .38s cubic-bezier(.34, 1.56, .64, 1); }
.rn-c { fill: none; stroke: var(--good); stroke-width: 2.4; stroke-linecap: round;
  stroke-dasharray: 88; stroke-dashoffset: 88; animation: rn-draw .4s ease-out forwards; }
.rn-t { fill: none; stroke: var(--good); stroke-width: 3; stroke-linecap: round; stroke-linejoin: round;
  stroke-dasharray: 22; stroke-dashoffset: 22; animation: rn-draw .28s ease-out .26s forwards; }
@keyframes rn-draw { to { stroke-dashoffset: 0; } }
@keyframes rn-pop { 0% { transform: scale(.4); opacity: 0; } 100% { transform: scale(1); opacity: 1; } }
.rn-swapic { color: var(--accent-deep); animation: rn-pop .3s ease-out, rn-tilt .55s ease .05s; }
@keyframes rn-tilt { 40% { transform: rotate(-14deg) scale(1.15); } }
.rn-warnic { color: var(--low); font-weight: 800; animation: rn-pop .3s ease-out; }
.rn-busyic { width: 15px; height: 15px; border-radius: 50%; border: 2.5px solid var(--hairline); border-top-color: var(--accent); animation: rn-spin .8s linear infinite; }
@keyframes rn-spin { to { transform: rotate(360deg); } }""",
 """/* 轮 162b：刷新结果小药丸（暖爪可爱版）——爱心弹出扑通一跳 / 星花旋闪 / 摇摆！/ 转圈 */
.refresh-note {
  display: flex; align-items: center; justify-content: center; gap: 7px;
  width: fit-content; margin: 4px auto 10px; padding: 6px 14px;
  font-size: 13px; font-weight: 700; color: var(--ink-soft);
  background: var(--wash); border: 1px solid var(--hairline); border-radius: 999px;
  animation: rn-rise .3s ease-out;
}
.refresh-note.rn-ok { color: var(--accent-deep); }
.refresh-note.rn-batch { color: var(--accent-deep); }
.refresh-note.rn-fail { color: var(--low); }
@keyframes rn-rise { 0% { transform: translateY(6px); opacity: 0; } 100% { transform: translateY(0); opacity: 1; } }
.rn-ic { display: inline-flex; width: 20px; height: 20px; align-items: center; justify-content: center; font-size: 15px; }
.rn-heart { width: 20px; height: 20px; fill: var(--accent-deep);
  animation: rn-heart .62s cubic-bezier(.34, 1.56, .64, 1); transform-origin: 50% 60%; }
@keyframes rn-heart {
  0% { transform: scale(0) rotate(-18deg); opacity: 0; }
  55% { transform: scale(1.25) rotate(4deg); opacity: 1; }
  72% { transform: scale(.94) rotate(0deg); }
  100% { transform: scale(1.06) scale(1); }
}
.rn-spark { width: 18px; height: 18px; fill: var(--accent-deep);
  animation: rn-pop .34s cubic-bezier(.34, 1.56, .64, 1), rn-twinkle .9s ease-in-out .34s 2; transform-origin: 50% 50%; }
@keyframes rn-pop { 0% { transform: scale(.3) rotate(-90deg); opacity: 0; } 100% { transform: scale(1) rotate(0deg); opacity: 1; } }
@keyframes rn-twinkle { 50% { transform: scale(.68) rotate(22deg); opacity: .55; } }
.rn-warnic { color: var(--low); font-weight: 800; animation: rn-pop .3s ease-out, rn-wobble .5s ease .1s; }
@keyframes rn-wobble { 25% { transform: rotate(-12deg); } 60% { transform: rotate(9deg); } }
.rn-busyic { width: 15px; height: 15px; border-radius: 50%; border: 2.5px solid var(--hairline); border-top-color: var(--accent); animation: rn-spin .8s linear infinite; }
@keyframes rn-spin { to { transform: rotate(360deg); } }"""),
])
print("PART C DONE")
