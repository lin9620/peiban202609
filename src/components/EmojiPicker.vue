<!-- 轮 164：表情按钮 + 弹出面板（微信常用集，Unicode 免资产）——评论框/私信框共用。
 * 用法：<EmojiPicker :text="draft" @update:text="v => draft = v" />——
 * 按钮放发送键左侧；面板 position:fixed 按按钮实时 rect 定位（teleport 到 body），
 * 不受祖先 overflow 裁剪 / transform 包含块影响（home-track 陷阱同源）。
 * 插入在 textarea/input 光标处（picker 自己在同行内找输入元素），插入后焦点+光标归位。
 * 点选不收面板（可连选），点面板外/再点按钮收起。 -->
<script setup>
import { ref, onMounted, onBeforeUnmount } from "vue";
import { t } from "../i18n.js";
import { isApp } from "../stores/uiStore.js";
import { Capacitor } from "@capacitor/core";
import { emojiSheetMode, sheetLayout, keyboardHeight, isEmojiHit } from "../utils/emojiSheetRules.js";
import "emoji-picker-element";   /* 轮 188：成熟开源组件（MIT）——搜索/分类/皮肤色阶全套，替换自研格子 */

/* 轮 199 · 抄原生 App 的键盘协作：原生应用收/起键盘而输入框不失焦（B站/知乎/小红书皆此法）。
 * Capacitor Keyboard 插件只在 App 内有（网页走 blur 回退），hide/show 即原生 IME 窗口控制。 */
const kb = () => (isApp && Capacitor.Plugins.Keyboard) || null;

const props = defineProps({ text: { type: String, default: "" } });
const emit = defineEmits(["update:text"]);

const open = ref(false);
const root = ref(null);
const sheetOn = ref(false);   /* 当前是「贴屏底 sheet」形态（决定 CSS 圆角/内边距） */
const pos = ref({ left: "8px", bottom: "200px" });

/* ── 手机/App sheet：几何全在 utils/emojiSheetRules（纯函数、有单测）里算，这里只贴样式 ──
 * rowEl：本次被「顶到面板上面」的输入行；appliedShift 记住已顶开的量 —— 重排时要用它把
 * 行还原成「未被顶开」的坐标再算（否则每重排一次都按已顶开的位置算，越算越挤）。 */
let rowEl = null;
let anchoredRow = false;
let appliedShift = 0;
let baseMargin = 0;
let rafId = 0;
let settleTimers = [];
/* 轮 182：键盘收起时的视口高（历史最大值）与本次面板的目标高度（锁定一次不再变）。
 * restH 用来给面板定位（面板必须钉在收起态的屏底，不能钉在键盘弹起时的矮视口）；
 * sheetH 在打开那一刻实测键盘高 —— 面板与键盘**同高**，切换时输入框一像素不动。 */
let restH = 0;
let sheetH = 0;

function rememberRest() {
  const h = typeof window === "undefined" ? 0 : window.innerHeight || 0;
  if (h > restH) restH = h;   /* 只增不减：视口被键盘压矮时不能把基准降下来 */
}

function sheetMode() {
  return emojiSheetMode({ isApp, innerWidth: typeof window === "undefined" ? 0 : window.innerWidth });
}

function layoutSheet() {
  if (!rowEl) return;
  const natural = rowEl.getBoundingClientRect().bottom + appliedShift;   /* 未被顶开时的行底 */
  const L = sheetLayout({
    viewportH: window.innerHeight,
    rowBottomNatural: natural,
    anchored: anchoredRow,
    baseMargin,
    sheetH,
    restH,
  });
  appliedShift = L.shift;
  rowEl.style.marginBottom = L.margin ? Math.round(L.margin) + "px" : "";
  /* 高度写显式 px + 贴屏底（top 一起给）：**绝不写 bottom**。
   * 写 bottom 的话，键盘收起把布局视口拉高时面板会跟着长（用户实测 197→507 的那条 bug）。 */
  pos.value = {
    left: "0", right: "0", width: "auto",
    top: Math.round(L.top) + "px", height: Math.round(L.height) + "px", bottom: "auto",
  };
}

