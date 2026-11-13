/* 轮 532 · 安卓 resize 型内核「键盘动画期间面板高会不会被锁成中途值」
 *   node tools/kb-seq-drive.mjs [--dur=420]
 *
 * 为什么要有它：现有 androidbar-drive 是**一步跳**（inner 744 → 484 一次到位），
 * 而真机键盘是 744 → 700 → 640 → 580 → 520 → 484 一帧一帧缩的。
 * 轮 526 把 schedulePanelLock 从「每帧 clearTimeout 重设」改成「有定时器就不重设」，
 * 安卓上等于「从 kbUp 成立那一刻起算 180ms」，如果动画比 180ms 慢，
 * 定时器醒过来时键盘还没到位 → 面板高锁成中途值，之后又被纠正 → 肉眼一跳。
 * 这个工装就是拿逐帧序列把它逼出来：动画时长可调，默认 260ms，
 * 落到 420ms（MIUI 实测量级）就能看见 A 段锁成 279 再纠正回 300。
 */
import { spawnSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(root, "tools", "_kbseq-dist");
const keep = process.argv.includes("--keep");
const DUR = Number((process.argv.find((a) => a.startsWith("--dur=")) || "").split("=")[1]) || 260;

const cfg = path.join(root, "tools", "_kbseq.vite.config.mjs");
writeFileSync(cfg, `import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import path from "node:path";
const R = ${JSON.stringify(root)};
export default defineConfig({
  root: path.join(R, "tools", "wallbar-harness"),
  base: "./",
  plugins: [vue()],
  resolve: { alias: { "@": path.join(R, "src") } },
  define: { "process.env.NODE_ENV": '"production"' },
  build: { outDir: ${JSON.stringify(OUT)}, emptyOutDir: true, target: "es2019" },
});
`);

const b = spawnSync(process.execPath, [path.join(root, "node_modules", "vite", "bin", "vite.js"), "build", "--config", cfg],
  { cwd: root, encoding: "utf8" });
if (b.status !== 0) {
  console.error("HARNESS_BUILD_FAIL\n" + (b.stdout || "") + (b.stderr || ""));
  process.exit(1);
}

const expr = path.join(root, "tools", "_kbseq-expr.js");
writeFileSync(expr, `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 80 && !window.__ready; i++) await sleep(100);
  if (!window.__ready) return { error: "harness-not-ready" };

  /* 安卓 resize 型：inner 与 vv 一起缩，vv 常年比 inner 少 31px（小米样本） */
  const realInner = window.innerHeight;
  let fakeInner = realInner;
  Object.defineProperty(window, "innerHeight", { configurable: true, get: () => fakeInner });
  /* 桩模型：键盘态 inner 与 vv **一起缩**（小米样本：无键盘 innerH=vvH，
   * 键盘弹起 innerH=vvH=484）。31px 那条噪声不参与本次复现 ——
   * 这里要逼的是「锁定时机」，不是噪声。
   * 注意 show 里 vv 只用来显示，真实读数由 __kbSim 写进 fakeVV。 */

  const cssv = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const step = (inner) => {
    fakeInner = inner;
    if (typeof window.__kbSim === "function") window.__kbSim(inner, 0, 1);
    else window.dispatchEvent(new Event("resize"));
  };

  const barEl = () => document.querySelector(".cmt-main-bar");
  const rec = [];
  const snap = (tag) => {
    const bb = barEl();
    const pk = document.querySelector(".wp-composer-picker");
    const r = bb ? bb.getBoundingClientRect() : null;
    const pr = pk ? pk.getBoundingClientRect() : null;
    const w = window.__wpVars || {};
    rec.push({
      tag, inner: fakeInner, vv: fakeInner,
      panel: w.panel === undefined ? null : w.panel,
      panelCss: cssv("--kb-panel"),
      panelH: cssv("--kb-panel-h"),
      kbNow: cssv("--kb-now"),
      barBottom: r ? Math.round(r.bottom) : null,
      pickTop: pr ? Math.round(pr.top) : null,
      pickH: pr ? Math.round(pr.height) : null,
    });
  };

  /* 打开评论条 */
  document.querySelector('[data-entry="0"]').click();
  await sleep(400);
  const ta = document.querySelector(".cmt-main-bar textarea");
  if (ta) ta.focus();
  await sleep(80);
  snap("rest");

  const KB = 300;
  const runAnim = async (tag) => {
    const from = fakeInner;
    const to = realInner - KB;
    const t0 = performance.now();
    while (true) {
      const p = Math.min(1, (performance.now() - t0) / ${DUR});
      const inner = Math.round(from + (to - from) * p);
      if (inner !== fakeInner) step(inner);
      snap(tag + "@" + Math.round(performance.now() - t0));
      if (p >= 1) break;
      await sleep(16);
    }
    await sleep(160);
    snap(tag + "+160");
    await sleep(260);
    snap(tag + "+420");
    await sleep(400);
    snap(tag + "+820");
  };

  await runAnim("A");              /* 第一趟：冷启动把面板高锁出来 */
  /* 收键盘 */
  step(realInner);
  await sleep(700);
  snap("closed");
  /* 第二趟：热态（面板高已锁过）再弹一次 —— 用户反复切的就是这一趟 */
  await runAnim("B");

  /* 聚合：panel 值的每次变化（只看变化，别把 80 条原样吐出去） */
  const seq = (tag) => {
    const rows = rec.filter((x) => x.tag.startsWith(tag + "@"));
    const out = [];
    let prev = null;
    for (const r of rows) {
      if (r.panel !== prev) { out.push({ t: Number(r.tag.split("@")[1]), panel: r.panel, inner: r.inner }); prev = r.panel; }
    }
    return out;
  };
  return {
    w: window.innerWidth, h: realInner, dur: ${DUR},
    seqA: seq("A"), seqB: seq("B"),
    final: rec[rec.length - 1],
    tail: rec.filter((x) => /\\+|closed/.test(x.tag)),
  };
})()`);

const r = spawnSync(process.execPath, [
  "tools/web-probe.mjs", `--serve=${OUT}`, "--url=/index.html",
  "--w=393", "--h=852", "--wait=2500", `--file=${expr}`,
], { cwd: root, encoding: "utf8", env: { ...process.env, MSYS2_ARG_CONV_EXCL: "--url" } });

const out = (r.stdout || "") + (r.stderr || "");
let data = null;
try { data = JSON.parse(out.slice(out.indexOf("{"))); } catch (e) { /* 原样打出来 */ }
if (!data) { console.error("NO_JSON\n" + out.slice(-1500)); process.exit(1); }
if (data.error) { console.error("HARNESS_ERROR: " + data.error); process.exit(1); }

if (!keep) {
  try { rmSync(OUT, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  try { rmSync(cfg, { force: true }); } catch (e) { /* 忽略 */ }
  try { rmSync(expr, { force: true }); } catch (e) { /* 忽略 */ }
}

console.log(`viewport ${data.w}x${data.h}  键盘动画 ${data.dur}ms  键盘高 300`);
const show = (rows) => rows.map((x) => `${x.t}ms:panel=${x.panel}(inner=${x.inner})`).join("  ");
console.log("A 段 panel 轨迹: " + show(data.seqA));
console.log("B 段 panel 轨迹: " + show(data.seqB));
for (const x of data.tail) console.log(`  ${x.tag.padEnd(12)} inner=${x.inner} panel=${x.panel} panelH=${x.panelH || "-"} kbNow=${x.kbNow || "-"} barBottom=${x.barBottom} pick=${x.pickTop}..${x.pickTop + x.pickH}`);

/* ── 断言 ──────────────────────────────────────────────
 * 面板高要「一次到 300，全程不再变」。中途出现别的值就是肉眼那一跳。 */
const fails = [];
const seqA = data.seqA;
const seqB = data.seqB;
const finalPanel = data.final && data.final.panel;
if (!(finalPanel === 300)) fails.push(`最终面板高 ${finalPanel} ≠ 键盘高 300`);
const driftA = seqA.filter((x) => x.panel !== null && x.panel !== 300);
if (driftA.length) fails.push("A 段（冷启动首次弹键盘）面板高被锁成中途值：" + driftA.map((x) => x.t + "ms→" + x.panel).join(", "));
const drift = seqB.filter((x) => x.panel !== null && x.panel !== finalPanel);
if (drift.length) fails.push("B 段面板高被改过：" + drift.map((x) => `${x.t}ms→${x.panel}`).join(", "));

if (fails.length) {
  console.log("\nFAIL " + fails.length);
  for (const f of fails) console.log("  · " + f);
  process.exit(1);
}
console.log("\nPASS 面板高一次锁到 300，A/B 两段全程未变");
