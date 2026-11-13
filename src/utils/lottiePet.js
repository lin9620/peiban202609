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
function ellipseGroup(size, at, fill, opacity = 100, stroke = null, weight = 3) {
  const it = [
    { ty: "el", nm: "el", p: still(at), s: still(size) },
    { ty: "fl", nm: "fl", c: still(rgb(fill)), o: still(opacity), r: 1 },
  ];
  /* #11 贴纸风描边：主体件带一圈深一号的边，立刻从「色块」变「形象」 */
  if (stroke) it.push({ ty: "st", nm: "st", c: still(rgb(stroke)), o: still(100), w: still(weight), lc: 2, lj: 2 });
  return {
    ty: "gr",
    nm: "shape",
    it: it.concat([
      {
        ty: "tr", nm: "tr",
        p: still([0, 0]), a: still([0, 0]),
        s: still([100, 100]), r: still(0), o: still(100),
        sk: still(0), sa: still(0),
      },
    ]),
  };
}

/** 贝塞尔路径组：p.path = { c, v, o, i }（顶点为相对 center 的局部坐标）；
 *  同时给 fill + stroke 时先填色再描边，做出贴纸轮廓。 */
function pathGroup(p) {
  const d = p.path;
  const it = [
    {
      ty: "sh", nm: "sh",
      ks: { a: 0, k: { c: d.c !== false, v: d.v, o: d.o, i: d.i } },
    },
  ];
  if (p.fill) {
    it.push({ ty: "fl", nm: "fl", c: still(rgb(p.fill)), o: still(p.fillOpacity == null ? (p.opacity == null ? 100 : p.opacity) : p.fillOpacity), r: 1 });
  }
  if (p.stroke) {
    it.push({
      ty: "st", nm: "st", c: still(rgb(p.stroke)),
      o: still(p.strokeOpacity == null ? (p.opacity == null ? 100 : p.opacity) : p.strokeOpacity),
      w: still(p.weight || 2.5), lc: 2, lj: 2,
    });
  }
  it.push({
    ty: "tr", nm: "tr",
    p: still([0, 0]), a: still([0, 0]),
    s: still([100, 100]), r: still(0), o: still(100),
    sk: still(0), sa: still(0),
  });
  return { ty: "gr", nm: "path", it };
}

/**
 * 统一动画字段：undefined -> 静止值；数组 -> 当作关键帧对；对象 -> 已是动画
 */
function anim(v, fallback) {
  if (v === undefined || v === null) return still(fallback);
  if (typeof v === "number") return still(v);
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
      o: anim(p.opac, p.dim ? 55 : (p.opacity == null ? 100 : p.opacity)),
      r: anim(p.rot, 0),
      p: anim(p.pos, [pos[0], pos[1], 0]),
      a: still([0, 0, 0]),
      s: anim(p.scale, [100, 100, 100]),
    },
    ao: 0,
    shapes: p.shapes || [p.path ? pathGroup(p) : ellipseGroup(p.size, at, p.fill, p.opacity == null ? 100 : p.opacity, p.stroke || null, p.weight || 3)],
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
function eyes({ l, r, y, size, color, frames, sleep, dim, mood }) {
  const [w, h] = size;
  /* #11 互动表情：happy/clean 换成「开心弯弯眼」（∩ 弧）——比圆点眼更有情绪 */
  if (!sleep && (mood === "happy" || mood === "clean")) {
    const arc = (cx, nm) => ({
      name: nm,
      center: [cx, y],
      path: {
        c: false,
        v: [[cx - w * 0.42, y + 2.6], [cx, y - 3.4], [cx + w * 0.42, y + 2.6]],
        i: [[-w * 0.26, 0], [0, 0], [w * 0.26, 0]],
        o: [[w * 0.26, 0], [0, 0], [-w * 0.26, 0]],
      },
      stroke: color, weight: 3.2,
    });
    return [arc(l, "eyeArcL"), arc(r, "eyeArcR")];
  }
  const sc = sleep ? sleepEye(frames) : blink(frames, [110, 158]);
  return [
    { name: "eyeL", center: [l, y], size: [w, h], fill: color, scale: sc },
    { name: "eyeR", center: [r, y], size: [w, h], fill: color, scale: sc },
    { name: "hlL", center: [l + 4, y - 5], size: [5, 5], fill: "#FFFFFF", opacity: 88 },
    { name: "hlR", center: [r + 4, y - 5], size: [5, 5], fill: "#FFFFFF", opacity: 88 },
    { name: "hl2L", center: [l - 3, y + 4], size: [3, 3], fill: "#FFFFFF", opacity: 55 },
    { name: "hl2R", center: [r - 3, y + 4], size: [3, 3], fill: "#FFFFFF", opacity: 55 },
  ];
}

