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
  has(BC, /:host\(\.wp-kb-swap\) \.vac-box-footer \{\s*\n\s*padding-bottom: var\(--wp-emoji-h\) !important;[\s\S]{0,90}?transition: none !important;/, "没有 .wp-kb-swap 的钉住规则（输入框会先掉屏底）");
  /* 轮 516 · 钉住量必须扣掉可视视口上推量 --vtop。
   * iOS 键盘态会把可视视口上推（offsetTop = 键盘高），页面底**已经**是键盘上沿；
   * 整份让位等于让两次。组装级工装（dm-sheet-drive）实测「键盘 → 表情」：
   * 输入行屏幕 469 → 146 → 405。扣掉之后全程稳定在 469~486，不再窜到上半屏。 */
  has(BC, /:host\(\.wp-kb-swap\) \.vac-box-footer \{[\s\S]{0,200}?max\(0px, var\(--wp-emoji-h\) - var\(--vtop, 0px\)\)/,
    "钉住量没扣 --vtop（键盘还在上推时会让位两次，输入条窜到屏幕上半部）");
  /* 轮 512 · 这条原来要求「footer 上常驻 padding-bottom 的 .22s 过渡」，
   * 工装实测把它推翻了（安卓模型 393×852 / 键盘 300）：
   *   to-panel+20   picker 已铺到 552..852，条还在 767..852、pad 仅 41
   *   to-panel+120  pad 才到 300，条落定 508
   * 面板是**瞬现**的（组件直接插节点，没有过渡），让位却慢 .22s ——
   * 中间 200ms 输入条被面板盖住，然后从屏底爬上来，这就是用户说的「有一闪的东西」。
   * 所以口径反过来：不许有常驻过渡，撑起必须同帧到位；
   * 「面板 → 键盘」那半段由 :host(.wp-kb-swap) 的 transition: none 负责。 */
  assert.doesNotMatch(BC, /\.vac-box-footer \{ transition: padding-bottom/,
    "footer 又挂回常驻的 padding 过渡（开面板时输入条会被面板盖住再爬上来）");
  has(BC, /:host\(\.wp-kb-swap\) \.vac-box-footer \{[\s\S]{0,320}?transition: none !important;/,
    ".wp-kb-swap 没把过渡关掉（钉住那一刻会被 .22s 拖成滑动）");
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

/* 轮 511 · 私信页页面盒子在 iOS 上必须用「布局视口高(--vlh) − 让位量(--kbb)」。
 *
 * iOS Safari 的底部工具栏是**浮层**：既不缩布局视口，也不改 100dvh。所以
 * `height: calc(100dvh - var(--kb-h))` 算出来是整屏 852，而可视区只有 771 ——
 * 页面盒子底边沉到工具栏下面 81px，底栏和表情面板跟着一起沉。
 * 正确式子 = 布局视口高(--vlh) − 让位量(--kbb)：
 *   无键盘 852 − 81(工具栏) = 771 ✓；键盘上推 852 − 0 = 852（iOS 已把可视区上推）✓
 * 不能用 --vph：那是「含键盘」的可视高（键盘态 522），页面缩到 522 再叠上 iOS 的
 * 上推，输入条会悬在键盘上方一条工具栏。
 *
 * 轮 512 · **这套式子只许挂在 overlay 型内核上**（html.kb-overlay）。
 * 用户原话：「安卓本来好好的，你改苹果之后全是问题」。安卓/小米是 resize 型：
 * 键盘一弹窗口自己就缩，innerHeight 随地址栏实时变，套上 --vlh 会让页面高度
 * 一帧一帧改（还带 .22s 过渡）→ 退出会话的缩放感、切表情的一闪。
 * 所以这条断言改成三段，任何一段不满足都红：
 *   ① 默认（resize 型）必须是 `100dvh − --kb-h` —— 轮 511 之前那套，原样；
 *   ② 默认这条里**不许出现 --vlh**（防止有人图省事又合并回去）；
 *   ③ overlay 型才允许 `--vlh − --kbb`。 */
t("L8 页面盒子按内核分流：安卓 resize 型保持 100dvh−kb-h，iOS overlay 型才用 --vlh−--kbb", () => {
  /* ① resize 型：原式子 */
  assert.match(CSS, /html\.kb-web \.dm-page--chat[^{]*\{[^}]*height: calc\(100dvh - var\(--kb-h/,
    "默认（resize 型）.dm-page--chat 没回到 100dvh − --kb-h");
  assert.match(CSS, /html\.kb-web \.shell--mobile-nav\.shell--chat \.dm-page \{[^}]*height: calc\(100dvh - var\(--kb-h/,
    "默认（resize 型）外壳 .shell--chat .dm-page 没回到 100dvh − --kb-h");
  /* ② 默认那条里不许混进 --vlh：CSS 里 --vlh 只应出现在 .kb-overlay 选择器下 */
  const vlhRules = CSS.match(/[^{}]*\{[^}]*var\(--vlh/g) || [];
  assert.ok(vlhRules.length > 0, "一条 --vlh 规则都没有（iOS 那边会退回裸 100dvh）");
  const bad = vlhRules.filter((r) => !/kb-overlay/.test(r));
  assert.equal(bad.length, 0, "有规则用了 --vlh 却没限定 .kb-overlay（安卓会被一起套上）");
  /* ③ overlay 型 */
  assert.match(CSS, /html\.kb-web\.kb-overlay \.dm-page--chat[^{]*\{[^}]*height: calc\(var\(--vlh, \S+\) - var\(--kbb/,
    "overlay 型 .dm-page--chat 没接「--vlh − --kbb」");
  assert.match(CSS, /html\.kb-web\.kb-overlay \.shell--mobile-nav\.shell--chat \.dm-page[^{]*\{[^}]*height: calc\(var\(--vlh, \S+\) - var\(--kbb/,
    "overlay 型外壳那条没接「--vlh − --kbb」");
});

/* ═══ 轮 517：退出会话 / 切表情 两条「一闪一缩」的接线锁 ═══
 * 行为层由 tools/chat-exit-drive.mjs（真渲染）与 tools/androidbar-drive.mjs 量，
 * 这里只锁「接线别被删掉」—— 那两个函数一断，真渲染工装也不会红（它直接调 release）。 */

t("L9 退出会话必须同帧拆掉 fixed 接管（不许只靠 250ms 巡检）", () => {
  const MV = fs.readFileSync("src/views/MessagesView.vue", "utf8");
  has(MV, /import \{[^}]*releaseChatViewport[^}]*\} from "\.\.\/utils\/chatViewport\.js"/,
    "MessagesView 没引 releaseChatViewport");
  assert.match(MV, /watch\(chatOpen,[\s\S]{0,420}?releaseChatViewport\(\)/,
    "chatOpen 变 false 时没调 releaseChatViewport（退出那一刻页面会被钉在 fixed 框里）");
  /* 顺序：恢复列表位置必须在拆接管之后（否则 scrollTop 写进一个裁切框里） */
  assert.match(MV, /watch\(activeId,[\s\S]{0,300}?releaseChatViewport\(\);[\s\S]{0,80}?restoreListScroll\(\)/,
    "restoreListScroll 没排在 releaseChatViewport 之后（写进去的滚动位置会被裁掉）");
});

t("L10 表情面板必须保活（v-if 每次重建 = 用户说的「一闪」）", () => {
  const WPC = fs.readFileSync("src/components/WpComposer.vue", "utf8");
  has(WPC, /v-if="pickerMounted"[\s\S]{0,200}?class="wp-composer-picker"/,
    "面板还是 v-if=\"emojiOpen\"（每次切键盘都卸载，再点表情重建 emoji-picker）");
  has(WPC, /:class="\{ 'is-open': emojiOpen \}"/,
    "面板没有 is-open 类开关（收起后要能隐藏）");
  /* 关面板时不许把就绪态置 false：实例还在，置 false 会让下次打开先渲染一帧骨架。
     只认真正的代码行（注释里也写着这句话，别被自己的注释骗了）。 */
  const close = WPC.slice(WPC.indexOf("if (!open)"), WPC.indexOf("if (!open)") + 520);
  no(close, /^\s*pickerReady\.value = false;/m,
    "关面板还把 pickerReady 置 false（下次打开会先闪一帧骨架）");
});

console.log(`chat-look-test: ${pass} pass, ${fails.length} fail`);
if (fails.length) { for (const f of fails) console.log("  FAIL " + f); process.exit(1); }
