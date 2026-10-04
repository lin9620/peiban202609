# 轮 162 part B：CommunityView 刷新批瘦身 + 刷新提示状态机/新胶囊 + i18n + CSS
import io

def edit(p, pairs):
    s = io.open(p, encoding="utf-8").read()
    for old, new in pairs:
        assert s.count(old) == 1, f"{p}: anchor x{s.count(old)}: {old[:70]!r}"
        s = s.replace(old, new)
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)
    print("ok", p)

MV = "src/views/CommunityView.vue"

# ═══ ① 批瘦身：刷新/首屏 20 条（视口只露 16 张），触底续载保持 50 ═══
edit(MV, [
("""const FEED_PAGE = 50;""",
 """const FEED_PAGE = 50;
const REFRESH_PAGE = 20;   /* 轮 162：刷新/首屏批瘦身——视口只露 16 张，拉 50 条+两轮富化纯浪费；触底续载仍 50 */"""),
# 挂载取数器
("""    const rows = (await cloudFetchPostsSample(FEED_PAGE).catch(() => null))
      || (await cloudFetchPosts(FEED_PAGE, 0).catch(() => null));""",
 """    const rows = (await cloudFetchPostsSample(REFRESH_PAGE).catch(() => null))
      || (await cloudFetchPosts(REFRESH_PAGE, 0).catch(() => null));"""),
# 刷新分支：20 条 + 状态机
("""    refreshNote.value = t("community.refreshing");
    const prevNewest = newestSeenTs.value;
    const key = cacheKey("wall:posts", (cloud.user && cloud.user.id) || "");
    const pull = Promise.all([
      cloudFetchPosts(FEED_PAGE, 0).catch(() => null),
      cloudFetchPostsSample(FEED_PAGE).catch(() => null),
    ]).then(([posts, batch]) => ({""",
 """    refreshNote.value = "busy";
    let freshOk = true;
    const prevNewest = newestSeenTs.value;
    const key = cacheKey("wall:posts", (cloud.user && cloud.user.id) || "");
    const pull = Promise.all([
      cloudFetchPosts(REFRESH_PAGE, 0).catch(() => null),
      cloudFetchPostsSample(REFRESH_PAGE).catch(() => null),
    ]).then(([posts, batch]) => ({"""),
("""      refreshNote.value = t("community.refreshed");
    } else if (box && batchOk) {""",
 """      refreshNote.value = "ok";
    } else if (box && batchOk) {"""),
("""      cacheSet(key, { rows: box.batch, counts: {}, fromFetch: true });
      refreshNote.value = t("community.refreshBatch");
    } else {
      refreshNote.value = t("community.refreshFail");
    }""",
 """      cacheSet(key, { rows: box.batch, counts: {}, fromFetch: true });
      refreshNote.value = "batch";
    } else {
      refreshNote.value = "fail";
      freshOk = false;
    }"""),
# loadCloud 返回成败（下拉刷新要如实提示）
("""  } finally {
    loadingCloud.value = false;
  }
}

/* 触底续载""",
 """  } finally {
    loadingCloud.value = false;
  }
  return freshOk;
}

/* 触底续载"""),
# 状态机声明 + 文案
("""const refreshNote = ref(false);""",
 """const refreshNote = ref("");   /* 轮 162：刷新提示状态机 ""|busy|ok|batch|fail */
const refreshText = computed(() => ({
  busy: t("community.refreshing"), ok: t("community.refreshed"),
  batch: t("community.refreshBatch"), fail: t("community.refreshFail"),
}[refreshNote.value] || ""));"""),
# 手机下拉：结果如实进状态机（原来无条件显示「已刷新 ✓」）
("""  if (pullDist.value >= 62) {
    await loadCloud({ fresh: true });   /* 轮 56：下拉刷新 = 强制取新第 1 页（不再拿缓存装样子） */
    refreshNote.value = true;
    setTimeout(() => { refreshNote.value = false; }, 2500);
  }""",
 """  if (pullDist.value >= 62) {
    /* 轮 56：下拉刷新 = 强制取新第 1 页（不再拿缓存装样子）；轮 162：成败如实提示 */
    const okPull = await loadCloud({ fresh: true });
    refreshNote.value = okPull ? "ok" : "fail";
    setTimeout(() => { refreshNote.value = ""; }, 2500);
  }"""),
# 模板：提示胶囊重做（SVG 圆环打勾逐帧描出 + 弹跳；换一批/失败/刷新中各有形态）
("""    <transition name="t-swap" mode="out-in">
      <p v-if="refreshNote" :key="String(refreshNote)" class="notice" style="text-align: center; color: var(--good); font-weight: 700">
        {{ t("community.refreshed") }}
      </p>
    </transition>""",
 """    <transition name="t-swap" mode="out-in">
      <div v-if="refreshNote" :key="refreshNote" class="refresh-note" :class="'rn-' + refreshNote">
        <span v-if="refreshNote === 'ok'" class="rn-ic" aria-hidden="true">
          <svg viewBox="0 0 36 36">
            <circle class="rn-c" cx="18" cy="18" r="14" />
            <path class="rn-t" d="M11.5 18.6l4.6 4.6 8.6-9.8" />
          </svg>
        </span>
        <span v-else-if="refreshNote === 'batch'" class="rn-ic rn-swapic" aria-hidden="true">⇄</span>
        <span v-else-if="refreshNote === 'fail'" class="rn-ic rn-warnic" aria-hidden="true">!</span>
        <span v-else class="rn-ic rn-busyic" aria-hidden="true"></span>
        <span>{{ refreshText }}</span>
      </div>
    </transition>"""),
])

# ═══ ② i18n：✓ 移出文案（图标接手） ═══
edit("src/i18n.js", [
('      refreshed: "Refreshed ✓",', '      refreshed: "Refreshed",'),
('      refreshBatch: "Refreshed ✓ · a new batch for you",', '      refreshBatch: "A new batch for you",'),
('      refreshed: "已刷新 ✓",', '      refreshed: "已刷新",'),
('      refreshBatch: "已刷新 ✓ 换了一批内容",', '      refreshBatch: "换了一批内容",'),
])

# ═══ ③ style.css：胶囊与图标动画 ═══
edit("src/style.css", [
("""html[data-theme="night"] .st-skel-card {
  background: linear-gradient(100deg, rgba(139, 156, 232, .10) 40%, rgba(139, 156, 232, .20) 50%, rgba(139, 156, 232, .10) 60%);
  background-size: 200% 100%;
}""",
 """html[data-theme="night"] .st-skel-card {
  background: linear-gradient(100deg, rgba(139, 156, 232, .10) 40%, rgba(139, 156, 232, .20) 50%, rgba(139, 156, 232, .10) 60%);
  background-size: 200% 100%;
}
/* 轮 162：刷新结果胶囊——圆环打勾（stroke 逐帧描出 + 弹一下）、换一批 ⇄、失败 ！、刷新中转圈 */
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
@keyframes rn-spin { to { transform: rotate(360deg); } }"""),
])
print("PART B DONE")
