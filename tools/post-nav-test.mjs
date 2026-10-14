/* 帖子详情「上一条 / 下一条」列表上下文（轮 279）：utils/postNav.js 单测 + 入口接线守护
 * 跑法：node tools/post-nav-test.mjs */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
let pass = 0;
const fails = [];
const ok = (name, cond) => {
  if (cond) { pass++; return; }
  fails.push(name);
  console.log("FAIL  " + name);
};
const has = (src, ...needles) => needles.every((n) => src.includes(n));

const KEY = "warm-paws:postNav";
const nav = await import("../src/utils/postNav.js");
const { setPostNav, getPostNav, clearPostNav, navIdsFor, navTarget } = nav;

/* ── 1. 判据（内存态，不装 sessionStorage） ── */
clearPostNav();
ok("无上下文时 navIdsFor 返回空数组（= 详情页不启用滑动）", navIdsFor("a").length === 0);
ok("无上下文时 navTarget 返回 null", navTarget("a", 1) === null);

setPostNav([{ dbId: "p3" }, { dbId: "p2" }, { dbId: "p1" }]);
ok("setPostNav 后 navIdsFor 命中当前 id → 返回整张表",
  navIdsFor("p2").join(",") === "p3,p2,p1");
ok("navIdsFor 对不在表里的 id 返回空数组（收藏/通知这类无列表入口不启用）",
  navIdsFor("zzz").length === 0);
ok("表序即列表显示序，上一条 = 前一项", navTarget("p3", -1) === null
  && navTarget("p2", -1) === "p3");
ok("下一条 = 后一项", navTarget("p2", 1) === "p1" && navTarget("p1", 1) === null);
ok("到头返回 null（详情页据此回弹 + 提示，不会滑穿）",
  navTarget("p1", 1) === null && navTarget("p3", -1) === null);

/* 数字 dbId 也要能被 String(params.id) 命中（详情页 uid 恒为字符串） */
setPostNav([{ dbId: 11 }, { dbId: 22 }]);
ok("数字 dbId 也能被 String(params.id) 命中", navIdsFor("11").length === 2
  && navTarget("11", 1) === "22");

/* 脏数据不进表，也不能把表挤没 */
setPostNav([{ dbId: null }, { id: "a" }, { id: "a" }, null, "b", { dbId: "c" }]);
ok("去空 + 去重后只剩 a/b/c", navIdsFor("b").join(",") === "a,b,c");

/* 少于 2 条 = 没有上下一条 → 清掉，不留脏表 */
setPostNav([{ dbId: "solo" }]);
ok("只有 1 条时清空（存了也是空转）", getPostNav() === null
  && navIdsFor("solo").length === 0);
setPostNav("不是数组");
ok("传非法值同样清空而不是崩", getPostNav() === null);

/* ── 2. sessionStorage：落盘 / 刷新恢复 / 隐私模式降级 ── */
const store = new Map();
globalThis.sessionStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

clearPostNav();
setPostNav([{ dbId: "x1" }, { dbId: "x2" }]);
ok("跳转时写入 sessionStorage（同设备刷新/分享链接打开后还能接着滑）", store.size === 1);
ok("落盘格式 = {ids:[...]} JSON", JSON.parse(store.get(KEY)).ids.join(",") === "x1,x2");

/* 模拟「刷新页面」：内存被清空，只剩上一次留下的存储 → getPostNav 应从存储恢复 */
clearPostNav();
store.set(KEY, JSON.stringify({ ids: ["r1", "r2", "r3"], ts: 1 }));
const restored = getPostNav();
ok("内存为空时 getPostNav 从 sessionStorage 恢复整张表",
  restored && restored.ids.join(",") === "r1,r2,r3");
ok("恢复后 navTarget 照常工作", navTarget("r1", 1) === "r2");

/* 存储里是脏数据（半截 JSON / 结构不对）→ 当没有，不能崩 */
clearPostNav();
store.set(KEY, "{ids:[oops");
ok("半截 JSON 当没有，不外抛", getPostNav() === null);
clearPostNav();
store.set(KEY, JSON.stringify({ ids: [] }));
ok("空表当没有", getPostNav() === null);
clearPostNav();

/* 隐私模式 / 配额满：存储全程抛异常 → 降级为纯内存，功能不崩 */
globalThis.sessionStorage = {
  getItem() { throw new Error("SecurityError"); },
  setItem() { throw new Error("QuotaExceededError"); },
  removeItem() { throw new Error("SecurityError"); },
};
let threw = false;
try { clearPostNav(); setPostNav([{ dbId: "s1" }, { dbId: "s2" }]); }
catch (e) { threw = true; }
ok("存储全抛异常时 setPostNav 不外抛（降级为纯内存）", !threw);
ok("存储全抛异常时仍能算出上下条", navTarget("s1", 1) === "s2");
delete globalThis.sessionStorage;
clearPostNav();