/** #11 互动嘴型：happy/play/eat 用张嘴笑，平时/睡觉用微笑弧（统一返回数组，调用点用 ... 展开） */
function mouthFor(c, cx, y, w, color, tongue) {
  const m = c.mood || "idle";
  if (!c.sleep && (m === "happy" || m === "play" || m === "eat")) return openMouth(cx, y, color, tongue);
  return [smile(cx, y, w, c.sleep, color)];
}

/** 微笑嘴（贝塞尔描边；k=开心弧度，睡觉时压平）
 *  注意：路径顶点是相对 center 的局部坐标，图层位置才是 center。 */
function smile(cx, y, w = 22, sleep = false, color = "#B0714F") {
  const k = sleep ? 2 : 6;
  return {
    name: "smile", center: [cx, y],
    path: {
      c: false,
      v: [[-w / 2, -k * 0.2], [0, k], [w / 2, -k * 0.2]],
      i: [[w * 0.22, 0], [0, 0], [-w * 0.22, 0]],
      o: [[-w * 0.22, 0], [0, 0], [w * 0.22, 0]],
    },
    stroke: color, weight: 3,
  };
}

/** 张嘴笑（实心小半圆，比微笑更 Q；睡时不用） */
function openMouth(cx, y, color = "#8C5A44", tongue = "#FF9AA8") {
  return [
    {
      name: "mouthO", center: [cx, y],
      path: {
        c: true,
        v: [[-9, 0], [0, 9], [9, 0]],
        i: [[0, -5], [6, -1], [-6, -1]],
        o: [[0, 5], [-6, 1], [6, 1]],
      },
      fill: color,
    },
    {
      name: "tongue", center: [cx, y + 5],
      path: {
        c: true,
        v: [[-5, -2], [0, 5], [5, -2]],
        i: [[0, -2], [3, 0], [-3, 0]],
        o: [[0, 2], [-3, 0], [3, 0]],
      },
      fill: tongue,
    },
  ];
}

/** 漂浮小心心（贝塞尔实心 + 上飘 + 呼吸透明度） */
function heart(cx, y, s = 1, frames = 120, offset = 0) {
  const u = 6 * s;
  const bob = (t) => y - t;
  return {
    name: "heart",
    center: [cx, y],
    pos: keys([
      [1 + offset, [cx, bob(0), 0]],
      [Math.floor(frames / 2), [cx + 2 * s, bob(8 * s), 0]],
      [frames + offset, [cx, bob(16 * s), 0]],
    ]),
    opac: keys([
      [1 + offset, 0], [Math.floor(frames / 3), 80], [frames + offset, 0],
    ]),
    path: {
      c: true,
      /* 经典心形：上凹槽 → 左心瓣 → 下尖 → 右心瓣 */
      v: [[0, -u * 0.55], [-u * 1.2, -u * 0.15], [0, u * 1.35], [u * 1.2, -u * 0.15]],
      i: [[u * 0.2, -u * 0.55], [0, -u * 0.9], [-u * 0.45, -u * 0.4], [0, u * 0.6]],
      o: [[-u * 0.2, -u * 0.55], [0, u * 0.6], [u * 0.45, -u * 0.4], [0, -u * 0.9]],
    },
    fill: "#FF8FA3",
  };
}

function blush(l, r, y, fill = "#FFB3A0", w = 19, h = 10, opacity = 55) {
  return [
    { name: "blushL", center: [l, y], size: [w, h], fill, opac: still(opacity) },
    { name: "blushR", center: [r, y], size: [w, h], fill, opac: still(opacity) },
  ];
}

/** #11 细直线（胡须/ZZZ 折线共用）；p1→p2 直线描边 */
function line(p1, p2, color, weight = 2, opacity = 100, name = "line") {
  return {
    name,
    center: [p1[0], p1[1]],
    path: { c: false, v: [[0, 0], [p2[0] - p1[0], p2[1] - p1[1]]], i: [[0, 0], [0, 0]], o: [[0, 0], [0, 0]] },
    stroke: color, weight, opac: still(opacity),
  };
}

