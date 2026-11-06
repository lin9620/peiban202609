/* i18n 文案回归：node tools/i18n-test.mjs
 * 回归重点（对应线上出现过的两类故障）：
 *  ① 界面直接显示原始 key（如 "adventure.timeM"、"adventure.fedVisitor"）：
 *     - 词典缺 key：旅行倒计时 timeM/timeS、招待访客 fedVisitor 曾缺失；
 *     - 命名空间写错：messages 里是顶层 adventure，组件却写成 pet.adventure.*；
 *     - i18n.locale 不是规范值（如 "zh-CN"）时词典取不到 → 全部文案退化成 key。
 *  ② 带参数替换用 new RegExp 拼接：值里含 $ 或 \ 会被当正则语法，导致报错或替换错乱。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { messages, t, i18n, normLocale } from "../src/i18n.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (n, c, extra = "") => {
  if (c) { pass++; console.log("PASS ", n, extra); }
  else { fail++; console.log("FAIL ", n, extra); }
};

/* ─── ① 收集 src 里所有 t("key") 字面量 ──
 * 负向后顾避免把 getContext("2d") / select("id") / fillText("x") / import("./x.vue") 误当成 t() */
const CALL = /(?<![\w$.])t\(\s*["']([^"'\\$]+)["']\s*[,)]/g;
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  if (e.isDirectory()) return walk(p);
  return /\.(vue|js)$/.test(e.name) ? [p] : [];
});
const used = new Map();
for (const f of walk(path.join(root, "src"))) {
  const src = fs.readFileSync(f, "utf8");
  for (const m of src.matchAll(CALL)) {
    const at = path.basename(f) + ":" + (src.slice(0, m.index).split("\n").length);
    if (!used.has(m[1])) used.set(m[1], []);
    used.get(m[1]).push(at);
  }
}
/* 数组是叶子（如 home.mood.options 是给 v-for 用的文案数组），不能展开成 key.0 / key.1 */
const flatten = (o, pre = "") => Object.entries(o).flatMap(([k, v]) =>
  v && typeof v === "object" && !Array.isArray(v) ? flatten(v, pre + k + ".") : [pre + k]);
const pick = (o, k) => k.split(".").reduce((a, p) => (a == null ? a : a[p]), o);

/* 多语言：en 是基准。**admin.* 是唯一允许缺席的一组** ——
 * 管理后台只有站主用，中/英界面足够；缺了由 t() 回退英文，普通用户永远看不到。
 * 规则是「全翻或全不翻」：不允许半套 admin（半套八成是漏了几条）。 */
const ADMIN = (k) => k.startsWith("admin.");
const LANGS = Object.keys(messages);
const setOf = (l) => new Set(flatten(messages[l]));
const SETS = Object.fromEntries(LANGS.map((l) => [l, setOf(l)]));
const en = SETS.en;
const ADMIN_TOTAL = [...en].filter(ADMIN).length;
const where = (k) => `${k} <- ${(used.get(k) || ["(未在 src 中使用)"]).join(",")}`;

ok("T1 词典规模合理（每语言 >200）", LANGS.every((l) => SETS[l].size > 200),
  LANGS.map((l) => `${l}=${SETS[l].size}`).join(" "));
ok("T2 抓到字面量 key 数量合理（防正则失效假通过）", used.size > 150, `used=${used.size}`);

