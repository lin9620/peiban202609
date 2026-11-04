/* App 图标生成器 v4 —— 「实色陶红 + 一枚白爪印」
 * ------------------------------------------------------------
 * 轮 403：用户从 _scratch/icons/v5 的五个方案里圈定了 4 号（实色底 + 大爪印），
 * 替掉 v3 的「米底 + 珊瑚圆环」。设计参数直接量自选定稿 4-paw.png：
 *   底色 #DF4B2C（角落与中心同色，纯实色，无渐变无阴影）
 *   爪印 #FFF8F1，外接宽 = 画布 55.66%，几何中心对齐画布中心（实测偏移 0.5px）
 * 爪印只用 4 个圆 + 1 个椭圆，坐标单位制下 bbox 精确已知，因此任意尺寸都能重画
 * 矢量（不是缩位图），48px 也不糊。
 *
 * 唯一入口：这是全套图标唯一的生成器。public/icons、favicon、apple-touch-icon、
 * Android 全密度 mipmap、anydpi 自适应 XML、Android 13 单色图标都在这里出。
 * 旧生成器（make-app-icon-legacy-blue / -night、gen-icons.mjs）已停产，跑它们会把
 * 这里的结果覆盖掉——轮 280 就是这么被回退过一次的。
 *
 * 用法：node tools/make-app-icon.mjs
 */
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const res = path.join(root, "android", "app", "src", "main", "res");
const previewDir = path.join(root, "_icon-concepts");

const RED = "#DF4B2C";
const PAW = "#FFF8F1";

const PAW_RATIO = 0.556; // 爪印外接宽 / 画布
const RADIUS_RATIO = 0.2237; // 圆角 / 边长（与 iOS squircle 观感一致）
/* 自适应图标：108dp 画布，系统只露出中间 72dp。
 * 所以前景里的爪印要按「72dp 的 55.6%」来定，落到 108dp 画布上就是 37.07%。 */
const ADAPTIVE_RATIO = (PAW_RATIO * 72) / 108;

/* 爪印矢量：单位制里 4 趾 + 掌垫，bbox = x[-63,63] × y[-72.5,41] */
const UNIT_W = 126;
const PAW_SHAPES = `
    <circle cx="-47" cy="-35" r="16"/>
    <circle cx="-16" cy="-56" r="16.5"/>
    <circle cx="16" cy="-56" r="16.5"/>
    <circle cx="47" cy="-35" r="16"/>
    <ellipse cx="0" cy="13" rx="34" ry="28"/>`;

/**
 * 画一张图标。
 * @param {number} size      边长 px
 * @param {"rounded"|"circle"|"square"|"none"} shape 底色形状（none = 透明底，只画爪印）
 * @param {number} ratio     爪印宽 / 边长
 * @param {string} pawFill   爪印颜色
 * @param {string|null} ground 底色（shape=none 时忽略）
 */
function iconSvg(size, { shape = "rounded", ratio = PAW_RATIO, pawFill = PAW, ground = RED } = {}) {
  const k = (size * ratio) / UNIT_W;
  // 把单位制里的 bbox 中心 (0, -15.75) 对到画布中心
  const tx = size / 2;
  const ty = size / 2 + 15.75 * k;

  let bg = "";
  if (shape === "rounded") {
    bg = `<rect width="${size}" height="${size}" rx="${(size * RADIUS_RATIO).toFixed(2)}" fill="${ground}"/>`;
  } else if (shape === "circle") {
    bg = `<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="${ground}"/>`;
  } else if (shape === "square") {
    bg = `<rect width="${size}" height="${size}" fill="${ground}"/>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"
      viewBox="0 0 ${size} ${size}" shape-rendering="geometricPrecision">
    ${bg}
    <g fill="${pawFill}" transform="translate(${tx.toFixed(2)},${ty.toFixed(2)}) scale(${k.toFixed(5)})">${PAW_SHAPES}
    </g>
  </svg>`;
}

const png = async (svg, file) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const buf = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
  fs.writeFileSync(file, buf);
  return buf;
};

/* ── ① Android 全密度 ───────────────────────────────────── */
const DENSITIES = [
  ["mipmap-mdpi", 48, 108],
  ["mipmap-hdpi", 72, 162],
  ["mipmap-xhdpi", 96, 216],
  ["mipmap-xxhdpi", 144, 324],
  ["mipmap-xxxhdpi", 192, 432],
];