/* ── 3. 接线：四个入口都在跳转前存表 ── */
const community = read("src/views/CommunityView.vue");
const myPosts = read("src/views/MyPostsView.vue");
const waller = read("src/views/WallerView.vue");
const profile = read("src/views/ProfileView.vue");
const detail = read("src/views/PostDetailView.vue");

ok("暖心墙 goDetail 跳转前 setPostNav(shown)",
  has(community, "setPostNav(shown.value)")
  && community.indexOf("setPostNav(shown.value)")
    < community.indexOf('name: "postDetail", params: { id: p.dbId }'));
ok("我的帖子 openWall 跳转前 setPostNav(rows)，且空 dbId 早退",
  has(myPosts, "setPostNav(rows.value)", "if (p.dbId == null) return;"));
ok("他人主页 goDetail 跳转前 setPostNav(posts)",
  has(waller, "setPostNav(posts.value)")
  && waller.indexOf("setPostNav(posts.value)")
    < waller.indexOf('name: "postDetail", params: { id: p.dbId }'));
ok("我的主页帖子卡 router-link 上 setPostNav(myPosts)（不改写成 push，导航仍由 vue-router 走）",
  has(profile, '@click="setPostNav(myPosts)"', "'/post/' + p.dbId"));
ok("四个入口都 import 了 setPostNav",
  [community, myPosts, waller, profile].every((s) => has(s, 'from "../utils/postNav.js"')));

/* ── 4. 接线：详情页手势 ── */
ok("PostDetailView 引入判据 navIdsFor/navTarget + 复用 panes 的 swipeDir",
  has(detail, "navIdsFor", "navTarget", 'from "../utils/panes.js"', "swipeDir"));
ok("两端差异只在「挂哪些监听」：触摸先挂，App 端不挂鼠标键盘",
  has(detail, 'window.addEventListener("touchstart"', 'window.addEventListener("mousedown"',
    'window.addEventListener("keydown"', "if (!isApp)")
  && detail.indexOf('window.addEventListener("touchstart"')
    < detail.indexOf("if (!isApp)"));
ok("跟手 + 过半才切 + 边界阻尼三件套齐备（用户拍板的手感）",
  has(detail, "const TURN_RATIO = 0.5", "const EDGE_DAMP = 0.32",
    'dragPhase.value = "drag"', "dampX(dx)"));
ok("切换用 router.replace（滑 10 次返回仍是一步回列表）而非 push",
  has(detail, 'router.replace({ name: "postDetail", params: { id: next } })')
  && !/router\.push\(\{\s*\n?\s*name: "postDetail", params: \{ id: next \}/.test(detail));
ok("到头提示走 i18n 成对键 nav.prevEnd / nav.nextEnd",
  has(detail, 't("nav.nextEnd")', 't("nav.prevEnd")'));
ok("touch-action: pan-y + 滑出过渡就位（横向交给 JS、纵向留给浏览器）",
  has(detail, "touch-action: pan-y;", ".pd-swipe.out { transition: transform"));
ok("方向键在输入框内不翻页（光标移动归输入框）",
  has(detail, "ArrowLeft", "ArrowRight") && /closest\('input, textarea/.test(detail));

/* ── 5. fixed 陷阱：位移层绝不能包住 cmt-main-bar / ReportDialog ──
 * position:fixed 进了带 transform 的祖先会被劫持包含块 —— style.css 2392 行记着同一坑，
 * 轮 238 / 175 / 151 各踩过一次。这里把「谁在 pd-swipe 里」钉死。 */
const swOpen = detail.indexOf('class="pd-swipe"');
const swClose = detail.indexOf("/.pd-swipe 轮 279");
const barAt = detail.indexOf('class="cmt-main-bar"');
const repAt = detail.indexOf("<ReportDialog");
ok("pd-swipe 开闭标签成对且都在模板内", swOpen > 0 && swClose > swOpen);
ok("pd-swipe 只包内容区（返回头在里头）",
  swOpen < detail.indexOf('class="pd-head"')
  && detail.indexOf('class="pd-head"') < swClose);
ok("手机端底部输入条 cmt-main-bar 在 pd-swipe **之外**（否则 fixed 被 transform 劫持）",
  barAt > swClose);
ok("举报弹窗在 pd-swipe **之外**", repAt > swClose);

console.log(`post-nav-test: ${pass} pass, ${fails.length} fail`);
for (const f of fails) console.log("FAIL  " + f);
if (fails.length) process.exit(1);
