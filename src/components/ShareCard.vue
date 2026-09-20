<script setup>
import { ref, onMounted } from "vue";
import { Capacitor, registerPlugin } from "@capacitor/core";
import { t, i18n } from "../i18n.js";
import { SPECIES } from "../data/pets.js";

const props = defineProps({
  quote: { type: String, default: "" },
  pet: { type: Object, default: null },
});
const emit = defineEmits(["close"]);

const cardBox = ref(null);
const done = ref(false);
const W = 800, H = 1000;

const speciesMeta = SPECIES.find(
  (x) => x.key === (props.pet && props.pet.species)
);
const petEmoji = speciesMeta ? speciesMeta.emoji : "\u{1F431}";
const petName = props.pet ? props.pet.name : "";

function wrapText(c, text, x, y, maxW, lineH) {
  // 英文按词换行，中文按字符换行
  if (!text) return y;
  const isCJK = /[\u4e00-\u9fff]/.test(text);
  const words = isCJK ? text.split("") : text.split(" ");
  let line = "", yy = y;
  for (const w of words) {
    const test = isCJK ? line + w : line + w + " ";
    if (c.measureText(test).width > maxW && line) {
      c.fillText(line.trim(), x, yy);
      line = isCJK ? w : w + " ";
      yy += lineH;
    } else {
      line = test;
    }
  }
  if (line.trim()) c.fillText(line.trim(), x, yy);
  return yy;
}

function drawFooter(c) {
  c.fillStyle = "#9b8271";
  c.font = "600 26px 'Segoe UI', 'PingFang SC', sans-serif";
  c.fillText("Warm Paws \u{1F43E}", W / 2, H - 90);
  c.font = "400 20px 'Segoe UI', 'PingFang SC', sans-serif";
  c.fillText(
    new Date().toLocaleDateString(i18n.locale === "zh" ? "zh-CN" : "en-US",
      { year: "numeric", month: "long", day: "numeric" }),
    W / 2, H - 54
  );
}

function drawPetName(c, y) {
  if (!petName) return;
  c.fillStyle = "#8a7460";
  c.font = "700 30px 'Segoe UI', 'PingFang SC', sans-serif";
  c.fillText(petName, W / 2, y);
}

function drawEmojiPet(c, endY) {
  c.font = "190px 'Segoe UI Emoji', 'Apple Color Emoji', sans-serif";
  c.fillText(petEmoji, W / 2, endY + 250);
  drawPetName(c, endY + 320);
  drawFooter(c);
}

function draw() {
  const c = cardBox.value.getContext("2d");
  const g = c.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#fff3e4"); g.addColorStop(1, "#ffdcb8");
  c.fillStyle = g; c.fillRect(0, 0, W, H);

  // 爪印装饰
  c.font = "44px serif"; c.globalAlpha = 0.18;
  for (const [x, y, r] of [[90, 120, -0.4], [700, 210, 0.3], [120, 830, 0.25], [690, 890, -0.3]]) {
    c.save(); c.translate(x, y); c.rotate(r); c.fillText("\u{1F43E}", 0, 0); c.restore();
  }
  c.globalAlpha = 1;

  // 语录
  c.fillStyle = "#5b4636";
  c.font = "italic 700 40px 'Segoe UI', 'PingFang SC', sans-serif";
  c.textAlign = "center";
  const endY = wrapText(c, props.quote, W / 2, 220, W - 140, 58);

  // 当前宠物（自定义立绘优先，否则用 species emoji）
  const customImg = props.pet && props.pet.custom && props.pet.custom.img;
  if (customImg) {
    const img = new Image();
    /* Storage 公网图必须带 CORS 再画，否则画布被「污染」，导出时 toDataURL/toBlob 直接抛错 */
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const maxW = 320, maxH = 280;
      const scale = Math.min(maxW / img.width, maxH / img.height, 1);
      const w = img.width * scale, h = img.height * scale;
      c.drawImage(img, W / 2 - w / 2, endY + 70 + (maxH - h) / 2, w, h);
      drawPetName(c, endY + 70 + maxH + 46);
      drawFooter(c);
    };
    img.onerror = () => drawEmojiPet(c, endY);
    img.src = customImg;
  } else {
    drawEmojiPet(c, endY);
  }
}

