<script setup>
/* 轮 342 · 暖心墙通用输入框（一级评论 / 二级回复 / 手机底部条）
 * ------------------------------------------------------------
 * 形态对齐私信的新输入区：白色胶囊 + 表情 + 纸飞机。
 * 行为：
 *   · 桌面 Enter 发送、Shift+Enter 换行；手机 Enter 换行（只点纸飞机发）
 *   · 表情插到光标处（有选区替换选区），数据源走本地 /emoji/data.json，不走 CDN
 *   · 自动长高到 120px 后内部滚动；点外面 / Esc 收表情面板
 * 数据仍由父页面管：v-model + @send，组件不碰草稿、不碰发送队列。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import "emoji-picker-element";
import { t } from "../i18n.js";
import { isMobileNav, isApp } from "../stores/uiStore.js";
import { enterSends, insertText, pickerOpensUp } from "../utils/composer.js";
import { hideEmojiSearch } from "../utils/emojiPanel.js";
import { scheduleEmojiWarm } from "../utils/emojiWarm.js";

const props = defineProps({
  modelValue: { type: String, default: "" },
  placeholder: { type: String, default: "" },
  maxlength: { type: Number, default: 0 },
  disabled: { type: Boolean, default: false },
});
const emit = defineEmits(["update:modelValue", "send", "focus"]);

const root = ref(null);
const ta = ref(null);
const picker = ref(null);
const emojiOpen = ref(false);
const pickerUp = ref(true);
const canSend = computed(() => !!String(props.modelValue || "").trim() && !props.disabled);
/* 轮401：面板打开时按钮语义从「表情」切「键盘」，和会话段一致。 */
const emojiLabel = computed(() => emojiOpen.value ? t("comment.keyboard") : t("comment.emoji"));

/* 轮 348：手机上表情面板改成「贴底整宽」（与会话段同款），不再是网页那种小浮窗。
 * 判据跟 DmVacChat 的 @media 一致（≤899px），两处才不会一边 sheet 一边浮窗。 */
const isSheet = () => typeof window !== "undefined"
  && typeof window.matchMedia === "function"
  && window.matchMedia("(max-width: 899px)").matches;/* 底条（暖心墙手机主评论条）——面板打开时把整条抬到面板上沿 */
const barOf = () => (root.value && root.value.closest(".cmt-main-bar")) || null;
const syncBar = (open) => {
  const bar = barOf();
  if (bar) bar.classList.toggle("wp-emoji-open", !!open && isSheet());
};

const grow = () => {
  const el = ta.value;
  if (!el) return;
  el.style.height = "auto";
  /* 轮 345：跟 vue-advanced-chat 的 .vac-textarea 同一条长高线
     （默认 300px；视口 ≤768 高时组件 CSS 也是 120px） */
  const max = typeof window !== "undefined" && window.innerHeight <= 768 ? 120 : 300;
  const pad = parseFloat(getComputedStyle(el).paddingTop) || 0;
  const content = el.scrollHeight - pad * 2;
  const h = Math.min(content, max);
  el.style.height = Math.max(h, 20) + "px";
  el.style.overflowY = content > max ? "auto" : "hidden";
};

const onInput = (e) => {
  emit("update:modelValue", e.target.value);
  grow();
};

const doSend = () => {
  if (!canSend.value) return;
  emojiOpen.value = false;
  emit("send");
};

const onKeydown = (e) => {
  if (e.key === "Escape" && emojiOpen.value) {
    emojiOpen.value = false;
    e.stopPropagation();
    return;
  }
  if (!enterSends(e, isMobileNav.value)) return;
  e.preventDefault();
  doSend();
};

