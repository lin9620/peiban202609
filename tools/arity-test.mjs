/* 模板调用 / 脚本签名 参数个数一致性检查（纯 Node，静态扫描）
 *   node tools/arity-test.mjs
 * 由来：CommunityView 里 repPlaceholder(p, cm) 被模板写成 repPlaceholder(cm)，
 *       多出来的 cm 变 undefined → 渲染时 cm.name 抛错 → 整页崩到错误边界。
 *       这类「改签名忘了改调用」的错编译期不报，只有点到那个按钮才炸，故加静态回归。
 *       扫描前先「抹掉注释 + 按顶层逗号切参数表（解构算 1 个）+ 认 JSDoc 里的可选参数」，
 *       否则 JSDoc 示例、解构参数、文档标了 undefined 的可选参会变成误报 —— 误报一多，检查就没人看了。
 */
import fs from "node:fs";
import path from "node:path";

const out = [];
let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; out.push("PASS  " + name); }
  catch (e) { fail++; out.push("FAIL  " + name + "  → " + e.message); }
};

const root = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(vue|js)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

/** 从开括号位置起数顶层逗号 → 参数个数（跳过字符串 / 括号 / 模板串内的逗号） */
function argCountAt(src, openParenIdx) {
  let depth = 0, args = 0, saw = false, quote = "";
  for (let i = openParenIdx; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; saw = true; continue; }
    if (c === "(" || c === "[" || c === "{") { depth++; if (depth > 1) saw = true; continue; }
    if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) break; /* 外层括号闭合：结束计数 */
      saw = true;
      continue;
    }
    if (c === "," && depth === 1) { args++; saw = true; continue; }
    if (!/\s/.test(c)) saw = true;
  }
  return saw ? args + 1 : 0; /* 空括号（没见到任何实参）= 0 个参数 */
}

/** 把注释换成等长空格（保留换行）：注释里的示例调用不再被当成真调用，
 *  且字符下标不变 → 报错行号依然准确 */
function maskComments(src) {
  const a = src.split("");
  let i = 0;
  let quote = "";
  while (i < src.length) {
    const c = src[i];
    if (quote) {
      if (c === "\\") { i += 2; continue; }
      if (c === quote) quote = "";
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; i++; continue; }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") { a[i] = " "; i++; }
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] !== "\n") a[i] = " ";
        i++;
      }
      for (let k = 0; k < 2 && i < src.length; k++, i++) a[i] = " ";
      continue;
    }
    i++;
  }
  return a.join("");
}