/* 每个已使用的 key 都得在每种语言里存在（admin 除外，走英文回退） */
for (const l of LANGS) {
  const miss = [...used.keys()].filter((k) => !SETS[l].has(k) && !ADMIN(k));
  ok(`T3 ${l} 无缺失 key（已使用范围，admin 除外）`, miss.length === 0, miss.map(where).join(" | "));
}
/* 非 admin 部分必须与 en 完全一致：多出来的 key 说明拼错命名空间，少了说明漏翻 */
for (const l of LANGS.filter((x) => x !== "en")) {
  const miss = [...en].filter((k) => !SETS[l].has(k) && !ADMIN(k));
  const extra = [...SETS[l]].filter((k) => !en.has(k));
  ok(`T4 ${l} 非 admin 键集合与 en 完全对齐`, miss.length === 0 && extra.length === 0,
    `miss=${miss.join(",")} extra=${extra.join(",")}`);
  /* 全翻或全不翻 */
  const adminMiss = [...en].filter((k) => ADMIN(k) && !SETS[l].has(k)).length;
  ok(`T5 ${l} admin 整组全翻或全不翻`, adminMiss === 0 || adminMiss === ADMIN_TOTAL,
    `缺 ${adminMiss}/${ADMIN_TOTAL}`);
}

/* 漏译探测：值跟英文一模一样。品牌名/emoji/单位缩写天然相同，
 * admin.* 已整组允许沿用英文 —— 除此之外不该成片雷同。 */
for (const l of LANGS.filter((x) => x !== "en")) {
  const same = [...en].filter((k) => !ADMIN(k) && pick(messages[l], k) === pick(messages.en, k));
  ok(`T6 ${l} 无明显漏译（非 admin 与英文雷同 <40）`, same.length < 40,
    `same=${same.length} ${same.slice(0, 12).join(",")}`);
}
/* 串语言污染：包里混进中文/日文假名是最典型的粘贴事故 */
const CJK = /[\u4e00-\u9fff\u3040-\u30ff]/;
for (const l of LANGS.filter((x) => x !== "zh")) {
  const dirty = flatten(messages[l]).filter((k) => CJK.test(String(pick(messages[l], k))));
  ok(`T7 ${l} 无非本语言字符污染`, dirty.length === 0, dirty.slice(0, 10).join(","));
}
/* 占位符一致性：译文里 {n} {max} 这类必须与英文完全同集合，
 * 少一个只是显示缺陷，多一个会渲染成字面量 {xxx} —— 都是真故障。 */
for (const l of LANGS.filter((x) => x !== "en")) {
  const bad = [];
  for (const k of en) {
    if (!SETS[l].has(k)) continue;
    const a = String(pick(messages.en, k)).match(/\{[a-z]+\}/gi) || [];
    const b = String(pick(messages[l], k)).match(/\{[a-z]+\}/gi) || [];
    const sa = [...new Set(a)].sort().join(","), sb = [...new Set(b)].sort().join(",");
    if (sa !== sb) bad.push(`${k}: ${sa} vs ${sb}`);
  }
  ok(`T8 ${l} 插值占位符与英文一致`, bad.length === 0, bad.slice(0, 8).join(" | "));
}

/* ─── ② 曾出问题的 key 逐一回归（每种语言都要在） ─── */
for (const k of ["adventure.timeM", "adventure.timeS", "adventure.fedVisitor", "adventure.backIn"]) {
  ok(`T9 ${k} 各语言齐备`, LANGS.every((l) => SETS[l].has(k)), LANGS.filter((l) => !SETS[l].has(k)).join(","));
}

/* ─── ③ 渲染：任何已用 key 都不该原样冒出来（顺带验证 admin 缺省确实回退到英文） ─── */
const render = (loc) => {
  i18n.locale = loc;
  const bad = [];
  for (const k of used.keys()) { const v = t(k); if (v === k || !v) bad.push(`${k}->${v}`); }
  return bad;
};
for (const l of LANGS) {
  const bad = render(l);
  ok(`T10 ${l} 下所有 key 均有文案`, bad.length === 0, bad.slice(0, 15).join(","));
}

