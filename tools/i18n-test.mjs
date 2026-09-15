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
const en = new Set(flatten(messages.en));
const zh = new Set(flatten(messages.zh));
const where = (k) => `${k} <- ${used.get(k).join(",")}`;

ok("T1 词典规模合理", en.size > 200 && zh.size > 200, `en=${en.size} zh=${zh.size}`);
ok("T2 抓到字面量 key 数量合理（防正则失效假通过）", used.size > 150, `used=${used.size}`);

const missEn = [...used.keys()].filter((k) => !en.has(k));
const missZh = [...used.keys()].filter((k) => !zh.has(k));
ok("T3 en 无缺失 key", missEn.length === 0, missEn.map(where).join(" | "));
ok("T4 zh 无缺失 key", missZh.length === 0, missZh.map(where).join(" | "));

const enOnly = [...en].filter((k) => !zh.has(k));
const zhOnly = [...zh].filter((k) => !en.has(k));
ok("T5 en/zh 键集合对称", enOnly.length === 0 && zhOnly.length === 0, `en-only=${enOnly.join(",")} zh-only=${zhOnly.join(",")}`);

/* ─── ② 曾出问题的 key 逐一回归 ─── */
for (const k of ["adventure.timeM", "adventure.timeS", "adventure.fedVisitor", "adventure.backIn"]) {
  ok(`T6 ${k} 双语齐备`, en.has(k) && zh.has(k));
}

/* ─── ③ 渲染：任何已用 key 都不该原样冒出来 ─── */
const render = (loc) => {
  i18n.locale = loc;
  const bad = [];
  for (const k of used.keys()) { const v = t(k); if (v === k || !v) bad.push(`${k}->${v}`); }
  return bad;
};
const badEn = render("en"), badZh = render("zh");
ok("T7 en 下所有 key 均有文案", badEn.length === 0, badEn.join(","));
ok("T8 zh 下所有 key 均有文案", badZh.length === 0, badZh.join(","));

/* ─── ④ locale 脏值归一化：zh-CN / en_US / 大写都不能让整站变 key ─── */
ok("T9 normLocale 归一化", normLocale("zh-CN") === "zh" && normLocale("en_US") === "en" && normLocale("ZH") === "zh" && normLocale(null) === "en");
i18n.locale = "zh-CN";
ok("T10 脏 locale 下仍渲染中文", t("adventure.timeM", { m: 3 }) === "3 分钟", t("adventure.timeM", { m: 3 }));
i18n.locale = "en-US";
ok("T11 脏 locale 下仍渲染英文", t("adventure.timeS", { s: 5 }) === "5s", t("adventure.timeS", { s: 5 }));

/* ── ⑤ 参数替换：值里含正则元字符必须原样输出 ─── */
i18n.locale = "en";
const out = t("adventure.welcomeBack", { n: "$&", c: "\\1" });
ok("T12 参数含 $ 与 \\ 不被当正则语法", out.includes("$&") && out.includes("\\1"), out);

/* ── ⑥ 缺 key 时的行为：未知 key 原样返回，zh 缺 key 回退英文 ─── */
ok("T13 未登记 key 原样返回便于排查", t("no.such.key") === "no.such.key");
const backup = messages.zh.adventure.timeM;
delete messages.zh.adventure.timeM;
i18n.locale = "zh";
ok("T14 zh 缺 key 时回退英文而非显示 key", t("adventure.timeM", { m: 4 }) === "4 min", t("adventure.timeM", { m: 4 }));
messages.zh.adventure.timeM = backup;
i18n.locale = "en";

/* ─── ⑦ 构建产物（若已构建）：修复过的文案要真的进包 ─── */
const assetsDir = path.join(root, "dist", "assets");
if (fs.existsSync(assetsDir)) {
  const js = fs.readdirSync(assetsDir).filter((f) => f.endsWith(".js"))
    .map((f) => fs.readFileSync(path.join(assetsDir, f), "utf8")).join("\n");
  ok("T15 产物含英文修复文案", js.includes("{m} min") && js.includes("{s}s") && js.includes("It loved your dish"));
  ok("T16 产物含中文修复文案", js.includes("{m} 分钟") && js.includes("它很喜欢你的料理"));
} else {
  console.log("SKIP  T15~T16 尚未构建 dist（先跑 npm run build）");
}

console.log(`\nTOTAL ${pass + fail}  PASS ${pass}  FAIL ${fail}`);
if (fail > 0) process.exitCode = 1;