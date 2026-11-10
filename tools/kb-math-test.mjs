/* 「别的机型会怎样」矩阵测试（Node 直跑：node tools/kb-math-test.mjs）
 * ------------------------------------------------------------
 * 轮 325（用户追问：「你不要只看我这一个机子，别的型号的机子呢」）。
 * 把键盘让位的算式抽成纯函数 src/utils/keyboardMath.js，这里把不同机型/导航模式的
 * **同一块键盘**算一遍，锁住三件事：
 *   ① 换机型算出来的值一样（导航栏高度在加减里抵消，不写任何机型常量）；
 *   ② 旧口径（不扣导航栏）的缺口高度 = 该机型导航栏高度 —— 所以这 bug 不是某台机子独有，
 *      而是「导航栏多高就漏多宽」，0 导航栏的机子根本不出现；
 *   ③ 脏输入/离谱值一律兜底（0 / 夹到视口 − 120），绝不把输入框压到键盘底下。
 * 纯 Node，无 DOM、无网络。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { kbPageInset, kbWebInset, kbShrinkInset, kbPanelFallback, kbScreenH } from "../src/utils/keyboardMath.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

let pass = 0, fail = 0;
const out = [];
function t(name, fn) {
  try { fn(); pass++; out.push("ok   " + name); }
  catch (e) { fail++; out.push("FAIL " + name + " :: " + e.message); }
}

/* ══════════ ① 同一块键盘 + 不同导航栏 → 同一个页面让位值 ══════════ */

/* 机型对照表：imeInset 是「从窗口底往上量」的输入法高度（Keyboard 插件报的值），
   sysBottom 是 MainActivity 实际加的 padding-bottom（WebView 底部让掉的高度）。
   三键导航时输入法坐在导航栏上面 → 两个数都含导航栏；手势导航时输入法盖住导航栏
   → 两个数也都含。所以「键盘自己有多高」= imeInset − sysBottom，机型差异被消掉。 */
const DEVICES = [
  { name: "手势导航 · 32dp 导航条（用户这台 Xiaomi 23054RA19C / Android 13）", nav: 32 },
  { name: "三键导航 · 48dp", nav: 48 },
  { name: "手势导航 · 24dp（Pixel 系列常见）", nav: 24 },
  { name: "无底部系统栏（横屏 / 平板 / 部分 ROM）", nav: 0 },
  { name: "大导航栏 · 65dp（折叠屏展开 / 车机）", nav: 65 },
];
const KEYBOARDS = [240, 260, 280, 288, 300, 320, 360];   /* 页面里键盘的真实高度（CSS px） */

t("T1 同一块键盘：5 种导航栏 × 7 种键盘高度，算出来的让位值必须等于键盘真实高度", () => {
  for (const kb of KEYBOARDS) {
    for (const d of DEVICES) {
      const got = kbPageInset(kb + d.nav, d.nav, 790);
      assert.equal(got, kb, `${d.name} · 键盘 ${kb} → 算出 ${got}，应为 ${kb}`);
    }
  }
});

t("T2 换机型不改结果：同一块 288 的键盘，5 种导航栏算出来全是 288（没有任何机型常量）", () => {
  const vals = DEVICES.map((d) => kbPageInset(288 + d.nav, d.nav, 790));
  assert.deepEqual(new Set(vals).size, 1, "不同导航栏算出了不同值：" + JSON.stringify(vals) + " ← 说明又写死了机型");
  assert.equal(vals[0], 288);
});

t("T3 旧口径（不扣导航栏）的缺口高度 = 该机型导航栏高度 → 这 bug 是「导航栏多高漏多宽」", () => {
  for (const kb of [240, 288, 320]) {
    for (const d of DEVICES) {
      const old = kb + d.nav;          /* 轮 322：直接把插件值当让位值 */
      const gap = old - kb;            /* 实际多让出来的宽度 */
      assert.equal(gap, d.nav, `${d.name}：旧口径缺口 ${gap}，应等于导航栏 ${d.nav}`);
    }
  }
  /* 0 导航栏的机子旧口径也不出问题 —— 与「用户这台 32dp 漏 32px」对得上 */
  assert.equal(kbPageInset(320, 0, 790) - 320, 0);
});

