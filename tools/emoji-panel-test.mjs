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
  /* 别用「多少个字符以内必须有 X」这种窗口判据：注释稍微写长一点就假红（轮 504 踩过）。
     直接取 watch 块本体判断。 */
  const watchBlk = (WC.match(/watch\(emojiOpen,[\s\S]*?\n\}\);/) || [""])[0];
  has(watchBlk, /hideEmojiSearch\(picker\.value\)/, "打开时没去搜索框");
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
  /* 轮 524：onDocClick 不再自己写「收面板 + 回焦点」，统一走 closeForKeyboard
     （同步 focus 申请键盘 → rAF 等键盘盖上来再收面板） */
  has(WC, /const onDocClick = \(\) => \{[\s\S]{0,240}closeForKeyboard\(\);/, "click 没收面板/没回焦点");
  has(WC, /document\.addEventListener\("click", onDocClick\)/, "没挂 click");
  has(WC, /document\.removeEventListener\("click", onDocClick\)/, "卸载没摘 click");
});

t("E6 暖心墙：面板打开先收键盘（跟会话同一套）", () => {
  has(WC, /const isSheet = \(\) =>[\s\S]{0,200}matchMedia\("\(max-width: 899px\)"\)/, "没有 sheet 判据");
  has(WC, /if \(isSheet\(\)\) \{[\s\S]{0,260}ta\.value\.blur\(\)/, "打开面板没 blur（键盘会压在面板上）");
  /* 轮 504：让位归零改成走 setPanelOpen（写 --kb-h=0 + 作废变化判据 + 重算），
     手写 --kb-h=0 会把「上次写过的值」留在缓存里，面板收完回键盘时被吞掉。 */
  has(WC, /setPanelOpen\(!!open && isSheet\(\)\);/, "打开/关闭面板没走 setPanelOpen");
});

/* ── ③ 暖心墙面板与会话同款（贴底整宽） ── */
t("E7 暖心墙：≤899px 面板贴底整宽 + 高度与会话同一条", () => {
  const m = WC.match(/@media \(max-width: 899px\) \{([\s\S]*?)\n\}/);
  assert.ok(m, "没有 ≤899px 的贴底样式");
  const block = m[1];
  has(block, /position: fixed;/, "不是 fixed");
  has(block, /left: 0;[\s\S]{0,40}right: 0;/, "没整宽");
  /* 轮 506：bottom 不再是写死的 0（那是布局视口底，键盘/工具栏浮起时面板整块跑到屏外），
     改成 --kbb（可视视口底离布局视口底多远，由 utils/viewportVars.js 现读）。 */
  /* 轮 519：还要减掉过冲量（键盘收起时浏览器会多报 55px），否则那 140ms 里面板会往下掉。 */
  has(block, /bottom: calc\(var\(--kbb, 0px\) \+ var\(--kb-over, 0px\)\);/, "没贴可视视口底（还在用布局视口底）");
  has(block, /top: auto;/, "top: auto 没了，会和 bottom 打架");
  /* 轮 482：高度从写死 320 改成 --kb-panel-h（= 上一次真实键盘高），
   * 否则收键盘弹面板时输入条会跳一截（用户报「表情包跟打字的上拉框高度不一致」）。 */
  has(block, /height: var\(--kb-panel-h\);/, "面板高度没跟 --kb-panel-h 走（会和键盘不一致）");
  has(block, /border-radius: 0;/, "还带圆角（浮窗样）");
  has(block, /z-index: 170;/, "z-index 会被底条盖住");
  has(BC, /--wp-emoji-h: var\(--kb-panel-h/, "会话段的高度基准变了（两处必须同一个变量）");
  /* 轮 519：面板高只认 JS 锁定的 --kb-panel，上限是固定 px。
   * 旧写法是 min(--kb-last, --kb-cap, 62vh) —— 三个都在每帧重算，其中 62vh 在键盘态
   * （视口 484）和面板态（视口 744）算出两个不同的上限，面板高于是每切一次变一截。 */
  has(CSS, /--kb-panel-h:\s*min\(var\(--kb-panel,\s*320px\),\s*420px\)/,
    ":root 里 --kb-panel-h 不是「锁定的键盘高 → 320 兜底 → 420 固定上限」");
  assert.ok(!/--kb-panel-h:[^;]*\d+vh/.test(CSS),
    "面板高的上限还在用 vh（键盘态/面板态会算出两个不同的值，高度就会漂）");
});

t("E8 底条与面板共用一个参照系（轮 519：resize 型 transform 位移 / overlay 型 padding 让位）", () => {
  /* 轮 519 · resize 型（安卓/小米）：位置靠 transform 位移，不改布局。
   * 旧写法是 padding-bottom: var(--kb-panel-h) —— 它会把条撑高、把输入行顶上去，
   * 而「让位」和「键盘收起」不是同一帧完成的，中间那几帧输入行就窜到上半屏（用户说的一闪）。 */
  /* ⚠ 不能用 transform：条内部挂着 position:fixed 的表情面板，祖先一有 transform，
   * fixed 的包含块就从视口变成这根条 —— 真机实测面板被压到 224~484（该 484~744）。 */
  has(CSS, /html\.kb-resize \.cmt-main-bar\.wp-emoji-open \{[\s\S]{0,260}bottom: calc\(var\(--kbb, 0px\) \+ var\(--kb-panel-h\) - var\(--kb-now, 0px\) \+ var\(--kb-over, 0px\)\)/,
    "resize 型没按「kbb + 面板高 − 键盘当前占高 + 过冲」算条底");
  assert.ok(!/\.cmt-main-bar\.wp-emoji-open \{[^}]*transform:/.test(CSS),
    "条的让位又用了 transform（会劫持内部 fixed 面板的包含块）");
  /* overlay 型（iOS）布局视口不缩，只能靠内边距让位，这条保留。 */
  has(CSS, /html\.kb-overlay \.cmt-main-bar\.wp-emoji-open \{[\s\S]{0,200}padding-bottom: max\(0px, var\(--kb-panel-h\) - var\(--vtop, 0px\)\)/,
    "overlay 型（iOS）的让位没了");
  has(CSS, /html\.cap-app \.cmt-main-bar\.wp-emoji-open,[\s\S]{0,120}bottom: var\(--kb-panel-h\);/,
    "App 壳那条没了（那边不跑 fixedBar，仍要靠 bottom 抬）");
  /* 网页端的条不许再拿 --kb-h 当 bottom：那是间接推导，任一道闸门失效就会把条顶到半空。
     ⚠ 必须先把注释剥掉再断言 —— 注释里就写着「不再用 bottom: var(--kb-h)」，
     直接 match 会被这句解释骗过去（轮 502 的 I7 就是这么假绿的）。 */
  const kbWebBar = CSS.match(/html\.kb-web \.cmt-main-bar \{([\s\S]{0,900}?)\}/);
  const kbWebBody = kbWebBar ? kbWebBar[1].replace(/\/\*[\s\S]*?\*\//g, "") : "";
  assert.ok(kbWebBar && /bottom: var\(--kbb, 0px\);/.test(kbWebBody), "网页端条底没接 --kbb（还在用布局视口底 / --kb-h 推导）");
  assert.ok(kbWebBar && !/bottom: var\(--kb-h\)/.test(kbWebBody), "网页端条底还在吃 --kb-h");
  /* 轮 506：条底与面板底必须是**同一个变量**，否则两个参照系一错位就分家 */
  has(WC, /bottom: calc\(var\(--kbb, 0px\) \+ var\(--kb-over, 0px\)\);/, "面板 bottom 没接 --kbb（与条不同源）");
  has(WC, /bar\.classList\.add\("wp-emoji-open"\)/, "没给底条挂类");
  /* 轮 519：摘类必须等**键盘真正占到面板高度**（按时间摘会让条在键盘半路时跳一下）。 */
  has(WC, /const dropBarWhenReady = \(bar, \w+\) => \{[\s\S]{0,900}?classList\.remove\("wp-emoji-open"\)/,
    "摘类没有等键盘到位的交接期（面板一关条就掉到屏底）");
  /* 这段跑在键盘弹出动画的头 100ms 里，读样式会强制重排、把键盘弹出打断。 */
  assert.ok(!/const dropBarWhenReady[\s\S]{0,600}getComputedStyle/.test(WC),
    "交接期里用了 getComputedStyle（每帧强制重排，会打断系统键盘的弹出）");
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
  /* 轮 521：中间多了骨架层那一句（mountSkel / dropSkel），三件事的**先后**不变：
     图标 → 让位 → 记状态。骨架是旁路，插在哪都不能把前两件挤掉。 */
  has(BC, /syncEmojiIcon\(open\);\s*\n\s*emojiPad\(open\);[\s\S]{0,260}emojiWasOpen = open;/, "setEmojiOpen 没调用图标同步 / 让位");
  /* 轮 521：骨架必须在面板刚打开时铺、收起时摘（实现搬进 utils/emojiSkel.js） */
  has(BC, /if \(open && !emojiWasOpen\) emojiSkel\.mount\(\);\s*\n\s*else if \(!open\) emojiSkel\.drop\(\);/, "面板开关没接骨架层");
  has(BC, /:host\(\.wp-emoji-open\)[^{]*\.wp-vac-emoji-swap \.wp-vac-emoji \{ display: none; \}/, "面板打开时笑脸没藏起来");
  has(BC, /:host\(\.wp-emoji-open\)[^{]*\.wp-vac-emoji-swap \.wp-vac-kb \{ display: block; \}/, "面板打开时键盘键没显示");
  /* 新监听必须只在「面板已开 + 点的是表情键」时接管，且在组件收面板前
     先 holdForKeyboard，收完再把焦点还给 textarea。
     轮 520：轮询收面板的那次 btn.click() 会再次触发本监听，所以头部多了一行
     `if (closingPanel) return;` —— 锚点改成从「拦截标记」开始切。 */
  const at = BC.indexOf('if (closingPanel) return;\n    const picker = sr.querySelector(".vac-emoji-picker");');
  assert.ok(at > 0, "找不到表情键的二次点击监听");
  const b = BC.slice(at, at + 3200);   /* 轮 520：加了大段说明，窗口放宽 */
  has(b, /if \(!path\.includes\(btn\)\) return;/, "没限定只接表情/键盘键");
  has(b, /holdForKeyboard\(\);/, "收面板前没钉住让位");
  /* 轮 520：这一次点击必须**当场拦下** —— 否则组件立刻收面板、键盘要 400ms 才起来，
     中间 260px 空白（真机 screencast f037）。收面板的时机交给「键盘到位」那一支。 */
  has(b, /e\.stopImmediatePropagation\(\);/, "没拦下组件自己的点击（面板会提前消失，底下空一大片）");
  has(b, /const closeWhenKb = \(\) => \{[\s\S]{0,600}btn\.click\(\)/, "没有「键盘到位再收面板」的轮询");
  /* 轮 510：焦点必须**同步**还回去 —— iOS 只在用户手势的同步栈里认 focus()，
     以前这里写的是 setTimeout(…, 0)，键盘根本不会弹，用户看到的就是「折叠」。 */
  has(b, /taNow\.focus\(\);/, "收面板后没同步把焦点还给输入框");
  has(b, /try \{[\s\S]{0,200}taNow\.focus\(\);[\s\S]{0,40}\} catch/, "focus 没包在 try 里（无焦点环境会抛）");
  /* 轮 513：iOS 对「已经是 activeElement」的输入框调 focus() 是**空操作**，键盘不会起来。
     面板收起时 textarea 可能还拿着焦点 → 必须先 blur 再 focus（用户报的「切换键盘没效果」）。 */
  has(b, /activeElement === taNow[\s\S]{0,120}taNow\.blur\(\)/, "已是激活态时没先 blur（iOS 上 focus 会变成空操作）");
  /* 轮 513：补焦点那一次 setTimeout 只能给有 hover 的设备（桌面）。手机上它已经出栈，
     iOS 只会把焦点挪过去而不弹键盘 —— 留下「有焦点、没键盘」的死状态。 */
  has(b, /matchMedia\("\(hover: hover\)"\)[\s\S]{0,400}setTimeout/, "手机上也补焦点了（会留下有焦点没键盘的死状态）");
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
 * 从那之后的做法一直是「量面板实际占掉多少 → 写内联 padding-bottom」。
 *
 * 轮 520 · 量 rect 这套被真机否掉了（用户：「会话框的表情/键盘切换也有问题」）。
 * 逐帧读数 433 → 180 → 495 → 440：一次切换跳三下。原因是量出来的是「面板自己多高」，
 * 跟「键盘此刻还占多高」是两件事 —— 安卓 resize 型内核（小米）弹键盘时会自己把
 * innerHeight 和页面盒子一起压矮，面板高 260 与键盘收缩 260 就在同一个 padding 上
 * 叠加，让位一次算成 520px，输入条先窜到屏幕上半部再被顶回来。
 * 而且三个采样点（立刻量 / 260ms 补量 / ResizeObserver 重量）全在赌时机，键盘动画里必然踩空。
 * 现在一个采样点都不留：式子里的每个量都由 viewportVars 每帧算好，宿主只挂表达式，
 * 浏览器逐帧自己重算。下面的断言就是锁这个口径 ——
 * 谁再往回去量 rect / 加定时器补量，条就会重新跳。 */
t("E15 会话页让位只挂表达式：面板高 − 键盘此刻占高（不量 rect、不赌采样时机）", () => {
  has(BC, /const emojiPad = \(open\) => \{/, "没有让位函数");
  has(BC, /const PAD_EXPR = "calc\(7px \+ var\(--wp-emoji-h, 320px\)/, "让位表达式没以「面板高」打头（轮 524 起前面多了一笔 7px 底内边距）");
  /* 面板 fixed 贴的是**可视视口底**，输入条在页面盒子内，两者差浏览器工具栏那一条
     （真机实测 31px）。整份补会让条提前顶离键盘顶一截；--kb-kbb 是按键盘收起进度
     打折过的，全程连续。 */
  has(BC, /var\(--kb-kbb, var\(--kbb, 0px\)\)/, "让位没补「面板贴的是可视视口底」那条缝（面板会盖住输入条一条工具栏）");
  /* 这一项是轮 520 的核心：扣掉键盘此刻已经占掉的高度，两态线性互补，条原地不动。 */
  has(BC, /- var\(--kb-now, 0px\)/, "让位没扣「键盘此刻占高」→ resize 型内核上会被算两次，输入条窜到上半屏");
  /* 轮 524：校正项从 --chat-h 换成 --chat-box（min(视口高, 键盘态盒子高)）。
     盒子高是 chatViewport.js 内联写的像素，靠 resize + 250ms 巡检更新，键盘动画期间
     落后整整一拍（实测 inner 已 799、盒子停在 484 达 258ms）；--chat-h 就是这个滞后值，
     --chat-box 是同一个量的**无滞后**版本。让位必须跟盒子同源，否则条会往下砸一截再弹回。 */
  has(BC, /var\(--chat-box, var\(--vlh, 0px\)\) - var\(--vlh, 0px\)/, "没补页面盒子滞后的校正项（盒子慢一拍时条会往下砸一截）");
  has(BC, /:host \{ --chat-box: min\(var\(--vlh, 0px\), var\(--kb-pageh, var\(--vlh, 0px\)\)\); \}/, "没有 --chat-box（无滞后的盒子高）定义");
  /* 收起时必须清掉内联值，否则关掉面板后输入条永远悬在半空。 */
  has(BC, /foot\.style\.paddingBottom = emojiPadOn \? PAD_EXPR : "";/, "收起面板没清内联让位（输入条会一直悬空）");
  has(BC, /sr\.querySelector\("#room-footer \.vac-box-footer"\)/, "让位没落在 .vac-box-footer（面板的定位宿主）上");
  /* 判据：桌面浮窗不能套这条（否则桌面 footer 也被顶起来 300） */
  has(BC, /const sheetMode = \(\) =>[\s\S]{0,200}matchMedia\("\(max-width: 899px\)"\)/, "没有 sheet 判据");
  has(BC, /emojiPadOn = !!open && sheetMode\(\);/, "让位没跟 sheet 判据走");
  /* 桌子另一头：面板自己的位置也必须逐帧跟着走，不能有第二条时间线。
   * 轮 520b：库把面板包在 Vue 的 vac-slide-up 过渡里，那条规则是 transition: all .3s，
   * 连 bottom 一起缓动 —— 真机逐帧拍到 --kb-now 已 0、面板 bottom 还在 -260 里爬，
   * 晚 300ms 才到位，底部空一条 260px 的带子。必须显式关掉过渡。 */
  has(BC, /bottom: calc\(var\(--kb-kbb[^;]*;\s*\n\s*\/\*[\s\S]{0,900}?transition: none !important;/,
    "面板没关掉库的过渡（bottom 会被缓动 300ms，比键盘晚一整拍）");
  {
    const at = BC.indexOf("bottom: max(");
    assert.ok(at > 0, "面板没有「页面盒子没跟上」那一帧的退路（会跟条裂开一条工具栏）");
    const seg = BC.slice(at, at + 300);
    assert.ok(/--kb-kbb/.test(seg) && /--chat-box/.test(seg),
      "max() 里没同时写「贴着条」和「退回旧页面底」两根式子");
  }
  /* 老内核不认 max()：旧式子必须还留在 max 那条之前当兜底 */
  assert.ok(
    BC.indexOf("bottom: calc(var(--kb-kbb, var(--kbb, 0px)) - var(--kb-now, 0px)) !important;")
      < BC.indexOf("bottom: max("),
    "max() 那条排在了旧式子前面（不认 max() 的内核会连兜底都没了）");
  /* ——以下三条是「别再回去」的反向锁—— */
  no(BC, /getBoundingClientRect\(\)\.height/, "又在量面板 rect 了（采样时机必然踩空，resize 型内核上还会把让位算两次）");
  no(BC, /new ResizeObserver\(put\)/, "又挂 ResizeObserver 跟着面板重量了（面板高已经锁在 --wp-emoji-h）");
  no(BC, /emojiPadTimer|stopPadRO|padRO\b/, "又留了补量定时器/观察者（轮 520 已全部删除）");
  /* 轮 514：面板几何已经搬进 vendored 库（wrapper static + fixed/--kbb），宿主这边
     不许再内联改几何 —— 两套机制并存时，内联 !important 会把 --kbb 压成固定的 0，
     iOS 上面板就又沉到工具栏下面 81px（轮 512 的坑就踩在这里）。 */
  no(BC, /const pinPicker = /, "宿主还在内联钉面板几何（和库的 fixed/--kbb 打架）");
  no(BC, /p\.style\.setProperty\("(position|bottom|width|height)"/, "宿主还在给面板写内联几何");
  /* 接线：一定要在 setEmojiOpen 里调，否则面板开了也不让位 */
  has(BC, /syncEmojiIcon\(open\);\s*\n\s*emojiPad\(open\);/, "setEmojiOpen 没接上 emojiPad");
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

t("E18 面板几何由 vendored 库负责（fixed + bottom:--kbb），宿主不再抢优先级", () => {
  /* 轮 514：库已 fork 进 vendor/（见 PATCHES.md）。轮 503 那套「面板 absolute 到
     footer 的 padding 区」不再使用 —— 它要求页面盒子高度也正确，两个参照系；
     现在面板直接 fixed 到可视区底（bottom:--kbb），与 footer 位置解耦，
     而 --kbb 本身有闭环校正兜底。 */
  const LIB = fs.readFileSync("vendor/vue-advanced-chat/dist/vue-advanced-chat.es.js", "utf8");
  has(LIB, /\.vac-emoji-wrapper\{position:static;display:flex\}/,
    "库里的 wrapper 不是 static（面板会锚到按钮那个小盒子 → 缩成一条竖线）");
  has(LIB, /@media \(max-width:899px\)\{\.vac-emoji-wrapper \.vac-emoji-picker:not\(\.vac-picker-reaction\)\{position:fixed!important;left:0!important;right:0!important;bottom:var\(--kbb,0px\)!important/,
    "库里的手机端面板不是「fixed + 贴 --kbb」（会沉到工具栏下面）");
  has(LIB, /height:var\(--kb-panel-h,320px\)/,
    "库里的手机端面板高度没吃 --kb-panel-h（高度又会随 innerHeight 变来变去）");
  /* 宿主不许再给面板写几何 !important：两套机制并存必然打架（轮 512 的教训） */
  no(BC, /\.vac-emoji-wrapper \.vac-emoji-picker \{[^}]*(position|bottom|width|height):[^}]*!important/,
    "宿主还在给面板写几何 !important（会和库的 fixed/--kbb 打架）");
  no(BC, /\.vac-emoji-wrapper:has\(/, "宿主还在用 :has() 改 wrapper（库已处理，国产内核也不认）");
  /* 让位 padding 仍必须落在 .vac-box-footer：内层才是 relative 的那一层 */
  has(BC, /:host\(\.wp-emoji-open\) \.vac-box-footer \{\s*\n\s*padding-bottom: calc\(7px \+ var\(--wp-emoji-h\)\);/,
    "让位 padding 没落在 .vac-box-footer（写在外层面板不跟着走）");
  /* 输入行不许被 position/transform 抬高：那会抢走面板的包含块
     （实测：给 .vac-icon-textarea 加 position:relative 后，面板立刻锚回到输入行底边，
     变成 180..516 悬在聊天记录中间）。层级问题用 z-index 之外的办法解决。 */
  no(BC, /\.vac-box-footer > \.vac-icon-textarea \{\s*\n\s*position: relative/, "输入行被定位了（会抢走面板的包含块）");
});

t("E19 面板开关只走 setPanelOpen：手写 --kb-h 会把「值没变不重写」的判据骗死", () => {
  const KI = fs.readFileSync("src/utils/keyboardInset.js", "utf8");
  has(KI, /export function setPanelOpen\(open\)/, "keyboardInset 没有 setPanelOpen");
  has(KI, /lastWebKb = -1;\s*\n\s*lastPanelKb = -1;/, "setPanelOpen 没把「上次写过的值」作废（同一高度第二次会被吞）");
  /* 轮 510：面板态归零照旧，但多了一道「这是不是真键盘」的闸 —— Safari 工具栏 81px
     不再被当成键盘（旧写法 kbInsetValue 的 80px 闸门正好放过它）。 */
  has(KI, /const h = panelOpen \|\| !realKb \? 0 : raw;/, "applyWeb 没认面板态（键盘收起动画期间会抖一记）或没挡工具栏");
  has(BC, /setPanelOpen\(open\);/, "DmVacChat 没接 setPanelOpen");
  no(BC, /document\.documentElement\.style\.setProperty\("--kb-h", "0px"\)/, "还在手写 --kb-h（和变化判据打架，输入条会留在键盘底下）");
  /* 面板开着时「收起→键盘」的钉住时间：1.2s 太长，用户这 1.2s 里看到的就是残影。
     轮 520：兜底从 setTimeout 换成 rAF 帧计数（40 帧 ≈ 660ms）—— 定时器只数墙钟，
     不管键盘到底动没动，也不管面板还开着没关；帧计数还能顺带把「等面板收完」一起数。 */
  has(BC, /kbSwapFrames = 40;/, "kb-swap 没有帧数兜底（等不到键盘会一直钉着让位）");
  no(BC, /kbSwapTimer = setTimeout/, "还是墙钟定时器兜底（键盘没动也会硬等/硬摘）");
  no(BC, /new MutationObserver\(\(\) => \{[\s\S]{0,200}endKbSwap/, "又在用 MutationObserver 盯面板摘钉（面板一开本就该撤钉）");
  /* 面板一开就该撤掉 swap（否则 padding 被 !important 钉住） */
  has(BC, /if \(open && !emojiWasOpen\) \{[\s\S]{0,400}endKbSwap\(\);/, "面板重新打开时没撤掉 kb-swap");
  /* 轮 504：暖心墙的 WpComposer 走同一道门。它原来是 toggleEmoji 里手写 --kb-h=0，
     真机实测「面板收完回键盘」之后 --kb-h 一直停在 0，页面不再让位。 */
  has(WC, /import \{[^}]*setPanelOpen[^}]*\} from "\.\.\/utils\/keyboardInset\.js"/, "WpComposer 没引 setPanelOpen");
  has(WC, /setPanelOpen\(!!open && isSheet\(\)\);/, "WpComposer 的面板开关没走 setPanelOpen");
  no(WC, /document\.documentElement\.style\.setProperty\("--kb-h"/, "WpComposer 还在手写 --kb-h");
});

t("E20 --kb-last 只增不减：同一台机的面板高度不许随地址栏伸缩变来变去", () => {
  const KI = fs.readFileSync("src/utils/keyboardInset.js", "utf8");
  has(KI, /let panelMax = 0;/, "没有 panelMax");
  has(KI, /panelMax = Math\.max\(panelMax, Math\.round\(panel\)\);/, "--kb-last 还是每次覆写（面板高度会跳）");
  has(KI, /panelMax = Math\.max\(panelMax, Math\.round\(px\)\);/, "px 支路没取最大值");
});

/* 轮 511 · 会话页的摘钉判据同样不能只认「--kbb 变大」。
 * iOS 为了让光标露出来会把可视视口整体上推，于是 offsetTop ≈ 键盘高，
 * 键盘态 --kbb = inner − (offsetTop + vvH) ≈ 0 —— 它是从工具栏的 81 **变小**。
 * 要求「变大 80」在上推态永远不成立，swap 只能等兜底，
 * 那一整秒多里 .vac-box-footer 的 padding-bottom 还是面板高：
 * 输入条被顶在屏幕中部、下面一大片空白，点发送/键盘都像没反应（用户截图红框）。
 *
 * 轮 520 · 判据再收紧一层：「键盘开始动」不等于「交接完了」。
 * 逐帧实测，旧判据（--kb-h > 0 / inner 缩 120 / --kbb 变 60）在键盘动画刚起头就成立，
 * 那一刻 --kb-now 才一百多，让位式子里的「面板高 − kb-now」从已扣掉一半直接跳成全扣，
 * 输入条往下砸 253px 再被键盘顶回来 —— 就是用户说的「切换时有一条东西一跳」。
 * 现在只在**键盘真到位**（kb-now ≥ 面板高 − 6）时摘；那一帧让位算出来正好是 0，摘了不动。
 * 读的是 window.__wpVars（viewportVars 每帧算好的快照），不是 getComputedStyle ——
 * 后者在键盘弹出动画里读会强制同步重排，把系统键盘的弹出打断。 */
t("E21 会话页摘钉按「键盘真到位」判（--kb-now 追上 --wp-emoji-h），不是等墙钟", () => {
  has(BC, /const swapReady = \(\) => \{[\s\S]{0,320}window\.__wpVars/, "摘钉判据没读 __wpVars 快照");
  has(BC, /return wv\.kbNow >= target - 6;/, "摘钉没等键盘真到位（动画刚起头就摘 → 条往下砸一截再弹回）");
  has(BC, /if \(swapReady\(\) \|\| kbSwapFrames <= 0\) \{ endKbSwap\(\); return; \}/, "轮询里没用 swapReady");
  /* 面板还开着时不能直接 return（延迟收面板之后 holdForKeyboard 先挂、面板后收，
     旧写法会把轮询断掉，.wp-kb-swap 永远摘不下来）。 */
  has(BC, /if \(nn\.classList\.contains\("wp-emoji-open"\)\) \{[\s\S]{0,160}requestAnimationFrame\(tick\)/,
    "面板还开着时轮询断了（会让位钉在旧值、类也摘不掉）");
  no(BC, /k >= holdKbb \+ 80/, "还留着旧的「只认变大」判据");
  no(BC, /Math\.abs\(k - holdKbb\) >= 60/, "还留着旧的「--kbb 变 60 就摘」判据");
});

/* 轮 513 · 影子样式里的**注释必须配平**。
 * 事故（我自己踩的）：删一条 transition 时把注释的收尾符留在了后面，于是
 * 「轮 512：…」那几行变成了裸 CSS 文本，浏览器按错误恢复规则把**下一条规则整块吃掉**
 * —— 被吃掉的正好是把 .vac-emoji-wrapper 改成 static 的那条，
 * 面板就又锚回按钮那个小盒子（用户截图：面板贴着右边竖成一条）。
 * 这种错编译不报、测试全绿、只有在真机上看得见，所以静态拦一道。 */
t("E22 影子样式的注释必须配平（裸文本会吃掉下一条规则）", () => {
  const m = BC.match(/const THEME_CSS = `([\s\S]*?)`;/);
  assert.ok(m, "找不到 THEME_CSS 模板");
  /* 轮 520b · 反引号是**同一个事故的第二个入口**：注释里写一个反引号，
   * 模板字符串当场闭合，剩下的中文和 CSS 被当成 JS 表达式 → 运行时
   * 「main is not defined」，整页白板。编译不报错、测试当时也全绿，
   * 只有真机打开会话看得见（round 520 我自己踩过一次，修完注释又踩了一次）。
   * 这里直接数：从开引号到 "`;" 之间不允许再出现反引号。 */
  {
    const at = BC.indexOf("const THEME_CSS = `");
    const open = BC.indexOf("`", at);
    const close = BC.indexOf("`;", open + 1);
    assert.ok(open > 0 && close > open, "THEME_CSS 的模板引号没配对");
    const inner = BC.slice(open + 1, close);
    const stray = (inner.match(/`/g) || []).length;
    assert.equal(stray, 0, `THEME_CSS 里出现了 ${stray} 个反引号（模板字符串会提前闭合，剩下半行变成 JS 表达式 → 整页崩）`);
  }
  const css = m[1];
  let open = false;
  let stray = 0;
  for (let i = 0; i < css.length - 1; i++) {
    if (!open && css[i] === "/" && css[i + 1] === "*") { open = true; i++; continue; }
    if (open && css[i] === "*" && css[i + 1] === "/") { open = false; i++; continue; }
    if (!open && css[i] === "*" && css[i + 1] === "/") { stray++; i++; }
  }
  assert.equal(open, false, "THEME_CSS 里有没闭合的 /*");
  assert.equal(stray, 0, `THEME_CSS 里有 ${stray} 处野 */（会把下一条规则吃掉）`);
  /* 轮 514：原先这条查的是「被吃掉的那条 wrapper static 规则还在」，那条规则已经
     搬进 vendored 库，所以改查库 —— 同一类事故（注释没配平把下一条吃掉）会让它消失。 */
  const LIB = fs.readFileSync("vendor/vue-advanced-chat/dist/vue-advanced-chat.es.js", "utf8");
  assert.match(LIB, /\.vac-emoji-wrapper\{position:static/,
    "把 wrapper 改成 static 的规则不在了（面板会缩成按钮宽）");
});

/* 轮 513 · 位置不再只靠「推导」，--kbb 要把实测补正量一起写进去。
 * 三个消费者（页面高 / 吸底条 / 面板 bottom）都吃 --kbb，补正量必须落在同一处。 */
t("E23 --kbb 叠加实测补正量；闭环校正在会话页保留，暖心墙已摘", () => {
  const VV = fs.readFileSync("src/utils/viewportVars.js", "utf8");
  /* 轮 524b：式子搬进纯函数 kbbValue（口径要能被矩阵单测覆盖），
     断言改成「必须走纯函数、且 kbbFix 真的喂进去了」。 */
  has(VV, /const kbb = kbbValue\(inner, vvH, vtop, isOverlay, kbbFix\);/, "--kbb 没走纯函数 / 没叠加 kbbFix（补正量白算）");
  has(VV, /export function nudgeKbbFix/, "没有 nudgeKbbFix 出口");
  has(BC, /startBottomPin\(\(\) => \{[\s\S]{0,200}dm-page--chat/, "会话页没接 startBottomPin");
  /* 轮 521：卸载钩子从单行改成多行（顺手要清掉面板的 html 标记），
     断言改成「钩子里确实调了 stopBottomPin」，不再锁那一行的字面量。 */
  has(BC, /onBeforeUnmount\(\(\) => \{[\s\S]{0,400}stopBottomPin\(\);/, "会话页卸载没停闭环（会带误差到下一页）");
  /* 面板的 html 标记必须一起清：留着会让 chatViewport 把列表页也钉成键盘态高度 */
  has(BC, /onBeforeUnmount\(\(\) => \{[\s\S]{0,500}classList\.remove\("wp-emoji-open"\)/, "卸载没摘面板标记（列表页会被钉成键盘态高度）");
  /* 轮 519 · 暖心墙不再挂闭环。
   * 用户第 2 条是「面板高度变来变去 + 切表情有一闪」，这两个都发生在键盘高度这条链上，
   * 跟 --kbb 一点关系没有（真机 resize 型上 --kbb 恒 0）。再拿实测去推 --kbb，
   * 只会在键盘动画里把条推来推去 —— 那正是「一闪」的形状。 */
  assert.ok(!/startBottomPin|nudgeKbbFix/.test(WC),
    "暖心墙又挂上了闭环校正（本轮已判定它与这两条问题无关，且会在动画里推 --kbb）");
});

console.log(`emoji-panel-test: ${pass} pass, ${fails.length} fail`);
if (fails.length) { for (const f of fails) console.log("  FAIL " + f); process.exit(1); }
