/* 暖心墙「离场 ↔ 返回保持原样」回归测试（Node 直跑：node tools/wall-keep-test.mjs）
 * ------------------------------------------------------------
 * 用户报障（反复）：在暖心墙（/community）往下滚一段 → 点开某个帖子（/post/:id）
 * → 返回，列表回到页顶、浏览位置全丢。
 *
 * ⚠ 轮 224 真机实锤（CDP 取证，不是推断）——「离开时抓位置」这件事有个致命时序：
 *   KeepAlive 的 deactivate 是「**先把 DOM 移进 display:none 的隐藏容器，再回调
 *   onDeactivated**」。等 onDeactivated 跑起来时，scrollTop 已被浏览器归零。
 *   取证：容器滚到 1400 → onDeactivated 确实被调用（时间戳前进）却读到 0 →
 *   data-cv-dea 恒为 saved=0 → 回来永远在页顶。
 *   所以位置必须**在 DOM 还活着的时候**抓，两条路互为兜底：
 *     ① onScroll 滚动期实时记账（惯性滚动也跟得上）
 *     ② onBeforeRouteLeave 组件内守卫（导航确认前，DOM 仍在文档里）
 *
 * 另一半是「回来时钉回去」：手机端墙是**自滚容器**（wallScrollerEl: fixed +
 * overflowY:auto），window.scrollY 恒为 0 —— 位置只在容器上，window 上什么都没有。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

let pass = 0;
const fails = [];
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; return; }
  fails.push(name);
  console.log("FAIL  " + name + (extra ? "  → " + extra : ""));
};

/** 剥注释（整块换成同长空白保行号）：注释里提到 scrollTop / onUserMove 这类名字
 *  会把「代码里到底还有没有」判反 —— feed-perf-test 为此踩过两次。 */