for (const [dir, launcher, fg] of DENSITIES) {
  const d = path.join(res, dir);
  fs.mkdirSync(d, { recursive: true });

  // 传统图标（Android 8.0 以下整张用，8.0+ 只作兜底）：带圆角的实色方块
  await png(iconSvg(launcher, { shape: "rounded" }), path.join(d, "ic_launcher.png"));
  // 圆形图标
  await png(iconSvg(launcher, { shape: "circle" }), path.join(d, "ic_launcher_round.png"));
  // 自适应前景：透明底 + 白爪印（系统负责裁形状）
  await png(iconSvg(fg, { shape: "none", ratio: ADAPTIVE_RATIO }), path.join(d, "ic_launcher_foreground.png"));
  // Android 13 主题图标：同一枚爪印，系统按壁纸取色
  await png(iconSvg(fg, { shape: "none", ratio: ADAPTIVE_RATIO }), path.join(d, "ic_launcher_monochrome.png"));
  // 自适应背景层：纯色（anydpi XML 走 @color，这份是模板遗留的位图兜底，一并刷成同色）
  await png(iconSvg(fg, { shape: "square" }), path.join(d, "ic_launcher_background.png"));

  console.log(`  ${dir}: launcher ${launcher}px · foreground/monochrome/background ${fg}px`);
}

/* ── ② anydpi 自适应 XML + 背景色 ───────────────────────── */
const adaptive = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
    <!-- 轮 403：Android 13 主题图标（单色）。API 33 以下忽略此节点，不影响 8.0~12。 -->
    <monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>
</adaptive-icon>
`;
for (const name of ["ic_launcher.xml", "ic_launcher_round.xml"]) {
  fs.writeFileSync(path.join(res, "mipmap-anydpi-v26", name), adaptive);
}
fs.writeFileSync(
  path.join(res, "values", "ic_launcher_background.xml"),
  `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${RED}</color>\n</resources>\n`,
);

/* ── ③ Web / PWA ────────────────────────────────────────── */
const pub = path.join(root, "public");
const master512 = await png(iconSvg(512), path.join(root, "tools", "icon-master.png"));

await png(iconSvg(192), path.join(pub, "favicon.png"));
await png(iconSvg(192), path.join(pub, "icons", "icon-192.png"));
await png(iconSvg(512), path.join(pub, "icons", "icon-512.png"));
/* maskable：满版不留圆角（系统自己裁），爪印在 80% 安全圆内 */
await png(iconSvg(512, { shape: "square" }), path.join(pub, "icons", "icon-maskable-512.png"));
/* apple-touch-icon：iOS 自己加圆角，给满版方图；180 是官方要求尺寸 */
await png(iconSvg(180, { shape: "square" }), path.join(pub, "apple-touch-icon.png"));

/* ── ④ 预览图（给人看，不进包） ─────────────────────────── */
fs.mkdirSync(previewDir, { recursive: true });
fs.writeFileSync(path.join(previewDir, "app-icon-512.png"), master512);

const big = await sharp(master512).resize(400, 400).png().toBuffer();
const round = await sharp(Buffer.from(iconSvg(400, { shape: "circle" }))).png().toBuffer();

/* 自适应图标在启动器上的真实观感：108dp 画布只露中间 72dp，再套一层圆形遮罩。
 * 所以这里画「72dp 视口」——爪印按其 55.6% 落位——然后裁圆。 */
const view72 = 400;
const adaptivePreview = await sharp(
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${view72}" height="${view72}">
       <rect width="${view72}" height="${view72}" fill="${RED}"/>
       <g fill="${PAW}" transform="translate(${view72 / 2},${view72 / 2 + 15.75 * ((view72 * PAW_RATIO) / UNIT_W)})
          scale(${(view72 * PAW_RATIO) / UNIT_W})">${PAW_SHAPES}
       </g>
     </svg>`,
  ),
)
  .composite([
    {
      input: Buffer.from(
        `<svg width="${view72}" height="${view72}"><circle cx="${view72 / 2}" cy="${view72 / 2}" r="${view72 / 2}"/></svg>`,
      ),
      blend: "dest-in",
    },
  ])
  .png()
  .toBuffer();

await sharp({ create: { width: 1448, height: 500, channels: 4, background: "#F1EADF" } })
  .composite([
    { input: big, left: 24, top: 24 },
    { input: round, left: 456, top: 24 },
    { input: adaptivePreview, left: 888, top: 24 },
    { input: await sharp(master512).resize(96, 96).png().toBuffer(), left: 1320, top: 40 },
    { input: await sharp(Buffer.from(iconSvg(48))).png().toBuffer(), left: 1320, top: 156 },
    { input: await sharp(Buffer.from(iconSvg(29))).png().toBuffer(), left: 1380, top: 175 },
  ])
  .png()
  .toFile(path.join(previewDir, "app-icon-preview.png"));

console.log(`APP ICON v4 DONE（实色 ${RED} + 白爪印 ${PAW}，爪宽 ${(PAW_RATIO * 100).toFixed(1)}%）`);
