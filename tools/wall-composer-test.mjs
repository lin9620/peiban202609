/* 轮 342 · 暖心墙输入框（一级评论 / 一级回复 / 二级回复 / 手机底部条）
 *   node tools/wall-composer-test.mjs
 *
 * 用户原话：「是所有的暖心墙输入框都换，一级二级。」
 * 口径：
 *   · CommunityView / PostDetailView 各 4 处输入框全部换成 WpComposer，
 *     不再有第二套 textarea / van-field 混在评论里；
 *   · 观感与私信底栏同款：白色胶囊 + 表情 + 纸飞机，自动长高；
 *   · 桌面 Enter 发送、Shift+Enter 换行；手机 Enter 只换行（点纸飞机发）；
 *   · 表情插到光标处，数据源走本地 /emoji/data.json（不走 CDN）；
 *   · 面板贴顶时往下弹，别被视口/卡片裁掉。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { enterSends, insertText, pickerOpensUp } from "../src/utils/composer.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const RAW = (p) => fs.readFileSync(path.join(root, p), "utf8");
const code = (s) => s.replace(/<!--[\s\S]*?-->/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");

const WPC_RAW = RAW("src/components/WpComposer.vue");
const WPC = code(WPC_RAW);
const WALL = RAW("src/views/CommunityView.vue");
const DETAIL = RAW("src/views/PostDetailView.vue");
const CSS = RAW("src/style.css");
const I18N = RAW("src/i18n.js");
const VITE = RAW("vite.config.js");

let pass = 0, fail = 0; const out = [];
const t = (name, fn) => {
  try { fn(); pass++; out.push("ok   " + name); }
  catch (e) { fail++; out.push("FAIL " + name + " :: " + e.message); }
};
const has = (src, re, msg) => { if (!re.test(src)) throw new Error(msg); };
const tags = (src) => [...src.matchAll(/<WpComposer\b[\s\S]*?\/>/g)].map((m) => m[0]);

/* ── 纯逻辑 ── */
t("C1 表情插到光标处（不吞前后文）", () => {
  assert.deepEqual(insertText("你好世界", 2, 2, "🌸"), { value: "你好🌸世界", caret: 4 });
});

t("C2 有选区就替换选区（光标落在表情后）", () => {
  assert.deepEqual(insertText("你好世界", 1, 3, "🌸"), { value: "你🌸界", caret: 3 });
});

t("C3 超长按 maxlength 截断，光标不越界", () => {
  const r = insertText("1234", 4, 4, "5678", 6);
  assert.equal(r.value, "123456");
  assert.equal(r.caret, 6);
  const r2 = insertText("123456", 6, 6, "7", 6);
  assert.equal(r2.value, "123456");
  assert.equal(r2.caret, 6);
});

t("C4 负坐标/越界坐标夹紧（不抛、不吞字）", () => {
  assert.deepEqual(insertText("abc", -5, 99, "X"), { value: "X", caret: 1 });
  assert.deepEqual(insertText("abc", 99, -1, "X"), { value: "abcX", caret: 4 });
  assert.deepEqual(insertText(null, 0, 0, "X"), { value: "X", caret: 1 });
});

t("C5 桌面 Enter 发送；Shift+Enter / 手机 / 输入法组合中不发", () => {
  const k = (o = {}) => ({ key: "Enter", shiftKey: false, isComposing: false, keyCode: 13, ...o });
  assert.equal(enterSends(k()), true);
  assert.equal(enterSends(k({ shiftKey: true })), false);
  assert.equal(enterSends(k(), true), false);
  assert.equal(enterSends(k({ isComposing: true })), false);
  assert.equal(enterSends(k({ keyCode: 229 })), false);
  assert.equal(enterSends(k({ key: "a" })), false);
  assert.equal(enterSends(null), false);
});

t("C6 表情面板方向：贴顶往下、贴底往上、上方够高往上", () => {
  /* 视口 800，面板 340：输入框 top=100 → 上方 92 不够，往下 */
  assert.equal(pickerOpensUp(100, 140, 800, 340), false);
  /* top=600 → 上方 592 够，往上 */
  assert.equal(pickerOpensUp(600, 640, 800, 340), true);
  /* 上方 300、下方 100：两边都不够，哪边大往哪边（上） */
  assert.equal(pickerOpensUp(300, 700, 800, 340), true);
  /* 脏值不炸，默认往上 */
  assert.equal(pickerOpensUp(NaN, 1, 800, 340), true);
});

