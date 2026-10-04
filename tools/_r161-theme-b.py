# 轮 161 part B：lavender/night 补变量 + 白色水洗按透明度三档换成主题感知变量
import io, re

CSS = "src/style.css"
s = io.open(CSS, encoding="utf-8").read()

# ═══ lavender / night 块补新变量 ═══
old = """html[data-theme="lavender"] {
  --ink: #443a5c; --ink-soft: #8379a3; --ink-faint: #bdb3d4;
  --accent: #a78bdb; --accent-deep: #8f6fc4; --accent-soft: #ece2fb;"""
new = """html[data-theme="lavender"] {
  --ink: #443a5c; --ink-soft: #8379a3; --ink-faint: #bdb3d4;
  --accent: #a78bdb; --accent-deep: #8f6fc4; --accent-soft: #ece2fb;
  --card: #f2eef9; --hairline: #e0d8ec; --page-bg: #f5f1fc;"""
assert s.count(old) == 1
s = s.replace(old, new)

old = """html[data-theme="night"] {
  --ink: #e8eaf6; --ink-soft: #a9b1d6; --ink-faint: #767ea8;
  --accent: #8b9ce8; --accent-deep: #a3b2f0; --accent-soft: rgba(139, 156, 232, .18);"""
new = """html[data-theme="night"] {
  --ink: #e8eaf6; --ink-soft: #a9b1d6; --ink-faint: #767ea8;
  --accent: #8b9ce8; --accent-deep: #a3b2f0; --accent-soft: rgba(139, 156, 232, .18);
  --card: #262c52; --hairline: rgba(139, 156, 232, .25); --page-bg: #171a33;
  --wash: rgba(139, 156, 232, .12); --wash-mid: rgba(139, 156, 232, .17); --wash-strong: rgba(139, 156, 232, .24);"""
assert s.count(old) == 1
s = s.replace(old, new)

# ═══ 白色水洗大扫除：background: rgba(255,255,255,.X) 按透明度换 var(--wash*) ═══
# 排除：主题块定义（--glass/--wash 定义行）、夜间专属旧覆盖（data-theme 行）、渐变（单独处理）
def bucket(alpha):
    a = float("0." + alpha)   # 正则捕获的是小数部分（".45"→"45"），必须拼回小数
    if a <= 0.55: return "var(--wash)"
    if a <= 0.78: return "var(--wash-mid)"
    return "var(--wash-strong)"

lines = s.split("\n")
changed = 0
for i, ln in enumerate(lines):
    if "data-theme" in ln or "--glass" in ln or "--wash" in ln:
        continue
    if "background" not in ln or "rgba(255, 255, 255" not in ln:
        continue
    newln = re.sub(r"background: rgba\(255, 255, 255, \.(0?\d+)\)( \!important)?;",
                   lambda m: "background: " + bucket(m.group(1)) + (" !important;" if m.group(2) else ";"), ln)
    if newln != ln:
        lines[i] = newln
        changed += 1
s = "\n".join(lines)
print("washes replaced:", changed)

# ═══ 两条白色渐变单独换（583 卡片光泽 / 665 暖白渐变） ═══
old = "background: linear-gradient(135deg, rgba(255, 255, 255, .8), rgba(255, 255, 255, .5));"
assert s.count(old) == 1
s = s.replace(old, "background: linear-gradient(135deg, var(--wash-strong), var(--wash));")
old = "background: linear-gradient(150deg, rgba(255, 238, 221, .92), rgba(255, 255, 255, .66));"
assert s.count(old) == 1
s = s.replace(old, "background: linear-gradient(150deg, var(--wash-strong), var(--wash-mid));")

# ═══ 夜色下故事流骨架屏换暗蓝水洗（原暖灰在夜里几乎不可见） ═══
anchor = "@keyframes st-skel-shine { to { background-position: -200% 0; } }"
assert s.count(anchor) == 1
s = s.replace(anchor, anchor + """
html[data-theme="night"] .st-skel-card {
  background: linear-gradient(100deg, rgba(139, 156, 232, .10) 40%, rgba(139, 156, 232, .20) 50%, rgba(139, 156, 232, .10) 60%);
  background-size: 200% 100%;
}""")

io.open(CSS, "w", encoding="utf-8", newline="\n").write(s)

# ═══ BottleRecords：橙色水洗标签改主题感知（accent 系） ═══
BR = "src/components/BottleRecords.vue"
b = io.open(BR, encoding="utf-8").read()
old = "border: 1px solid rgba(245, 140, 80, .28); background: rgba(245, 140, 80, .08);"
assert b.count(old) == 1
b = b.replace(old, "border: 1px solid var(--hairline); background: var(--wash);")
old = "color: #7c4a24;"
assert b.count(old) == 1
b = b.replace(old, "color: var(--ink-soft);")
io.open(BR, "w", encoding="utf-8", newline="\n").write(b)
print("ok", BR)