/** #11 四角星星（洗澡/玩耍的闪光粒子）：缩放弹出 + 旋转 */
function sparkle(cx, y, s = 1, frames = 110, offset = 0) {
  const u = 8 * s;
  const star = {
    name: "sparkle",
    center: [cx, y],
    path: {
      c: true,
      v: [[0, -u], [u * 0.26, -u * 0.26], [u, 0], [u * 0.26, u * 0.26],
          [0, u], [-u * 0.26, u * 0.26], [-u, 0], [-u * 0.26, -u * 0.26]],
      i: [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0]],
      o: [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0]],
    },
    fill: "#FFD98E",
    rot: keys([[1 + offset, 0], [Math.floor(frames / 2), 90], [frames + offset, 180]]),
    scale: keys([
      [1 + offset, [0, 0, 100]],
      [Math.floor(frames / 3) + offset, [100, 100, 100]],
      [Math.floor(frames * 0.6) + offset, [128, 128, 100]],
      [frames + offset, [0, 0, 100]],
    ]),
    opac: keys([[1 + offset, 0], [Math.floor(frames / 3) + offset, 95], [frames + offset, 0]]),
  };
  star.name = "sparkle" + (offset || 0);
  return star;
}

/** #11 睡觉 Zzz：两枚折线「Z」错拍上飘 */
function zzz(cx, y, frames = 240) {
  const zPath = (w, h) => ({
    c: false,
    v: [[0, 0], [w, 0], [0, h], [w, h]],
    i: [[0, 0], [0, 0], [0, 0], [0, 0]],
    o: [[0, 0], [0, 0], [0, 0], [0, 0]],
  });
  const one = (dx, dy, s, t0) => {
    const l = {
      name: "zzz" + t0,
      center: [cx + dx, y + dy],
      path: zPath(9 * s, 11 * s),
      stroke: "#9BB0D8", weight: 3,
      pos: keys([
        [t0, [cx + dx, y + dy, 0]],
        [t0 + Math.floor(frames / 2), [cx + dx + 6 * s, y + dy - 14 * s, 0]],
        [frames, [cx + dx + 10 * s, y + dy - 26 * s, 0]],
      ]),
      opac: keys([[t0, 0], [t0 + 20, 85], [frames, 0]]),
    };
    return l;
  };
  return [one(0, 0, 1, 6), one(16, -6, 0.72, 66)];
}

/* ═════════ 路径造型工具（手绘小橘猫用） ═════════ */

/** 解析绝对 SVG 路径（M/L/C/Q/Z）为 Lottie 路径数据。
 *  只服务内置造型：每条路径一个子路径，不做相对指令和圆弧。 */
function parsePath(d) {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) || [];
  let i = 0;
  let cmd = "";
  let cx = 0, cy = 0, startX = 0, startY = 0;
  let closed = false;
  const v = [], inH = [], outH = [];
  const num = () => Number(tokens[i++]);
  const add = (x, y, inx = 0, iny = 0, outx = 0, outy = 0) => {
    v.push([x, y]); inH.push([inx, iny]); outH.push([outx, outy]);
  };
  const setOut = (ox, oy) => { if (v.length) outH[v.length - 1] = [ox, oy]; };
  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[a-zA-Z]$/.test(t)) { cmd = t.toUpperCase(); i++; }
    else if (!cmd) { i++; continue; }
    if (cmd === "M") {
      const x = num(), y = num();
      add(x, y); cx = x; cy = y; startX = x; startY = y; cmd = "L";
    } else if (cmd === "L") {
      const x = num(), y = num();
      add(x, y); cx = x; cy = y;
    } else if (cmd === "C") {
      const x1 = num(), y1 = num(), x2 = num(), y2 = num(), x = num(), y = num();
      setOut(x1 - cx, y1 - cy);
      add(x, y, x2 - x, y2 - y);
      cx = x; cy = y;
    } else if (cmd === "Q") {
      const x1 = num(), y1 = num(), x = num(), y = num();
      const c1x = cx + (2 / 3) * (x1 - cx), c1y = cy + (2 / 3) * (y1 - cy);
      const c2x = x + (2 / 3) * (x1 - x), c2y = y + (2 / 3) * (y1 - y);
      setOut(c1x - cx, c1y - cy);
      add(x, y, c2x - x, c2y - y);
      cx = x; cy = y;
    } else if (cmd === "Z") {
      closed = true;
      if (v.length > 1) {
        const [lx, ly] = v[v.length - 1];
        if (Math.abs(lx - startX) < 0.01 && Math.abs(ly - startY) < 0.01) {
          inH[0] = inH[v.length - 1];
          v.pop(); inH.pop(); outH.pop();
        }
      }
      if (i < tokens.length && !/^[a-zA-Z]$/.test(tokens[i])) break;
    } else {
      i++;
    }
  }
  return { c: closed, v, i: inH, o: outH };
}

