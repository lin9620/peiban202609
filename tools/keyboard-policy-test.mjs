/* 轮 322 锁：键盘「先露一层空白」的根治方案 —— 四件套缺一件就复发。
 *
 * 真机实测病因链（详见 jiaojie 轮 322）：
 *   ① 窗口曾按 adjustResize 缩 → manifest 改 adjustNothing；
 *   ② 真正把布局视口从 843 压到 539 的是 SystemBars 插件给 decorView 加的
 *      「输入法高度」padding-bottom → config 改 insetsHandling="disable"；
 *   ③ 布局视口外的元素不参与绘制（红块实验证实）→ 让位必须在视口内自己做过过渡；
 *   ④ 于是 MainActivity 只给系统栏让位（不计输入法），网页层用 Keyboard 事件的
 *      输入法高度写 CSS 变量 --kb-h，让整屏页 / 吸底输入条同时长同曲线上移。
 *
 * 反向验证：按 HEAD 造副本后 `node tools/keyboard-policy-test.mjs <dir>` → 该红的全红。
 */
import { readFileSync, existsSync } from "node:fs";

const ROOT = process.argv[2] || ".";
const p = (rel) => (ROOT === "." ? rel : ROOT + "/" + rel);
const read = (rel) => {
  const f = p(rel);
  if (!existsSync(f)) throw new Error("缺少文件 " + rel);
  return readFileSync(f, "utf8");
};
/* 规则级判定用：去掉注释，避免「注释里提到 100svh」被误判成用了 100svh */
const readCss = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "");