/* ── 组件源码锁 ── */
t("W1 WpComposer 是胶囊 + 表情 + 纸飞机 + 自动长高", () => {
  has(WPC, /<textarea[\s\S]{0,400}?class="wp-composer-input"/, "没有 textarea");
  has(WPC, /class="wp-composer-ico is-emoji"/, "没有表情按钮");
  has(WPC, /class="wp-composer-ico is-send"/, "没有纸飞机发送键");
  has(WPC, /:disabled="!canSend"/, "发送键没按空内容禁用");
  has(WPC, /const max =[\s\S]{0,260}?el\.scrollHeight/, "没有按 scrollHeight 自动长高");
  has(WPC, /\.wp-composer-field[\s\S]{0,220}?border-radius:\s*20px/, "胶囊圆角丢了");
});

t("W2 桌面 Enter 发 / Shift+Enter 换行 / 手机只点纸飞机", () => {
  has(WPC, /@keydown="onKeydown"/, "没接 keydown");
  has(WPC, /enterSends\(e, isMobileNav\.value\)/, "没按桌面/手机分流");
  has(WPC, /if \(!enterSends\(e, isMobileNav\.value\)\) return;/, "Enter 判定没接");
  has(WPC, /e\.preventDefault\(\)[\s\S]{0,40}?doSend\(\)/, "Enter 没接到发送");
});

t("W3 表情数据源本地 /emoji/data.json（不依赖 CDN）", () => {
  has(WPC, /import "emoji-picker-element"/, "没注册 emoji-picker");
  has(WPC, /<emoji-picker\s+data-source="\/emoji\/data\.json"/, "没走本地 data-source");
  assert.ok(!/https?:\/\/(cdn|unpkg|jsdelivr)/i.test(WPC), "组件里混进了 CDN 表情源");
  has(VITE, /emoji-picker/, "vite 没把 emoji-picker 当自定义元素");
});

t("W4 表情插到光标处 + 点外面/Esc 收面板", () => {
  has(WPC, /insertText\(value, start, end, unicode, props\.maxlength\)/, "没走 insertText");
  has(WPC, /addEventListener\("pointerdown", onDocDown, true\)/, "没监听点外面");
  has(WPC, /root\.value\.contains\(e\.target\)/, "点面板里面也被误关");
  has(WPC, /e\.key === "Escape" && emojiOpen\.value/, "Esc 没收面板");
});

