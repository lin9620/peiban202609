/* ═══════════ 第二档：装扮 · 季节 · 信箱回信池 ═══════════ */

/* 装扮配件：coins=售价，pos=佩戴位置微调（toppx/left% 用于叠在宠物头顶） */
export const ACCESSORIES = [
  { key: "daisy",   ico: "\u{1F33C}", cost: 30,  name: { en: "Daisy Clip",  zh: "小雏菊" },   dy: -6 },
  { key: "cap",     ico: "\u{1F9E2}", cost: 40,  name: { en: "Little Cap",  zh: "小红帽" },   dy: -2 },
  { key: "leaf",    ico: "\u{1F343}", cost: 45,  name: { en: "Lucky Leaf",  zh: "幸运叶" },   dy: -5 },
  { key: "scarf",   ico: "\u{1F9E3}", cost: 50,  name: { en: "Warm Scarf",  zh: "暖围巾" },   dy: 14 },
  { key: "ribbon",  ico: "\u{1F380}", cost: 60,  name: { en: "Sakura Bow",  zh: "樱花结" },   dy: -4 },
  { key: "shades",  ico: "\u{1F576}\uFE0F", cost: 80, name: { en: "Cool Shades", zh: "酷墨镜" }, dy: 2 },
  { key: "bell",    ico: "\u{1F514}", cost: 90,  name: { en: "Golden Bell", zh: "小金铃" },   dy: 12 },
  { key: "crown",   ico: "\u{1F451}", cost: 120, name: { en: "Tiny Crown",  zh: "小皇冠" },   dy: -8 },
];

/* 季节 / 节日彩蛋（按公历区间近似） */
export const SEASONS = [
  { key: "christmas",  from: [12, 20], to: [1, 5],
    particles: ["\u2744\uFE0F", "\u2728"],
    name: { en: "Christmas season", zh: "圣诞季" } },
  { key: "springfest", from: [1, 6], to: [2, 20],
    particles: ["\u{1F9E7}", "\u2728"],
    name: { en: "Lunar New Year", zh: "新春佳节" } },
  { key: "sakura",     from: [3, 10], to: [4, 15],
    particles: ["\u{1F338}", "\u{1F338}", "\u2728"],
    name: { en: "Sakura days", zh: "樱花季" } },
  { key: "summer",     from: [6, 20], to: [8, 31],
    particles: ["\u2600\uFE0F", "\u{1F4A7}"],
    name: { en: "Summer break", zh: "盛夏时光" } },
  { key: "halloween",  from: [10, 25], to: [11, 5],
    particles: ["\u{1F383}", "\u2728"],
    name: { en: "Halloween", zh: "万圣节" } },
  { key: "autumn",     from: [11, 6], to: [12, 19],
    particles: ["\u{1F342}", "\u{1F341}"],
    name: { en: "Golden autumn", zh: "金秋时节" } },
];
export const DEFAULT_SEASON = {
  key: "gentle", particles: ["\u2728", "\u{1F343}"],
  name: { en: "Gentle days", zh: "平常日子" },
};

function mdToday() {
  const d = new Date();
  return [d.getMonth() + 1, d.getDate()];
}
function mdInRange(md, from, to) {
  if (from[0] === to[0]) return md[0] === from[0] && md[1] >= from[1] && md[1] <= to[1];
  /* 跨年区间（如 12/20-1/5） */
  if (from[0] > to[0]) return (md[0] >= from[0] && md[1] >= from[1]) || (md[0] <= to[0] && md[1] <= to[1]);
  return md[0] >= from[0] && md[0] <= to[0];
}
export function seasonNow() {
  const md = mdToday();
  const hit = SEASONS.find((s) => mdInRange(md, s.from, s.to));
  return hit || DEFAULT_SEASON;
}
