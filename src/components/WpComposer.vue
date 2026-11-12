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
import { isMobileNav } from "../stores/uiStore.js";
import { setPanelOpen } from "../utils/keyboardInset.js";
import { syncViewportVars } from "../utils/viewportVars.js";
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
let barDropTimer = 0;
/* 面板 → 键盘：把 .wp-emoji-open 摘掉的时机。
 *
 * 不能按时间摘 —— 真机逐帧：固定 280ms 到点时系统键盘才起到一半（inner 还 539），
 * 摘掉类那一刻 bottom 从 55 掉回 0，输入行跳 55px，然后键盘到位又跳回来。
 * 改成等「键盘真正占到面板高度」再摘：那时抬升量本来就是 0，摘不摘都一样，零跳变。
 * 键盘压根没起来（用户点了别处）就一直等到帧数用完，然后摘掉、条自然落回屏底。
 *
 * ⚠ 不要用 getComputedStyle 读这两个数：它每帧强制同步重排，而这段正好跑在
 * 键盘弹出动画的第一个 100ms 里 —— 真机上会把系统键盘的弹出打断（实测 inner 停在 744）。
 * utils/viewportVars.js 每帧已经把值算好放在 window.__wpVars 里，直接读，零开销。 */
const dropBarWhenReady = (bar, frames) => {
  if (!bar || emojiOpen.value) return;
  const wv = (typeof window !== "undefined" && window.__wpVars) || null;
  if (wv && wv.panel > 0 && wv.kbNow < wv.panel - 6 && frames > 0) {
    requestAnimationFrame(() => dropBarWhenReady(bar, frames - 1));
    return;
  }
  bar.classList.remove("wp-emoji-open");
};
const syncBar = (open) => {
  const bar = barOf();
  clearTimeout(barDropTimer);
  if (open && isSheet()) {
    if (bar) bar.classList.add("wp-emoji-open");
  } else if (bar) {
    barDropTimer = setTimeout(() => dropBarWhenReady(bar, 40), 60);
  }
  /* 轮 515：面板态还要打到 html 上。
   * App 壳里暖心墙没有 .dm-page，整页高度只由 `body { padding-bottom: var(--kb-h) }`
   * 决定；面板打开会让键盘收起（--kb-h → 0），那 320px 的让位要是也走 220ms 过渡，
   * 屏幕上就是「底部抽出一条空白再填上」—— 第 2 条那个闪的另一半。
   * 见 style.css 的 `html.cap-app.kb-anim:not(.wp-panel) body`。 */
  try {
    document.documentElement.classList.toggle("wp-panel", !!open && isSheet());
  } catch (e) { /* 无 DOM 环境 */ }
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
    /* 面板开着再点 = 收面板 + 回键盘（微信式交接）。
     * 顺序必须先是 focus：iOS 只在用户手势的同步栈里认 focus()。
     * 轮 519：这里原来还有一句 holdForKeyboard() 去把底条钉在面板高度上等键盘接住。
     * 现在不需要了 —— 条的抬升量是 calc(面板高 − --kb-now)，键盘一起来 --kb-now
     * 就跟着涨、抬升量跟着减，两边自然咬合，没有任何需要「等」的窗口。 */
    try { if (ta.value) ta.value.focus(); } catch (e) { /* 无焦点环境 */ }
    emojiOpen.value = false;
    return;
  }
  /* 上方放不下就往下弹：暖心墙桌面主评论框离页面顶很近，旧版往上弹会被视口裁掉半截。 */
  /* 轮 519：开面板这一刻先现读一次视口。以前是为了「抢在键盘收起前把 --kb-last 定住」，
   * 现在面板高是锁定的常量，这次同步只为了让 --kb-now 处于最新值，
   * 免得面板出现的第一帧按上一帧的键盘高度去 drop。 */
  syncViewportVars();
  const el = root.value;
  if (el) {
    const r = el.getBoundingClientRect();
    const narrow = typeof window !== "undefined" && window.innerWidth <= 640;
    const vh = typeof window !== "undefined" ? window.innerHeight : 800;
    const h = Math.min(narrow ? 300 : 340, vh * (narrow ? 0.46 : 0.52));
    pickerUp.value = pickerOpensUp(r.top, r.bottom, vh, h);
  }
  emojiOpen.value = true;
  /* 手机上跟会话一致 —— 面板贴底，先把键盘收起来，否则面板会被输入法压在后面。
   * 收键盘 = blur。让位不用管：--kb-now 会随 inner 回升自己减到 0。 */
  if (isSheet()) {
    try { if (ta.value) ta.value.blur(); } catch (e) { /* 无焦点环境 */ }
  }
};