onMounted(() => {
  try { draw(); } catch (e) { console.error("[Warm Paws] 分享卡片绘制失败：", e); }
});

/* 导出画布 → App 内走原生分享面板 / 网页走系统分享或下载。
 * 为什么不能只靠 <a download>：Capacitor 的安卓 WebView 没有配置 DownloadListener，
 * 点了下载按钮什么都不会发生（用户实测「生成分享图片功能没有用」）。
 * App 里走 WpShare 原生插件（MainActivity 注册）调系统分享面板，
 * 用户选「保存到相册 / 微信 / QQ」都行；旧版 APK 没有该插件时再退回网页兜底。 */
const WpShare = registerPlugin("WpShare");
const busy = ref(false);
const errMsg = ref("");

function canvasBlob() {
  return new Promise((resolve, reject) => {
    try { cardBox.value.toBlob((b) => (b ? resolve(b) : reject(new Error("blob-empty"))), "image/png"); }
    catch (e) { reject(e); }
  });
}

async function shareSave() {
  if (busy.value) return;
  busy.value = true;
  errMsg.value = "";
  try {
    const blob = await canvasBlob();
    /* App 内：原生分享面板（可存相册 / 发聊天软件）；安卓 WebView 不认 <a download> */
    if (Capacitor.isNativePlatform()) {
      try {
        await WpShare.shareImage({ data: cardBox.value.toDataURL("image/png"), fileName: "warm-paws-card.png" });
        done.value = true;
        busy.value = false;
        setTimeout(() => { done.value = false; }, 2600);
        return;
      } catch (e) { /* 旧 APK 没装这个插件 → 落到下面的网页兜底 */ }
    }
    const file = new File([blob], "warm-paws-card.png", { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: t("home.share"), text: props.quote });
      done.value = true;
    } else {
      /* 桌面浏览器：走传统下载 */
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "warm-paws-card.png";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      done.value = true;
    }
  } catch (e) {
    /* 用户在分享面板点了取消（AbortError）不算失败 */
    if (!(e && e.name === "AbortError")) errMsg.value = t("home.shareFail");
  } finally {
    busy.value = false;
    setTimeout(() => { done.value = false; errMsg.value = ""; }, 3000);
  }
}
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal" style="width: min(92vw, 460px)">
      <h3>{{ t("home.share") }}</h3>
      <div class="share-canvas-box">
        <canvas ref="cardBox" :width="W" :height="H" style="width: 100%" />
      </div>
      <div class="modal-row" style="margin-top: 16px">
        <button class="modal-btn ghost" @click="emit('close')">{{ t("common.close") }}</button>
        <button class="modal-btn" :disabled="busy" @click="shareSave">
          {{ busy ? t("home.saving") : done ? t("home.shared") : t("home.saveShare") }}
        </button>
      </div>
      <p v-if="errMsg" class="notice" style="margin-top: 10px">{{ errMsg }}</p>
    </div>
  </div>
</template>

<style>
.modal-mask {
  position: fixed; inset: 0; z-index: 2000;
  background: rgba(60, 40, 20, .4);
  display: flex; align-items: center; justify-content: center;
}
.modal {
  background: #fff; border-radius: 22px; padding: 22px;
  width: min(92vw, 560px); max-height: 90vh; overflow: auto;
  text-align: center; box-shadow: 0 20px 60px rgba(0, 0, 0, .25);
}
.modal h3 { font-size: 17px; margin-bottom: 12px; }
.modal-row { display: flex; gap: 12px; justify-content: center; }
.modal-btn {
  border: none; background: var(--accent); color: #fff;
  font-weight: 700; font-size: 14px; padding: 10px 26px;
  border-radius: 999px; cursor: pointer;
}
.modal-btn.ghost { background: #eee3d4; color: #8a7460; }
</style>