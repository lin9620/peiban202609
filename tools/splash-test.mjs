/* 启动页（轮 24）守护：静态层存在 / 淡出 / 看门狗联动 / 预热与兜底时序
 * 运行：node tools/splash-test.mjs */
import fs from "node:fs";

let pass = 0;
const fails = [];
function ok(name, cond) { if (cond) pass++; else fails.push(name); }
const read = (p) => fs.readFileSync(p, "utf8");
const has = (src, ...parts) => parts.every((p) => src.includes(p));

const html = read("index.html");
const appVue = read("src/App.vue");

/* 递归列出 res 下的匹配文件（原生启动图回归守护用） */
function filesUnder(dir, re) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = d + "/" + e.name;
      if (e.isDirectory()) walk(p);
      else if (re.test(e.name)) out.push(p);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

ok("index.html：启动页静态层（不依赖 Vue，#app 外的 DOM 层；logo/文案/呼吸动画/背景色与主题一致）",
  has(html, 'id="app-splash"', "sp-paw", "sp-breathe", "温暖的爪印", "#fff7ee"));
ok("index.html：淡出类 .out（App.vue 关页用）+ aria-hidden + prefers-reduced-motion 降动画",
  has(html, "#app-splash.out", 'aria-hidden="true"', "prefers-reduced-motion"));
ok("index.html：看门狗触发先摘启动页（6 秒中文兜底提示不被启动页挡住）",
  has(html, 'var sp = document.getElementById("app-splash");')
    && html.indexOf('document.getElementById("app-splash")') < html.indexOf("app.innerHTML"));
ok("App.vue：云端就绪 + 会话缓存预热后才关启动页（Promise.race 2.5s 兜底放行，云端挂了不挡人）",
  has(appVue, "removeSplash();", "Promise.race([boot, new Promise((r) => setTimeout(r, 2500))])"));
ok("App.vue：预热会话列表与 MessagesView 同款（key dm:convs + dmApi.listConvs(200, 0)；未登录跳过）",
  has(appVue, 'cacheKey("dm:convs", cloud.user.id)', "dmApi.listConvs(200, 0)")
    && appVue.includes("prefetchConvs()")
    && has(appVue, "if (!(cloud.ready && cloud.user)) return;"));
ok("MessagesView：会话键与预热完全一致（dm:convs + listConvs(200, 0)——对不上预热就白做）",
  has(read("src/views/MessagesView.vue"), 'cacheKey("dm:convs", meId.value)', "dmApi.listConvs(200, 0)"));

ok("轮 26：启动页内容加厚（slogan+三条特性+温柔话，逐条浮现动画）",
  has(html, "sp-feats", "sp-quote", "一个温柔的角落", "漂流瓶", "暖心墙",
    "你已经做得比想象中好了", "sp-in", "animation-delay"));

ok("轮 30：启动页只给 App（html.cap-app 恢复显示；网页默认 display:none；判据在启动页之前生效）",
  has(html, "cap-app", "capacitor", "#app-splash { display: none; }")
    && html.indexOf("looksApp") < html.indexOf('id="app-splash"'));

/* ─── 轮 38：两条真实回归的守护（「App 里启动页消失」+「冷启动黑边」）───────────
 * 这两条都在「原生层 + 显示判据」上，而轮 24-37 的 splash-test 只盯网页层，
 * 原生这层一直裸奔 → 所以每轮都"改好了"、黑边和启动页却还在。这里钉死。 */
const cfg = JSON.parse(read("capacitor.config.json"));
const styles = read("android/app/src/main/res/values/styles.xml");
const stylesV31 = read("android/app/src/main/res/values-v31/styles.xml");
const manifest = read("android/app/src/main/AndroidManifest.xml");
const mainJs = read("src/main.js");

ok("轮 38 ① 启动页判据不再只靠 UA：capacitor.config.json 配了 appendUserAgent，且 index.html 认同一串（改一边就红）",
  typeof cfg.android.appendUserAgent === "string" && cfg.android.appendUserAgent.length > 0
    && html.includes(cfg.android.appendUserAgent));
ok("轮 38 ② 判据多信号（androidBridge/Capacitor/UA）+ main.js 用 Capacitor.isNativePlatform() 在 mount 前权威补判",
  html.includes("window.androidBridge") && html.includes("navigator.userAgent")
    && mainJs.includes("Capacitor.isNativePlatform()")
    && mainJs.includes('classList.add("cap-app")')
    && mainJs.indexOf('classList.add("cap-app")') < mainJs.indexOf('mount("#app")'));