function localizePath(path, center) {
  return {
    c: path.c,
    v: path.v.map(([x, y]) => [x - center[0], y - center[1]]),
    i: path.i,
    o: path.o,
  };
}

function catPart(name, center, d, fill, opts = {}) {
  return Object.assign({
    name, center, path: localizePath(parsePath(d), center), fill,
  }, opts);
}

function catStroke(name, center, d, color, weight = 2.5, opacity = 100, rot) {
  return catPart(name, center, d, null, {
    stroke: color, weight, strokeOpacity: opacity, rot,
  });
}

const CAT = {
  fur: "#F3A05A",
  furDark: "#D9772F",
  cream: "#FFF0D8",
  outline: "#A95524",
  innerEar: "#FFB9A8",
  nose: "#E9786F",
  eye: "#3B2A22",
  mouth: "#9C5138",
  blush: "#F28E7E",
  shadow: "#6B3A1F",
};

/** 猫眼：眼白高光跟眼睛同层，眨眼时一起压扁，不会留下悬空白点。 */
function catEye(name, cx, cy, scale, sleep, mood) {
  if (!sleep && (mood === "happy" || mood === "clean")) {
    const arcName = name === "eyeL" ? "eyeArcL" : "eyeArcR";
    return {
      name: arcName, center: [cx, cy],
      path: localizePath(parsePath(`M${cx - 9} ${cy + 2} C${cx - 4} ${cy - 5} ${cx + 4} ${cy - 5} ${cx + 9} ${cy + 2}`), [cx, cy]),
      stroke: CAT.eye, weight: 3.6,
    };
  }
  return {
    name, center: [cx, cy], scale,
    /* Lottie 形状组按数组倒序绘制：数组最后的眼睛底色先画（最下层），高光后画（最上层） */
    shapes: [
      ellipseGroup([3.2, 3.2], [-5, 5], "#FFFFFF", 58),
      ellipseGroup([7, 7], [5, -7], "#FFFFFF", 92),
      ellipseGroup([22, 25], [0, 0], CAT.eye, 100),
    ],
  };
}

/** 猫嘴：平时是 w 形微笑，开心/玩耍/吃饭换成张嘴。 */
function catMouth(c, cx, y, w) {
  const m = c.mood || "idle";
  if (!c.sleep && (m === "happy" || m === "play" || m === "eat")) {
    return openMouth(cx, y, CAT.mouth, "#FF9AA8");
  }
  const k = c.sleep ? 1.5 : 3.6;
  return [
    catStroke("smile", [cx, y], `M${cx - w / 2} ${y - 1} C${cx - w / 4} ${y + k} ${cx - 3} ${y + k} ${cx} ${y} C${cx + 3} ${y + k} ${cx + w / 4} ${y + k} ${cx + w / 2} ${y - 1}`, CAT.mouth, 2.4),
    catStroke("smileStem", [cx, y - 4], `M${cx} ${y - 6} L${cx} ${y}`, CAT.mouth, 2.2),
  ];
}

function catWhiskers() {
  const color = "#B76A4B";
  return [
    catStroke("wsk1", [88, 107], "M88 107 C76 105 64 103 54 99", color, 2, 55),
    catStroke("wsk2", [88, 112], "M88 112 C74 112 62 112 51 112", color, 2, 55),
    catStroke("wsk3", [88, 117], "M88 117 C76 119 65 122 55 126", color, 2, 55),
    catStroke("wsk4", [132, 107], "M132 107 C144 105 156 103 166 99", color, 2, 55),
    catStroke("wsk5", [132, 112], "M132 112 C146 112 158 112 169 112", color, 2, 55),
    catStroke("wsk6", [132, 117], "M132 117 C144 119 155 122 165 126", color, 2, 55),
  ];
}