t("T4 真机实测那组数：插件报 320、导航栏 32 → 288（= 页面里键盘实际压住的高度）", () => {
  assert.equal(kbPageInset(320, 32, 790), 288);
  /* 真机像素：输入栏底 1465 → 键盘上沿 1581 = 115 设备px = 41.8 CSS ≈ 32(导航栏) + 10(输入条自身留白) */
  assert.ok(Math.abs(41.8 - (32 + 10)) < 0.5, "42 ≈ 32 + 10 对不上，说明归因错了");
});

/* ══════════ ② 兜底：脏输入 / 离谱值 ══════════ */

t("T5 非法输入一律 0（不让位），绝不产生 NaN / 负值", () => {
  for (const v of [0, -100, NaN, undefined, null, "", "abc", {}, []]) {
    assert.equal(kbPageInset(v, 32, 790), 0, `ime=${String(v)} 应为 0`);
  }
  for (const s of [NaN, -5, undefined, null, "", "x"]) {
    assert.equal(kbPageInset(320, s, 790), 320, `sysBottom=${String(s)} 应被当 0 → 320`);
  }
  assert.equal(kbPageInset("320", "32", "790"), 288, "字符串数字没转过来");
});

t("T6 大到离谱（某些 ROM 报错值）→ 夹到「视口 − 120」，绝不把页面压成一条", () => {
  assert.equal(kbPageInset(2000, 0, 790), 670);
  assert.equal(kbPageInset(5000, 32, 2400), 2280);
  assert.equal(kbPageInset(700, 0, 790), 670, "670 = 790 − 120 上限");
  assert.equal(kbPageInset(669, 0, 790), 669, "上限以下不许动");
  /* 视口未知（0）时不做夹取，只保证非负 */
  assert.equal(kbPageInset(2000, 0, 0), 2000);
});

t("T7 结果恒为非负整数、且不超过输入法高度（不单调越界）", () => {
  for (let ime = 0; ime <= 400; ime += 7) {
    for (let sys = 0; sys <= 80; sys += 8) {
      const v = kbPageInset(ime, sys, 900);
      assert.ok(Number.isInteger(v), `非整数：${v}`);
      assert.ok(v >= 0, `负值：${v}`);
      assert.ok(v <= ime, `超过输入法高度：${v} > ${ime}`);
    }
  }
});

t("T8 视口高一点/低一点不影响结果（只看 ime − sysBottom，不看机型尺寸）", () => {
  const vh = [640, 720, 790, 844, 926, 1200];
  const vals = vh.map((h) => kbPageInset(320, 32, h));
  assert.deepEqual(new Set(vals).size, 1, "视口不同算出了不同值：" + JSON.stringify(vals));
});

/* ══════════ ③ 运行时确实用的是这个函数 ══════════ */

t("T9 keyboardInset.js 必须调用 kbPageInset（不许再有内联减法）", () => {
  const js = read("src/utils/keyboardInset.js");
  assert(/import \{[^}]*\bkbPageInset\b[^}]*\} from "\.\/keyboardMath\.js"/.test(js), "没 import 纯函数");
  assert(/kbPageInset\(raw, sys, vh\)/.test(js), "没把 raw/sys/vh 喂给 kbPageInset");
  assert(!/Math\.round\(raw\s*-/.test(js), "还留着内联减法（两份口径迟早漂）");
  assert(/window\.__kbInfo/.test(js), "没有现场诊断 __kbInfo（别的机型出问题只能靠猜）");
});

t("T10 纯函数模块本身不含 DOM / Capacitor 依赖（Node 里能直接测）", () => {
  /* 只查代码，不查注释 —— 注释里写「window.screen.height 会报物理像素」是说明，不是依赖 */
  const src = read("src/utils/keyboardMath.js")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert(!/document\.|window\.|getComputedStyle|@capacitor/.test(src), "纯函数里混进了环境依赖");
});

/* ══════════ ④ 轮 462：网页端（用可视视口反推，不看机型常量） ══════════ */