const toggleEmoji = () => {
  if (emojiOpen.value) {
    /* 轮401 · 微信式交接：面板开着再点 = 收面板 + 回键盘，不能只把面板关掉。
       先钉住底条让位，等组件收完面板后焦点落回输入框；系统键盘接上后
       .wp-kb-swap 再由 --kb-h 观察器摘掉，底条原地不动。 */
    if (isSheet()) holdForKeyboard();
    emojiOpen.value = false;
    try { if (ta.value) ta.value.focus(); } catch (e) { /* 无焦点环境 */ }
    return;
  }
  /* 上方放不下就往下弹：暖心墙桌面主评论框离页面顶很近，旧版往上弹会被视口裁掉半截。 */
  const el = root.value;
  if (el) {
    const r = el.getBoundingClientRect();
    const narrow = typeof window !== "undefined" && window.innerWidth <= 640;
    const vh = typeof window !== "undefined" ? window.innerHeight : 800;
    const h = Math.min(narrow ? 300 : 340, vh * (narrow ? 0.46 : 0.52));
    pickerUp.value = pickerOpensUp(r.top, r.bottom, vh, h);
  }
  emojiOpen.value = true;
  /* 轮 348：手机上跟会话一致 —— 面板贴底时先把键盘收起来（面板要占屏底 320），
     否则面板会被输入法压在后面。收键盘 = blur + 让位归零，与会话同一套。 */
  if (isSheet()) {
    try { if (ta.value) ta.value.blur(); } catch (e) { /* 无焦点环境 */ }
    try { document.documentElement.style.setProperty("--kb-h", "0px"); } catch (e) { /* 忽略 */ }
  }
};

/* 面板开关 → 底条让位 + 去掉 picker 的搜索框（库每次打开都会重建元素）
 * 轮 478：数据已在空闲时预热过（见 emojiWarm.js 的 scheduleEmojiWarm），
 * 正常情况下面板一打开就是满的；预热没赶上（刚装/弱网/存储被清）时，
 * 先铺一层骨架占位，别让面板是一片空白 —— 用户说的「点了很慢、卡顿」就是这段空白。 */
const pickerReady = ref(false);
let readyTimer = 0;
function watchPickerReady() {
  clearTimeout(readyTimer);
  pickerReady.value = false;
  const started = Date.now();
  const tick = () => {
    const el = picker.value;
    const sr = el && el.shadowRoot;
    if (sr && sr.querySelector(".emoji")) { pickerReady.value = true; return; }
    /* 兜底 2.5s：真拉不下来也不能永远盖着骨架（库拉不到数据时自己会停在空态） */
    if (Date.now() - started > 2500) { pickerReady.value = true; return; }
    readyTimer = setTimeout(tick, 40);
  };
  readyTimer = setTimeout(tick, 16);
}
watch(emojiOpen, async (open) => {
  syncBar(open);
  if (!open) { clearTimeout(readyTimer); pickerReady.value = false; return; }
  await nextTick();
  hideEmojiSearch(picker.value);
  watchPickerReady();
  /* emoji-picker 的 shadow 可能晚一帧才挂好，再补一次（幂等） */
  setTimeout(() => hideEmojiSearch(picker.value), 80);
});

/* 轮 350 · 手机上面板里点一个表情：不许抢焦点。
 * 真机（393×895）实报：点一个表情，输入法立刻弹起来、面板被顶掉 —— 看着像「自动切回文字输入」。
 * 原因就是下面 onEmoji 里那次 focus()（桌面没键盘，一直是好的）。
 * 现在：面板贴着屏底时（isSheet）只插字、不 focus，面板保持打开，可以接着点；
 * 插入位置用记住的光标（面板打开时输入框是 blur 的，selectionStart 会退成 0）。 */
let lastCaret = null;
const rememberCaret = () => {
  const el = ta.value;
  if (el && el.selectionStart != null) lastCaret = el.selectionStart;
};
const onEmoji = async (e) => {
  const unicode = e && e.detail && e.detail.unicode;
  if (!unicode) return;
  const el = ta.value;
  const value = String(props.modelValue || "");
  const active = el && document.activeElement === el;
  const start = active && el.selectionStart != null
    ? el.selectionStart
    : (lastCaret == null ? value.length : Math.min(lastCaret, value.length));
  const end = active && el.selectionEnd != null ? el.selectionEnd : start;
  const r = insertText(value, start, end, unicode, props.maxlength);
  emit("update:modelValue", r.value);
  lastCaret = r.caret;
  await nextTick();
  const n = ta.value;
  if (!n) return;
  /* 桌面：保持焦点，选完接着打字；手机贴底面板：绝不 focus（一 focus 输入法就上来） */
  if (!isSheet()) {
    try {
      n.focus();
      n.setSelectionRange(r.caret, r.caret);
    } catch (err) { /* 无焦点环境 */ }
  }
  grow();
};

