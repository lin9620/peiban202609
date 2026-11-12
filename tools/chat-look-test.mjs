/* 轮 349 · 会话段三处视觉锁（用户：不要虚线 / 日期不要白底 / 输入条上下要一样）
 *   node tools/chat-look-test.mjs
 *
 * 只锁「会看出来的那一层」：头部分隔线、日期胶囊底色、手机底栏的上下留白。
 * 数值口径来自真机尺寸的无头实测（934×869 App 形态 + 390×844 手机）：
 *   · 头：.vac-room-header 的 border-bottom 原本是 1px dashed → 必须 0；
 *   · 日期：「今天」「10月24日」原本 background = --wash-mid（rgba(255,255,255,.72)）→ 必须 transparent；
 *   · 输入条：.dm-thread 原本底部再垫 10px + 安全区，底栏自己还有 10px（上 10 / 下 20）→
 *     底部只留安全区。轮 358 再把顶部那 14px 去掉：聊天头自己有 60px 高，
 *     状态栏下面只让 --sat，不再多垫一条（用户截图红框）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const BC = fs.readFileSync("src/components/DmVacChat.vue", "utf8");
const CSS = fs.readFileSync("src/style.css", "utf8");

let pass = 0;
const fails = [];
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fails.push(name + " —— " + e.message); } };
const has = (src, re, msg) => { if (!re.test(src)) throw new Error(msg); };
const no = (src, re, msg) => { if (re.test(src)) throw new Error(msg); };

/* 取 THEME_CSS 里某个选择器的规则块 */
const block = (src, sel) => {
  const i = src.indexOf(sel + " {");
  if (i < 0) return "";
  const j = src.indexOf("}", i);
  return src.slice(i, j + 1);
};

t("L1 会话头没有虚线分隔（border-bottom 归零）", () => {
  const b = block(BC, ".vac-room-header");
  assert.ok(b, "找不到 .vac-room-header 规则");
  has(b, /border-bottom:\s*0\s*!important/, "头部还留着分隔线");
  no(b, /dashed/, "头部还是虚线");
});

