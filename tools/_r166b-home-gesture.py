# 轮 166b：撤掉联盒拉伸（去打卡后今日联出现长空白）——手势面上移 home3 + home3 拉满屏
import io

def edit(p, pairs):
    s = io.open(p, encoding="utf-8").read()
    for old, new in pairs:
        assert s.count(old) == 1, f"{p}: anchor x{s.count(old)}: {old[:70]!r}"
        s = s.replace(old, new)
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)
    print("ok", p)

# ═══ ① style.css：联恢复内容高；home3 拉满一屏（透明底，手势面） ═══
edit("src/style.css", [
(""".home-track {
  display: flex; align-items: stretch;   /* 轮 166：flex-start→stretch——联盒跟随 track 高度拉伸，
    内容短联（故事）的下方空白也在联盒内，横滑手势面覆盖到屏底（用户实测空白滑不动；
    flex-start 时联盒只有内容高，空白命中落到 home3，track 手势收不到） */""",
 """.home-track {
  display: flex; align-items: flex-start;   /* 轮 166b：回到内容高——stretch 会把联内的卡片区
    拉出一长条空白（用户实测「去打卡后今日页下面那么长的空白」）。手势面已上移 home3，
    联盒不再承担手势职责 */"""),
(""".home3 { overflow: hidden; overflow: clip; }""",
 """.home3 {
  overflow: hidden; overflow: clip;
  /* 轮 166b：home3 拉满一屏（减页顶 14 + 底部导航 78 + safe-area）——它背景透明，
     视觉与原来完全一致，但内容以下的空白都在 home3 手势面里，横滑不再有死区 */
  min-height: calc(100dvh - 96px - env(safe-area-inset-bottom, 0px));
}"""),
])

# ═══ ② HomeView：手势挂 home3；track 恢复内容高 ═══
edit("src/views/HomeView.vue", [
("""    <div
      class="home-track"
      :style="{ transform: 'translateX(' + idx * -100 + '%)', height: trackH }"
      @touchstart.passive="onTouchStart"
      @touchmove.passive="onTouchMove"
      @touchend.passive="onTouchEnd">""",
 """    <div
      class="home-track"
      :style="{ transform: 'translateX(' + idx * -100 + '%)', height: trackH }">"""),
("""  <div v-else class="home3">
    <div class="home-chips" role="tablist">""",
 """  <div v-else class="home3"
    @touchstart.passive="onTouchStart"
    @touchmove.passive="onTouchMove"
    @touchend.passive="onTouchEnd">
    <div class="home-chips" role="tablist">"""),
("""function measure() {
  const el = paneEls.value[idx.value];
  if (!el) return;
  let avail = 0;
  try {
    const host = el.parentElement;
    const top = host ? host.getBoundingClientRect().top : 0;
    avail = window.innerHeight - top - 96;
  } catch (e) { /* 拿不到几何就维持内容高 */ }
  /* 轮 166：align-items:stretch 后 pane.offsetHeight = 拉伸高（自锁），改量其内容子元素 */
  const inner = el.firstElementChild;
  const contentH = inner ? inner.offsetHeight : el.offsetHeight;
  trackH.value = Math.max(120, Math.round(Math.max(contentH, avail))) + "px";
}""",
 """function measure() {
  /* 轮 166b：track 恢复内容高（stretch 方案撤了——长空白难看）。手势面在 home3，
     内容以下的空白照样能滑，track 高度不再需要撑屏 */
  const el = paneEls.value[idx.value];
  if (el) trackH.value = Math.max(120, Math.round(el.offsetHeight)) + "px";
}"""),
("""  if (typeof window !== "undefined") window.addEventListener("resize", measure);
});""",
 """});"""),
("""onBeforeUnmount(() => {
  if (ro) ro.disconnect();
  if (typeof window !== "undefined") window.removeEventListener("resize", measure);
});""",
 """onBeforeUnmount(() => {
  if (ro) ro.disconnect();
});"""),
])
print("ALL 166b EDITS DONE")
