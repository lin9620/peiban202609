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

  /* 轮 511 · 先让它「见过」一次键盘（正常缩可视视口、不上推）。
     真机第一次点输入框就是这一下，webKbSeen 记上值之后，
     后面的「面板 → 键盘」才会走 holdForKeyboard 的 swap 分支。
     不补这一步，整条 swap 路径在工装里根本不执行 —— 上一版那条断言就是空转的假绿。 */
  __kbSim(H - 330, 0);
  await sleep(500);
  __kbSim(H, 0);
  await sleep(400);

  /* 轮 510 · 工具栏态：真机第一次打开就是这个状态（Safari 底部工具栏 81px 让
     vv 比 inner 矮），而它**不是键盘**。旧代码把它当键盘：--kb-h 变 81（页面平白缩
     81px、吸底条抬 81px），随后又把这个 81 当成「键盘本体高度」存进 localStorage，
     --kb-fallback 于是掉到 119px —— 表情面板只剩两排（用户视频里那个）。 */
  __kbSim(H - 81, 0);
  await sleep(500);
  snap("toolbar-only");
  /* 轮 513 · 自愈验证：把 --kbb 故意写成 0（= 内核把工具栏高度漏报成 0，iOS 26 玻璃栏
     和 X 内置浏览器都会这样）。闭环校正（utils/bottomPin.js）必须在这之后把条拉回
     可视区底 —— 这正是「面板沉到屏幕外 / 只露两排」那类问题的总开关。
     下面那条通用断言（每一步 bar.bottom 都必须 ≈ visBottom）就是它的判据。 */
  document.documentElement.style.setProperty("--kbb", "0px");
  await sleep(900);
  snap("kbb-broken");
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
  /* 轮 516 · 上推态下**先采一次**再还原。
   * 上一版这里点完表情立刻 __kbSim(H-81) 还原，理由是「真机上键盘会跟着收起来，
   * 测的是不存在的状态」—— 这句话是错的：键盘收起要 250ms，这 250ms 里
   * 可视视口仍是上推的，而用户看见的恰恰就是这 250ms。
   * 组装级工装（dm-sheet-drive）在私信页量到：不扣上推量时输入行会窜到屏幕 146
   * （本该 469）。暖心墙是同一套面板 + 同一条让位公式，必须在这里也有采样点。 */
  snap("panel-press-60");
  /* 轮 511：键盘收起后 Safari 的底部工具栏还在（vv = inner − 81），不能还原成整屏。
     还原成整屏会让 --kbb 变 0，之后「点键盘键」那一刻记下的基线 holdKbb 也是 0，
     键盘回来时 --kbb 还是 0（上推态）→ 判据永远不成立，测出来的是个假现场。 */
  __kbSim(H - 81, 0);
  await sleep(900);
  snap("panel");

  /* 面板里最后一排 emoji 有没有被切：拿 shadow 里的最后一个按钮量 */
  let lastEmoji = null;
  try {
    const host = document.querySelector(".wp-composer-picker emoji-picker");
    const sr = host && host.shadowRoot;
    /* 轮 511：必须排掉 .baseline-emoji —— 那是库里用来量字号的一枚 absolute 隐藏按钮，
       一直在 section 末尾。上一版直接取 querySelectorAll 的最后一个，量到的永远是它
       （每轮都是 443..476 这个死值），等于这个断言从写下来那天起就没测过真东西。 */
    const all = sr ? [...sr.querySelectorAll("button.emoji")] : [];
    const btns = all.filter((b) => !b.classList.contains("baseline-emoji")
      && !b.classList.contains("hidden") && !b.closest(".skintone-list"));
    if (btns.length) {
      const r = btns[btns.length - 1].getBoundingClientRect();
      lastEmoji = { bottom: Math.round(r.bottom), top: Math.round(r.top), n: btns.length };
    }
    /* 轮 511：网格（.tabpanel）比面板矮多少 = 那块能点却什么都没有的空白。
       用户报「面板下面空一大片、按空白处也能选表情」，这一行就是判据。 */
    /* 网格容器：这版库里没有 .tabpanel，改成「含 ≥30 个 emoji 按钮的最小 div」 */
    let grid = sr && sr.querySelector(".tabpanel");
    if (!grid && sr) {
      for (const el of sr.querySelectorAll("div")) {
        const n = el.querySelectorAll("button.emoji").length;
        if (n >= 30 && (!grid || n < grid.querySelectorAll("button.emoji").length)) grid = el;
      }
    }
    if (grid && lastEmoji) {
      const g = grid.getBoundingClientRect();
      const hostR = host.getBoundingClientRect();
      lastEmoji.grid = {
        h: Math.round(g.height), top: Math.round(g.top), bottom: Math.round(g.bottom),
        scrollH: grid.scrollHeight, hostH: Math.round(hostR.height),
        rows: Math.round(g.height / 33), padToBottom: Math.round(hostR.bottom - g.bottom),
      };
    }
  } catch (e) { /* shadow 结构变了就跳过 */ }
  steps[steps.length - 1].lastEmoji = lastEmoji;

  /* 面板 → 键盘（同样：真机上键盘会重新弹起并上推可视视口） */
  document.querySelector(".cmt-main-bar .wp-composer-ico.is-emoji").click();
  await sleep(20);
  snap("kb-press-20");
  await sleep(100);
  __kbSim(H - 330, 330);
  /* 轮 511：键盘回来 350ms 就要采样 —— 兜底是 1200ms，只测 1400ms 那一刻
     等于把「swap 一直钉着」这个缺陷完全跳过去（上一版就是这么假绿的）。 */
  await sleep(350);
  snap("kb-arrived-350");
  await sleep(1050);
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
    + (s.lastEmoji && s.lastEmoji.grid
      ? `  grid=${s.lastEmoji.grid.top}..${s.lastEmoji.grid.bottom}(${s.lastEmoji.grid.h}) scroll=${s.lastEmoji.grid.scrollH} 排≈${s.lastEmoji.grid.rows} 空隙=${s.lastEmoji.grid.padToBottom}`
      : "")
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
const press60 = step("panel-press-60");
if (!press60) fails.push("panel-press-60: 没采到「键盘还在时点表情」那一帧");
else {
  /* 轮 516 · 这一帧是用户真正看见的：键盘还在收起，可视视口仍是上推的。
   * 面板必须已经**藏在键盘所在的位置**（底边 = 可视区底 852），不许横在可视区中间。
   * 不扣 --vtop 时实测：面板 202..532、底条被顶到屏幕 152 —— 半屏都是面板。 */
  /* 坐标换成屏幕坐标：键盘态可视视口上推，布局坐标要减掉 offsetTop（见 snap 的 vv）。 */
  const vt = (press60.vv && press60.vv[1]) || 0;
  if (press60.picker) {
    const pt = press60.picker.top - vt;
    const pb = press60.picker.bottom - vt;
    if (pt < 500) {
      fails.push(`panel-press-60: 面板顶在屏幕 ${pt}（该 ≥500，藏在键盘后面）—— 键盘还没收就把面板亮出来`);
    }
    if (pb > press60.visBottom + 2) {
      fails.push(`panel-press-60: 面板底越过可视区（${pb} > ${press60.visBottom}）`);
    }
  }
  /* 底条不许被顶到屏幕上半部（不扣 --vtop 时屏幕 148，扣了之后贴可视区底 ~437） */
  if (press60.bar) {
    const bt = press60.bar.top - vt;
    if (bt < 400) {
      fails.push(`panel-press-60: 底条被顶到屏幕 ${bt}（该留在下部）—— 让位把上推量和面板高叠了一次`);
    }
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
/* 轮 511 · 核心：键盘一回来，swap 必须立刻摘掉。
   旧判据写 `k >= holdKbb + 80`（要求 --kbb **变大**），但 iOS 上推可视视口时
   键盘态 --kbb 是从 81 掉到 0（变小）→ 判据永不成立 → 只能等 1200ms 兜底。
   那一整秒多里底条被 padding-bottom 顶在屏幕中部、下面一大片空白：
   用户发的截图红框 + 「切换键盘跟发送按钮没效果」就是这个。 */
const arrived = step("kb-arrived-350");
if (arrived) {
  if (String(arrived.barCls || "").includes("wp-kb-swap")) {
    fails.push(`kb-arrived-350: 键盘已回来 350ms，swap 仍钉着（cls=${arrived.barCls}）—— 条悬在半空、下面一大片空白`);
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