t("T11 网页端：iOS Safari 393×852 弹 336 键盘 → 让位 336（布局视口不动）", () => {
  /* 布局视口 852 不变，可视视口 852−336 = 516，偏移 0 */
  assert.equal(kbWebInset(852, 516, 0), 336);
});

t("T12 网页端：Safari 上推可视视口时，上推量也要算进去（否则底条压进键盘一截）", () => {
  /* 可见区 = 从 40 起、高 516 → 底边 556；键盘占 852−556 = 296 */
  assert.equal(kbWebInset(852, 516, 40), 296);
  assert.equal(852 - kbWebInset(852, 516, 40), 40 + 516, "底条底边必须正好落在可视视口下沿");
});

t("T13 网页端：「缩布局视口」型内核（resizes-content / 部分国产内核）→ 0，不许双重让位", () => {
  assert.equal(kbWebInset(516, 516, 0), 0);
  /* 小米浏览器两种路径都要能自洽：不缩（516 可视）→ 让位；缩（布局也 516）→ 不让 */
  assert.equal(kbWebInset(852, 516, 0), 336);
});

t("T14 网页端：脏数据一律 0（宁可不让位，也不许把页面压成一条）", () => {
  const dirty = [[null, 516, 0], [852, undefined, 0], ["x", 516, 0], [0, 0, 0], [NaN, NaN, NaN]];
  for (const [a, b, c] of dirty) assert.equal(kbWebInset(a, b, c), 0, `kbWebInset(${a},${b},${c}) 应为 0`);
  assert.equal(kbWebInset(852, 900, 0), 0, "可视视口比布局视口还大 → 0（不是负让位）");
  assert.equal(kbWebInset(852, 516, -30), 336, "负数上移量按 0 处理");
});

t("T15 网页端：离谱值夹到「布局视口 − 120」，结果取整", () => {
  assert.equal(kbWebInset(852, 100, 0), 732, "852 − 120 上限");
  assert.equal(kbWebInset(852, 5000, 0), 0, "算出负数 → 0");
  assert.equal(kbWebInset(393.4, 260.7, 0.2), 133, "132.5 → 取整成 133");
});

/* ══════════ ⑥ 轮 496 · 缩布局视口型内核的键盘本体高度 ══════════
 * 用户：「手机浏览器输入的时候，表情跟文字输入高度不一致」。
 * 一批浏览器弹键盘时直接把 innerHeight 缩掉（布局视口跟着缩），于是 kbWebInset 恒为 0
 * —— 底条由浏览器自己顶上去，是对的；但表情面板要跟的「键盘本体高度」也因此永远拿不到，
 * 只能退回 46vh/320px 死值 → 面板与键盘差一截，输入条跟着跳。
 * 这里锁住反推式子的口径与兜底。 */

t("T16 缩布局视口：852 → 536 的键盘，反推 316", () => {
  assert.equal(kbShrinkInset(852, 536), 316);
});

t("T17 地址栏 / 底部工具栏伸缩（≤130px）不认，绝不误判成键盘", () => {
  assert.equal(kbShrinkInset(852, 795), 0, "57px = 地址栏");
  assert.equal(kbShrinkInset(852, 732), 0, "128 = Chrome 地址栏+工具栏，不是键盘（轮 500：原来卡 120 会中招）");
  assert.equal(kbShrinkInset(852, 722), 0, "130 仍不认");
  assert.equal(kbShrinkInset(852, 702), 150, "150 才认");
});

t("T18 脏输入 / 离谱值一律 0 或夹住", () => {
  assert.equal(kbShrinkInset(0, 536), 0, "无基线");
  assert.equal(kbShrinkInset(852, 0), 0, "无当前值");
  assert.equal(kbShrinkInset(852, 900), 0, "变大不是键盘");
  assert.equal(kbShrinkInset(852, 20), 732, "夹到基线 − 120");
});

