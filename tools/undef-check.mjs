/* 静态检查：找出「使用了项目内导出符号但没导入」的引用（空白页元凶） */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "src");

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(vue|js|mjs)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

const files = walk(src);

/* 模板字符串（含嵌套）——正则剥不干净：`` `a${b ? `&id=${c}` : ""}` `` 里，
   简单的 /`(?:\\.|[^`\\])*`/g 会把内层反引号当成外层的闭合，导致 `${...}` 里的
   `&before_id=` 残留在「代码」里，被当成 `before_id = …` 赋值（本检查踩过）。
   这里手写扫描：文本段整体丢弃；`${}` 内的表达式原样输出（其中的字符串/嵌套模板递归处理），
   `}` 配对按花括号深度算，字符串里的 `}` 不会提前收尾。 */
function stripTemplates(code) {
  const out = [];
  const stack = [];            /* 每层：null = 在模板文本段；数字 = 在 ${} 内的花括号深度 */
  const inText = () => stack.length > 0 && stack[stack.length - 1] === null;
  const copyString = (i) => {  /* 从引号处原样拷到配对引号（跳过转义） */
    const q = code[i];
    out.push(q);
    i++;
    while (i < code.length) {
      if (code[i] === "\\") { out.push(code[i], code[i + 1] || ""); i += 2; continue; }
      out.push(code[i]);
      if (code[i] === q) return i + 1;
      i++;
    }
    return i;
  };
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    if (inText()) {
      if (c === "\\") { i += 2; continue; }                      /* 转义：整对跳过 */
      if (c === "`") { stack.pop(); out.push("``"); i++; continue; }
      if (c === "$" && code[i + 1] === "{") { stack[stack.length - 1] = 0; out.push(" "); i += 2; continue; }
      i++;                                                       /* 文本内容丢弃 */
      continue;
    }
    if (c === "`") { stack.push(null); i++; continue; }          /* 进模板（含 ${} 里的嵌套模板） */
    if (stack.length) {                                          /* 在 ${} 表达式里 */
      if (c === "{" ) { stack[stack.length - 1]++; out.push(c); i++; continue; }
      if (c === "}") {
        if (stack[stack.length - 1] === 0) { stack[stack.length - 1] = null; i++; continue; }
        stack[stack.length - 1]--; out.push(c); i++; continue;
      }
      if (c === '"' || c === "'") { i = copyString(i); continue; }
      out.push(c); i++; continue;
    }
    if (c === '"' || c === "'") { i = copyString(i); continue; }
    out.push(c); i++;
  }
  return out.join("");
}

/* 剥离注释与字符串字面量：避免把 import 路径（如 "../stores/petStore.js"）
   和文案里的词当成「使用」，这类误报会淹没真实问题 */
function stripNoise(code) {
  return stripTemplates(
    code
      .replace(/\/\*[\s\S]*?\*\//g, " ")      // 块注释
      .replace(/<!--[\s\S]*?-->/g, " ")        // HTML 注释
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1 "),  // 行注释（避免吃掉 https://）
  )
    .replace(/"(?:\\.|[^"\\])*"/g, '""')       // 双引号字符串
    .replace(/'(?:\\.|[^'\\])*'/g, "''")       // 单引号字符串
    /* import 语句本身不是「使用」：别名导入 `import { finalReward as snackReward }`
       里的原名 finalReward 会被误判成未导入，故整流剥离（字符串已换成 ""，路径可匹配） */
    .replace(/^[ \t]*import\s[\s\S]*?from\s*["'][^"']*["']\s*;?/gm, "import;");
}