/* 点组件外面收面板；表情面板在 shadow DOM 里，事件 target 会重定向到 emoji-picker 宿主，
   root.contains(target) 仍然成立。
   轮 348：面板贴底后，点输入框不能在 pointerdown 就收 —— 暖心墙底条的 document click
   监听会按「点击目标是否还在条内」决定关不关条，面板先收、输入框同帧落回屏底，
   这一击就点空了：条被关掉、键盘也不弹。
   所以点输入区时只记一笔，到 click（目标还是输入框）再收面板并补一次 focus。 */
/* 轮 350b · 面板 → 键盘的交接（暖心墙底条）。
 * 真机 393×895 实测：面板开着点输入框，底条 bottom 从 320 掉回 var(--kb-h)=0，
 * 整条落到屏底（barY 518→781，掉 256px）；键盘 ~300ms 后才弹起又把它顶回 525。
 * 做法：收面板时先给底条挂 .wp-kb-swap（bottom 钉在面板高），等 --kb-h > 0 再摘掉
 * —— 面板高与键盘高同为 320，摘掉时几乎不动。1.2s 等不到键盘就兜底摘掉。 */
let kbSwapMO = null;
let kbSwapTimer = 0;
const endKbSwap = () => {
  clearTimeout(kbSwapTimer);
  if (kbSwapMO) { kbSwapMO.disconnect(); kbSwapMO = null; }
  const bar = barOf();
  if (bar) bar.classList.remove("wp-kb-swap");
};
const holdForKeyboard = () => {
  /* 只有 App 壳才有 --kb-h（网页端是浏览器自己缩视口）——网页上钉住会让底条先悬空 1.2s */
  if (!isApp) return;
  const bar = barOf();
  if (!bar) return;
  bar.classList.add("wp-kb-swap");
  if (kbSwapMO) kbSwapMO.disconnect();
  kbSwapMO = new MutationObserver(() => {
    const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--kb-h")) || 0;
    if (v > 0) endKbSwap();
  });
  kbSwapMO.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
  clearTimeout(kbSwapTimer);
  kbSwapTimer = setTimeout(endKbSwap, 1200);
};

let tapClosePending = false;
const onDocDown = (e) => {
  if (!emojiOpen.value) return;
  if (root.value && root.value.contains(e.target)) {
    const field = e.target && e.target.closest ? e.target.closest(".wp-composer-field") : null;
    if (field || e.target === ta.value) tapClosePending = true;
    return;
  }
  emojiOpen.value = false;
};
const onDocClick = () => {
  if (!tapClosePending) return;
  tapClosePending = false;
  if (isSheet()) holdForKeyboard();     /* 让位先钉住，等键盘接上再撤 */
  emojiOpen.value = false;
  try { if (ta.value) ta.value.focus(); } catch (err) { /* 无焦点环境 */ }
};

onMounted(() => {
  document.addEventListener("pointerdown", onDocDown, true);
  document.addEventListener("click", onDocClick);
  grow();
  /* 轮 478：输入组件一出现就在空闲时把表情数据备好（幂等，全站只跑一次）——
     首次点开表情要等 500~800ms 就是这段数据现拉现写造成的。 */
  scheduleEmojiWarm();
});
onBeforeUnmount(() => {
  endKbSwap();
  clearTimeout(readyTimer);
  document.removeEventListener("pointerdown", onDocDown, true);
  document.removeEventListener("click", onDocClick);
});
watch(() => props.modelValue, () => nextTick(grow));

defineExpose({
  focus: () => { try { ta.value && ta.value.focus(); } catch (e) { /* 无焦点环境 */ } },
  textarea: ta,
});
</script>

