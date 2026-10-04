<!-- 轮 164：表情按钮 + 弹出面板（微信常用集，Unicode 免资产）——评论框/私信框共用。
 * 用法：<EmojiPicker :text="draft" @update:text="v => draft = v" />——
 * 按钮放发送键左侧；面板 position:fixed 按按钮实时 rect 定位（teleport 到 body），
 * 不受祖先 overflow 裁剪 / transform 包含块影响（home-track 陷阱同源）。
 * 插入在 textarea/input 光标处（picker 自己在同行内找输入元素），插入后焦点+光标归位。
 * 点选不收面板（可连选），点面板外/再点按钮收起。 -->
<script setup>
import { ref, nextTick, onMounted, onBeforeUnmount } from "vue";
import { t } from "../i18n.js";
import { isApp } from "../stores/uiStore.js";
import { emojiSheetMode, sheetLayout, keyboardHeight, isEmojiHit } from "../utils/emojiSheetRules.js";

const EMOJIS = [
  "😊", "😄", "😁", "😆", "😅", "😂", "🤣", "🙂",
  "🥰", "😍", "😘", "🤗", "🥺", "😳", "😋", "🤩",
  "😎", "🥳", "😏", "😌", "🤔", "🙄", "😴", "🥱",
  "😔", "😢", "😭", "😤", "😠", "😡", "😱", "🤯",
  "😇", "😉", "💪", "👏", "🙏", "🤝", "✌️", "👋",
  "🌹", "💐", "🌸", "🍀", "🌈", "⭐", "✨", "🔥",
  "🍬", "🍰", "☕", "💤", "❤️", "💕", "💖", "💯",
  "🎉", "🎁", "🐱", "🐶", "🐾", "👀", "🙈", "💬",
];

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

/** 本次输入行里的输入元素（插入表情、收起面板后把焦点还回去都用它） */
function inputEl() {
  return root.value ? root.value.parentElement.querySelector("textarea, input") : null;
}

/* 轮 183 · 自己记光标，别去问一个「已经失焦」的元素。
 * 病根：面板开着时输入框是 blur 的（键盘被面板顶掉），这时 v-model 一改写，
 * 元素自己的 selectionStart/End 会被复位到 0 —— 收起面板时再读它，
 * 光标就「跳回首字」，正是用户第三次报的那条。所以：
 *   ① 收键盘**之前**把当时的光标位置存下来（那一刻它是准的）；
 *   ② 每插一个表情按插完的位置递推；
 *   ③ 收起时用存下来的值恢复，不读元素。
 * 面板开着时用户无法打字，光标只由「插入表情」这一个动作推进，所以递推是可靠的。
 *
 * 轮 185（真机复验又报「点表情按钮 → 光标变成首个」）：上面 ① 的时机也不够。
 * 用户点按钮的那一刻，**输入框已经被按钮的这次点击 blur 了** —— openSheet 里
 * rememberCaret() 读到的 selectionStart 已经是失焦后的值（浏览器复位成 0）。
 * 正确做法是**持续跟踪**：输入框获得焦点期间（打字/移动光标/选中/粘贴）一直记，
 * 于是任何时刻点按钮拿到的都是真位置，而不是「点按钮那一刻的残值」。
 */
let caretMem = null;
let caretBound = null;   /* 当前绑定的输入元素（换行/换草稿时解绑重绑） */

function rememberCaret() {
  const el = inputEl();
  if (el && typeof el.selectionStart === "number") caretMem = el.selectionStart;
}

/** 输入框在焦点内时的任何光标变化都记下来（打字/方向键/拖选/粘贴/长按菜单） */
function trackCaret(el) {
  if (!el || caretBound === el) return;
  untrackCaret();
  caretBound = el;
  const onEvt = () => {
    const t = caretBound;
    if (!t || !t.isConnected) return;
    if (typeof t.selectionStart === "number") caretMem = t.selectionStart;
  };
  /* selectionchange 是浏览器统一口径（覆盖点击定位、拖选、程序改selection）；
   * keyup/input/pointerup 兜住个别内核不发 selectionchange 的情况。 */
  for (const n of ["keyup", "input", "pointerup", "focus", "select"]) el.addEventListener(n, onEvt, true);
  document.addEventListener("selectionchange", onEvt);
  caretUnbind = () => {
    for (const n of ["keyup", "input", "pointerup", "focus", "select"]) el.removeEventListener(n, onEvt, true);
    document.removeEventListener("selectionchange", onEvt);
  };
}
let caretUnbind = null;
function untrackCaret() {
  if (caretUnbind) { try { caretUnbind(); } catch (e) { /* 忽略 */ } }
  caretUnbind = null;
  caretBound = null;
}

/**
 * 轮 185：把记好的光标**真正落到元素上**。
 * 必须 focus →（值没跟上就先补值）→ setSelectionRange → 下一帧再按一次同一位置。
 * 最后那一次是关键：v-model 是异步写值，值刷进来会把 selection 复位到 0，
 * 只在 nextTick 里设一次等于白设（这正是「光标变成首个」的真凶）。
 * 全程**不回读**元素的位置，只用 caretMem —— 它是唯一可信的真相。
 */
