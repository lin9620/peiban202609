/* ═══ 萌宠头像生成器 v2（轮 238 · 30 张）═══
 * 产出 public/avatars/01.svg … 30.svg —— 注册用户按 uid 哈希稳定分配（utils/avatar.js）。
 * 设计口径：LINE Friends 式精致 kawaii，不是幼儿贴纸 ——
 *   · 脸部径向柔影 + 顶部高光（体积感，不是纯平色块）
 *   · 腮红用径向渐变渐隐（不是硬边椭圆）
 *   · 双层眼眸高光、细口线（1.4px）、克制的粉调
 *   · 背景双色柔和渐变；每个物种有一处「记忆点」（鹿斑/浣熊眼罩/鲸鱼喷水…）
 * 全矢量手写坐标：每张 ~2KB、任意尺寸不糊、无外部素材。
 * 运行：node tools/gen-avatars.mjs   （重跑覆盖，产物入库）
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "avatars");

const INK = "#4A3B33";

/* ── 面部通用：脸 + 体积影 + 顶光 + 眼 + 腮红 ── */
const FACE_GRAD = `<radialGradient id="sh" cx="40%" cy="32%" r="85%">
<stop offset="52%" stop-color="#000" stop-opacity="0"/><stop offset="100%" stop-color="#000" stop-opacity=".08"/>
</radialGradient>`;
const BLUSH_GRAD = `<radialGradient id="b"><stop offset="0%" stop-color="#F58CA6" stop-opacity=".5"/><stop offset="100%" stop-color="#F58CA6" stop-opacity="0"/></radialGradient>`;
const DEFS = `<defs><clipPath id="c"><circle cx="48" cy="48" r="48"/></clipPath>${FACE_GRAD}${BLUSH_GRAD}</defs>`;

const head = (fur) =>
  `<circle cx="48" cy="55" r="29.5" fill="${fur}"/>` +
  `<circle cx="48" cy="55" r="29.5" fill="url(#sh)"/>` +
  `<ellipse cx="38" cy="36.5" rx="12" ry="6.5" fill="#FFF" opacity=".26" transform="rotate(-16 38 36.5)"/>`;

const eye = (x, y, r = 3.2) =>
  `<ellipse cx="${x}" cy="${y}" rx="${r * 0.92}" ry="${r}" fill="${INK}"/>` +
  `<circle cx="${x + 1.05}" cy="${y - 1.35}" r="${(r * 0.4).toFixed(2)}" fill="#FFF"/>` +
  `<circle cx="${x - 0.9}" cy="${y + 1.3}" r="${(r * 0.2).toFixed(2)}" fill="#FFF" opacity=".75"/>`;
const closedEye = (x, y) =>
  `<path d="M${x - 3.2} ${y} Q${x} ${y + 2.4} ${x + 3.2} ${y}" stroke="${INK}" stroke-width="1.6" fill="none" stroke-linecap="round"/>`;
const happyEye = (x, y) =>
  `<path d="M${x - 3.2} ${y + 1.4} Q${x} ${y - 2.8} ${x + 3.2} ${y + 1.4}" stroke="${INK}" stroke-width="1.7" fill="none" stroke-linecap="round"/>`;
const blush = (x, y) => `<circle cx="${x}" cy="${y}" r="6.2" fill="url(#b)"/>`;
const smile = (x, y, w = 6.5) =>
  `<path d="M${x - w / 2} ${y} Q${x} ${y + 3} ${x + w / 2} ${y}" stroke="${INK}" stroke-width="1.4" fill="none" stroke-linecap="round"/>`;
const omega = (x, y) =>
  `<path d="M${x - 4.2} ${y} Q${x - 2.1} ${y + 3.3} ${x} ${y} Q${x + 2.1} ${y + 3.3} ${x + 4.2} ${y}" stroke="${INK}" stroke-width="1.4" fill="none" stroke-linecap="round"/>`;
