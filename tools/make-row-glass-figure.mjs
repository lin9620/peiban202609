/* 三张对比图拼一张：点之前 / 第一次返回 / 第三次返回（轮 422 验收图） */
import sharp from "sharp";
import fs from "node:fs";

const imgs = ["crop-V0", "crop-V1", "crop-V3"];
const labels = ["① 点之前：没有任何高亮", "② 第一次进会话再返回", "③ 第三次进会话再返回"];
const W = 420, G = 14, pad = 18, top = 56;

const metas = [];
for (const n of imgs) metas.push(await sharp(`.probe5/${n}.png`).metadata());
const H = Math.max(...metas.map((m) => m.height));
const TOTAL_W = pad * 2 + W * 3 + G * 2;

let texts = "";
labels.forEach((t, i) => {
  texts += `<text x="${pad + i * (W + G)}" y="36" font-family="Microsoft YaHei, PingFang SC, sans-serif" font-size="19" fill="#3a2e2a">${t}</text>`;
});
const svg = `<svg width="${TOTAL_W}" height="${top + H + pad}" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="#f4f1ec"/>${texts}</svg>`;

const comp = imgs.map((n, i) => ({ input: `.probe5/${n}.png`, left: pad + i * (W + G), top }));
const buf = await sharp(Buffer.from(svg)).composite(comp).png().toBuffer();
fs.writeFileSync(".probe5/row-glass-3up.png", buf);
const m = await sharp(buf).metadata();
console.log("对比图", m.width, "×", m.height);