/** 按「顶层逗号」切参数表：跳过括号与字符串里的逗号（解构参数不会被切碎） */
function splitTopLevel(s) {
  const parts = [];
  let depth = 0;
  let quote = "";
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      cur += c;
      if (c === "\\") { cur += s[++i] || ""; continue; }
      if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; cur += c; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    if (c === ")" || c === "]" || c === "}") depth--;
    if (c === "," && depth === 0) { parts.push(cur); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((s) => s.trim());
}

/** 从开括号起找配对的闭括号（跳过字符串里的括号）；找不到返回 -1 */
function matchParen(code, openIdx) {
  let depth = 0;
  let quote = "";
  for (let i = openIdx; i < code.length; i++) {
    const c = code[i];
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "(") { depth++; continue; }
    if (c === ")") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** 定义前紧邻的 JSDoc（中间只允许 export / default / async 之类修饰词） */
function jsDocBefore(code, defIdx) {
  const head = code.slice(0, defIdx);
  const end = head.lastIndexOf("*/");
  if (end < 0) return "";
  const start = head.lastIndexOf("/**", end);
  if (start < 0) return "";
  if (!/^[\s]*(?:export\s+|default\s+|async\s+)*$/.test(head.slice(end + 2))) return "";
  return head.slice(start, end + 2);
}

/** 参数是否「可省略」：带默认值 / rest / JSDoc 标了 [name] 或类型含 undefined */
function isOptionalParam(decl, jsdoc) {
  const s = String(decl || "").trim();
  if (!s) return true;
  if (s.startsWith("...")) return true;
  if (/^[A-Za-z_$][\w$]*\s*=/.test(s)) return true;
  if (/^\{[\s\S]*\}\s*=/.test(s) || /^\[[\s\S]*\]\s*=/.test(s)) return true;
  const named = s.match(/^([A-Za-z_$][\w$]*)/);
  if (!named || !jsdoc) return false; /* 解构参数：整体算 1 个必填 */
  const re = new RegExp("@param\\s*\\{([^}]*)\\}\\s*\\[?\\s*" + named[1] + "\\b", "g");
  let m;
  while ((m = re.exec(jsdoc))) {
    if (/undefined/.test(m[1]) || /\[/.test(m[0])) return true;
  }
  return false;
}

/** 函数定义表：Map<name, { req: 必填参数个数, defs: Set<参数左括号下标> }> */
function fnDefs(code, raw = code) {
  const map = new Map();
  const re = /(?:function\s+([A-Za-z_$][\w$]*)\s*\()|(?:(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\s*)?\()/g;
  let m;
  while ((m = re.exec(code))) {
    const name = m[1] || m[2];
    const open = m.index + m[0].length - 1;
    const close = matchParen(code, open);
    if (close < 0) continue;
    const after = code.slice(close + 1, close + 16).trimStart();
    if (!after.startsWith("=>") && !after.startsWith("{")) continue; /* 后面不是函数体 → 不是定义 */
    const jsdoc = jsDocBefore(raw, m.index);
    const req = splitTopLevel(code.slice(open + 1, close)).filter((d) => !isOptionalParam(d, jsdoc)).length;
    const cur = map.get(name);
    if (cur) { cur.req = Math.min(cur.req, req); cur.defs.add(open); }
    else map.set(name, { req, defs: new Set([open]) });
  }
  return map;
}

/** 脚本里函数定义的「必填参数个数」：{ name: n } */
function requiredParams(script, raw = script) {
  const need = {};
  for (const [name, d] of fnDefs(script, raw)) need[name] = d.req;
  return need;
}

/** 某字符下标所在行号（从 1 开始） */
const lineAt = (code, idx) => code.slice(0, idx).split("\n").length;

/** 模板里「调用参数个数 < 签名必填个数」的问题（code 已 maskComments、tpl 已 maskHtmlComments）
 *  返回 [{ line, msg }]，line 是模板内的相对行号（外加 line0 得到文件行号） */
function templateArityProblems(code, tpl) {
  const need = requiredParams(code);
  const bad = [];
  for (const name of Object.keys(need)) {
    const re = new RegExp("(^|[^\\w$.])" + name.replace(/\$/g, "\\$") + "\\s*\\(", "g");
    let m;
    while ((m = re.exec(tpl))) {
      const open = m.index + m[0].length - 1;
      const n = argCountAt(tpl, open);
      if (n < 0) continue;
      if (n < need[name]) {
        bad.push({
          line: lineAt(tpl, m.index + m[1].length),
          msg: name + "() 模板传了 " + n + " 个参数，但签名必填 " + need[name] + " 个：" + m[0].trim() + "…",
        });
      }
    }
  }
  return bad;
}

const files = walk(path.join(root, "src"));
const problems = [];

for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  const rel = path.relative(root, f).replace(/\\/g, "/");
  const sm = src.match(/<script setup>([\s\S]*?)<\/script>/);
  const tm = src.match(/<template>([\s\S]*?)<\/template>/);
  if (!sm || !tm) continue;
  const line0 = src.slice(0, tm.index).split("\n").length;
  for (const p of templateArityProblems(maskComments(sm[1]), maskHtmlComments(tm[1]))) {
    problems.push(rel + ":" + (line0 + p.line - 1) + "  " + p.msg);
  }
}

/** 同文件内自调用：定义与调用的参数个数是否匹配（跨文件调用留给 T1 的模板检查 + 肉眼）
 *  前置条件：传入的 code 已 maskComments（否则注释里的示例会误报） */
function selfCallProblems(code, raw = code) {
  const problems = [];
  for (const [name, d] of fnDefs(code, raw)) {
    /* 前面不是 . 或单词字符才算「本地调用」：obj.name() 是别人的同名方法，不判定 */
    const callRe = new RegExp("(^|[^\\w$.])" + name.replace(/\$/g, "\\$") + "\\s*\\(", "g");
    let m;
    while ((m = callRe.exec(code))) {
      const open = m.index + m[0].length - 1;
      if (d.defs.has(open)) continue; /* 定义本身，不是调用 */
      const n = argCountAt(code, open);
      if (n < 0) continue;
      if (n < d.req) problems.push({ line: lineAt(code, m.index + m[1].length), msg: name + "() 传了 " + n + " 个参数，签名必填 " + d.req + " 个" });
    }
  }
  return problems;
}

/** 模板里的 <!-- 注释 --> 抹成空格（保留换行） */
function maskHtmlComments(s) {
  const a = s.split("");
  let i = 0;
  while (i < s.length) {
    if (s.slice(i, i + 4) === "<!--") {
      const found = s.indexOf("-->", i + 4);
      const end = found < 0 ? s.length : found + 3;
      for (let k = i; k < end; k++) if (s[k] !== "\n") a[k] = " ";
      i = end;
      continue;
    }
    i++;
  }
  return a.join("");
}

t("T1 模板调用参数个数 ≥ 函数必填参数个数（防 undefined 崩溃）", () => {
  if (problems.length) throw new Error("\n      " + problems.join("\n      "));
});

t("T1b 同文件 JS 自调用参数个数同样要够（含 .js 与 <script setup>）", () => {
  const bad = [];
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    const rel = path.relative(root, f).replace(/\\/g, "/");
    const sm = src.match(/<script setup>([\s\S]*?)<\/script>/);
    const line0 = sm ? src.slice(0, sm.index).split("\n").length : 1;
    const body = sm ? sm[1] : src;
    for (const p of selfCallProblems(maskComments(body), body)) bad.push(rel + ":" + (line0 + p.line - 1) + "  " + p.msg);
  }
  if (bad.length) throw new Error("\n      " + bad.join("\n      "));
});

t("T1c 自我保护：模板少传参数确实抓得到（还原 repPlaceholder 那次事故）", () => {
  const script = [
    "const cm = null;",
    'const repPlaceholder = (p, cm) => ((cm || {}).name || "") + "…";',
  ].join("\n");
  const tpl = [
    "<div>",
    '  <n-input :placeholder="repPlaceholder(cm)" />',
    '  <n-input :placeholder="repPlaceholder(p, cm)" />',
    "</div>",
  ].join("\n");
  const bad = templateArityProblems(maskComments(script), maskHtmlComments(tpl));
  if (bad.length !== 1) throw new Error("应恰好抓到 1 处，实际 " + bad.length);
  if (bad[0].line !== 2) throw new Error("应报在模板第 2 行，实际 " + bad[0].line);
});

t("T2 扫描覆盖面：至少检查到若干 vue 文件的模板", () => {
  const withTpl = files.filter((f) => /<template>/.test(fs.readFileSync(f, "utf8"))).length;
  if (withTpl < 5) throw new Error("只扫到 " + withTpl + " 个含模板的文件，正则可能失效");
});

t("T3 自我保护：argCountAt 的计数正确（含嵌套/字符串逗号）", () => {
  const s = 'f(a, g(b, c), "x,y", { k: 1 })';
  const open = s.indexOf("(");
  const n = argCountAt(s, open);
  if (n !== 4) throw new Error("应识别 4 个参数，实际 " + n);
  if (argCountAt("noArgs()", 6) !== 0) throw new Error("空括号应为 0");
});

t("T3b 自我保护：注释先被抹掉（JSDoc 里的示例调用不算调用）", () => {
  const s = 'foo(a); // bar(baz)\nqux(); /* p(q) */';
  const m = maskComments(s);
  if (m.length !== s.length) throw new Error("屏蔽后长度必须一致，否则行号会错");
  if (m.includes("bar") || m.includes("p(q)")) throw new Error("注释没抹干净：" + JSON.stringify(m));
  if (m.split("\n").length !== s.split("\n").length) throw new Error("换行被破坏");
});

t("T3c 自我保护：必填参数识别（解构算 1 个；默认值/rest/JSDoc undefined 视为可省）", () => {
  const code = [
    "/** @param {string|null|undefined} c  省略 → 全部 */",
    "function f(a, b, c) {}",
    "function g({ x, y }, z = 1) {}",
    "const h = (a, ...rest) => a;",
    "const k = (a, { b } = {}) => a;",
  ].join("\n");
  const need = requiredParams(code);
  if (need.f !== 2) throw new Error("f 应必填 2 个（c 在 JSDoc 里标了 undefined），实际 " + need.f);
  if (need.g !== 1) throw new Error("g 应必填 1 个（解构算一个、z 有默认值），实际 " + need.g);
  if (need.h !== 1) throw new Error("h 应必填 1 个（rest 可省），实际 " + need.h);
  if (need.k !== 1) throw new Error("k 应必填 1 个（解构带默认值可省），实际 " + need.k);
});

t("T3d 自我保护：真缺陷抓得到，注释与方法调用不误报", () => {
  const src = [
    "function p(x, y) { return x + y; }",
    "p(1, 2);",
    "p(1);",
    "// p(1)",
    "/* p(1) */",
    "const o = { p(x, y) { return 0; } };",
    "o.p(1);",
  ].join("\n");
  const bad = selfCallProblems(maskComments(src), src);
  if (bad.length !== 1) throw new Error("应恰好抓到 1 处，实际 " + bad.length + "：" + bad.map((b) => b.line + ":" + b.msg).join(" | "));
  if (bad[0].line !== 3) throw new Error("应报在第 3 行，实际 " + bad[0].line);
});

out.push("");
out.push("TOTAL " + (pass + fail) + "  PASS " + pass + "  FAIL " + fail);
fs.writeFileSync("arity-test.txt", out.join("\n"), "utf8");
console.log(out.join("\n"));
process.exit(fail ? 1 : 0);