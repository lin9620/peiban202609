/* ═══ App 图标候选生成器（轮 238 · 10 个方向）═══
 * 产出 _icon-concepts/01..10.svg + sheet.png（总览拼图，给用户挑）。
 * 口径：暖爪治愈系 —— 奶油/暖橘主调、kawaii 体积感、圆角方块（启动图标惯例 rx≈22%），
 * 母题围绕 爪印 / 萌宠 / 陪伴。选中后由 make-app-icon.mjs 生成全密度 mipmap。
 * 运行：node tools/gen-icon-concepts.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "_icon-concepts");
mkdirSync(OUT, { recursive: true });

const S = 512;                       // 画布
const R = 116;                       // 圆角（启动图标比例）
const INK = "#4A3B33";

/* ── 通用件 ── */
const bg = (c1, c2) =>
  `<defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.6" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient>
    <radialGradient id="gl"><stop offset="0" stop-color="#FFF" stop-opacity=".55"/><stop offset="1" stop-color="#FFF" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="${S}" height="${S}" rx="${R}" fill="url(#bg)"/>`;
const orb = (x, y, r, color, op) =>
  `<circle cx="${x}" cy="${y}" r="${r}" fill="${color}" opacity="${op}" filter="url(#blur${r})"/>` +
  `<defs><filter id="blur${r}" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="${r * 0.24}"/></filter></defs>`;
const glint = (x, y) => `<ellipse cx="${x}" cy="${y}" rx="60" ry="30" fill="url(#gl)" transform="rotate(-18 ${x} ${y})"/>`;

/* 爪印：肉垫 + 四趾（s≈肉垫半宽；趾色可独立） */
function paw(cx, cy, s, padColor, toeColor, rot = 0) {
  const toe = (tx, ty, rx, ry, a) =>
    `<ellipse cx="${tx}" cy="${ty}" rx="${rx}" ry="${ry}" fill="${toeColor}" transform="rotate(${a} ${tx} ${ty})"/>`;
  return `<g transform="translate(${cx} ${cy}) rotate(${rot})">
    <ellipse cx="0" cy="${s * 0.34}" rx="${s * 0.52}" ry="${s * 0.44}" fill="${padColor}"/>
    ${toe(-s * 0.54, -s * 0.12, s * 0.185, s * 0.25, -20)}
    ${toe(-s * 0.19, -s * 0.34, s * 0.195, s * 0.27, -7)}
    ${toe(s * 0.19, -s * 0.34, s * 0.195, s * 0.27, 7)}
    ${toe(s * 0.54, -s * 0.12, s * 0.185, s * 0.25, 20)}
  </g>`;
}
const heart = (cx, cy, s, color, rot = 0) =>
  `<path transform="translate(${cx} ${cy}) rotate(${rot}) scale(${s})"
    d="M0 8 C -2 4 -10 -2 -10 -8 C -10 -13 -6 -15 -3 -14 C -1 -13.4 0 -11.5 0 -11 C 0 -11.5 1 -13.4 3 -14 C 6 -15 10 -13 10 -8 C 10 -2 2 4 0 8 Z" fill="${color}"/>`;

/* 萌宠脸底座（圆头 + 体积影 + 顶光） */
const faceBase = (fur) =>
  `<circle cx="256" cy="272" r="150" fill="${fur}"/>
   <circle cx="256" cy="272" r="150" fill="url(#sh)"/>
   <ellipse cx="200" cy="172" rx="64" ry="34" fill="#FFF" opacity=".3" transform="rotate(-16 200 172)"/>`;
const faceShade = `<radialGradient id="sh" cx="40%" cy="30%" r="85%">
  <stop offset="55%" stop-color="#000" stop-opacity="0"/><stop offset="100%" stop-color="#000" stop-opacity=".1"/></radialGradient>`;
const eye = (x, y) =>
  `<ellipse cx="${x}" cy="${y}" rx="15" ry="18.5" fill="${INK}"/>` +
  `<circle cx="${x + 5}" cy="${y - 6.5}" r="6" fill="#FFF"/>` +
  `<circle cx="${x - 4.5}" cy="${y + 6}" r="3" fill="#FFF" opacity=".75"/>`;
const blushI = (x, y) => `<ellipse cx="${x}" cy="${y}" rx="22" ry="13" fill="#F58CA6" opacity=".5"/>`;

