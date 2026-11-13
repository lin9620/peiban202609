/* 轮 533 · iOS「键盘 ↔ 表情」逐帧工装（真挂 DmVacChat）
 *   node tools/ios-kb-drive.mjs [--mode=tb|full] [--keep] [--json]
 *
 * 为什么必须要这一条，而 dm-sheet-drive 不够：
 * dm-sheet-drive 是「一步跳」——直接 __kbSim(522, 330) 把视口按到终态，量首尾两点。
 * 用户报的却全是**过程中**的那一下（「微小的跳动」「一闪」「窜一下」）。首尾都对、
 * 中间错，那种 bug 一步跳的工装永远看不见 —— 安卓那边轮 532 已经用逐帧抓过一次
 * （面板高被锁成中途值 279，差 21px），iOS 这边从来没做过。
 *
 * 这一版把 iOS 键盘动画按真机的两段式逐帧喂进去，每一帧都量输入行在屏幕上的位置：
 *
 *   段 A · 工具栏进出：键盘一动，Safari 底部工具栏先消失（vv 771 → 852，vtop 还是 0）。
 *          键盘收起时反过来，工具栏在键盘**收完之后**才回来。
 *   段 B · 键盘本身：vv 852 → 522 且 vtop 0 → 330（键盘贴着布局视口底，
 *          所以 vtop ≡ innerHeight − vv.height）。
 *
 * 两种 vv 语义都跑（真机上两代 Safari 表现不同，代码必须两种都对）：
 *   --mode=tb    无键盘时 vv = 852 − 81（工具栏扣掉可视高）—— iOS 15 后常见
 *   --mode=full  无键盘时 vv 也 = 852（工具栏纯覆盖层，不进 vv）
 *
 * 断言只有四条，全部对着「用户看见什么」：
 *   K1 键盘态、面板态、切回来之后，输入行底停在**同一个像素**（容差 4）
 *   K2 面板打开到切回键盘的**每一帧**，输入行位移 ≤ 4（逐帧零跳动）
 *   K3 面板顶 = 输入行底，面板高 = 键盘高
 *   K4 面板不跑到屏幕外（键盘态时允许藏在键盘后面）
 */
import { spawnSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(root, "tools", "_dmsheet-harness-dist");
const keep = process.argv.includes("--keep");
const asJson = process.argv.includes("--json");
const MODE = (process.argv.find((a) => a.startsWith("--mode=")) || "--mode=tb").split("=")[1];

/* 不指定 --mode 时**两种 vv 语义都跑**。
 *
 * 真机上两代 Safari 的读数不同：无键盘时 vv 可能是 852（工具栏纯覆盖层）也可能是
 * 771（工具栏扣掉可视高）。这一轮的核心 bug（键盘高被算成 249 而不是 330）只在
 * 后一种语义下出现 —— 而过去所有工装都只在 852 那种语义下跑过，所以一直是绿的。
 * 所以「两种都必须对」不是可选项，默认就双双验证。 */
if (!process.argv.some((a) => a.startsWith("--mode=")) && !process.env.__IOSKB_CHILD) {
  const modes = ["tb", "full"];
  const extra = [
    ...(process.argv.includes("--keep") ? ["--keep"] : []),
    ...(process.argv.includes("--json") ? ["--json"] : []),
  ];
  let bad = 0;
  for (const m of modes) {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), `--mode=${m}`, ...extra],
      { cwd: root, encoding: "utf8", env: { ...process.env, __IOSKB_CHILD: "1" } });
    process.stdout.write(r.stdout || "");
    process.stderr.write(r.stderr || "");
    if (r.status !== 0) bad++;
  }
  process.exit(bad ? 1 : 0);
}

const cfg = path.join(root, "tools", "_dmsheet.vite.config.mjs");
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
if (b.status !== 0) {
  console.error("HARNESS_BUILD_FAIL\n" + (b.stdout || "") + (b.stderr || ""));
  process.exit(1);
}

