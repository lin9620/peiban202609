/* 图片处理（批次 1 · P1）
 * ------------------------------------------------------------
 * 上半部分：纯函数（尺寸/比例/体积/dataURL 校验），Node 可单测（tools/image-fit.mjs）；
 * 下半部分：浏览器专用压缩管线（依赖 canvas，单测不覆盖）。
 *
 * 背景：超大或「极窄长条」图片会在浏览器 Canvas 解码时占满内存，
 * 且旧逻辑只按宽度缩放（1×10000 的图缩完仍是 1×90）。这里统一收口：
 *  - 文件体积 ≤ 5 MB、类型必须是 image/*
 *  - 解码后宽高比 ≤ 12、总像素 ≤ 3000 万
 *  - 最长边压到 900px（只缩不放）
 *  - 产出的 dataURL 必须通过 isUsableDataUrl（拦 "data:," 空产物）
 */

export const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_EDGE = 900;    // 压缩后最长边
export const MAX_PET_EDGE = 480; // 自定义立绘最长边（要存进 localStorage，必须更小）
export const MAX_RATIO = 12;    // 宽高比上限
export const MAX_PIXELS = 30e6; // 解码总像素上限（约 30 MP）

/** 按最长边等比缩放（只缩不放）；尺寸非法返回 null */
export function fitSize(w, h, maxEdge = MAX_EDGE) {
  w = Math.floor(Number(w));
  h = Math.floor(Number(h));
  if (!(w > 0) || !(h > 0)) return null;
  const k = Math.min(1, maxEdge / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

/** 解码后的像素体检：宽高比 + 总像素，任一超限都算不健康 */
export function isSaneShape(w, h, maxRatio = MAX_RATIO, maxPixels = MAX_PIXELS) {
  w = Math.floor(Number(w));
  h = Math.floor(Number(h));
  if (!(w > 0) || !(h > 0)) return false;
  const ratio = Math.max(w, h) / Math.min(w, h);
  return ratio <= maxRatio && w * h <= maxPixels;
}

/** 文件预检（解码前）：类型 + 体积。reason: empty | not-image | too-large */
export function validateImageFile(file) {
  if (!file) return { ok: false, reason: "empty" };
  if (!/^image\//.test(file.type || "")) return { ok: false, reason: "not-image" };
  if (file.size > MAX_FILE_BYTES) return { ok: false, reason: "too-large" };
  return { ok: true, reason: "" };
}

/** dataURL 可用性：拦 "data:,"、空串与非图片类型（Canvas 偶发的空产物） */
const DATA_URL_RE = /^data:image\/(?:png|jpe?g|webp);base64,[A-Za-z0-9+\/=]+$/;
export function isUsableDataUrl(s) {
  return typeof s === "string" && DATA_URL_RE.test(s) && s.length > 128;
}

/* —— 以下为浏览器专用管线 —— */

/**
 * 把已解码的 img 按上限压缩成 dataURL
 * @param {HTMLImageElement} img 已解码图片
 * @param {number} quality jpeg/webp 质量（png 忽略该参数）
 * @param {string} mime 输出格式：社区帖用 jpeg，自定义立绘用 png（保透明底）
 * @param {number} maxEdge 最长边上限（社区 900 / 立绘 480）
 */
export function shrinkToDataUrl(img, quality = 0.78, mime = "image/jpeg", maxEdge = MAX_EDGE) {
  const size = fitSize(img.naturalWidth, img.naturalHeight, maxEdge);
  if (!size) throw new Error("bad-size");
  const c = document.createElement("canvas");
  c.width = size.width;
  c.height = size.height;
  c.getContext("2d").drawImage(img, 0, 0, size.width, size.height);
  return c.toDataURL(mime, quality);
}