/* ── 10 个方向 ── */
const CONCEPTS = {
  /* 01 经典爪印：奶油渐变 + 暖橘大爪 */
  c1: { name: "爪印·经典", svg: () =>
    bg("#FFF4E4", "#FFDDBC") + orb(420, 90, 110, "#F5A860", .35) + orb(80, 440, 120, "#F58CA6", .22) +
    glint(180, 130) +
    paw(256, 250, 150, "#F5A860", "#E8965A") +
    `<ellipse cx="256" cy="322" rx="52" ry="20" fill="#FFF" opacity=".35"/>` },
  /* 02 爱心肉垫：爪印 + 粉心肉垫 */
  c2: { name: "爪印·爱心", svg: () =>
    bg("#FFEDF0", "#FFD3DE") + orb(96, 96, 110, "#F58CA6", .3) + orb(430, 430, 120, "#F5A860", .28) +
    glint(340, 120) +
    paw(256, 236, 132, "#F49BAF", "#F49BAF") +
    heart(256, 330, 10.5, "#E8557E") },
  /* 03 小橘猫 */
  c3: { name: "小橘猫", svg: () =>
    bg("#FFF3E2", "#FFE2C4") + orb(420, 88, 100, "#F5A860", .35) +
    `<g transform="translate(256 96) rotate(-20)"><path d="M0 -46 L36 26 L-36 26 Z" fill="#F5A860"/><path d="M0 -26 L18 16 L-18 16 Z" fill="#FFDCB8"/></g>` +
    `<g transform="translate(368 100) rotate(20)"><path d="M0 -46 L36 26 L-36 26 Z" fill="#F5A860"/><path d="M0 -26 L18 16 L-18 16 Z" fill="#FFDCB8"/></g>` +
    faceBase("#F5A860") + eye(204, 268) + eye(308, 268) +
    `<path d="M244 316 L268 316 L256 332 Z" fill="#E08F3E"/>` +
    `<path d="M256 332 Q256 344 240 346 M256 332 Q256 344 272 346" stroke="${INK}" stroke-width="8" fill="none" stroke-linecap="round"/>` +
    blushI(172, 318) + blushI(340, 318) },
  /* 04 柴犬 */
  c4: { name: "柴犬", svg: () =>
    bg("#FFEBDD", "#FFD8C2") + orb(420, 90, 110, "#E8965A", .4) +
    `<g transform="translate(150 130) rotate(-16)"><path d="M0 -50 L38 28 L-38 28 Z" fill="#E8965A"/><path d="M0 -28 L19 18 L-19 18 Z" fill="#FFF2E4"/></g>` +
    `<g transform="translate(362 130) rotate(16)"><path d="M0 -50 L38 28 L-38 28 Z" fill="#E8965A"/><path d="M0 -28 L19 18 L-19 18 Z" fill="#FFF2E4"/></g>` +
    faceBase("#E8965A") +
    `<path d="M196 316 Q256 378 316 316 L316 292 Q256 258 196 292 Z" fill="#FFF6EC"/>` +
    eye(206, 268) + eye(306, 268) +
    `<path d="M243 312 L269 312 L256 331 Z" fill="${INK}"/>` +
    `<path d="M256 331 Q256 343 242 345 M256 331 Q256 343 270 345" stroke="${INK}" stroke-width="7" fill="none" stroke-linecap="round"/>` },
  /* 05 月夜陪伴：星夜蓝 + 月亮 + 奶油爪 */
  c5: { name: "月夜·陪伴", svg: () =>
    bg("#3D4763", "#2C3550") + orb(120, 110, 120, "#8FA0C7", .35) + orb(430, 420, 130, "#F5C97E", .22) +
    `<circle cx="150" cy="120" r="4" fill="#FFF" opacity=".8"/><circle cx="390" cy="90" r="3" fill="#FFF" opacity=".6"/><circle cx="430" cy="200" r="3.5" fill="#FFF" opacity=".7"/><circle cx="80" cy="300" r="3" fill="#FFF" opacity=".5"/>` +
    `<path d="M340 120 A66 66 0 1 1 268 56 A52 52 0 1 0 340 120 Z" fill="#FFE9B8"/>` +
    paw(244, 320, 128, "#FFE9B8", "#FFDFA0") },
  /* 06 爪印比心：爪印为主，小心点缀 */
  c6: { name: "爪印·比心", svg: () =>
    bg("#FFF4E4", "#FFDDBC") + orb(430, 100, 110, "#F58CA6", .3) +
    glint(170, 130) +
    `<g transform="translate(248 252) rotate(-10)">` +
    paw(0, 0, 132, "#F5A860", "#E8965A") + `</g>` +
    heart(346, 208, 7.5, "#E8557E", 14) +
    `<circle cx="150" cy="392" r="8" fill="#F58CA6" opacity=".55"/><circle cx="120" cy="150" r="6" fill="#F5A860" opacity=".6"/>` },
  /* 07 漂流瓶：圆肩瓶 + 瓶中信 */
  c7: { name: "漂流瓶", svg: () =>
    bg("#DFF0FA", "#C4E2F4") + orb(100, 100, 110, "#9CC3E5", .4) +
    `<g transform="rotate(-10 256 260)">
      <rect x="234" y="98" width="44" height="34" rx="8" fill="#C98F3E"/>
      <rect x="228" y="126" width="56" height="20" rx="8" fill="#E8B04B"/>
      <path d="M228 142 Q208 200 208 280 Q208 366 256 366 Q304 366 304 280 Q304 200 284 142 Z" fill="#BFE0F2" opacity=".95"/>
      <path d="M238 210 Q232 300 240 330 L272 330 Q280 300 274 210 Q256 200 238 210 Z" fill="#FFF7E0"/>
      heart(256, 268, 6.5, "#E8557E")
    </g>` +
    paw(112, 400, 70, "#F5A860", "#E8965A", -18) },
  /* 08 星光爪印 */
  c8: { name: "爪印·星光", svg: () =>
    bg("#FFEFD6", "#FFDFAC") + orb(430, 420, 120, "#F5C97E", .45) +
    `<path d="M120 120 L132 156 L168 168 L132 180 L120 216 L108 180 L72 168 L108 156 Z" fill="#FFD75E"/>` +
    `<path d="M400 96 L408 122 L434 130 L408 138 L400 164 L392 138 L366 130 L392 122 Z" fill="#FFC95E" opacity=".9"/>` +
    `<path d="M420 350 L425 372 L447 378 L425 384 L420 406 L415 384 L393 378 L415 372 Z" fill="#F58CA6" opacity=".8"/>` +
    paw(256, 262, 148, "#F5A860", "#E8965A") },
  /* 09 橘猫抱心 */
  c9: { name: "橘猫·抱心", svg: () =>
    bg("#FFF3E2", "#FFE2C4") + orb(90, 90, 110, "#F58CA6", .28) +
    `<g transform="translate(256 100) rotate(-20)"><path d="M0 -44 L34 25 L-34 25 Z" fill="#F5A860"/><path d="M0 -24 L17 15 L-17 15 Z" fill="#FFDCB8"/></g>` +
    `<g transform="translate(368 104) rotate(20)"><path d="M0 -44 L34 25 L-34 25 Z" fill="#F5A860"/><path d="M0 -24 L17 15 L-17 15 Z" fill="#FFDCB8"/></g>` +
    faceBase("#F5A860") + eye(206, 262) + eye(306, 262) +
    `<path d="M246 308 L266 308 L256 322 Z" fill="#E08F3E"/>` +
    `<path d="M170 380 Q256 330 342 380 L342 430 L170 430 Z" fill="#FFDCB8"/>` +
    heart(256, 396, 9.5, "#E8557E") },
  /* 10 信封爪印：温暖信箱 */
  c10: { name: "信·爪印", svg: () =>
    bg("#EAF6EC", "#D5EDDA") + orb(420, 100, 110, "#F5A860", .3) +
    `<rect x="136" y="170" width="240" height="170" rx="22" fill="#FDFDFB"/>
     <path d="M136 192 L256 292 L376 192" fill="none" stroke="#E3D5C2" stroke-width="10" stroke-linecap="round"/>
     heart(256, 320, 9, "#E8557E")` +
    paw(256, 252, 62, "#F5A860", "#E8965A") },
};

