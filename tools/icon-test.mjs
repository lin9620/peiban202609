/* 图标守护（轮 403）：设计定稿是「陶红实色底 + 一枚白爪印」
 * 运行：node tools/icon-test.mjs
 *
 * 为什么要有这个测试：图标被覆盖过两次（轮 280 的 C 版被旧生成器回退、轮 403 换版），
 * 每次都是「文件看着还在、尺寸也对、但图案不是定稿」。所以这里除了尺寸，还钉住
 * **颜色、爪印占比、圆角/满版的分别处理**，以及「谁有权写这些文件」。
 *
 * 定稿参数（量自 _scratch/icons/v5/4-paw.png，用户 2026-11-04 圈定）：
 *   底 #DF4B2C · 爪 #FFF8F1 · 爪宽 = 画布 55.6% · 圆角 = 边长 22.37%
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const RES = path.join(ROOT, "android", "app", "src", "main", "res");

const RED = "#df4b2c";
const PAW = "#fff8f1";
const PAW_RATIO = 0.556;
const ADAPTIVE_RATIO = (PAW_RATIO * 72) / 108;

let pass = 0;
const fails = [];
const ok = (name, cond) => (cond ? pass++ : fails.push(name));
const read = (p) => fs.readFileSync(p, "utf8");
const hex = (r, g, b) => "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");

/** 读成原始像素，给出取色与 alpha 探针 */
async function px(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const at = (x, y) => {
    const i = (y * info.width + x) * info.channels;
    return { hex: hex(data[i], data[i + 1], data[i + 2]), a: data[i + 3] };
  };
  return { at, w: info.width, h: info.height, data, ch: info.channels };
}