/* —— 🐱 小橘猫 —— */
function cat(c) {
  const { frames, sleep } = c;
  const mood = c.mood || "idle";
  const tailRot = sleep ? keys([[0, -5], [frames, -2]]) : wag(frames, [-12, 10]);
  const earRot = sleep ? 0 : earTwitch(frames, 116);
  const breath = breathe(frames, sleep ? 4.5 : 2.6);
  const eyeScale = sleep ? sleepEye(frames) : blink(frames, [104, 156]);

  const tailD = "M154 178 C176 184 194 174 198 154 C202 136 194 120 182 116 C176 114 170 116 168 122";
  const bodyD = "M110 105 C90 105 74 116 66 133 C58 150 60 170 68 182 C76 193 92 196 110 196 C128 196 144 193 152 182 C160 170 162 150 154 133 C146 116 130 105 110 105 Z";
  const bellyD = "M110 120 C94 120 84 136 84 158 C84 178 94 187 110 187 C126 187 136 178 136 158 C136 136 126 120 110 120 Z";
  const headD = "M110 33 C91 33 75 39 64 50 C56 58 52 68 50 79 C48 89 48 98 52 106 C56 116 64 124 76 128 C88 132 100 133 110 133 C120 133 132 132 144 128 C156 124 164 116 168 106 C172 98 172 89 170 79 C168 68 164 58 156 50 C145 39 129 33 110 33 Z";
  const earLD = "M66 60 C56 48 48 30 52 20 C54 14 60 14 66 20 C76 30 86 42 92 52 C94 56 91 60 86 61 Z";
  const earRD = "M154 60 C164 48 172 30 168 20 C166 14 160 14 154 20 C144 30 134 42 128 52 C126 56 129 60 134 61 Z";
  const earInLD = "M62 54 C56 43 52 32 55 27 C57 23 61 25 66 30 C73 37 80 45 84 50 C86 53 84 55 80 55 Z";
  const earInRD = "M158 54 C164 43 168 32 165 27 C163 23 159 25 154 30 C147 37 140 45 136 50 C134 53 136 55 140 55 Z";
  const pawLD = "M84 173 C74 173 68 179 68 186 C68 193 75 197 84 197 C93 197 100 193 100 186 C100 179 94 173 84 173 Z";
  const pawRD = "M136 173 C126 173 120 179 120 186 C120 193 127 197 136 197 C145 197 152 193 152 186 C152 179 146 173 136 173 Z";
  const noseD = "M110 98 C113 98 116 100 116 103 C116 106 113 108 110 108 C107 108 104 106 104 103 C104 100 107 98 110 98 Z";

  return [
    { name: "shadow", center: [110, 196], size: [118, 14], fill: CAT.shadow, opac: still(12) },

    /* 尾巴：三层叠出「深色轮廓 + 橘色毛 + 奶色尾尖」 */
    { name: "tailOutline", pivot: [154, 176], path: localizePath(parsePath(tailD), [154, 176]), stroke: CAT.outline, weight: 19, rot: tailRot },
    { name: "tail", pivot: [154, 176], path: localizePath(parsePath(tailD), [154, 176]), stroke: CAT.fur, weight: 13, rot: tailRot },
    catStroke("tailStripe1", [154, 176], "M188 164 L196 158", CAT.furDark, 6, 55, tailRot),
    catStroke("tailStripe2", [154, 176], "M194 146 L200 140", CAT.furDark, 5, 55, tailRot),
    catStroke("tailStripe3", [154, 176], "M188 130 L194 124", CAT.furDark, 5, 55, tailRot),
    { name: "tailTip", pivot: [154, 176], at: [14, -54], size: [20, 20], fill: CAT.cream, stroke: CAT.outline, weight: 2.5, rot: tailRot },

    catPart("body", [110, 150], bodyD, CAT.fur, { stroke: CAT.outline, weight: 3.5, scale: breath }),
    catPart("belly", [110, 150], bellyD, CAT.cream, { scale: breath }),

    catPart("pawL", [84, 185], pawLD, CAT.cream, { stroke: CAT.outline, weight: 2.5 }),
    catPart("pawR", [136, 185], pawRD, CAT.cream, { stroke: CAT.outline, weight: 2.5 }),
    catStroke("toeL1", [80, 192], "M80 189 L80 195", CAT.outline, 2, 50),
    catStroke("toeL2", [88, 192], "M88 189 L88 195", CAT.outline, 2, 50),
    catStroke("toeR1", [132, 192], "M132 189 L132 195", CAT.outline, 2, 50),
    catStroke("toeR2", [140, 192], "M140 189 L140 195", CAT.outline, 2, 50),

    catPart("earL", [80, 62], earLD, CAT.fur, { stroke: CAT.outline, weight: 3.2, rot: earRot }),
    catPart("earInL", [80, 62], earInLD, CAT.innerEar, { rot: earRot }),
    catPart("earR", [140, 62], earRD, CAT.fur, { stroke: CAT.outline, weight: 3.2, rot: earRot }),
    catPart("earInR", [140, 62], earInRD, CAT.innerEar, { rot: earRot }),

    catPart("head", [110, 84], headD, CAT.fur, { stroke: CAT.outline, weight: 3.5 }),

    catStroke("stripeM", [110, 52], "M110 43 C109 50 109 56 110 62", CAT.furDark, 5, 75),
    catStroke("stripeL", [96, 50], "M96 43 C94 49 93 55 93 60", CAT.furDark, 4, 70),
    catStroke("stripeR", [124, 50], "M124 43 C126 49 127 55 127 60", CAT.furDark, 4, 70),
    catStroke("cheekL1", [63, 94], "M53 93 C60 91 66 91 72 93", CAT.furDark, 3.5, 55),
    catStroke("cheekL2", [62, 102], "M52 102 C59 100 65 100 71 102", CAT.furDark, 3.5, 55),
    catStroke("cheekR1", [157, 94], "M148 93 C154 91 160 91 167 93", CAT.furDark, 3.5, 55),
    catStroke("cheekR2", [158, 102], "M149 102 C155 100 161 100 168 102", CAT.furDark, 3.5, 55),

    ...blush(68, 152, 106, CAT.blush, 24, 12, 45),

    { name: "muzzleL", center: [100, 110], size: [30, 24], fill: CAT.cream },
    { name: "muzzleR", center: [120, 110], size: [30, 24], fill: CAT.cream },
    catPart("nose", [110, 103], noseD, CAT.nose),

    ...catMouth(c, 110, 112, 26),
    ...catWhiskers(),
    catEye("eyeL", 84, 84, eyeScale, sleep, mood),
    catEye("eyeR", 136, 84, eyeScale, sleep, mood),
  ];
}

