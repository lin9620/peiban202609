/* 安卓 resize 型内核 · 暖心墙「键盘 ↔ 表情」切换轨迹（真渲染）
 *   node tools/androidbar-drive.mjs [--keep] [--cap]
 *
 * --cap ：把页面伪装成 **App 壳**（html.cap-app）。用户装的是 APK，走的是
 *         style.css 里那条 `html.cap-app` 分支，而不是 kb-web 那条 —— 轮 512/513
 *         只改了 kb-web，工装也只测了 kb-web，所以「改好了」是假的。
 *         这个模式下额外断言三件事（都是用户原话的翻译）：
 *           C1 平时底条没有任何 padding/bottom 过渡（切表情要瞬变，否则一闪）
 *           C2 键盘动画窗口（kb-anim）里**要**有过渡（跟系统输入法动画咬合）
 *           C3 键盘窗口 + 面板态时要回到瞬变（面板瞬现，条不能花 220ms 爬上来）
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
const capMode = process.argv.includes("--cap");

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
  const CAP = ${JSON.stringify(capMode)};
  if (CAP) document.documentElement.classList.add("cap-app");
  for (let i = 0; i < 80 && !window.__ready; i++) await sleep(100);
  if (!window.__ready) return { error: "harness-not-ready" };
  /* 真实 App 壳里 viewportVars 一进来就 isNativeShell() 早退，**不会**挂 kb-web。
   * 而 harness 是先按网页端跑起来的，那个类已经在 html 上了 —— 不摘掉，
   * 网页端那条「html.kb-web .cmt-main-bar { transition: none }」会压住 cap-app 这条，
   * 测出来永远是「没有过渡」，工装自己骗自己（这次就是被它骗了一轮）。
   * 注意注释里不要用反引号 —— 会把上面的模板字符串提前截断。 */
  if (CAP) document.documentElement.classList.remove("kb-web");

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

  /* 轮 517：用户第 2 条「切表情跟键盘的时候有一闪的东西」。
   * 光是几何（条/面板位置）全对，也可能有东西在闪 —— 面板里那层
   * .wp-picker-skel 骨架是 v-if，emoji-picker 也是 v-if：
   * 切一次键盘就把整块卸掉、再点表情重新造一个自定义元素，
   * 骨架要等 shadow 里出现 .emoji 才撤，那几十毫秒就是肉眼看见的「一闪」。
   * 所以逐帧记三样：骨架在不在 / 面板实例换了没有（uid）/ shadow 里有没有格子。 */
  const probe = { n: 0 };
  const rows = [];
  const snap = (name) => {
    const bb = barEl();
    const pk = pkEl();
    const ep = pk ? pk.querySelector("emoji-picker") : null;
    if (ep && !ep.__uid) ep.__uid = ++probe.n;
    const sr = ep && ep.shadowRoot;
    rows.push({
      name, inner: fakeInner, vvH: Math.round((window.visualViewport || {}).height || 0),
      kb: cssv("--kb-h"), kbb: cssv("--kbb"), panelH: cssv("--kb-panel-h"), kbLast: cssv("--kb-last"),
      bar: R(bb), picker: R(pk), pad: padOf(bb),
      cls: bb ? bb.className : "",
      skel: !!document.querySelector(".wp-picker-skel"),
      epUid: ep ? ep.__uid : 0,
      srEmoji: !!(sr && sr.querySelector(".emoji")),
      pkIn: !!pk,
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

  /* ── 第二次「键盘 → 表情」：用户反复做的就是这一下 ──
     如果面板每次都被 v-if 卸载重建，这里就会看到 skel=true + epUid 变大。 */
  const emo2 = document.querySelector(".cmt-main-bar .wp-composer-ico.is-emoji");
  if (emo2) emo2.click();
  snap("panel2+0");
  await sleep(16); snap("panel2+16");
  await sleep(24); snap("panel2+40");
  setVp(H, H);
  await sleep(60); snap("panel2+100");
  await sleep(300); snap("panel2");

  /* ── App 壳专属：过渡到底挂在哪几个状态上 ──
     只看 computed style，不猜实现。用户报的「一闪」就是「面板瞬现、条却在过渡」。 */
  const capChecks = {};
  if (CAP) {
    const de = document.documentElement;
    /* 可能被 viewportVars / keyboardInset 的巡检重新挂回来 —— 读之前再摘一次 */
    de.classList.remove("kb-web");
    const bb = barEl();
    const tr = () => {
      if (!bb) return null;
      const cs = getComputedStyle(bb);
      return { p: cs.transitionProperty, d: cs.transitionDuration };
    };
    capChecks.idle = tr();                       /* 平时：不该有任何过渡 */
    /* 上一步可能还在 .wp-kb-swap 尾态里 —— 先摘干净，别让 :not() 影响 C2。
       轮 517：最后一段是「第二次开面板」，所以 html.wp-panel 也还挂着（面板保活后
       关面板才摘）—— 不摘它，body 那条 :not(.wp-panel) 永远不命中，C6 恒红。 */
    bb.classList.remove("wp-emoji-open", "wp-kb-swap");
    de.classList.remove("wp-panel");
    capChecks.idle = tr();
    const btr = () => {
      const cs = getComputedStyle(document.body);
      return { p: cs.transitionProperty, d: cs.transitionDuration };
    };
    de.classList.add("kb-anim");
    capChecks.anim = tr();
    capChecks.bodyAnim = btr();                  /* 键盘窗口：body 让位要平滑 */
    bb.classList.add("wp-emoji-open");
    de.classList.add("wp-panel");                /* 面板态（WpComposer.syncBar 会挂） */
    capChecks.animPanel = tr();                  /* 键盘窗口 + 面板态：必须没有 */
    capChecks.bodyPanel = btr();                 /* 同上，body 也必须瞬变 */
    bb.classList.remove("wp-emoji-open");
    de.classList.remove("wp-panel");
    de.classList.remove("kb-anim");
    /* 会话页那一侧：暖心墙 harness 里没有 .dm-page--chat，就现造一个最小骨架，
     * 只读 transition —— 用户报的「退出会话一缩一放」就是它平时也带着 .22s。 */
    capChecks.chatPage = (() => {
      const host = document.createElement("div");
      host.className = "shell shell--mobile-nav shell--chat";
      const page = document.createElement("div");
      page.className = "dm-page dm-page--chat";
      host.appendChild(page);
      document.body.appendChild(host);
      const rd = () => { const cs = getComputedStyle(page); return { p: cs.transitionProperty, d: cs.transitionDuration }; };
      const idle = rd();
      de.classList.add("kb-anim");
      const anim = rd();
      de.classList.remove("kb-anim");
      host.remove();
      return { idle, anim };
    })();
  }

  return { w: window.innerWidth, h: H, panelPad, panelReal, capChecks, barCount: document.querySelectorAll(".cmt-main-bar").length, steps: rows };
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
if (capMode && data.capChecks) {
  const c = data.capChecks;
  const s = (v) => (v ? `${v.p} / ${v.d}` : "null");
  console.log(`cap  idle=${s(c.idle)}  anim=${s(c.anim)}  animPanel=${s(c.animPanel)}  bars=${data.barCount}`);
  if (c.chatPage) console.log(`cap  会话页 idle=${s(c.chatPage.idle)}  anim=${s(c.chatPage.anim)}`);
}
for (const s of data.steps) {
  console.log(
    s.name.padEnd(13)
    + ` inner=${String(s.inner).padStart(4)} vv=${String(s.vvH).padStart(4)}`
    + ` kb=${(s.kb || "-").padEnd(6)} kbb=${(s.kbb || "-").padEnd(6)}`
    + ` panelH=${(s.panelH || "-").padEnd(22)} kbLast=${(s.kbLast || "-").padEnd(7)}`
    + ` bar=${s.bar ? s.bar.t + ".." + s.bar.b : "-"}`
    + ` pad=${s.pad}`
    + ` picker=${s.picker ? s.picker.t + ".." + s.picker.b : "-"}`
    + ` 骨架=${s.skel ? "在" : "无"} uid=${s.epUid} sr=${s.srEmoji ? "ok" : (s.pkIn ? "-" : "无面板")}`
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

/* ── 用户第 2 条「切表情跟键盘的时候有一闪的东西」──
 * 几何全对也可能闪：面板 v-if 每次卸载重建 <emoji-picker>，真机上要重新灌
 * /emoji/data.json 再渲染上百个格子，那段时间是空的/只有骨架。
 * 这里用实例 uid 认「有没有重建」，用骨架节点认「有没有闪那一层」。 */
const p1 = by("panel");
const p2 = by("panel2+16") || by("panel2");
ok("A3 第二次开面板不许重建 emoji-picker（重建 = 真机重新灌数据，就是那一闪）",
  p1 && p2 && p1.epUid > 0 && p1.epUid === p2.epUid,
  `第一次 uid=${p1 && p1.epUid} 第二次 uid=${p2 && p2.epUid}`);
ok("A3b 第二次开面板 shadowRoot 里格子立刻就在",
  p2 && p2.srEmoji === true, `sr=${p2 && p2.srEmoji}`);
const seq2 = ["panel2+16", "panel2+40", "panel2+100", "panel2"].map(by).filter(Boolean);
ok("A4 第二次开面板全程不许出现骨架",
  seq2.length >= 3 && seq2.every((s) => !s.skel),
  `采样=${seq2.map((s) => s.name + ":" + (s.skel ? "在" : "无")).join(" ")}`);

/* 面板高度必须与实测键盘高一致（用户第 4 条：高度跟键盘一样） */
const kbRow = by("kb");
const kbLastNum = parseFloat(kbRow && kbRow.kbLast) || 0;
ok("面板高度 = 实测键盘高（±8）",
  kbLastNum > 0 && Math.abs(panelPad - kbLastNum) <= 8,
  `panelPad=${panelPad} kbLast=${kbLastNum}`);

/* ── App 壳（--cap）：过渡只许出现在键盘动画窗口里 ──
 * 这三条就是用户「一闪」「缩放」的直译。轮 512/513 把网页端改干净了，
 * 工装也只测网页端，于是 APK 里那三条常驻过渡一直没被发现。 */
if (capMode) {
  const cc = data.capChecks || {};
  const durs = (v) => (v && v.d ? v.d.split(",").map((x) => parseFloat(x) || 0) : []);
  const hasAnim = (v) => durs(v).some((x) => x > 0.01);
  const show = (v) => (v ? `${v.p} / ${v.d}` : "null");
  ok("C1 平时底条不许有过渡（有 = 切表情一闪）",
    cc.idle && !hasAnim(cc.idle), `transition=${show(cc.idle)}`);
  ok("C2 键盘动画窗口内底条必须有过渡（否则页面瞬跳露白）",
    cc.anim && hasAnim(cc.anim), `transition=${show(cc.anim)}`);
  ok("C3 键盘窗口 + 面板态必须瞬变（面板瞬现，条不能爬 220ms）",
    cc.animPanel && !hasAnim(cc.animPanel), `transition=${show(cc.animPanel)}`);
  ok("C6 键盘窗口内 body 让位必须有过渡（与页面高度同步，否则露白）",
    cc.bodyAnim && hasAnim(cc.bodyAnim), `transition=${show(cc.bodyAnim)}`);
  ok("C7 面板态下 body 让位必须瞬变（否则暖心墙底部抽一条空白）",
    cc.bodyPanel && !hasAnim(cc.bodyPanel), `transition=${show(cc.bodyPanel)}`);
  if (cc.chatPage) {
    const cp = cc.chatPage;
    ok("C4 会话页平时高度不许有过渡（有 = 退出会话一缩一放）",
      !hasAnim(cp.idle), `transition=${show(cp.idle)}`);
    ok("C5 键盘窗口内会话页高度必须有过渡（否则整页瞬跳露白）",
      hasAnim(cp.anim), `transition=${show(cp.anim)}`);
  }
}

if (fails.length) {
  console.log("androidbar-drive: " + fails.length + " fail");
  for (const f of fails) console.log("  FAIL " + f);
  process.exit(1);
}
console.log("androidbar-drive: 全部断言通过");