/* ═══ 轮 198 · 光标体系整体退役，换浏览器原生 API ═══
 * 旧体系（轮 183/185/187 的 trackCaret 持续跟踪 + caretMem 递推 + applyCaret 三重定时器）
 * 在真机上翻车的两个实锤：
 *   ① 插入位置读了**失焦元素**的实时选区——手机上失焦输入框的选区是脏的（输入法选词/旧值
 *      残留），拿比文本长度还大的脏位置切片 = 「前面输入全删了只剩一个表情」；
 *   ② 失焦期间 selectionchange 还在喂 caretMem——v-model 改写会把选区清零，被记成当前位置
 *      = 「表情跳到第一个前面」。
 * 新做法（全原生，无监听器、无定时器）：
 *   - 唯一一次读光标：openSheet 里**输入框还焦点时**（桌面 ☺ 按钮有 mousedown.prevent 不抢
 *     焦点；手机点按钮不转移焦点）记下位置，存 caretAt；
 *   - 插入用 el.setRangeText(uni, lo, hi, "end")：范围两端夹紧到当前长度（脏位置删不掉内容），
 *     浏览器自己把光标落在插入之后，并触发原生 input 事件 → v-model 自动同步（无二次写值，
 *     不再存在「v-model 回写把 selection 复位」的整类问题）；
 *   - 失焦插入一律用 caretAt（夹紧），只在元素真的焦点内才信实时选区。 */
let caretAt = null;   /* 打开面板那一刻（输入框尚在焦点）的真实光标位置 */

/** 本次输入行里的输入元素（插入表情、收起面板后把焦点还回去都用它） */
function inputEl() {
  return root.value ? root.value.parentElement.querySelector("textarea, input") : null;
}

/* 视口一变就重排：键盘弹起/收起、旋屏、原生键盘动画结束都会走这里 ——
 * 这正是「先点输入、再点表情」那条路径的正解（旧实现只在打开那一帧量一次坐标）。
 * 只订阅 resize：visualViewport 的 scroll 在正常滚动时也狂发，会把 marginBottom 每帧写一遍。 */
function onViewportChange() {
  if (!open.value || !rowEl || rafId) return;
  rafId = requestAnimationFrame(() => { rafId = 0; if (open.value && rowEl) { rememberRest(); layoutSheet(); } });
}
function listenViewport(on) {
  const fn = on ? "addEventListener" : "removeEventListener";
  window[fn]("resize", onViewportChange);
  if (window.visualViewport) window.visualViewport[fn]("resize", onViewportChange);
}
function clearSettle() {
  for (const id of settleTimers) clearTimeout(id);
  settleTimers = [];
}

function clearRowShift() {
  if (rowEl) rowEl.style.marginBottom = "";
  rowEl = null;
  anchoredRow = false;
  appliedShift = 0;
  baseMargin = 0;
  clearSettle();
  listenViewport(false);
}

function openSheet() {
  /* 兜底：万一将来把按钮放到没有输入行的位置，就把按钮自己当锚点（面板挂在它下面）。 */
  rowEl = root.value.closest(".dm-input-row, .cmt-input-row, .cmt-main-bar") || root.value;
  /* 贴屏底的行才需要被顶开（聊天 footer / 暖心墙底部输入条）；页内内联框不动 */
  anchoredRow = !!(rowEl && rowEl.closest && rowEl.closest(".dm-compose, .cmt-main-bar"));
  baseMargin = rowEl ? Math.max(0, parseFloat(rowEl.style.marginBottom) || 0) : 0;
  appliedShift = 0;
  /* 轮 182：在 blur 收键盘**之前**实测键盘高度，锁成本次面板高度。
   * 键盘占着的时候视口正是矮的，这一刻量到的差值就是键盘真高；锁死之后
   * 键盘收起导致视口变高也不会改面板高 —— 面板与键盘等高互换，输入框不位移。 */
  rememberRest();
  /* 轮 198：趁输入框还在焦点内（桌面 ☺ 有 mousedown.prevent 不抢焦点；手机点按钮不转移焦点）
   * 读一次真实光标位置——这是全程唯一一次读它，之后插入/恢复全用这个数（夹紧使用）。 */
  const ie = inputEl();
  if (ie && typeof ie.selectionStart === "number") caretAt = ie.selectionStart;
  sheetH = keyboardHeight({ innerH: window.innerHeight, restH }) || 0;
  layoutSheet();   /* 先算好再渲染：面板一出现就在正确位置，不会先闪一下默认坐标 */
  /* 轮 199 · 抄原生 App（B站/知乎/小红书）：收键盘**不 blur 输入框**——原生应用的输入框在
   * 表情面板弹出时从不失焦，光标原地钉住，插入永远落在真实位置。网页里对应的能力就是
   * Capacitor Keyboard.hide()：只收 IME 窗口，DOM 焦点不动。网页环境（无插件）才退回 blur。 */
  if (kb()) {
    kb().hide().catch(() => {});
  } else {
    const ae = document.activeElement;
    if (ae && ae !== document.body && ae.blur) ae.blur();   /* 收键盘：面板占键盘位，两者互斥 */
  }
  listenViewport(true);
  /* 安全网：个别内核收键盘只改 visualViewport 且不发 resize —— 补排两次（幂等，不闪） */
  clearSettle();
  settleTimers = [80, 260].map((ms) => setTimeout(() => { if (open.value && rowEl) { rememberRest(); layoutSheet(); } }, ms));
}

