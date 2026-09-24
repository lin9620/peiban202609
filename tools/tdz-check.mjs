/* 静态检查（轮 42 补）：immediate watch 同步执行的代码里，是否用到了**后面才声明的** const/let
 *   node tools/tdz-check.mjs   → problems=0；命中则 exit 1
 *
 * 背景（同类事故第二次）：immediate: true 会在 watch 那一行**同步**跑回调，
 * 而回调（或它调用的本文件 function 声明）若引用了本文件后面才声明的
 * const/let（典型：ref 状态），此时还在 TDZ 里 →
 *   ReferenceError: Cannot access 'ht' before initialization
 * setup 抛错 → App.vue 错误边界接管 → 整页变「这里好像有点小状况」。
 *   轮 34：/admin 白屏；轮 41：首页 + 漂流瓶列表（recPage 声明在 watch 之后）。
 * 构建 / undef-check / arity-test 都抓不到这类问题（不是未定义，是执行顺序），
 * 只有真挂载（page-smoke）会现形。这里把它提前到静态检查阶段。
 * 判据 = 顶层 watch(..., { immediate: true }) 的回调体里出现的标识符，
 *        其顶层 const/let 声明行号 > watch 行号 → 命中。
 * 说明：只查顶层 watch（函数体内注册的 watch 运行时早已过了模块初始化，不构成 TDZ）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(root, "src");

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(vue|js|mjs)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

/* 注释换成同长空白：行号/列位置保持原样，注释里提到的名字才不会误报 */
function blankComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\w])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));
}

/* 取 <script> 块内容 + 它前面占了几行（.vue）；.js 原样 */
function scriptOf(file, text) {
  if (!file.endsWith(".vue")) return { code: text, offset: 0 };
  const m = /<script[^>]*>([\s\S]*?)<\/script>/.exec(text);
  if (!m) return { code: "", offset: 0 };
  return { code: m[1], offset: text.slice(0, m.index).split("\n").length - 1 };
}

/* 从 s[open] 处的括号起找配对的右括号（跳过字符串/模板；注释已被清空） */
function matchPair(s, open) {
  let d = 0;
  let quote = null;
  let esc = false;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if ("([{".includes(c)) d++;
    else if (")]}".includes(c)) { d--; if (d === 0) return i; }
  }
  return -1;
}

/* 顶层逗号切参数（括号/字符串里的逗号不算） */
function splitArgs(s) {
  const out = [];
  let d = 0;
  let quote = null;
  let esc = false;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if ("([{".includes(c)) d++;
    else if (")]}".includes(c)) d--;
    else if (c === "," && d === 0) { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out;
}

const lineAt = (s, i) => s.slice(0, i).split("\n").length;


/* 取回调体（同步执行的部分）：内联箭头/内联 function，或本文件同名 function 声明的体 */
function bodyOf(clean, cbTxt) {
  const t = cbTxt.trim();
  const arrow = t.indexOf("=>");
  if (arrow >= 0) {
    const after = t.slice(arrow + 2).trim();
    if (after.startsWith("{")) return after.slice(1, after.lastIndexOf("}"));
    return after;                                       /* 表达式体：() => foo() */
  }
  if (t.indexOf("function") === 0) {
    const b = t.indexOf("{");
    return b >= 0 ? t.slice(b + 1, t.lastIndexOf("}")) : "";
  }
  /* 具名回调：函数声明有提升，注册时就执行其体 —— 体里引用后面的 const 一样崩 */
  const decl = new RegExp("function\\s+" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\(").exec(clean);
  if (!decl) return "";
  const head = clean.lastIndexOf("\n", decl.index);
  if (clean.slice(head + 1, decl.index).trim() !== "") return "";   /* 只认顶层函数声明 */
  const bodyStart = clean.indexOf("{", decl.index);
  const bodyEnd = bodyStart >= 0 ? matchPair(clean, bodyStart) : -1;
  return bodyStart >= 0 && bodyEnd > 0 ? clean.slice(bodyStart + 1, bodyEnd) : "";
}

/** 单文件分析：返回命中的 [{ line, name, declLine }]（行号为原文件行号） */
export function analyze(file, text) {
  const { code, offset } = scriptOf(file, text);
  if (!code) return [];
  const clean = blankComments(code);
  const bad = [];

  /* 顶层 const/let 绑定 → 行号（缩进 0 才算顶层） */
  const decl = new Map();
  clean.split("\n").forEach((ln, i) => {
    const m = /^(?:const|let)\s+([A-Za-z_$][\w$]*)/.exec(ln);
    if (m) decl.set(m[1], i + 1);                       /* script 块内的行号 */
  });

  const re = /\bwatch\s*\(/g;
  let m;
  while ((m = re.exec(clean)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = matchPair(clean, open);
    if (close < 0) continue;
    const lineStart = clean.lastIndexOf("\n", m.index) + 1;
    if (clean.slice(lineStart, m.index).trim() !== "") continue;      /* 只查顶层 watch */
    const args = splitArgs(clean.slice(open + 1, close));
    if (args.length < 3 || !/immediate\s*:\s*(true|!0)/.test(args[2])) continue;
    const watchLine = lineAt(clean, m.index);
    const body = bodyOf(clean, args[1]);
    if (!body) continue;
    for (const [name, line] of decl) {
      if (line <= watchLine) continue;                                /* 已初始化，安全 */
      if (new RegExp("(^|[^\\w$.])" + name + "\\b").test(body)) {
        bad.push({ line: offset + watchLine, name, declLine: offset + line });
      }
    }
  }
  return bad;
}

const invoked = !!process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;   /* 被 import 复用时只导出 analyze */

if (invoked && process.argv.includes("--selftest")) {
  const badSrc = `<script setup>
import { ref, watch } from "vue";
const a = ref(1);
watch([a], () => { page.value = 0; load(); }, { immediate: true });
const page = ref(0);
function load() { page.value = 1; }
</script>`;
  const goodSrc = `<script setup>
import { ref, watch } from "vue";
const a = ref(1);
const page = ref(0);
watch([a], () => { page.value = 0; }, { immediate: true });
</script>`;
  const late = analyze("bad.vue", badSrc);   /* load 是函数声明（提升）→ 只应报 page */
  const ok = analyze("good.vue", goodSrc);
  const t1 = late.length === 1 && late[0].name === "page";
  const t2 = ok.length === 0;
  console.log(`${t1 ? "PASS" : "FAIL"}  T1 真缺陷抓得到（${JSON.stringify(late)}）`);
  console.log(`${t2 ? "PASS" : "FAIL"}  T2 顺序正确不误报`);
  const n = (t1 ? 1 : 0) + (t2 ? 1 : 0);
  console.log(`\nTOTAL 2  PASS ${n}  FAIL ${2 - n}`);
  process.exit(n === 2 ? 0 : 1);
}

if (invoked) {
  const problems = [];
  for (const file of walk(SRC)) {
    const text = fs.readFileSync(file, "utf8");
    for (const b of analyze(file, text)) problems.push({ file: path.relative(root, file), ...b });
  }
  for (const p of problems) {
    console.log(`FAIL  ${p.file}:${p.line}  immediate 回调用了后面声明的 ${p.name}（声明在 ${p.declLine} 行）→ 会 TDZ 崩`);
  }
  console.log(`\nTDZ_DONE problems=${problems.length}`);
  process.exit(problems.length ? 1 : 0);
}

