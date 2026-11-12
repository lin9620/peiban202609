/* 轮 514 · vendored 库的手机表情面板：真渲染几何断言
 *
 * 为什么要有这个：这一轮把库 fork 进 vendor/，改的就是「面板到底贴在哪、多宽、多高」。
 * 这些必须在真实排版里量，不能靠读 CSS 推断 —— 过去九轮的教训就是「我读到的是对的，
 * 真机上不是」。
 *
 * 断言只问用户能看见的事实：
 *   · 面板是不是整宽、左右是不是贴着屏幕边
 *   · 底边是不是真的落在 --kbb 那条线上（iOS 无键盘 = 工具栏 81px 上方）
 *   · 高度是不是真的等于 --kb-panel-h（= 键盘高）
 *   · 面板上还有没有残留内联几何（有的话宿主就得 !important，就会跟 --kbb 打架）
 *
 * 用法：node tools/vac-sheet-drive.mjs [--keep]
 */
import { spawnSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(root, "tools", "_vacsheet-harness-dist");
const keep = process.argv.includes("--keep");

const cfg = path.join(root, "tools", "_vacsheet.vite.config.mjs");
writeFileSync(cfg, `import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import path from "node:path";
const R = ${JSON.stringify(root)};
export default defineConfig({
  root: path.join(R, "tools", "vac-sheet-harness"),
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

const expr = path.join(root, "tools", "_vacsheet-expr.js");
writeFileSync(expr, `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 100 && !window.__ready; i++) await sleep(100);
  if (!window.__ready) return { error: "harness-not-ready" };

  const host = document.querySelector("vue-advanced-chat");
  const sr = host && host.shadowRoot;
  if (!sr) return { error: "no-shadow-root" };
  /* 手机尺寸下组件先显示房间列表，.vac-col-messages 是 display:none —— 不点进房间，
     面板节点虽然存在但 rect 全 0（第一版工装就是这么被骗的）。 */
  const room = sr.querySelector(".vac-room-container");
  if (room) { room.click(); await sleep(700); }
  const col = sr.querySelector(".vac-col-messages");
  if (!col || getComputedStyle(col).display === "none") return { error: "room-not-opened" };
  const wrap = sr.querySelector(".vac-emoji-wrapper");
  const btn = sr.querySelector(".vac-emoji-wrapper .vac-svg-button");
  if (!btn) return { error: "no-emoji-button" };

  const R = (el) => {
    const r = el.getBoundingClientRect();
    return { t: Math.round(r.top), b: Math.round(r.bottom), l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const C = (el) => {
    const c = getComputedStyle(el);
    return { pos: c.position, bottom: c.bottom, top: c.top, left: c.left, right: c.right, width: c.width, height: c.height };
  };
  const setV = (k, v) => document.documentElement.style.setProperty(k, v);
  const delV = (k) => document.documentElement.style.removeProperty(k);

  const rows = [];
  const snap = (name) => {
    const p = sr.querySelector(".vac-emoji-picker");
    /* 轮 516：连输入行一起量。面板是 fixed、输入行在页面流里 —— 面板一出现，
       输入行如果不让位就会被面板整个盖住（用户看到的「输入框没了」）。 */
    const foot = sr.querySelector(".vac-box-footer");
    const ta = sr.querySelector(".vac-textarea");
    const footPad = foot ? getComputedStyle(foot).paddingBottom : "-";
    rows.push({
      name,
      vw: window.innerWidth, vh: window.innerHeight,
      wrapPos: wrap ? getComputedStyle(wrap).position : "-",
      rect: p ? R(p) : null,
      cs: p ? C(p) : null,
      inline: p ? String(p.getAttribute("style") || "") : "",
      foot: foot ? R(foot) : null,
      footPad,
      ta: ta ? R(ta) : null,
    });
  };

  snap("closed");
  btn.click();
  await sleep(700);
  snap("open");

  /* iOS 无键盘：底部工具栏 81px 浮在页面之上 ⇒ 面板底必须让开它 */
  setV("--kbb", "81px");
  await sleep(120);
  snap("open-kbb81");

  /* 面板高由 --kb-panel-h 决定（宿主写的是「本会话见过的最大键盘高」） */
  setV("--kb-panel-h", "300px");
  await sleep(120);
  snap("open-panel300");

  delV("--kbb");
  delV("--kb-panel-h");
  await sleep(120);
  snap("open-reset");

  return { w: window.innerWidth, h: window.innerHeight, rows };
})()`);

function run(w, h) {
  const r = spawnSync(process.execPath, [
    "tools/web-probe.mjs", `--serve=${OUT}`, "--url=/index.html",
    `--w=${w}`, `--h=${h}`, "--wait=2500", `--file=${expr}`,
  ], { cwd: root, encoding: "utf8", env: { ...process.env, MSYS2_ARG_CONV_EXCL: "--url" } });
  const out = (r.stdout || "") + (r.stderr || "");
  try { return JSON.parse(out.slice(out.indexOf("{"))); }
  catch (e) { console.error("NO_JSON(" + w + "x" + h + ")\n" + out.slice(-1200)); return null; }
}

const phone = run(393, 852);
const desk = run(1280, 800);

if (!keep) {
  for (const f of [OUT, cfg, expr]) {
    try { rmSync(f, { recursive: true, force: true }); } catch (e) { /* 回收站不可用时留着，不影响结论 */ }
  }
}

if (!phone || phone.error || !desk || desk.error) {
  console.error("HARNESS_ERROR: " + ((phone && phone.error) || (desk && desk.error) || "unknown"));
  process.exit(1);
}

const by = (d, n) => (d.rows || []).find((s) => s.name === n) || {};
const fmt = (s) => {
  const r = s.rect, c = s.cs;
  return `wrap=${String(s.wrapPos).padEnd(8)} pos=${String(c && c.pos).padEnd(8)}`
    + ` rect=${r ? r.l + ".." + r.r + " × " + r.t + ".." + r.b : "-"}`
    + ` w=${r ? r.w : "-"} h=${r ? r.h : "-"}`
    + ` | foot=${s.foot ? s.foot.t + ".." + s.foot.b : "-"}(pad=${s.footPad})`
    + ` ta=${s.ta ? s.ta.t + ".." + s.ta.b : "-"}`;
};

console.log(`手机 ${phone.w}x${phone.h}`);
for (const s of phone.rows) console.log("  " + String(s.name).padEnd(14) + fmt(s) + (s.inline ? "  inline=" + s.inline : ""));
console.log(`\n桌面 ${desk.w}x${desk.h}`);
for (const s of desk.rows) console.log("  " + String(s.name).padEnd(14) + fmt(s) + (s.inline ? "  inline=" + s.inline : ""));

/* ── 断言 ───────────────────────────────────────────────── */
const fails = [];
const ok = (name, cond, extra) => { if (!cond) fails.push(name + (extra ? " — " + extra : "")); };

const open = by(phone, "open");
const kbb = by(phone, "open-kbb81");
const p300 = by(phone, "open-panel300");
const deskOpen = by(desk, "open");

ok("P1 wrapper 是 static（否则面板以按钮为包含块，缩成一条竖线）",
  open.wrapPos === "static", `wrapPos=${open.wrapPos}`);

ok("P2 手机面板是 fixed（跟着可视区走，不跟页面盒子）",
  open.cs && open.cs.pos === "fixed", `pos=${open.cs && open.cs.pos}`);

ok("P3 面板整宽：左右贴屏幕边",
  open.rect && open.rect.l === 0 && open.rect.r === phone.w,
  open.rect ? `l=${open.rect.l} r=${open.rect.r} 期望 0/${phone.w}` : "无面板");

ok("P4 未设 --kbb 时面板贴屏底",
  open.rect && Math.abs(open.rect.b - phone.h) <= 1,
  open.rect ? `bottom=${open.rect.b} 期望 ${phone.h}` : "无面板");

ok("P5 --kbb=81 时面板底让开工具栏（iOS 工具栏那条线）",
  kbb.rect && Math.abs(kbb.rect.b - (phone.h - 81)) <= 1,
  kbb.rect ? `bottom=${kbb.rect.b} 期望 ${phone.h - 81}` : "无面板");

ok("P6 面板高度吃 --kb-panel-h（= 键盘高，不再跟着 innerHeight 变）",
  p300.rect && Math.abs(p300.rect.h - 300) <= 2,
  p300.rect ? `h=${p300.rect.h} 期望 300` : "无面板");

/* 内联几何：有的话宿主只能 !important 压，而压过头就把 --kbb 也压掉了 */
const badInline = (phone.rows || []).filter((s) => s.inline && /(^|;)\s*(height|top|right)\s*:/.test(s.inline));
ok("P7 面板上没有内联 height/top/right（几何全交给 CSS）",
  badInline.length === 0,
  badInline.map((s) => s.name + " → " + s.inline).join(" | ") || "");

/* 桌面行为必须没被改坏：仍是 300 宽的小浮层，不是整宽 sheet */
ok("P8 桌面面板仍是 300 宽浮层（上游行为未被改坏）",
  deskOpen.rect && Math.abs(deskOpen.rect.w - 300) <= 2,
  deskOpen.rect ? `w=${deskOpen.rect.w}` : "无面板");

ok("P9 桌面面板仍是 absolute（不是 fixed 整宽）",
  deskOpen.cs && deskOpen.cs.pos === "absolute" && deskOpen.rect && deskOpen.rect.l > 0,
  deskOpen.cs ? `pos=${deskOpen.cs.pos} l=${deskOpen.rect && deskOpen.rect.l}` : "无面板");

console.log("");
if (fails.length) {
  for (const f of fails) console.log("FAIL " + f);
  console.log(`\nvac-sheet-drive: ${fails.length} fail`);
  process.exit(1);
}
console.log("vac-sheet-drive: 全部断言通过");
