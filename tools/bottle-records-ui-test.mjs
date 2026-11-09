/* 轮 494 · 漂流瓶记录段（消息 → 漂流瓶）的版式护栏
 *   node tools/bottle-records-ui-test.mjs
 *
 * 用户原话：「这个页面各种按钮布局也太丑了，重新更改设计一些」，附夜间主题截图：
 *   ① 标题、状态、撤回散在卡片的三个角落，撤回是一颗裸红字飘在右下角；
 *   ② 「刷新记录」是全局 .dm-act 的虚线胶囊，夹在实体标题旁边像草稿；
 *   ③ 两个页签是 accent 实心底 + ink-soft 字（夜间 #8b9ce8 配 #a9b1d6 只有 1.4:1，几乎读不出来）；
 *   ④ .bottle-record 写 `border: 1px solid var(--line)`，而 --line 这个变量**从来没定义过**，
 *      整条 border 简写失效 —— 卡片根本没有边框，只是一堆浮在页面上的文字。
 *
 * 这组断言钉的就是上面四条，以及「别把已经排好的动作区改回去」。
 */
import fs from "node:fs";

const RECS = fs.readFileSync("src/components/BottleRecords.vue", "utf8");
const CSS = fs.readFileSync("src/style.css", "utf8");

let pass = 0;
const fails = [];
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fails.push(name + " —— " + e.message); } };
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
/* 取一条规则（同一选择器可能出现多次，取第一处） */
const block = (src, sel) => {
  const i = src.indexOf(sel + " {");
  if (i < 0) return "";
  const j = src.indexOf("}", i);
  return src.slice(i, j + 1);
};
const has = (src, s) => src.includes(s);

t("U1 记录卡用真实存在的 --hairline（不是幽灵变量 --line）", () => {
  const b = block(RECS, ".bottle-record");
  assert(b, "找不到 .bottle-record 规则");
  assert(!/var\(--line\)/.test(b), "又写回 var(--line) 了 —— 这个变量不存在，整条 border 会失效，卡片没有边界");
  assert(/var\(--hairline\)/.test(b), "卡片边框没有用 --hairline");
});

t("U2 状态胶囊与撤回/隐藏在同一行，撤回靠右对齐", () => {
  assert(has(RECS, 'class="br-foot"'), "缺少状态行容器 .br-foot");
  const foot = block(RECS, ".br-foot");
  assert(foot && /display:\s*flex/.test(foot) && /align-items:\s*center/.test(foot), "状态行不是一行 flex");
  const ops = block(RECS, ".br-ops");
  assert(ops && /margin-left:\s*auto/.test(ops), "撤回没有靠右（`margin-left:auto`），会跟状态挤在一起");
  /* 状态胶囊自己在 .br-foot 里，不再是一个独立的 <p> 段落 */
  assert(has(RECS, 'class="br-state"'), "缺少状态胶囊 .br-state");
});

t("U3 两个页签是分段控件，选中态不靠 accent 实底吸字", () => {
  assert(has(RECS, 'class="br-seg"'), "缺少分段控件容器 .br-seg");
  const on = block(RECS, ".br-seg-btn.on");
  assert(on, "缺少 .br-seg-btn.on 规则");
  assert(/background:\s*var\(--accent-soft\)/.test(on),
    "选中态必须用 accent-soft 浅底 —— 用 var(--accent) 实底时夜间主题 #8b9ce8 上的字只有 1.4:1");
  assert(/color:\s*var\(--ink\)/.test(on), "选中态文字必须是正文色（五套主题都 ≥8:1）");
  assert(!/\.br-tab\b/.test(RECS), "老的 .br-tab 独立胶囊还在，会和分段控件打架");
});

t("U4 「刷新记录」不再用全局虚线按钮，且带可旋转图标", () => {
  assert(has(RECS, 'class="br-refresh"'), "缺少 .br-refresh");
  /* 刷新按钮的 class 里不能再出现 dm-act（那是 1.5px dashed 的通用按钮） */
  const i = RECS.indexOf('class="br-refresh"');
  assert(i > 0, "找不到刷新按钮");
  assert(!RECS.slice(i - 200, i + 200).includes("dm-act"), "刷新按钮又用回 .dm-act 虚线胶囊了");
  assert(/br-refresh-ico/.test(RECS) && /br-spin/.test(RECS), "缺少旋转图标 / 动画");
  const b = block(RECS, ".br-refresh");
  assert(!/dashed/.test(b), "刷新按钮不要虚线描边");
});

t("U5 夜间主题的主按钮改用深墨字（accent 在夜间是淡紫）", () => {
  assert(/html\[data-theme="night"\]\s*\.br-btn--main/.test(RECS),
    "缺少夜间主题的 .br-btn--main 覆盖 —— 白字在 #8b9ce8 上只有 2.6:1，按钮文字会糊");
});

t("U6 原生 details 三角被换成自绘 chevron", () => {
  assert(/summary::-webkit-details-marker\s*\{\s*display:\s*none/.test(RECS), "没有隐藏原生 ▶");
  assert(has(RECS, "list-style: none"), "summary 没有去掉 list-style（Firefox 会画三角）");
  assert(/summary::before/.test(RECS) && /details\[open\]\s*>\s*summary::before/.test(RECS),
    "缺少自绘 chevron 或展开态翻转");
});

t("U7 待决定的动作按钮一行两列等分（不再单个 inline-block 各占一行）", () => {
  const acts = block(RECS, ".br-acts");
  assert(acts, "缺少 .br-acts");
  assert(/display:\s*grid/.test(acts) && /grid-template-columns:\s*1fr 1fr/.test(acts), "两个按钮没有等分同一行");
  assert(has(RECS, "br-btn--main") && has(RECS, "br-btn--wide"), "缺少主按钮 / 整行按钮变体");
});

t("U8 旧类名仍在（bottle-gap-test / bottle-test 按名锁着）", () => {
  assert(has(RECS, "bottle-record-title") && has(RECS, "bottle-record-open-label"),
    "折叠标题的两个 span 变了名，bottle-test 的轮398 断言会失效");
  assert(has(RECS, 'class="bottle-record-text"'), "正文类名变了");
  assert(/\.bottle-record > details\s*\{[^}]*margin-bottom:\s*12px/.test(RECS),
    "内容区 → 动作区的 12px 呼吸位被改了（轮429 用户亲自报过按钮贴正文）");
});

console.log(`bottle-records-ui-test: ${pass} pass, ${fails.length} fail`);
if (fails.length) { for (const f of fails) console.log("  FAIL " + f); process.exit(1); }