/* —— 🐕 柴柴 —— */
function dog(c) {
  const { frames, sleep } = c;
  return [
    { name: "tail", pivot: [170, 138], stroke: "#C77F3F", weight: 10,
      path: { c: false, v: [[0, 0], [8, -8], [10, -18], [4, -28]], i: [[0, 0], [-7, 0], [0, -7], [0, 0]], o: [[0, 0], [7, 0], [0, 7], [0, 0]] },
      rot: sleep ? keys([[0, -9], [frames, -4]]) : wag(frames, [-24, 17]) },
    { name: "tailTip", center: [174, 110], size: [14, 14], fill: "#FFF3E0" },
    { name: "body", center: [110, 152], size: [98, 70], fill: "#E9A05A", stroke: "#C77F3F",
      scale: breathe(frames, sleep ? 5 : 3) },
    { name: "pawL", center: [88, 178], size: [28, 18], fill: "#FFF3E0", stroke: "#E0C9A8", weight: 2.5 },
    { name: "pawR", center: [132, 178], size: [28, 18], fill: "#FFF3E0", stroke: "#E0C9A8", weight: 2.5 },
    { name: "belly", center: [110, 162], size: [54, 44], fill: "#FFF3E0", opacity: 78 },
    { name: "earL", pivot: [76, 74], at: [-6, -24], size: [28, 32], fill: "#D98F4C", stroke: "#B96F33",
      rot: sleep ? keys([[0, 0], [frames, 0]]) : earTwitch(frames, 96) },
    { name: "earR", pivot: [144, 74], at: [6, -24], size: [28, 32], fill: "#D98F4C", stroke: "#B96F33" },
    { name: "head", center: [110, 102], size: [96, 86], fill: "#EDAE6A", stroke: "#C77F3F",
      scale: breathe(frames, sleep ? 4 : 2.4) },
    ...blush(72, 148, 118),
    { name: "muzzle", center: [110, 120], size: [44, 32], fill: "#FFF3E0" },
    { name: "nose", center: [110, 110], size: [13, 10], fill: "#4A3B2F" },
    { name: "browL", center: [86, 86], size: [11, 5], fill: "#FFF3E0" },
    { name: "browR", center: [134, 86], size: [11, 5], fill: "#FFF3E0" },
    ...mouthFor(c, 110, 124, 20, "#8A6248", "#FF9AA8"),
    ...eyes({ l: 86, r: 134, y: 100, size: [12, 15], color: "#3E3128", frames, sleep, mood: c.mood }),
  ];
}

