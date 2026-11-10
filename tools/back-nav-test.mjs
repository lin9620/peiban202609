/* 轮 493 · App 系统返回键的导航策略锁（Node 直跑）
 *   node tools/back-nav-test.mjs
 *
 * 用户实报：「app端为什么所有的返回都是返回桌面了，而不是前一页或者返回首页呢，
 *            你设计一下正常app的返回逻辑」。
 *
 * 旧口径（轮 T9）只有一句：非根视图 router.back()，四个 Tab 根 minimizeApp()。
 * 于是站在暖心墙/消息/我的上按一下返回，整个 App 直接缩到桌面 —— 这就是"所有返回
 * 都回桌面"。反过来，冷启动深链（通知点进来 / 分享链接 / 谷歌登录回跳）没有历史，
 * router.back() 无路可退，把 WebView 历史退到底 = 白屏或掉出应用。
 *
 * 这里锁三层：
 *   ① 纯决策表 planBack 的每一档行为（含用户实景：站 Tab 根按一次返回绝不能 minimize）
 *   ② 路由表：每个二级页必须声明 meta.backTo，且指向真实存在的路径
 *   ③ 接线：注册在 setup 顶层（不在 onMounted 末尾）、不再用 ROOT_VIEWS 名字白名单、
 *      首页有「再按一次退出」提示、五语种都有这句文案
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { planBack, normPath, TAB_ROOTS, EXIT_HINT_WINDOW } from "../src/utils/backPlan.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

let pass = 0, fail = 0; const out = [];
function t(name, fn) {
  try { fn(); pass++; out.push("ok   " + name); }
  catch (e) { fail++; out.push("FAIL " + name + " :: " + e.message); }
}

const app = read("src/App.vue");
const routerSrc = read("src/router.js");
const css = read("src/style.css");
const i18n = read("src/i18n.js");
const i18nEs = read("src/i18n.es.js");
const i18nPt = read("src/i18n.pt.js");
const i18nFr = read("src/i18n.fr.js");

/* ═══════════ ① 决策表 ═══════════ */

t("P1 应用内还有上一页 → 回上一页（用户说的「前一页」）", () => {
  const p = planBack({ path: "/post/12", back: "/community", backTo: "/community" });
  assert.equal(p.action, "history");
});

t("P2 没有上一页（冷启动深链）但声明了父页 → replace 到父页，不是退出", () => {
  const p = planBack({ path: "/post/12", back: null, backTo: "/community" });
  assert.equal(p.action, "replace");
  assert.equal(p.to, "/community");
});

t("P3 已拉黑这类三级页：父页优先于 Tab 根", () => {
  const p = planBack({ path: "/settings/blocked", back: null, backTo: "/settings" });
  assert.equal(p.action, "replace");
  assert.equal(p.to, "/settings");
});

t("P4 站在非首页的 Tab 根按返回 → 回首页（不是最小化到桌面）", () => {
  for (const p of ["/community", "/messages", "/profile"]) {
    const r = planBack({ path: p, back: null, backTo: "" });
    assert.equal(r.action, "replace", p + " 没回首页");
    assert.equal(r.to, "/", p + " 回的不是首页");
    assert.notEqual(r.action, "minimize", p + " 仍然直接退到桌面");
  }
});

t("P5 首页第一次按返回只提示，不退（用户实报的「一按就回桌面」）", () => {
  const r = planBack({ path: "/", back: null, backTo: "", now: 1000, lastHintAt: 0 });
  assert.equal(r.action, "hint");
  assert.notEqual(r.action, "minimize");
});

t("P6 首页提示后 2 秒内再按 → 才最小化到桌面（App 惯例）", () => {
  const r = planBack({ path: "/", back: null, backTo: "", now: 1000 + EXIT_HINT_WINDOW - 1, lastHintAt: 1000 });
  assert.equal(r.action, "minimize");
});

t("P7 超过 2 秒窗口再按 → 重新提示（不能凭很久之前那一次就退出）", () => {
  const r = planBack({ path: "/", back: null, backTo: "", now: 1000 + EXIT_HINT_WINDOW + 1, lastHintAt: 1000 });
  assert.equal(r.action, "hint");
});

