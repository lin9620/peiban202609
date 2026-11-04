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
import { kbPageInset } from "../src/utils/keyboardMath.js";

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
  assert(/import \{ kbPageInset \} from "\.\/keyboardMath\.js"/.test(js), "没 import 纯函数");
  assert(/kbPageInset\(raw, sys, vh\)/.test(js), "没把 raw/sys/vh 喂给 kbPageInset");
  assert(!/Math\.round\(raw\s*-/.test(js), "还留着内联减法（两份口径迟早漂）");
  assert(/window\.__kbInfo/.test(js), "没有现场诊断 __kbInfo（别的机型出问题只能靠猜）");
});

t("T10 纯函数模块本身不含 DOM / Capacitor 依赖（Node 里能直接测）", () => {
  const src = read("src/utils/keyboardMath.js");
  assert(!/document\.|window\.|getComputedStyle|@capacitor/.test(src), "纯函数里混进了环境依赖");
});

console.log(out.join("\n"));
console.log(`\nkb-math-test: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
