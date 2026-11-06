/* 模板作用域检查：模板里调用的函数必须在 script setup 顶层声明
 *   node tools/template-scope-test.mjs
 *
 * 由来（轮 439 实际踩到）：为了省事把
 *     function onPrefToggle(v) { ... }
 * 写进了 `const langName = computed(() => { ... })` 的内部，
 * 然后模板里 `@update:model-value="onPrefToggle"`。构建、类型、静态扫描全都不报错，
 * 因为模板里的标识符是运行时才解析的 —— 真机上点一下开关就是
 * "onPrefToggle is not defined"，整个设置页崩掉。
 *
 * 判定口径（只抓这一类，不去做完整的模板语义分析以免误报）：
 *   在 script setup 里**缩进声明**（= 嵌在别的函数/回调里）的函数名，
 *   只要在 template 里出现过，就是模板取不到 → FAIL。
 * 顶层声明（列首无缩进）、import 进来的、v-for 别名都不在检查范围。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(root, "src");

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => {
  if (c) { pass++; console.log("PASS  " + n + (extra ? "  " + extra : "")); }
  else { fail++; console.log("FAIL  " + n + (extra ? "  " + extra : "")); }
};

const walk = (dir, acc = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith(".vue")) acc.push(p);
  }
  return acc;
};

/** 去掉注释，避免把注释里的示例代码当成声明 */
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const files = walk(SRC);
let scanned = 0, nestedTotal = 0;
const problems = [];

for (const f of files) {
  const raw = fs.readFileSync(f, "utf8");
  const tplM = raw.match(/<template>([\s\S]*)<\/template>/);
  const scrM = raw.match(/<script setup[^>]*>([\s\S]*?)<\/script>/);
  if (!tplM || !scrM) continue;               /* 非 script setup 组件不在此检查范围 */
  scanned++;
  const tpl = tplM[1];
  const scr = stripComments(scrM[1]);

  /* 缩进声明的函数 = 嵌在另一个函数体里（列首无缩进的才是 setup 顶层） */
  const nested = [...scr.matchAll(/^[ \t]+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1]);
  nestedTotal += nested.length;
  for (const name of new Set(nested)) {
    /* 模板里以标识符形式出现（插值、事件绑定、属性绑定都算） */
    const re = new RegExp("(?<![\\w$.])" + name.replace(/\$/g, "\\$") + "(?![\\w$])");
    if (re.test(tpl)) problems.push(`${path.relative(SRC, f)} → ${name}`);
  }
}

ok("S1 扫到足够的 script setup 组件（防规则失效假通过）", scanned > 20, `scanned=${scanned}`);
ok(
  "S2 模板调用到的函数都在 setup 顶层（没有嵌在 computed/回调里的）",
  problems.length === 0,
  problems.join(" | "),
);
console.log(`       （共检查 ${nestedTotal} 个嵌套函数声明）`);

/* 反向自检：把这次的 bug 手动造出来，规则必须抓得到 —— 否则上面的 PASS 是假的 */
{
  const fakeTpl = `<van-switch @update:model-value="onPrefToggle" />`;
  const fakeScr = stripComments(`const langName = computed(() => {
  function onPrefToggle(v) { return v; }
  return "x";
});`);
  const nested = [...fakeScr.matchAll(/^[ \t]+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1]);
  const caught = nested.some((n) => new RegExp("(?<![\\w$.])" + n + "(?![\\w$])").test(fakeTpl));
  ok("S3 规则自检：能抓到「函数写在 computed 里、模板里却调它」", caught, caught ? "" : "规则失效！");
}
/* 顶层声明不能被误报 */
{
  const fakeTpl = `<van-switch @update:model-value="onPrefToggle" />`;
  const fakeScr = stripComments(`function onPrefToggle(v) { return v; }`);
  const nested = [...fakeScr.matchAll(/^[ \t]+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1]);
  ok("S4 顶层声明不被误报", nested.length === 0);
}

console.log(`\nTOTAL ${pass + fail}  PASS ${pass}  FAIL ${fail}`);
if (fail > 0) process.exitCode = 1;