/* 面板开关 → 底条让位 + 去掉 picker 的搜索框（库每次打开都会重建元素）
 * 轮 478：数据已在空闲时预热过（见 emojiWarm.js 的 scheduleEmojiWarm），
 * 正常情况下面板一打开就是满的；预热没赶上（刚装/弱网/存储被清）时，
 * 先铺一层骨架占位，别让面板是一片空白 —— 用户说的「点了很慢、卡顿」就是这段空白。 */
/* 轮 515 · 首帧就查一次：预热过的话 shadowRoot 里已经有 `.emoji`，
 * 不必先渲染一帧骨架再换成真表情（那一帧就是用户说的「一闪」）。
 * picker.value 此刻是 null（面板还没插进 DOM），只有上次留着的老节点才查得到，
 * 所以这一步只是「省掉能省的那次」，查不到就走原来的定时器，行为不变。 */
const pickerLooksReady = () => {
  try {
    const el = picker.value;
    const sr = el && el.shadowRoot;
    return !!(sr && sr.querySelector(".emoji"));
  } catch (e) { return false; }
};
const pickerReady = ref(false);
/* 轮 517 · 面板**只挂一次，之后只隐藏**（v-show），不再 v-if 卸载。
 *
 * 用户第 2 条（安卓浏览器，反复切键盘/表情）「有一闪的东西」，工装量到的就是这个：
 *   v-if="emojiOpen" ⇒ 切一次键盘就把 .wp-composer-picker 连同 <emoji-picker>
 *   一起从 DOM 摘掉，再点表情时**重新造一个自定义元素**。
 *   androidbar-drive 逐帧采实例 uid：第一次 1、切走 0、第二次 2 —— 每次都重建。
 * 重建的代价在真机上不在几何（几何是同帧到位的），而在格子：
 * 库要把 /emoji/data.json 重新灌一遍、上百个格子重新渲染，这几十到几百毫秒里
 * 面板是空的/只有骨架 —— 肉眼看到的就是「一闪」。
 * 保活之后 shadowRoot 一直在，watchPickerReady 的同步探测第一帧就命中，骨架不再出现。 */
const pickerMounted = ref(false);
let readyTimer = 0;
/* 轮 519：这里原来有一整套「量面板实际高度 → 写进底条内联 padding-bottom」，
 * 还配了 ResizeObserver + 260ms 复核。删掉的理由：
 *   ① 面板高度现在就是 CSS 的 var(--kb-panel-h)（锁定的键盘高），量出来必然等于它；
 *   ② 让位改成了 transform（位移），不再改 padding —— 改布局会在键盘收起那一帧
 *      把输入行顶到上半屏，那正是「一闪」的主体；
 *   ③ 内联样式和 CSS 规则抢同一件事，出了偏差只能靠 ResizeObserver 反复纠正。
 * 现在条的位置完全由 style.css 里那一条 calc 决定，一处定义、一处生效。 */
