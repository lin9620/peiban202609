/* 轮 348 · 表情面板三条（app 去搜索框 / 点输入框键盘不塌 / 暖心墙与会话同款）
 *   node tools/emoji-panel-test.mjs
 * 源码锁 + 纯函数真跑：hideEmojiSearch 用假 shadowRoot 验「塞一条 style、且幂等」。
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const BC = fs.readFileSync("src/components/DmVacChat.vue", "utf8");
const WC = fs.readFileSync("src/components/WpComposer.vue", "utf8");
const CSS = fs.readFileSync("src/style.css", "utf8");
const UTIL = fs.readFileSync("src/utils/emojiPanel.js", "utf8");

let pass = 0;
const fails = [];
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fails.push(name + " —— " + e.message); } };
const has = (src, re, msg) => { if (!re.test(src)) throw new Error(msg); };
const no = (src, re, msg) => { if (re.test(src)) throw new Error(msg); };

/* hideEmojiSearch 只碰 document.createElement + shadowRoot，Node 里给个最小壳就能真跑 */
globalThis.document = { createElement: () => ({ attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, textContent: "" }) };
const { hideEmojiSearch, hideEmojiSearchIn } = await import("../src/utils/emojiPanel.js");

/* ── ① 去搜索框（app 端，两个面板都去） ── */
t("E1 hideEmojiSearch：塞一条 .search-row{display:none}，且幂等", () => {
  const made = [];
  const sr = { querySelector: () => null, appendChild: (n) => made.push(n) };
  assert.equal(hideEmojiSearch({ shadowRoot: sr }), true);
  assert.equal(made.length, 1, "没有塞 style");
  assert.match(made[0].textContent, /\.search-row\{display:none !important;\}/, "藏的不是 .search-row");
  assert.equal(made[0].attrs["data-wp-nosearch"], "1", "没有幂等标记");
  /* 第二次：已经有一条 → 不再追加 */
  const sr2 = { querySelector: (q) => (q === "style[data-wp-nosearch]" ? {} : null), appendChild: (n) => made.push(n) };
  assert.equal(hideEmojiSearch({ shadowRoot: sr2 }), true);
  assert.equal(made.length, 1, "重复调用又塞了一条");
  /* 批量入口：没有 shadowRoot / 空 root 不能炸 */
  assert.equal(hideEmojiSearchIn(null), 0);
  assert.equal(hideEmojiSearchIn({ querySelectorAll: () => [{}, { shadowRoot: null }] }), 0);
  assert.equal(hideEmojiSearch(null), false);
});

