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
      kb: cssv("--kb-h"), kbb: cssv("--kbb"), panelH: cssv("--kb-panel-h"), kbLast: cssv("--kb-last"),
      fb: cssv("--kb-fallback"),
      bar: R(bar), picker: R(pk),
      inlineTop: bar ? bar.style.top : "",
      barCls: bar ? bar.className : "",
    });
  };

  snap("rest");
  document.querySelector('[data-entry="0"]').click();
  await sleep(500);
  snap("bar-open");

  /* iOS 真机的**第一次**键盘状态就是「上推」的：输入条在页面底部，Safari 为了露出
     光标会把可视视口整个推上去（vv.offsetTop ≈ 键盘高）。旧代码在这里算 kbWebInset
     = inner − vv.height − offsetTop = 0，于是 --kb-last 永远是空、面板退回估计值 320，
     与真键盘 330 差一截 —— 用户第五次报的「表情框跟输入框高度不一致」。
     所以这一步必须**先上推、后**走面板，顺序不能反过来（反了就被「只增不减」掩盖）。 */
  const H = window.innerHeight;

  /* 轮 510 · 工具栏态：真机第一次打开就是这个状态（Safari 底部工具栏 81px 让
     vv 比 inner 矮），而它**不是键盘**。旧代码把它当键盘：--kb-h 变 81（页面平白缩
     81px、吸底条抬 81px），随后又把这个 81 当成「键盘本体高度」存进 localStorage，
     --kb-fallback 于是掉到 119px —— 表情面板只剩两排（用户视频里那个）。 */
  __kbSim(H - 81, 0);
  await sleep(500);
  snap("toolbar-only");
  __kbSim(H, 0);
  await sleep(300);

  __kbSim(H - 330, 330);
  await sleep(700);
  snap("kb-pan");

  /* 点表情：面板贴底（组件会 blur + 归零让位）
     真机上键盘会跟着收起来 —— 假工装里没有真键盘，这里手工把可视视口还原，
     否则测的是「键盘还在、面板又开」这个真机上不存在的状态。 */
  document.querySelector(".cmt-main-bar .wp-composer-ico.is-emoji").click();
  await sleep(60);
  __kbSim(H, 0);
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

  /* 面板 → 键盘（同样：真机上键盘会重新弹起并上推可视视口） */
  document.querySelector(".cmt-main-bar .wp-composer-ico.is-emoji").click();
  await sleep(120);
  __kbSim(H - 330, 330);
  await sleep(1400);
  snap("back-to-kb");

  /* 收键盘 */
  __kbSim(H, 0);
  await sleep(600);
  snap("kb-hide");

  /* 键盘弹起但**没有**上推（安卓 / 桌面浏览器 / iOS 光标本来就露着）：条也要贴住。
     这一档与 kb-pan 的算式不同（kbb = 键盘高），两条都得过。 */
  __kbSim(H - 330, 0);
  await sleep(700);
  snap("kb-plain");

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
    + ` kb=${(s.kb || "-").padEnd(6)} kbb=${(s.kbb || "-").padEnd(6)} panelH=${(s.panelH || "-").padEnd(6)} kbLast=${(s.kbLast || "-").padEnd(6)}`
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
const tb = step("toolbar-only");
if (!tb) fails.push("toolbar-only: 没走到「只有 Safari 工具栏」那一步");
else {
  if (!near(parseFloat(tb.kb || 0), 0)) {
    fails.push(`toolbar-only: 工具栏 81px 被当成键盘（--kb-h=${tb.kb}，应为 0）—— 页面会平白缩 81px`);
  }
  const fbPx = parseFloat(String(tb.fb || "").replace(/[^0-9.]/g, ""));
  if (tb.fb && fbPx > 0 && fbPx < 250) {
    fails.push(`toolbar-only: --kb-fallback=${tb.fb} 掉到工具栏量级（面板只会有两排）`);
  }
}

const pan = step("kb-pan");
if (!pan) fails.push("kb-pan: 没走到「iOS 首次键盘就上推」那一步");
else {
  if (!near(parseFloat(pan.kbLast || 0), 330)) {
    fails.push(`kb-pan: 键盘上推时 --kb-last = ${pan.kbLast}（应为 330）—— 面板高度会退回估计值`);
  }
}
const panel = step("panel");
if (!panel) fails.push("panel: 没走到面板那一步");
else if (!panel.picker) fails.push("panel: 面板没出现");
else {
  if (panel.picker.bottom > panel.visBottom + 2) {
    fails.push(`panel: 面板底部越过可视区（picker.bottom=${panel.picker.bottom} visBottom=${panel.visBottom}）`);
  }
  if (panel.picker.top < 0) fails.push(`panel: 面板顶部在屏幕外（top=${panel.picker.top}）`);
  if (panel.bar.bottom > panel.visBottom + 2) fails.push("panel: 条压在面板下沿之外");
  /* 本轮的核心断言：面板高度必须等于刚才那个键盘的高度（用户：「表情框跟输入框高度不一致」） */
  if (!near(panel.picker.h, 330, 2)) {
    fails.push(`panel: 面板高 ${panel.picker.h} ≠ 键盘高 330 —— 面板和输入框对不上`);
  }
  /* 条把面板顶上去之后，输入行下沿要正好压在面板上沿
     （--kb-panel-h 的 computed value 是 `min(330px, 380px)` 这种表达式，读不出 px，
       所以用面板自己的高度当基准 —— 两者本来就是同一个变量） */
  if (!near(panel.bar.bottom - panel.picker.h, panel.picker.top, 4)) {
    fails.push(`panel: 输入行下沿 ${panel.bar.bottom - panel.picker.h} 与面板上沿 ${panel.picker.top} 不齐`);
  }
}
const back = step("back-to-kb");
if (back) {
  if (!near(back.bar.bottom, back.visBottom)) {
    fails.push(`back-to-kb: 回键盘后条没贴可视底（bar.bottom=${back.bar.bottom} visBottom=${back.visBottom}）`);
  }
  if (!near(parseFloat(back.kbLast || 0), 330)) {
    fails.push(`back-to-kb: --kb-last 掉回 ${back.kbLast}（应为 330）`);
  }
}
const plain = step("kb-plain");
if (plain && !near(plain.bar.bottom, plain.visBottom)) {
  fails.push(`kb-plain: 键盘没上推时条没贴可视底（bar.bottom=${plain.bar.bottom} visBottom=${plain.visBottom}）`);
}

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
