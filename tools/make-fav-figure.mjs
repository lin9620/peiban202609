/* 生成「收藏按钮修复前/后」对照图（headless 渲染的两张 harness 截图拼一起） */
import sharp from "sharp";

const W = 786;            // 每格宽度（harness 已是 2x）
const G = 24;
const TOP = 56;

const a = await sharp(".probe10/before.png").toBuffer();
const b = await sharp(".probe10/after2.png").toBuffer();
const meta = await sharp(a).metadata();

const left = 18;
const right = left + W + G;
const totalW = left * 2 + W * 2 + G;
const totalH = TOP + meta.height + 20;

const svg = `<svg width="${totalW}" height="${totalH}" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="#efeae3"/>
  <text x="${left}" y="36" font-family="Microsoft YaHei, sans-serif" font-size="21" fill="#3a2e2a">修复前：点完「收藏」，按钮整颗看不见</text>
  <text x="${right}" y="36" font-family="Microsoft YaHei, sans-serif" font-size="21" fill="#3a2e2a">修复后：实心深棕 + 白字，正常显示</text>
</svg>`;

await sharp(Buffer.from(svg))
  .composite([
    { input: a, left, top: TOP },
    { input: b, left: right, top: TOP },
  ])
  .png()
  .toFile(".probe10/compare.png");

console.log("compare.png", totalW, totalH);