/**
 * 收起面板。轮 182 起 `restoreFocus` 为真时把焦点还给输入框、键盘随之回来 ——
 * 这是用户那句「点表情按钮再点回来就直接折叠了，这时候要输入文字又要点击一次输入框」的正解：
 * 表情按钮是**切换键**（键盘 ↔ 面板），不是单向开关。
 */
function closeSheet(restoreFocus) {
  if (typeof window !== "undefined") {
    window.__wpLog = window.__wpLog || [];
    window.__wpLog.push({ ev: "closeSheet", restoreFocus: restoreFocus === true });
  }
  open.value = false;
  const el = restoreFocus ? inputEl() : null;
  /* 轮 186（真机复验）：还焦点会被**按钮自己**覆盖 ——
   * 手指点按钮时浏览器在 click 之后才把焦点给BUTTON，
   * 我们在 click 里focus 输入框 → 随后又被按钮抢走 → activeElement=BUTTON.emo-btn，
   * 用户还得再点一次输入框。先同步把按钮 blur 掉，再还焦点。 */
  const ae = document.activeElement;
  if (ae && ae !== el && ae !== document.body && typeof ae.blur === "function") {
    try { ae.blur(); } catch (e) { /* 忽略 */ }
  }
  clearRowShift();
  if (el) {
    /* 轮 198：还焦点 + 把光标放回记住的位置（夹紧到当前长度）。原生路径下不存在
     * 「v-model 二次写值把 selection 复位」的问题（setRangeText 的 input 事件同步的
     * 就是 DOM 现值），一次落位即稳，不再需要三重定时器抢焦点。
     * 轮 199：App 内输入框全程没失焦（Keyboard.hide 不动 DOM 焦点），再把键盘叫回来即可。 */
    try {
      el.focus({ preventScroll: true });
      const at = caretAt != null ? Math.min(caretAt, el.value.length) : el.value.length;
      el.setSelectionRange(at, at);
    } catch (e) { /* 无光标环境忽略 */ }
    if (kb()) kb().show().catch(() => {});   /* 抄原生：面板收起 = 键盘回位（输入框还在焦点） */
  }
}

function toggle() {
  if (open.value) { closeSheet(true); return; }
  if (sheetMode()) {
    /* 手机/App：贴屏底 sheet，展开在输入框**下面**（几何见 emojiSheetRules） */
    sheetOn.value = true;
    openSheet();
  } else {
    /* 桌面：小弹层贴在按钮上方（原样）。这里必须现量按钮 rect ——
     * 旧实现复用了手机分支块内的 `const r`（块作用域），桌面一点表情就 ReferenceError、
     * 面板根本打不开；改回各分支各自量。 */
    sheetOn.value = false;
    const r = root.value.getBoundingClientRect();
    const bottom = Math.max(8, window.innerHeight - r.top + 8) + "px";
    const left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - 304));
    pos.value = { left: left + "px", bottom };
  }
  open.value = true;
}

/* 轮 198：插入全走原生 setRangeText——范围替换 + 浏览器落光标 + 原生 input 事件同步 v-model。
 * 选区只信「焦点内」的实时值；失焦（面板开着）一律用 caretAt 且两端夹紧到当前长度——
 * 手机上失焦输入框的选区是脏的，直接切片 = 用户实测「前面的输入全删了只剩一个表情」。 */
