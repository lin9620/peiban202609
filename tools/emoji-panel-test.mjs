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
  has(block, /height: min\(46vh, 320px\);/, "高度与会话不一致");
  has(block, /border-radius: 0;/, "还带圆角（浮窗样）");
  has(block, /z-index: 170;/, "z-index 会被底条盖住");
  has(BC, /--wp-emoji-h: min\(46vh, 320px\)/, "会话段的高度基准变了（两处必须同一条）");
});

t("E8 底条抬到面板上沿（暖心墙手机主评论条）", () => {
  has(CSS, /\.cmt-main-bar\.wp-emoji-open,[\s\S]{0,120}bottom: min\(46vh, 320px\);/, "底条没抬起来（会被面板盖住）");
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
  has(BC, /syncEmojiIcon\(open\);\s*\n\s*emojiWasOpen = open;/, "setEmojiOpen 没调用图标同步");
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

console.log(`emoji-panel-test: ${pass} pass, ${fails.length} fail`);
if (fails.length) { for (const f of fails) console.log("  FAIL " + f); process.exit(1); }