<template>
  <div ref="root" class="wp-composer" :class="{ 'is-disabled': disabled, 'emoji-down': !pickerUp }">
    <div class="wp-composer-field">
      <textarea
        ref="ta"
        class="wp-composer-input"
        :value="modelValue"
        :placeholder="placeholder"
        :maxlength="maxlength || undefined"
        :disabled="disabled"
        rows="1"
        @input="onInput"
        @keydown="onKeydown"
        @focus="emit('focus')"
        @select="rememberCaret"
        @keyup="rememberCaret"
        @click="rememberCaret"
        @blur="rememberCaret"
      ></textarea>
    </div>

    <button
      type="button"
      class="wp-composer-ico is-emoji"
      :title="emojiLabel"
      :aria-label="emojiLabel"
      :aria-expanded="emojiOpen ? 'true' : 'false'"
      @click.stop="toggleEmoji"
    >
      <svg v-if="emojiOpen" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="M20 5H4c-1.1 0-1.99.9-1.99 2L2 17c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm-9 3h2v2h-2V8zm0 3h2v2h-2v-2zM8 8h2v2H8V8zm0 3h2v2H8v-2zm-1 5H5v-2h2v2zm0-3H5v-2h2v2zm0-3H5V8h2v2zm9 6H8v-2h8v2zm0-3h-2v-2h2v2zm0-3h-2V8h2v2zm3 6h-2v-2h2v2zm0-3h-2v-2h2v2zm0-3h-2V8h2v2z"></path>
      </svg>
      <svg v-else viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm3.5-9c.83 0 1.5-.67 1.5-1.5S16.33 8 15.5 8 14 8.67 14 9.5s.67 1.5 1.5 1.5zm-7 0c.83 0 1.5-.67 1.5-1.5S9.33 8 8.5 8 7 8.67 7 9.5 7.67 11 8.5 11zm3.5 6.5c2.33 0 4.31-1.46 5.11-3.5H6.89c.8 2.04 2.78 3.5 5.11 3.5z"></path>
      </svg>
    </button>

    <button
      type="button"
      class="wp-composer-ico is-send"
      :class="{ on: canSend }"
      :title="t('common.send')"
      :aria-label="t('common.send')"
      :disabled="!canSend"
      @click.stop="doSend"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="M2,21L23,12L2,3V10L17,12L2,14V21Z"></path>
      </svg>
    </button>

    <div v-if="emojiOpen" class="wp-composer-picker" @click.stop>
      <!-- 轮 478：数据没到位时铺一层占位（面板原本这段是纯空白，看着像点坏了） -->
      <div v-if="!pickerReady" class="wp-picker-skel" aria-hidden="true">
        <i v-for="n in 48" :key="n"></i>
      </div>
      <emoji-picker data-source="/emoji/data.json" ref="picker" @emoji-click="onEmoji"></emoji-picker>
    </div>
  </div>
</template>

<style scoped>
/* 轮 345：按 vue-advanced-chat 的 .vac-textarea / .vac-icon-textarea 原尺重画。
   会话底栏（390 宽实测）：胶囊 308×36、圆角 20、底色 var(--wash-strong)（实测
   computed rgba(255,255,255,.9)，叠在 #faf9f5 上与会话同色）、描边 #e6dfd8、
   字号 16/18、左内边距 12；表情/纸飞机各 34×24，图标 24，间距 5。 */