t("E2 会话段：组件 shadow 里每次同步都把搜索框收掉", () => {
  has(BC, /import \{ hideEmojiSearchIn \} from "\.\.\/utils\/emojiPanel\.js"/, "DmVacChat 没引工具");
  has(BC, /const syncEmoji = \(\) => \{[\s\S]{0,320}hideEmojiSearchIn\(sr\)/, "syncEmoji 没调（面板重建后搜索框会回来）");
  has(BC, /emojiMO\.observe\(sr, \{ childList: true, subtree: true \}\)/, "MutationObserver 被删（面板重开不再同步）");
});

t("E3 暖心墙：picker ref + 打开时去搜索框", () => {
  has(WC, /import \{ hideEmojiSearch \} from "\.\.\/utils\/emojiPanel\.js"/, "WpComposer 没引工具");
  has(WC, /const picker = ref\(null\)/, "没有 picker ref");
  has(WC, /<emoji-picker data-source="\/emoji\/data\.json" ref="picker"/, "模板没挂 ref");
  has(WC, /watch\(emojiOpen, async \(open\) => \{[\s\S]{0,420}hideEmojiSearch\(picker\.value\)/, "打开时没去搜索框");
  has(WC, /setTimeout\(\(\) => hideEmojiSearch\(picker\.value\), 80\)/, "没有晚一帧的补刀（shadow 未就绪时）");
});

/* ── ② 点输入框键盘不塌 ── */
t("E4 会话段：touchstart 不许库先收面板，click 再收 + 回焦点", () => {
  has(BC, /const inInputArea = \(e\) => \{/, "没有「点的是不是输入区」判定");
  has(BC, /tapClosePending = true;\s*\n\s*e\.stopPropagation\(\);/, "touchstart 没拦住库的 click-outside");
  has(BC, /footer\.addEventListener\("click", \(e\) => \{[\s\S]{0,260}closeKeepFocus\(\)/, "click 阶段没补收面板");
  has(BC, /const closeKeepFocus = \(\) => \{[\s\S]{0,560}ta\.focus\(\)/, "收面板后没把焦点还给输入框");
  /* 轮 350：收面板前必须先钉住让位（否则输入框先掉屏底、键盘上来再顶回去） */
  has(BC, /const closeKeepFocus = \(\) => \{[\s\S]{0,200}holdForKeyboard\(\);[\s\S]{0,400}ta\.focus\(\)/, "收面板前没钉住让位（holdForKeyboard）");
  /* 表情按钮 / 面板自身必须排除，否则点表情会「收了又开」 */
  has(BC, /contains\("vac-emoji-wrapper"\)[\s\S]{0,8}return false/, "没排除表情按钮");
  has(BC, /if \(path\.includes\(picker\)\) return false;/, "没排除面板自身");
});

t("E5 暖心墙：pointerdown 只记标记，click 才收面板（否则底条会被当成点空白关掉）", () => {
  has(WC, /let tapClosePending = false;/, "没有 pending 标记");
  has(WC, /if \(field \|\| e\.target === ta\.value\) tapClosePending = true;/, "pointerdown 直接收面板（会点空）");
  no(WC, /if \(field \|\| e\.target === ta\.value\) \{\s*\n\s*emojiOpen\.value = false;/, "pointerdown 里还在收面板");
  has(WC, /const onDocClick = \(\) => \{[\s\S]{0,260}emojiOpen\.value = false;[\s\S]{0,200}ta\.value\.focus\(\)/, "click 没收面板/没回焦点");
  has(WC, /document\.addEventListener\("click", onDocClick\)/, "没挂 click");
  has(WC, /document\.removeEventListener\("click", onDocClick\)/, "卸载没摘 click");
});

t("E6 暖心墙：面板打开先收键盘（跟会话同一套）", () => {
  has(WC, /const isSheet = \(\) =>[\s\S]{0,200}matchMedia\("\(max-width: 899px\)"\)/, "没有 sheet 判据");
  has(WC, /if \(isSheet\(\)\) \{[\s\S]{0,260}ta\.value\.blur\(\)/, "打开面板没 blur（键盘会压在面板上）");
  has(WC, /document\.documentElement\.style\.setProperty\("--kb-h", "0px"\)/, "没把键盘让位归零");
});

/* ── ③ 暖心墙面板与会话同款（贴底整宽） ── */
t("E7 暖心墙：≤899px 面板贴底整宽 + 高度与会话同一条", () => {
  const m = WC.match(/@media \(max-width: 899px\) \{([\s\S]*?)\n\}/);
  assert.ok(m, "没有 ≤899px 的贴底样式");
  const block = m[1];
  has(block, /position: fixed;/, "不是 fixed");
  has(block, /left: 0;[\s\S]{0,40}right: 0;/, "没整宽");
  has(block, /bottom: 0;/, "没贴底");
  /* 轮 482：高度从写死 320 改成 --kb-panel-h（= 上一次真实键盘高），
   * 否则收键盘弹面板时输入条会跳一截（用户报「表情包跟打字的上拉框高度不一致」）。 */
  has(block, /height: var\(--kb-panel-h\);/, "面板高度没跟 --kb-panel-h 走（会和键盘不一致）");
  has(block, /border-radius: 0;/, "还带圆角（浮窗样）");
  has(block, /z-index: 170;/, "z-index 会被底条盖住");
  has(BC, /--wp-emoji-h: var\(--kb-panel-h/, "会话段的高度基准变了（两处必须同一个变量）");
  /* 轮 498：兜底与上限改由 JS 算成 px（--kb-fallback / --kb-cap），
     CSS 的 46vh/62vh 只当「JS 没跑到」时的最后兜底 —— vh 在部分内核上不可信。 */
  has(CSS, /--kb-panel-h:\s*min\(var\(--kb-last,\s*var\(--kb-fallback,\s*min\(46vh, 320px\)\)\),\s*var\(--kb-cap,\s*62vh\)\)/,
    ":root 里 --kb-panel-h 不是「键盘高 → JS px 兜底 → vh 末位兜底」这条链");
});

t("E8 底条抬到面板上沿（暖心墙手机主评论条）", () => {
  has(CSS, /\.cmt-main-bar\.wp-emoji-open,[\s\S]{0,200}bottom: var\(--kb-panel-h\);/, "底条没抬起来（会被面板盖住）");
  has(CSS, /html\.kb-web \.cmt-main-bar\.wp-emoji-open,[\s\S]{0,80}bottom: var\(--kb-panel-h\);/, "网页端那条没跟同一个变量");
  has(CSS, /html\.cap-app \.cmt-main-bar\.wp-emoji-open/, "App 壳那条没覆盖（bottom 仍是 --kb-h）");
  has(WC, /bar\.classList\.toggle\("wp-emoji-open", !!open && isSheet\(\)\)/, "没给底条挂类");
  has(WC, /root\.value\.closest\("\.cmt-main-bar"\)/, "找不到底条");
});

t("E9 桌面不受影响：浮窗那条仍在（≤768 的老规则没被贴底顶掉）", () => {
  has(WC, /@media \(max-width: 768px\) \{[\s\S]{0,260}right: -4px;/, "768 的老浮窗规则没了");
  has(WC, /\.wp-composer\.emoji-down \.wp-composer-picker \{[\s\S]{0,80}top: calc\(100% \+ 8px\)/, "向下弹的分支被删");
});

/* 轮 400：App 上「键盘开着 → 点表情 → 再点表情」不能直接塌回屏底。
   期望与微信一致：面板打开时表情键变成键盘键；再点 = 收面板 + 把焦点还回
   输入框（系统键盘接上），并且 footer 的让位先钉住，输入条原地不动。 */
t("E10 轮400 表情键二次点击 = 键盘键（换图标 + 回焦点 + 让位钉住）", () => {
  has(BC, /const EMOJI_SWAP_HTML = `/, "没有两枚图标的 HTML");
  has(BC, /class="wp-vac-emoji-swap"[\s\S]{0,900}class="wp-vac-kb"/, "图标里没有键盘键");
  has(BC, /const syncEmojiIcon = \(open\) => \{[\s\S]{0,520}data-wp-emoji-key/, "没有按开关同步图标");
  has(BC, /syncEmojiIcon\(open\);\s*\n\s*emojiPad\(open\);\s*\n\s*emojiWasOpen = open;/, "setEmojiOpen 没调用图标同步 / 让位");
  has(BC, /:host\(\.wp-emoji-open\)[^{]*\.wp-vac-emoji-swap \.wp-vac-emoji \{ display: none; \}/, "面板打开时笑脸没藏起来");
  has(BC, /:host\(\.wp-emoji-open\)[^{]*\.wp-vac-emoji-swap \.wp-vac-kb \{ display: block; \}/, "面板打开时键盘键没显示");
  /* 新监听必须只在「面板已开 + 点的是表情键」时接管，且在组件收面板前
     先 holdForKeyboard，收完再把焦点还给 textarea。 */
  const at = BC.indexOf('footer.addEventListener("click", (e) => {\n    const picker = sr.querySelector(".vac-emoji-picker");');
  assert.ok(at > 0, "找不到表情键的二次点击监听");
  const b = BC.slice(at, at + 900);
  has(b, /if \(!path\.includes\(btn\)\) return;/, "没限定只接表情/键盘键");
  has(b, /holdForKeyboard\(\);/, "收面板前没钉住让位");
  has(b, /ta\.focus\(\)/, "收面板后没把焦点还给输入框");
});

/* ═══ 轮 478 · 「点表情等半天」的修法护栏 ═══
 * 病根：首次点开时 emoji-picker-element 要在那一刻现拉 430KB JSON + 写 1923 条进
 * IndexedDB（实测面板空白 500~800ms）；同一页面再点开只要 34ms。
 * 修法：空闲时先建一个 Database 把表填好 → 真面板走「查库」快路径；
 *       万一预热没赶上，面板先铺骨架，别让用户对着一块空白。
 * 这几个断言防的是「有人觉得预热多余把它删了 / 骨架忘了收」：
 *   ① 预热必须由根组件在启动后触发，且必须用库自己的 Database（同一个 IndexedDB）；
 *   ② 省流/2G 不预热（不能替用户悄悄花流量）；
 *   ③ 面板必须铺骨架 + 有 2.5s 上限 + 卸载时清定时器；
 *   ④ emojiPanel.js 不许 import 库（它要在 Node 里单测，库一进就 requestAnimationFrame 崩）。 */
const WARM = fs.readFileSync("src/utils/emojiWarm.js", "utf8");
const APP = fs.readFileSync("src/App.vue", "utf8");

t("E11 预热走库自己的 Database（共用同一个 IndexedDB）", () => {
  has(WARM, /import \{ Database \} from "emoji-picker-element"/, "没用库导出的 Database");
  has(WARM, /new Database\(\{ dataSource: EMOJI_DATA \}\)/, "没指定自托管的 data.json");
  has(WARM, /await emojiDatabase\(\)\.ready\(\)/, "没等 ready 就算预热完了");
  has(WARM, /dataSource: EMOJI_DATA/, "数据源不是 /emoji/data.json");
  has(WARM, /const EMOJI_DATA = "\/emoji\/data\.json"/, "数据源地址被改");
});

t("E12 根组件启动后触发预热，且省流/2G 跳过", () => {
  has(APP, /import \{ scheduleEmojiWarm \} from "\.\/utils\/emojiWarm\.js"/, "App 没引预热");
  has(APP, /scheduleEmojiWarm\(\);/, "App 没调用（等于白做）");
  has(WARM, /saveData/, "没看 saveData");
  has(WARM, /2g\|slow-2g/, "没排掉 2G");
  has(WARM, /if \(warming\) return warming/, "没有幂等（会重复拉数据）");
  has(WARM, /if \(scheduled \|\|/, "重复调用会重复排空闲任务");
});

t("E13 面板加载态：骨架 + 上限 + 卸载清理", () => {
  has(WC, /class="wp-picker-skel"/, "面板没有加载占位");
  has(WC, /v-if="!pickerReady"/, "骨架没挂在 pickerReady 上");
  has(WC, /const pickerReady = ref\(false\)/, "没有 pickerReady 状态");
  has(WC, /querySelector\("\.emoji"\)/, "没按真实表情节点判断就绪");
  has(WC, /Date\.now\(\) - started > 2500/, "没有 2.5s 上限（数据拉不到会永远盖着）");
  has(WC, /onBeforeUnmount\(\(\) => \{[\s\S]{0,200}clearTimeout\(readyTimer\)/, "卸载没清定时器");
  has(WC, /\.wp-picker-skel \{/, "骨架样式没写");
  has(WC, /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,120}\.wp-picker-skel i \{ animation: none/, "骨架没做 reduced-motion 降级");
});

t("E14 emojiPanel.js 保持纯 DOM（不许 import 库，否则 Node 单测崩）", () => {
  no(UTIL, /from "emoji-picker-element"/, "又把库引进来了 —— Node 里 requestAnimationFrame 未定义会直接崩");
});

/* 轮 498 · 用户第四次报「手机浏览器里表情跟输入框高度不一致、根本不能用」。
 * 真因不是高度算错，而是**会话页让位只靠两条命**：
 *   ① .vac-room-footer:has(.vac-emoji-picker)  —— 旧内核（Chromium<105 / X5 / 国产 WebView）整套不认
 *   ② :host(.wp-emoji-open)                     —— 依赖 MutationObserver 挂上了没有
 * 两条同时失效 → footer 的 padding-bottom 归零 → 面板把输入条整条盖住。
 * Edge/Chrome 上两条都通，本机怎么测都是好的；用户机器上是一条白板。
 * 现在的做法：面板一出现就「量」它实际占掉多少，写 footer 的内联 padding-bottom
 * （内联压过一切选择器），并且盯着面板尺寸变化重量。 */
t("E15 会话页让位不赌选择器：量出来的内联 padding（:has 不支持、类没挂上也不塌）", () => {
  has(BC, /const emojiPad = \(open\) => \{/, "没有「量出来」的让位函数");
  has(BC, /querySelector\("\.vac-emoji-picker"\)[\s\S]{0,400}getBoundingClientRect\(\)/, "没有量面板的真实矩形");
  has(BC, /f\.style\.paddingBottom = covered \+ "px"/, "没写内联 padding-bottom（选择器一失效就白给）");
  /* 面板底下到屏底的缝也要算进去，否则面板没贴底时会少补一条 */
  has(BC, /Math\.round\(b\.height\) \+ Math\.max\(0, Math\.round\(vh - b\.bottom\)\)/, "只算了面板高度，没算它离屏底的缝");
  /* 收起时必须清掉内联值，否则关掉面板后输入条永远悬在半空 */
  has(BC, /if \(!open \|\| !sheetMode\(\)\) \{ stopPadRO\(\); foot\.style\.paddingBottom = ""; return; \}/,
    "收起面板没清内联让位（输入条会一直悬空）");
  /* 桌面浮窗不能套这条（否则桌面 footer 也被顶起来 300） */
  has(BC, /const sheetMode = \(\) =>[\s\S]{0,200}matchMedia\("\(max-width: 899px\)"\)/, "没有 sheet 判据");
  /* 面板高度会随 --kb-last / 视口变化，必须跟着重量 */
  has(BC, /new ResizeObserver\(put\)/, "没有盯面板尺寸变化（差一截就会留缝）");
  has(BC, /padRO\.observe\(p\)/, "ResizeObserver 没盯上面板");
  /* 接线：一定要在 setEmojiOpen 里调，否则面板开了也不量 */
  has(BC, /syncEmojiIcon\(open\);\s*\n\s*emojiPad\(open\);/, "setEmojiOpen 没接上 emojiPad");
  has(BC, /onBeforeUnmount\(\(\) => \{[\s\S]{0,400}stopPadRO\(\);/, "卸载没断开 ResizeObserver");
});

t("E16 表情观察者不许「第一帧拿不到 shadowRoot 就永久失联」", () => {
  /* 旧写法：const sr = ...; if (!sr) return; —— bind() 若跑在自定义元素升级之前，
     这个 MutationObserver 从此再也挂不上，宿主永远没有 wp-emoji-open。 */
  has(BC, /const observeEmoji = \(\) => \{[\s\S]{0,300}if \(emojiTries\+\+ < 40\) setTimeout/, "拿不到 shadowRoot 没有退避重试");
  has(BC, /if \(!unmounted\) observeEmoji\(\)/, "卸载后定时器还在重试（会空转）");
  has(BC, /onBeforeUnmount\(\(\) => \{[\s\S]{0,120}unmounted = true;/, "卸载没置位 unmounted");
  /* 切会话时再补挂一次，双保险 */
  has(BC, /watch\(\(\) => \[curRoom\.value, props\.showBack\][\s\S]{0,240}observeEmoji\(\)/, "切会话没补挂观察者");
  no(BC, /const observeEmoji = \(\) => \{\s*\n\s*const sr = el\.value && el\.value\.shadowRoot;\s*\n\s*if \(!sr\) return;/,
    "还是「拿不到就 return」的老写法");
});

t("E17 面板高度尺子：兜底与上限用 JS 的 px，vh 只当最后兜底", () => {
  const KI = fs.readFileSync("src/utils/keyboardInset.js", "utf8");
  has(KI, /const FALLBACK_VAR = "--kb-fallback"/, "没有 --kb-fallback");
  has(KI, /const CAP_VAR = "--kb-cap"/, "没有 --kb-cap");
  /* 轮 500：尺子要知道「现在有没有键盘」——有键盘时页面高度不可信，得退回历史最大值 */
  has(KI, /function writePanelRuler\(noKb\) \{/, "写尺子的函数没接「当前是否有键盘」");
  /* 轮 499/500：兜底算式搬到 keyboardMath.kbPanelFallback（纯函数、Node 里测各机型），
     这里只锁「接线对了没有」——面板高度必须来自那个函数，不能用常量顶替；
     屏高还必须先过 kbScreenH（物理像素要按 dpr 折回，不然 2340 减 732 会算爆）。 */
  has(KI, /return kbPanelFallback\(base, screenNow\(\), readStored\(\)\);/, "兜底没走 kbPanelFallback（写死常量就又会跳）");
  has(KI, /return kbScreenH\(win\.screen\.height, win\.devicePixelRatio\)/, "屏高没做物理像素归一");
  has(fs.readFileSync("src/utils/keyboardMath.js", "utf8"), /export function kbPanelFallback\(base, screenH, seen\)/,
    "keyboardMath 里没有 kbPanelFallback");
  has(KI, /Math\.min\(base, vis\) \* 0\.8/, "上限没跟「当前可视高度」走（矮视口下面板会吃掉整屏）");
  has(KI, /restH = \(typeof window !== "undefined" && window\.innerHeight\) \|\| 0;\s*\n\s*writePanelRuler\(true\);/, "initWeb 没算尺子");
  /* 键盘起落会改可视高度，尺子必须跟着重算（只有变化时才写样式） */
  has(KI, /writePanelRuler\(!\(panelH > 0\)\);/, "applyWeb 里没跟可视高度重算尺子");
  has(KI, /if \(fb === lastFb && cap === lastCap\) return;/, "没有变化判据（逐帧写样式会一直触发重排）");
  /* 基线只往上记：弹完键盘布局视口没复原的机型，矮值不能盖掉真基线 */
  has(KI, /inner > restH\) \{\s*\n\s*restH = inner;\s*\n\s*writePanelRuler\(true\);/, "基线还会被矮视口覆盖（面板高度会一直错）");
  has(KI, /orientationchange[\s\S]{0,240}restH = window\.innerHeight \|\| 0;/, "旋屏没重取基线");
});

console.log(`emoji-panel-test: ${pass} pass, ${fails.length} fail`);
if (fails.length) { for (const f of fails) console.log("  FAIL " + f); process.exit(1); }