const nose = (x, y, c = INK) =>
  `<path d="M${x - 2.1} ${y} L${x + 2.1} ${y} L${x} ${y + 2.5} Z" fill="${c}"/>`;

/* ── 耳朵 ── */
const roundEar = (x, y, r, fur, inner) =>
  `<circle cx="${x}" cy="${y}" r="${r}" fill="${fur}"/>` +
  (inner ? `<circle cx="${x}" cy="${y}" r="${(r * 0.56).toFixed(2)}" fill="${inner}"/>` : "");
const pointEar = (x, y, s, rot, fur, inner) => {
  const g = `<path d="M0 -12 L9 7.5 L-9 7.5 Z" fill="${fur}"/>` +
    (inner ? `<path d="M0 -6.2 L4.6 5.2 L-4.6 5.2 Z" fill="${inner}"/>` : "");
  return `<g transform="translate(${x} ${y}) rotate(${rot}) scale(${s})">${g}</g>`;
};
const floppyEar = (x, y, rot, fur, inner) => {
  const g = `<ellipse cx="0" cy="5.5" rx="8" ry="12.5" fill="${fur}"/>` +
    (inner ? `<ellipse cx="0" cy="6.5" rx="4.3" ry="7.5" fill="${inner}"/>` : "");
  return `<g transform="translate(${x} ${y}) rotate(${rot})">${g}</g>`;
};

/* 刺猬的刺冠：程序生成的锯齿弧（上限角 170°→10°，内 26 / 外 36） */
const spikeCrown = (cx, cy, rIn, rOut) => {
  let d = "";
  const steps = 9;
  const a0 = Math.PI * 0.94, a1 = Math.PI * 0.06;
  for (let k = 0; k <= steps; k++) {
    const a = a0 + (a1 - a0) * (k / steps);
    const r = k % 2 === 0 ? rIn : rOut;
    d += (k ? "L" : "M") + (cx + r * Math.cos(a)).toFixed(1) + " " + (cy - r * Math.sin(a)).toFixed(1) + " ";
  }
  d += `L${cx + rIn} ${cy + 6} Q${cx} ${cy + 14} ${cx - rIn} ${cy + 6} Z`;
  return d;
};

