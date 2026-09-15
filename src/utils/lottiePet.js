/**
 * Lottie 宠物动画工厂
 * ------------------------------------------------------------
 * 不依赖外部素材：按「关节点 + 图层」的声明式配置，在运行时生成
 * 合法的 Lottie JSON（bodymovin v5），交给 lottie-web 播放。
 * 好处：体积小、风格统一、无版权问题，且随时可换成真实 Lottie 文件。
 *
 * 想换成美术给的 .json 素材：见 src/data/lottieAssets.js
 */
const FPS = 60;
const W = 220;
const H = 200;

/* —— 颜色：hex -> Lottie 的 0~1 三元组 —— */
function rgb(hex) {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

const still = (v) => ({ a: 0, k: v });

/** 关键帧：pairs = [[帧号, 值], ...]，值可为数字或数组 */
function keys(pairs) {
  return {
    a: 1,
    k: pairs.map(([t, v]) => ({
      t,
      s: Array.isArray(v) ? v : [v],
      i: { x: [0.36], y: [1] },
      o: { x: [0.64], y: [0] },
    })),
  };
}

/** 呼吸：胸腹轻微起伏，x 反向微缩更自然 */
function breathe(frames, amp = 3) {
  const open = [100 + amp * 0.35, 100 + amp, 100];
  return keys([
    [0, [100, 100, 100]],
    [frames / 2, open],
    [frames, [100, 100, 100]],
  ]);
}

/** 眨眼：缩放 Y 压扁 + 快速还原，可给多组时间点 */
function blink(frames, at = [110, 158]) {
  const out = [[0, [100, 100, 100]]];
  at.forEach((t) => {
    out.push([t, [100, 100, 100]]);
    out.push([t + 4, [100, 5, 100]]);
    out.push([t + 9, [100, 100, 100]]);
  });
  out.push([frames, [100, 100, 100]]);
  return keys(out);
}

/** 摇尾：以 pivot 为轴往复摆动 */
function wag(frames, deg = [-14, 12], times = null) {
  const seq = times || [0, 0.25, 0.5, 0.75, 1];
  return keys(seq.map((p, i) => [Math.round(frames * p), deg[i % 2]]));
}

/* —— 图层构件 —— */
function ellipseGroup(size, at, fill, opacity = 100) {
  return {
    ty: "gr",
    nm: "shape",
    it: [
      { ty: "el", nm: "el", p: still(at), s: still(size) },
      { ty: "fl", nm: "fl", c: still(rgb(fill)), o: still(opacity), r: 1 },
      {
        ty: "tr", nm: "tr",
        p: still([0, 0]), a: still([0, 0]),
        s: still([100, 100]), r: still(0), o: still(100),
        sk: still(0), sa: still(0),
      },
    ],
  };
}

/**
 * 统一动画字段：undefined -> 静止值；数组 -> 当作关键帧对；对象 -> 已是动画
 */
function anim(v, fallback) {
  if (v === undefined || v === null) return still(fallback);
  return Array.isArray(v) ? keys(v) : v;
}

/**
 * 生成一个形状图层
 * @param ind 图层序号
 * @param p   部件描述 { name,size,fill,opacity?,center?|pivot?+at?,scale?,rot?,dim? }
 */
function layer(ind, p) {
  const isPivot = !!p.pivot;
  const pos = isPivot ? p.pivot : p.center || [W / 2, H / 2];
  const at = isPivot ? p.at || [0, 0] : [0, 0];
  return {
    ddd: 0,
    ind,
    ty: 4,
    nm: p.name,
    sr: 1,
    ks: {
      o: still(p.dim ? 55 : 100),
      r: anim(p.rot, 0),
      p: still([pos[0], pos[1], 0]),
      a: still([0, 0, 0]),
      s: anim(p.scale, [100, 100, 100]),
    },
    ao: 0,
    shapes: [ellipseGroup(p.size, at, p.fill, p.opacity == null ? 100 : p.opacity)],
    ip: 0,
    op: 0, // 由组装函数统一填充
    st: 0,
    bm: 0,
  };
}

/** 把「从后到前」的部件数组组装成 Lottie 文档（图层顺序需反转） */
function build(parts, frames, name) {
  const layers = parts
    .slice()
    .reverse()
    .map((p, i) => layer(i + 1, Object.assign({}, p, { _i: i })));
  layers.forEach((l) => { l.op = frames; });
  return {
    v: "5.7.4",
    fr: FPS,
    ip: 0,
    op: frames,
    w: W,
    h: H,
    nm: name,
    ddd: 0,
    assets: [],
    layers,
  };
}

export const LOTTIE_META = { W, H, FPS };

/* ═════════ 宠物造型规格（从后到前的绘制顺序） ═════════ */

/** 睡觉时眼睛压成一条缝 */
const sleepEye = (frames) => keys([[0, [100, 9, 100]], [frames, [100, 9, 100]]]);

/** 耳朵「抖一下」的关键帧 */
const earTwitch = (frames, at = 108) => keys([
  [0, 0], [at, 0], [at + 6, -7], [at + 12, 2], [at + 18, 0], [frames, 0],
]);

/** 通用眼睛（含高光）*/
function eyes({ l, r, y, size, color, frames, sleep, dim }) {
  const sc = sleep ? sleepEye(frames) : blink(frames, [110, 158]);
  const [w, h] = size;
  return [
    { name: "eyeL", center: [l, y], size: [w, h], fill: color, scale: sc },
    { name: "eyeR", center: [r, y], size: [w, h], fill: color, scale: sc },
    { name: "hlL", center: [l + 4, y - 5], size: [5, 5], fill: "#FFFFFF", opacity: 88 },
    { name: "hlR", center: [r + 4, y - 5], size: [5, 5], fill: "#FFFFFF", opacity: 88 },
  ];
}

/** 通用腮红 */
function blush(l, r, y, fill = "#FFB3A0") {
  return [
    { name: "blushL", center: [l, y], size: [19, 10], fill, dim: true },
    { name: "blushR", center: [r, y], size: [19, 10], fill, dim: true },
  ];
}

/* —— 🐱 小橘猫 —— */
function cat(c) {
  const { frames, sleep } = c;
  return [
    { name: "tail", pivot: [166, 146], at: [13, -15], size: [26, 32], fill: "#F0A15E",
      rot: sleep ? keys([[0, -7], [frames, -3]]) : wag(frames, [-15, 13]) },
    { name: "body", center: [110, 150], size: [96, 72], fill: "#F5B678",
      scale: breathe(frames, sleep ? 5 : 3) },
    { name: "pawL", center: [88, 176], size: [28, 18], fill: "#FFE6CB" },
    { name: "pawR", center: [132, 176], size: [28, 18], fill: "#FFE6CB" },
    { name: "belly", center: [110, 160], size: [56, 46], fill: "#FFE6CB", opacity: 72 },
    { name: "earL", pivot: [80, 74], at: [-4, -22], size: [26, 34], fill: "#F0A15E",
      rot: sleep ? keys([[0, 0], [frames, 0]]) : earTwitch(frames, 120) },
    { name: "earR", pivot: [140, 74], at: [4, -22], size: [26, 34], fill: "#F0A15E" },
    { name: "earInL", pivot: [80, 78], at: [-4, -20], size: [13, 20], fill: "#FFC9B0" },
    { name: "earInR", pivot: [140, 78], at: [4, -20], size: [13, 20], fill: "#FFC9B0" },
    { name: "head", center: [110, 102], size: [92, 84], fill: "#F7BE84",
      scale: breathe(frames, sleep ? 4 : 2.4) },
    ...blush(74, 146, 122),
    { name: "muzzle", center: [110, 122], size: [34, 24], fill: "#FFE6CB" },
    { name: "nose", center: [110, 115], size: [10, 8], fill: "#F2897F" },
    ...eyes({ l: 88, r: 132, y: 104, size: [13, 16], color: "#4A3B2F", frames, sleep }),
  ];
}

/* —— 🐕 柴柴 —— */
function dog(c) {
  const { frames, sleep } = c;
  return [
    { name: "tail", pivot: [170, 138], at: [13, -16], size: [30, 26], fill: "#D98F4C",
      rot: sleep ? keys([[0, -9], [frames, -4]]) : wag(frames, [-24, 17]) },
    { name: "body", center: [110, 152], size: [98, 70], fill: "#E9A05A",
      scale: breathe(frames, sleep ? 5 : 3) },
    { name: "pawL", center: [88, 178], size: [28, 18], fill: "#FFF3E0" },
    { name: "pawR", center: [132, 178], size: [28, 18], fill: "#FFF3E0" },
    { name: "belly", center: [110, 162], size: [54, 44], fill: "#FFF3E0", opacity: 78 },
    { name: "earL", pivot: [76, 74], at: [-6, -24], size: [28, 32], fill: "#D98F4C",
      rot: sleep ? keys([[0, 0], [frames, 0]]) : earTwitch(frames, 96) },
    { name: "earR", pivot: [144, 74], at: [6, -24], size: [28, 32], fill: "#D98F4C" },
    { name: "head", center: [110, 102], size: [96, 86], fill: "#EDAE6A",
      scale: breathe(frames, sleep ? 4 : 2.4) },
    ...blush(72, 148, 118),
    { name: "muzzle", center: [110, 120], size: [44, 32], fill: "#FFF3E0" },
    { name: "nose", center: [110, 110], size: [13, 10], fill: "#4A3B2F" },
    ...eyes({ l: 86, r: 134, y: 100, size: [12, 15], color: "#3E3128", frames, sleep }),
  ];
}

/* —— 🐰 麻薯兔 —— */
function rabbit(c) {
  const { frames, sleep } = c;
  return [
    { name: "tail", center: [172, 152], size: [26, 26], fill: "#FFFFFF", opacity: 95 },
    { name: "body", center: [110, 152], size: [90, 66], fill: "#FFF6EE",
      scale: breathe(frames, sleep ? 5 : 3) },
    { name: "footL", center: [90, 178], size: [26, 16], fill: "#FFFFFF" },
    { name: "footR", center: [130, 178], size: [26, 16], fill: "#FFFFFF" },
    { name: "belly", center: [110, 160], size: [52, 42], fill: "#FFFFFF", opacity: 85 },
    { name: "earL", pivot: [94, 78], at: [-3, -34], size: [22, 62], fill: "#FFF6EE",
      rot: sleep ? keys([[0, 4], [frames, 6]]) : earTwitch(frames, 132) },
    { name: "earR", pivot: [126, 78], at: [3, -34], size: [22, 62], fill: "#FFF6EE",
      rot: sleep ? keys([[0, -4], [frames, -6]]) : earTwitch(frames, 138) },
    { name: "earInL", pivot: [94, 86], at: [-3, -30], size: [11, 46], fill: "#FFCDD8" },
    { name: "earInR", pivot: [126, 86], at: [3, -30], size: [11, 46], fill: "#FFCDD8" },
    { name: "head", center: [110, 106], size: [84, 78], fill: "#FFF6EE",
      scale: breathe(frames, sleep ? 4 : 2.4) },
    ...blush(78, 142, 124, "#FFC3CC"),
    { name: "mouth", center: [110, 126], size: [18, 10], fill: "#FFCDD8", opacity: 85 },
    { name: "nose", center: [110, 117], size: [9, 7], fill: "#F5A0AE" },
    ...eyes({ l: 90, r: 130, y: 106, size: [12, 15], color: "#5A4A44", frames, sleep }),
  ];
}

/* —— 🦖 小恐龙 —— */
function dino(c) {
  const { frames, sleep } = c;
  return [
    { name: "tail", pivot: [168, 144], at: [16, -4], size: [48, 26], fill: "#9BD3A8",
      rot: sleep ? keys([[0, -6], [frames, -3]]) : wag(frames, [-11, 11]) },
    { name: "body", center: [110, 152], size: [94, 68], fill: "#9BD3A8",
      scale: breathe(frames, sleep ? 5 : 3) },
    { name: "footL", center: [88, 178], size: [30, 16], fill: "#8AC79A" },
    { name: "footR", center: [132, 178], size: [30, 16], fill: "#8AC79A" },
    { name: "belly", center: [110, 162], size: [54, 44], fill: "#EAF7E4", opacity: 85 },
    { name: "spikeL", center: [96, 66], size: [18, 22], fill: "#7FC08F",
      scale: sleep ? undefined : breathe(frames, 3) },
    { name: "spikeM", center: [110, 58], size: [19, 24], fill: "#7FC08F" },
    { name: "spikeR", center: [124, 66], size: [18, 22], fill: "#7FC08F" },
    { name: "head", center: [110, 102], size: [88, 80], fill: "#A6DBB2",
      scale: breathe(frames, sleep ? 4 : 2.4) },
    ...blush(74, 146, 122),
    { name: "nostrilL", center: [102, 116], size: [6, 5], fill: "#7FC08F" },
    { name: "nostrilR", center: [118, 116], size: [6, 5], fill: "#7FC08F" },
    ...eyes({ l: 88, r: 132, y: 104, size: [13, 15], color: "#3E4A3C", frames, sleep }),
  ];
}

/* —— 🦦 水獭 —— */
function otter(c) {
  const { frames, sleep } = c;
  return [
    { name: "tail", pivot: [170, 150], at: [20, 0], size: [46, 20], fill: "#B98A6A",
      rot: sleep ? keys([[0, -5], [frames, -2]]) : wag(frames, [-9, 9]) },
    { name: "body", center: [110, 152], size: [92, 68], fill: "#C29170",
      scale: breathe(frames, sleep ? 5 : 3) },
    { name: "pawL", center: [88, 178], size: [26, 16], fill: "#C29170" },
    { name: "pawR", center: [132, 178], size: [26, 16], fill: "#C29170" },
    { name: "belly", center: [110, 162], size: [54, 42], fill: "#F3E0CE", opacity: 88 },
    { name: "head", center: [110, 102], size: [88, 80], fill: "#C99A79",
      scale: breathe(frames, sleep ? 4 : 2.4) },
    { name: "earL", center: [78, 80], size: [18, 18], fill: "#B98A6A",
      scale: sleep ? sleepEye(frames) : keys([[0, [100, 100, 100]], [frames, [100, 100, 100]]]) },
    { name: "earR", center: [142, 80], size: [18, 18], fill: "#B98A6A" },
    ...blush(74, 146, 120),
    { name: "muzzle", center: [110, 122], size: [40, 28], fill: "#F3E0CE" },
    { name: "nose", center: [110, 113], size: [11, 9], fill: "#4A3B2F" },
    ...eyes({ l: 88, r: 132, y: 102, size: [12, 14], color: "#42342C", frames, sleep }),
  ];
}

/* ═════════ 组装与缓存 ═════════ */
const SHAPES = { cat, dog, rabbit, dino, otter };

const VARIANTS = {
  idle: { frames: 180, sleep: false },
  sleep: { frames: 240, sleep: true },
};

const cache = {};

/** 取某只宠物的 Lottie 动画数据；species 不是预设宠物时返回 null */
export function petAnimation(species, variant = "idle") {
  if (!SHAPES[species]) return null;
  const key = species + ":" + variant;
  if (cache[key]) return cache[key];
  const cfg = VARIANTS[variant] || VARIANTS.idle;
  cache[key] = build(SHAPES[species](cfg), cfg.frames, species + "-" + variant);
  return cache[key];
}

export const hasPreset = (species) => !!SHAPES[species];

