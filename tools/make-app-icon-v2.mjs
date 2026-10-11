/* ═══ App 图标生成器 v2.2（轮 238）——源 = 5 号「月夜·陪伴」═══
 * 教训固化（本轮两个翻车点）：
 *   ① pawLayer 的坐标已在 viewBox 空间，绝不能再乘 k（viewBox 映射还会缩一次 →
 *      双重缩放 = 爪印缩成米粒落在左上角，启动器上只剩背景层，用户实测）。
 *   ② 国产启动器对「图片背景」的自适应渲染各自放大/裁切 → 背景层用**纯色**，
 *      完整设计（星空+月+爪）整体放进**前景**并缩进 66% 安全区（×0.9），
 *      任何蒙版/放大下设计都完整，边缘与纯色背景同色融合。
 * 用法：node tools/make-app-icon-v2.mjs
 */
import sharp from "sharp";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const res = path.join(root, "android", "app", "src", "main", "res");
const previewDir = path.join(root, "_icon-concepts");

const S = 512;
const NAVY_EDGE = "#2C3550";

/* ── 设计层：星空 + 月亮 + 奶油爪（完整设计，flat navy 底）── */
function designLayer(size, zoom = 1, cx = 256, cy = 256) {
  const k = size / S;
  const orb = (x, y, r, color, op) =>
    `<circle cx="${x}" cy="${y}" r="${r}" fill="${color}" opacity="${op}"/>` +
    `<defs><filter id="o${r}${color.slice(1)}" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="${r * 0.24}"/></filter></defs>`;
  const star = (x, y, r, op) => `<circle cx="${x}" cy="${y}" r="${r}" fill="#FFF" opacity="${op}"/>`;
  const toe = (tx, ty, rx, ry, a) =>
    `<ellipse cx="${tx}" cy="${ty}" rx="${rx}" ry="${ry}" fill="#FFDFA0" transform="rotate(${a} ${tx} ${ty})"/>`;
  const CY = 229.5;   /* 爪印包围盒中心对齐组原点 */
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${S} ${S}">
    <rect width="${S}" height="${S}" fill="${NAVY_EDGE}"/>
    <g transform="translate(${cx} ${cy}) scale(${zoom}) translate(${-256} ${-256})">
      <rect width="${S}" height="${S}" fill="url(#bg)"/>
      ${orb(120, 110, 120, "#8FA0C7", .35)}${orb(430, 430, 130, "#F5C97E", .15)}
      ${star(104, 92, 4.5, .85)}${star(430, 196, 3.4, .6)}${star(88, 384, 3.4, .5)}${star(430, 344, 3.2, .5)}${star(196, 74, 2.8, .55)}${star(340, 330, 3.2, .5)}
      <!-- 轮 238：月亮 = 右上角装饰（允许被蒙版裁一点），爪印才是主角、正居中 -->
      <g transform="translate(420 92) scale(0.8) translate(-337 -104)">
        <path d="M340 120 A66 66 0 1 1 268 56 A52 52 0 1 0 340 120 Z" fill="#FFE9B8" opacity="0.92"/>
      </g>
      <g transform="translate(256 ${CY})">
        <ellipse cx="0" cy="78" rx="75" ry="63" fill="#FFE9B8"/>
        ${toe(-78, -17, 27, 36, -20)}${toe(-27, -49, 28, 39, -7)}${toe(27, -49, 28, 39, 7)}${toe(78, -17, 27, 36, 20)}
        <ellipse cx="0" cy="95" rx="26" ry="10" fill="#FFF" opacity=".38"/>
      </g>
    </g>
  </svg>`;
}
const DESIGN_DEFS = `<defs><radialGradient id="bg" cx="0.42" cy="0.36" r="0.78">
  <stop offset="0" stop-color="#46506E"/><stop offset="1" stop-color="#2C3550"/></radialGradient></defs>`;
/* 设计里的 bg 渐变定义要在每个 SVG 里都带（librsvg 按文档解析） */
function design(size, zoom, cx, cy) {
  const svg = designLayer(size, zoom, cx, cy);
  return svg.replace("<rect width=\"512\" height=\"512\" fill=\"" + NAVY_EDGE + "\"/>",
    DESIGN_DEFS + "<rect width=\"512\" height=\"512\" fill=\"" + NAVY_EDGE + "\"/>");
}

/* 传统全出血方图：设计铺满（启动器自蒙版） */
async function fullIcon(size) {
  return sharp(Buffer.from(design(size, 1, 256, 256))).png().toBuffer();
}

/* ── 密度表：[目录, 传统 launcher px, 自适应层画布 px] ── */
const DENSITIES = [
  ["mipmap-mdpi", 48, 108],
  ["mipmap-hdpi", 72, 162],
  ["mipmap-xhdpi", 96, 216],
  ["mipmap-xxhdpi", 144, 324],
  ["mipmap-xxxhdpi", 192, 432],
];

for (const [dir, launcher, fgCanvas] of DENSITIES) {
  const d = path.join(res, dir);
  /* 传统：全出血设计方图 */
  await sharp(await fullIcon(launcher)).png().toFile(path.join(d, "ic_launcher.png"));
  const circle = Buffer.from(`<svg width="${launcher}" height="${launcher}"><circle cx="${launcher / 2}" cy="${launcher / 2}" r="${launcher / 2}" fill="#fff"/></svg>`);
  await sharp(await fullIcon(launcher))
    .composite([{ input: circle, blend: "dest-in" }])
    .png().toFile(path.join(d, "ic_launcher_round.png"));
  /* 自适应背景：纯色深蓝（与设计边缘同色，OEM 放大也不穿帮） */
  await sharp({ create: { width: fgCanvas, height: fgCanvas, channels: 4, background: { r: 44, g: 53, b: 80, alpha: 1 } } })
    .png().toFile(path.join(d, "ic_launcher_background.png"));
  /* 自适应前景：完整设计缩进安全区（×0.9），OEM 怎么放大都完整 */
  const fgDesign = await sharp(Buffer.from(design(fgCanvas, 0.9))).png().toBuffer();
  await sharp({ create: { width: fgCanvas, height: fgCanvas, channels: 4, background: { r: 44, g: 53, b: 80, alpha: 1 } } })
    .composite([{ input: fgDesign, gravity: "center" }])
    .png().toFile(path.join(d, "ic_launcher_foreground.png"));
  console.log(`  ${dir}: launcher ${launcher} / round / foreground+background ${fgCanvas}`);
}

/* anydpi XML：background 用纯色（@color），foreground 用设计图 */
for (const name of ["ic_launcher.xml", "ic_launcher_round.xml"]) {
  const p = path.join(res, "mipmap-anydpi-v26", name);
  const fs = await import("node:fs");
  let xml = fs.readFileSync(p, "utf8");
  xml = xml.replace(
    /<background android:drawable="[^"]*"\/>/,
    '<background android:drawable="@color/ic_launcher_background"/>',
  );
  fs.writeFileSync(p, xml);
  console.log(`  anydpi: ${name} background → @color`);
}
/* 纯色值同步：#2C3550（设计边缘同色） */
const valuesPath = path.join(res, "values", "ic_launcher_background.xml");
const fs2 = await import("node:fs");
fs2.writeFileSync(valuesPath, `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#2C3550</color>\n</resources>\n`);
console.log("  values/ic_launcher_background → #2C3550");

/* ── 预览：512 主图（含居中十字）+ 圆形 + 96/48 ── */
const master = await fullIcon(512);
await sharp(master).png().toFile(path.join(previewDir, "app-icon-512.png"));
const circle = Buffer.from(`<svg width="400" height="400"><circle cx="200" cy="200" r="200" fill="#fff"/></svg>`);
const cross = Buffer.from(`<svg width="400" height="400"><path d="M200 0 V400 M0 200 H400" stroke="#E8557E" stroke-width="1" stroke-dasharray="6 6" opacity=".7"/></svg>`);
const circ = await sharp(await sharp(master).resize(400, 400).png().toBuffer())
  .composite([{ input: circle, blend: "dest-in" }]).png().toBuffer();
const small = await sharp(master).resize(96, 96).png().toBuffer();
const tiny = await sharp(master).resize(48, 48).png().toBuffer();
await sharp({ create: { width: 960, height: 440, channels: 4, background: "#FFF9F0" } })
  .composite([
    { input: await sharp(master).resize(400, 400).png().toBuffer(), left: 20, top: 20 },
    { input: circ, left: 440, top: 20 },
    { input: small, left: 860, top: 40 },
    { input: tiny, left: 880, top: 180 },
  ]).png().toFile(path.join(previewDir, "app-icon-preview.png"));
console.log("APP ICON v2.2 DONE（月夜·陪伴）→ _icon-concepts/app-icon-512.png + app-icon-preview.png");
