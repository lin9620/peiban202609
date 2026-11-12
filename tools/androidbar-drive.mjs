/* 安卓 resize 型内核 · 暖心墙「键盘 ↔ 表情」切换轨迹（真渲染）
 *   node tools/androidbar-drive.mjs [--keep]
 *
 * 为什么单独有一个（与 wallbar-drive 的分工）：
 *   wallbar-drive 只伪造 visualViewport —— 那是 **iOS overlay 型**（键盘浮在页面上、
 *   布局视口不缩）。安卓 / 小米是 **resize 型**：键盘一弹 window.innerHeight 也缩，
 *   100dvh 跟着缩，--kb-h 与 --kbb 恒为 0。拿 iOS 模型测安卓，测出来的全是假现场
 *   （轮 512 就是这么被用户抓到的：「安卓本来好好的，你改苹果之后全是问题」）。
 *
 * 锁的是两条硬约束（都来自用户原话「切表情/键盘有一闪的东西」）：
 *   A1 开面板后第一帧，让位就必须到位 —— 面板是瞬现的（组件直插节点，无过渡），
 *      让位若走 .22s，输入条会先被面板盖住、再从屏底爬上来。
 *   A2 关面板那一瞬让位不许塌 —— 面板还在淡出、键盘还没起来，
 *      一塌就是屏幕底部 300px 空白。必须由 .wp-kb-swap 钉住，等 innerHeight 缩了再摘。
 */
import { spawnSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(root, "tools", "_androidbar-harness-dist");
const keep = process.argv.includes("--keep");

const cfg = path.join(root, "tools", "_androidbar.vite.config.mjs");
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

const expr = path.join(root, "tools", "_androidbar-expr.js");
writeFileSync(expr, `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 80 && !window.__ready; i++) await sleep(100);
  if (!window.__ready) return { error: "harness-not-ready" };

  /* ── 安卓 resize 型视口桩：inner 与 vv 一起缩，offsetTop 恒 0 ── */
  const realInner = window.innerHeight;
  let fakeInner = realInner;
  Object.defineProperty(window, "innerHeight", { configurable: true, get: () => fakeInner });
  const cssv = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

  const setVp = (inner, vvH) => {
    fakeInner = inner;
    const vv = window.visualViewport;
    if (vv) {
      Object.defineProperty(vv, "height", { configurable: true, get: () => vvH });
      Object.defineProperty(vv, "offsetTop", { configurable: true, get: () => 0 });
      Object.defineProperty(vv, "scale", { configurable: true, get: () => 1 });
      vv.dispatchEvent(new Event("resize"));
      vv.dispatchEvent(new Event("scroll"));
    }
    window.dispatchEvent(new Event("resize"));
  };

  const barEl = () => document.querySelector(".cmt-main-bar");
  const pkEl = () => document.querySelector(".wp-composer-picker");
  const R = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { t: Math.round(r.top), b: Math.round(r.bottom) }; };
  const padOf = (el) => (el ? Math.round(parseFloat(getComputedStyle(el).paddingBottom) || 0) : -1);

  const rows = [];
  const snap = (name) => {
    const bb = barEl();
    rows.push({
      name, inner: fakeInner, vvH: Math.round((window.visualViewport || {}).height || 0),
      kb: cssv("--kb-h"), kbb: cssv("--kbb"), panelH: cssv("--kb-panel-h"), kbLast: cssv("--kb-last"),
      bar: R(bb), picker: R(pkEl()), pad: padOf(bb),
      cls: bb ? bb.className : "",
    });
  };

  const H = realInner;
  const KB = 300;

  snap("rest");
  document.querySelector('[data-entry="0"]').click();
  await sleep(500);
  const ta = document.querySelector(".cmt-main-bar textarea");
  if (ta) ta.focus();
  await sleep(60);
  snap("bar-open");

  /* 键盘弹起（安卓：inner 也缩） */
  setVp(H - KB, H - KB);
  await sleep(400);
  snap("kb");

  /* 点表情：键盘收起 + 面板打开 */
  const emo = document.querySelector(".cmt-main-bar .wp-composer-ico.is-emoji");
  if (emo) emo.click();
  setVp(H, H);
  for (const ms of [0, 20, 60, 120, 220, 400]) {
    if (ms) await sleep(ms);
    snap("to-panel+" + ms);
  }
  await sleep(500);
  snap("panel");
  const panelPad = padOf(barEl());
  /* 目标值取**面板自己的高度**，不能取实现写进 padding 的那个数（那样等于自己跟自己比，
     实现写多少都绿）。轮 513 就是这么漏掉「量内层自定义元素只有 265、容器是 300」的。 */
  const pk = document.querySelector(".wp-composer-picker");
  const panelReal = pk ? Math.round(pk.getBoundingClientRect().height) : 0;

  /* 点键盘键：面板收起 + 键盘弹起 */
  const kbBtn = document.querySelector(".cmt-main-bar .wp-composer-ico.is-emoji");
  if (kbBtn) kbBtn.click();
  await sleep(10);
  snap("kb-press+10");
  setVp(H - KB, H - KB);
  for (const ms of [20, 60, 120, 220, 350]) {
    await sleep(ms);
    snap("to-kb+" + ms);
  }
  await sleep(600);
  snap("kb-again");

  return { w: window.innerWidth, h: H, panelPad, panelReal, steps: rows };
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
  try { rmSync(OUT, { recursive: true, force: true }); } catch (e) { /* 回收站不可用时留着，不影响结论 */ }
  try { rmSync(cfg, { force: true }); } catch (e) { /* 同上 */ }
  try { rmSync(expr, { force: true }); } catch (e) { /* 同上 */ }
}

console.log(`viewport ${data.w}x${data.h}`);
for (const s of data.steps) {
  console.log(
    s.name.padEnd(13)
    + ` inner=${String(s.inner).padStart(4)} vv=${String(s.vvH).padStart(4)}`
    + ` kb=${(s.kb || "-").padEnd(6)} kbb=${(s.kbb || "-").padEnd(6)}`
    + ` panelH=${(s.panelH || "-").padEnd(22)} kbLast=${(s.kbLast || "-").padEnd(7)}`
    + ` bar=${s.bar ? s.bar.t + ".." + s.bar.b : "-"}`
    + ` pad=${s.pad}`
    + ` picker=${s.picker ? s.picker.t + ".." + s.picker.b : "-"}`
    + (s.cls && s.cls !== "cmt-main-bar" ? " cls=" + s.cls : "")
  );
}

/* ── 断言 ───────────────────────────────────────────────── */
const by = (n) => data.steps.find((s) => s.name === n);
const fails = [];
const ok = (name, cond, extra) => { if (!cond) fails.push(name + (extra ? " — " + extra : "")); };
const panelPad = data.panelReal || 0;   /* 用面板真实高度当目标 */

ok("面板态让位 = 面板高度（面板高与键盘高同源）",
  panelPad >= 100, `panelPad=${panelPad}`);

/* A1：开面板后第一帧让位就得在。采样点 +20ms（一帧多点），
 * 允许 15px 误差（面板高度取整 / 过渡尾差）。 */
const firstFrame = by("to-panel+20");
ok("A1 开面板 20ms 内让位到位（否则输入条被面板盖住再爬上来）",
  firstFrame && Math.abs(firstFrame.pad - panelPad) <= 15,
  `+20ms pad=${firstFrame && firstFrame.pad} 目标=${panelPad}`);

/* A2：关面板后第一帧让位不许塌。 */
const press = by("kb-press+10");
ok("A2 关面板 10ms 内让位仍钉住（否则底部露一大片空白）",
  press && Math.abs(press.pad - panelPad) <= 15,
  `+10ms pad=${press && press.pad} 目标=${panelPad}`);
ok("A2b 关面板那一刻挂了 .wp-kb-swap",
  press && /wp-kb-swap/.test(press.cls || ""),
  `cls=${press && press.cls}`);

/* 键盘回来之后必须摘钉（不能一直顶着面板高）。
 * 注意基线：条自身就有 41px 的 padding-bottom（视觉留白），面板态是
 * `padding-bottom: var(--kb-panel-h)` 直接覆盖它。所以「归零」= 回到自身基线，
 * 不是回到 0。 */
const basePad = (by("bar-open") || {}).pad || 0;
const kbBack = by("to-kb+220");
ok("A2c 键盘回来后摘钉（让位回到条自身基线）",
  kbBack && kbBack.pad <= basePad + 15, `to-kb+220 pad=${kbBack && kbBack.pad} 基线=${basePad}`);

/* 面板高度必须与实测键盘高一致（用户第 4 条：高度跟键盘一样） */
const kbRow = by("kb");
const kbLastNum = parseFloat(kbRow && kbRow.kbLast) || 0;
ok("面板高度 = 实测键盘高（±8）",
  kbLastNum > 0 && Math.abs(panelPad - kbLastNum) <= 8,
  `panelPad=${panelPad} kbLast=${kbLastNum}`);

if (fails.length) {
  console.log("androidbar-drive: " + fails.length + " fail");
  for (const f of fails) console.log("  FAIL " + f);
  process.exit(1);
}
console.log("androidbar-drive: 全部断言通过");