.wp-composer {
  position: relative;
  display: flex;
  align-items: stretch;
  gap: 0;
  flex: 1 1 auto;
  min-width: 0;
  width: 100%;
  box-sizing: border-box;
}
.wp-composer-field {
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  align-items: flex-end;
  padding: 0;
  background: var(--wash-strong, #fffdf9);
  border: 1px solid var(--hairline, #e6dfd8);
  border-radius: 20px;
  box-shadow: none;
}
.wp-composer-input {
  flex: 1 1 0;
  width: auto;
  min-width: 0;
  height: 20px;
  max-height: 300px;
  padding: 12px 16px 12px 12px;
  border: 0;
  outline: none;
  background: transparent;
  resize: none;
  font: inherit;
  font-size: 16px;
  line-height: 20px;
  color: var(--ink, #141413);
  overflow-y: hidden;
  box-sizing: content-box;
}
.wp-composer-input::placeholder {
  color: var(--ink-faint, #8e8b82);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.wp-composer-ico {
  flex: none;
  width: 38px;
  height: 24px;
  align-self: center;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--ink-faint, #8e8b82);
  cursor: pointer;
  transition: transform .2s ease, opacity .2s ease;
}
.wp-composer-ico svg { width: 24px; height: 24px; display: block; }
.wp-composer-ico.is-emoji { color: var(--accent, #cc785c); margin-left: 5px; }
.wp-composer-ico.is-send.on { color: var(--accent, #cc785c); }
.wp-composer-ico:not(:disabled):hover { transform: scale(1.1); opacity: .7; }
.wp-composer-ico:disabled { opacity: 1; color: var(--ink-faint, #8e8b82); cursor: default; }
.wp-composer-ico:focus-visible { outline: 2px solid var(--accent, #cc785c); outline-offset: 1px; }

.wp-composer.emoji-down .wp-composer-picker {
  top: calc(100% + 8px);
  bottom: auto;
}
.wp-composer-picker {
  position: absolute;
  right: 0;
  bottom: calc(100% + 8px);
  z-index: 80;
  width: min(320px, calc(100vw - 28px));
  height: min(340px, 52vh);
  border: 1px solid var(--hairline, #e6dfd8);
  border-radius: 16px;
  overflow: hidden;
  background: var(--wash-strong, #fffdf9);
  box-shadow: 0 18px 44px rgba(40, 28, 16, 0.18);
}
.wp-composer-picker emoji-picker {
  width: 100%;
  height: 100%;
  --background: var(--wash-strong, #fffdf9);
  --border-color: var(--hairline, #e6dfd8);
  --indicator-color: var(--accent, #cc785c);
  --input-border-color: var(--hairline, #e6dfd8);
  --category-emoji-size: 1.15rem;
}
/* 轮 478：加载占位。尺寸对齐真实网格（8 列、格子近正方），数据到位后直接换成真表情，
   不会看到「一小撮 → 一整屏」的跳变。 */
.wp-picker-skel {
  position: absolute;
  inset: 0;
  z-index: 1;
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  grid-auto-rows: 34px;
  gap: 4px;
  padding: 10px 8px;
  background: var(--wash-strong, #fffdf9);
}
.wp-picker-skel i {
  border-radius: 8px;
  background: var(--hairline, #e6dfd8);
  opacity: .45;
  animation: wp-skel-pulse 1.1s ease-in-out infinite;
}
.wp-picker-skel i:nth-child(8n+2) { animation-delay: .08s; }
.wp-picker-skel i:nth-child(8n+3) { animation-delay: .16s; }
.wp-picker-skel i:nth-child(8n+4) { animation-delay: .24s; }
.wp-picker-skel i:nth-child(8n+5) { animation-delay: .32s; }
.wp-picker-skel i:nth-child(8n+6) { animation-delay: .4s; }
@keyframes wp-skel-pulse {
  0%, 100% { opacity: .32; }
  50% { opacity: .62; }
}
@media (prefers-reduced-motion: reduce) {
  .wp-picker-skel i { animation: none; opacity: .45; }
}

@media (max-width: 768px) {
  .wp-composer-input { padding: 7px 7px 7px 12px; line-height: 18px; }
  .wp-composer-ico { width: 34px; }
  .wp-composer-picker {
    right: -4px;
    width: min(320px, calc(100vw - 20px));
    height: min(300px, 46vh);
  }
}

/* 轮 348 · 手机上表情面板 = 贴底整宽（与会话段同款，微信式），不再是网页那种小浮窗。
   高度跟 DmVacChat 的 --wp-emoji-h 同一条（min(46vh, 320px)），底条由父级
   .cmt-main-bar.wp-emoji-open 抬到面板上沿（见 style.css）。 */
@media (max-width: 899px) {
  .wp-composer.emoji-down .wp-composer-picker,
  .wp-composer-picker {
    position: fixed;
    left: 0;
    right: 0;
    top: auto;
    bottom: 0;
    width: 100%;
    /* 轮 482：与底条 .cmt-main-bar 的 bottom 用同一个变量 —— 面板高 = 上一次真实键盘高，
       「收键盘弹面板 / 面板收键盘」两次切换的位置完全对齐（原来写死 min(46vh,320px)，
       和真机键盘 280~310 差一截，用户看到输入条跳一下）。 */
    height: var(--kb-panel-h);
    max-height: none;
    border: 0;
    border-top: 1px solid var(--hairline, #e6dfd8);
    border-radius: 0;
    box-shadow: none;
    background: var(--wash-strong, #fffdf9);
    z-index: 170;
  }
  .wp-composer-picker emoji-picker {
    width: 100%;
    height: calc(100% - var(--sab, env(safe-area-inset-bottom, 0px)));
    --emoji-size: 1.35rem;
    --emoji-padding: .35rem;
  }
}
@media (max-height: 768px) {
  .wp-composer-input { max-height: 120px; }
}
</style>
