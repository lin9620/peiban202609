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

/* 剥离注释与字符串字面量：避免把 import 路径（如 "../stores/petStore.js"）
   和文案里的词当成「使用」，这类误报会淹没真实问题 */
function stripNoise(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, " ")      // 块注释
    .replace(/<!--[\s\S]*?-->/g, " ")        // HTML 注释
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")   // 行注释（避免吃掉 https://）
    .replace(/`(?:\\.|[^`\\])*`/g, "``")     // 模板字符串
    .replace(/"(?:\\.|[^"\\])*"/g, '""')     // 双引号字符串
    .replace(/'(?:\\.|[^'\\])*'/g, "''")     // 单引号字符串
    /* import 语句本身不是「使用」：别名导入 `import { finalReward as snackReward }`
       里的原名 finalReward 会被误判成未导入，故整流剥离（字符串已换成 ""，路径可匹配） */
    .replace(/^[ \t]*import\s[\s\S]*?from\s*["'][^"']*["']\s*;?/gm, "import;");
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

/* 2) 逐文件检查：出现导出名，但既未导入、也非本地定义 */
const IMPORT_RE = /import\s+(?:([\w$]+)\s*,\s*)?(?:\{([^}]*)\}|\*\s+as\s+([\w$]+)|([\w$]+))?\s*from\s*["']([^"']+)["']/g;
const problems = [];

for (const f of files) {
  const code = fs.readFileSync(f, "utf8");
  const rel = path.relative(root, f).replace(/\\/g, "/");
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
  for (const m of code.matchAll(/(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) bound.add(m[1]);
  for (const m of code.matchAll(/(?:const|let|var)\s*\[([^\]]+)\]/g)) {
    for (const p of m[1].split(",")) { const n = p.trim(); if (n) bound.add(n); }
  }
  for (const m of code.matchAll(/(?:const|let|var)\s*\{([^}]+)\}/g)) {
    for (const p of m[1].split(",")) {
      const n = p.trim().split(":").pop().trim();
      if (n) bound.add(n);
    }
  }

  /* 关键：必须用「剥离注释与字符串后」的代码判断使用，
     否则 import 路径（"./stores/petStore.js"）会被当成使用 → 全是误报 */
  const scan = stripNoise(code);

  /* 函数参数也是局部绑定（箭头函数 / function 声明），在剥离后的代码上匹配 */
  for (const m of scan.matchAll(/\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*=>/g)) collectParams(m[1], bound);
  for (const m of scan.matchAll(/\bfunction\s*[A-Za-z_$][\w$]*\s*\(([^)]*)\)/g)) collectParams(m[1], bound);

  /* 对象 / class 方法简写也是本地定义（如适配层 db = { async listComments(postId, limit) {...} }）。
     此前只认 function/class 声明，方法名与别的模块导出撞名时（如 comments.js 的 listComments）
     会被误报成「未导入的调用」。正常 JS 里「标识符(…){」只会出现在方法定义处（或 if/for 等
     关键字，绑进集合无害），真正的裸调用后面跟的是 ; 或 ) ，不会被这条吞掉。 */
  for (const m of scan.matchAll(/(?<![\w$.])(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/g)) bound.add(m[1]);

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