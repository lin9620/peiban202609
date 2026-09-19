// 临时脚本（跑完可删）：T4 品牌图标生成
// 从矢量 SVG（复刻 favicon 的桃色渐变 + 暖橙爪印）光栅化，避免 180px 源图放大发糊。
// 产物：public/icons/icon-512.png / icon-192.png / icon-maskable-512.png
import sharp from "sharp";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

mkdirSync(new URL("../public/icons", import.meta.url), { recursive: true });

/* 爪印几何（对照 apple-touch-icon 180px 原图目测拟合）：
   中趾对（相切、微外倾）+ 左右趾（更低、外倾）+ 大掌（下中） */
const paw = (scale = 1) =>
  scale === 1
    ? `<g fill="#f58c50">
    <ellipse cx="222" cy="150" rx="50" ry="62" transform="rotate(-12 222 150)"/>
    <ellipse cx="290" cy="150" rx="50" ry="62" transform="rotate(12 290 150)"/>
    <ellipse cx="118" cy="212" rx="46" ry="58" transform="rotate(-26 118 212)"/>
    <ellipse cx="394" cy="212" rx="46" ry="58" transform="rotate(26 394 212)"/>
    <ellipse cx="256" cy="342" rx="112" ry="94"/>
  </g>`
    : `<g fill="#f58c50" transform="translate(256 256) scale(${scale}) translate(-256 -256)">
    <ellipse cx="222" cy="150" rx="50" ry="62" transform="rotate(-12 222 150)"/>
    <ellipse cx="290" cy="150" rx="50" ry="62" transform="rotate(12 290 150)"/>
    <ellipse cx="118" cy="212" rx="46" ry="58" transform="rotate(-26 118 212)"/>
    <ellipse cx="394" cy="212" rx="46" ry="58" transform="rotate(26 394 212)"/>
    <ellipse cx="256" cy="342" rx="112" ry="94"/>
  </g>`;

const svg = (inner) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fff0e2"/>
      <stop offset="1" stop-color="#ffd9c4"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" fill="url(#bg)"/>
  ${inner}
</svg>`;

const jobs = [
  ["icon-512.png", svg(paw(1)), 512],
  ["icon-192.png", svg(paw(1)), 192],
  /* maskable：安全区只有 80% 圆内，爪印缩到 72% 居中，背景满幅 */
  ["icon-maskable-512.png", svg(paw(0.72)), 512],
];

for (const [name, body, size] of jobs) {
  const out = fileURLToPath(new URL(`../public/icons/${name}`, import.meta.url));
  const info = await sharp(Buffer.from(body)).resize(size, size).png().toFile(out);
  console.log(`OK ${name}  ${info.width}x${info.height}  ${info.size}B`);
}
console.log("DONE");
