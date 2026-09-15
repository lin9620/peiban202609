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

/* 温暖信箱：小橘/宠物的回信池（发信后随机延迟回信） */
export const MAIL_REPLIES = [
  { en: "I read your letter twice. Whatever it is, you don't have to carry it alone tonight.", zh: "你的信我读了两遍。不管是什么，今晚你都不用一个人扛。" },
  { en: "Thank you for telling me. Small courage like this counts the most.", zh: "谢谢你告诉我。这样小小的勇气，最了不起了。" },
  { en: "I can't fix it, but I'll sit right here with you while it passes.", zh: "我可能帮不上忙，但我会一直坐在这里，陪你等它过去。" },
  { en: "Have you eaten today? Start there. Then one more small thing.", zh: "今天吃饭了吗？先从这里开始，然后再做一件小事就好。" },
  { en: "You did better today than you give yourself credit for. I noticed.", zh: "你今天做得比你以为的好，我都看在眼里。" },
  { en: "Some days are for growing, some are just for resting. Both are fine.", zh: "有些日子用来成长，有些只用来休息。都可以的。" },
  { en: "Your feelings are allowed to be loud. I'll stay quiet with you until they aren't.", zh: "情绪可以大声一点。我陪你安静地等它变小。" },
  { en: "I saved a warm spot on the floor for you. Always.", zh: "我一直在地板上给你留了个暖暖的位置。" },
  { en: "The stars took forever too, and look how they turned out.", zh: "星星也是花了很久才亮起来的，你看现在多好看。" },
  { en: "Tomorrow, one small kind thing — for you, from you. Deal?", zh: "明天为你自己做一件温柔的小事，好吗？说定了。" },
];