t("P8 故事系 replace 型返回：哪怕有上一页也回发现页（轮 148 老 bug 不能复活）", () => {
  const r = planBack({ path: "/story/12", back: "/", backTo: "/story", backMode: "replace" });
  assert.equal(r.action, "replace");
  assert.equal(r.to, "/story");
});

t("P9 页面内 ← 钮（allowExit=false）在首页什么都不做，绝不退出 App", () => {
  const r = planBack({ path: "/", back: null, backTo: "", allowExit: false });
  assert.equal(r.action, "none");
});

t("P10 back 指向自己时不算「有上一页」（否则原地打转）", () => {
  const r = planBack({ path: "/community", back: "/community", backTo: "", now: 0, lastHintAt: 0 });
  assert.equal(r.action, "replace");
  assert.equal(r.to, "/");
});

t("P11 路径归一：/zh 别名、尾斜杠、query 都不影响判断", () => {
  assert.equal(normPath("/zh"), "/");
  assert.equal(normPath("/zh/community/"), "/community");
  assert.equal(normPath("/messages?tab=notif"), "/messages");
  assert.equal(normPath(""), "/");
  const r = planBack({ path: "/zh/messages", back: null, backTo: "" });
  assert.equal(r.action, "replace");
  assert.equal(r.to, "/");
});

/* ── 轮495 · 轮493 那版最致命的一条错（用户：「故事主页连续两次返回没有用」）──
 * 实测（_scratch/backprobe 真路由探针）：replace 之后 history.state.back 会指回
 * 刚离开的那一页 —— 在 /story 按返回 → replace("/") → state.back = "/story"。
 * 若「有没有上一页」排在「Tab 根」前面，首页就会 router.back() 跳回 /story：
 * 用户按两次 = 去了首页又弹回来，等于没动。这三条把这个顺序钉死。 */
t("P13 首页即使 history 里有上一页，也只提示退出（不许被 history 抓走）", () => {
  const r = planBack({ path: "/", back: "/story", backTo: "", now: 1000, lastHintAt: 0 });
  assert.equal(r.action, "hint", "首页必须提示退出，不能 history back（那是乒乓的来源）");
  const r2 = planBack({ path: "/", back: "/story", backTo: "", now: 1500, lastHintAt: 1000 });
  assert.equal(r2.action, "minimize", "窗口内第二次按键才最小化");
});

t("P14 Tab 根一律回首页，哪怕历史里有别的上一页", () => {
  for (const p of ["/community", "/messages", "/profile"]) {
    const r = planBack({ path: p, back: "/story", backTo: "", now: 0, lastHintAt: 0 });
    assert.equal(r.action, "replace", p + " 在 Tab 根时不该 history back");
    assert.equal(r.to, "/");
  }
});

t("P15 故事主页返回 = 回它来的地方（不是原地、也不是发现页）", () => {
  const r = planBack({ path: "/story", back: "/", backTo: "/", now: 0, lastHintAt: 0 });
  assert.equal(r.action, "history", "有上一页就该回上一页");
});

t("P16 故事详情返回 = 历史回退（从哪进去回哪，轮495 用户要求）", () => {
  const fromHome = planBack({ path: "/story/12", back: "/?tab=story", backTo: "/story", now: 0, lastHintAt: 0 });
  assert.equal(fromHome.action, "history", "从首页故事联进来要回首页，不能甩到 /story");
  const deepLink = planBack({ path: "/story/12", back: null, backTo: "/story", now: 0, lastHintAt: 0 });
  assert.equal(deepLink.action, "replace");
  assert.equal(deepLink.to, "/story", "没有上一页才回发现页");
});

t("P12 聊天页无历史（通知直达 /messages/9）→ 回会话列表", () => {
  const r = planBack({ path: "/messages/9", back: null, backTo: "/messages" });
  assert.equal(r.action, "replace");
  assert.equal(r.to, "/messages");
});

t("P13 Tab 根集合就是底部四个页签的 path（不是 route name）", () => {
  assert.deepEqual(TAB_ROOTS, ["/", "/community", "/messages", "/profile"]);
});

/* ═══════════ ② 路由表：二级页必须声明父页 ═══════════ */

