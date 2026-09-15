/* 生成社交分享图与站点图标（纯 Node，零第三方依赖）
 * 用法：node tools/make-og.mjs
 * 产出到 public/：og-image.png (1200x630) · favicon.png (192) · apple-touch-icon.png (180)
 * 背景：项目视觉全部由 CSS / Lottie 运行时生成，没有任何位图素材，
 *       所以这里手写 PNG 编码器（zlib 内置）+ 极简绘图原语画出品牌图。
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "public");
fs.mkdirSync(outDir, { recursive: true });

/* ══════════ 最小 PNG 编码器（8 位 RGBA） ══════════ */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(w, h, rgba) {
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
/* ══════════ 绘图原语 ══════════ */
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

class Canvas {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.px = Buffer.alloc(w * h * 4); // 全透明起点
  }
  /* alpha 混合写入单像素 */
  blend(x, y, c, a) {
    if (a <= 0 || x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    const sa = a > 1 ? 1 : a;
    const da = this.px[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa <= 0) return;
    this.px[i] = Math.round((c[0] * sa + this.px[i] * da * (1 - sa)) / oa);
    this.px[i + 1] = Math.round((c[1] * sa + this.px[i + 1] * da * (1 - sa)) / oa);
    this.px[i + 2] = Math.round((c[2] * sa + this.px[i + 2] * da * (1 - sa)) / oa);
    this.px[i + 3] = Math.round(oa * 255);
  }
  /* 竖直渐变铺底 */
  verticalGradient(top, bottom) {
    for (let y = 0; y < this.h; y++) {
      const t = this.h > 1 ? y / (this.h - 1) : 0;
      const c = [
        Math.round(top[0] + (bottom[0] - top[0]) * t),
        Math.round(top[1] + (bottom[1] - top[1]) * t),
        Math.round(top[2] + (bottom[2] - top[2]) * t),
      ];
      for (let x = 0; x < this.w; x++) this.blend(x, y, c, 1);
    }
  }
  rect(x, y, w, h, c, a = 1) {
    for (let j = Math.round(y); j < Math.round(y + h); j++)
      for (let i = Math.round(x); i < Math.round(x + w); i++) this.blend(i, j, c, a);
  }
  /* 椭圆：边缘按像素距离羽化 1.5px（抗锯齿） */
  ellipse(cx, cy, rx, ry, c, a = 1) {
    const minR = Math.min(rx, ry);
    for (let y = Math.floor(cy - ry - 2); y <= Math.ceil(cy + ry + 2); y++) {
      for (let x = Math.floor(cx - rx - 2); x <= Math.ceil(cx + rx + 2); x++) {
        const dx = (x + 0.5 - cx) / rx;
        const dy = (y + 0.5 - cy) / ry;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d >= 1) continue;
        this.blend(x, y, c, a * clamp01(((1 - d) * minR) / 1.5));
      }
    }
  }
  /* 柔光光斑：中心亮、边缘渐隐，用于背景氛围 */
  glow(cx, cy, r, c, a = 1) {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const d = Math.sqrt(dx * dx + dy * dy) / r;
        if (d >= 1) continue;
        const k = 1 - d;
        this.blend(x, y, c, a * k * k);
      }
    }
  }
  /* 爪印：1 个掌垫 + 4 个脚趾 */
  paw(cx, cy, s, c, a = 1) {
    this.ellipse(cx, cy, 105 * s, 88 * s, c, a);
    const toes = [
      [-132, -138, 46, 54],
      [-38, -182, 46, 54],
      [38, -182, 46, 54],
      [132, -138, 46, 54],
    ];
    for (const [dx, dy, rx, ry] of toes) this.ellipse(cx + dx * s, cy + dy * s, rx * s, ry * s, c, a);
  }
  save(file) {
    fs.writeFileSync(path.join(outDir, file), encodePNG(this.w, this.h, this.px));
    return file;
  }
}

/* ══════════ 5x7 像素字体（只登记品牌用得到的字母） ══════════ */
const FONT = {
  W: ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
};
const textWidth = (text, scale) => (text.length * 6 - 1) * scale;
function pixelText(cv, text, x, y, scale, c, a = 1) {
  let cx = x;
  for (const ch of text.toUpperCase()) {
    const g = FONT[ch];
    if (g) {
      for (let ry = 0; ry < g.length; ry++) {
        for (let rx = 0; rx < g[ry].length; rx++) {
          if (g[ry][rx] === "1") cv.rect(cx + rx * scale, y + ry * scale, scale, scale, c, a);
        }
      }
    }
    cx += 6 * scale;
  }
}
/* ===== 配色（与 style.css 品牌色一致） ===== */
const CREAM = [255, 247, 238];
const PEACH = [255, 224, 196];
const ACCENT = [255, 159, 90];
const DEEP = [240, 132, 47];
const LILAC = [183, 166, 232];
const SKY = [158, 208, 245];

const made = [];

/* ① 社交分享大图 1200x630 */
{
  const cv = new Canvas(1200, 630);
  cv.verticalGradient(CREAM, PEACH);
  cv.glow(1080, 620, 420, ACCENT, 0.3);
  cv.glow(90, 60, 340, LILAC, 0.16);
  cv.glow(1150, 90, 300, SKY, 0.18);
  cv.paw(600, 258, 0.82, ACCENT, 1);
  const s = 14;
  pixelText(cv, "WARM PAWS", (1200 - textWidth("WARM PAWS", s)) / 2, 428, s, DEEP, 1);
  made.push(cv.save("og-image.png"));
}

/* ② 图标：爪印居中（favicon / apple-touch-icon 同款构图）
 *    爪印外接尺寸：宽 356s / 高 324s（相对缩放 s），留 11% 边距并做垂直居中 */
function icon(size, file) {
  const cv = new Canvas(size, size);
  cv.verticalGradient(CREAM, PEACH);
  cv.glow(size * 0.85, size * 0.9, size * 0.7, ACCENT, 0.28);
  const s = (size * 0.78) / 356;
  cv.paw(size / 2, size / 2 + 74 * s, s, ACCENT, 1);
  made.push(cv.save(file));
}
icon(192, "favicon.png");
icon(180, "apple-touch-icon.png");

for (const f of made) {
  console.log("OK  " + f + "  " + fs.statSync(path.join(outDir, f)).size + " bytes");
}
console.log("MAKE_OG_DONE " + made.length);