const ok = [];
const bad = [];
const t = (name, fn) => {
  try { fn(); ok.push(name); }
  catch (e) { bad.push(name + " :: " + e.message); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

/* —— ① 窗口不再随输入法缩放 —— */
t("AndroidManifest：MainActivity 带 windowSoftInputMode=adjustNothing", () => {
  const xml = read("android/app/src/main/AndroidManifest.xml");
  const act = xml.match(/<activity[\s\S]*?>/);
  assert(!!act, "manifest 里没找到 <activity> 开标签");
  assert(/android:name="\.MainActivity"/.test(act[0]), "<activity> 不是 .MainActivity");
  assert(/android:windowSoftInputMode="adjustNothing"/.test(act[0]),
    "<activity> 缺 android:windowSoftInputMode=\"adjustNothing\"（回退默认 = 窗口被缩，空区又变成窗口底色那层）");
});

/* —— ② SystemBars 不再把输入法高度塞进 decorView padding —— */
t("capacitor.config.json：SystemBars.insetsHandling = disable", () => {
  const cfg = JSON.parse(read("capacitor.config.json"));
  const v = cfg && cfg.plugins && cfg.plugins.SystemBars && cfg.plugins.SystemBars.insetsHandling;
  assert(v === "disable", "SystemBars.insetsHandling 不是 disable（实际 " + v + "）—— 插件会把布局视口压到 539");
});

/* —— ②b 窗口底色必须与页面底色同值（否则过渡那几十毫秒会闪一条奶白缝）—— */
t("窗口底 = 页面底颜色（capacitor.config / styles.xml / --page-bg 三者同值）", () => {
  const cfg = JSON.parse(read("capacitor.config.json"));
  const nativeBg = String((cfg.android && cfg.android.backgroundColor) || "").toLowerCase();
  assert(/^#[0-9a-f]{6}$/.test(nativeBg), "capacitor.config 的 android.backgroundColor 不是 6 位 hex");
  const css = readCss("src/style.css");
  const m = css.match(/--page-bg:\s*(#[0-9a-fA-F]{6})/);
  assert(!!m, "style.css 找不到 --page-bg");
  assert(nativeBg === m[1].toLowerCase(),
    "窗口底 " + nativeBg + " 与页面底 " + m[1] + " 不同值 —— 键盘让位动画期间会闪出可见的底色缝");
  const styles = read("android/app/src/main/res/values/styles.xml");
  const wb = [...styles.matchAll(/name="android:windowBackground">(#[0-9A-Fa-f]{6})</g)].map((x) => x[1].toLowerCase());
  assert(wb.length >= 1, "styles.xml 里没有 windowBackground");
  for (const c of wb) assert(c === nativeBg, "styles.xml 的 windowBackground " + c + " 与 config 不同值");
});

/* —— ③ 系统栏照旧让位、唯独不计输入法 ——
 * 轮 487 口径复核：轮 347 把「decorView 加 padding」整套撤了 —— 让位改由
 * env(safe-area-inset-*) + --sat/--sab 承担（真机实测重复让位 = 内容比状态栏低一整条、
 * 底部多一条导航栏高的空白）。所以「必须 setPadding」这条老断言已经反了，改成锁：
 *   ① 仍接管 insets 并按 systemBars 取值；② 绝不再加 padding；③ 键盘可见时安全区底部归零。 */
t("MainActivity：接管 insets，只给系统栏让位（轮347 起不再 setPadding）", () => {
  const java = read("android/app/src/main/java/net/de5/dale/MainActivity.java");
  assert(/setOnApplyWindowInsetsListener/.test(java), "MainActivity 没有接管 insets 监听");
  const block = (java.match(/setOnApplyWindowInsetsListener\([\s\S]*?\n        \}\);/g) || []).join("\n");
  assert(/Type\.systemBars\(\)/.test(block), "监听里没有按 systemBars 让位（状态栏/导航栏会压到内容上）");
  assert(!/setPadding\(/.test(block),
    "又给 decorView 加 padding 了：会和 --sat/--sab 双重让位（轮347 真机实测：内容低一整条 + 底部空一条）");
  assert(/imeVisible\s*\?\s*0\s*:\s*bars\.bottom/.test(block),
    "键盘可见时安全区底部没归零（输入法顶掉导航栏后会多一条 navBar 高的缝）");
  assert(/Type\.displayCutout\(\)/.test(block), "没算刘海（displayCutout），横屏会压到挖孔区");
});

/* —— ④ 输入法高度 → CSS 变量 —— */
t("keyboardInset：四个键盘事件都接、写 --kb-h", () => {
  const js = read("src/utils/keyboardInset.js");
  for (const ev of ["keyboardWillShow", "keyboardDidShow", "keyboardWillHide", "keyboardDidHide"]) {
    assert(js.includes('"' + ev + '"'), "没注册 " + ev);
  }
  assert(/--kb-h/.test(js), "没有 --kb-h 变量名");
  assert(/setProperty\(/.test(js), "没有 setProperty 写入变量");
});
t("轮 462：App 壳仍只走 Keyboard 插件，网页端另走可视视口（两条支路不许互相污染）", () => {
  const js = read("src/utils/keyboardInset.js");
  assert(/if \(!Capacitor\.isNativePlatform\(\)\) \{ initWeb\(\); return; \}/.test(js),
    "没有「原生 → 插件 / 网页 → initWeb」的分流");
  /* 网页端不许碰 Keyboard 插件：浏览器里没有这个原生插件，调用会抛 */
  const webFn = (js.match(/function initWeb\(\)[\s\S]*?\n\}/) || [""])[0];
  assert(!!webFn, "缺 initWeb()");
  assert(!/Keyboard\./.test(webFn), "initWeb 里调了 Keyboard 插件");
  assert(/WEB_CLASS = "kb-web"/.test(js) && /classList\.add\(WEB_CLASS\)/.test(js),
    "没给 html 打 kb-web（style.css 的三条网页端规则挂在这个类上）");
});
t("轮 462：网页端用 visualViewport 量键盘，且只在真的在输入时让位", () => {
  const js = read("src/utils/keyboardInset.js");
  assert(/window\.visualViewport/.test(js), "没读 visualViewport");
  assert(/vv\.addEventListener\("resize"/.test(js) && /vv\.addEventListener\("scroll"/.test(js),
    "可视视口的 resize / scroll 都要接（iOS 上推只派发 scroll）");
  assert(/vv\.scale > 1\.05/.test(js), "缺双指缩放排除（缩放也会缩可视视口，但不是键盘）");
  assert(/editableFocused\(\)/.test(js), "缺「有焦点才让位」的判据（否则地址栏伸缩会被当成键盘）");
  assert(/shadowRoot\s*&&\s*el\.shadowRoot\.activeElement/.test(js),
    "没钻进 shadow DOM：会话输入框在 vue-advanced-chat 里，宿主 tagName 判不出来 → 聊天页一动不动");
  assert(/focusin/.test(js), "缺 focusin 逐帧采样（部分国产内核不派发可视视口事件）");
  assert(/kbWebInset\(window\.innerHeight, vv\.height, vv\.offsetTop\)/.test(js),
    "没把 innerHeight / vv.height / vv.offsetTop 一起喂给纯函数");
});
t("style.css：.kb-web 三处让位与 .cap-app 一一对应（改一份就要改另一份）", () => {
  const css = readCss("src/style.css");
  assert(/html\.kb-web \{[^}]*--kb-h:\s*0px/.test(css), "kb-web 没定义 --kb-h 初值");
  assert(/html\.kb-web \.shell--mobile-nav\.shell--chat \.dm-page\s*\{[^}]*height:\s*calc\(100dvh - var\(--kb-h/.test(css),
    "聊天页高度没接 --kb-h");
  /* 轮 464：这条规则是 100dvh 单写 —— 内核不认 dvh 时整条失效，而它又压掉了上面
   * 那条 100vh/100dvh，height 直接落回 auto（真机 .dm-page=2401，屏高 744）。
   * 必须补一行 100vh 的同一算式当垫底。 */
  assert(/html\.kb-web \.shell--mobile-nav\.shell--chat \.dm-page\s*\{[^}]*height:\s*calc\(100vh - var\(--kb-h/.test(css),
    "聊天页高度缺 100vh 垫底（旧内核不认 dvh → 整条失效 → 按内容撑高）");
  /* 轮 504：网页端的评论底条**不再**用 bottom: var(--kb-h) 这条间接推导。
   * 真机（iPhone Safari）上它会把条顶到页面顶部 —— --kb-h 链上任一道闸门失效就会拿到
   * 残留值 / 被夹到 layout-120。现在改由 utils/fixedBar.js 按可视视口钉内联 top，
   * CSS 只留 bottom: 0 当「算不出来就贴布局视口底」的兜底。 */
  assert(/html\.kb-web \.cmt-main-bar\s*\{[^}]*bottom:\s*0;/.test(css),
    "网页端评论底条没有 bottom: 0 兜底（不许再拿 --kb-h 推导）");
  assert(!/html\.kb-web \.cmt-main-bar\s*\{[^}]*bottom:\s*var\(--kb-h\)/.test(css),
    "网页端评论底条又回到 --kb-h 间接推导（真机上会把条顶到半空）");
  const fb = read("src/utils/fixedBar.js");
  assert(/\.cmt-main-bar/.test(fb) && /fixedBarTop\(/.test(fb),
    "fixedBar 没接管评论底条（bottom:0 会在键盘底下）");
  assert(/html\.cap-app \.cmt-main-bar\s*\{[^}]*bottom:\s*var\(--kb-h\)/.test(css),
    "App 壳评论条没接 --kb-h（那边不跑 fixedBar）");
  assert(/html\.kb-web \.reply-bar\s*\{[^}]*bottom:\s*calc\(var\(--kb-h\) \+ 64px/.test(css),
    "详情页回复条没接 --kb-h");
  assert(/html\.kb-web \.cmt-main-bar\.wp-emoji-open[\s\S]{0,200}padding-bottom:\s*var\(--kb-panel-h\)/.test(css),
    "表情面板打开时底条没让位（轮 504 起是 padding-bottom 撑开，不再是 bottom 抬升）");
});
t("keyboardInset：异常一律归零 + 切后台归零（绝不带一条永久空白回来）", () => {
  const js = read("src/utils/keyboardInset.js");
  const catches = js.match(/catch\s*\([^)]*\)\s*\{[\s\S]*?\}/g) || [];
  assert(catches.some((b) => /setInset\(0\)/.test(b)), "异常路径没有 setInset(0) 兜底");
  assert(/visibilitychange/.test(js) && /document\.hidden/.test(js), "缺 visibilitychange 归零兜底");
});
t("main.js：启动即初始化键盘让位", () => {
  const m = read("src/main.js");
  assert(/from "\.\/utils\/keyboardInset\.js"/.test(m), "没 import keyboardInset.js");
  assert(/(^|\n)\s*initKeyboardInset\(\);/.test(m), "没调用 initKeyboardInset()");
});

/* —— ④b 轮 324/347：键盘高度的扣减口径 ——
 * 轮 324 时 WebView 底被导航栏顶上去，--kb-h 必须减 --sys-bottom。
 * 轮 347 改真·全屏后 WebView 底 = 窗口底，`--sys-bottom` 恒推 0px，减法自然退化成 no-op。
 * 轮 487 复核：纯函数的减法必须留着（旧布局 / 未来改回仍要用），但 App 壳必须推 0，
 * 且不许再出现「按 navBar 缓存取大者」那种只对旧布局成立的分支。 */
t("轮 324/347：--kb-h 仍扣 --sys-bottom（纯函数兜底），App 壳该值恒 0", () => {
  const js = read("src/utils/keyboardInset.js");
  const math = read("src/utils/keyboardMath.js");
  assert(/const SYS_BOTTOM_VAR = "--sys-bottom"/.test(js), "没有 --sys-bottom 变量名");
  assert(/getComputedStyle\(document\.documentElement\)\.getPropertyValue\(SYS_BOTTOM_VAR\)/.test(js),
    "没有从 html 上读 --sys-bottom");
  assert(/import \{[^}]*\bkbPageInset\b[^}]*\} from "\.\/keyboardMath\.js"/.test(js), "没有用纯函数 kbPageInset");
  assert(/Math\.max\(0, Math\.round\(ime - sys\)\)/.test(math),
    "纯函数里没扣 sysBottom：Keyboard 的 keyboardHeight 从窗口底量，旧布局下会悬空一条 navBar");
  assert(/vh - 120/.test(math), "纯函数缺少「离谱值夹取」兜底");
  const java = read("android/app/src/main/java/net/de5/dale/MainActivity.java");
  assert(/setProperty\('--sys-bottom'/.test(java), "MainActivity 没把 --sys-bottom 推给网页层");
  assert(/setProperty\('--sys-bottom',\s*'0px'\)/.test(java),
    "--sys-bottom 不是恒 0：轮347 已让 WebView 铺到窗口底，再减一次就是白垫一条");
  assert(/evaluateJavascript\(/.test(java), "MainActivity 没走 evaluateJavascript 推值");
  assert(/\/ density\)/.test(java), "推给网页的值没按 density 换成 CSS px");
  const css = read("src/style.css");
  assert(/html\.cap-app \{[^}]*--sys-bottom: 0px/.test(css), "CSS 缺 --sys-bottom 默认值（读不到会算成 NaN）");
});

/* —— ⑤ 让位落到三处可见控件 —— */
t("style.css：--kb-h 变量 + 正文底部让位", () => {
  const css = readCss("src/style.css");
  assert(/html\.cap-app\s*\{[^}]*--kb-h:\s*0px/.test(css), "html.cap-app 没定义 --kb-h 初值");
  assert(/html\.cap-app body\s*\{[^}]*padding-bottom:\s*var\(--kb-h\)/.test(css),
    "body 没有 padding-bottom: var(--kb-h)（长页面滚不到输入框）");
});
t("style.css：聊天整屏页高度跟着 --kb-h 缩，且带过渡（dvh 关在 @supports 里）", () => {
  const css = readCss("src/style.css");
  const at = css.indexOf("html.cap-app .shell--mobile-nav.shell--chat .dm-page {");
  assert(at > 0, "缺「聊天整屏页高度跟着键盘缩」的规则");
  const base = css.slice(at, css.indexOf("}", at) + 1);
  /* 轮 474：基线必须是 100vh（旧内核只认 vh）；dvh 版单独关进 @supports。
   * 同一规则里写两条声明是错的 —— dvh 解析期合法、计算期作废，会把 100vh 一起吃掉。 */
  assert(/height:\s*calc\(100vh - var\(--kb-h\)\)/.test(base),
    "基线高度没用 calc(100vh - var(--kb-h))（旧内核只有这一条能兜住）");
  assert(/transition:\s*height\s/.test(base), "高度没有过渡（会硬跳、与输入法错位）");
  const sup = css.indexOf("@supports (height: 100dvh)", at);
  assert(sup > at, "缺 dvh 的 @supports 覆盖块");
  assert(/height:\s*calc\(100dvh - var\(--kb-h\)\)/.test(css.slice(sup, sup + 400)),
    "dvh 版高度没关进 @supports（旧内核会把整条 height 算成 auto）");
});
t("style.css：暖心墙吸底评论条 bottom 跟着 --kb-h 抬，且带过渡", () => {
  const css = readCss("src/style.css");
  const m = css.match(/html\.cap-app \.cmt-main-bar\s*\{[^}]*\}/);
  assert(!!m, "缺「吸底评论条跟着键盘抬」的规则");
  assert(/bottom:\s*var\(--kb-h\)/.test(m[0]), "bottom 没接 --kb-h");
  assert(/transition:\s*bottom\s/.test(m[0]), "bottom 没有过渡");
});
t("style.css：详情页固定回复条 .reply-bar 也要跟着抬", () => {
  const css = readCss("src/style.css");
  const m = css.match(/html\.cap-app \.reply-bar\s*\{[^}]*\}/);
  assert(!!m, "缺 .reply-bar 的键盘让位规则（详情页回复条会被键盘盖住）");
  assert(/bottom:\s*calc\(var\(--kb-h\) \+ 64px/.test(m[0]), "bottom 没接 --kb-h + 64px");
  assert(/transition:\s*bottom\s/.test(m[0]), "bottom 没有过渡");
});

/* —— ⑥ 视口策略 + 已被证伪的写法 —— */
t("index.html：viewport 声明 interactive-widget=resizes-content（且不写 viewport-fit=cover）", () => {
  const html = read("index.html");
  const m = html.match(/<meta\s+name="viewport"[^>]*>/);
  assert(!!m, "index.html 没有 viewport meta");
  /* 轮 463：resizes-visual → resizes-content。前者只缩可视视口，100dvh 不变、底条留在键盘底下
     （iOS 还会把整页上推露出一条空白）；后者让 Chromium 系缩布局视口，输入条自然贴键盘上沿。 */
  assert(/interactive-widget=resizes-content/.test(m[0]), "viewport 缺 interactive-widget=resizes-content");
  assert(!/interactive-widget=resizes-visual/.test(m[0]), "又退回 resizes-visual 了（底条会留在键盘底下）");
  /* viewport-fit=cover 在 App 里没有收益：这台 WebView 的 env(safe-area-inset-*) 实测恒为 0，
     安全区由 MainActivity 的原生 padding 负责；而它对 iPhone Safari 有副作用（内容顶到刘海下），
     所以别再写回来。 */
  assert(!/viewport-fit=cover/.test(m[0]), "又写了 viewport-fit=cover（App 无用 + iOS 有副作用）");
});
t("cap-strip-hero：App 那份 index.html 的视口切成 overlays-content", () => {
  const js = read("tools/cap-strip-hero.mjs");
  assert(/interactive-widget=resizes-content/.test(js) && /interactive-widget=overlays-content/.test(js),
    "cap-strip-hero 没有把 App 的视口策略改成 overlays-content（VP_OLD 要跟着 index.html 走）");
  assert(/VP_OLD/.test(js) && /VP_NEW/.test(js), "改写逻辑没接线（VP_OLD/VP_NEW）");
  /* 轮 462：网页端去掉 cover，App 这份要补回来（edge-to-edge WebView 靠它铺到最底） */
  assert(/VP_COVER_ANCHOR/.test(js) && /viewport-fit=cover/.test(js),
    "App 那份没补回 viewport-fit=cover（WebView 会自己内缩一条导航栏，底部白一条）");
  /* 判定必须落在 meta 标签上：dist 的 head 里有一句「去掉 viewport-fit=cover」的中文注释，
     按全文 includes 判会被注释骗过去（本轮踩过，App 那份一直没补上）。 */
  assert(/<meta\\s\+name="viewport"\[\^>\]\*viewport-fit=cover/.test(js) || /name="viewport"\[\^>\]\*viewport-fit=cover/.test(js),
    "补 cover 前的判定没限定在 meta 标签里（会被 head 里的注释误判）");
});
t("style.css：不许再写 100svh（本机浏览器量出 0 = 无效声明，会被整条丢弃）", () => {
  const css = readCss("src/style.css");
  assert(!/100svh/.test(css), "又出现了 100svh");
});
t("style.css：聊天页高度仍是 100vh 基线 + @supports 内 100dvh（旧内核回退口径不许丢）", () => {
  const css = readCss("src/style.css");
  /* 轮 487 复核：轮 474 把「同规则两条声明」改成「vh 基线 + @supports 覆盖」，
   * 旧断言还在找连续两行 `height:100vh; height:100dvh;` —— 那种写法本身就是 bug。
   * 现在锁的是行为：基线认 vh，dvh 只在不支持时才不生效。 */
  const base = css.match(/(?:^|\n)\.shell--mobile-nav\.shell--chat \.dm-page \{([^}]*)\}/);
  assert(!!base, "缺基线 .shell--mobile-nav.shell--chat .dm-page 规则");
  assert(/height:\s*100vh/.test(base[1]), "基线高度不是 100vh（旧内核会落回 auto）");
  assert(/gap:\s*0/.test(base[1]), "基线丢了 gap:0（会话列表与输入条之间会多一条缝）");
  const dvh = /\.shell--mobile-nav\.shell--chat \.dm-page \{\s*height:\s*100dvh;?\s*\}/.exec(css);
  assert(!!dvh, "@supports 里没有把高度覆盖成 100dvh（新内核就不会随地址栏伸缩）");
  const near = css.lastIndexOf("@supports (height: 100dvh)", dvh.index);
  assert(near >= 0 && dvh.index - near < 260,
    "dvh 覆盖不在 @supports 块里（旧内核不认 dvh，整条 height 会退成 auto）");
});

/* ─── 轮 465 · 网页端改用 fixed 精确覆盖可视视口 ───
 * 462/463/464 三轮都在「算高度」，真机全部失败：iOS Safari 从不缩布局视口、只会把整个
 * 文档往上推，只要文档比视口高一行（.shell 天生 padding-bottom:48px），算得再准也露白；
 * 小米浏览器键盘是 overlay，输入条贴在布局视口底部正好压在手势条上。
 * 结论：必须脱离文档流 —— fixed + visualViewport 高度，不依赖任何类名判据。 */
t("chatViewport：fixed 接管存在且被 main.js 调用", () => {
  assert(existsSync(ROOT + "/src/utils/chatViewport.js"), "没有 src/utils/chatViewport.js");
  const js = read("src/utils/chatViewport.js");
  const main = read("src/main.js");
  assert(/export function initChatViewport/.test(js), "没导出 initChatViewport");
  assert(/initChatViewport\(\)/.test(main), "main.js 没调用 initChatViewport");
});
t("chatViewport：高度决策交给纯函数（轮 468：不再在脚本里按单一内核语义取值）", () => {
  const js = read("src/utils/chatViewport.js");
  /* 轮 503：height + top 一起由 pickChatRect 裁决（它内部就是 pickChatHeight + 裁到可视区） */
  assert(/pickChatRect\(window\.innerHeight/.test(js),
    "没把 innerHeight / vv.height / vvTop / --kb-h 喂给 pickChatRect");
  assert(/from "\.\/chatHeight\.js"/.test(js), "没从 chatHeight 引纯函数");
  /* 轮 470：判据从「--kb-h 有值」改成「可视视口缩了」(kbOpen)。原因是多内核矩阵实测：
     部分国产内核键盘弹起时不派发 visualViewport 事件，--kb-h 恒为 0；而 overlay 键盘下
     100dvh 根本不变 → 容器仍全屏高，底边落到键盘底下，输入条被整个盖住。
     真正的理由是「键盘占到地方了」，不是「某条链路算出值了」。 */
  assert(/const kbOpen = rect\.kbOpen/.test(js), "没接 pickChatRect 的 kbOpen");
  assert(/useInlineH = kbOpen \|\| !supportsDvh/.test(js),
    "内联高度判据没走 kbOpen（overlay 且不派发事件的内核会在键盘底下留全屏高）");
  assert(/supportsDvh/.test(js), "没有 dvh 能力探测（老内核要退回写死）");
  assert(/el\.style\.position = "fixed"/.test(js), "没有设 position:fixed（文档仍可被上推）");
  /* 具体选源口径由 tools/chat-height-test.mjs 的多内核矩阵锁住（轮 468）。 */
});
t("chatViewport：App 壳必须排除（那边走原生 --kb-h，两套混用会顶穿）", () => {
  const js = read("src/utils/chatViewport.js");
  assert(/isNativePlatform/.test(js) && /cap-app/.test(js),
    "没有 App 壳守卫（isNativePlatform / cap-app）");
  assert(/if \(isNativeShell\(\)\) return null/.test(js), "守卫没接进 findChatPage");
});
t("chatViewport：关掉 CSS 的 height 过渡（否则输入条落后键盘半拍）", () => {
  const js = read("src/utils/chatViewport.js");
  assert(/el\.style\.transition = "none"/.test(js), "没有显式清掉 transition");
});
t("chatViewport：容器变高矮后贴底要保住（否则键盘弹起会上跳一屏）", () => {
  const js = read("src/utils/chatViewport.js");
  assert(/stick/.test(js) && /sc\.scrollTop = sc\.scrollHeight/.test(js),
    "缺「原本贴底就继续贴底」的处理");
});
t("style.css：wp-chat-fix 锁滚动，且底部不再垫底", () => {
  const css = readCss("src/style.css");
  assert(/html\.wp-chat-fix[\s\S]{0,200}overflow:\s*hidden/.test(css),
    "wp-chat-fix 没锁 html/body 滚动");
  /* 轮 466：`html.wp-chat-fix .dm-page { padding-bottom: max(6px, env(...)) }` 删掉了。
   * 真机（1080×2460）逐像素量：输入框底边到工具栏上沿空 63 物理像素，其中 16px 就是
   * 这条 6px + thread 的 10px 叠出来的。网页端浏览器工具栏已经让开手势条，再垫就是留白。 */
  assert(!/html\.wp-chat-fix \.dm-page\s*\{[^}]*padding-bottom/.test(css),
    "wp-chat-fix 又把 .dm-page 的底部垫底加回来了（真机实测就是这条留白）");
  assert(/html\.wp-chat-fix \.shell--mobile-nav\.shell--chat \.dm-thread[\s\S]{0,90}padding-bottom:\s*0/.test(css),
    "thread 的 10px 底部保底没在网页端归零");
});

console.log(`\nkeyboard-policy-test (${ROOT}) :: ${ok.length}/${ok.length + bad.length}`);
for (const n of ok) console.log("  ok   " + n);
for (const n of bad) console.log("  FAIL " + n);
process.exit(bad.length ? 1 : 0);