/** 白色爪印的外接框（与底色差得够多才算） */
async function pawBox(file) {
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, ink = 0;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * ch;
      if (data[i] > 230 && data[i + 1] > 230 && data[i + 2] > 220) {
        ink++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return { w: x1 - x0 + 1, h: y1 - y0 + 1, ink, total: info.width * info.height, size: info.width };
}

/* ── ① Web / PWA ─────────────────────────────────────────── */
const WEB = [
  ["public/icons/icon-192.png", 192], // 圆角
  ["public/icons/icon-512.png", 512], // 圆角
  ["public/icons/icon-maskable-512.png", 512], // 满版
  ["public/favicon.png", 192], // 圆角
  ["public/apple-touch-icon.png", 180], // 满版（iOS 自己加圆角）
];
for (const [rel, size] of WEB) {
  const p = path.join(ROOT, rel);
  const m = fs.existsSync(p) ? await sharp(p).metadata() : null;
  ok(`${rel} 存在且 ${size}×${size}`, !!m && m.width === size && m.height === size);
}

const web192 = await px(path.join(ROOT, "public/icons/icon-192.png"));
ok("圆角版：四角透明（不是满版方图）", web192.at(0, 0).a === 0 && web192.at(191, 191).a === 0);
ok(`圆角版：底色是陶红 ${RED}`, web192.at(96, 30).hex === RED);

const mask = await px(path.join(ROOT, "public/icons/icon-maskable-512.png"));
ok("maskable：满版不透明（系统自己裁形状，留透明会被裁出白角）",
  mask.at(0, 0).a === 255 && mask.at(511, 511).a === 255 && mask.at(0, 0).hex === RED);

const ios = await px(path.join(ROOT, "public/apple-touch-icon.png"));
ok("apple-touch-icon：满版不透明（iOS 自己加圆角，做圆角会二次裁）",
  ios.at(0, 0).a === 255 && ios.at(179, 179).a === 255 && ios.at(0, 0).hex === RED);

const box = await pawBox(path.join(ROOT, "public/icons/icon-512.png"));
ok(`爪印宽度 = 画布 ${(PAW_RATIO * 100).toFixed(1)}% ±2%`,
  Math.abs(box.w / box.size - PAW_RATIO) < 0.02);
ok("爪印面积占比 12%~26%（防缩成一枚小点或被放大糊满）",
  box.ink / box.total > 0.12 && box.ink / box.total < 0.26);

/* ── ② Android 全密度 ───────────────────────────────────── */
const DENSITIES = [
  ["mipmap-mdpi", 48, 108],
  ["mipmap-hdpi", 72, 162],
  ["mipmap-xhdpi", 96, 216],
  ["mipmap-xxhdpi", 144, 324],
  ["mipmap-xxxhdpi", 192, 432],
];
for (const [dir, launcher, fg] of DENSITIES) {
  const d = path.join(RES, dir);
  const expect = [
    ["ic_launcher.png", launcher],
    ["ic_launcher_round.png", launcher],
    ["ic_launcher_foreground.png", fg],
    ["ic_launcher_monochrome.png", fg],
    ["ic_launcher_background.png", fg],
  ];
  let bad = [];
  for (const [file, size] of expect) {
    const p = path.join(d, file);
    const m = fs.existsSync(p) ? await sharp(p).metadata() : null;
    if (!m || m.width !== size || m.height !== size) bad.push(`${file}(${m ? m.width : "缺"})`);
  }
  ok(`${dir}：launcher ${launcher} / 前景·单色·背景 ${fg} 齐全`, bad.length === 0);
}

const fgPx = await px(path.join(RES, "mipmap-xxxhdpi/ic_launcher_foreground.png"));
ok("自适应前景：四角与四边中点全透明（系统只裁形状，不该自带底）",
  fgPx.at(0, 0).a === 0 && fgPx.at(431, 0).a === 0 && fgPx.at(0, 431).a === 0 && fgPx.at(216, 0).a === 0);
const fgBox = await pawBox(path.join(RES, "mipmap-xxxhdpi/ic_launcher_foreground.png"));
/* 108dp 画布只露中间 72dp，所以前景里的爪印要按 72dp 的 55.6% 落位 */
ok(`自适应前景：爪宽 = 72dp 视口的 ${(PAW_RATIO * 100).toFixed(1)}% ±3%`,
  Math.abs(fgBox.w / fgBox.size - ADAPTIVE_RATIO) < 0.03);
ok("自适应前景：爪印在 66dp 安全区内（居中，四周留 1/6 余量）",
  fgBox.w / fgBox.size < 66 / 108);

/* ── ③ 原生配置 ─────────────────────────────────────────── */
const adaptive = read(path.join(RES, "mipmap-anydpi-v26/ic_launcher.xml"));
ok("anydpi 自适应：background / foreground / monochrome 三层齐（Android 13 主题图标）",
  adaptive.includes("@color/ic_launcher_background") &&
    adaptive.includes("@mipmap/ic_launcher_foreground") &&
    adaptive.includes("<monochrome"));
ok("anydpi round 版与普通版同一套三层（别只改一个）",
  read(path.join(RES, "mipmap-anydpi-v26/ic_launcher_round.xml")) === adaptive);
const colorXml = read(path.join(RES, "values/ic_launcher_background.xml"));
ok(`背景色资源 = ${RED}，且无旧米色 #F5F0E8 残留`,
  colorXml.toLowerCase().includes(RED) && !colorXml.toLowerCase().includes("#f5f0e8"));

/* ── ④ 谁有权写这些文件（两次被覆盖的根因） ─────────────── */
const appIcon = read(path.join(ROOT, "tools/make-app-icon.mjs"));
ok("唯一生成器 make-app-icon.mjs：同时产出 public 图标与 Android mipmap",
  appIcon.includes("public") && appIcon.includes("mipmap-anydpi-v26") && appIcon.includes(RED.toUpperCase()));
const og = read(path.join(ROOT, "tools/make-og.mjs"));
ok("make-og.mjs 不再写 favicon / apple-touch-icon（否则会把旧设计盖回来）",
  !og.includes('"favicon.png"') && !og.includes('"apple-touch-icon.png"'));

/* ── ⑤ index.html / manifest 仍指向这套文件 ─────────────── */
const html = read(path.join(ROOT, "index.html"));
ok("index.html：favicon 与 apple-touch-icon 引用在",
  html.includes('href="/favicon.png"') && html.includes('href="/apple-touch-icon.png"'));
const mf = JSON.parse(read(path.join(ROOT, "public/manifest.json")));
ok("manifest：192 常规 / 512 常规 / 512 maskable 三条都指向 /icons/",
  mf.icons.some((i) => i.sizes === "192x192" && !i.purpose) &&
    mf.icons.some((i) => i.sizes === "512x512" && !i.purpose) &&
    mf.icons.some((i) => i.purpose === "maskable"));

/* 汇总行用 TOTAL/PASS/FAIL 格式：tools/all.mjs 的 parseCounts 只认这个口径，
 * 写成小写 "26 pass" 会被当成「没有断言」，全量断言数就漏统计。 */
console.log(`TOTAL ${pass + fails.length} PASS ${pass} FAIL ${fails.length}`);
for (const f of fails) console.log("FAIL  " + f);
if (fails.length) process.exit(1);