function applyCaret(el, caret, allowFocus = true) {
  if (!el || !el.isConnected || caret == null) return;
  try {
    /* 轮 187：allowFocus=false 用于「面板开着连选」——一 focus 输入框，
       focusin 就被 onFocusIn 接住 → 面板被关（用户实测「点表情后面板收了」）。
       光标位置照样记录，用户点输入框时从这里继续。 */
    if (allowFocus && document.activeElement !== el) el.focus({ preventScroll: true });
    /* 值还没被Vue 刷进来时，光标下标是按旧串算的 —— 先对齐值再定位 */
    if (typeof props.text === "string" && el.value !== props.text) el.value = props.text;
    el.setSelectionRange(caret, caret);
  } catch (e) { /* 无光标环境（detached / 不支持）忽略 */ }
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
  trackCaret(inputEl());   /* 轮 185：先接管光标跟踪，再 blur —— 之后怎么改都不会丢位置 */
  rememberCaret();
  sheetH = keyboardHeight({ innerH: window.innerHeight, restH }) || 0;
  layoutSheet();   /* 先算好再渲染：面板一出现就在正确位置，不会先闪一下默认坐标 */
  const ae = document.activeElement;
  if (ae && ae !== document.body && ae.blur) ae.blur();   /* 收键盘：面板占键盘位，两者互斥 */
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
  /* 轮 185：只用记下来的光标，绝不回读元素（失焦 + v-model 改写后读出来是 0） */
  const caret = caretMem;
  clearRowShift();
  if (el) {
    trackCaret(el);
    const run = () => {
      /* 再防御一次：万一浏览器又把焦点给了按钮/别处，抢回来 */
      if (document.activeElement !== el && document.activeElement &&
          document.activeElement !== document.body &&
          typeof document.activeElement.blur === "function") {
        try { document.activeElement.blur(); } catch (e) { /* 忽略 */ }
      }
      applyCaret(el, caret);
    };
    nextTick(run);
    /* 值刷进来会复位 selection —— 再补一帧；键盘动画前后各一次，三重保险 */
    requestAnimationFrame(run);
    clearSettle();
    /* 最后一发放在 click 默认行为（浏览器给按钮 focus）之后，确保我们赢 */
    settleTimers = [0, 120, 320, 520].map((ms) => setTimeout(run, ms));
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

function pick(e) {
  /* 输入元素 = 按钮所在输入行里的第一个 textarea/input（每行只有一个） */
  const el = inputEl();
  trackCaret(el);
  const base = String(props.text || "");
  let out, caret;
  /* 轮 183/185：面板开着时元素是失焦的，selectionStart 已被 v-model 改写复位 → 不可信。
   * 一律用「记下来的光标」，插完再递推，面板开多久都不会漂。 */
  const s0 = caretMem != null ? caretMem
    : (el && typeof el.selectionStart === "number" ? el.selectionStart : null);
  if (el && s0 != null) {
    const en = el.selectionEnd == null ? s0 : el.selectionEnd;
    const lo = Math.min(s0, en), hi = Math.max(s0, en);   /* 选区存在时整段替换 */
    out = base.slice(0, lo) + e + base.slice(hi);
    caret = lo + e.length;
  } else {
    out = base + e;
    caret = out.length;
  }
  caretMem = caret;   /* 递推下一步的位置 —— 全组件唯一的真相源 */
  emit("update:text", out);
  nextTick(() => {
    if (!el) return;
    /* 轮 187：连选模式——选完**绝不 focus**（一 focus 输入框，onFocusIn 就把面板关了，
     * 用户实测「点表情后面板收了」）；光标已记在 caretMem，点输入框/收面板时接着用 */
    applyCaret(el, caret, false);
  });
}

/**
 * 面板开着时用户点回输入框要打字 —— 必须让位给键盘。
 * 轮 182：只收起面板、**不调focus**（系统是用户自己点的，键盘自然弹起；程序再focus 一次会闪）。
 * 用 focusin 兜住：点击不一定先落在输入框上（先落在它的包装层），focusin 更可靠。
 */
function onFocusIn(e) {
  if (!open.value) return;
  const el = inputEl();
  if (el && (e.target === el || (el.contains && el.contains(e.target)))) closeSheet(false);
}

function onDoc(e) {
  /* 点面板/按钮以外的地方收起：**不还焦点** —— 用户是去点别处了，强行弹键盘会抢焦点。
   * 轮 185：输入条的「点外收起」也挂在 document 上，两边必须用**同一套命中判定**，
   * 否则会出现「面板点得好好的，评论条却被收起」。统一走 utils 的 isEmojiHit()，
   * 它认的是静态标记（.emo-btn/.emo-panel/.emo-root），不依赖面板此刻在不在 DOM 里。 */
  if (open.value && root.value && !root.value.contains(e.target) && !isEmojiHit(e.target)) closeSheet(false);
}
onMounted(() => {
  rememberRest();
  document.addEventListener("pointerdown", onDoc);
  document.addEventListener("focusin", onFocusIn, true);
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onDoc);
  document.removeEventListener("focusin", onFocusIn, true);
  untrackCaret();   /* 轮 185：document 上的 selectionchange 监听必须解，否则元素换了还跟着旧元素记 */
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
             @pointerdown.stop @click.stop>
          <button v-for="e in EMOJIS" :key="e" type="button" class="emo-cell" @mousedown.prevent @click="pick(e)">{{ e }}</button>
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
  width: 296px; max-width: calc(100vw - 16px); max-height: 42vh; overflow-y: auto;
  overscroll-behavior: contain;
  display: grid; grid-template-columns: repeat(8, 1fr); gap: 2px; padding: 10px;
  background: var(--glass-strong); border: 1px solid var(--hairline); border-radius: 16px;
  box-shadow: var(--shadow-lg, 0 12px 34px rgba(20, 20, 19, .16));
}
.emo-cell {
  appearance: none; border: none; background: none; cursor: pointer;
  font-size: 21px; line-height: 1; padding: 5px 0; border-radius: 9px;
  transition: transform .12s ease, background-color .12s ease;
}
.emo-cell:hover { background: var(--wash); }
.emo-cell:active { transform: scale(.86); }
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
.emo-panel.emo-sheet .emo-cell { font-size: 20px; padding: 4px 0; }
</style>
