/* 轮 521 · 表情面板骨架层（用户：「要照暖心墙那样补个骨架」）
 *   node tools/emoji-skel-test.mjs
 *
 * 背景（真机逐帧 probe-fill）：库每次点表情都重建 <emoji-picker>，格子是
 *   17 →（约 600ms）→ 179 → 187
 * 长起来的，位置第一帧就对、内容是空的 —— 用户看到的就是「点了没反应」。
 *
 * 这里锁的是**行为契约**，不是具体实现：阈值、超时、重铺、退场条件。
 * 真浏览器里的逐帧行为另有一套 harness 验过（面板晚一帧插入、面板重建、
 * 数据拉不下来），结论写进 jiaojie.md 的轮 521 条目。
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const SK = fs.readFileSync("src/utils/emojiSkel.js", "utf8");
const BC = fs.readFileSync("src/components/DmVacChat.vue", "utf8");

let pass = 0;
const fails = [];
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fails.push(name + " —— " + e.message); } };
const has = (src, re, msg) => { if (!re.test(src)) throw new Error(msg); };
const no = (src, re, msg) => { if (re.test(src)) throw new Error(msg); };

t("S1 导出 createEmojiSkel，返回 mount / drop 两个口", () => {
  has(SK, /export function createEmojiSkel\(hostGetter\)/, "没有工厂函数");
  has(SK, /return \{ mount, drop \};/, "没导出 mount / drop");
});

t("S2 阈值 40、超时 2.5s、等面板 30 帧（三个数都要有出处注释）", () => {
  has(SK, /const FILLED_AT = 40;/, "没有「铺满」阈值");
  has(SK, /const GIVE_UP_MS = 2500;/, "没有超时兜底（数据拉不下来会永远盖着）");
  has(SK, /const WAIT_FRAMES = 30;/, "没有「等面板插入」的帧数上限");
  /* 阈值必须大于「最近使用」那一批（17），否则面板一出现就被判成铺满、骨架白铺 */
  assert.ok(/FILLED_AT = (\d+)/.exec(SK)[1] > 17, "阈值不能低于 17（会跟「最近使用」那批撞车）");
});

t("S3 选择器带 .vac-emoji-wrapper 前缀（跟库的 media 规则同一层，少一层就找不到宿主）", () => {
  has(SK, /querySelector\("\.vac-emoji-wrapper \.vac-emoji-picker"\)/, "选择器不对（面板在 wrapper 里）");
});

t("S4 面板晚一帧插入时要继续等，不能一次就放弃", () => {
  has(SK, /if \(!pk\) \{[\s\S]{0,160}tries\+\+ < WAIT_FRAMES[\s\S]{0,80}requestAnimationFrame\(tick\)/, "面板还没插进来就放弃了");
});

t("S5 面板被重建（库每次开关都重建）要重新铺一层", () => {
  has(SK, /if \(!node \|\| node\.parentNode !== pk\)/, "没检测面板重建（新面板会是白的）");
  has(SK, /querySelector\("\." \+ SKEL_CLASS\)/, "重建时没清掉旧节点");
});

t("S6 退场条件是「格子够数」或「超时」，两样都要", () => {
  has(SK, /if \(filled\(pk\) \|\| Date\.now\(\) - at > GIVE_UP_MS\) \{ drop\(\); return; \}/, "退场条件不全");
});

t("S7 读 emoji-picker 的 shadowRoot 必须包 try（有的 WebView 不让读）", () => {
  has(SK, /try \{[\s\S]{0,200}querySelectorAll\("\.emoji"\)/, "读 shadowRoot 没兜异常（会整条挂掉）");
});

t("S8 drop 要停 rAF 并摘节点（组件卸载后不能继续每帧查 shadowRoot）", () => {
  has(SK, /const drop = \(\) => \{\s*\n\s*stop\(\);/, "drop 没停 rAF");
  has(SK, /removeChild\(node\)/, "drop 没摘节点");
});

/* ── 宿主侧接线 ── */
t("S9 宿主在面板「刚打开 / 已收起」时各调一次，不是每次 sync 都调", () => {
  has(BC, /if \(open && !emojiWasOpen\) emojiSkel\.mount\(\);/, "打开时没铺骨架（或没做「刚打开」判断）");
  has(BC, /else if \(!open\) emojiSkel\.drop\(\);/, "收起时没摘骨架");
  has(BC, /const emojiSkel = createEmojiSkel\(\(\) => el\.value\);/, "没把宿主交给骨架");
});

t("S10 卸载时摘掉骨架（否则 rAF 永不停）", () => {
  has(BC, /onBeforeUnmount\(\(\) => \{[\s\S]{0,300}emojiSkel\.drop\(\)/, "卸载没停骨架");
});

/* ── 样式（面板在 shadow tree 里，样式只能写在 THEME_CSS） ── */
t("S11 骨架样式在 THEME_CSS 内，8 列 34px（跟暖心墙同尺，换真内容不跳）", () => {
  has(BC, /\.wp-picker-skel \{[\s\S]{0,320}grid-template-columns: repeat\(8, 1fr\)/, "骨架不是 8 列");
  has(BC, /\.wp-picker-skel \{[\s\S]{0,320}grid-auto-rows: 34px/, "骨架行高不是 34px");
  has(BC, /\.wp-picker-skel \{[\s\S]{0,400}pointer-events: none/, "骨架没关掉点击（会挡住表情）");
  /* 72 个格子 × 34px 已经超过面板最高可能高度，多出来的被 overflow 裁掉 */
  has(SK, /const CELLS = 72;/, "骨架格子数不对");
});

t("S12 不许把骨架写回内联（内联会跟着面板重建丢失，且没法统一主题）", () => {
  no(BC, /skelNode\.style\./, "骨架还在写内联样式");
});

console.log("emoji-skel-test: " + pass + " pass, " + fails.length + " fail");
for (const f of fails) console.log("  FAIL " + f);
if (fails.length) process.exit(1);
