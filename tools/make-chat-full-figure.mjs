/* 会话页「浮卡 → 铺满」对照图：左 = 421 的圆角玻璃卡，右 = 426 的整屏铺满 */
import sharp from "sharp";

const OLD = ".probe3/c1.png";
const NEW = ".probe10/chat-full.png";
const W = 430;
const G = 28;
const PAD = 18;
const TOP = 52;

const a = await sharp(OLD).resize({ width: W }).toBuffer();
const b = await sharp(NEW).resize({ width: W }).toBuffer();
const ha = (await sharp(a).metadata()).height;
const hb = (await sharp(b).metadata()).height;
const H = Math.max(ha, hb);

const totalW = PAD * 2 + W * 2 + G;
const totalH = TOP + H + PAD;

const svg = `<svg width="${totalW}" height="${totalH}" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="#efeae3"/>
  <text x="${PAD}" y="34" font-family="Microsoft YaHei, sans-serif" font-size="20" fill="#8b6a58">改前：浮起来的圆角玻璃卡（左右留边）</text>
  <text x="${PAD + W + G}" y="34" font-family="Microsoft YaHei, sans-serif" font-size="20" fill="#3a2e2a">改后：整页铺满（以前的样子）</text>
</svg>`;

await sharp(Buffer.from(svg))
  .composite([
    { input: a, left: PAD, top: TOP },
    { input: b, left: PAD + W + G, top: TOP },
  ])
  .png()
  .toFile("chat-full-426.png");

console.log("chat-full-426.png", totalW, totalH);
