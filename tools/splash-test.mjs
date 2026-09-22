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

ok("轮 30：启动页只给 App（UA 含 Capacitor → html.cap-app 恢复显示；网页默认 display:none）",
  has(html, "cap-app", "capacitor", "#app-splash { display: none; }")
    && html.indexOf("capacitor/i.test(navigator.userAgent") < html.indexOf('id="app-splash"'));

console.log(`splash-test: ${pass} pass, ${fails.length} fail`);
for (const f of fails) console.log("FAIL  " + f);
if (fails.length) process.exit(1);