/* —— 🐰 麻薯兔 —— */
function rabbit(c) {
  const { frames, sleep } = c;
  return [
    { name: "tail", center: [172, 152], size: [26, 26], fill: "#FFFFFF", opacity: 95, stroke: "#E8CBB6", weight: 2.5 },
    { name: "body", center: [110, 152], size: [90, 66], fill: "#FFF6EE", stroke: "#E8CBB6",
      scale: breathe(frames, sleep ? 5 : 3) },
    { name: "footL", center: [90, 178], size: [26, 16], fill: "#FFFFFF", stroke: "#E8CBB6", weight: 2.5 },
    { name: "footR", center: [130, 178], size: [26, 16], fill: "#FFFFFF", stroke: "#E8CBB6", weight: 2.5 },
    { name: "belly", center: [110, 160], size: [52, 42], fill: "#FFFFFF", opacity: 85 },
    { name: "earL", pivot: [94, 78], at: [-3, -34], size: [22, 62], fill: "#FFF6EE", stroke: "#E8CBB6",
      rot: sleep ? keys([[0, 4], [frames, 6]]) : earTwitch(frames, 132) },
    { name: "earR", pivot: [126, 78], at: [3, -34], size: [22, 62], fill: "#FFF6EE", stroke: "#E8CBB6",
      rot: sleep ? keys([[0, -4], [frames, -6]]) : earTwitch(frames, 138) },
    { name: "earInL", pivot: [94, 86], at: [-3, -30], size: [11, 46], fill: "#FFCDD8" },
    { name: "earInR", pivot: [126, 86], at: [3, -30], size: [11, 46], fill: "#FFCDD8" },
    { name: "head", center: [110, 106], size: [84, 78], fill: "#FFF6EE", stroke: "#E8CBB6",
      scale: breathe(frames, sleep ? 4 : 2.4) },
    ...blush(78, 142, 124, "#FFC3CC"),
    ...mouthFor(c, 110, 130, 18, "#D98A9A", "#FF9AA8"),
    { name: "nose", center: [110, 117], size: [9, 7], fill: "#F5A0AE" },
    ...eyes({ l: 90, r: 130, y: 106, size: [14, 17], color: "#5A4A44", frames, sleep, mood: c.mood }),
  ];
}

/* —— 🦖 小恐龙 —— */
function dino(c) {
  const { frames, sleep } = c;
  return [
    { name: "tail", pivot: [168, 144], at: [16, -4], size: [48, 26], fill: "#9BD3A8", stroke: "#7BAF8A",
      rot: sleep ? keys([[0, -6], [frames, -3]]) : wag(frames, [-11, 11]) },
    { name: "body", center: [110, 152], size: [94, 68], fill: "#9BD3A8", stroke: "#7BAF8A",
      scale: breathe(frames, sleep ? 5 : 3) },
    { name: "footL", center: [88, 178], size: [30, 16], fill: "#8AC79A", stroke: "#6FA377", weight: 2.5 },
    { name: "footR", center: [132, 178], size: [30, 16], fill: "#8AC79A", stroke: "#6FA377", weight: 2.5 },
    { name: "belly", center: [110, 162], size: [54, 44], fill: "#EAF7E4", opacity: 85 },
    { name: "spikeL", center: [96, 66], size: [18, 22], fill: "#7FC08F",
      scale: sleep ? undefined : breathe(frames, 3) },
    { name: "spikeM", center: [110, 58], size: [19, 24], fill: "#7FC08F" },
    { name: "spikeR", center: [124, 66], size: [18, 22], fill: "#7FC08F" },
    { name: "head", center: [110, 102], size: [88, 80], fill: "#A6DBB2", stroke: "#7BAF8A",
      scale: breathe(frames, sleep ? 4 : 2.4) },
    ...blush(74, 146, 122),
    { name: "nostrilL", center: [102, 116], size: [6, 5], fill: "#7FC08F" },
    { name: "nostrilR", center: [118, 116], size: [6, 5], fill: "#7FC08F" },
    ...mouthFor(c, 110, 126, 18, "#6FAE80", "#FF9AA8"),
    ...eyes({ l: 88, r: 132, y: 104, size: [13, 15], color: "#3E4A3C", frames, sleep, mood: c.mood }),
  ];
}

