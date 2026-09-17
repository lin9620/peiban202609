<script setup>
import { ref, onMounted, computed } from "vue";
import { t } from "../i18n.js";
import { addDish } from "../stores/petStore.js";

const emit = defineEmits(["saved"]);

const W = 640, H = 480;
const canvas = ref(null);
const ctx = ref(null);

const tool = ref("brush");           // brush | eraser
const color = ref("#5b4636");
const template = ref("free");
const name = ref("");
const strokes = ref(0);              // 笔画数
const colorsUsed = ref(new Set());   // 用过的颜色
const lengthPx = ref(0);             // 笔画总长
const undoStack = ref([]);
const savedMsg = ref(false);

const COLORS = ["#5b4636", "#e2873d", "#f6a55c", "#ef7d6a", "#e56ba0", "#7f9df5", "#7fc86e", "#8a6a4a"];

/* 样品线稿：淡色虚线，供描摹 */
const TEMPLATES = {
  free: null,
  kibble: (c) => {   // 猫粮碗
    c.beginPath(); c.arc(320, 300, 170, 0, Math.PI, false); c.stroke();
    c.beginPath(); c.ellipse(320, 300, 170, 46, 0, 0, Math.PI * 2); c.stroke();
    c.beginPath(); c.ellipse(320, 300, 110, 30, 0, 0, Math.PI * 2); c.stroke();
    for (const [x, y] of [[260, 282], [320, 270], [380, 282], [290, 292], [350, 292]]) {
      c.beginPath(); c.arc(x, y, 16, 0, Math.PI * 2); c.stroke();
    }
  },
  fish: (c) => {     // 小鱼干
    c.beginPath(); c.ellipse(280, 260, 120, 70, -0.2, 0, Math.PI * 2); c.stroke();
    c.beginPath(); c.moveTo(392, 230); c.lineTo(450, 180); c.lineTo(455, 260); c.lineTo(392, 290);
    c.closePath(); c.stroke();
    c.beginPath(); c.arc(230, 245, 8, 0, Math.PI * 2); c.stroke();
    c.beginPath(); c.moveTo(250, 205); c.quadraticCurveTo(280, 240, 250, 250); c.stroke();
    c.beginPath(); c.moveTo(300, 200); c.quadraticCurveTo(330, 240, 300, 258); c.stroke();
  },
  can: (c) => {      // 罐头
    c.strokeRect(210, 170, 220, 200);
    c.beginPath(); c.ellipse(320, 170, 110, 32, 0, 0, Math.PI * 2); c.stroke();
    c.beginPath(); c.moveTo(210, 240); c.lineTo(430, 240); c.stroke();
    c.beginPath(); c.moveTo(255, 285); c.quadraticCurveTo(320, 320, 385, 285); c.stroke();
  },
  pudding: (c) => {  // 布丁
    c.beginPath(); c.moveTo(200, 250); c.quadraticCurveTo(320, 180, 440, 250);
    c.quadraticCurveTo(430, 380, 320, 385); c.quadraticCurveTo(210, 380, 200, 250);
    c.closePath(); c.stroke();
    c.beginPath(); c.ellipse(320, 250, 120, 30, 0, 0, Math.PI * 2); c.stroke();
    c.beginPath(); c.arc(320, 190, 26, 0, Math.PI * 2); c.stroke();
  },
  cookie: (c) => {   // 爱心饼干
    c.beginPath();
    c.moveTo(320, 400);
    c.bezierCurveTo(140, 260, 220, 120, 320, 210);
    c.bezierCurveTo(420, 120, 500, 260, 320, 400);
    c.closePath(); c.stroke();
    c.beginPath(); c.arc(285, 230, 12, 0, Math.PI * 2); c.stroke();
    c.beginPath(); c.arc(355, 230, 12, 0, Math.PI * 2); c.stroke();
    c.beginPath(); c.moveTo(300, 285); c.quadraticCurveTo(320, 305, 340, 285); c.stroke();
  },
};

function drawTemplate() {
  const c = ctx.value;
  if (!c) return;
  c.save();
  c.setLineDash([10, 10]);
  c.strokeStyle = "rgba(150,120,90,.35)";
  c.lineWidth = 3;
  const fn = TEMPLATES[template.value];
  if (fn) fn(c);
  c.restore();
}

function clearCanvas(keepTemplate = true) {
  const c = ctx.value;
  c.fillStyle = "#ffffff";
  c.fillRect(0, 0, W, H);
  if (keepTemplate) drawTemplate();
}

function pushUndo() {
  undoStack.value.push(canvas.value.toDataURL());
  if (undoStack.value.length > 20) undoStack.value.shift();
}