const NAMES = ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9", "c10"];

/* ── 渲染：SVG → PNG（带角标编号）→ 总览 sheet ── */
mkdirSync(OUT, { recursive: true });
const tiles = [];
for (let i = 0; i < NAMES.length; i++) {
  const key = NAMES[i];
  const c = CONCEPTS[key];
  const num = String(i + 1).padStart(2, "0");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}">${c.svg()}</svg>`;
  writeFileSync(join(OUT, `${num}-${c.name}.svg`), svg, "utf8");
  const badge = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="30" fill="#4A3B33" opacity=".82"/><text x="32" y="44" font-family="Arial" font-size="34" font-weight="700" fill="#FFF7EE" text-anchor="middle">${i + 1}</text></svg>`;
  const png = await sharp(Buffer.from(svg)).resize(300, 300).png().toBuffer();
  const badgePng = await sharp(Buffer.from(badge)).png().toBuffer();
  const composed = await sharp(png).composite([{ input: badgePng, left: 226, top: 226 }]).png().toBuffer();
  writeFileSync(join(OUT, `${num}-${c.name}.png`), composed);
  tiles.push(composed);
}
/* 总览：5 列 × 2 行，带间隙 */
const CELL = 310, GAP = 14, COLS = 5, ROWS = 2;
const W = COLS * CELL + (COLS + 1) * GAP, H = ROWS * CELL + (ROWS + 1) * GAP + 56;
const comps = tiles.map((buf, i) => ({
  input: buf, left: GAP + (i % COLS) * CELL, top: GAP + Math.floor(i / COLS) * CELL,
}));
const sheet = await sharp({ create: { width: W, height: H, channels: 4, background: "#FFF9F0" } })
  .composite(comps).png().toBuffer();
const label = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="56"><text x="${W / 2}" y="40" font-family="Arial" font-size="28" fill="#8A6E52" text-anchor="middle">Warm Paws · App 图标候选 1-10（回复编号）</text></svg>`;
await sharp(sheet).composite([{ input: await sharp(Buffer.from(label)).png().toBuffer(), left: 0, top: H - 56 }]).png().toFile(join(OUT, "sheet.png"));
console.log(`[gen-icon-concepts] 10 个候选 → ${OUT}（sheet.png 总览）`);
