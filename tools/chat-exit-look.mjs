/* 轮 522 · 退出会话「缩放」的组装级工装（真 CSS + 真 chatViewport，逐帧记列表几何）
 *   node tools/chat-exit-look.mjs
 *
 * 用户第 3 条反复回归三次，静态断言挡不住：真正坏掉的是「退场那 180ms 里列表的几何」，
 * 只有真渲染才看得见。这里量两件事，两件都必须恒定：
 *   · 列表 / 列表行：整段退场（含收尾那一帧）不许变宽、不许位移
 *   · 退场层（.dm-thread）：尺寸钉在进入时的矩形上（键盘态 484，不许长到整屏）
 * 两种场景各跑一遍：无键盘退出 / 键盘态（盒子 484）退出。
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(root, "tools", "_chat-exit-look-dist");
const cfg = path.join(root, "tools", "_chat-exit-look.vite.config.mjs");
const expr = path.join(root, "tools", "_chat-exit-look.expr.js");

writeFileSync(cfg, `import { defineConfig } from "vite";
export default defineConfig({
  root: ${JSON.stringify(path.join(root, "tools", "chat-exit-look-harness"))},
  base: "./",
  logLevel: "warn",
  build: { outDir: ${JSON.stringify(OUT)}, emptyOutDir: true, target: "es2019" },
});
`);
const b = spawnSync(process.execPath, [path.join(root, "node_modules", "vite", "bin", "vite.js"), "build", "--config", cfg],
  { cwd: root, encoding: "utf8" });
if (b.status !== 0) { console.error("BUILD_FAIL\n" + (b.stdout || "") + (b.stderr || "")); process.exit(1); }

writeFileSync(expr, `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 80 && !window.__ready; i++) await sleep(100);
  if (!window.__ready) return { error: "harness-not-ready" };
  await sleep(400);
  const out = { kb: null, plain: null };
  /* ① 无键盘退出 */
  window.__enter({ keyboard: false });
  await sleep(350);
  window.__exit({ release: true, freeze: true });
  await sleep(1000);
  out.plain = { after: window.__snap(), frames: window.__frames().slice() };
  /* ② 键盘态（盒子 484）退出 */
  window.__enter({ keyboard: true });
  await sleep(350);
  const beforeKb = window.__snap();
  window.__exit({ release: true, freeze: true });
  await sleep(1000);
  out.kb = { before: beforeKb, after: window.__snap(), frames: window.__frames().slice() };
  return out;
})()`);

const r = spawnSync(process.execPath, [
  "tools/web-probe.mjs", `--serve=${OUT}`, "--url=/index.html",
  "--w=393", "--h=852", "--wait=2200", `--file=${expr}`, "--timeout=30000",
], { cwd: root, encoding: "utf8", env: { ...process.env, MSYS2_ARG_CONV_EXCL: "--url" } });
const out = (r.stdout || "") + (r.stderr || "");
let data = null;
try { data = JSON.parse(out.slice(out.indexOf("{"))); } catch (e) { /* 下面报错 */ }
if (!data) { console.error("NO_JSON\n" + out.slice(-1500)); process.exit(1); }
if (data.error) { console.error("HARNESS_ERROR: " + data.error); process.exit(1); }

const f = (r) => r ? `[${r[0]},${r[1]} ${r[2]}x${r[3]}]` : "-";
const uniq = (fr, k) => [...new Set(fr.filter((x) => x.list).map((x) => JSON.stringify(x[k])))];
const fails = [];
const ok = (n, c, extra) => { if (!c) fails.push(n + (extra ? " — " + extra : "")); };

for (const [name, g] of [["无键盘", data.plain], ["键盘态", data.kb]]) {
  const fr = g.frames;
  console.log(`\n=== ${name} ===`);
  if (g.before) console.log("  进入后   list", f(g.before.list), "thread", f(g.before.thread));
  console.log("  逐帧取值 page", uniq(fr, "page").join(" "));
  console.log("            list", uniq(fr, "list").join(" "));
  console.log("            row0", uniq(fr, "row0").join(" "));
  console.log("          thread", uniq(fr, "thread").join(" "));
  console.log("          docH  ", uniq(fr, "docH").join(" "));
  console.log("        scrollY ", uniq(fr, "scrollY").join(" "));

  ok(`${name}：列表在整段退场里不许变宽/位移`, uniq(fr, "list").length === 1, uniq(fr, "list").join(" vs "));
  ok(`${name}：列表行几何必须恒定`, uniq(fr, "row0").length === 1, uniq(fr, "row0").join(" vs "));
  ok(`${name}：收尾后列表位置必须与退场中逐像素一致`,
    JSON.stringify(g.after.list) === JSON.stringify(fr.filter((x) => x.list).pop().list),
    `after=${f(g.after.list)}`);
  /* 页面盒子只允许在收尾那一帧之后变化（页面本身不可见），列表与行必须一致 */
  if (g.before) {
    /* 只比宽高：translateX 的 0→14 是退场动画本身，不算几何跳变 */
    const size = [...new Set(fr.filter((x) => x.list && x.thread[2] > 0).map((x) => x.thread[2] + "x" + x.thread[3]))];
    const want = g.before.thread[2] + "x" + g.before.thread[3];
    ok(`${name}：退场层尺寸必须钉住（不许从键盘态长到整屏）`,
      size.length === 1 && size[0] === want, `${size.join(" vs ")} / 期望 ${want}`);
  }
  ok(`${name}：收尾线程不再占位`, g.after.thread[2] === 0 || g.after.thread[3] === 0, f(g.after.thread));

  /* 帧序列：只在真正变化处打印 */
  let prev = null;
  for (const x of fr.filter((y) => y.list)) {
    const key = JSON.stringify([x.list, x.thread, x.docH]);
    if (key !== prev) {
      console.log("   ", String(x.t).padStart(6), "list", f(x.list), "row0", f(x.row0),
        "thread", f(x.thread), "docH", x.docH);
      prev = key;
    }
  }
}

console.log("\n=== 结论 ===");
if (fails.length) { for (const x of fails) console.log("FAIL", x); process.exitCode = 1; }
else console.log("PASS 退场全程列表几何不变、覆盖层高度钉住、收尾零位移");
rmSync(cfg, { force: true });
rmSync(expr, { force: true });
rmSync(OUT, { recursive: true, force: true });
