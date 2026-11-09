/* 导航 / 交互响应护栏（Node 直跑：node tools/nav-response-test.mjs）
 * ------------------------------------------------------------
 * 轮 482。用户一次报了三件：
 *   ① 暖心墙评论：表情面板跟打字的上拉框高度不一致
 *   ② 手机浏览器上底部按钮点击不顺畅，老是点了没效果
 *   ③ 故事 → 今日 → 故事，直接回最前面
 *
 * ②③ 的根因都在「有没有人接这一枪」上，属于**静默失败**：代码不报错、
 * 测试也照过，只有人手指点上去才发现。所以这里专门钉住三件事：
 *
 *   · retapTab 信号必须有人兜底。原来只有 CommunityView 接，其余三个页签
 *     「点自己」= 发信号给空气，表现为完全没反应。
 *   · 页签不许用 v-model 绑只读 computed（Vant 写入会静默失败，状态源分叉）。
 *   · 首页切联不许无条件 scrollTo(0,0)（四个联共用 window 滚动，会把别的联的位置抹掉）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

let pass = 0;
let fail = 0;
const out = [];
function t(name, fn) {
  try {
    fn();
    pass++;
    out.push("ok   " + name);
  } catch (e) {
    fail++;
    out.push("FAIL " + name + " :: " + e.message);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const app = read("src/App.vue");
const tabbar = read("src/components/TabBar.vue");
const home = read("src/views/HomeView.vue");
const cv = read("src/views/CommunityView.vue");
const css = read("src/style.css");

/* ─── ② 再点当前页签：必须有人响应 ─── */
t("N1 App 级兜底：watch retap 信号（否则首页/消息/我的点自己完全没反应）", () => {
  assert(/retapSeq/.test(app) && /retapPath/.test(app), "App.vue 没引入 retapSeq / retapPath");
  assert(/watch\(\[retapSeq, retapPath\]/.test(app), "App.vue 没有监听 retap 信号 —— 只有自觉的页面才会响应");
});

t("N2 同路径 → 回顶；子路径（/messages/:id）→ 退回列表", () => {
  const i = app.indexOf("watch([retapSeq, retapPath]");
  assert(i > 0, "找不到 retap 监听");
  const seg = app.slice(i, i + 900);
  assert(/window\.scrollTo\(\{ top: 0/.test(seg), "同路径分支没有回顶");
  assert(/cur\.startsWith\(target \+ "\/"\)/.test(seg), "没有「在子路径时退回父页」的分支（在会话里点「消息」会没反应）");
  assert(/router\.push\(target\)/.test(seg), "子路径分支没有真的跳回列表页");
});

t("N3 页签不用 v-model 绑只读 computed（Vant 写入会静默失败）", () => {
  assert(!/v-model="activeIdx"/.test(tabbar), "又用 v-model 绑 activeIdx 了 —— 它是 computed（只读），Vant 写不进去");
  assert(/:model-value="activeIdx"/.test(tabbar), "没有改成单向 :model-value");
  assert(/const activeIdx = computed\(/.test(tabbar), "activeIdx 不再是 computed —— 说明口径又变了，重新核对");
});

t("N4 底栏吃掉触摸不参与滚动 + 不触发长按选字", () => {
  const m = css.match(/\.tabbar \{[^}]*\}/);
  assert(m, "找不到 .tabbar 规则");
  assert(/touch-action:\s*none/.test(m[0]),
    "底栏没有 touch-action:none —— 国产浏览器在惯性滚动时会把落在底栏的第一次点击当成「停住滚动」吞掉");
  const item = css.match(/\.tabbar \.van-tabbar-item \{[^}]*\}/);
  assert(item && /tap-highlight-color:\s*transparent/.test(item[0]), "tab 项没关系统灰块");
  assert(item && /user-select:\s*none/.test(item[0]), "tab 项没关长按选字（长按会进入选择态，抬手不派发 click）");
});

/* ─── ③ 每个联各自记滚动位置 ─── */
t("N5 首页切联：存当前联的 y，切回来恢复（不许无脑回顶）", () => {
  assert(/paneScroll\.set\(pane\.value, window\.scrollY\)/.test(home),
    "setPane 没保存当前联的滚动位置 —— 切走就把人家位置抹了");
  assert(/paneScroll\.get\(k\)/.test(home), "没读取目标联上次的位置");
  assert(!/if \(scroll\) window\.scrollTo\(0, 0\);/.test(home),
    "还在无条件回顶（正是「点今日再点故事回到最前面」的成因）");
});

t("N6 恢复必须在 track 高度落定之后（否则被短文档钳到 0）", () => {
  const i = home.indexOf("watch(idx, async");
  assert(i > 0, "找不到 watch(idx)");
  const seg = home.slice(i, i + 700);
  assert(/measure\(\)/.test(seg) && /restoreY/.test(seg), "watch(idx) 里没在 measure 之后恢复位置");
  assert(/requestAnimationFrame/.test(seg), "没有等下一帧再滚（track 刚换高，布局还没落定）");
});

/* ─── ②（轮 483）再点「暖心墙」页签时，关注流是子状态，必须先退出 ─── */
t("N9 关注流里点「暖心墙」页签 → 退出关注流（不是就地刷新关注流）", () => {
  const i = cv.indexOf("watch([retapSeq, retapPath]");
  assert(i > 0, "CommunityView 没接 retap 信号");
  const seg = cv.slice(i, i + 1600);
  const m = seg.match(/if \(followOnly\.value\)\s*\{([^}]*)\}/);
  assert(m, "没有「在关注流里点页签」的分支 —— 会掉到 manualRefresh，用户看到的是关注流被原地更新了一遍");
  assert(/exitFollowFeed\(\)/.test(m[1]), "分支里没调 exitFollowFeed（等于没退出关注流）");
  assert(/return/.test(m[1]), "分支没有 return —— 会继续往下 manualRefresh，先刷一遍关注流");
  const at = seg.indexOf(m[0]);
  const mr = seg.indexOf("manualRefresh()");
  assert(mr < 0 || at < mr, "关注流分支写在 manualRefresh 之后 —— 关注流已经被刷过一遍了");
});

t("N10 退出关注流要回顶（换数据源 = 从头看）", () => {
  const i = cv.indexOf("function exitFollowFeed()");
  assert(i > 0, "找不到 exitFollowFeed");
  const seg = cv.slice(i, i + 800);
  assert(/pinToTop\(\)/.test(seg), "exitFollowFeed 没回顶 —— 退出后列表换成全部流，视口还停在关注流的滚动深度");
});

/* ─── ① 表情面板与键盘同一把尺子（详见 emoji-panel-test E7/E8） ─── */
t("N7 面板高度 / 底条让位 / 会话段 三处都走 --kb-panel-h", () => {
  assert(/--kb-panel-h:\s*min\(var\(--kb-last/.test(css), ":root 没有 --kb-panel-h");
  const hits = css.match(/var\(--kb-panel-h\)/g) || [];
  assert(hits.length >= 2, `style.css 只找到 ${hits.length} 处 var(--kb-panel-h)，预期 2（网页端 + App 壳的底条让位）`);
  assert(/height:\s*var\(--kb-panel-h\)/.test(read("src/components/WpComposer.vue")),
    "评论表情面板高度没跟 --kb-panel-h（会和键盘高度对不上）");
  assert(/--wp-emoji-h:\s*var\(--kb-panel-h/.test(read("src/components/DmVacChat.vue")),
    "会话段 --wp-emoji-h 没跟同一个变量");
  assert(!/bottom:\s*min\(46vh, 320px\)/.test(css), "还有写死 min(46vh,320px) 的让位（会跟键盘高度对不上）");
});

t("N8 键盘高度要留一份「上一次」的残留值", () => {
  const kb = read("src/utils/keyboardInset.js");
  assert(/setProperty\("--kb-last"/.test(kb), "keyboardInset 没写 --kb-last");
  const i = kb.indexOf('setProperty("--kb-last"');
  const seg = kb.slice(Math.max(0, i - 400), i + 120);
  assert(/if \(px > 0\)/.test(seg), "--kb-last 没有「只在有效高度时写」的判断（键盘收起时会把自己清成 0，等于没记）");
});

console.log(out.join("\n"));
console.log(`\nnav-response-test: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