/* ─── ④ locale 脏值归一化：zh-CN / en_US / 大写都不能让整站变 key ─── */
ok("T11 normLocale 归一化", normLocale("zh-CN") === "zh" && normLocale("en_US") === "en" && normLocale("ZH") === "zh" && normLocale(null) === "en");
i18n.locale = "zh-CN";
ok("T12 脏 locale 下仍渲染中文", t("adventure.timeM", { m: 3 }) === "3 分钟", t("adventure.timeM", { m: 3 }));
i18n.locale = "en-US";
ok("T13 脏 locale 下仍渲染英文", t("adventure.timeS", { s: 5 }) === "5s", t("adventure.timeS", { s: 5 }));
i18n.locale = "es-419";
ok("T14 脏 locale 下仍渲染西语", t("adventure.timeM", { m: 3 }) === "3 min", t("adventure.timeM", { m: 3 }));
i18n.locale = "pt-BR";
ok("T15 脏 locale 下仍渲染葡语", t("adventure.timeM", { m: 3 }) === "3 min", t("adventure.timeM", { m: 3 }));
i18n.locale = "fr-CA";
ok("T16 脏 locale 下仍渲染法语", t("adventure.timeS", { s: 5 }) === "5 s", t("adventure.timeS", { s: 5 }));

/* ── ⑤ 参数替换：值里含正则元字符必须原样输出 ─── */
i18n.locale = "en";
const out = t("adventure.welcomeBack", { n: "$&", c: "\\1" });
ok("T17 参数含 $ 与 \\ 不被当正则语法", out.includes("$&") && out.includes("\\1"), out);

/* ── ⑥ 缺 key 时的行为：未知 key 原样返回，其余语言缺 key 回退英文 ─── */
ok("T18 未登记 key 原样返回便于排查", t("no.such.key") === "no.such.key");
for (const l of LANGS.filter((x) => x !== "en")) {
  const backup = messages[l].adventure.timeM;
  delete messages[l].adventure.timeM;
  i18n.locale = l;
  ok(`T19 ${l} 缺 key 时回退英文而非显示 key`, t("adventure.timeM", { m: 4 }) === "4 min", t("adventure.timeM", { m: 4 }));
  messages[l].adventure.timeM = backup;
}
i18n.locale = "en";

/* ─── ⓪ 轮 456：首启语言默认值 ───
 * 用户：「用户第一次进入的时候默认为英文」。此前无存档时跟随 navigator.language，
 * 中文手机首启直接中文。现在一律 en；只有存过 wp-lang 才走存档（设置页手动选的）。
 * 用源码断言而不是读 i18n.locale —— 测试进程里前面的用例已经改过运行时 locale。 */
{
  const src = fs.readFileSync(path.join(root, "src/i18n.js"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  ok("T25 无存档时默认 en，不再跟随 navigator.language",
    /getItem\("wp-lang"\)\s*\|\|\s*"en"/.test(src) && !/navigator\.language/.test(src));
}

/* ─── ⑦ 构建产物（若已构建）：修复过的文案要真的进包 ─── */
const assetsDir = path.join(root, "dist", "assets");
if (fs.existsSync(assetsDir)) {
  const js = fs.readdirSync(assetsDir).filter((f) => f.endsWith(".js"))
    .map((f) => fs.readFileSync(path.join(assetsDir, f), "utf8")).join("\n");
  ok("T20 产物含英文修复文案", js.includes("{m} min") && js.includes("{s}s") && js.includes("It loved your dish"));
  ok("T21 产物含中文修复文案", js.includes("{m} 分钟") && js.includes("它很喜欢你的料理"));
  ok("T22 产物含西语文案", js.includes("Muro Cálido") && js.includes("Enviar una botella"));
  ok("T23 产物含葡语文案", js.includes("Muro Acolhedor") && js.includes("Garrafas ao mar"));
  ok("T24 产物含法语文案", js.includes("Mur Chaleureux") && js.includes("Bouteilles à la mer"));
} else {
  console.log("SKIP  T20~T24 尚未构建 dist（先跑 npm run build）");
}

console.log(`\nTOTAL ${pass + fail}  PASS ${pass}  FAIL ${fail}`);
if (fail > 0) process.exitCode = 1;