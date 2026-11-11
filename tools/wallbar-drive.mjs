/* 轮 504 · 暖心墙评论条几何实测（构建 harness → 无头 Edge 假 visualViewport → 量 rect）
 *   node tools/wallbar-drive.mjs [--keep]
 * 只量不改：这一轮先拿证据，再决定改哪儿。
 */
import { spawnSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(root, "tools", "_wallbar-harness-dist");
const keep = process.argv.includes("--keep");

const cfg = path.join(root, "tools", "wallbar-harness", "vite.harness.config.mjs");
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

const expr = path.join(root, "tools", "_wallbar-expr.js");
writeFileSync(expr, `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 80 && !window.__ready; i++) await sleep(100);
  if (!window.__ready) return { error: "harness-not-ready" };

  const R = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) };
  };
  const cssv = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const steps = [];
  const snap = (name) => {
    const bar = document.querySelector(".cmt-main-bar");
    const pk = document.querySelector(".wp-composer-picker");
    const vv = window.visualViewport || {};
    steps.push({
      name,
      vv: [Math.round(vv.height || 0), Math.round(vv.offsetTop || 0)],
      inner: window.innerHeight,
      visBottom: Math.round((vv.offsetTop || 0) + (vv.height || window.innerHeight)),
      kb: cssv("--kb-h"), panelH: cssv("--kb-panel-h"), kbLast: cssv("--kb-last"),
      bar: R(bar), picker: R(pk),
      inlineTop: bar ? bar.style.top : "",
      barCls: bar ? bar.className : "",
    });
  };

  snap("rest");
  document.querySelector('[data-entry="0"]').click();
  await sleep(500);
  snap("bar-open");

  /* iOS：键盘 330，可视视口缩到 522，布局视口不动 */
  const H = window.innerHeight;
  __kbSim(H - 330, 0);
  await sleep(700);
  snap("kb330");

  /* 点表情：面板贴底（组件会 blur + 归零让位） */
  document.querySelector(".cmt-main-bar .wp-composer-ico.is-emoji").click();
  await sleep(900);
  snap("panel");

  /* 面板里最后一排 emoji 有没有被切：拿 shadow 里的最后一个按钮量 */
  let lastEmoji = null;
  try {
    const host = document.querySelector(".wp-composer-picker emoji-picker");
    const sr = host && host.shadowRoot;
    const btns = sr ? sr.querySelectorAll("button.emoji") : [];
    if (btns.length) {
      const r = btns[btns.length - 1].getBoundingClientRect();
      lastEmoji = { bottom: Math.round(r.bottom), top: Math.round(r.top) };
    }
  } catch (e) { /* shadow 结构变了就跳过 */ }
  steps[steps.length - 1].lastEmoji = lastEmoji;

  /* 面板 → 键盘 */
  document.querySelector(".cmt-main-bar .wp-composer-ico.is-emoji").click();
  await sleep(1400);
  snap("back-to-kb");

  /* 收键盘 */
  __kbSim(H, 0);
  await sleep(600);
  snap("kb-hide");

  /* iOS 把可视视口整个上推（vv.offsetTop > 0） */
  __kbSim(H - 330, 330);
  await sleep(700);
  snap("pushed");

  return {
    dpr: window.devicePixelRatio,
    w: window.innerWidth, h: window.innerHeight,
    steps,
  };
})()`);

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith("--" + name + "="));
  return hit ? hit.split("=").slice(1).join("=") : dflt;
};
const W = arg("w", "393");
const H = arg("h", "852");

const r = spawnSync(process.execPath, [
  "tools/web-probe.mjs", `--serve=${OUT}`, "--url=/index.html",
  `--w=${W}`, `--h=${H}`, "--wait=2500", `--file=${expr}`,
], { cwd: root, encoding: "utf8", env: { ...process.env, MSYS2_ARG_CONV_EXCL: "--url" } });