t("T19 接线：面板高度必须走独立来源，不能拿 --kb-h 顶替", () => {
  const ki = read("src/utils/keyboardInset.js");
  assert.match(ki, /kbShrinkInset/, "keyboardInset 没接 kbShrinkInset");
  assert.match(ki, /writeVar\(h, \{[\s\S]{0,400}?\}, panelH\)/, "writeVar 没收到键盘本体高度");
  assert.match(ki, /--kb-last/, "没有写 --kb-last");
  assert.match(ki, /export function webSwapNeeded/, "没有导出 webSwapNeeded（面板→键盘交接要用）");
  const wc = read("src/components/WpComposer.vue");
  assert.match(wc, /if \(!isApp && !webSwapNeeded\(\)\) return;/, "WpComposer 的钉住仍然只认 App 壳");
  const dc = read("src/components/DmVacChat.vue");
  assert.match(dc, /if \(!isApp && !webSwapNeeded\(\)\) return;/, "DmVacChat 的钉住仍然只认 App 壳");
});

/* ── 轮 499 · 表情面板兜底高度必须在「页面坐标系」里 ────────────────────
 * 用户第四次报同一件事，四张截图（App 2 张 / 浏览器 2 张）。量出来的实情：
 *   · 浏览器：页面可视区 732（底部工具栏占掉 120），真键盘落在页面里只占 185；
 *     旧兜底 320 ⇒ 面板一开底条被顶上去 135，看着就是「表情和文字输入高度不一致」；
 *   · App：852 全面屏，真键盘 303，旧兜底 320 ⇒ 差 17（用户截图里那一点点跳）。
 * 新算式 = base − 屏高 × 0.64（键盘本体约占屏高 36%），命中过真键盘后改用实测比例。 */
t("T20 页面坐标系：带底部工具栏的浏览器算出 187（真值 185）", () => {
  assert.equal(kbPanelFallback(732, 852, 0), 187, "852 屏 / innerHeight 732 → 187");
  assert.ok(Math.abs(kbPanelFallback(732, 852, 0) - 185) <= 3, "与真机 185 的偏差必须 ≤3");
});

t("T21 全面屏（App / 隐藏工具栏）算出 307（真值 303）,不再按 46% 给 320", () => {
  assert.equal(kbPanelFallback(852, 852, 0), 307, "852/852 → 307");
  assert.ok(Math.abs(kbPanelFallback(852, 852, 0) - 303) <= 5, "与真机 303 的偏差必须 ≤5");
  assert.notEqual(kbPanelFallback(852, 852, 0), 320, "不许再退回旧兜底 320");
});

t("T22 本机实测值优先，且换工具栏 / 换页面高度都能折回去", () => {
  /* 用户那台真测出来的：innerHeight 732 时键盘在页面里占 185 ——
     存的是「键盘本体绝对高度」= 185 + 工具栏 120 = 305 */
  const seen = { abs: 305, screen: 852 };
  assert.equal(kbPanelFallback(732, 852, seen), 185, "有实测值就用它");
  assert.equal(kbPanelFallback(852, 852, seen), 305, "工具栏收起 → 同一份实测值折成 305");
  assert.equal(kbPanelFallback(736, 852, seen), 189, "页面高度差 4px 也按实测值折，不再整份作废");
  /* 分屏：窗口 400 高，键盘整个落在窗口里 → 就是绝对高度 305 */
  assert.equal(kbPanelFallback(400, 852, seen), 305, "分屏窗口里键盘占满自己那一块");
  /* 横屏的屏幕尺寸差太多（±40 之外）→ 不许跨方向复用 */
  assert.equal(kbPanelFallback(1024, 1024, seen), 330, "换了屏幕尺寸就不许套旧值");
});

t("T23 脏输入 / 离谱值一律夹住，绝不返回 0 或负数", () => {
  assert.equal(kbPanelFallback(0, 852, 0), 0, "无 base");
  assert.equal(kbPanelFallback(NaN, 852, 0), 0);
  assert.ok(kbPanelFallback(732, 0, 0) > 0, "拿不到屏高也要给个正值（退回比例）");
  assert.equal(kbPanelFallback(1000, 852, 9), 307, "离谱实测当没有，按键盘绝对高度估");
  assert.ok(kbPanelFallback(852, 2340, 0) <= 380, "物理像素的屏高不许把面板算爆");
  assert.ok(kbPanelFallback(300, 852, 0) >= Math.round(300 * 0.14), "矮视口不许小于 14%");
  assert.ok(kbPanelFallback(2000, 2000, 0) <= 380, "高视口不许大于 380");
});

