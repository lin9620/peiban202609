/* App 图标生成器（轮 101，参照 make-og.mjs 的自包含模式）
 * ------------------------------------------------------------
 * 从设计源图（tools/icon-src.png：白底圆角方块上的蓝爪+粉心）提取图标，
 * 生成 Android 全套启动图标：
 *   · 传统 ic_launcher.png（48/72/96/144/192，白底压平）
 *   · ic_launcher_round.png（同尺寸圆形裁切）
 *   · 自适应前景 ic_launcher_foreground.png（108dp 全幅透明画布 + 图标居中 66% 安全区）
 * 圆角方块四角透明（rounded-rect 蒙版 rx=18%），传统方形图标压平到白底。
 * 背景色同步 values/ic_launcher_background.xml → #FFF7EE（暖米色，与 App 主题一致）。
 * 用法：node tools/make-app-icon.mjs
 * 源图更换后重跑即可（裁切参数按 298×270 源图标定，换源图先目检 _crop-check.png）。
 */
import sharp from "sharp";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "tools", "icon-src.png");
const res = path.join(root, "android", "app", "src", "main", "res");

/* 裁切参数（目检校准）：白底圆角方块本体，四角经蒙版透明 */
const CROP = { left: 61, top: 46, size: 176 };
const roundedRectSvg = (s) =>
  Buffer.from(`<svg width="${s}" height="${s}"><rect x="0" y="0" width="${s}" height="${s}" rx="${Math.round(s * 0.18)}" fill="#fff"/></svg>`);
const circleSvg = (s) =>
  Buffer.from(`<svg width="${s}" height="${s}"><circle cx="${s / 2}" cy="${s / 2}" r="${s / 2}" fill="#fff"/></svg>`);

const master = path.join(root, "tools", "icon-master.png");
/* 注意：sharp 的 composite 在管线最后（resize 之后）才执行 —— 蒙版必须按「resize 之后
 * 的尺寸」生成，否则居中的小蒙版会把放大图裁成中间一小块（轮 101 第一次生成的翻车点）。 */
await sharp(src).extract({ ...CROP, width: CROP.size, height: CROP.size })
  .resize(512, 512)
  .composite([{ input: roundedRectSvg(512), blend: "dest-in" }])
  .png().toFile(master);

const DENSITIES = [
  ["mipmap-mdpi", 48, 108],
  ["mipmap-hdpi", 72, 162],
  ["mipmap-xhdpi", 96, 216],
  ["mipmap-xxhdpi", 144, 324],
  ["mipmap-xxxhdpi", 192, 432],
];
for (const [dir, launcher, fgCanvas] of DENSITIES) {
  const d = path.join(res, dir);
  await sharp(master).resize(launcher, launcher).flatten({ background: "#ffffff" })
    .png().toFile(path.join(d, "ic_launcher.png"));
  await sharp(master).resize(launcher, launcher)
    .composite([{ input: circleSvg(launcher), blend: "dest-in" }])
    .png().toFile(path.join(d, "ic_launcher_round.png"));
  const inner = Math.round(fgCanvas * 0.66);
  await sharp({ create: { width: fgCanvas, height: fgCanvas, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: await sharp(master).resize(inner, inner).png().toBuffer(), gravity: "center" }])
    .png().toFile(path.join(d, "ic_launcher_foreground.png"));
  console.log(`  ${dir}: launcher ${launcher}px / round / foreground ${fgCanvas}px`);
}
console.log("APP ICON DONE");