const noComment = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
  .replace(/(^|[^:\w"'`])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));

/** 切「整个钩子体」：从 anchor 之后取到下一个顶层声明为止。
 *  固定字符数切分会把函数尾部的断言目标切出去（假失败，feed-perf-test 已记过教训）。 */
const STOPS = ["\nfunction ", "\nwatch(", "\nonMounted(", "\nonActivated(", "\nonDeactivated(", "\nonUnmounted(", "\nonBeforeRouteLeave(", "\n</script>"];
function block(src, anchor, stops = STOPS) {
  const i = src.indexOf(anchor);
  if (i < 0) return "";
  const from = i + anchor.length;
  const cuts = stops.map((s) => src.indexOf(s, from)).filter((v) => v > 0);
  return cuts.length ? src.slice(from, Math.min(...cuts)) : src.slice(from);
}

const app = read("src/App.vue");
const router = read("src/router.js");
const scrollMem = read("src/utils/scrollMem.js");
const cv = noComment(read("src/views/CommunityView.vue"));

/* ══════════ 保活名单与缓存身份 ══════════ */
ok("K1 暖心墙进 KeepAlive 名单，且 keep-alive 真的绑了它",
  /const keepAliveNames = \[[^\]]*"CommunityView"[^\]]*\]/.test(app)
    && /<keep-alive :include="keepAliveNames">/.test(app));

ok("K2 缓存 key 用 meta.grp / route.name：同组原地复用、跨组各自一份缓存",
  /:key="\(route\.meta && route\.meta\.grp\) \|\| route\.name \|\| route\.path"/.test(app));

/* ══════════ 滚动位置记忆（共享工具 + 路由回位） ══════════ */
ok("K3 scrollMem 是跨 chunk 单例（打包器会把轻模块内联成多份 → 模块级 Map 会各存一份）",
  /window\.__wpScrollMem/.test(scrollMem));

ok("K4 scrollMem 三件套齐全",
  /export function rememberScroll\(/.test(scrollMem)
    && /export function getScroll\(/.test(scrollMem)
    && /export function restoreScroll\(/.test(scrollMem));

ok("K5 路由 scrollBehavior 存在，且「同组原地切换不动滚动」",
  /scrollBehavior\(to, from, savedPosition\)/.test(router)
    && /=== from\.meta\.grp\) return false/.test(router));

/* ══════════ 手机端：墙自滚（window.scrollY 恒 0） ══════════ */
ok("K6 手机端墙是自滚容器（fixed + overflowY:auto）——位置只在容器上",
  /ref="wallScrollerEl"/.test(cv) && /overflowY: 'auto'/.test(cv) && /position: 'fixed'/.test(cv));

ok("K7 墙的滚动事件挂在容器自己身上（@scroll 在 wallScrollerEl 上）",
  /ref="wallScrollerEl"[\s\S]{0,400}?@scroll\.passive="onScroll"/.test(cv));

/* ══════════ 离开：抓位置（轮 224 实锤的时序） ══════════ */
const deact = block(cv, "onDeactivated(() => {");
const leave = block(cv, "onBeforeRouteLeave(() => {");

ok("K8 导航确认前抓位置（onBeforeRouteLeave —— 此刻 DOM 还在文档里）",
  /onBeforeRouteLeave\(/.test(cv) && /wallScrollTop = el\.scrollTop/.test(leave),
  "缺 onBeforeRouteLeave 抓取（只剩 onDeactivated 那条路 → 读到归零值）");

ok("K9 抓位置只采信「仍在文档内」的值（document.contains 校验）",
  /document\.contains\(el\)/.test(leave) && /document\.contains\(el\)/.test(deact),
  "没做 contains 校验 → 会用已被 KeepAlive 移走、scrollTop 归零的元素覆盖真位置");

ok("K10 滚动期实时记账（onScroll 里，滚的正是墙容器时）",
  /if \(el && e && e\.target === el\) wallScrollTop = el\.scrollTop;/.test(cv),
  "onScroll 没记账 → 惯性滚动后离开时取不到真值");

ok("K11 onDeactivated 不再直接读 scrollTop（防回退成 0）",
  !/wallScrollTop = wallScrollerEl\.value \? wallScrollerEl\.value\.scrollTop : 0;/.test(cv),
  "又改回在 onDeactivated 里读 —— 那里读到的是已被归零的值（用户实测「返回回页顶」）");

ok("K12 离开即置 feedRestoring（回来时先藏墙，滚到位再揭示）",
  /feedRestoring\.value = true;/.test(deact));

/* ══════════ 回来：回位 ══════════ */
const act = block(cv, "onActivated(() => {");
ok("K13 回来先恢复 window 位置（桌面端整页滚）", /restoreScroll\(route\.path\)/.test(act),
  "没调 restoreScroll");

ok("K14 回来把容器位置钉回去（手机端——位置只在容器上）",
  /wallScrollerEl\.value\.scrollTop = wallScrollTop/.test(act),
  "没把容器 scrollTop 钉回 → 手机端回页顶");

ok("K15 回位有多重保险：同步先钉 + nextTick 复钉 + 250ms 兜底（字体/图片会把上方内容顶开）",
  /const pin = \(\) =>/.test(act)
    && (act.match(/\bpin\(\);/g) || []).length >= 2
    && /nextTick\(\(\) => \{[\s\S]{0,90}?pin\(\);/.test(act)
    && /setTimeout\(\(\) => \{[\s\S]{0,90}?pin\(\);/.test(act));

/* 轮 233 起有多条揭示路径（pin 到位就立即亮 / nextTick / 250ms 兜底），要逐条检查：
   每条 feedRestoring=false 的前面都必须能看到 pin()（先钉住），且有 pinnedOk() 这套「读回确认」。
   这是「秒开」与「不闪」两条要求的共同前提 —— 少了它，揭示时画面可能还在页顶。 */
const reveals = [...act.matchAll(/feedRestoring\.value = false/g)].map((m) => m.index);
const everyGuarded = reveals.length > 0 && reveals.every((i) => /pin\(\);/.test(act.slice(Math.max(0, i - 420), i)));
ok("K16 每条揭示路径之前都已钉住位置（轮 233 起有多条路径）",
  everyGuarded && /const pinnedOk = \(\) =>/.test(act),
  `${reveals.length} 条揭示路径里存在没先 pin 的（揭示时画面还在页顶 → 用户看到「下滑」）`);

/* ══════════ 钩子引用的回调必须有定义（轮 223 真事故的防复发锁） ══════════
 * 判据：这些名字都出现在 addEventListener / rAF / onUnmounted 里；
 * 谁被删了，钩子就在那一行抛 ReferenceError 整段中断，回位代码静默失效。 */
for (const fn of ["feedTick", "onUserMove", "onScroll", "onViewport", "scheduleFeedTick", "mainBarDocClose"]) {
  ok(`K17 钩子引用的回调 ${fn} 在本文件有定义`,
    new RegExp(`function ${fn}\\(`).test(cv),
    "定义被删但引用还在 → ReferenceError 打断钩子（回位代码根本不执行）");
}

/* ══════════ 跨重启：存档也要带容器位置 ══════════ */
ok("K18 离场存档同时记 window 与容器两个位置",
  /y: window\.scrollY/.test(cv)
    && /pane: wallScrollerEl\.value \? wallScrollerEl\.value\.scrollTop : 0/.test(cv),
  "存档少了 pane（手机端重启后回页顶）");

ok("K19 恢复存档时也把容器位置钉回去（跨重启 / 刷新路径）",
  /wallScrollerEl\.value\.scrollTop = s\.pane/.test(cv),
  "restoreFeed 没恢复容器位置");

/* ══════════ 自检：用例注册在 process.exit 之前 ══════════ */
{
  const self = read("tools/wall-keep-test.mjs");
  const exitAt = self.indexOf("process.exit(");
  ok("K20 本文件所有用例都注册在 process.exit 之前（防新增用例被静默跳过）",
    exitAt > 0 && !/^ok\(/m.test(self.slice(exitAt)));
}

console.log(`\nTOTAL ${pass + fails.length}  PASS ${pass}  FAIL ${fails.length}`);
process.exit(fails.length ? 1 : 0);
