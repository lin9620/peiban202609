/* 轮 364 · ＋ 弹层图标 / 写故事文案
 *   node tools/tabbar-copy-test.mjs
 *
 * 用户截图：三个 emoji 图标不好看；「写故事」下面那句「最多 3 万字」要去掉，
 * 只在编辑器里超过上限时提示。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { messages } from "../src/i18n.js";

const TAB = fs.readFileSync("src/components/TabBar.vue", "utf8");
const EDITOR = fs.readFileSync("src/components/story/StoryEditor.vue", "utf8");

let pass = 0;
const fails = [];
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fails.push(name + " —— " + e.message); } };
const noLimit = (s) => !/3\s*万|30000|30,000|30k|30,000/i.test(String(s || ""));

t("C1 ＋ 弹层三个入口都用 SVG，不再用 emoji", () => {
  const sheet = TAB.slice(TAB.indexOf('class="tabbar-sheet"'), TAB.indexOf("</van-tabbar>"));
  const icons = [...sheet.matchAll(/<span class="tabbar-opt-ico"[\s\S]*?<\/span>/g)].map((m) => m[0]);
  assert.equal(icons.length, 3, `只找到 ${icons.length} 个入口图标`);
  for (const ico of icons) {
    assert.match(ico, /<svg\b/, "入口图标不是 SVG");
    assert.doesNotMatch(ico, /[\u{1F300}-\u{1FAFF}]/u, "入口里还留着 emoji");
  }
});

t("C2 图标容器是统一的 38px 圆角底，不再靠 font-size 撑", () => {
  assert.match(TAB, /\.tabbar-opt-ico\s*\{[^}]*width:\s*38px/, "图标没有固定 38px 宽");
  assert.match(TAB, /\.tabbar-opt-ico\s*\{[^}]*height:\s*38px/, "图标没有固定 38px 高");
  assert.match(TAB, /\.tabbar-opt-ico\s*\{[^}]*background:\s*var\(--accent-soft/, "图标没有统一底色");
});

t("C3 写故事副标题不再写 3 万字上限", () => {
  assert.ok(noLimit(messages.en.tab.composeStorySub), "英文副标题还带着 30,000");
  assert.ok(noLimit(messages.zh.tab.composeStorySub), "中文副标题还带着 3 万字");
});

t("C4 故事栏介绍也不提前写上限", () => {
  for (const lang of ["en", "zh"]) {
    assert.ok(noLimit(messages[lang].story.sub), `${lang} story.sub 还带着上限`);
    assert.ok(noLimit(messages[lang].story.feedSub), `${lang} story.feedSub 还带着上限`);
  }
});

t("C5 正常计数不带 max；只有超限文案带 max", () => {
  for (const lang of ["en", "zh"]) {
    assert.ok(noLimit(messages[lang].story.counter), `${lang} counter 还带着上限`);
    assert.match(String(messages[lang].story.counterOver), /\{max\}/, `${lang} counterOver 没有 {max}`);
  }
  assert.match(EDITOR, /over \? t\("story\.counterOver", \{ n: chars, max: BODY_MAX \}\) : t\("story\.counter"/,
    "编辑器不是「超限才显示上限」");
});

t("C6 超过上限时仍有明确提示（清单 + 红色计数）", () => {
  assert.match(EDITOR, /if \(over\.value\) list\.push\(t\("story\.tooLong"\)\)/, "超限清单提示没了");
  assert.match(EDITOR, /'st-count--over': over/, "计数没有超限红色态");
  assert.ok(messages.en.story.tooLong && messages.zh.story.tooLong, "tooLong 中英不全");
});

console.log(`tabbar-copy-test: ${pass} pass, ${fails.length} fail`);
if (fails.length) { for (const f of fails) console.log("  FAIL " + f); process.exit(1); }