/* —— 🦦 水獭 —— */
function otter(c) {
  const { frames, sleep } = c;
  return [
    { name: "tail", pivot: [170, 150], stroke: "#9C6F4F", weight: 12,
      path: { c: false, v: [[0, 0], [14, -2], [26, 2], [34, 10]], i: [[0, 0], [-8, -2], [0, -6], [0, 0]], o: [[0, 0], [8, 2], [0, 6], [0, 0]] },
      rot: sleep ? keys([[0, -5], [frames, -2]]) : wag(frames, [-9, 9]) },
    { name: "body", center: [110, 152], size: [92, 68], fill: "#C29170", stroke: "#9C6F4F",
      scale: breathe(frames, sleep ? 5 : 3) },
    { name: "pawL", center: [88, 178], size: [26, 16], fill: "#C29170", stroke: "#9C6F4F", weight: 2.5 },
    { name: "pawR", center: [132, 178], size: [26, 16], fill: "#C29170", stroke: "#9C6F4F", weight: 2.5 },
    { name: "belly", center: [110, 162], size: [54, 42], fill: "#F3E0CE", opacity: 88 },
    { name: "head", center: [110, 102], size: [88, 80], fill: "#C99A79", stroke: "#9C6F4F",
      scale: breathe(frames, sleep ? 4 : 2.4) },
    { name: "earL", center: [78, 80], size: [18, 18], fill: "#B98A6A", stroke: "#9C6F4F", weight: 2.5,
      scale: sleep ? sleepEye(frames) : keys([[0, [100, 100, 100]], [frames, [100, 100, 100]]]) },
    { name: "earR", center: [142, 80], size: [18, 18], fill: "#B98A6A", stroke: "#9C6F4F", weight: 2.5 },
    ...blush(74, 146, 120),
    { name: "muzzle", center: [110, 122], size: [40, 28], fill: "#F3E0CE" },
    { name: "nose", center: [110, 113], size: [11, 9], fill: "#4A3B2F" },
    line([90, 118], [64, 112], "#8A6248", 2, 70, "wsk1"),
    line([90, 124], [64, 129], "#8A6248", 2, 70, "wsk2"),
    line([130, 118], [156, 112], "#8A6248", 2, 70, "wsk3"),
    line([130, 124], [156, 129], "#8A6248", 2, 70, "wsk4"),
    ...mouthFor(c, 110, 126, 18, "#8A6248", "#FF9AA8"),
    ...eyes({ l: 88, r: 132, y: 102, size: [12, 14], color: "#42342C", frames, sleep, mood: c.mood }),
  ];
}

/* ═════════ 组装与缓存 ═════════ */
const SHAPES = { cat, dog, rabbit, dino, otter };

const VARIANTS = {
  idle:  { frames: 180, sleep: false, mood: "idle" },
  sleep: { frames: 240, sleep: true,  mood: "idle" },
  happy: { frames: 110, sleep: false, mood: "happy" },
  play:  { frames: 110, sleep: false, mood: "play" },
  clean: { frames: 110, sleep: false, mood: "clean" },
  eat:   { frames: 110, sleep: false, mood: "eat" },
};

const cache = {};

/** 取某只宠物的 Lottie 动画数据；species 不是预设宠物时返回 null */
export function petAnimation(species, variant = "idle") {
  if (!SHAPES[species]) return null;
  const key = species + ":" + variant;
  if (cache[key]) return cache[key];
  const cfg = VARIANTS[variant] || VARIANTS.idle;
  let layers = SHAPES[species](cfg);
  /* 互动时（清醒 idle）漂浮一颗小心心 —— 每只宠物都有的萌化点缀 */
  /* #11 粒子层：睡觉 Zzz；开心双心；洗澡星星；玩耍星星+心；吃饭小心心；平时一颗心 */
  if (cfg.sleep) layers = layers.concat(zzz(158, 56, cfg.frames));
  else if (cfg.mood === "happy") layers = layers.concat(heart(158, 48, 1, cfg.frames, 0), heart(186, 68, 0.8, cfg.frames, 16));
  else if (cfg.mood === "clean") layers = layers.concat(sparkle(58, 96, 1, cfg.frames, 0), sparkle(162, 92, 0.85, cfg.frames, 14), sparkle(112, 40, 0.9, cfg.frames, 28));
  else if (cfg.mood === "play") layers = layers.concat(sparkle(64, 70, 0.9, cfg.frames, 6), heart(182, 58, 0.9, cfg.frames, 20));
  else if (cfg.mood === "eat") layers = layers.concat(heart(180, 58, 0.8, cfg.frames, 8));
  else layers = layers.concat(heart(180, 54, 1, cfg.frames, 10));
  cache[key] = build(layers, cfg.frames, species + "-" + variant);
  return cache[key];
}

export const hasPreset = (species) => !!SHAPES[species];