const out = (r.stdout || "") + (r.stderr || "");
let data = null;
try { data = JSON.parse(out.slice(out.indexOf("{"))); } catch (e) { /* 下面原样打出来 */ }

if (!data) {
  console.error("NO_JSON\n" + out.slice(-1200));
  process.exit(1);
}
if (data.error) { console.error("HARNESS_ERROR: " + data.error); process.exit(1); }

console.log(`viewport ${data.w}x${data.h}`);
for (const s of data.steps) {
  const b = s.bar, p = s.picker;
  console.log(
    `${s.name.padEnd(12)} vv=${String(s.vv[0]).padStart(3)}+${String(s.vv[1]).padStart(3)} visB=${String(s.visBottom).padStart(3)}`
    + ` kb=${(s.kb || "-").padEnd(6)} panelH=${(s.panelH || "-").padEnd(6)} kbLast=${(s.kbLast || "-").padEnd(6)}`
    + ` bar=${b ? b.top + ".." + b.bottom + "(" + b.h + ")" : "-"}`
    + ` picker=${p ? p.top + ".." + p.bottom + "(" + p.h + ")" : "-"}`
    + (s.lastEmoji ? ` lastEmoji=${s.lastEmoji.top}..${s.lastEmoji.bottom}` : "")
    + (s.inlineTop ? ` inlineTop=${s.inlineTop}` : "")
    + (s.barCls && s.barCls !== "cmt-main-bar" ? ` cls=${s.barCls}` : "")
  );
}

/* ── 断言（用户两张截图 = 两条硬约束）─────────────────────────────
 * ① 条永远贴在**可视区底**，不许跑到页面顶部、也不许钻到键盘底下；
 * ② 面板整块落在可视区内，最后一排不许被底部工具栏切掉。 */
const fails = [];
const step = (n) => data.steps.find((s) => s.name === n);
const near = (a, b, tol = 3) => Math.abs(a - b) <= tol;

for (const s of data.steps) {
  if (!s.bar) continue;
  if (s.bar.top < -1) fails.push(`${s.name}: 条越过屏幕顶部（top=${s.bar.top}）`);
  if (!near(s.bar.bottom, s.visBottom)) fails.push(`${s.name}: 条没贴可视区底（bar.bottom=${s.bar.bottom} visBottom=${s.visBottom}）`);
}
const kb = step("kb330");
if (kb && !near(kb.bar.bottom, kb.visBottom)) fails.push("kb330: 键盘弹起后条没跟着上移");
const panel = step("panel");
if (!panel) fails.push("panel: 没走到面板那一步");
else if (!panel.picker) fails.push("panel: 面板没出现");
else {
  if (panel.picker.bottom > panel.visBottom + 2) {
    fails.push(`panel: 面板底部越过可视区（picker.bottom=${panel.picker.bottom} visBottom=${panel.visBottom}）`);
  }
  if (panel.picker.top < 0) fails.push(`panel: 面板顶部在屏幕外（top=${panel.picker.top}）`);
  if (panel.bar.bottom > panel.visBottom + 2) fails.push("panel: 条压在面板下沿之外");
}
const back = step("back-to-kb");
if (back && !(parseFloat(back.kb) > 0)) {
  fails.push(`back-to-kb: 面板收完回键盘后 --kb-h 还是 ${back.kb}（页面不让位）`);
}
const pushed = step("pushed");
if (pushed && !near(pushed.bar.bottom, pushed.visBottom)) fails.push("pushed: iOS 上推可视视口后条没贴住可见底");

if (fails.length) {
  console.error("\nWALLBAR FAIL");
  for (const f of fails) console.error("  · " + f);
  process.exitCode = 1;
} else {
  console.log("\nwallbar-drive: 全部断言通过");
}

if (!keep) {
  rmSync(OUT, { recursive: true, force: true });
  rmSync(expr, { force: true });
  rmSync(cfg, { force: true });
}
