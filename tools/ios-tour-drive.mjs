/* 轮 536 · iOS 会话页「连续多轮切换 + 输入」真渲染工装
 *   node tools/ios-tour-drive.mjs [--keep] [--json]
 *
 * 为什么必须再加这一条（dm-sheet-drive / ios-kb-drive 都在跑，却全绿）：
 * 那两条都只走**一遍**「键盘 → 表情 → 键盘」，而且每步都是脚本一次把视口按到终态。
 * 用户报的却是「多次点击跟输入之后」—— 第二轮、第三轮才坏。
 *
 * 实测（本工装第一版，2026-11-15）抓到的：
 *   第 1 轮切回键盘后，宿主**仍挂着 wp-emoji-open**、picker 节点还在 505..771；
 *   于是第 2 轮点「键盘键」实际执行的是「开面板」—— 状态与视觉反向，越点越乱。
 *   真机上这就是「面板和键盘同时在屏上」：一张是暖心墙，一张是会话。
 *
 * 断言四条（对着用户看见的东西，不对着内部变量）：
 *   T1 每一轮切回键盘落定后：面板必须**关着**（没有 wp-emoji-open、picker 不可见）
 *   T2 每一轮面板落定后：面板顶 = 输入行底，高度 = 键盘高 + 基线 17 − 工具栏(0..81)
 *   T3 所有「键盘态」里输入行停在同一个像素；所有「面板态」里也停在同一个像素（容差 4）
 *   T4 任何落定帧都不许出现「键盘在屏上（--kb-now > 12）且面板开着」
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

const expr = path.join(root, "tools", "_iostour-expr.js");
writeFileSync(expr, `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 100 && !window.__ready; i++) await sleep(100);
  if (!window.__ready) return { error: "harness-not-ready" };

  const host = document.querySelector(".dm-vac");
  const sr = host && host.shadowRoot;
  if (!sr) return { error: "no-shadow-root" };
  const room = sr.querySelector(".vac-room-container");
  if (room) { room.click(); await sleep(800); }
  const col = sr.querySelector(".vac-col-messages");
  if (!col || getComputedStyle(col).display === "none") return { error: "room-not-opened" };

  const H = window.innerHeight, KB = 330, TB = 81;
  const page = document.querySelector(".dm-page--chat");
  const cssv = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const rows = [];

  /* 屏幕坐标 = 布局坐标 − visualViewport.offsetTop（键盘态 iOS 会把可视视口整个推上去） */
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
    rows.push({
      tag,
      open: host.classList.contains("wp-emoji-open"),
      kbNow: Math.round(parseFloat(cssv("--kb-now")) || 0),
      panelH: Math.round(parseFloat(String(cssv("--kb-panel-h")).replace(/[^0-9.]/g, " ").trim()) || 0),
      pad: foot ? getComputedStyle(foot).paddingBottom : "-",
      pageH: pr ? Math.round(pr.height) : 0,
      ta: R(ta), pk: R(pk),
    });
  };
  const ease = (t) => t * t * (3 - 2 * t);
  const frames = async (N, fn) => { for (let i = 1; i <= N; i++) { fn(ease(i / N)); await sleep(20); } };
  const kbUp = async () => await frames(10, (e) => { const vv = Math.round(H + (H - KB - H) * e); __kbSim(vv, H - vv, 1); });
  const kbDown = async () => await frames(10, (e) => { const vv = Math.round((H - KB) + (H - (H - KB)) * e); __kbSim(vv, H - vv, 1); });

  __kbSim(H - TB, 0, 1);
  await sleep(1700);
  snap("rest");

  const ta0 = sr.querySelector("textarea.vac-textarea");
  const ebtn = sr.querySelector("#room-footer .vac-emoji-wrapper .vac-svg-button")
    || sr.querySelector(".vac-emoji-wrapper .vac-svg-button");
  if (!ta0 || !ebtn) return { error: "no-node" };

  /* 「面板开着点输入区」：真机上这一下会 focus + 收面板，是用户来回点的常见路径 */
  const tapInput = (ta) => {
    ta.dispatchEvent(new Event("touchstart", { bubbles: true, composed: true }));
    ta.dispatchEvent(new Event("click", { bubbles: true, composed: true }));
  };

  ta0.focus();
  await kbUp();
  await sleep(400); snap("kb0");

  const CYCLES = 3;
  for (let c = 1; c <= CYCLES; c++) {
    ebtn.click();                       /* 键盘 → 表情 */
    await kbDown();
    await sleep(500); snap("panel" + c);

    ta0.value = "测试" + c;             /* 输入 */
    ta0.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(120); snap("typed" + c);

    tapInput(ta0);                      /* 面板开着点输入区 */
    await sleep(400); snap("tap" + c);

    ebtn.click();                       /* 回键盘 */
    await sleep(20); snap("press" + c);
    await kbUp();
    await sleep(600); snap("kbback" + c);
    await sleep(500); snap("kbend" + c);
  }
  return { w: window.innerWidth, h: H, kb: KB, tb: TB, cycles: CYCLES, rows };
})()`);

const r = spawnSync(process.execPath, [
  "tools/web-probe.mjs", `--serve=${OUT}`, "--url=/index.html",
  "--w=393", "--h=852", "--wait=3000", "--ua=ios", `--file=${expr}`,
], { cwd: root, encoding: "utf8" });
const out = (r.stdout || "") + (r.stderr || "");
let data = null;
try { data = JSON.parse(out.slice(out.indexOf("{"))); } catch (e) { /* 下面统一报 */ }

if (!keep) {
  for (const f of [OUT, cfg, expr]) { try { rmSync(f, { recursive: true, force: true }); } catch (e) { /* 忽略 */ } }
}
if (!data || data.error) {
  console.error("HARNESS_ERROR: " + ((data && data.error) || out.slice(-1200)));
  process.exit(1);
}

const rows = data.rows;
if (asJson) console.log(JSON.stringify({ rows }, null, 1));
else {
  console.log(`viewport ${data.w}x${data.h} kb=${data.kb} tb=${data.tb} cycles=${data.cycles}`);
  console.log("tag".padEnd(11) + "open".padEnd(7) + "kbNow".padEnd(7) + "pad".padEnd(26)
    + "输入行(屏)".padEnd(15) + "面板(屏)");
  for (const r0 of rows) {
    const ta = r0.ta ? `${r0.ta.t}..${r0.ta.b}` : "-";
    const pk = r0.pk && r0.pk.shown ? `${r0.pk.t}..${r0.pk.b}(${r0.pk.h})` : "-";
    console.log(String(r0.tag).padEnd(11) + (r0.open ? "OPEN" : "----").padEnd(7)
      + String(r0.kbNow).padEnd(7) + String(r0.pad).padEnd(26) + ta.padEnd(15) + pk);
  }
}

/* ── 断言 ──────────────────────────────────────────────────────── */
const fails = [];
const by = (n) => rows.find((x) => x.tag === n);
const near = (a, b, tol = 4) => Math.abs(a - b) <= tol;
const kbStates = [];
const panelStates = [];

for (let c = 1; c <= data.cycles; c++) {
  const panel = by("panel" + c);
  const kbback = by("kbback" + c);
  const kbend = by("kbend" + c);

  /* T1 · 切回键盘落定后，面板必须关掉 */
  for (const s of [kbback, kbend]) {
    if (!s) { fails.push(`第 ${c} 轮: 没采到「切回键盘」的落定帧`); continue; }
    if (s.open) fails.push(`第 ${c} 轮 ${s.tag}: 键盘已经起来，面板仍挂着 wp-emoji-open（kbNow=${s.kbNow}）`);
    if (s.pk && s.pk.shown) fails.push(`第 ${c} 轮 ${s.tag}: 键盘已经起来，面板还画在 ${s.pk.t}..${s.pk.b}（${s.pk.h}px）`);
    if (s.ta) kbStates.push({ tag: s.tag, b: s.ta.b });
  }

  /* T2 · 面板态：顶 = 输入行底，高度落在合法区间 */
  if (!panel) { fails.push(`第 ${c} 轮: 没采到面板态`); continue; }
  if (!panel.open) fails.push(`第 ${c} 轮 panel: 点表情之后面板没打开`);
  if (!panel.pk || !panel.pk.shown) fails.push(`第 ${c} 轮 panel: 面板没画出来`);
  else {
    if (panel.ta && !near(panel.ta.b, panel.pk.t, 3)) {
      fails.push(`第 ${c} 轮 panel: 输入行底 ${panel.ta.b} 与面板顶 ${panel.pk.t} 不齐（裂 ${Math.abs(panel.ta.b - panel.pk.t)}px）`);
    }
    const hi = data.kb + 17;
    const lo = hi - (data.tb || 0);
    if (panel.pk.h > hi + 4 || panel.pk.h < lo - 4) {
      fails.push(`第 ${c} 轮 panel: 面板高 ${panel.pk.h}（合法区间 ${lo}..${hi}）`);
    }
  }
  if (panel.ta) panelStates.push({ tag: "panel" + c, b: panel.ta.b });
}

/* T3 · 同类状态必须落在同一个像素 —— 这正是「每切一次摆一下」的判据 */
{
  const cmp = (list, label) => {
    if (list.length < 2) return;
    const base = list[0].b;
    const bad = list.filter((x) => !near(x.b, base));
    if (bad.length) {
      fails.push(`T3 ${label}态位置不一致（基准 ${base}）: ` + bad.map((x) => `${x.tag} ${x.b}`).join(", "));
    }
  };
  cmp(kbStates, "键盘");
  cmp(panelStates, "面板");
}

/* T4 · 任何落定帧都不许「键盘在屏上 + 面板开着」 */
for (const r0 of rows) {
  if (r0.kbNow > 12 && r0.open && r0.pk && r0.pk.shown && r0.pk.t < 900) {
    fails.push(`${r0.tag}: 键盘占着 ${r0.kbNow}px，面板还开着（${r0.pk.t}..${r0.pk.b}）—— 两样同时在屏上`);
  }
}

if (fails.length) {
  console.error(`\nios-tour-drive: ${fails.length} 条失败`);
  for (const f of fails) console.error("  · " + f);
  process.exit(1);
}
console.log(`\nios-tour-drive: 全部断言通过（${data.cycles} 轮切换，键盘态输入行恒 ${kbStates[0] ? kbStates[0].b : "-"}）`);