ok("轮 38 ③ 米色窗口底挂在「Activity 真正使用」的主题上（轮 25 写在了没人用的 AppTheme.NoActionBar 上）",
  manifest.includes('android:theme="@style/AppTheme.NoActionBarLaunch"')
    && /<style name="AppTheme\.NoActionBarLaunch" parent="AppTheme\.NoActionBar">/.test(styles)
    && /<style name="AppTheme\.NoActionBar"[\s\S]*?<item name="android:windowBackground">#FFF7EE<\/item>/.test(styles));
ok("轮 38 ④ 原生启动层是米色品牌图，Capacitor 默认蓝色 X splash.png 已删净（主题零 @drawable/splash 引用）",
  styles.includes("@drawable/launch_bg")
    && !/@drawable\/splash\b/.test(styles)
    && !/@drawable\/splash\b/.test(stylesV31)
    && fs.existsSync("android/app/src/main/res/drawable/launch_paw.xml")
    && filesUnder("android/app/src/main/res", /splash/i).length === 0);
ok("轮 38 ⑤ Android 12+ 系统启动画面同样米色（不设就退回 ?colorBackground=黑 → 冷启动一圈黑）",
  stylesV31.includes('<item name="android:windowSplashScreenBackground">#FFF7EE</item>')
    && stylesV31.includes('parent="AppTheme.NoActionBar"'));

/* ─── 轮 39：深色模式「黑屏」的守护（用户夜测报「黑屏没改」）──────────────────
 * App 恒为米色浅色主题，但 AppTheme.NoActionBar 用的是 DayNight parent、WebView
 * 也没退出 Force Dark：深色模式下系统/MIUI 的「强制深色」会把米色页面整个反黑。
 * 轮 38 是在下午浅色模式下抓帧实测的 → 测不出这一层。三道闸全部钉死。 */
const styleBlock = (src, name) => (src.match(new RegExp('<style name="' + name + '"[\\s\\S]*?</style>')) || [""])[0];
const blockAppTheme = styleBlock(styles, "AppTheme"); /* 引号闭合，不会误命中 AppTheme.NoActionBar */
const blockNoActionBar = styleBlock(styles, "AppTheme.NoActionBar");
const blockLaunchV31 = styleBlock(stylesV31, "AppTheme.NoActionBarLaunch");
const mainActivity = read("android/app/src/main/java/net/de5/dale/MainActivity.java");

ok("轮 39 ① 主题零 DayNight（恒浅色 App 用 Light parent；DayNight 在深色下只会把回落色翻黑）",
  blockNoActionBar.includes('parent="Theme.AppCompat.Light.NoActionBar"')
    && !styles.includes('parent="Theme.AppCompat.DayNight'));
ok("轮 39 ② Force Dark 三处显式退出（AppTheme / AppTheme.NoActionBar / v31 Launch——继承链节点各自带齐，防整体替换丢属性）",
  blockAppTheme.includes('<item name="android:forceDarkAllowed">false</item>')
    && blockNoActionBar.includes('<item name="android:forceDarkAllowed">false</item>')
    && blockLaunchV31.includes('<item name="android:forceDarkAllowed">false</item>'));
ok("轮 39 ③ MainActivity 强制浅色配置在 super.onCreate 之前 + WebView 实例关 Force Dark（双保险）",
  mainActivity.includes("AppCompatDelegate.setDefaultNightMode(AppCompatDelegate.MODE_NIGHT_NO)")
    && mainActivity.indexOf("AppCompatDelegate.setDefaultNightMode") < mainActivity.indexOf("super.onCreate(savedInstanceState)")
    && mainActivity.includes("setForceDarkAllowed(false)"));

/* 轮 30 埋的雷：它在启动页样式块中间插了 </style>，把唯一 style 提前闭合，
 * 后面 30 行 CSS 全成了裸文本 → 唯一生效的规则是 display:none，启动页从此
 * 在任何环境都不可能显示（App 端「启动页又没了」的真因）。这里连 HTML 结构一起守。 */
const styleBlocks = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
ok("轮 38 ⑥ 启动页 CSS 真在 <style> 里 + 标签配对（裸文本回归守护）",
  styleBlocks.includes("#app-splash { position: fixed")
    && styleBlocks.includes("html.cap-app #app-splash { display: flex; }")
    && styleBlocks.includes("#app-splash { display: none; }")
    && (html.match(/<style>/g) || []).length === (html.match(/<\/style>/g) || []).length);
/* 优先级：④ 恢复显示那条必须排在 ② 默认隐藏之后（同块内靠后 + 选择器多一个类） */
ok("轮 38 ⑦ 显示规则优先级正确（默认 display:none 在前，html.cap-app 恢复显示在后）",
  styleBlocks.indexOf("#app-splash { display: none; }") < styleBlocks.indexOf("html.cap-app #app-splash { display: flex; }"));

console.log(`splash-test: ${pass} pass, ${fails.length} fail`);
for (const f of fails) console.log("FAIL  " + f);
if (fails.length) process.exit(1);