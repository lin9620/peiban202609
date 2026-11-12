/* 轮 517 · 「退出会话 → 列表」接管拆除工装
 *   node tools/chat-exit-drive.mjs [--keep]
 *
 * 断言的是**退出那一帧**（同一个 tick，巡检还没跑过）页面是否已经交还给文档流。
 * 只看几何与类，不猜实现：
 *   · html.wp-chat-fix 必须摘（CSS 里它带 height:100%;overflow:hidden）
 *   · .dm-page 的内联 position/height/width/overflow 必须清空
 *   · 列表必须重新可见、文档必须能滚（scrollHeight > clientHeight）
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { writeFileSync, rmSync } from "node:fs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(root, "tools", "_chat-exit-harness-dist");
const keep = process.argv.includes("--keep");

const cfg = path.join(root, "tools", "_chat-exit.vite.config.mjs");
const R = JSON.stringify(root);
writeFileSync(cfg, `import { defineConfig } from "vite";
export default defineConfig({
  root: ${JSON.stringify(path.join(root, "tools", "chat-exit-harness"))},
  base: "./",
  build: { outDir: ${JSON.stringify(OUT)}, emptyOutDir: true, target: "es2019" },
});
`);
const b = spawnSync(process.execPath, [path.join(root, "node_modules", "vite", "bin", "vite.js"), "build", "--config", cfg],
  { cwd: root, encoding: "utf8" });
if (b.status !== 0) {
  console.error("BUILD_FAIL\n" + (b.stdout || "") + (b.stderr || ""));
  process.exit(1);
}

const expr = path.join(root, "tools", "_chat-exit-expr.js");
writeFileSync(expr, `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 80 && !window.__ready; i++) await sleep(100);
  if (!window.__ready) return { error: "harness-not-ready" };

  const rows = [];
  const put = (name, s) => rows.push(Object.assign({ name }, s));

  put("enter", window.__snap());

  /* ① 旧行为：退出时**不**调 release —— 复现用户看到的那 0~250ms */
  put("exit-no-release", window.__exit(false));
  await sleep(320);                       /* 等 250ms 巡检兜底 */
  put("exit-after-poll", window.__snap());

  /* ② 重新进会话，再用新行为退出（同帧 release） */
  put("enter-2", window.__enter());
  put("exit-release", window.__exit(true));

  return { rows };
})()`);

const r = spawnSync(process.execPath, [
  "tools/web-probe.mjs", `--serve=${OUT}`, "--url=/index.html",
  "--w=393", "--h=852", "--wait=2000", `--file=${expr}`,
], { cwd: root, encoding: "utf8", env: { ...process.env, MSYS2_ARG_CONV_EXCL: "--url" } });

const out = (r.stdout || "") + (r.stderr || "");
let data = null;
try { data = JSON.parse(out.slice(out.indexOf("{"))); } catch (e) { /* 下面报错 */ }
if (!data) { console.error("NO_JSON\n" + out.slice(-1500)); process.exit(1); }
if (data.error) { console.error("HARNESS_ERROR: " + data.error); process.exit(1); }

if (!keep) {
  try { rmSync(OUT, { recursive: true, force: true }); } catch (e) { /* 留着不影响结论 */ }
  try { rmSync(cfg, { force: true }); } catch (e) { /* 同上 */ }
  try { rmSync(expr, { force: true }); } catch (e) { /* 同上 */ }
}

const s = (v) => (v === true ? "on" : v === false ? "off" : v);
for (const r0 of data.rows) {
  console.log(
    String(r0.name).padEnd(18)
    + ` fix=${s(r0.fix).padEnd(4)} page=${(r0.pagePos || "-").padEnd(8)}`
    + ` h=${(r0.pageH || "-").padEnd(8)} w=${(r0.pageW || "-").padEnd(5)} ov=${(r0.pageOv || "-").padEnd(8)}`
    + ` 列表=${(r0.listDisplay || "-").padEnd(6)} 列表高=${r0.listRect ? r0.listRect.h : "-"}`
    + ` 文档=${r0.docScrollH}/${r0.docClientH}`
    + ` thread=${r0.threadIn ? "在" : "无"}`
  );
}

const by = (n) => data.rows.find((x) => x.name === n);
const fails = [];
const ok = (name, cond, extra) => { if (!cond) fails.push(name + (extra ? " — " + extra : "")); };

const enter = by("enter");
ok("进会话确实接管了（前提条件）",
  enter && enter.fix === true && enter.pagePos === "fixed",
  `fix=${enter && enter.fix} pos=${enter && enter.pagePos}`);

/* 证据：旧行为在巡检之前一定是锁着的。这条红了说明「现场」没复现出来，结论不作数。 */
const old = by("exit-no-release");
ok("【证据】不 release 时退出那一帧仍锁着（这就是用户看到的那一下）",
  old && old.fix === true && old.pagePos === "fixed",
  `fix=${old && old.fix} pos=${old && old.pagePos}`);

const poll = by("exit-after-poll");
ok("【对照】巡检兜底之后会自己清（说明不是永久坏，是晚了 0~250ms）",
  poll && poll.fix === false && poll.pagePos === "",
  `fix=${poll && poll.fix}`);

/* 修复的判据：退出那一帧就干净，且列表恢复可见、文档恢复可滚 */
const rel = by("exit-release");
ok("退出那一帧就摘掉 wp-chat-fix", rel && rel.fix === false, `fix=${rel && rel.fix}`);
ok("退出那一帧就清空内联 fixed/height/width",
  rel && rel.pagePos === "" && rel.pageH === "" && rel.pageW === "",
  `pos=${rel && rel.pagePos} h=${rel && rel.pageH} w=${rel && rel.pageW}`);
ok("退出那一帧列表就可见", rel && rel.listDisplay !== "none", `display=${rel && rel.listDisplay}`);
ok("退出那一帧文档就恢复可滚（列表比一屏高）",
  rel && rel.docScrollH > rel.docClientH + 40, `文档=${rel && rel.docScrollH}/${rel && rel.docClientH}`);

if (fails.length) {
  console.error(`\nchat-exit-drive: ${fails.length} 条失败`);
  for (const f of fails) console.error("  ✗ " + f);
  process.exit(1);
}
console.log("\nchat-exit-drive: 全部断言通过");
