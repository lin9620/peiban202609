/* 跨机型（重点 iOS Safari）兼容护栏（Node 直跑：node tools/ios-compat-test.mjs）
 * ------------------------------------------------------------
 * 轮 502。用户：「我插上苹果手机，你能像控制安卓一样控制吗，苹果浏览器上有很多问题」
 *       「你不要又是只看我这台苹果手机，要兼容啊，你在这台上修好了，别的型号怎么办」
 *
 * 前提（写清楚免得下轮又想去装工具）：iOS 没有 adb 那套。触控注入只有 WebDriverAgent，
 * 要 macOS + Xcode + 开发者证书；Windows 上最多拿到 WPD 文件通道。所以**不能靠远程点按验证**，
 * 只能靠两条：①按能力降级，不按机型写死；②让机器自己 ?diag=1 把能力报上来。
 *
 * 本文件钉的是"不按机型写死"这一半，七条：
 *   I1 backdrop-filter 必须带 -webkit- 配对（iOS ≤17 只认前缀那条，裸写整条被丢）；
 *   I2 任何 dvh/svh 声明必须写在 @supports 里（轮 474：裸写会被旧内核算成 auto，
 *      连同一规则里的 vh 一起丢，容器高度当场塌成内容高）；
 *   I3 用了 100vh 或 dvh 的文件，必须同时有 vh 打底 + @supports 兜底（两边都不能缺）；
 *   I4 env(safe-area-inset-*) 必须给第二参数 fallback（不给就是整条声明失效）；
 *   I5 ?diag=1 自检面板必须注册、且只在带参数时生效（正常用户看不到）；
 *   I6 自检面板**不许**按 UA 机型分支，只能 CSS.supports / 实测（否则又变成"只对我这台"）；
 *   I7 index.html 的 viewport 口径与 style.css 的注释不许互相矛盾。
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
  try { fn(); pass++; out.push("ok   " + name); }
  catch (e) { fail++; out.push("FAIL " + name + " :: " + e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

/* src 下所有带样式的文件 */
const STYLE_FILES = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (!/node_modules|dist|_scratch/.test(p)) walk(p); }
    else if (/\.(css|vue)$/.test(e.name)) STYLE_FILES.push(p);
  }
})(path.join(root, "src"));

const rel = (p) => path.relative(root, p).replace(/\\/g, "/");
/* 只去块注释：CSS 里 // 不是注释，不动它 */
const decomment = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
const cache = new Map();
const src = (p) => {
  if (!cache.has(p)) cache.set(p, decomment(fs.readFileSync(p, "utf8")));
  return cache.get(p);
};

/* 找出所有 @supports (...) { ... } 的字符区间（大括号配对，允许嵌套 @media） */
function supportsRanges(text) {
  const ranges = [];
  const re = /@supports\s*\(([^)]*(?:\([^)]*\)[^)]*)*)\)\s*\{/g;
  let m;
  while ((m = re.exec(text))) {
    let i = m.index + m[0].length;
    let depth = 1;
    const start = m.index;
    while (i < text.length && depth > 0) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") depth--;
      i++;
    }
    ranges.push({ start, end: i, cond: m[1] });
  }
  return ranges;
}

/* ── I1 backdrop-filter 必须带 -webkit- 配对 ─────────────────────── */
t("I1 每处 backdrop-filter 都有 -webkit- 配对，且值一致（iOS ≤17 只认前缀）", () => {
  const misses = [];
  for (const f of STYLE_FILES) {
    const lines = fs.readFileSync(f, "utf8").split("\n");
    lines.forEach((ln, i) => {
      const m = ln.match(/(?<!-webkit-)backdrop-filter\s*:\s*([^;}]+)/);
      if (!m) return;
      if (/^\s*(\*|\/\*)/.test(ln)) return;
      const val = m[1].trim();
      /* 前缀可以写在同一行后面，也可以写在上一行 —— 两种都算配对 */
      const near = [lines[i - 1] || "", ln, lines[i + 1] || ""].join("\n");
      const pre = near.match(/-webkit-backdrop-filter\s*:\s*([^;}]+)/);
      if (!pre) misses.push(`${rel(f)}:${i + 1} 缺 -webkit- 配对`);
      else if (pre[1].trim().replace(/\s+/g, "") !== val.replace(/\s+/g, ""))
        misses.push(`${rel(f)}:${i + 1} 两条值不一致（${val} vs ${pre[1].trim()}）`);
    });
  }
  assert(misses.length === 0, "有 " + misses.length + " 处没配对：\n    " + misses.join("\n    "));
});

