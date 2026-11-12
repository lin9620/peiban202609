/* 轮 516 · 私信会话页「键盘 ↔ 表情」原地不动 真渲染驱动
 *   node tools/dm-sheet-drive.mjs [--keep] [--explore]
 *
 * 用户：「点键盘→点表情→再点键盘，输入框会跳」（苹果）。这一条过去九轮都没被量过：
 * 面板几何有工装（vac-sheet-drive）、暖心墙有工装（wallbar-drive），
 * 唯独**私信会话页**——也就是他天天用的那个页面——从来没有组装级实测。
 *
 * 这里挂真组件（DmVacChat，含宿主注入影子树的 THEME_CSS），伪造 iOS overlay 型
 * visualViewport，走完「键盘 → 表情 → 键盘」，每一步量输入行的屏幕坐标。
 */
import { spawnSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(root, "tools", "_dmsheet-harness-dist");
const keep = process.argv.includes("--keep");

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

const expr = path.join(root, "tools", "_dmsheet-expr.js");
writeFileSync(expr, `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 100 && !window.__ready; i++) await sleep(100);
  if (!window.__ready) return { error: "harness-not-ready" };

  const host = document.querySelector(".dm-vac");
  const sr = host && host.shadowRoot;
  if (!sr) return { error: "no-shadow-root" };

  /* 手机尺寸下库先显示房间列表，不点进房间 .vac-col-messages 是 display:none，
     rect 全 0 却「全绿」——vac-sheet-drive 第一版就这么骗过我一次。 */
  const room = sr.querySelector(".vac-room-container");
  if (room) { room.click(); await sleep(800); }
  const col = sr.querySelector(".vac-col-messages");
  if (!col || getComputedStyle(col).display === "none") return { error: "room-not-opened" };

  const R = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { t: Math.round(r.top), b: Math.round(r.bottom), l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const cssv = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const page = document.querySelector(".dm-page--chat");

  const rows = [];
  const snap = (name) => {
    const ta = sr.querySelector("textarea.vac-textarea");
    const foot = sr.querySelector(".vac-box-footer");
    const pk = sr.querySelector(".vac-emoji-picker");
    const vv = window.visualViewport || {};
    const pageR = page ? page.getBoundingClientRect() : null;
    rows.push({
      name,
      inner: window.innerHeight,
      vvTop: Math.round(vv.offsetTop || 0),
      visBottom: Math.round((vv.offsetTop || 0) + (vv.height || window.innerHeight)),
      kb: cssv("--kb-h"), kbb: cssv("--kbb"), vtop: cssv("--vtop"), panelH: cssv("--kb-panel-h"), kbLast: cssv("--kb-last"),
      page: pageR ? { t: Math.round(pageR.top), b: Math.round(pageR.bottom), h: Math.round(pageR.height) } : null,
      ta: R(ta), foot: R(foot),
      footPad: foot ? getComputedStyle(foot).paddingBottom : "-",
      picker: R(pk),
      hostCls: host.className,
      threadCls: (document.querySelector(".dm-thread") || {}).className || "",
    });
  };

  const H = window.innerHeight;
  const KB = 330;                    /* iPhone 键盘本体高 */
  const TB = 81;                     /* iOS 底部工具栏 */
  const ta0 = sr.querySelector("textarea.vac-textarea");
  if (!ta0) return { error: "no-textarea" };

  snap("rest");

  /* ① 点输入框 → 键盘弹起（overlay 型：可视视口上推，innerHeight 不变） */
  ta0.focus();
  __kbSim(H - KB, KB);
  await sleep(500);
  snap("kb");

  /* ② 点表情：面板出现、键盘收起（真机上工具栏还在 → vv = H - 81） */
  const ebtn = sr.querySelector("#room-footer .vac-emoji-wrapper .vac-svg-button")
    || sr.querySelector(".vac-emoji-wrapper .vac-svg-button");
  if (!ebtn) return { error: "no-emoji-button" };
  ebtn.click();
  /* 细采样：真机键盘收起要 250ms 左右，这 250ms 里输入行在哪，就是用户看见的那一下。
     过去九轮只看「最终态对不对」，从来没量过中间这 250ms —— 所以每轮都说改好了。 */
  await sleep(16);  snap("emoji+16");
  await sleep(44);  snap("emoji+60");
  await sleep(60);  snap("emoji+120");
  __kbSim(H - TB, 0);
  await sleep(60);  snap("emoji+180");
  await sleep(120); snap("emoji+300");
  await sleep(400); snap("panel");

  /* ③ 再点表情键（此时应换成键盘）：面板收、键盘起 */
  ebtn.click();
  await sleep(20);
  snap("kb-press-20");
  await sleep(120);
  __kbSim(H - KB, KB);
  await sleep(350);
  snap("kb-back-350");
  await sleep(900);
  snap("kb-back");

  return { w: window.innerWidth, h: H, kb: KB, tb: TB, rows };
})()`);

const r = spawnSync(process.execPath, [
  "tools/web-probe.mjs", `--serve=${OUT}`, "--url=/index.html",
  "--w=393", "--h=852", "--wait=3000", `--file=${expr}`,
], { cwd: root, encoding: "utf8" });
const out = (r.stdout || "") + (r.stderr || "");
let data = null;
try { data = JSON.parse(out.slice(out.indexOf("{"))); } catch (e) {
  console.error("NO_JSON\n" + out.slice(-1500));
}

if (!keep) {
  for (const f of [OUT, cfg, expr]) {
    try { rmSync(f, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }
}

if (!data || data.error) {
  console.error("HARNESS_ERROR: " + ((data && data.error) || "unknown"));
  process.exit(1);
}

console.log(`viewport ${data.w}x${data.h}  kb=${data.kb} tb=${data.tb}`);
const s = (v) => (v ? `${v.t}..${v.b}` : "-");
/* 屏幕坐标：Safari 上推时 vv.offsetTop > 0，布局坐标要减掉它才是用户看见的位置 */
const scr = (r, top) => (r ? `${r.t - top}..${r.b - top}` : "-");
for (const r0 of data.rows) {
  const t = r0.vvTop || 0;
  console.log(
    String(r0.name).padEnd(16)
    + ` vvTop=${String(t).padEnd(4)} visB=${String(r0.visBottom).padEnd(4)} kbb=${String(r0.kbb).padEnd(6)} vtop=${String(r0.vtop).padEnd(6)}`
    + ` 屏幕: ta=${scr(r0.ta, t).padEnd(9)} picker=${scr(r0.picker, t).padEnd(9)}`
    + ` pad=${r0.footPad}  cls=${r0.hostCls.replace(/^dm-vac ?/,"")||"-"}`
  );
}
console.log("\n宿主类: " + data.rows[data.rows.length - 1].hostCls + " / " + data.rows[data.rows.length - 1].threadCls);

/* ── 断言（全部对着「用户看见什么」说，不读实现）────────────────────
 * 坐标一律换算成**屏幕坐标**：iOS 键盘态会把可视视口上推（vv.offsetTop = 键盘高），
 * 布局坐标要减掉它才是屏幕上的位置。上一版工装就是没换这个，量出来的数字看着正常，
 * 实际用户看到的是另一回事。
 */
const fails = [];
const by = (n) => data.rows.find((r) => r.name === n) || {};
const scrPos = (r, k) => {
  if (!r || !r[k]) return null;
  const t = r.vvTop || 0;
  return { t: r[k].t - t, b: r[k].b - t, h: r[k].h };
};
const need = (n) => { const r = by(n); if (!r.name) fails.push(`${n}: 没走到这一步`); return r; };

const kbRow = need("kb");
const e16 = need("emoji+16");
const e120 = need("emoji+120");
const panel = need("panel");
const press = need("kb-press-20");
const back = need("kb-back");

/* A1 · 点表情那一下，输入行不许窜到屏幕上半部。
 * 改前实测：屏幕 469 → 146（+16ms）→ 405。用户说的「一闪」就是这一下。 */
for (const [nm, row] of [["emoji+16", e16], ["emoji+120", e120]]) {
  const t = scrPos(row, "ta");
  if (t && t.t < 380) {
    fails.push(`${nm}: 输入行窜到屏幕 ${t.t}（该留在 400 以上）—— 让位没扣 --vtop，等于让了两次`);
  }
}
/* A2 · 上推态下面板必须落在**键盘所在的位置**（屏幕 522..852），
 * 不许横在可视区中间（改前 202..532：半屏都是面板，聊天记录被挤没）。 */
{
  const pk = scrPos(e120, "picker");
  if (!pk) fails.push("emoji+120: 面板没出现");
  else {
    if (pk.t < 500) fails.push(`emoji+120: 面板顶在屏幕 ${pk.t}（该 ≥500，藏在键盘后面）—— 键盘还在收就把面板亮出来了`);
    if (Math.abs(pk.h - 330) > 8) fails.push(`emoji+120: 面板高 ${pk.h}（该 = 键盘 330）`);
  }
}
/* A3 · 面板 → 键盘那一下，钉住必须生效：输入行一步都不许动。
 * 改前实测：屏幕 405 → 725（+20ms，掉 320px）→ 469，中间底下露一大片空白。 */
{
  const p1 = scrPos(panel, "ta");
  const p2 = scrPos(press, "ta");
  if (!p2) fails.push("kb-press-20: 没量到输入行");
  else if (p1 && Math.abs(p2.t - p1.t) > 24) {
    fails.push(`kb-press-20: 输入行从 ${p1.t} 跳到 ${p2.t}（差 ${Math.abs(p2.t - p1.t)}px）—— .wp-kb-swap 没钉住`);
  }
  if (!/wp-kb-swap/.test(press.hostCls || "")) {
    fails.push(`kb-press-20: 宿主没挂 .wp-kb-swap（cls=${press.hostCls}）—— webSwapNeeded 在 overlay 型上返回了 false`);
  }
  const pad = parseFloat(String(press.footPad)) || 0;
  if (pad < 200) fails.push(`kb-press-20: 让位只剩 ${pad}px（该还钉着面板高）—— 一帧塌光，屏幕底部露空白`);
}
/* A4 · 落定态：面板贴着工具栏上沿、输入行压在面板上沿、让位 = 面板高。 */
{
  const pk = scrPos(panel, "picker");
  const t = scrPos(panel, "ta");
  if (pk && Math.abs(pk.b - 771) > 2) fails.push(`panel: 面板底在 ${pk.b}（该 771 = iOS 工具栏上沿）`);
  if (pk && t && Math.abs(t.b - pk.t) > 2) fails.push(`panel: 输入行下沿 ${t.b} 与面板上沿 ${pk.t} 不齐`);
  const pad = parseFloat(String(panel.footPad)) || 0;
  if (Math.abs(pad - (pk ? pk.h : 0)) > 2) fails.push(`panel: 让位 ${pad}px ≠ 面板高（会留缝或压住）`);
}
/* A5 · 键盘回来之后，输入行回到键盘上沿（页面底）。 */
{
  const t = scrPos(kbRow, "ta");
  /* 容差 20：footer 自带 padding + 安全区，输入行下沿落在 505 左右；这里只抓「差了半个键盘」那种错 */
  if (t && Math.abs(t.b - 522) > 20) fails.push(`kb: 键盘态输入行下沿在 ${t.b}（该 ≈522 = 键盘上沿 852−330）`);
  const t2 = scrPos(back, "ta");
  if (t2 && Math.abs(t2.b - 522) > 20) fails.push(`kb-back: 回到键盘后输入行下沿在 ${t2.b}（该 ≈522）`);
}

if (fails.length) {
  console.error("\ndm-sheet-drive: " + fails.length + " 条失败");
  for (const f of fails) console.error("  · " + f);
  process.exit(1);
}
console.log("\ndm-sheet-drive: 全部断言通过");