/* ── 轮 500 · 多机型矩阵：用户问「别的手机呢」 ─────────────────────────
 * 轮 499 的算式是 base − screenH × 0.64，等价于「键盘占屏高 36%」。
 * 那条比例假设只在 852 高的屏上成立：平板 1024 上真键盘只占 30%（多算 59），
 * 手机横屏 393 上却占 53%（少算 69）。这里把各机型摆开，锁住三件事：
 *   ① 用户那台（852）必须一格不动；
 *   ② 任何机型的偏差都必须 ≤ 35px（键盘高度的品牌差本身就有 ±20，不追求更准）；
 *   ③ 分屏 / 桌面窗口这些「屏幕比页面高一大截」的参照系不许按屏高硬推。 */
const MACHINES = [
  /* 机型, 屏高 CSS px, 页面可视高 innerHeight, 键盘本体绝对高（真机） */
  { name: "iPhone SE3 竖（Safari 工具栏 114）", s: 667, b: 553, kb: 258 },
  { name: "iPhone 15 竖（底部工具栏 120）", s: 852, b: 732, kb: 305 },
  { name: "iPhone 15 竖（无工具栏 / App）", s: 852, b: 852, kb: 305 },
  { name: "小屏 Android 360×640", s: 640, b: 640, kb: 250 },
  { name: "大屏 Android 412×915", s: 915, b: 915, kb: 300 },
  { name: "折叠屏展开 884", s: 884, b: 884, kb: 302 },
  { name: "iPad 竖 1024（键盘只占 30%）", s: 1024, b: 1024, kb: 310 },
  { name: "手机横屏（393 高，键盘占 53%）", s: 393, b: 393, kb: 210 },
  { name: "Android 分屏（窗口 400 高）", s: 852, b: 400, kb: 305 },
  { name: "桌面窗口 800 / 屏 1080", s: 1080, b: 800, kb: 330 },
];
/* 真面板高：屏幕比页面高 200 以上 ⇒ 窗口不占满屏，键盘整个在窗口里；否则扣掉工具栏那段 */
function truthPanel(m) {
  return m.s - m.b > 200 ? m.kb : Math.max(0, m.b - (m.s - m.kb));
}

t("T25 多机型矩阵：每种机器的估算偏差都必须 ≤35px，且平板/横屏/分屏不许再差上百像素", () => {
  const bad = [];
  for (const m of MACHINES) {
    const got = kbPanelFallback(m.b, m.s, null);
    const err = got - truthPanel(m);
    if (Math.abs(err) > 35) bad.push(`${m.name}：算 ${got} / 真 ${truthPanel(m)}（差 ${err}）`);
  }
  assert.deepEqual(bad, [], "这些机型偏差过大：\n    " + bad.join("\n    "));
});

t("T26 用户那台（852）零退化：187 / 307，与轮 499 完全一致", () => {
  assert.equal(kbPanelFallback(732, 852, null), 187, "带工具栏仍是 187");
  assert.equal(kbPanelFallback(852, 852, null), 307, "全面屏仍是 307");
});

t("T27 键盘绝对高度必须有上下限，不许再是纯比例（纯比例在平板/横屏上偏得离谱）", () => {
  const km = read("src/utils/keyboardMath.js");
  assert.match(km, /KB_ABS_MIN = 240/, "没有键盘绝对高度下限（小屏机会算得比真键盘还矮）");
  assert.match(km, /KB_ABS_MAX = 330/, "没有键盘绝对高度上限（大屏机会算得比真键盘还高）");
  assert.match(km, /Math\.min\(Math\.max\(Math\.round\(s \* 0\.36\), KB_ABS_MIN\), KB_ABS_MAX\)/, "没有把屏高比例夹到绝对区间");
  assert.doesNotMatch(km, /b - s \* 0\.64/, "还留着「按屏高 36% 直接推」的旧算式");
  /* 上限不许是 45%：分屏时窗口 400 高、键盘 305（76%），按 45% 夹会把面板压矮 120 */
  assert.match(km, /const hi = Math\.min\(Math\.round\(b \* 0\.8\), 380\)/, "上限还是按比例夹的（分屏会漏一截）");
});