const expr = path.join(root, "tools", "_ioskb-expr.js");
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

  const H = window.innerHeight;
  const KB = 330;
  const TB = 81;
  const MODE = ${JSON.stringify(MODE)};
  const REST_VV = MODE === "tb" ? H - TB : H;

  const rows = [];
  const snap = (tag) => {
    const ta = sr.querySelector("textarea.vac-textarea");
    const foot = sr.querySelector(".vac-box-footer");
    const pk = sr.querySelector(".vac-emoji-picker");
    const vv = window.visualViewport || {};
    const vtop = Math.round(vv.offsetTop || 0);
    const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect();
      return { t: Math.round(b.top) - vtop, b: Math.round(b.bottom) - vtop, h: Math.round(b.height) }; };
    const page = document.querySelector(".dm-page--chat");
    const pr = page ? page.getBoundingClientRect() : null;
    rows.push({
      tag, vvH: Math.round(vv.height || 0), vtop,
      ta: r(ta), pk: r(pk),
      page: pr ? { t: Math.round(pr.top), h: Math.round(pr.height) } : null,
      pad: foot ? getComputedStyle(foot).paddingBottom : "-",
      cls: host.className.replace(/^dm-vac ?/, ""),
      wv: (window.__wpVars || null),
    });
  };

  /* 开机 = 工具栏展开（真机冷启动的样子）。等过 BASE_WINDOW_MS 再动手。 */
  __kbSim(REST_VV, 0, 1);
  await sleep(1700);
  snap("rest");

  const ta0 = sr.querySelector("textarea.vac-textarea");
  const ebtn = sr.querySelector("#room-footer .vac-emoji-wrapper .vac-svg-button")
    || sr.querySelector(".vac-emoji-wrapper .vac-svg-button");
  if (!ta0 || !ebtn) return { error: "no-node" };

  const ease = (t) => t * t * (3 - 2 * t);
  const frames = async (N, fn, tag) => {
    for (let i = 1; i <= N; i++) { fn(ease(i / N)); await sleep(20); snap(tag + i); }
  };
  const kbUp = async (tag) => {
    if (REST_VV < H) {
      await frames(4, (e) => __kbSim(Math.round(REST_VV + (H - REST_VV) * e), 0, 1), tag + "a");
    }
    await frames(10, (e) => { const vv = Math.round(H + (H - KB - H) * e); __kbSim(vv, H - vv, 1); }, tag + "b");
  };
  const kbDown = async (tag) => {
    await frames(10, (e) => { const vv = Math.round((H - KB) + (H - (H - KB)) * e); __kbSim(vv, H - vv, 1); }, tag + "a");
    if (REST_VV < H) {
      await frames(4, (e) => __kbSim(Math.round(H + (REST_VV - H) * e), 0, 1), tag + "b");
    }
  };

  ta0.focus();
  await kbUp("kb");
  await sleep(400); snap("kb-done");

  ebtn.click();
  await sleep(16); snap("em+16");
  await kbDown("em");
  await sleep(500); snap("panel");

  ebtn.click();
  await sleep(20); snap("re+20");
  await kbUp("re");
  await sleep(500); snap("kb-back");

  return { w: window.innerWidth, h: H, kb: KB, tb: TB, mode: MODE, restVv: REST_VV, rows };
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
if (asJson) console.log(JSON.stringify({ mode: data.mode, rows }, null, 1));
else {
  console.log(`mode=${data.mode} viewport ${data.w}x${data.h} kb=${data.kb} tb=${data.tb} restVv=${data.restVv}`);
  console.log("tag".padEnd(10) + "vvH".padEnd(6) + "vtop".padEnd(6) + "ta(屏)".padEnd(13)
    + "picker(屏)".padEnd(15) + "pad".padEnd(8) + "page(t/h)".padEnd(12) + "panel");
  for (const r0 of rows) {
    const ta = r0.ta ? `${r0.ta.t}..${r0.ta.b}` : "-";
    const pk = r0.pk ? `${r0.pk.t}..${r0.pk.b}` : "-";
    const pg = r0.page ? `${r0.page.t}/${r0.page.h}` : "-";
    console.log(String(r0.tag).padEnd(10) + String(r0.vvH).padEnd(6) + String(r0.vtop).padEnd(6)
      + ta.padEnd(13) + pk.padEnd(15) + String(r0.pad).padEnd(8) + pg.padEnd(12)
      + String((r0.wv || {}).panel || "-"));
  }
}

