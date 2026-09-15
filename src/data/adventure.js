/* ═══════════ 旅行青蛙式冒险 · 数据定义 ═══════════
   目的地 / 特产 / 访客。emoji 一律用 Unicode 转义，防止写入过程丢失。 */

export const DESTS = [
  {
    key: "meadow", ico: "\u{1F33E}",
    sky: ["#cdebc3", "#fdf3c6"], ground: "#93c46d",
    name: { en: "Sunny Meadow", zh: "阳光草原" },
  },
  {
    key: "forest", ico: "\u{1F332}",
    sky: ["#bfe0d8", "#e9f5e1"], ground: "#6ea87b",
    name: { en: "Quiet Forest", zh: "幽静森林" },
  },
  {
    key: "lake", ico: "\u{1F30A}",
    sky: ["#c9e4f5", "#f2e9ff"], ground: "#7fb4d9",
    name: { en: "Misty Lake", zh: "雾语湖畔" },
  },
  {
    key: "town", ico: "\u{1F3D8}\uFE0F",
    sky: ["#f6d7c3", "#ffefdd"], ground: "#c9a183",
    name: { en: "Starlight Town", zh: "星光小镇" },
  },
  {
    key: "hills", ico: "\u{1F305}",
    sky: ["#f5c9c9", "#ffe9d6"], ground: "#b0907a",
    name: { en: "Cloudy Hills", zh: "云顶山丘" },
  },
  {
    key: "beach", ico: "\u{1F3D6}\uFE0F",
    sky: ["#bfe4f0", "#fdf0d5"], ground: "#f0d9a8",
    name: { en: "Bubble Beach", zh: "泡泡海滩" },
  },
  {
    key: "spring", ico: "\u2668\uFE0F",
    sky: ["#e3d1f0", "#ffe8f0"], ground: "#a68bb5",
    name: { en: "Warm Spring", zh: "暖雾温泉" },
  },
];

/* 每个目的地的特产（最多收录 2 种） */
export const SOUVENIRS = {
  meadow: [
    { ico: "\u{1F338}", name: { en: "Wildflower bookmark", zh: "野花书签" } },
    { ico: "\u{1FA81}", name: { en: "Kite tail ribbon", zh: "风筝尾带" } },
  ],
  forest: [
    { ico: "\u{1F344}", name: { en: "Tiny mushroom charm", zh: "小蘑菇摆件" } },
    { ico: "\u{1FAB6}", name: { en: "Blue feather", zh: "青鸟羽毛" } },
  ],
  lake: [
    { ico: "\u{1FAB7}", name: { en: "Lotus lantern", zh: "莲花灯" } },
    { ico: "\u{1F41A}", name: { en: "Echo conch", zh: "回声海螺" } },
  ],
  town: [
    { ico: "\u{1F39F}\uFE0F", name: { en: "Memorial ticket", zh: "纪念车票" } },
    { ico: "\u{1F9F8}", name: { en: "Bear keychain", zh: "小熊挂件" } },
  ],
  hills: [
    { ico: "\u{1F33B}", name: { en: "Sunflower tea", zh: "向阳花茶" } },
    { ico: "\u{1FAA8}", name: { en: "Painted pebble", zh: "手绘小石头" } },
  ],
  beach: [
    { ico: "\u{1F41A}", name: { en: "Pearl shell", zh: "珍珠贝" } },
    { ico: "\u2693", name: { en: "Mini anchor", zh: "迷你船锚" } },
  ],
  spring: [
    { ico: "\u{1F361}", name: { en: "Spa dumpling", zh: "温泉团子" } },
    { ico: "\u{1F33C}", name: { en: "Bath flower", zh: "汤之花" } },
  ],
};

/* 来家里做客的访客 */
export const VISITORS = [
  {
    key: "snail", ico: "\u{1F40C}",
    name: { en: "Slowmo the snail", zh: "蜗牛慢慢" },
    line: { en: "I smelled something yummy…", zh: "我闻到了好吃的味道……" },
  },
  {
    key: "bee", ico: "\u{1F41D}",
    name: { en: "Bumble the bee", zh: "蜜蜂嗡嗡" },
    line: { en: "Busy day! May I rest here?", zh: "忙了一天，能歇歇脚吗？" },
  },
  {
    key: "turtle", ico: "\u{1F422}",
    name: { en: "Shellby the turtle", zh: "乌龟缘缘" },
    line: { en: "Long journey… so hungry.", zh: "走了好远的路……好饿呀。" },
  },
];

export const destByKey = (key) => DESTS.find((d) => d.key === key) || DESTS[0];
export const souvByKey = (key) => {
  const [dest, idx] = key.split(":");
  const s = (SOUVENIRS[dest] || [])[Number(idx)];
  return s || null;
};
export const visitorByKey = (key) => VISITORS.find((v) => v.key === key) || null;

/* 总特产种数（图鉴用） */
export const TOTAL_SOUVENIRS = DESTS.reduce(
  (n, d) => n + (SOUVENIRS[d.key] || []).length, 0
);