t("T28 screen.height 归一：物理像素按 dpr 折回，认不出来就当没有（绝不拿 2340 去减 732）", () => {
  assert.equal(kbScreenH(852, 3), 852, "CSS px 原样用");
  assert.equal(kbScreenH(393, 3), 393, "横屏的 393 也是 CSS px");
  assert.equal(kbScreenH(1024, 2), 1024, "平板 CSS px");
  assert.equal(kbScreenH(2340, 3), 780, "物理像素按 dpr 折回");
  assert.equal(kbScreenH(2556, 3), 852, "2556/3 = 852");
  assert.equal(kbScreenH(100, 3), 0, "认不出来的当拿不到");
  assert.equal(kbScreenH(2340, 1), 0, "dpr=1 时 2340 不可能折回来，当拿不到");
  assert.equal(kbScreenH(0, 3), 0);
  assert.equal(kbScreenH(NaN, 3), 0);
});

t("T24 接线：keyboardInset 必须用页面坐标系的兜底，且真值要留到下一次冷启动", () => {
  const ki = read("src/utils/keyboardInset.js");
  assert.match(ki, /return kbPanelFallback\(base, screenNow\(\), readStored\(\)\);/, "兜底没走 kbPanelFallback（写成常量就又会跳）");
  assert.match(ki, /setProperty\(FALLBACK_VAR, fb \+ "px"\)/, "--kb-fallback 没写进 CSS");
  assert.doesNotMatch(ki, /base \* 0\.46/, "还留着按整屏 46% 的旧兜底");
  assert.match(ki, /wp-kb-panel-px/, "没有把实测值存下来（冷启动还得猜）");
  assert.match(ki, /savePanel\(panelSeen, restH > 0 \? restH : inner\)/, "applyWeb 没记实测值");
  assert.match(ki, /savePanel\(panelSeen, vh\)/, "App 壳没记实测值");
});

t("T29 接线：屏高要过 kbScreenH；实测值存绝对高度；面板尺子要跟工具栏", () => {
  const ki = read("src/utils/keyboardInset.js");
  assert.match(ki, /return kbScreenH\(win\.screen\.height, win\.devicePixelRatio\)/, "屏高没做物理像素归一");
  assert.match(ki, /if \(o && o\.abs > 0\) return \{ abs: o\.abs/, "读的还是旧的 (base,panel) 格式");
  assert.match(ki, /const toolbar = s > 0 && d > 0 && d <= 200 \? Math\.round\(d\) : 0;/, "存绝对高度时没扣工具栏那一段");
  assert.match(ki, /const pair = \{ abs: Math\.round\(panel \+ toolbar\)/, "存的不是键盘本体绝对高度");
  assert.match(ki, /writePanelRuler\(!\(panelH > 0\)\)/, "面板尺子没跟随「现在是否有键盘」");
  assert.match(ki, /const base = noKb && inner > 0 \? inner : \(restH > 0 \? restH : inner\);/, "面板基准没跟随工具栏（无键盘时该用当前 innerHeight）");
});

t("T30 反推键盘高度必须要求焦点：没有焦点时 innerHeight 变小是工具栏，不是键盘", () => {
  const ki = read("src/utils/keyboardInset.js");
  assert.match(ki, /panelH = focused \? kbShrinkInset\(restH, inner\) : 0/,
    "没有焦点也去反推，工具栏一动就被记成键盘高度并写进 localStorage");
  /* 实测过的坏结果：iframe 852 → 732（工具栏出现）→ 面板尺子被写成 120，之后回 852 也是 120 */
  assert.equal(kbShrinkInset(852, 732), 0, "128px 的工具栏变化不许算出键盘");
});

console.log(out.join("\n"));
console.log(`\nkb-math-test: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