function undo() {
  const data = undoStack.value.pop();
  if (!data) return;
  const img = new Image();
  img.onload = () => {
    clearCanvas(false);
    ctx.value.drawImage(img, 0, 0);
  };
  img.src = data;
}

function selectTemplate(k) {
  template.value = k;
  clearCanvas();
}

function pos(e) {
  const r = canvas.value.getBoundingClientRect();
  return { x: (e.clientX - r.left) * (W / r.width), y: (e.clientY - r.top) * (H / r.height) };
}

let drawing = false, last = null;

function down(e) {
  drawing = true;
  pushUndo();
  strokes.value++;
  last = pos(e);
  move(e);
}
function move(e) {
  if (!drawing) return;
  const c = ctx.value;
  const p = pos(e);
  lengthPx.value += Math.hypot(p.x - last.x, p.y - last.y);
  c.lineCap = "round"; c.lineJoin = "round";
  if (tool.value === "eraser") {
    c.globalCompositeOperation = "destination-out";
    c.lineWidth = 26; c.strokeStyle = "rgba(0,0,0,1)";
  } else {
    c.globalCompositeOperation = "source-over";
    c.lineWidth = 7; c.strokeStyle = color.value;
    colorsUsed.value.add(color.value);
  }
  c.beginPath(); c.moveTo(last.x, last.y); c.lineTo(p.x, p.y); c.stroke();
  last = p;
}
function up() { drawing = false; }

/* 用心度：笔画 + 颜色 + 长度 → 0~100 */
const effort = computed(() => {
  const s = Math.min(40, strokes.value * 3);
  const col = colorsUsed.value.size * 6;
  const len = Math.min(30, lengthPx.value / 400);
  return Math.min(100, Math.round(s + col + len));
});

function save() {
  // 压缩成 320x240 JPEG 存储，保护 localStorage
  const small = document.createElement("canvas");
  small.width = 320; small.height = 240;
  small.getContext("2d").drawImage(canvas.value, 0, 0, 320, 240);
  const dish = {
    id: Date.now(),
    name: name.value.trim() || t("pet.painter.nameDefault"),
    img: small.toDataURL("image/jpeg", 0.72),
    effort: effort.value,
    createdAt: Date.now(),
  };
  addDish(dish);
  savedMsg.value = true;
  setTimeout(() => { savedMsg.value = false; }, 2200);
  name.value = "";
  /* #1 存入食谱后从画板消失：清空画布 + 重置笔画统计（下一幅从头画） */
  strokes.value = 0;
  colorsUsed.value = new Set();
  lengthPx.value = 0;
  undoStack.value = [];
  clearCanvas();
  emit("saved", dish);
}

onMounted(() => {
  ctx.value = canvas.value.getContext("2d");
  clearCanvas();
});
</script>

<template>
  <div>
    <div class="painter-bar">
      <button class="tool" :class="{ on: tool === 'brush' }" @click="tool = 'brush'">
        {{ t('pet.painter.brush') }}
      </button>
      <button class="tool" :class="{ on: tool === 'eraser' }" @click="tool = 'eraser'">
        {{ t('pet.painter.eraser') }}
      </button>
      <span
        v-for="c in COLORS" :key="c"
        class="swatch" :class="{ on: color === c && tool === 'brush' }"
        :style="{ background: c }" @click="color = c; tool = 'brush'" />
      <button class="tool" @click="undo">{{ t('pet.painter.undo') }}</button>
      <button class="tool" @click="clearCanvas()">{{ t('pet.painter.clear') }}</button>
    </div>

    <div class="painter-bar">
      <button
        v-for="k in ['free','kibble','fish','can','pudding','cookie']"
        :key="k" class="tpl-chip" :class="{ on: template === k }" @click="selectTemplate(k)">
        {{ k === 'free' ? '✨' : { kibble: '🥣', fish: '🐟', can: '🥫', pudding: '🍮', cookie: '🍪' }[k] }}
      </button>
    </div>

    <canvas
      ref="canvas" class="painter-canvas"
      :width="W" :height="H"
      @pointerdown.prevent="down" @pointermove.prevent="move"
      @pointerup="up" @pointerleave="up" />

    <div class="painter-bar" style="margin-top: 12px">
      <input
        v-model="name" class="input" style="flex: 1; min-width: 160px"
        :placeholder="t('pet.painter.name')" />
      <button class="btn small" @click="save">{{ t('pet.painter.save') }}</button>
    </div>

    <p class="streak-note">
      {{ t('pet.painter.effort', { n: effort }) }}
      <span v-if="savedMsg" style="color: var(--good); font-weight: 700">
        · {{ t('pet.painter.saved') }}
      </span>
    </p>
  </div>
</template>

