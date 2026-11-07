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

/* —— ③ 系统栏照旧让位、唯独不计输入法 —— */
t("MainActivity：接管 insets，只给系统栏让位（不计输入法高度）", () => {
  const java = read("android/app/src/main/java/net/de5/dale/MainActivity.java");
  assert(/setOnApplyWindowInsetsListener/.test(java), "MainActivity 没有接管 insets 监听");
  const block = (java.match(/setOnApplyWindowInsetsListener\([\s\S]*?\n        \}\);/g) || []).join("\n");
  assert(/Type\.systemBars\(\)/.test(block), "监听里没有按 systemBars 让位（状态栏/导航栏会压到内容上）");
  assert(/setPadding\(/.test(block), "监听里没有 setPadding");
  assert(!/imeInsets/.test(block) && !/getInsets\(\s*WindowInsetsCompat\.Type\.ime\(\)/.test(block),
    "监听里把输入法高度算进 padding 了（正是这条把布局视口压成 539）");
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
  assert(/html\.kb-web \.shell--mobile-nav\.shell--chat \.dm-page\s*\{[^}]*height:\s*calc\(100dvh - var\(--kb-h\)\)/.test(css),
    "聊天页高度没接 --kb-h");
  assert(/html\.kb-web \.cmt-main-bar\s*\{[^}]*bottom:\s*var\(--kb-h\)/.test(css),
    "评论底条 bottom 没接 --kb-h");
  assert(/html\.kb-web \.reply-bar\s*\{[^}]*bottom:\s*calc\(var\(--kb-h\) \+ 64px/.test(css),
    "详情页回复条没接 --kb-h");
  assert(/html\.kb-web \.cmt-main-bar\.wp-emoji-open/.test(css),
    "表情面板打开时底条没跟着抬（3 段规则缺了会被 2 段的 bottom:var(--kb-h) 压掉）");
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

/* —— ④b 轮 324/325：键盘高度必须扣掉「WebView 底部让掉的系统栏」 —— */
t("轮 324：--kb-h = keyboardHeight − 导航栏（不扣就悬空一条 navBar 宽的空白）", () => {
  const js = read("src/utils/keyboardInset.js");
  const math = read("src/utils/keyboardMath.js");
  assert(/const SYS_BOTTOM_VAR = "--sys-bottom"/.test(js), "没有 --sys-bottom 变量名");
  assert(/getComputedStyle\(document\.documentElement\)\.getPropertyValue\(SYS_BOTTOM_VAR\)/.test(js),
    "没有从 html 上读 --sys-bottom");
  assert(/import \{[^}]*\bkbPageInset\b[^}]*\} from "\.\/keyboardMath\.js"/.test(js), "没有用纯函数 kbPageInset");
  assert(/Math\.max\(0, Math\.round\(ime - sys\)\)/.test(math),
    "纯函数里没扣 sysBottom：Keyboard 的 keyboardHeight 从窗口底量，WebView 底已让掉导航栏");
  assert(/vh - 120/.test(math), "纯函数缺少「离谱值夹取」兜底");
  const java = read("android/app/src/main/java/net/de5/dale/MainActivity.java");
  assert(/setProperty\('--sys-bottom'/.test(java), "MainActivity 没把 --sys-bottom 推给网页层");
  assert(/evaluateJavascript\(/.test(java), "MainActivity 没走 evaluateJavascript 推值");
  assert(/\/ density\)/.test(java), "推给网页的值没按 density 换成 CSS px");
  assert(/imeVisible \? Math\.max\(navBarBottom\[0\], bars\.bottom\)/.test(java),
    "键盘可见时没取「缓存值与当前值的大者」（某 ROM 首次派发就带输入法时缓存可能是 0）");
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
t("style.css：聊天整屏页高度跟着 --kb-h 缩，且带过渡", () => {
  const css = readCss("src/style.css");
  const m = css.match(/html\.cap-app \.shell--mobile-nav\.shell--chat \.dm-page\s*\{[^}]*\}/);
  assert(!!m, "缺「聊天整屏页高度跟着键盘缩」的规则");
  assert(/height:\s*calc\(100dvh - var\(--kb-h\)\)/.test(m[0]), "高度没用 calc(100dvh - var(--kb-h))");
  assert(/transition:\s*height\s/.test(m[0]), "高度没有过渡（会硬跳、与输入法错位）");
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
t("index.html：viewport 声明 interactive-widget=resizes-visual（且不写 viewport-fit=cover）", () => {
  const html = read("index.html");
  const m = html.match(/<meta\s+name="viewport"[^>]*>/);
  assert(!!m, "index.html 没有 viewport meta");
  assert(/interactive-widget=resizes-visual/.test(m[0]), "viewport 缺 interactive-widget=resizes-visual");
  /* viewport-fit=cover 在 App 里没有收益：这台 WebView 的 env(safe-area-inset-*) 实测恒为 0，
     安全区由 MainActivity 的原生 padding 负责；而它对 iPhone Safari 有副作用（内容顶到刘海下），
     所以别再写回来。 */
  assert(!/viewport-fit=cover/.test(m[0]), "又写了 viewport-fit=cover（App 无用 + iOS 有副作用）");
});
t("cap-strip-hero：App 那份 index.html 的视口切成 overlays-content", () => {
  const js = read("tools/cap-strip-hero.mjs");
  assert(/interactive-widget=resizes-visual/.test(js) && /interactive-widget=overlays-content/.test(js),
    "cap-strip-hero 没有把 App 的视口策略改成 overlays-content");
  assert(/VP_OLD/.test(js) && /VP_NEW/.test(js), "改写逻辑没接线（VP_OLD/VP_NEW）");
  /* 轮 462：网页端去掉 cover，App 这份要补回来（edge-to-edge WebView 靠它铺到最底） */
  assert(/VP_COVER_ANCHOR/.test(js) && /viewport-fit=cover/.test(js),
    "App 那份没补回 viewport-fit=cover（WebView 会自己内缩一条导航栏，底部白一条）");
});
t("style.css：不许再写 100svh（本机浏览器量出 0 = 无效声明，会被整条丢弃）", () => {
  const css = readCss("src/style.css");
  assert(!/100svh/.test(css), "又出现了 100svh");
});
t("style.css：聊天页高度仍是 100vh → 100dvh 两段式（旧内核回退口径不许丢）", () => {
  const css = readCss("src/style.css");
  assert(/\.shell--mobile-nav\.shell--chat \.dm-page\s*\{\s*height:\s*100vh;\s*height:\s*100dvh;/.test(css),
    "基线 .dm-page 的 height:100vh → 100dvh 两段式没了");
});

console.log(`\nkeyboard-policy-test (${ROOT}) :: ${ok.length}/${ok.length + bad.length}`);
for (const n of ok) console.log("  ok   " + n);
for (const n of bad) console.log("  FAIL " + n);
process.exit(bad.length ? 1 : 0);