t("W5 面板方向：贴顶往下弹的类与 CSS 都在", () => {
  has(WPC, /pickerOpensUp\(r\.top, r\.bottom, vh, h\)/, "没接方向判定");
  has(WPC, /'emoji-down': !pickerUp/, "根节点没挂方向类");
  has(WPC, /\.wp-composer\.emoji-down \.wp-composer-picker\s*\{[\s\S]{0,80}?top:\s*calc\(100% \+ 8px\)/, "往下弹的 CSS 丢了");
});

t("W6 组件只发事件，不碰父页草稿/发送队列；focus 可被父页调用", () => {
  has(WPC, /emit\("update:modelValue", e\.target\.value\)/, "输入没回传 v-model");
  has(WPC, /emit\("send"\)/, "发送没回传父页");
  has(WPC, /defineExpose\(\{[\s\S]{0,120}?focus:/, "没暴露 focus");
  assert.ok(!/localStorage|dm_send|fetch\(/.test(WPC), "组件越权碰了存储/网络");
});

/* ── 轮 345：用户要「跟会话输入框一模一样」——按 .vac-* 实测值锁死 ── */
t("W7 评论底栏外壳 = .vac-box-footer（底色/上边/内边距/无阴影）", () => {
  const i = CSS.indexOf("轮 345 · 评论底栏与会话底栏同尺");
  assert.ok(i >= 0, "style.css 里轮 345 覆盖块丢了");
  const block = CSS.slice(i);
  has(block, /\.cmt-main-bar\s*\{[\s\S]{0,260}?align-items:\s*stretch/, "底栏没有 stretch");
  has(block, /\.cmt-main-bar\s*\{[\s\S]{0,260}?gap:\s*0/, "底栏还有 gap");
  has(block, /\.cmt-main-bar\s*\{[\s\S]{0,260}?padding:\s*10px 8px/, "桌面内边距不是 10px 8px");
  has(block, /\.cmt-main-bar\s*\{[\s\S]{0,260}?background:\s*var\(--page-bg, #faf9f5\)/, "底栏底色不是 --page-bg");
  has(block, /\.cmt-main-bar\s*\{[\s\S]{0,260}?border-top:\s*1px solid var\(--hairline, #e6dfd8\)/, "底栏上边不是 1px --hairline");
  has(block, /\.cmt-main-bar\s*\{[\s\S]{0,260}?box-shadow:\s*none/, "底栏还有阴影");
  has(block, /@media \(max-width: 768px\)[\s\S]{0,260}?padding:\s*7px 2px/, "手机内边距不是 7px 2px 7px 7px");
});

t("W8 输入框本体 = .vac-textarea（36px/20px 字/20px 圆角/24px 图标）", () => {
  has(WPC, /\.wp-composer-field[\s\S]{0,260}?padding:\s*0/, "胶囊壳还留着内边距（会多 2px 高）");
  has(WPC, /\.wp-composer-field[\s\S]{0,260}?background:\s*var\(--wash-strong, #fffdf9\)/, "胶囊底色不是会话的 var(--wash-strong)");
  has(WPC, /scrollHeight\s*-\s*pad\s*\*\s*2/, "自动长高没扣掉上下内边距（会多 14px）");
  has(WPC, /\.wp-composer-field[\s\S]{0,260}?border:\s*1px solid var\(--hairline, #e6dfd8\)/, "胶囊描边不是 --hairline");
  has(WPC, /\.wp-composer-field[\s\S]{0,260}?border-radius:\s*20px/, "胶囊圆角不是 20px");
  assert.ok(!/\.wp-composer-field:focus-within/.test(WPC), "焦点态又把珊瑚描边/光晕加回来了");
  has(WPC, /\.wp-composer-input[\s\S]{0,260}?height:\s*20px/, "输入区高度不是 20px");
  has(WPC, /\.wp-composer-input[\s\S]{0,260}?font-size:\s*16px/, "字号不是 16px");
  has(WPC, /\.wp-composer-input[\s\S]{0,260}?padding:\s*12px 16px 12px 12px/, "桌面内边距不是 12/16/12/12");
  has(WPC, /@media \(max-width: 768px\)[\s\S]{0,180}?padding:\s*7px 7px 7px 12px/, "手机内边距不是 7/7/7/12");
  has(WPC, /@media \(max-width: 768px\)[\s\S]{0,180}?line-height:\s*18px/, "手机行高不是 18px");
  has(WPC, /\.wp-composer-ico\s*\{[\s\S]{0,260}?width:\s*38px;[\s\S]{0,60}?height:\s*24px/, "桌面图标位不是 38×24");
  has(WPC, /\.wp-composer-ico svg\s*\{[\s\S]{0,80}?width:\s*24px;[\s\S]{0,40}?height:\s*24px/, "图标不是 24px");
  has(WPC, /\.wp-composer-ico\.is-emoji\s*\{[\s\S]{0,120}?margin-left:\s*5px/, "表情键没有 5px 间距");
});

t("W9 手机卡内占位条也换成会话胶囊色（不再是浅蓝 12px 圆角）", () => {
  const i = CSS.indexOf("轮 345 · 评论底栏与会话底栏同尺");
  const block = CSS.slice(i);
  has(block, /\.cmt-entry\s*\{[\s\S]{0,260}?height:\s*36px/, "占位条高度不是 36px");
  has(block, /\.cmt-entry\s*\{[\s\S]{0,260}?border-radius:\s*20px/, "占位条圆角不是 20px");
  has(block, /\.cmt-entry\s*\{[\s\S]{0,260}?background:\s*#fffdf9/, "占位条底色不是 #fffdf9");
});

/* ── 两处页面接线 ── */
t("W10 表情/纸飞机图标 = vue-advanced-chat 的两条 path", () => {
  has(WPC, /M11\.99 2C6\.47 2 2 6\.48 2 12/, "表情图标不是会话组件那条");
  has(WPC, /M2,21L23,12L2,3V10L17,12L2,14V21Z/, "纸飞机不是会话组件那条（禁用态会不一样）");
  assert.ok(!/M21 3 14\.4 21/.test(WPC), "旧的自绘纸飞机又回来了");
});

for (const [name, src, refName] of [["CommunityView", WALL, "mainBarInput"], ["PostDetailView", DETAIL, "detailBarInput"]]) {
  t(`P1 ${name}：4 处输入框全是 WpComposer（一级/一级回复/二级回复/底部条）`, () => {
    const list = tags(src);
    assert.equal(list.length, 4, `WpComposer 数量不是 4：${list.length}`);
    for (const tag of list) {
      assert.ok(/v-model=/.test(tag), `有一处没接 v-model：${tag.slice(0, 60)}`);
      assert.ok(/@send=/.test(tag), `有一处没接 @send：${tag.slice(0, 60)}`);
    }
    has(src, /import WpComposer from "\.\.\/components\/WpComposer\.vue"/, "没引入 WpComposer");
    has(src, new RegExp(`ref="${refName}"[^>]*v-model=`), `底部条的 ref="${refName}" 没保留`);
  });
}

t("P2 评论里不再混旧输入框（textarea / van-field）", () => {
  assert.ok(!WALL.includes("<textarea"), "CommunityView 评论里还留着 textarea");
  assert.ok(!DETAIL.includes("<textarea"), "PostDetailView 评论里还留着 textarea");
  /* 暖心墙顶部发帖的 van-field 保留；评论区的 cmt-input 里不该再有 van-field */
  const cmt = WALL.slice(WALL.indexOf('class="cmt-input cmt-input-top"'), WALL.indexOf('class="cmt-input cmt-input-top"') + 600);
  assert.ok(!cmt.includes("van-field"), "一级评论框还是 van-field");
});

t("P3 一级/二级回复仍走原发送函数（数据链一行没改）", () => {
  has(WALL, /@send="sendTopCmt\(p\)"/, "一级评论发送没接 sendTopCmt");
  has(WALL, /@send="sendCmt\(p, cm\)"/, "一级回复没接 sendCmt(p, cm)");
  has(WALL, /@send="sendCmt\(p, cm, rp\)"/, "二级回复没接 sendCmt(p, cm, rp)");
  has(WALL, /@send="sendMainBar"/, "手机底部条没接 sendMainBar");
  has(DETAIL, /@send="sendTopCmt\(\)"/, "详情页一级评论没接 sendTopCmt");
  has(DETAIL, /@send="sendCmt\(cm\)"/, "详情页一级回复没接 sendCmt(cm)");
  has(DETAIL, /@send="sendCmt\(cm, rp\)"/, "详情页二级回复没接 sendCmt(cm, rp)");
  has(DETAIL, /@send="sendDetailBar"/, "详情页底部条没接 sendDetailBar");
});

t("P4 中英都有「表情」按钮文案", () => {
  has(I18N, /emoji:\s*"Emoji"/, "英文 comment.emoji 丢了");
  has(I18N, /emoji:\s*"表情"/, "中文 comment.emoji 丢了");
});

/* ── 轮 349：内联评论框的表情面板被帖子卡裁掉上半截 ──
 * .post-card 的 content-visibility:auto 隐含 paint containment，面板伸到卡顶以上的
 * 导航行 + 第一排表情会被整块裁掉（用户截图：面板从卡顶开始、上面缺一块）。 */
t("P5 表情面板打开时帖子卡必须让路（不裁、不压在上一张卡下）", () => {
  has(CSS, /\.post-card:has\(\.wp-composer-picker\.is-open\)\s*\{[^}]*content-visibility:\s*visible/, "卡片还留着 paint containment（面板上半截会被裁）");
  has(CSS, /\.post-card:has\(\.wp-composer-picker\.is-open\)\s*\{[^}]*z-index:\s*2/, "卡片没抬到上一张卡之上");
  /* 轮 517：面板改「保活 + is-open 类」（v-if 卸载重建 = 用户说的「一闪」）。
   * :has 必须认 .is-open，否则面板 DOM 常驻会让每一张卡都命中。 */
  has(WPC, /:class="\{ 'is-open': emojiOpen \}"/,
    "面板没有 is-open 类开关（:has 会一直命中所有卡）");
  has(WPC, /\.wp-composer-picker\.is-open\s*\{\s*display:\s*block/,
    "is-open 没有把面板显示出来");
});

/* ── 轮 350：面板 → 键盘交接（底条先掉屏底再被顶回来）+ 面板里点表情抢焦点 ──
 * 真机 393×895 实测：面板开着点输入框，barY 518→781→525（掉 256px）；
 * 面板里点一个表情，输入法立刻弹起（看着像「选一个就自动切回文字输入」）。 */
t("P6 轮 350：收面板时底条让位钉到键盘上来；面板里点表情不抢焦点", () => {
  /* 轮 482：钉住的高度从写死 320 改成 --kb-panel-h（上一次真实键盘高） */
  has(CSS, /\.cmt-main-bar\.wp-kb-swap \{\s*\n\s*bottom: var\(--kb-panel-h\);/, "没有 .wp-kb-swap 的钉住规则（底条会先掉到屏底）");
  has(WPC, /if \(isSheet\(\)\) holdForKeyboard\(\);/, "onDocClick 里没在收面板前钉住底条");
  /* 轮 506：摘钉判据扩成「--kb-h 或 --kbb > 0」—— iOS 上推可视视口时 --kb-h 恒为 0，
     只盯它会让钉一直挂到 600ms 兜底，那段时间输入行悬在键盘上方一个面板高。 */
  has(WPC, /const k = parseFloat\(de\.getPropertyValue\("--kbb"\)\) \|\| 0;/, "没把 --kbb 纳入摘钉判据");
  /* 轮 510：判据从「--kbb > 0」改成「比挂上时涨了 ≥80」。
     轮 509 之后无键盘的 --kbb 就是 Safari 工具栏高（81px，不再恒为 0），
     旧判据一挂上即成立 → swap 立刻被摘 → 收面板那一下失去钉住，
     用户看到的「中间一块空白，随后折叠」就是这一下。 */
  has(WPC, /const holdKbb = parseFloat\(getComputedStyle\(document\.documentElement\)\.getPropertyValue\("--kbb"\)\) \|\| 0;/, "没记挂上时的 --kbb 基线");
  /* 轮 511：判据从「比基线高 80」改成「跟基线差 80」——
     iOS 上推可视视口时键盘态 --kbb 是 **变小**（工具栏 81 → 键盘态 0），
     要求「变大」永远不成立，swap 只能等 1200ms 兜底，那一整秒多里底条被
     padding 顶在屏幕中部、下面一大片空白（用户截图红框 + 「点了没反应」）。 */
  has(WPC, /if \(v > 0 \|\| Math\.abs\(k - holdKbb\) >= 60\) endKbSwap\(\);/, "没按「--kbb 相对基线明显变化」摘钉（只认变大 = iOS 上推态永不成立）");
  /* 轮 496：不再无条件「网页端不钉」——走 visualViewport 让位路线的浏览器里，收面板那刻
     --kb-h 还是 0，底条会先掉 249px 再被键盘顶回来（393×852 实测）。改由 webSwapNeeded 判：
     只有「浏览器自己缩布局视口」那批不钉（钉住会悬空）。 */
  has(WPC, /if \(!isApp && !webSwapNeeded\(\)\) return;/, "交接条件没走 webSwapNeeded（缩布局视口型内核会先悬空 1.2s）");
  has(WPC, /if \(!isSheet\(\)\) \{\s*\n\s*try \{\s*\n\s*n\.focus\(\);/, "onEmoji 里手机也会 focus（输入法弹起来把面板顶掉）");
});

/* 轮401：用户指出暖心墙评论输入也有「再点表情直接折叠」——不是只修私信。 */
t("P7 轮401 评论输入：表情键二次点击 = 键盘键（换图标 + 回焦点 + 让位钉住）", () => {
  has(WPC, /const emojiLabel = computed\(\(\) => emojiOpen\.value \? t\("comment\.keyboard"\) : t\("comment\.emoji"\)\)/, "没有按开关切换按钮语义");
  /* 轮 510：顺序改成「先同步 focus → 再收面板 → 再钉让位」。
     iOS 只在用户手势的同步栈里认 focus()，而 holdForKeyboard / 面板消失都会改布局；
     先改样式再 focus 等于把刚拿到的焦点交给一次重排。 */
  has(WPC, /if \(emojiOpen\.value\) \{[\s\S]{0,400}ta\.value\.focus\(\);[\s\S]{0,120}emojiOpen\.value = false;[\s\S]{0,120}if \(isSheet\(\)\) holdForKeyboard\(\)/, "二次点击没「先同步回焦点、再钉让位」");
  has(WPC, /v-if="emojiOpen"[\s\S]{0,520}M20 5H4/, "面板打开时没换成键盘图标");
  has(WPC, /:title="emojiLabel"/, "按钮 title 没跟开关走");
  has(I18N, /keyboard:\s*"Keyboard"/, "英文 comment.keyboard 丢了");
  has(I18N, /keyboard:\s*"键盘"/, "中文 comment.keyboard 丢了");
});

/* 轮 513 · 面板占位必须是**量出来的内联 padding**，不能只靠 CSS 规则。
 * 用户报「切换键盘跟发送按钮没效果」「按上面的空白处也能选表情」—— 同一个原因：
 * 面板是 fixed + z-index 170，条只有 150；只要撑高条的那条规则没命中（kb-web 漏了、
 * .wp-emoji-open 没挂上、App 壳走别的分支），面板就整个盖在输入行和发送键上。
 * 内联 padding 不看任何选择器，量多少让多少，盖不住。 */
t("P8 轮513 面板占位走实测内联 padding（不靠 CSS 规则，别再盖住发送键）", () => {
  /* 轮 516：内联值改成 calc 表达式（--vtop 变化由浏览器自己重算），不再是 h + "px"。
     必须扣可视视口上推量：iOS 键盘态页面底已经是键盘上沿，整份让位等于让两次
     （工装 panel-press-60 实测底条被顶到屏幕 148，该 ~437）。 */
  has(WPC, /const syncPad = \(\) => \{[\s\S]{0,400}getBoundingClientRect\(\)\.height[\s\S]{0,160}paddingBottom = CAN_MAX/,
    "没有按实测高度写内联让位（面板会盖住输入行/发送键）");
  has(WPC, /max\(0px, \$\{h\}px - var\(--vtop, 0px\)\)/,
    "内联让位没扣 --vtop（键盘上推时底条会被顶到屏幕上半部）");
  has(WPC, /: h \+ "px"/, "不支持 max() 的内核没有兜底（让位会归零、面板盖住输入条）");
  has(WPC, /if \(!emojiOpen\.value \|\| !isSheet\(\) \|\| !el\) \{ clearPad\(\); return; \}/,
    "面板收起/桌面形态没清内联让位（条会一直悬着一条空白）");
  has(WPC, /padRO = new ResizeObserver\(\(\) => syncPad\(\)\)/, "没盯面板自身高度（数据晚到时让位会少一截）");
  has(WPC, /clearTimeout\(padTimer\)/, "卸载没清补量定时器");
  /* 轮 513 · 量的必须是外层容器 `.wp-composer-picker`（定高 = --kb-panel-h），
     不是 <emoji-picker> 本体（内容高，实测 265 vs 容器 300 —— 差 35px 会让输入行
     压进面板顶边）。工装实测抓到的：改前 pad=265、面板 300。 */
  has(WPC, /closest\("\.wp-composer-picker"\)/,
    "让位量的是自定义元素本体而不是外层容器（差一条面板内边距，输入行会压进面板）");
  has(WPC, /padRO\.observe\(padEl\(\)\)/, "ResizeObserver 没盯外层容器（容器变高时让位不跟）");
});

console.log(out.join("\n"));
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