/* ── 30 个物种 ── */
const SPECIES = {
  cat: { bg: ["#FFF3E2", "#FFE2C4"], draw: () =>
    pointEar(28, 32, 1, -20, "#F5A860", "#FFDCB8") + pointEar(68, 32, 1, 20, "#F5A860", "#FFDCB8") +
    head("#F5A860") +
    `<path d="M35 30.5 L40.5 35.5 M61 30.5 L55.5 35.5" stroke="#E08F3E" stroke-width="2.2" stroke-linecap="round"/>` +
    eye(38, 52.5) + eye(58, 52.5) + nose(48, 58.8, "#E08F3E") + omega(48, 61.2) +
    blush(29.5, 60) + blush(66.5, 60) },
  shiba: { bg: ["#FFEBDD", "#FFD8C2"], draw: () =>
    pointEar(28, 31, 1.02, -16, "#E8965A", "#FBDCBE") + pointEar(68, 31, 1.02, 16, "#E8965A", "#FBDCBE") +
    head("#E8965A") +
    `<ellipse cx="48" cy="60.5" rx="9.5" ry="7.2" fill="#FFF6EC"/>` +
    eye(38, 51.5) + eye(58, 51.5) + nose(48, 57.8) + smile(48, 63.5, 5.6) +
    blush(29, 59) + blush(67, 59) },
  rabbit: { bg: ["#FFEDF2", "#FFDCE7"], draw: () =>
    `<ellipse cx="35" cy="17" rx="7.2" ry="18.5" fill="#F7F1EC" transform="rotate(-11 35 17)"/>` +
    `<ellipse cx="35" cy="18" rx="3.4" ry="11.5" fill="#F4AFC2" transform="rotate(-11 35 18)"/>` +
    `<ellipse cx="61" cy="17" rx="7.2" ry="18.5" fill="#F7F1EC" transform="rotate(11 61 17)"/>` +
    `<ellipse cx="61" cy="18" rx="3.4" ry="11.5" fill="#F4AFC2" transform="rotate(11 61 18)"/>` +
    head("#F7F1EC") + eye(38, 53) + eye(58, 53) + nose(48, 58.8, "#E58BA0") + smile(48, 61.5, 5.6) +
    blush(30, 60) + blush(66, 60) },
  panda: { bg: ["#EDF4E9", "#DCEBDB"], draw: () =>
    roundEar(27, 33, 10, "#3E4245") + roundEar(69, 33, 10, "#3E4245") +
    head("#FDFDFB") +
    `<ellipse cx="37.5" cy="52" rx="7.4" ry="8.4" fill="#3E4245" transform="rotate(-14 37.5 52)"/>` +
    `<ellipse cx="58.5" cy="52" rx="7.4" ry="8.4" fill="#3E4245" transform="rotate(14 58.5 52)"/>` +
    `<circle cx="38" cy="51.6" r="2.7" fill="#FFF"/><circle cx="39" cy="50.8" r="1.05" fill="#3E4245"/>` +
    `<circle cx="58" cy="51.6" r="2.7" fill="#FFF"/><circle cx="59" cy="50.8" r="1.05" fill="#3E4245"/>` +
    nose(48, 60) + smile(48, 63.4, 6.2) },
  bear: { bg: ["#F6EBDB", "#EDDCC4"], draw: () =>
    roundEar(27.5, 33.5, 9.2, "#B98A5E", "#E2C098") + roundEar(68.5, 33.5, 9.2, "#B98A5E", "#E2C098") +
    head("#B98A5E") + `<ellipse cx="48" cy="62" rx="10.6" ry="8.2" fill="#E2C098"/>` +
    eye(38, 52) + eye(58, 52) + nose(48, 58.8) + smile(48, 62.2, 5.6) +
    blush(29, 59.5) + blush(67, 59.5) },
  frog: { bg: ["#EBF7E0", "#D8EFC4"], draw: () =>
    roundEar(31, 30, 10, "#8FC97E", "#CCEBBB") + roundEar(65, 30, 10, "#8FC97E", "#CCEBBB") +
    head("#8FC97E") + eye(38, 55, 3) + eye(58, 55, 3) + smile(48, 62, 11) +
    blush(29, 61) + blush(67, 61) },
  penguin: { bg: ["#E6F3FB", "#D2E8F7"], draw: () =>
    head("#45505C") +
    `<path d="M48 33.5 Q67 40 64.5 60 Q61 77 48 78.5 Q35 77 31.5 60 Q29 40 48 33.5 Z" fill="#FDFDFB"/>` +
    closedEye(39.5, 52) + closedEye(56.5, 52) +
    `<path d="M44.8 56 L51.2 56 L48 61.2 Z" fill="#F2A24B"/>` + blush(32, 60) + blush(64, 60) },
  fox: { bg: ["#FFEBD9", "#FFD9BC"], draw: () =>
    pointEar(26, 30, 1.22, -20, "#F08A4B", "#FFE7CE") + pointEar(70, 30, 1.22, 20, "#F08A4B", "#FFE7CE") +
    head("#F08A4B") +
    `<ellipse cx="48" cy="61" rx="10" ry="7.6" fill="#FFF6EC"/>` +
    eye(38, 52) + eye(58, 52) + nose(48, 58.6) + smile(48, 62, 5.8) +
    blush(29, 59.5) + blush(67, 59.5) },
  chick: { bg: ["#FFF6CF", "#FFECA8"], draw: () =>
    head("#FFD75E") +
    `<path d="M45.5 26.5 Q47.5 20.5 52.5 21.5" stroke="#E0A93E" stroke-width="2" fill="none" stroke-linecap="round"/>` +
    eye(39, 52) + eye(57, 52) +
    `<path d="M44.6 58 L51.4 58 L48 63.2 Z" fill="#F2A24B"/>` + blush(30.5, 58.5) + blush(65.5, 58.5) },
  otter: { bg: ["#E8F1F0", "#D6E7E5"], draw: () =>
    roundEar(27.5, 35.5, 7.8, "#A78A6D", "#DBC7AB") + roundEar(68.5, 35.5, 7.8, "#A78A6D", "#DBC7AB") +
    head("#A78A6D") +
    `<path d="M33.5 60 Q38.5 71.5 48 72.5 Q57.5 71.5 62.5 60 Q55.5 64.8 48 64.8 Q40.5 64.8 33.5 60 Z" fill="#F2E7D2"/>` +
    eye(38, 52) + eye(58, 52) + nose(48, 58.6) + smile(48, 62.2, 5.6) +
    blush(29.5, 59.5) + blush(66.5, 59.5) },
  dino: { bg: ["#EAF7E1", "#D6EFC4"], draw: () =>
    `<path d="M36.5 27.5 L41.5 20.5 L46.5 27.5 L51.5 19.5 L56.5 27.5 L61.5 21 L64.5 28.5" fill="none" stroke="#7DA85E" stroke-width="4.6" stroke-linejoin="round" stroke-linecap="round"/>` +
    head("#8FBF6E") + happyEye(38.5, 53) + happyEye(57.5, 53) + smile(48, 61.5, 9) +
    blush(29, 60) + blush(67, 60) },
  hedgehog: { bg: ["#F1E9F7", "#E2D5F0"], draw: () => {
    const spikes = spikeCrown(48, 57, 26.5, 36.5);
    return `<path d="${spikes}" fill="#8A6E52"/>` +
      `<circle cx="48" cy="61" r="21.5" fill="#C9A87C"/><circle cx="48" cy="61" r="21.5" fill="url(#sh)"/>` +
      `<ellipse cx="39" cy="46.5" rx="9" ry="5" fill="#FFF" opacity=".22" transform="rotate(-16 39 46.5)"/>` +
      eye(39.5, 60) + eye(56.5, 60) + nose(48, 66.8, "#6E5540") + smile(48, 69.6, 5) +
      blush(31.5, 66.5) + blush(64.5, 66.5);
    } },
  hamster: { bg: ["#FFEED8", "#FFE0BC"], draw: () =>
    roundEar(28.5, 34.5, 8.2, "#F2C98A", "#FBE0BC") + roundEar(67.5, 34.5, 8.2, "#F2C98A", "#FBE0BC") +
    head("#F2C98A") +
    `<circle cx="33.5" cy="62" r="7.8" fill="#F9DDB4"/><circle cx="62.5" cy="62" r="7.8" fill="#F9DDB4"/>` +
    eye(38, 52) + eye(58, 52) + nose(48, 58.6) + omega(48, 61) +
    `<circle cx="30.5" cy="60" r="6.2" fill="url(#b)"/><circle cx="65.5" cy="60" r="6.2" fill="url(#b)"/>` },
  koala: { bg: ["#EBF2F6", "#D9E6EE"], draw: () =>
    `<circle cx="24.5" cy="37" r="12.5" fill="#8FA0AE"/><circle cx="24.5" cy="37" r="6.6" fill="#D8C4B4"/>` +
    `<circle cx="71.5" cy="37" r="12.5" fill="#8FA0AE"/><circle cx="71.5" cy="37" r="6.6" fill="#D8C4B4"/>` +
    head("#9FB2C1") + `<ellipse cx="48" cy="62" rx="10.2" ry="7.8" fill="#C7D3DB"/>` +
    eye(38, 52) + eye(58, 52) + nose(48, 59.2, "#5A6B78") + smile(48, 62.8, 5.6) },
  raccoon: { bg: ["#EDF1F4", "#DDE4EA"], draw: () =>
    roundEar(27.5, 33.5, 8.8, "#B7BFC7", "#E4E9ED") + roundEar(68.5, 33.5, 8.8, "#B7BFC7", "#E4E9ED") +
    head("#B7BFC7") +
    `<ellipse cx="37.5" cy="52" rx="8.2" ry="6.4" fill="#4E565E" transform="rotate(-12 37.5 52)"/>` +
    `<ellipse cx="58.5" cy="52" rx="8.2" ry="6.4" fill="#4E565E" transform="rotate(12 58.5 52)"/>` +
    `<circle cx="38" cy="51.8" r="2.6" fill="#FFF"/><circle cx="38.9" cy="51" r="1" fill="#3E4245"/>` +
    `<circle cx="58" cy="51.8" r="2.6" fill="#FFF"/><circle cx="58.9" cy="51" r="1" fill="#3E4245"/>` +
    nose(48, 60) + smile(48, 63, 5.8) + blush(28.5, 61) + blush(67.5, 61) },
  fawn: { bg: ["#F5F0DE", "#EBE3C6"], draw: () =>
    floppyEar(25, 49, -102, "#B08650", "#D9B77F") + floppyEar(71, 49, 102, "#B08650", "#D9B77F") +
    head("#C99A63") +
    `<circle cx="39" cy="37.5" r="1.9" fill="#EBD9B4"/><circle cx="54" cy="35.5" r="1.9" fill="#EBD9B4"/><circle cx="61" cy="42" r="1.9" fill="#EBD9B4"/>` +
    eye(38, 53) + eye(58, 53) + nose(48, 60.2) + smile(48, 63.6, 5.6) +
    blush(29.5, 60) + blush(66.5, 60) },
  owl: { bg: ["#F2ECDF", "#E7DCC8"], draw: () =>
    pointEar(28.5, 28.5, 0.92, -18, "#A98A6A") + pointEar(67.5, 28.5, 0.92, 18, "#A98A6A") +
    head("#A98A6A") +
    `<circle cx="37" cy="52" r="9.4" fill="#F4EBDD"/><circle cx="59" cy="52" r="9.4" fill="#F4EBDD"/>` +
    `<circle cx="37" cy="52" r="4.8" fill="#4A3B33"/><circle cx="59" cy="52" r="4.8" fill="#4A3B33"/>` +
    `<circle cx="38.5" cy="50.4" r="1.6" fill="#FFF"/><circle cx="60.5" cy="50.4" r="1.6" fill="#FFF"/>` +
    `<path d="M45.2 58.5 L50.8 58.5 L48 63.4 Z" fill="#F2A24B"/>` + blush(27.5, 62) + blush(68.5, 62) },
  seal: { bg: ["#E4F4F4", "#CFE9EA"], draw: () =>
    head("#BFD9DC") +
    eye(38.5, 52) + eye(57.5, 52) + nose(48, 58.2, "#7FA2A8") + smile(48, 61.2, 5.6) +
    `<circle cx="40.5" cy="60.2" r=".9" fill="#9DBEC3"/><circle cx="36" cy="58.2" r=".9" fill="#9DBEC3"/><circle cx="55.5" cy="60.2" r=".9" fill="#9DBEC3"/><circle cx="60" cy="58.2" r=".9" fill="#9DBEC3"/>` +
    blush(30, 58.5) + blush(66, 58.5) },
  octopus: { bg: ["#FFE9F3", "#FFD6E8"], draw: () =>
    head("#F49BC0") +
    `<path d="M31 80 Q35 74 40 79 M44 81 Q48 75 53 80 M57 79 Q62 74 66 79" stroke="#F49BC0" stroke-width="6.5" fill="none" stroke-linecap="round"/>` +
    eye(38.5, 53) + eye(57.5, 53) + smile(48, 61.5, 7.5) +
    `<circle cx="41.5" cy="39.5" r="1.4" fill="#E783AE"/><circle cx="54.5" cy="39.5" r="1.4" fill="#E783AE"/>` +
    blush(30, 59.5) + blush(66, 59.5) },
  whale: { bg: ["#E4F1FB", "#CFE4F6"], draw: () =>
    `<path d="M48 23.5 Q45.5 15.5 38.5 15.5 M48 23.5 Q50.5 15.5 57.5 15.5" stroke="#9CC3E5" stroke-width="2.4" fill="none" stroke-linecap="round"/>` +
    `<path d="M48 24.5 L48 18.5" stroke="#9CC3E5" stroke-width="2.4" stroke-linecap="round"/>` +
    head("#7FA8CF") +
    `<path d="M33.5 61 Q40.5 68 48 68 Q55.5 68 62.5 61 Q59.5 70 48 71 Q36.5 70 33.5 61 Z" fill="#A8C8E5"/>` +
    eye(38.5, 52) + eye(57.5, 52) + smile(48, 59, 7.5) +
    blush(30, 58) + blush(66, 58) },
  pig: { bg: ["#FFE9E6", "#FFD6D1"], draw: () =>
    floppyEar(27.5, 36.5, -24, "#F5A8A8", "#FAC6C3") + floppyEar(68.5, 36.5, 24, "#F5A8A8", "#FAC6C3") +
    head("#F5A8A8") +
    `<ellipse cx="48" cy="60.5" rx="8.6" ry="6.2" fill="#F58B8B"/>` +
    `<circle cx="45" cy="60.5" r="1.4" fill="#C96A6A"/><circle cx="51" cy="60.5" r="1.4" fill="#C96A6A"/>` +
    eye(37, 51) + eye(59, 51) + blush(28.5, 58) + blush(67.5, 58) },
  cow: { bg: ["#F8F6EF", "#EEEBDF"], draw: () =>
    `<path d="M37.5 24 Q34.5 17 28.5 16 M37.5 24 Q39.5 16.5 45 15.5 M58.5 24 Q61.5 17 67.5 16 M58.5 24 Q56.5 16.5 51 15.5" stroke="#D9C9A8" stroke-width="2.2" fill="none" stroke-linecap="round"/>` +
    roundEar(25.5, 38.5, 7.8, "#F5F2E9", "#E8CCC7") + roundEar(70.5, 38.5, 7.8, "#F5F2E9", "#E8CCC7") +
    head("#FDFCF8") +
    `<path d="M29 41 Q23 47 27 54.5 Q33 56.5 35 48.5 Q36 42 29 41 Z" fill="#4E565E"/>` +
    `<path d="M65.5 34.5 Q71.5 38.5 69.5 45.5 Q64.5 47.5 62.5 41.5 Z" fill="#4E565E"/>` +
    `<ellipse cx="48" cy="63" rx="11" ry="8" fill="#F0C8C4"/>` +
    `<circle cx="44.6" cy="63" r="1.5" fill="#C9968F"/><circle cx="51.4" cy="63" r="1.5" fill="#C9968F"/>` +
    eye(37.5, 52) + eye(58.5, 52) },
  lamb: { bg: ["#F7F4EA", "#EDE8D8"], draw: () =>
    floppyEar(25.5, 42.5, -26, "#5C534E") + floppyEar(70.5, 42.5, 26, "#5C534E") +
    `<path d="M28 44 Q23.5 36 31 32.5 Q29.5 24.5 38.5 26.5 Q40.5 19 48 21.5 Q55.5 19 57.5 26.5 Q66.5 24.5 65 32.5 Q72.5 36 68 44 Q71.5 51.5 65 55 L31 55 Q24.5 51.5 28 44 Z" fill="#F2EEE6"/>` +
    head("#C4B5A6") +
    eye(38.5, 55) + eye(57.5, 55) + nose(48, 61.8, "#8A7B70") + smile(48, 64.8, 5.2) +
    blush(30, 62) + blush(66, 62) },
  monkey: { bg: ["#F3EBDE", "#E9DEC9"], draw: () =>
    roundEar(24.5, 40.5, 9.2, "#A8825C", "#D9BC96") + roundEar(71.5, 40.5, 9.2, "#A8825C", "#D9BC96") +
    head("#A8825C") +
    `<path d="M33 56.5 Q31.5 43 44.5 41 Q48 44.5 51.5 41 Q64.5 43 63 56.5 Q59 70 48 71 Q37 70 33 56.5 Z" fill="#D9BC96"/>` +
    eye(38.5, 53) + eye(57.5, 53) + nose(48, 59.2, "#8A6A48") + smile(48, 62.8, 6.4) +
    blush(29.5, 60) + blush(66.5, 60) },
  tiger: { bg: ["#FFEBD6", "#FFDBB8"], draw: () =>
    roundEar(27.5, 34.5, 8.8, "#F2A65A", "#FFD9A8") + roundEar(68.5, 34.5, 8.8, "#F2A65A", "#FFD9A8") +
    head("#F2A65A") +
    `<path d="M44 30.5 L45.6 37 M52 30.5 L50.4 37 M38.5 33.5 L41 38.5 M57.5 33.5 L55 38.5" stroke="#C97B32" stroke-width="2" stroke-linecap="round"/>` +
    eye(38, 52) + eye(58, 52) + nose(48, 58.6) + omega(48, 61) +
    blush(29.5, 59.5) + blush(66.5, 59.5) },
  lion: { bg: ["#FFF2D6", "#FFE3AE"], draw: () =>
    `<circle cx="48" cy="53.5" r="32.5" fill="#D9983E"/>` +
    `<circle cx="48" cy="53.5" r="32.5" fill="url(#sh)"/>` +
    head("#E8B04B") +
    `<path d="M42.5 27.5 Q48 22.5 53.5 27.5" stroke="#C98F35" stroke-width="2" fill="none" stroke-linecap="round"/>` +
    eye(38.5, 52) + eye(57.5, 52) + nose(48, 58.6) + smile(48, 62.2, 6) +
    blush(29.5, 59.5) + blush(66.5, 59.5) },
  mushroom: { bg: ["#F1EAF7", "#E2D6F0"], draw: () =>
    `<path d="M23.5 52 Q23.5 27.5 48 27.5 Q72.5 27.5 72.5 52 Q72.5 54.8 69.4 54.8 L26.6 54.8 Q23.5 54.8 23.5 52 Z" fill="#E88A8A"/><path d="M23.5 52 Q23.5 27.5 48 27.5 Q72.5 27.5 72.5 52 Q72.5 54.8 69.4 54.8 L26.6 54.8 Q23.5 54.8 23.5 52 Z" fill="url(#sh)"/>` +
    `<circle cx="38.5" cy="38.5" r="3.9" fill="#FBEAEA"/><circle cx="57.5" cy="35.5" r="3.1" fill="#FBEAEA"/><circle cx="48.5" cy="46" r="2.5" fill="#FBEAEA"/><circle cx="65" cy="46.5" r="2.7" fill="#FBEAEA"/>` +
    `<path d="M34.5 54.8 L61.5 54.8 Q63.5 67 56 71.5 Q48 75.5 40 71.5 Q32.5 67 34.5 54.8 Z" fill="#FBF3E4"/>` +
    eye(41.5, 62) + eye(54.5, 62) + smile(48, 66.6, 5.6) + blush(35.5, 65.5) + blush(60.5, 65.5) },
  pudding: { bg: ["#FFF5DA", "#FFE9B8"], draw: () =>
    `<path d="M29 40.5 Q29 36 33.5 36 L62.5 36 Q67 36 67 40.5 Q68.8 50.5 64 55 L32 55 Q29.2 50.5 29 40.5 Z" fill="#D99A4E"/>` +
    `<path d="M29 40.5 Q29 36 33.5 36 L62.5 36 Q67 36 67 40.5 Q68.8 50.5 64 55 L32 55 Q29.2 50.5 29 40.5 Z" fill="url(#sh)"/>` +
    `<ellipse cx="40" cy="43" rx="7.5" ry="3.6" fill="#FFF" opacity=".32" transform="rotate(-14 40 43)"/>` +
    `<path d="M32 55 L64 55 Q67 69 58 74.2 Q48 78.8 38 74.2 Q29 69 32 55 Z" fill="#FFFDF2" stroke="#E8CFA0" stroke-width="1.4"/>` +
    eye(40.5, 62.5) + eye(55.5, 62.5) + smile(48, 67.2, 6) + blush(33, 66.8) + blush(63, 66.8) },
  riceball: { bg: ["#EDF5EE", "#DBEBDD"], draw: () =>
    `<path d="M48 23 Q57.5 30.5 67 44 Q76.5 57.5 71 67.5 Q63.5 77.5 48 77.5 Q32.5 77.5 25 67.5 Q19.5 57.5 29 44 Q38.5 30.5 48 23 Z" fill="#FDFDFB"/><path d="M48 23 Q57.5 30.5 67 44 Q76.5 57.5 71 67.5 Q63.5 77.5 48 77.5 Q32.5 77.5 25 67.5 Q19.5 57.5 29 44 Q38.5 30.5 48 23 Z" fill="url(#sh)"/>` +
    eye(39.5, 55.5) + eye(56.5, 55.5) + smile(48, 60.4, 6) + blush(31.5, 59.5) + blush(64.5, 59.5) +
    `<path d="M33 67.5 L63 67.5 Q64.5 74.5 59 77.3 L37 77.3 Q31.5 74.5 33 67.5 Z" fill="#3E5A44"/>` },
  cloud: { bg: ["#E4EFFA", "#D0E2F5"], draw: () =>
    `<path d="M30.5 68.5 Q18.5 68.5 18.5 57.5 Q18.5 47.5 28.5 47 Q28.5 36.5 40.5 35.5 Q46.5 27 58 30 Q69.5 32.5 70.5 43.5 Q79.5 45.5 78.5 56 Q77.5 67.5 66 68.5 Z" fill="#FDFDFB"/>` +
    `<path d="M30.5 68.5 Q18.5 68.5 18.5 57.5 Q18.5 47.5 28.5 47 Q28.5 36.5 40.5 35.5 Q46.5 27 58 30 Q69.5 32.5 70.5 43.5 Q79.5 45.5 78.5 56 Q77.5 67.5 66 68.5 Z" fill="url(#sh)"/>` +
    eye(39.5, 54.5) + eye(56.5, 54.5) + smile(48, 59.5, 6.5) + blush(31.5, 58.5) + blush(64.5, 58.5) },
};