/* 取所有单行路由定义（本项目约定一条路由一行；多行会被下面的 E1 抓到） */
const routeLines = routerSrc
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => /^\{\s*path:\s*"/.test(l));

t("R1 路由表能被解析（至少 20 条；格式变了就更新这条测试）", () => {
  assert.ok(routeLines.length >= 20, `只解析到 ${routeLines.length} 条路由`);
});

t("R2 每个二级页都声明了 meta.backTo（漏一个 = 深链进这页按返回就没路可走）", () => {
  const missing = [];
  for (const line of routeLines) {
    const p = (line.match(/path:\s*"([^"]+)"/) || [])[1];
    if (!p) continue;
    if (TAB_ROOTS.includes(p)) continue;          /* Tab 根不需要父页 */
    if (p.includes("pathMatch")) continue;         /* 404 兜底 */
    if (!/backTo:/.test(line)) missing.push(p);
  }
  assert.deepEqual(missing, [], "这些路由没写 meta.backTo：" + missing.join(", "));
});

t("R3 backTo 指向的路径必须真实存在（不许指到一个已删除的页面）", () => {
  const all = new Set(routeLines.map((l) => (l.match(/path:\s*"([^"]+)"/) || [])[1]).filter(Boolean));
  const bad = [];
  for (const line of routeLines) {
    const to = (line.match(/backTo:\s*"([^"]+)"/) || [])[1];
    if (!to) continue;
    if (!all.has(to)) bad.push(`${(line.match(/name:\s*"([^"]+)"/) || [])[1]} → ${to}`);
  }
  assert.deepEqual(bad, [], "backTo 指向了不存在的路由：" + bad.join(", "));
});

t("R4 故事详情**不能**是 replace 型（轮495 反转：从哪进去就回哪，不能一律甩到发现页）", () => {
  const line = routeLines.find((l) => /name:\s*"storyDetail"/.test(l));
  assert.ok(line, "找不到 storyDetail 路由");
  assert.ok(!/backMode:\s*"replace"/.test(line), "storyDetail 又标成 replace 了 —— 会把从首页故事联进来的人甩到发现页");
  assert.match(line, /backTo:\s*"\/story"/, "storyDetail 的父页不是 /story（深链兜底要用）");
});

t("R6 其它故事子页（我的/排行榜/写作）不能标 replace 型", () => {
  for (const name of ["storyMine", "storyRank", "storyWrite"]) {
    const line = routeLines.find((l) => new RegExp('name:\\s*"' + name + '"').test(l));
    assert.ok(line, "找不到路由 " + name);
    assert.ok(!/backMode:\s*"replace"/.test(line), name + " 标了 replace，会覆盖历史回退");
  }
});

t("R5 每个 backTo 都必须以 / 开头（相对路径会让 router.replace 解析错）", () => {
  for (const line of routeLines) {
    const to = (line.match(/backTo:\s*"([^"]+)"/) || [])[1];
    if (!to) continue;
    assert.ok(to.startsWith("/"), `backTo 不是绝对路径：${to}`);
  }
});

/* ═══════════ ③ 接线 ═══════════ */

t("A1 返回键注册在 setup 顶层（不再挂在 onMounted 末尾，前面任何预热抛错都会跳过它）", () => {
  const iReg = app.indexOf('addListener("backButton"');
  const iMounted = app.indexOf("onMounted(async");
  assert.ok(iReg > 0, "App.vue 里找不到 backButton 注册");
  assert.ok(iMounted > 0, "找不到 onMounted");
  assert.ok(iReg < iMounted, "backButton 注册仍在 onMounted 里面/之后");
});

t("A2 决策走 planBack（不再用 ROOT_VIEWS 名字白名单决定要不要退出）", () => {
  assert.match(app, /createBackNav\(router/, "App.vue 没接 createBackNav");
  assert.ok(!/ROOT_VIEWS/.test(app), "App.vue 还留着 ROOT_VIEWS 白名单判断");
  assert.ok(!/CapApp\.minimizeApp\(\)/.test(app), "App.vue 里还自己调 minimizeApp（应交给 backNav）");
});

t("A3 拦截栈仍排在决策之前（浮层先关，再退页面）", () => {
  const seg = app.slice(app.indexOf('addListener("backButton"'), app.indexOf('addListener("backButton"') + 400);
  assert.match(seg, /if \(runBack\(\)\) return;/, "backButton 回调没先问 runBack()");
});

t("A4 首页退出的提示 UI 存在（模板 + 样式 + 2 秒自动收）", () => {
  assert.match(app, /v-if="backHint"/, "模板里没有 backHint 提示条");
  assert.match(app, /class="back-hint"/, "提示条没有 .back-hint 类");
  assert.match(css, /\.back-hint\s*\{/, "style.css 没有 .back-hint 样式");
  assert.match(css, /@keyframes back-hint-in/, "提示条没有入场动画");
  assert.match(app, /setTimeout\(\(\) => \{ backHint\.value = false; \}, 2000\)/, "提示不会自动消失");
});

t("A5 提示条不吃点击、且避开底栏安全区", () => {
  const rule = (css.match(/\.back-hint\s*\{[\s\S]*?\}/) || [""])[0];
  assert.match(rule, /pointer-events:\s*none/, "提示条会挡住下面的点击");
  assert.match(rule, /var\(--sab,/, "提示条没避开底部安全区");
  assert.match(rule, /position:\s*fixed/, "提示条不是 fixed（会被页面滚动带走）");
});

t("A6 五语种都有「再按一次退出」文案（缺 key 会显示成 pressAgain）", () => {
  assert.match(i18n, /pressAgain:\s*"[^"]+"/, "i18n.js 缺 pressAgain（en 或 zh）");
  assert.match(i18nEs, /"pressAgain":\s*"[^"]+"/, "西语缺 pressAgain");
  assert.match(i18nPt, /"pressAgain":\s*"[^"]+"/, "葡语缺 pressAgain");
  assert.match(i18nFr, /"pressAgain":\s*"[^"]+"/, "法语缺 pressAgain");
});

t("A7 决策模块自身不依赖 router / Capacitor（纯函数才能在 Node 里跑，也才测得住）", () => {
  const bp = read("src/utils/backPlan.js");
  assert.ok(!/from\s+"vue-router"/.test(bp), "backPlan.js 不该 import vue-router");
  assert.ok(!/@capacitor/.test(bp), "backPlan.js 不该 import Capacitor");
  assert.ok(!/window\./.test(bp), "backPlan.js 不该直接摸 window");
});

/* 轮495：故事系曾经的「自己再挂一个 backButton 监听、一律 replace 回 /story」必须彻底消失。
 * 双监听的后果是同一次按键被处理两遍，后到的 replace 覆盖先到的决策 —— 用户看到的就是
 * 「返回没反应 / 跑错页」，而且从代码上根本看不出是谁干的。 */
t("A8 页面自己不许再挂 backButton 监听（只有 App.vue 一处）", () => {
  const story = read("src/utils/storyBack.js");
  assert.ok(!/addListener\("backButton"/.test(story), "storyBack.js 又挂了一个返回键监听");
  assert.ok(!/@capacitor/.test(story), "storyBack.js 不该再依赖 Capacitor");
  const hits = [];
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/\.(vue|js)$/.test(f)) {
        const s = fs.readFileSync(p, "utf8");
        if (/addListener\("backButton"/.test(s) && !p.endsWith("App.vue")) hits.push(p);
      }
    }
  };
  walk(path.join(root, "src"));
  assert.equal(hits.length, 0, "这些文件也挂了 backButton 监听：" + hits.join(", "));
});

t("A9 页面内 ← 钮走 backOr（有上一页就回上一页，没有才回兜底页）", () => {
  const bn = read("src/utils/backNav.js");
  assert.match(bn, /export function backOr/, "backNav.js 没有 backOr");
  const story = read("src/utils/storyBack.js");
  assert.match(story, /backOr\(router,\s*to\)/, "storyBack 没走 backOr");
  const compose = read("src/views/ComposeView.vue");
  assert.match(compose, /backOr\(router,\s*"\/community"\)/, "发帖页返回没走 backOr");
  assert.ok(!/st\.back === "\/community"/.test(compose), "发帖页还留着写死的 st.back 判断");
});

t("A10 backOr 与决策表同源归一（/zh 别名、query 不会造成键对不上）", () => {
  const bn = read("src/utils/backNav.js");
  assert.match(bn, /normPath\(back\) !== cur/, "backOr 没用 normPath 比较，/?tab=story 会算成不同页");
});

console.log(out.join("\n"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
