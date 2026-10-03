<!-- 轮 164：表情按钮 + 弹出面板（微信常用集，Unicode 免资产）——评论框/私信框共用。
 * 用法：<EmojiPicker :text="draft" @update:text="v => draft = v" />——
 * 按钮放发送键左侧；面板 position:fixed 按按钮实时 rect 定位（teleport 到 body），
 * 不受祖先 overflow 裁剪 / transform 包含块影响（home-track 陷阱同源）。
 * 插入在 textarea/input 光标处（picker 自己在同行内找输入元素），插入后焦点+光标归位。
 * 点选不收面板（可连选），点面板外/再点按钮收起。 -->
<script setup>
import { ref, nextTick, onMounted, onBeforeUnmount } from "vue";
import { t } from "../i18n.js";

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
const pos = ref({ left: "8px", bottom: "200px" });

function toggle() {
  if (open.value) { open.value = false; return; }
  const r = root.value.getBoundingClientRect();
  const bottom = Math.max(8, window.innerHeight - r.top + 8) + "px";
  if (window.innerWidth < 640) {
    /* 轮 165：手机端贴底全宽（微信式），不再按按钮位置浮在半空挡内容 */
    pos.value = { left: "8px", right: "8px", width: "auto", bottom };
  } else {
    const left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - 304));
    pos.value = { left: left + "px", bottom };
  }
  open.value = true;
}

function pick(e) {
  /* 输入元素 = 按钮所在输入行里的第一个 textarea/input（每行只有一个） */
  const el = root.value ? root.value.parentElement.querySelector("textarea, input") : null;
  const base = String(props.text || "");
  let out, caret;
  if (el && typeof el.selectionStart === "number") {
    const s = el.selectionStart;
    const en = el.selectionEnd == null ? s : el.selectionEnd;
    out = base.slice(0, s) + e + base.slice(en);
    caret = s + e.length;
  } else {
    out = base + e;
    caret = out.length;
  }
  emit("update:text", out);
  nextTick(() => {
    if (!el) return;
    try { el.focus(); el.setSelectionRange(caret, caret); } catch (err) { /* 部分环境不支持 */ }
  });
}

function onDoc(e) {
  if (open.value && root.value && !root.value.contains(e.target)) open.value = false;
}
onMounted(() => document.addEventListener("pointerdown", onDoc));
onBeforeUnmount(() => document.removeEventListener("pointerdown", onDoc));
</script>

<template>
  <div ref="root" class="emo-root">
    <button type="button" class="emo-btn" :class="{ on: open }" :aria-label="t('emoji.title')" @click="toggle">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9.3" fill="none" stroke="currentColor" stroke-width="1.7" />
        <circle cx="8.7" cy="9.9" r="1.3" fill="currentColor" />
        <circle cx="15.3" cy="9.9" r="1.3" fill="currentColor" />
        <path d="M7.8 14c1.1 1.7 2.6 2.6 4.2 2.6s3.1-.9 4.2-2.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
      </svg>
    </button>
    <teleport to="body">
      <transition name="emo-pop">
        <div v-if="open" class="emo-panel" :style="pos" @pointerdown.stop>
          <button v-for="e in EMOJIS" :key="e" type="button" class="emo-cell" @click="pick(e)">{{ e }}</button>
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
</style>
