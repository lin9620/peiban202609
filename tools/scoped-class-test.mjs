#!/usr/bin/env node
/**
 * 跨组件复用 scoped 类名检查（轮447补）
 *
 * 由来：/following 复用了收藏页的 .favpage-head / .favpage-back / .favpage-refresh，
 * 但那些样式写在 FavoritesView 的 <style scoped> 里 —— Vue 会给 scoped 样式加
 * data-v-xxx 属性选择器，别的组件一条都拿不到。结果是「←」「标题」「↻」退化成
 * 块级堆叠，标题下面孤零零挂个刷新钮。
 *
 * 这类 bug **编译期完全查不出**（类名合法、CSS 语法合法、组件能渲染），
 * 只能靠肉眼在真机/浏览器里看见 —— 所以钉成测试。
 *
 * 判定：
 *   类名在「别的组件」的 scoped 里有定义，但在全局 css 和本组件 scoped 里都没有 → 报错。
 *   全局 css 里有 → 放行（全局样式对所有组件生效）。
 *   谁都没定义 → 不报（可能是布局类、动态类、第三方组件内部类，误报率高）。
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "src");

let pass = 0;
const fails = [];
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fails.push(`${name}${detail ? " — " + detail : ""}`); console.log(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
}

/* ── 1. 收集所有 .vue ── */
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".vue")) out.push(p);
  }
  return out;
}
const files = walk(SRC).map((p) => path.relative(ROOT, p).replace(/\\/g, "/"));

/* ── 2. 全局 css 里的类名（src 下所有独立 .css，组件内的 scoped 不算） ── */
const globalClasses = new Set();
const cssFiles = (function walkCss(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkCss(p, out);
    else if (e.name.endsWith(".css")) out.push(p);
  }
  return out;
})(SRC);
for (const abs of cssFiles) {
  for (const m of fs.readFileSync(abs, "utf8").matchAll(/\.([a-zA-Z][\w-]*)/g)) globalClasses.add(m[1]);
}

/* ── 3. 每个文件：模板类名 + scoped 类名 ── */
const pick = (s, re) => { const m = s.match(re); return m ? m[0] : ""; };
const scopedOf = new Map();     // file -> Set(class)
const usedOf = new Map();       // file -> Set(class)
const scopedFiles = new Map();  // class -> Set(file)

for (const rel of files) {
  const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
  const tpl = pick(src, /<template>[\s\S]*<\/template>/);
  const styles = src.match(/<style[^>]*>[\s\S]*?<\/style>/g) || [];
  const scopedBlocks = styles.filter((b) => /<style[^>]*\bscoped\b/.test(b));

  const used = new Set();
  /* 只认静态 class="..." 和 :class="{...}"；必须排除 :class="..."，
     否则会把表达式里的变量名（v-for 的 sm、:class 的 over）当成类名 → 大面积误报。 */
  for (const m of tpl.matchAll(/(?<!:)class="([^"]*)"/g)) {
    m[1].split(/\s+/).forEach((c) => { if (/^[a-zA-Z][\w-]*$/.test(c)) used.add(c); });
  }
  for (const m of tpl.matchAll(/:class="(\{[^}]*\})"/g)) {
    for (const k of m[1].matchAll(/'([a-zA-Z][\w-]*)'/g)) used.add(k[1]);
    for (const k of m[1].matchAll(/(?:^|[{,]\s*)([a-zA-Z][\w-]*)\s*:/g)) used.add(k[1]);
  }
  usedOf.set(rel, used);

  const sc = new Set();
  for (const b of scopedBlocks) for (const m of b.matchAll(/\.([a-zA-Z][\w-]*)/g)) sc.add(m[1]);
  scopedOf.set(rel, sc);
  for (const c of sc) {
    if (!scopedFiles.has(c)) scopedFiles.set(c, new Set());
    scopedFiles.get(c).add(rel);
  }
}

/* ── 4. 找跨组件泄漏 ── */
const leaks = [];
for (const [rel, used] of usedOf) {
  for (const c of used) {
    if (c.startsWith("n-") || c.startsWith("van-")) continue;   // 第三方组件内部类
    if (globalClasses.has(c)) continue;                          // 全局有 → 生效
    const owners = scopedFiles.get(c);
    if (!owners || !owners.size) continue;                       // 谁都没定义 → 不报
    if (!owners.has(rel)) {
      leaks.push({ file: rel, cls: c, owners: [...owners].join(", ") });
    }
  }
}

ok("S1 没有「跨组件复用 scoped 类名」的样式泄漏",
  leaks.length === 0,
  leaks.slice(0, 6).map((l) => `${l.file} 用了 .${l.cls}，但它只在 ${l.owners} 的 scoped 里`).join(" | "));

/* ── 5. 钉住本次修复本身（防止有人把样式又搬回 scoped） ── */
const css = fs.readFileSync(path.join(ROOT, "src/style.css"), "utf8");
for (const c of ["favpage-head", "favpage-back", "favpage-refresh", "favpage-signin"]) {
  ok(`S2 .${c} 定义在全局 style.css（收藏页与关注页共用）`,
    new RegExp(`\\.${c}[\\s{,:]`).test(css));
}

if (fails.length) {
  console.log(`\nFAIL ${fails.length} 条：`);
  for (const f of fails) console.log("  ✗", f);
}
console.log(`\nscoped-class-test: ${pass} pass, ${fails.length} fail`);
process.exit(fails.length ? 1 : 0);
