/* 按压态验收图：未按 / 第一次按下 / 第三次按下 / 第三次返回后 */
import sharp from "sharp";
import fs from "node:fs";

const items = [
  ["crop-L0", "① 没按"],
  ["crop-P1", "② 第一次按下"],
  ["crop-P3", "③ 第三次按下"],
  ["crop-L3", "④ 第三次返回后（干净）"],
];
const W = 420, G = 14, pad = 18, top = 56;
const metas = [];
for (const [n] of items) metas.push(await sharp(`.probe6/${n}.png`).metadata());
const H = Math.max(...metas.map((m) => m.height));
const TOTAL_W = pad * 2 + W * items.length + G * (items.length - 1);

let texts = "";
items.forEach(([, t], i) => {
  texts += `<text x="${pad + i * (W + G)}" y="36" font-family="Microsoft YaHei, PingFang SC, sans-serif" font-size="19" fill="#3a2e2a">${t}</text>`;
});
const svg = `<svg width="${TOTAL_W}" height="${top + H + pad}" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="#f4f1ec"/>${texts}</svg>`;
const comp = items.map(([n], i) => ({ input: `.probe6/${n}.png`, left: pad + i * (W + G), top }));
const buf = await sharp(Buffer.from(svg)).composite(comp).png().toBuffer();
fs.writeFileSync("press-glass-422.png", buf);
const m = await sharp(buf).metadata();
console.log("按压态对比图", m.width, "×", m.height);