t("L2 两条日期（10月24日 / 今天）都没有胶囊底色", () => {
  /* 顶部「会话开始于」那条 + 消息中间的日期分隔，必须在同一个 transparent 规则里 */
  has(BC, /\.vac-col-messages \.vac-text-started,\s*\n\s*\.vac-message-wrapper \.vac-card-info\.vac-card-date,\s*\n\s*\.vac-messages-container \.vac-card-info\.vac-card-date,\s*\n\s*\.vac-card-info\.vac-card-date \{[^}]*background:\s*transparent\s*!important/,
    "日期还在用底色（或只覆盖了其中一条）");
  no(BC, /\.vac-card-info\.vac-card-date[^{]*\{[^}]*background:\s*var\(--wash-mid/, "日期还是米白胶囊");
  has(BC, /\.vac-card-info\.vac-card-date[^{]*\{[^}]*color:\s*var\(--ink-soft/, "日期字色被改掉了");
});

t("L3 旧头 / 漂流瓶头（.dm-thread-head）也没有虚线（与会话段同口径）", () => {
  const b = block(CSS, ".dm-thread-head");
  assert.ok(b, "找不到 .dm-thread-head 规则");
  no(b, /dashed/, "旧头还是虚线");
  no(b, /border-bottom/, "旧头还留着分隔线");
});

t("L4 手机聊天底栏：顶部只让状态栏、底部只让安全区（不再多垫 14px / 10px）", () => {
  const i = CSS.indexOf(".shell--mobile-nav.shell--chat .dm-thread {");
  assert.ok(i > 0, "找不到手机聊天 .dm-thread 规则");
  const b = CSS.slice(i, CSS.indexOf("}", i) + 1);
  /* 轮 358：顶部不再垫 14px —— 聊天头自己有 60px 高，那 14px 就是用户截图里的空白 */
  has(b, /padding:\s*var\(--sat,[^\n]*?\)\)\s*0\s*var\(--sab/, "顶部没有只让 --sat（聊天头上方会多一条空白）");
  no(b, /calc\(14px \+ var\(--sat/, "顶部又垫回了 14px");
  no(b, /calc\(10px \+ var\(--sab/, "底部还有那条多余的 10px");
});

t("L5 表情面板打开时底栏让位仍然归零（轮 347 那条不能被顶掉；轮 350 面板→键盘交接同款）", () => {
  has(CSS, /\.dm-thread\.wp-emoji-open,\s*\n\s*\.shell--mobile-nav\.shell--chat \.dm-thread\.wp-kb-swap \{ padding-bottom: 0; \}/, "面板打开时底栏让位没了（输入条会被顶到半空）");
  has(BC, /:host\(\.wp-emoji-open\) \.vac-box-footer \{\s*\n\s*padding-bottom: var\(--wp-emoji-h\)/, "组件内 footer 让位没了");
});

t("L7 轮 350 面板→键盘交接：让位钉住 + 过渡同曲线（否则输入框先掉屏底再被顶回来）", () => {
  has(BC, /:host\(\.wp-kb-swap\) \.vac-box-footer \{\s*\n\s*padding-bottom: var\(--wp-emoji-h\) !important;\s*\n\s*transition: none !important;/, "没有 .wp-kb-swap 的钉住规则（输入框会先掉屏底）");
  has(BC, /\.vac-box-footer \{ transition: padding-bottom \.22s cubic-bezier\(\.2, \.8, \.2, 1\); \}/, "footer 过渡不是常驻/曲线与 .dm-page 不一致（交接时会抖）");
  has(BC, /const holdForKeyboard = \(\) => \{/, "没有 holdForKeyboard");
  has(BC, /holdForKeyboard\(\); {10,}\/\* 让位先钉住/, "closeKeepFocus 里没调 holdForKeyboard（或没在收面板之前调）");
  /* 轮 506：摘钉的判据从「--kb-h > 0」扩成「--kb-h > 0 或 --kbb > 0」——
     iOS 上推可视视口时 --kb-h 恒为 0，只盯它会让钉一直挂到 600ms 兜底。 */
  /* 轮 510：无键盘时 --kbb 已经等于 Safari 工具栏高（81px），旧判据「k > 0」一挂上
     就成立、swap 立刻被摘 → 收面板那一下失去钉住（用户：「中间一块空白，随后折叠」）。
     轮 511：判据改成「跟基线差 ≥60」，不再要求「涨」——
     iOS 上推可视视口时键盘态 --kbb 是 81 → 0（变小），要求涨 80 永远不成立，
     swap 只能等兜底，那一整秒多里条被 padding 顶在屏幕中部（用户截图红框）。 */
  has(BC, /const k = parseFloat\(de\.getPropertyValue\("--kbb"\)\) \|\| 0;/, "没有把 --kbb 纳入摘钉判据");
  has(BC, /const holdKbb = parseFloat\(getComputedStyle\(document\.documentElement\)\.getPropertyValue\("--kbb"\)\) \|\| 0;/, "没记挂上时的 --kbb 基线");
  has(BC, /if \(v > 0 \|\| Math\.abs\(k - holdKbb\) >= 60\) endKbSwap\(\);/, "没按「--kbb 相对基线明显变化」摘钉（只认变大 = iOS 上推态永不成立）");
  /* 轮 496：原来这里锁的是「网页端一律不钉」—— 实测 393×852 网页端收面板那一刻
     --kb-h 还是 0，输入框掉 249px 再被键盘顶回来。改成「按 webSwapNeeded 判」：
     走 visualViewport 让位路线的设备要钉，缩布局视口型（浏览器自己缩）不钉、否则悬空。 */
  has(BC, /if \(!isApp && !webSwapNeeded\(\)\) return;/, "面板→键盘交接没走 webSwapNeeded（缩布局视口型内核会先悬空 1.2s）");
});

t("L8 短消息气泡贴合文字（组件自带 min-width:100px 被归零）", () => {
  const b = block(BC, ".vac-message-wrapper .vac-message-container");
  assert.ok(b, "找不到 .vac-message-wrapper .vac-message-container 规则");
  has(b, /min-width:\s*0(?:\s*!important)?/, "短消息气泡仍被 min-width:100px 撑宽（一个字也占 100px）");
});

t("L6 桌面不受影响：这两条只动 App/手机壳（≥900 的布局规则没被改）", () => {
  /* 桌面聊天还是原来的卡片：.dm-thread 基础规则仍有 14px padding */
  has(CSS, /\.dm-thread \{ display: flex; flex-direction: column; min-height: 60vh; padding: 14px; \}/, "桌面 .dm-thread 被改了");
  /* 头部分隔线只在组件 shadow 里，桌面/手机同一份 —— 断言没有第二处 dashed 头部规则复活 */
  no(BC, /\.vac-room-header[^{]*\{[^}]*dashed/, "又出现一条带虚线的头部规则");
});

/* 轮 511 · 私信页页面盒子必须用「布局视口高(--vlh) − 让位量(--kbb)」，不能用裸 100vh / 100dvh。
 *
 * iOS Safari 的底部工具栏是**浮层**：既不缩布局视口，也不改 100dvh。所以
 * `height: calc(100dvh - var(--kb-h))` 算出来是整屏 852，而可视区只有 771 ——
 * 页面盒子底边沉到工具栏下面 81px，底栏和表情面板跟着一起沉：
 * 用户发来的两张图（面板最后一排被工具栏压住、输入条下方一大片空白）就是这个。
 * 正确式子 = 布局视口高(--vlh) − 让位量(--kbb)：
 *   无键盘 852 − 81(工具栏) = 771 ✓；键盘上推 852 − 0 = 852（iOS 已把可视区上推）✓
 * 不能用 --vph：那是「含键盘」的可视高（键盘态 522），页面缩到 522 再叠上 iOS 的
 * 上推，输入条会悬在键盘上方一条工具栏。 */
t("L8 私信页页面盒子 = 布局视口高 − 让位量（裸 100dvh 不扣 Safari 浮动工具栏）", () => {
  assert.match(CSS, /html\.kb-web \.dm-page--chat \{[^}]*height: calc\(var\(--vlh, \S+\) - var\(--kbb/,
    "网页端 .dm-page--chat 的高度不是「布局视口高 − 让位量」");
  assert.doesNotMatch(CSS, /html\.kb-web \.dm-page--chat \{[^}]*height: calc\(100dvh/,
    "网页端 .dm-page--chat 还在用裸 100dvh（页面会比可视区高一条工具栏）");
  assert.match(CSS, /html\.kb-web \.shell--mobile-nav\.shell--chat \.dm-page \{[\s\S]{0,900}?height: calc\(var\(--vlh, \S+\) - var\(--kbb/,
    "外壳那条 .shell--chat .dm-page 也不是「布局视口高 − 让位量」");
});

console.log(`chat-look-test: ${pass} pass, ${fails.length} fail`);
if (fails.length) { for (const f of fails) console.log("  FAIL " + f); process.exit(1); }