function onEmojiClick(ev) {
  const uni = ev && ev.detail && ev.detail.unicode;
  if (!uni) return;
  const el = inputEl();
  if (!el) return;
  const len = el.value.length;
  let lo, hi;
  if (document.activeElement === el && typeof el.selectionStart === "number") {
    lo = el.selectionStart;
    hi = el.selectionEnd == null ? lo : el.selectionEnd;
  } else {
    lo = hi = caretAt != null ? caretAt : len;
  }
  lo = Math.max(0, Math.min(lo, len));
  hi = Math.max(lo, Math.min(hi, len));
  try {
    el.setRangeText(uni, lo, hi, "end");
    caretAt = typeof el.selectionStart === "number" ? el.selectionStart : lo + uni.length;
  } catch (e) { /* 极老内核无 setRangeText：保底不炸 */ }
}

/* 轮 195：点表情不再抢输入框焦点——emoji-picker 的按钮是原生 button，mousedown 默认行为
 * 会把焦点从输入框挪进面板（桌面端=输入框失焦、光标丢；实测 Playwright fill 直接报
 * 「Active element is no longer the expected input target」）。只拦 emoji 格子/收藏按钮的
 * mousedown preventDefault——选中靠 click 照常触发；面板自己的搜索框(input.search)等
 * 仍保留原生聚焦。shadow 内元素的事件 target 在外层被重定向成宿主，必须走 composedPath。 */
function onPanelMouseDown(e) {
  const path = typeof e.composedPath === "function" ? e.composedPath() : [];
  for (const n of path) {
    if (n && n.tagName === "BUTTON" && n.classList && n.classList.contains("emoji")) {
      e.preventDefault();
      return;
    }
  }
}

/**
 * 面板开着时用户点回输入框要打字 —— 必须让位给键盘。
 * 轮 182：只收起面板、**不调focus**（系统是用户自己点的，键盘自然弹起；程序再focus 一次会闪）。
 * 用 focusin 兜住：点击不一定先落在输入框上（先落在它的包装层），focusin 更可靠。
 */
function onFocusIn(e) {
  if (!open.value) return;
  /* 轮 199 · 抄知乎桌面：**桌面弹层不因打字收起**——面板开着也能继续打字，来回切零步骤。
   * 只有手机 sheet（键盘要跟面板换位）才在焦点进输入框时收面板。 */
  if (!sheetMode()) return;
  const el = inputEl();
  if (el && (e.target === el || (el.contains && el.contains(e.target)))) closeSheet(false);
}

function onDoc(e) {
  /* 点面板/按钮以外的地方收起：**不还焦点** —— 用户是去点别处了，强行弹键盘会抢焦点。
   * 轮 185：输入条的「点外收起」也挂在 document 上，两边必须用**同一套命中判定**，
   * 否则会出现「面板点得好好的，评论条却被收起」。统一走 utils 的 isEmojiHit()，
   * 它认的是静态标记（.emo-btn/.emo-panel/.emo-root），不依赖面板此刻在不在 DOM 里。
   * 轮 199 · 抄知乎桌面：**输入行本身也算面板区**——打字/点发送不收面板，桌面才连贯；
   * 手机 sheet 交给 focusin 换位逻辑（点输入框 → 面板收、键盘起）。 */
  const zone = (root.value && root.value.closest(".dm-input-row, .cmt-input-row, .cmt-main-bar")) || root.value;
  if (open.value && zone && !zone.contains(e.target) && !isEmojiHit(e.target)) closeSheet(false);
}
/* 轮 199 · 抄原生 App 的互斥：App 内面板开着时输入框仍是焦点，用户再点它系统会把键盘
 * 弹回来（已焦点不再发 focusin）——监听原生 keyboardWillShow，键盘起 = 面板让位。 */
let kbShowHandle = null;
function onNativeKeyboardShow() {
  if (open.value) closeSheet(false);
}
onMounted(() => {
  rememberRest();
  document.addEventListener("pointerdown", onDoc);
  document.addEventListener("focusin", onFocusIn, true);
  if (kb() && kb().addListener) {
    /* 轮 199 修复：不同 Capacitor 版本 addListener 的返回不一（同步句柄 / Promise），两种都兜住 */
    try {
      const h = kb().addListener("keyboardWillShow", onNativeKeyboardShow);
      if (h && typeof h.then === "function") h.then((hh) => { kbShowHandle = hh; }).catch(() => {});
      else kbShowHandle = h;
    } catch (e) { /* 忽略 */ }
  }
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onDoc);
  document.removeEventListener("focusin", onFocusIn, true);
  if (kbShowHandle) { try { kbShowHandle.remove(); } catch (e) { /* 忽略 */ } kbShowHandle = null; }
  clearRowShift();
});
</script>