/* ── I2 dvh/svh 必须写在 @supports 里 ───────────────────────────── */
t("I2 所有 dvh/svh 声明都在 @supports 内（裸写会被旧内核算成 auto，vh 也一起丢）", () => {
  const bad = [];
  for (const f of STYLE_FILES) {
    const text = src(f);
    const ranges = supportsRanges(text);
    const re = /[0-9.)]*\s*(?:d|s|l)v(h|w|min|max|i|b)\b/g;
    let m;
    while ((m = re.exec(text))) {
      const at = m.index;
      const inside = ranges.some((r) => at > r.start && at < r.end);
      if (!inside) {
        const ln = text.slice(0, at).split("\n").length;
        bad.push(`${rel(f)}:${ln}  ${m[0].trim()}`);
      }
    }
  }
  assert(bad.length === 0, "有 " + bad.length + " 处 dvh/svh 裸露在 @supports 外：\n    " + bad.join("\n    "));
});

/* ── I3 100vh 必须同时有 vh 打底 + @supports 兜底 ────────────────── */
t("I3 用到视口单位高度的文件，vh 打底与 @supports 兜底两边都不缺", () => {
  const bad = [];
  for (const f of STYLE_FILES) {
    const text = src(f);
    if (!/\b100vh\b/.test(text)) continue;
    const heightish = /(?:min-|max-)?height\s*:[^;}]*\b100vh\b/.test(text) || /calc\(\s*100vh/.test(text);
    if (!heightish) continue;
    if (!/@supports\s*\(height:\s*100[ds]vh\)/.test(text)) bad.push(rel(f) + " 有 height:100vh 但没有 @supports 兜底");
  }
  assert(bad.length === 0, "缺兜底：\n    " + bad.join("\n    "));
});

/* ── I4 env() 必须带 fallback ───────────────────────────────────── */
t("I4 每处 env(safe-area-inset-*) 都给了 fallback 第二参数", () => {
  const bad = [];
  for (const f of STYLE_FILES) {
    const text = src(f);   /* 已去注释：注释里写 env(...) 举例不算违规 */
    const re = /env\(\s*safe-area-inset-[a-z]+\s*\)/g;
    let m;
    while ((m = re.exec(text))) bad.push(`${rel(f)}:${text.slice(0, m.index).split("\n").length}  ${m[0]}`);
  }
  assert(bad.length === 0, "有 " + bad.length + " 处 env() 没给 fallback：\n    " + bad.join("\n    "));
});

/* ── I5 自检面板已注册且带门控 ───────────────────────────────────── */
t("I5 ?diag=1 自检面板由 main.js 注册，且只在带参数时才出现", () => {
  const main = read("src/main.js");
  const diag = read("src/utils/compatDiag.js");
  assert(/import\s*\{\s*installCompatDiag\s*\}\s*from\s*"\.\/utils\/compatDiag\.js"/.test(main),
    "main.js 没引入 installCompatDiag");
  assert(/installCompatDiag\s*\(\s*\)/.test(main), "main.js 没调用 installCompatDiag()");
  assert(/\[\?&\]diag=1/.test(diag), "compatDiag 没有 ?diag=1 门控 —— 会把面板塞给所有用户");
  assert(/!\/\[\?&\]diag=1\/\.test\(\s*location\.search\s*\)\s*\)\s*return/.test(diag.replace(/\s+/g, " ")),
    "门控不是「不带参数就 return」，复查一下");
});

/* ── I6 自检面板不许按 UA 分支 ──────────────────────────────────── */
t("I6 自检面板不按 UA / 机型做分支，只走 CSS.supports 与实测", () => {
  const diag = read("src/utils/compatDiag.js")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  const verdict = /if\s*\([^)]*(?:userAgent|platform|vendor)/.test(diag)
    || /(?:userAgent|platform)[^;]*\.test\s*\(/.test(diag)
    || /\/iPhone\|iPad|\/iPad\|iPhone|Android\|iPhone/.test(diag);
  assert(!verdict, "compatDiag 里出现了 UA 机型分支 —— 那就又变成「只对我这台成立」了");
  assert(/CSS\.supports/.test(diag), "没有用 CSS.supports 做能力探测");
  assert(/getComputedStyle/.test(diag), "没有实测安全区（env() 读不出来，必须挂探针量）");
});

/* ── I7 viewport 口径不许自相矛盾 ───────────────────────────────── */
t("I7 index.html 没写 viewport-fit=cover 时，不许有注释声称已写", () => {
  const html = read("index.html");
  /* 必须只看那个 meta 标签本体 —— index.html 的注释里也有 "viewport-fit=cover 继续不写"，
     拿整份文件去测会当场判成「已写」，这条护栏就白设了（本轮实测栽过）。 */
  const meta = (html.match(/<meta\s+name="viewport"[^>]*>/) || [""])[0];
  const hasCover = /viewport-fit\s*=\s*cover/.test(meta);
  const style = read("src/style.css");
  const claims = /已加\s*viewport-fit=cover/.test(style);
  if (!hasCover) assert(!claims, "index.html 的 viewport 没写 cover，但 style.css 注释说「已加」—— 会误导下一轮");
  assert(/viewport-fit\s*=\s*cover 继续不写/.test(html),
    "index.html 的 viewport 决策没有留下说明，下轮没法判断 env() 为什么恒 0");
});

console.log(out.join("\n"));
console.log(`\n${pass} 通过 / ${pass + fail} 项`);
process.exit(fail ? 1 : 0);