/* ── 断言 ──────────────────────────────────────────────────────── */
const fails = [];
const by = (n) => rows.find((x) => x.tag === n) || {};
const need = (n) => { const r0 = by(n); if (!r0.tag) fails.push(`${n}: 没走到这一步`); return r0; };
const kbDone = need("kb-done");
const panel = need("panel");
const kbBack = need("kb-back");

/* K1 · 三种落定态，输入行底必须同一个像素 */
{
  const a = kbDone.ta && kbDone.ta.b;
  const b = panel.ta && panel.ta.b;
  const c = kbBack.ta && kbBack.ta.b;
  if (a == null || b == null || c == null) fails.push("K1: 有三个落定态没量到输入行");
  else {
    if (Math.abs(a - b) > 4) fails.push(`K1: 键盘态输入行底 ${a} vs 面板态 ${b}（差 ${Math.abs(a - b)}px）—— 一按表情就跳`);
    if (Math.abs(a - c) > 4) fails.push(`K1: 键盘态 ${a} vs 切回来之后 ${c}（差 ${Math.abs(a - c)}px）—— 来回一趟没回到原处`);
  }
}

/* K2 · 从「面板刚开」到「键盘切回来」的每一帧，输入行都不许动。
 * 这正是用户说的「微小跳动 / 一闪 / 窜一下」能被量到的唯一方式。 */
{
  const from = rows.findIndex((x) => x.tag === "em+16");
  const to = rows.findIndex((x) => x.tag === "kb-back");
  if (from < 0 || to < 0 || to <= from) fails.push("K2: 面板开合的帧序列不完整");
  else {
    const seq = rows.slice(from, to + 1).filter((x) => x.ta);
    const base = seq[0].ta.b;
    const bad = seq.filter((x) => Math.abs(x.ta.b - base) > 4);
    if (bad.length) {
      fails.push(`K2: 切换途中输入行动了 ${bad.length} 帧 —— `
        + bad.slice(0, 6).map((x) => `${x.tag} ${x.ta.b}(${x.ta.b - base > 0 ? "+" : ""}${x.ta.b - base})`).join(", "));
    }
  }
}

/* K3 · 面板几何：顶 = 输入行底，高 = 键盘高 */
{
  if (!panel.pk) fails.push("K3: 面板态没量到面板");
  else {
    if (Math.abs(panel.pk.h - data.kb) > 8) fails.push(`K3: 面板高 ${panel.pk.h}（该 = 键盘 ${data.kb}）`);
    if (panel.ta && Math.abs(panel.ta.b - panel.pk.t) > 3) {
      fails.push(`K3: 输入行底 ${panel.ta.b} 与面板顶 ${panel.pk.t} 不齐（裂 ${Math.abs(panel.ta.b - panel.pk.t)}px）`);
    }
  }
}

/* K4 · 面板不许跑到屏幕上半部（键盘态时允许藏在键盘后面，那时面板根本没开） */
{
  const vis = rows.filter((x) => x.pk);
  for (const x of vis) {
    if (x.pk.t < 200) {
      fails.push(`K4: ${x.tag} 面板顶窜到屏幕 ${x.pk.t}（聊天记录被挤没）`);
      break;
    }
  }
}

if (fails.length) {
  console.error(`\nios-kb-drive[${data.mode}]: ` + fails.length + " 条失败");
  for (const f of fails) console.error("  · " + f);
  process.exit(1);
}
console.log(`\nios-kb-drive[${data.mode}]: 全部断言通过（输入行全程 ${panel.ta.b}，两种状态同一像素）`);
