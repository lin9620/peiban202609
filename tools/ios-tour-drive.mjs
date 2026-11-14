/* 轮 536/537 · iOS 会话页「连续多轮切换 + 输入」真渲染工装
 *   node tools/ios-tour-drive.mjs [--keep] [--json]
 *
 * 为什么必须再加这一条（dm-sheet-drive / ios-kb-drive 都在跑，却全绿）：
 * 那两条都只走**一遍**「键盘 → 表情 → 键盘」，而且每步都是脚本一次把视口按到终态。
 * 用户报的却是「多次点击跟输入之后」—— 第二轮、第三轮才坏。
 *
 * 轮 537 · **两种内核语义都要跑**。真机（2026-11-15 06:01 三张 ?kbdiag=1 照片）上
 * innerHeight 会从 549 掉到 422：线上 viewport 写了 interactive-widget=resizes-content，
 * 这版 Safari 照做了。此时 `inner − vv` 只剩 4px，`--kb-now` 恒 0 ——
 * 只按 overlay 模拟的工装**永远**复现不出「面板不收」和「键盘键点不动」。
 *
 * 断言四条（对着用户看见的东西，不对着内部变量）：
 *   T1 每一轮切回键盘落定后：面板必须**关着**（没有 wp-emoji-open、picker 不可见）
 *   T2 每一轮面板落定后：面板顶 = 输入行底，高度 = 键盘高 + 基线 17 − 工具栏(0..81)
 *   T3 所有「键盘态」里输入行停在同一个像素；所有「面板态」里也停在同一个像素（容差 4）
 *   T4 任何落定帧都不许出现「键盘在屏上（kbOn）且面板开着」
 */
import { spawnSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(root, "tools", "_iostour-dist");
const keep = process.argv.includes("--keep");
const asJson = process.argv.includes("--json");

const cfg = path.join(root, "tools", "_iostour.vite.config.mjs");
writeFileSync(cfg, `import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import path from "node:path";
const R = ${JSON.stringify(root)};
export default defineConfig({
  root: path.join(R, "tools", "dm-sheet-harness"),
  base: "./",
  plugins: [vue()],
  resolve: { alias: { "@": path.join(R, "src") } },
  define: { "process.env.NODE_ENV": '"production"' },
  build: { outDir: ${JSON.stringify(OUT)}, emptyOutDir: true, target: "es2019" },
});
`);
const b = spawnSync(process.execPath, [path.join(root, "node_modules", "vite", "bin", "vite.js"), "build", "--config", cfg],
  { cwd: root, encoding: "utf8" });
if (b.status !== 0) { console.error("HARNESS_BUILD_FAIL\n" + (b.stdout || "") + (b.stderr || "")); process.exit(1); }

/* MODE = "overlay"（经典 iOS：只有 vv 缩）| "resize"（本机：inner 也缩） */
const mkExpr = (MODE) => `(async () => {
  const MODE = ${JSON.stringify(MODE)};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 100 && !window.__ready; i++) await sleep(100);
  if (!window.__ready) return { error: "harness-not-ready", mode: MODE };

  const host = document.querySelector(".dm-vac");
  const sr = host && host.shadowRoot;
  if (!sr) return { error: "no-shadow-root", mode: MODE };
  const room = sr.querySelector(".vac-room-container");
  if (room) { room.click(); await sleep(800); }
  const col = sr.querySelector(".vac-col-messages");
  if (!col || getComputedStyle(col).display === "none") return { error: "room-not-opened", mode: MODE };

  const H = window.innerHeight, KB = 330, TB = 81;
  const page = document.querySelector(".dm-page--chat");
  const cssv = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const rows = [];

  const R = (el) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    const vtop = Math.round((window.visualViewport && window.visualViewport.offsetTop) || 0);
    const b = el.getBoundingClientRect();
    return {
      t: Math.round(b.top) - vtop, b: Math.round(b.bottom) - vtop, h: Math.round(b.height),
      shown: cs.display !== "none" && cs.visibility !== "hidden" && b.height > 1,
    };
  };
  const snap = (tag) => {
    const ta = sr.querySelector("textarea.vac-textarea");
    const foot = sr.querySelector(".vac-box-footer");
    const pk = sr.querySelector(".vac-emoji-picker");
    const pr = page ? page.getBoundingClientRect() : null;
    const wv = window.__wpVars || {};
    rows.push({
      tag,
      open: host.classList.contains("wp-emoji-open"),
      kbNow: Math.round(parseFloat(cssv("--kb-now")) || 0),
      kbOn: !!wv.kbOn,
      shrink: Math.round(wv.shrink || 0),
      panelH: Math.round(parseFloat(String(cssv("--kb-panel-h")).replace(/[^0-9.]/g, " ").trim()) || 0),
      pad: foot ? getComputedStyle(foot).paddingBottom : "-",
      pageH: pr ? Math.round(pr.height) : 0,
      ta: R(ta), pk: R(pk),
    });
  };
  const ease = (t) => t * t * (3 - 2 * t);
  const frames = async (N, fn) => { for (let i = 1; i <= N; i++) { fn(ease(i / N)); await sleep(20); } };
  /* overlay：布局视口不动，只有 vv 缩；resize：inner 和 vv 一起缩（真机语义） */
  const setVp = (inner, vv, top) => {
    if (MODE === "resize") __kbSimResize(inner, vv, top);
    else __kbSim(vv, top, 1);
  };
  const kbUp = async () => await frames(10, (e) => {
    if (MODE === "resize") {
      const inner = Math.round(H + ((H - KB) - H) * e);
      __kbSimResize(inner, inner - 4, 0);
    } else {
      const vv = Math.round(H + ((H - KB) - H) * e);
      __kbSim(vv, H - vv, 1);
    }
  });
  const kbDown = async () => await frames(10, (e) => {
    if (MODE === "resize") {
      const inner = Math.round((H - KB) + (H - (H - KB)) * e);
      __kbSimResize(inner, inner - 4, 0);
    } else {
      const vv = Math.round((H - KB) + (H - (H - KB)) * e);
      __kbSim(vv, H - vv, 1);
    }
  });

  setVp(H, H - TB, 0);
  await sleep(1700);
  snap("rest");

  const ta0 = sr.querySelector("textarea.vac-textarea");
  const ebtn = sr.querySelector("#room-footer .vac-emoji-wrapper .vac-svg-button")
    || sr.querySelector(".vac-emoji-wrapper .vac-svg-button");
  if (!ta0 || !ebtn) return { error: "no-node", mode: MODE };

  const tapInput = (ta) => {
    ta.dispatchEvent(new Event("touchstart", { bubbles: true, composed: true }));
    ta.dispatchEvent(new Event("click", { bubbles: true, composed: true }));
  };

  ta0.focus();
  await kbUp();
  await sleep(400); snap("kb0");

  const CYCLES = 3;
  for (let c = 1; c <= CYCLES; c++) {
    ebtn.click();
    await kbDown();
    await sleep(500); snap("panel" + c);

    ta0.value = "测试" + c;
    ta0.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(120); snap("typed" + c);

    tapInput(ta0);
    await sleep(400); snap("tap" + c);

    ebtn.click();
    await sleep(20); snap("press" + c);
    await kbUp();
    await sleep(600); snap("kbback" + c);
    await sleep(500); snap("kbend" + c);
  }
  return { w: window.innerWidth, h: H, kb: KB, tb: TB, cycles: CYCLES, mode: MODE, rows };
})()`;

const runs = [];
for (const mode of ["overlay", "resize"]) {
  const expr = path.join(root, `tools/_iostour-expr-${mode}.js`);
  writeFileSync(expr, mkExpr(mode));
  const r = spawnSync(process.execPath, [
    "tools/web-probe.mjs", `--serve=${OUT}`, "--url=/index.html",
    "--w=393", "--h=852", "--wait=3000", "--ua=ios", `--file=${expr}`,
  ], { cwd: root, encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  let data = null;
  try { data = JSON.parse(out.slice(out.indexOf("{"))); } catch (e) { /* 下面统一报 */ }
  runs.push({ mode, data, out });
  try { if (!keep) rmSync(expr, { force: true }); } catch (e) { /* 忽略 */ }
}

if (!keep) {
  for (const f of [OUT, cfg]) { try { rmSync(f, { recursive: true, force: true }); } catch (e) { /* 忽略 */ } }
}

const fails = [];
const near = (a, b, tol = 4) => Math.abs(a - b) <= tol;

for (const run of runs) {
  const data = run.data;
  if (!data || data.error) {
    fails.push(`[${run.mode}] HARNESS_ERROR: ${(data && data.error) || run.out.slice(-800)}`);
    continue;
  }
  const rows = data.rows;
  if (asJson) console.log(JSON.stringify({ mode: run.mode, rows }, null, 1));
  else {
    console.log(`\n── ${run.mode} ── viewport ${data.w}x${data.h} kb=${data.kb} tb=${data.tb} cycles=${data.cycles}`);
    console.log("tag".padEnd(11) + "open".padEnd(7) + "kbOn".padEnd(7) + "kbNow".padEnd(7)
      + "shrink".padEnd(8) + "输入行(屏)".padEnd(15) + "面板(屏)");
    for (const r0 of rows) {
      const ta = r0.ta ? `${r0.ta.t}..${r0.ta.b}` : "-";
      const pk = r0.pk && r0.pk.shown ? `${r0.pk.t}..${r0.pk.b}(${r0.pk.h})` : "-";
      console.log(String(r0.tag).padEnd(11) + (r0.open ? "OPEN" : "----").padEnd(7)
        + (r0.kbOn ? "UP" : "--").padEnd(7) + String(r0.kbNow).padEnd(7)
        + String(r0.shrink).padEnd(8) + ta.padEnd(15) + pk);
    }
  }

  const by = (n) => rows.find((x) => x.tag === n);
  const kbStates = [];
  const panelStates = [];

  for (let c = 1; c <= data.cycles; c++) {
    const panel = by("panel" + c);
    const kbback = by("kbback" + c);
    const kbend = by("kbend" + c);

    /* T1 · 切回键盘落定后，面板必须关掉 */
    for (const s of [kbback, kbend]) {
      if (!s) { fails.push(`[${run.mode}] 第 ${c} 轮: 没采到「切回键盘」的落定帧`); continue; }
      if (s.open) fails.push(`[${run.mode}] 第 ${c} 轮 ${s.tag}: 键盘已经起来，面板仍挂着 wp-emoji-open（kbOn=${s.kbOn} kbNow=${s.kbNow} shrink=${s.shrink}）`);
      if (s.pk && s.pk.shown) fails.push(`[${run.mode}] 第 ${c} 轮 ${s.tag}: 键盘已经起来，面板还画在 ${s.pk.t}..${s.pk.b}（${s.pk.h}px）`);
      if (s.ta) kbStates.push({ tag: s.tag, b: s.ta.b });
    }

    if (!panel) { fails.push(`[${run.mode}] 第 ${c} 轮: 没采到面板态`); continue; }
    if (!panel.open) fails.push(`[${run.mode}] 第 ${c} 轮 panel: 点表情之后面板没打开`);
    if (!panel.pk || !panel.pk.shown) fails.push(`[${run.mode}] 第 ${c} 轮 panel: 面板没画出来`);
    else {
      if (panel.ta && !near(panel.ta.b, panel.pk.t, 3)) {
        fails.push(`[${run.mode}] 第 ${c} 轮 panel: 输入行底 ${panel.ta.b} 与面板顶 ${panel.pk.t} 不齐（裂 ${Math.abs(panel.ta.b - panel.pk.t)}px）`);
      }
      const hi = data.kb + 17;
      const lo = hi - (data.tb || 0);
      if (panel.pk.h > hi + 4 || panel.pk.h < lo - 4) {
        fails.push(`[${run.mode}] 第 ${c} 轮 panel: 面板高 ${panel.pk.h}（合法区间 ${lo}..${hi}）`);
      }
    }
    if (panel.ta) panelStates.push({ tag: "panel" + c, b: panel.ta.b });
  }

  /* T3 · 同类状态必须落在同一个像素 */
  const cmp = (list, label) => {
    if (list.length < 2) return;
    const base0 = list[0].b;
    const bad = list.filter((x) => !near(x.b, base0));
    if (bad.length) {
      fails.push(`[${run.mode}] T3 ${label}态位置不一致（基准 ${base0}）: ` + bad.map((x) => `${x.tag} ${x.b}`).join(", "));
    }
  };
  cmp(kbStates, "键盘");
  cmp(panelStates, "面板");

  /* T4 · 任何落定帧都不许「键盘在屏上 + 面板开着」 */
  for (const r0 of rows) {
    if (r0.kbOn && r0.open && r0.pk && r0.pk.shown && r0.pk.t < 900) {
      fails.push(`[${run.mode}] ${r0.tag}: 键盘在屏上（kbOn, shrink=${r0.shrink}, kbNow=${r0.kbNow}），面板还开着（${r0.pk.t}..${r0.pk.b}）—— 两样同时在屏上`);
    }
  }
}

if (fails.length) {
  console.error(`\nios-tour-drive: ${fails.length} 条失败`);
  for (const f of fails) console.error("  · " + f);
  process.exit(1);
}
console.log(`\nios-tour-drive: 两种内核语义（overlay / resize）各 3 轮切换，全部断言通过`);