/* 赋值给「本文件从未声明」的裸标识符 → ESM 严格模式下直接 ReferenceError。
   轮 82 真事故：B1 虚拟窗口里 `prevAnchor = root.style.overflowAnchor` 只写了赋值、忘了 let，
   onMounted 从那一行起整段中断（占位块 / 滚动监听 / 续载全没接上，界面却「看着正常」，
   只有真机量几何才现形 —— 首屏之后永远只有十几条）。
   现有的 undef-check 只查「导入的符号导入了没有」、tdz-check 只查 immediate watch 的顺序，
   都抓不到这类；而这类名字根本不在任何模块的导出表里，所以必须单独扫。
   判据：出现 `名字 =` / `名字 +=` 等赋值，但该名字在本文件里既不是声明、也不是参数（绑定集合），
        也不是内置全局（GLOBAL_OK）。`obj.name = ...` 的属性赋值因为前面是点号，天然不匹配。 */
const GLOBAL_OK = new Set([
  "window", "document", "location", "history", "navigator", "console", "performance", "crypto",
  "localStorage", "sessionStorage", "globalThis", "self", "top", "parent", "frames", "opener",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame",
  "queueMicrotask", "structuredClone", "fetch", "alert", "confirm", "prompt", "matchMedia",
  "getComputedStyle", "IntersectionObserver", "ResizeObserver", "MutationObserver",
  "CustomEvent", "Event", "AbortController", "URL", "URLSearchParams", "FormData", "Blob", "File",
  "FileReader", "Image", "Audio", "TextEncoder", "TextDecoder", "btoa", "atob",
  "isNaN", "isFinite", "parseInt", "parseFloat", "encodeURIComponent", "decodeURIComponent",
  "Math", "JSON", "Date", "Object", "Array", "String", "Number", "Boolean", "Promise", "Map", "Set",
  "WeakMap", "WeakSet", "Error", "RegExp", "Symbol", "BigInt", "Reflect", "Proxy", "Intl",
  "undefined", "NaN", "Infinity",
]);
/* `=(?![=>])`：别把 `p => expr` 的箭头、`a === b` 的相等判成赋值 */
const ASSIGN_RE = /(?<![\w$.'"`])([A-Za-z_$][\w$]*)\s*(?:=(?![=>])|\+=|-=|\*=|\/=|%=|\?\?=|\|\|=|&&=)/g;

/* 顶层逗号切分（括号 / 字符串里的逗号不算）—— 声明器列表用 */
function splitTop(list) {
  const parts = [];
  let depth = 0, quote = null, esc = false, cur = "";
  for (const ch of list) {
    if (quote) {
      cur += ch;
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; cur += ch; continue; }
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; }
    else cur += ch;
  }
  parts.push(cur);
  return parts;
}

/* 配对右括号（跳过字符串），用于解构声明器只取括号内部 */
function closingBracket(s) {
  let depth = 0, quote = null, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/* 一条 const/let/var 语句里的**每个**声明器都要收：
   `const W = 640, H = 480;` 只收第一个的话，H 会被误判成「未声明就赋值」（本检查踩过）。 */
function collectDeclNames(text, bound) {
  for (let p of splitTop(text)) {
    p = p.trim();
    if (!p) continue;
    /* 解构：`[k, v] of xs` / `{ a, b: c = 1 } = obj` —— 只取配对括号内部，右侧的
       `of xs)`、`= obj` 之类不参与（`for (const [k, v] of xs) { … }` 整行都在文本里） */
    if (p.startsWith("{") || p.startsWith("[")) {
      const close = closingBracket(p);
      if (close > 0) collectDeclNames(p.slice(1, close), bound);
      continue;
    }
    const n = p.replace(/^\.\.\.\s*/, "").split(/\s*=\s*/)[0].trim();
    if (/^[A-Za-z_$][\w$]*$/.test(n)) { bound.add(n); continue; }
    /* 重命名 / 深层解构：`a: b`、`a: { c }` → 取冒号右边再来一轮。
       放在「先试裸标识符」之后：`a = b ? c : d` 里的冒号才不会把 a 丢掉。 */
    const colon = p.lastIndexOf(":");
    if (colon >= 0) collectDeclNames(p.slice(colon + 1), bound);
  }
}

/* 从 const/let/var 之后取「声明器文本」：括号深度归零处的 ; 或换行即为语句末尾 */
function declTextFrom(code, start) {
  let depth = 0, quote = null, esc = false;
  for (let i = start; i < code.length; i++) {
    const c = code[i];
    if (quote) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    else if (depth === 0 && (c === ";" || c === "\n")) return code.slice(start, i);
  }
  return code.slice(start);
}

/* 收集函数参数作为局部绑定：箭头函数 + function 声明。
   修复误报：THEMES.find((t) => t.key === key)、pairs.map(([t, v]) => ({ t, ... }))
   —— 这里的 t 是局部参数，遮蔽了外层导入的 i18n 翻译函数 t。 */
function collectParams(list, bound) {
  const parts = [];
  let depth = 0, cur = "";
  for (const ch of list) {
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; }
    else cur += ch;
  }
  parts.push(cur);
  for (let p of parts) {
    p = p.trim();
    if (!p) continue;
    const dm = p.match(/^[{[]([\s\S]*)[}\]]$/);                 // 解构参数
    if (dm) {
      for (let e of dm[1].split(",")) {
        e = e.trim().split(/\s*=\s*/)[0].trim();                // 去默认值
        const n = e.split(/\s*:\s*/).pop().trim();              // 重命名取别名
        if (/^[A-Za-z_$][\w$]*$/.test(n)) bound.add(n);
      }
      continue;
    }
    const n = p.replace(/^\.+\s*/, "").split(/\s*=\s*/)[0].trim(); // rest / 默认值
    if (/^[A-Za-z_$][\w$]*$/.test(n)) bound.add(n);
  }
}

/* 导入语句：默认导出 / 具名 / 命名空间 / 默认+具名（供 buildBound 与主流程共用） */
const IMPORT_RE = /import\s+(?:([\w$]+)\s*,\s*)?(?:\{([^}]*)\}|\*\s+as\s+([\w$]+)|([\w$]+))?\s*from\s*["']([^"']+)["']/g;

