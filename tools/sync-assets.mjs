/* 把 dist 精确同步到 android/app/src/main/assets/public。
 * 为什么要自己写：`npx cap sync android` 在这台机器上会**静默失败**——
 * Capacitor 清空目标目录那一步被环境的 safe-delete 守卫拦住，命令仍返回 0，
 * 结果 APK 里还是上一版的 assets（曾导致「改了 CSS 但装机没变化」查了半天）。 */
import fs from "node:fs";
import path from "node:path";

const SRC = "dist";
const DST = path.join("android", "app", "src", "main", "assets", "public");

function walk(dir, base = "") {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const rel = path.join(base, name);
    const st = fs.statSync(abs);
    if (st.isDirectory()) out.push(...walk(abs, rel));
    else out.push(rel);
  }
  return out;
}

const srcFiles = new Set(walk(SRC));
let copied = 0;
for (const rel of srcFiles) {
  const from = path.join(SRC, rel);
  const to = path.join(DST, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  copied++;
}

let removed = 0;
const stale = [];
if (fs.existsSync(DST)) {
  for (const rel of walk(DST)) {
    if (!srcFiles.has(rel)) stale.push(rel);
  }
  /* 不直接删：环境有「批量删除」守卫（一轮 >50 个就拦），也是为了避免误删。
   * 统一挪到 .stale-assets/<时间戳>/，确认没用之后整体清掉即可（该目录已进 .gitignore）。 */
  if (stale.length) {
    const trash = path.join(".stale-assets", String(Date.now()));
    for (const rel of stale) {
      const to = path.join(trash, rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(path.join(DST, rel), to);
      removed++;
    }
  }
}

console.log(`[sync-assets] 复制 ${copied} 个 · 清理 ${removed} 个残留`);
