/* i18n 死键 / 漏键检查：node tools/i18n-usage-test.mjs
 * ------------------------------------------------------------
 * 轮 258：i18n-test 管「中英成对」，本工具管「用没用」：
 *   漏键（硬失败）：代码里写了 t("a.b.c") 这样的完整字面量、i18n 里却没有定义
 *     → 运行时界面直接显示原始 key（用户会看到 "bottle.stPicked" 这种鬼东西）。
 *   死键（硬失败）：i18n 里定义了、代码任何地方都不引用（含 vite.config 预渲染）
 *     → 白占双语维护成本（实例：dm.intro 123 字符英文，长期无人发现的死键）。
 *
 * 动态拼接 t("tasks." + task.key) 自动识别为前缀豁免（这些键在运行时拼出来，
 * 静态扫描看不见）；真要保留的死键写进 KEEP 并注明理由（如 i18n-test 探针键）。
 * 扫描面：src 目录下所有 .vue/.js + vite.config.js（排除 i18n.js 自身；tools 测试不扫）。
 */
import fs from "node:fs";
import path from "node:path";
import { messages } from "../src/i18n.js";

let pass = 0;
const fails = [];
const out = [];
function ok(name, cond) {
  if (cond) pass++;
  else fails.push(name);
  out.push((cond ? "PASS  " : "FAIL  ") + name);
}

/* ① 定义面：en 侧全部 key 路径（nodes：路径 → 节点；叶子 = 非对象值） */
const nodes = new Map();
const ns = new Set(Object.keys(messages.en));
(function walk(o, prefix) {
  for (const k of Object.keys(o)) {
    const p = prefix ? prefix + "." + k : k;
    nodes.set(p, o[k]);
    if (o[k] && typeof o[k] === "object") walk(o[k], p);
  }
})(messages.en, "");
const leaves = new Set([...nodes].filter(([, v]) => !(v && typeof v === "object")).map(([k]) => k));
const leavesUnder = (prefix) => [...leaves].filter((lf) => lf.startsWith(prefix + "."));

/* ② 代码面：完整字面量引用 + 动态拼接前缀 */
const files = [];
(function collect(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collect(p);
    else if (/\.(vue|js)$/.test(e.name)) files.push(p);
  }
})("src");
files.push("vite.config.js");

const dynPrefixes = new Set();
const referenced = new Set();
const usedButMissing = new Set();
const markRef = (lit) => {
  referenced.add(lit);
  /* 容器引用（t("privacy.s2l") 返回数组整用）→ 子树全算被引用，不连坐报死 */
  if (nodes.get(lit) && typeof nodes.get(lit) === "object") for (const lf of leavesUnder(lit)) referenced.add(lf);
};
for (const f of files) {
  if (path.resolve(f) === path.resolve("src/i18n.js")) continue;
  const src = fs.readFileSync(f, "utf8");
  /* 完整 key 字面量：引号/反引号包着的点分路径（无点的顶层键也认，如 t("brand")） */
  for (const m of src.matchAll(/["'`]([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_-]+)*)["'`]/g)) {
    const lit = m[1];
    if (!ns.has(lit.split(".")[0])) continue; /* 不是 i18n 命名空间开头的点串（如 petStore.js 导入路径）不掺和 */
    if (m.index > 0 && src[m.index - 1] === "=") continue; /* Vue/HTML 属性表达式（v-if="adventure.welcome"）不是词条引用 */
    if (!lit.includes(".")) { if (nodes.has(lit)) referenced.add(lit); continue; } /* 无点裸键只算引用、不算漏键 */
    if (nodes.has(lit)) markRef(lit);
    else if (![...leaves].some((lf) => lf.startsWith(lit))) {
      /* 动态基串（"adventure.welcome" + n 拼出 welcome1/welcome2）放行；真没有以它开头的键才算漏键 */
      usedButMissing.add(lit + "   ← " + f);
    }
  }
  /* 动态拼接前缀：t("tasks." + x) 与反引号模板 t(`notif.react.${v.reaction}`) 两种写法 */
  for (const m of src.matchAll(/["']([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_-]+)*\.)["']\s*\+/g)) dynPrefixes.add(m[1]);
  for (const m of src.matchAll(/`([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_-]+)*\.)\$\{/g)) dynPrefixes.add(m[1]);
  /* 属性链直读（vite.config 预渲染：E.community.title / ZH.home.mood.subtitle）——不是字符串字面量，单独抓。
     轮 261：缺键也要报——曾有 E.home.companions.hall 被当死键删掉、这里只在键存在时标记，
     预渲染页面静默印出 "undefined" 跑了很久没人发现（补上与字符串字面量同口径的漏键检测）。
     紧跟 "(" 的末段是方法名（E.home.heroSub.split("{n}")）——去掉末段再判，别把 .split 当缺键。 */
  for (const m of src.matchAll(/\b(?:E|ZH|EN|messages\.en|messages\.zh)\.([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_-]+)+)/g)) {
    let lit = m[1];
    if (src[m.index + m[0].length] === "(" && lit.includes(".")) lit = lit.slice(0, lit.lastIndexOf("."));
    if (nodes.has(lit)) markRef(lit);
    else if (![...leaves].some((lf) => lf.startsWith(lit))) {
      usedButMissing.add(lit + "   ← " + f + "（属性链）");
    }
  }
}

/* ③ 死键：定义了但没人用，且不在动态前缀豁免里，也不在 KEEP 里 */
const KEEP = new Map([
  ["home.hello", "i18n-test 双语平衡探针键（测试专用占位，勿删）"],
]);
const dead = [];
const deadKept = [];
for (const k of leaves) {
  if (referenced.has(k)) continue;
  if ([...dynPrefixes].some((p) => k.startsWith(p))) continue;
  if (KEEP.has(k)) { deadKept.push(k + "（" + KEEP.get(k) + "）"); continue; }
  dead.push(k);
}

ok("漏键 = 0（代码引用了但 i18n 没定义 → 界面会显示原始 key）", usedButMissing.size === 0);
ok("死键 = 0（i18n 定义了但代码不用；确要保留的进 KEEP 并注明理由）", dead.length === 0);

if (usedButMissing.size) {
  out.push("  ── 漏键明细 ──");
  for (const s of [...usedButMissing].sort()) out.push("    " + s);
}
if (dead.length) {
  out.push("  ── 死键明细（删 i18n.js 里对应的 en/zh 两份；或确认要留则进 KEEP）──");
  for (const s of dead.sort()) out.push("    " + s);
}
if (deadKept.length) {
  out.push("  ── KEEP 保留键 ──");
  for (const s of deadKept.sort()) out.push("    " + s);
}

console.log(out.join("\n"));
console.log(`i18n-usage-test: ${pass} pass, ${fails.length} fail（叶子键 ${leaves.size} · 引用 ${referenced.size} · 动态前缀 ${dynPrefixes.size}）`);
if (fails.length) process.exit(1);