const NAMES = [
  "cat", "shiba", "rabbit", "panda", "bear", "frog", "penguin", "fox", "chick", "otter",
  "dino", "hedgehog", "hamster", "koala", "raccoon", "fawn", "owl", "seal", "octopus", "whale",
  "pig", "cow", "lamb", "monkey", "tiger", "lion", "mushroom", "pudding", "riceball", "cloud",
];

function render(name, i) {
  const sp = SPECIES[name];
  if (!sp) throw new Error("missing species " + name);
  if (!sp.bg || sp.bg.length !== 2) throw new Error("bg 需要 [浅, 深] 两色: " + name);
  const n = String(i + 1).padStart(2, "0");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" role="img" aria-label="${name}">
<defs><clipPath id="c"><circle cx="48" cy="48" r="48"/></clipPath>
<linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sp.bg[0]}"/><stop offset="1" stop-color="${sp.bg[1]}"/></linearGradient>${FACE_GRAD}${BLUSH_GRAD}</defs>
<g clip-path="url(#c)">
<rect width="96" height="96" fill="url(#g)"/>
${sp.draw()}
</g>
</svg>\n`;
  writeFileSync(join(OUT, `${n}.svg`), svg, "utf8");
}

mkdirSync(OUT, { recursive: true });
if (NAMES.length !== 30) throw new Error(`期望 30 个物种，实际 ${NAMES.length}`);
NAMES.forEach(render);
console.log(`[gen-avatars] 30 张 → ${OUT}`);
