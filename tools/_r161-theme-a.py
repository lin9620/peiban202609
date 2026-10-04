# 轮 161：主题套件补全新变量组（--card/--hairline/--page-bg/--wash*）+ 白色水洗改主题感知
import io, re

def edit(p, pairs):
    s = io.open(p, encoding="utf-8").read()
    for old, new in pairs:
        assert s.count(old) == 1, f"{p}: anchor x{s.count(old)}: {old[:70]!r}"
        s = s.replace(old, new)
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)
    print("ok", p)

CSS = "src/style.css"

# ═══ ① :root：新增主题感知变量（轮 120 设计体系的新组 + 水洗三档） ═══
edit(CSS, [
("""  --glass: #faf9f5;
  --glass-strong: #faf9f5;""",
 """  --glass: #faf9f5;
  --glass-strong: #faf9f5;
  /* 轮 161：主题感知的新组——此前五个 data-theme 块只覆盖旧变量组，这四样永远停在
     奶油体系（用户实测「换了主题配色不变」）。--page-bg 兜底底色、--wash* 白色水洗
     三档（夜间主题下换成暗蓝水洗，白水洗在夜色里会刺眼）。 */
  --page-bg: #faf9f5;
  --wash: rgba(255, 255, 255, .5);
  --wash-mid: rgba(255, 255, 255, .72);
  --wash-strong: rgba(255, 255, 255, .9);"""),
("""html { scroll-behavior: smooth; background: #faf9f5; }""",
 """html { scroll-behavior: smooth; background: var(--page-bg); }"""),
("""  color: var(--ink);
  background: #faf9f5;""",
 """  color: var(--ink);
  background: var(--page-bg);"""),
])

# ═══ ② 四个主题块补全新变量组 ═══
edit(CSS, [
("""html[data-theme="sakura"] {
  --ink: #5a3a46; --ink-soft: #a3798c; --ink-faint: #d3b3c0;
  --accent: #f78fb3; --accent-deep: #e76a9a; --accent-soft: #ffe1ec;""",
 """html[data-theme="sakura"] {
  --ink: #5a3a46; --ink-soft: #a3798c; --ink-faint: #d3b3c0;
  --accent: #f78fb3; --accent-deep: #e76a9a; --accent-soft: #ffe1ec;
  --card: #fdeef4; --hairline: #f0d9e3; --page-bg: #fdf1f6;"""),
("""html[data-theme="mint"] {
  --ink: #2f4a42; --ink-soft: #6f9188; --ink-faint: #b0c9c2;
  --accent: #5fbfa5; --accent-deep: #46a78e; --accent-soft: #dcf2ea;""",
 """html[data-theme="mint"] {
  --ink: #2f4a42; --ink-soft: #6f9188; --ink-faint: #b0c9c2;
  --accent: #5fbfa5; --accent-deep: #46a78e; --accent-soft: #dcf2ea;
  --card: #ebf6ef; --hairline: #d4e7da; --page-bg: #eefaf4;"""),
])
# lavender / night 块用各自的锚点
s = io.open(CSS, encoding="utf-8").read()
lav = re.search(r'html\[data-theme="lavender"\] \{[^}]*\}', s)
assert lav, "lavender block"
print("lavender block:\n" + lav.group(0))
night = re.search(r'html\[data-theme="night"\] \{[^}]*\}', s)
print("night block:\n" + night.group(0))
