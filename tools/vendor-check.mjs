/* 轮 514 · vendored 库的接线与改动完整性
 *
 * 背景：会话页外壳 fork 进 vendor/vue-advanced-chat（见 PATCHES.md）。fork 的唯一意义
 * 是「几何在源码里就是对的」，宿主不用再内联 !important 抢优先级。
 *
 * 这条测试要拦住三种回退：
 *   ① 有人把依赖改回 ^2.1.2 → npm install 装回上游包，五处改动全没；
 *   ② 有人从上游覆盖了 dist 但忘了重新应用改动；
 *   ③ 有人又在宿主里加内联钉（两套机制并存，必然打架）。
 */
import { readFileSync, existsSync } from "node:fs";
import assert from "node:assert";

const ROOT = process.cwd();
const LIBF = "vendor/vue-advanced-chat/dist/vue-advanced-chat.es.js";
const out = [];
let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); out.push("ok   " + name); pass++; }
  catch (e) { out.push("FAIL " + name + " :: " + e.message); fail++; }
};
const has = (s, re, msg) => assert.match(s, re, msg);
const no = (s, re, msg) => assert.doesNotMatch(s, re, msg);

const PKG = JSON.parse(readFileSync("package.json", "utf8"));
const LIB = readFileSync(LIBF, "utf8");
const VMETA = JSON.parse(readFileSync("vendor/vue-advanced-chat/package.json", "utf8"));

t("V1 依赖指向本地 fork（不是 ^2.1.2 —— 那样 install 会把改动冲掉）", () => {
  assert.equal(PKG.dependencies["vue-advanced-chat"], "file:vendor/vue-advanced-chat");
  assert.ok(existsSync("vendor/vue-advanced-chat/PATCHES.md"), "改动清单不见了");
});

t("V2 lockfile 认的是 link，不是 registry 包", () => {
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  const ent = lock.packages["node_modules/vue-advanced-chat"] || {};
  assert.equal(ent.link, true, "node_modules 里不是本地链接（install 过上游包了？）");
  assert.equal(lock.packages[""].dependencies["vue-advanced-chat"], "file:vendor/vue-advanced-chat");
});

t("V3 fork 版本号带本地后缀，避免与上游混淆", () => {
  assert.match(VMETA.version, /^2\.1\.2-warmpaws\.\d+$/, `实际 ${VMETA.version}`);
  assert.equal(VMETA.license, "MIT", "许可证字段丢了（MIT 要求保留）");
});

t("V4 改动 1：wrapper 是 static（否则面板缩成按钮宽的一条竖线）", () => {
  has(LIB, /\.vac-emoji-wrapper\{position:static;display:flex\}/, "wrapper 还是 relative");
  no(LIB, /\.vac-emoji-wrapper\{position:relative;display:flex\}/, "上游原件没被改（还是 relative）");
});

t("V5 改动 2：手机端面板 fixed + bottom:--kbb + height:--kb-panel-h（带 !important）", () => {
  has(LIB, /@media \(max-width:899px\)\{\.vac-emoji-wrapper \.vac-emoji-picker:not\(\.vac-picker-reaction\)\{position:fixed!important;left:0!important;right:0!important;bottom:var\(--kbb,0px\)!important;top:auto!important;width:100%!important;height:var\(--kb-panel-h,320px\)!important/,
    "手机端 sheet 规则不完整（缺 fixed / --kbb / --kb-panel-h / !important 任一）");
});

t("V6 改动 3：手机端普通输入框不写内联几何（reaction 保持上游）", () => {
  has(LIB, /if \(!this\.emojiReaction\) \{\s*\n\s*this\.emojiPickerRight = "";\s*\n\s*this\.emojiPickerTop = 0;\s*\n\s*this\.emojiPickerHeight = 0;\s*\n\s*return;/,
    "mobileSize 分支没短路（height/top/right 又被写成内联值了）");
  has(LIB, /this\.emojiPickerHeight = innerHeight - 200;/, "reaction 的上游逻辑被误删（长按表情会塌）");
});

t("V7 改动 4/5：height/top 为 0 时不输出（否则写死 0px 把 CSS 压掉）", () => {
  has(LIB, /height: \$data\.emojiPickerHeight > 0 \? `\$\{\$data\.emojiPickerHeight\}px` : void 0,/,
    "height 还是无条件输出");
  has(LIB, /top: \$props\.positionTop && \$data\.emojiPickerHeight > 0 \? \$data\.emojiPickerHeight : \(\$data\.emojiPickerTop > 0 \? `\$\{\$data\.emojiPickerTop\}px` : void 0\),/,
    "top 还是无条件输出");
});

/* 工装抓出来的真 bug：positionTop 是布尔 prop，web component 传 "false" 也是 truthy，
   配合 height=0 会渲染出 top:0px —— 面板整宽、高度都对，但位置被顶到屏幕顶部。 */
t("V7b 改动 6：positionTop 为真但 height=0 时不写 top", () => {
  no(LIB, /top: \$props\.positionTop \? \$data\.emojiPickerHeight :/,
    "positionTop 分支没加 height>0 的条件（会写出 top:0px，面板跑到屏幕顶部）");
});

t("V8 宿主不再内联改面板几何（两套机制并存必然打架）", () => {
  const BC = readFileSync("src/components/DmVacChat.vue", "utf8");
  no(BC, /const pinPicker = /, "pinPicker 又回来了");
  no(BC, /p\.style\.setProperty\("(position|bottom|width|height)"/, "宿主又给面板写内联几何");
  /* 让位那一半必须还在：面板不能盖住输入行 */
  has(BC, /f\.style\.paddingBottom = h \+ "px"/, "让位 padding 不见了（面板会盖住输入行）");
});

t("V9 dist 与 node_modules 解析到的是同一份（防止装了两份）", () => {
  const nm = "node_modules/vue-advanced-chat/" + "dist/vue-advanced-chat.es.js";
  assert.ok(existsSync(nm), "node_modules 里没有库文件");
  const a = readFileSync(nm, "utf8");
  assert.equal(a.length, LIB.length, `长度不同：node_modules ${a.length} vs vendor ${LIB.length}`);
  assert.ok(a.includes(".vac-emoji-wrapper{position:static;display:flex}"), "node_modules 里是没改过的原件");
});

console.log(out.join("\n"));
console.log(`\nvendor-check: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