<template>
  <div ref="root" class="emo-root">
    <button type="button" class="emo-btn" :class="{ on: open }" :aria-label="t('emoji.title')"
            @mousedown.prevent @click="toggle">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9.3" fill="none" stroke="currentColor" stroke-width="1.7" />
        <circle cx="8.7" cy="9.9" r="1.3" fill="currentColor" />
        <circle cx="15.3" cy="9.9" r="1.3" fill="currentColor" />
        <path d="M7.8 14c1.1 1.7 2.6 2.6 4.2 2.6s3.1-.9 4.2-2.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
      </svg>
    </button>
    <teleport to="body">
      <transition name="emo-pop">
        <!-- 轮 185：@click.stop 是**必需**的，不是优化。面板 teleport 到 body、不在评论条内，
             而评论条/详情页的「点外收起」都挂在 document 的 click 上；面板不拦 click，
             冒泡到底就会被判成「点了外面」→ 输入框整条消失（用户实测必现）。
             pointerdown.stop 拦不住 click，两处都要。 -->
        <div v-if="open" class="emo-panel" :class="{ 'emo-sheet': sheetOn }" :style="pos"
             @pointerdown.stop @mousedown="onPanelMouseDown" @click.stop>
          <emoji-picker @emoji-click="onEmojiClick"></emoji-picker>
        </div>
      </transition>
    </teleport>
  </div>
</template>

<style>
.emo-root { display: inline-flex; flex: none; }
.emo-btn {
  appearance: none; cursor: pointer; border: none; background: none; padding: 0;
  width: 34px; height: 34px; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--ink-faint); transition: color .15s ease, background-color .15s ease;
}
.emo-btn svg { width: 22px; height: 22px; }
.emo-btn:hover, .emo-btn.on { color: var(--accent-deep); background: var(--accent-soft); }
.emo-panel {
  position: fixed; z-index: 260;
  width: 320px; max-width: calc(100vw - 8px);
  overflow: hidden;
  background: var(--glass-strong); border: 1px solid var(--hairline); border-radius: 18px;
  box-shadow: var(--shadow-lg, 0 12px 34px rgba(20, 20, 19, .16));
  padding: 0;
}
/* emoji-picker-element（Web Component）：尺寸/主题走它的 shadow CSS 变量 */
.emo-panel emoji-picker {
  display: block; width: 100%; height: 100%;
  --num-columns: 8;
  --emoji-padding: 5px;
  --emoji-size: 24px;
  --background: var(--glass-strong);
  --border-color: transparent;
  --category-emoji-size: 24px;
  --indicator-color: var(--accent);
}
.emo-pop-enter-active, .emo-pop-leave-active { transition: opacity .16s ease, transform .16s ease; }
.emo-pop-enter-from, .emo-pop-leave-to { opacity: 0; transform: translateY(8px) scale(.96); }
/* 轮 179：手机/App 表情面板 = 贴屏底的 sheet（面板在输入框下面）。
 * 宽高由组件按 utils/emojiSheetRules 算成显式 px，所以这里只管外观、**不再写 max-height 兜底**
 * （旧版用 max-height: none 让 inline 的 top/bottom 决定高度，正是「键盘收起被拉长」的一半原因）。
 * 判定与 JS 同源：.emo-sheet 由组件按 isApp/窄屏（<640）加 —— 不再用媒体查询重复一套真相。 */
.emo-panel.emo-sheet {
  border-radius: 18px 18px 0 0; border-bottom: none;
  /* 桌面的 max-height: 42vh 是给「按钮上方小弹层」的兜底；sheet 的高度由 inline px 说了算，
     这里必须放开它，否则矮视口下 max-height 会把面板压得比算出来的高度还短。 */
  max-height: none;
  padding-bottom: calc(10px + env(safe-area-inset-bottom, 0px));
}
</style>