/* 收集「本文件里已声明的所有名字」：导入 / function · class / const·let·var（含解构与多声明器）
   / 函数与方法参数 / catch 参数 / 方法简写名。
   2b 的赋值扫描全靠它区分「声明过」和「没声明」—— 漏收就会误报，多收就会漏报真问题。 */
function buildBound(code) {
  const bound = new Set();

  for (const m of code.matchAll(IMPORT_RE)) {
    if (m[1]) bound.add(m[1]);
    if (m[2]) for (const p of m[2].split(",")) {
      const n = p.trim().split(/\s+as\s+/).pop().trim();
      if (n) bound.add(n);
    }
    if (m[3]) bound.add(m[3]);
    if (m[4]) bound.add(m[4]);
  }
  /* function / class 声明名（词边界防止把 `mylet x` 之类当声明） */
  for (const m of code.matchAll(/(?:^|[^\w$.])(?:function|class)\s+([A-Za-z_$][\w$]*)/g)) bound.add(m[1]);
  /* const/let/var：整条语句的每个声明器都收（含解构、多声明器、for-of 的 [k, v]） */
  for (const m of code.matchAll(/(?:^|[^\w$.])(?:const|let|var)\s+/g)) {
    collectDeclNames(declTextFrom(code, m.index + m[0].length), bound);
  }

  /* 关键：必须用「剥离注释与字符串后」的代码判断使用，
     否则 import 路径（"./stores/petStore.js"）会被当成使用 → 全是误报 */
  const scan = stripNoise(code);

  /* 函数参数也是局部绑定（箭头函数 / function 声明 / 方法简写）。
     三处都允许默认值里的一层括号（`utcDay()` / `Date.now()` 很常见），
     否则参数表会在第一个 `)` 处截断 → `{ replyTo = "" }` 这类解构默认值会被误报成裸赋值。 */
  for (const m of scan.matchAll(/\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*=>/g)) collectParams(m[1], bound);
  for (const m of scan.matchAll(/\bfunction\s*[A-Za-z_$][\w$]*\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) {
    collectParams(m[1], bound);
  }
  /* catch (e) 的 e 也是局部绑定（扫赋值时要算已声明，否则 `catch (e) { e = null }` 会误报） */
  for (const m of scan.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) bound.add(m[1]);

  /* 对象 / class 方法简写也是本地定义（如适配层 db = { async listComments(postId, limit) {...} }）。
     此前只认 function/class 声明，方法名与别的模块导出撞名时（如 comments.js 的 listComments）
     会被误报成「未导入的调用」。正常 JS 里「标识符(…){」只会出现在方法定义处（或 if/for 等
     关键字，绑进集合无害），真正的裸调用后面跟的是 ; 或 ) ，不会被这条吞掉。 */
  for (const m of scan.matchAll(/(?<![\w$.])(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*\{/g)) {
    bound.add(m[1]);
    collectParams(m[2], bound);   /* 方法简写的参数也是局部绑定（`async listPosts(limit, opts = {})`） */
  }
  return bound;
}

/* 2b) 未声明就赋值：返回「可直接打印的问题行」数组（同一名字在一个文件里只报一次，免得刷屏）。
   ⚠ 只在 <script> 块里扫：.vue 的 <template> 里 `class="x"` 这类属性会被 stripNoise 剥成
   `class=`，跟赋值长得一模一样，整文件扫会刷出几百条假警报（本检查初版就踩了）。 */
export function scanUnassigned(rel, code, bound) {
  const out = [];
  const sm = /<script[^>]*>([\s\S]*?)<\/script>/.exec(code);
  const scriptTxt = sm ? sm[1] : code;
  const tagM = /<script[^>]*>/.exec(code);
  const baseLine = tagM ? code.slice(0, tagM.index + tagM[0].length).split("\n").length - 1 : 0;
  const seen = new Set();
  for (const m of stripNoise(scriptTxt).matchAll(ASSIGN_RE)) {
    const name = m[1];
    if (bound.has(name) || GLOBAL_OK.has(name) || seen.has(name)) continue;
    seen.add(name);
    const esc = name.replace(/[$]/g, "\\$");
    const at = scriptTxt.search(new RegExp("(?<![\\w$.'\"`])" + esc + "\\s*(?:=(?![=>])|\\+=|-=|\\*=|\\/=|%=|\\?\\?=|\\|\\|=|&&=)"));
    const line = baseLine + (at >= 0 ? scriptTxt.slice(0, at).split("\n").length : 0);
    out.push(rel + (line ? ":" + line : "") + "  →  " + name
      + " = … 但本文件从未声明它（ESM 严格模式下 ReferenceError → 该处起的整段逻辑都中断）");
  }
  return out;
}

/* ── 自检：`node tools/undef-check.mjs --selftest` ──
   2b 这一档是「用正则近似 JS 语义」，最怕两件事：加了新语法后**漏报**真问题，
   或者反过来**误报**一片（初版就误报过 365 条）。这里把两类都用最小样本钉住。 */
if (process.argv.includes("--selftest")) {
  const names = (src) =>
    scanUnassigned("t.js", src, buildBound(src)).map((s) => s.split("→")[1].trim().split(" ")[0]);
  const cases = [
    ["真缺陷：只赋值、忘了 let（轮 82 的 prevAnchor 事故）",
      'let a = 1;\nfunction f() { prevAnchor = el.style.overflowAnchor; }\nvoid a;',
      ["prevAnchor"]],
    ["声明过就不报：let prevAnchor 之后再赋值",
      'let prevAnchor = "";\nfunction f() { prevAnchor = "none"; }',
      []],
    ["多声明器：const W = 640, H = 480 两个都要算已声明",
      "const W = 640, H = 480;\nfunction f() { H = 1; W = 2; }",
      []],
    ["解构参数默认值 `{ replyTo = \"\", now = Date.now() }` 不是裸赋值",
      'function add(store, { replyTo = "", now = Date.now() } = {}) { replyTo = "x"; now = 1; }',
      []],
    ["嵌套模板字符串：`&before_id=${enc(bid)}` 不是赋值",
      ["const bid = 1;", "function f(enc) {", "  const off = 0;",
        "  return call(`/posts?limit=${enc(1)}${off ? `&offset=${enc(off)}` : \"\"}${bid ? `&before_id=${enc(bid)}` : \"\"}`);",
        "}", "void f;"].join("\n"),
      []],
    ["字符串 / 注释里的「赋值」不算",
      'const a = 1;\n/* b = 2 */\nconst s = "c = 3";\n// d = 4\nconst t = \'e += 5\';\nvoid a; void s; void t;',
      []],
    ["属性赋值不算（obj.x = 1 / globalThis.g = 2）",
      "let o = {};\nfunction f() { o.name = 1; o[\"k\"] = 2; globalThis.g = 3; }",
      []],
    ["catch 参数是已声明",
      'function f() { try { throw 1; } catch (e) { e = null; } }',
      []],
    [".vue 只扫 <script>（模板属性 class= / :style= 不是赋值）",
      '<script setup>\nconst a = 1;\nvoid a;\n</script>\n<template><div class="x" :style="{ color: \'red\' }"></div></template>',
      []],
    ["未声明就赋值的每一个名字都要报（不只第一个）",
      "function f() { alpha = 1; beta = 2; }",
      ["alpha", "beta"]],
  ];
  let pass = 0;
  for (const [label, src, want] of cases) {
    const got = names(src);
    const ok = got.length === want.length && want.every((w) => got.includes(w));
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}` + (ok ? "" : `\n      want=${JSON.stringify(want)} got=${JSON.stringify(got)}`));
    if (ok) pass++;
  }
  console.log(`\nTOTAL ${cases.length}  PASS ${pass}  FAIL ${cases.length - pass}`);
  process.exit(pass === cases.length ? 0 : 1);
}

/* 1) 收集所有项目内的导出符号 */
const exported = new Map(); // name -> 定义文件
for (const f of files) {
  const code = fs.readFileSync(f, "utf8");
  const rel = path.relative(root, f).replace(/\\/g, "/");
  const add = (n) => { if (!exported.has(n)) exported.set(n, rel); };
  for (const m of code.matchAll(/export\s+(?:const|let|function|class)\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of code.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) add(name);
    }
  }
}

/* 2) 逐文件检查：出现导出名，但既未导入、也非本地定义；以及「未声明就赋值」 */
const problems = [];

for (const f of files) {
  const code = fs.readFileSync(f, "utf8");
  const rel = path.relative(root, f).replace(/\\/g, "/");
  const bound = buildBound(code);
  /* 关键：必须用「剥离注释与字符串后」的代码判断使用，
     否则 import 路径（"./stores/petStore.js"）会被当成使用 → 全是误报 */
  const scan = stripNoise(code);

  /* 2b) 未声明就赋值（见文件头与 scanUnassigned 的说明） */
  for (const p of scanUnassigned(rel, code, bound)) problems.push(p);

  for (const name of exported.keys()) {
    if (bound.has(name)) continue;
    /* 排除：属性访问 obj.name、标签名 <name-xxx>（如 router-link）、标识符内部子串、
       对象键名（i18n 词条字典里的 adventure: / feedVisitor: 这类键不是标识符使用） */
    const esc = name.replace(/[$]/g, "\\$");
    const re = new RegExp("(?<![\\w$.-])" + esc + "(?!\\s*:)(?![\\w$-])");
    if (re.test(scan)) {
      problems.push(rel + "  →  使用了 " + name + "（定义在 " + exported.get(name) + "）但未导入/未定义");
    }
  }
}

const out = [
  "SCANNED=" + files.length + "  EXPORTS=" + exported.size + "  PROBLEMS=" + problems.length,
  "",
  ...problems,
];
fs.writeFileSync(path.join(root, "undef-report.txt"), out.join("\n"), "utf8");
console.log("UNDEF_DONE problems=" + problems.length);