function watchPickerReady() {
  clearTimeout(readyTimer);
  /* 轮 515：预热过的话 shadowRoot 里此刻就已经有格子 —— 先同步查一次，
   * 查到就直接算就绪，别先渲染一帧骨架再换成真表情（那一帧就是「一闪」）。 */
  if (pickerLooksReady()) { pickerReady.value = true; return; }
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
  /* 轮 504：开关统一走 setPanelOpen（开=整屏，关=作废缓存后重算）。
   * 以前只有「开」这一半，而且是 toggleEmoji 手写 --kb-h=0 绕过去的。
   * 桌面也照传 false：转桌面/拖宽之后 panelOpen 不许留在 true（否则 --kb-h 永远归零）。 */
  setPanelOpen(!!open && isSheet());
  if (!open) {
    clearTimeout(readyTimer);
    /* 轮 517：这里原来有 `pickerReady.value = false` —— 只对「面板会被销毁」成立。
     * 现在面板保活（pickerMounted），置 false 会让下次打开先渲染一帧骨架，等于
     * 自己造出那「一闪」。就绪状态跟着实例走，实例还在就必须保持 true。 */
    return;
  }
  pickerMounted.value = true;
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
/* 轮 519 · 这一整段（endKbSwap / holdForKeyboard / MutationObserver / resize 监听 /
 * 1200ms 兜底定时器）已删除。
 *
 * 它存在的唯一理由是：收面板那一刻 --kb-h 还是 0，底条会先落回屏底、等键盘 200~350ms
 * 后才被顶回来，所以要「先把条钉在面板高度上，等键盘信号到了再摘」。三套判断叠在一起
 * （--kb-h > 0 / --kbb 变化 ≥60 / innerHeight 缩小 ≥120），还得配 1.2s 兜底 —— 因为
 * 只要有一台机器三条都不命中，条就会在那 1.2 秒里悬在半空。
 *
 * 现在没有「等」这件事了：条的抬升量 = calc(面板高 − --kb-now)，而 --kb-now 就是键盘
 * 当前占高。键盘一起来它就涨、抬升量同步减少，两边逐帧咬合。开关面板只改一个类名，
 * 位置由 CSS 自己算完。 */

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
  clearTimeout(readyTimer);
  clearTimeout(barDropTimer);
  /* 轮 515：面板开着就被卸载时 html.wp-panel 必须摘掉，
     否则 body 的键盘让位永远不走过渡（按钮场景里那一跳） */
  try { document.documentElement.classList.remove("wp-panel"); } catch (e) { /* 忽略 */ }
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

    <!-- 轮 517：保活（v-if 只决定「有没有造过」，开关走 is-open 类）。
         不能用 v-show —— style.css 里 `.post-card:has(.wp-composer-picker)` 靠
         「面板在不在 DOM 里」让当前那张卡让路，v-show 的 display:none 它照样命中，
         于是所有带输入条的帖子卡都会 常驻 content-visibility:visible + z-index:2。
         用类名后 :has 只认真正打开的那一个。 -->
    <div
      v-if="pickerMounted"
      class="wp-composer-picker"
      :class="{ 'is-open': emojiOpen }"
      @click.stop
    >
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
  /* 轮 517：默认不占位（保活后 DOM 常在，靠这个类开关显隐，别用 v-show） */
  display: none;
  width: min(320px, calc(100vw - 28px));
  height: min(340px, 52vh);
  border: 1px solid var(--hairline, #e6dfd8);
  border-radius: 16px;
  overflow: hidden;
  background: var(--wash-strong, #fffdf9);
  box-shadow: 0 18px 44px rgba(40, 28, 16, 0.18);
}
.wp-composer-picker.is-open { display: block; }
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
    width: 100%;
    /* 轮 482：与底条 .cmt-main-bar 的 bottom 用同一个变量 —— 面板高 = 上一次真实键盘高，
       「收键盘弹面板 / 面板收键盘」两次切换的位置完全对齐（原来写死 min(46vh,320px)，
       和真机键盘 280~310 差一截，用户看到输入条跳一下）。
       轮 506：bottom 也换成 --kbb（可视视口底离布局视口底多远），与底条同一个数。
       以前是 `bottom: 0` = 布局视口底 —— 键盘弹起 / iOS 底部工具栏浮起时，
       面板会整块落在键盘下方（用户截图：最后一排 emoji 看不见）。 */
    bottom: calc(var(--kbb, 0px) + var(--kb-over, 0px));
    height: var(--kb-panel-h);
    /* 轮 519 · 键盘还在时把面板压在键盘**正下方**，等键盘收起它就从底下升上来。
     *
     * fixed 的 bottom 是相对布局视口底，键盘弹起时布局视口只剩 484，
     * 面板 bottom:0 就会落在 224~484 —— 键盘上方、正好盖住聊天内容（用户看到的「面板
     * 先糊到屏幕中间，然后掉下去」）。translateY(--kb-now) 把面板往下推一个「键盘当前
     * 占高」，它就始终停在屏幕底部那一块：键盘在时被键盘盖住看不见，键盘收完自然露出。
     *
     * 键盘收多少 --kb-now 就减多少，面板跟着升多少，两者同一个数驱动，不会错位。
     * iOS（overlay 型）的 --kb-now 就是可视视口上推量，与原 --vtop 是同一个数，
     * 所以这条规则两型通用，不再是两份。 */
    transform: translateY(var(--kb-now, 0px));
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
