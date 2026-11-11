/* iOS 26「玻璃栏」真实渲染测试（Node 直跑：node tools/ios26-glass-test.mjs）
 * ------------------------------------------------------------
 * 为什么单独一个工装：
 *   iOS 26 Safari 把布局视口改成了「整块屏」——`innerHeight` 含顶部/底部两条浮动玻璃栏、
 *   键盘弹起也不变；而 `visualViewport.height` / `100svh` / `100dvh` 只有栏杆之间那一条。
 *   这是**和 iOS 15–18 完全不同的语义**，也是用户问「别的苹果手机呢」时最容易踩的那台。
 *
 *   纯函数矩阵（viewport-matrix-test）只能证明算式对；这里要证明**真实 CSS 里条真的落在那**。
 *   Chromium 自己造不出这种语义（它的 dvh 恒等于视口高），所以两件事都伪造：
 *     ① visualViewport 的 height/offsetTop ← 假对象；
 *     ② 探针元素的 getBoundingClientRect ← 只对 `style.height === "100svh"/"100dvh"` 的元素
 *        返回假读数，其余一律透传真实现（不能整体 patch，条自身的几何还要靠它量）。
 *
 * 断言只看用户能看见的事实：
 *   G1 无键盘：吸底条底边 = 玻璃栏上沿（inner − 栏高），不许沉到栏下面、也不许悬空
 *   G2 键盘态：吸底条底边 = 键盘上沿
 *   G3 面板高度变量 = 键盘态让位量（输入条不许跳）
 *   G4 无键盘时 kb 必须为 0（玻璃栏不是键盘）
 *
 * 用法：node tools/ios26-glass-test.mjs      （需先 npm run build）
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const DIST = path.resolve("dist");
const EDGE = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => fs.existsSync(p));
if (!EDGE) { console.error("IOS26_FAIL: msedge-not-found"); process.exit(1); }
if (!fs.existsSync(path.join(DIST, "index.html"))) {
  console.error("IOS26_FAIL: dist-not-found（先 npm run build）"); process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* iPhone 15 的 iOS 26 语义：屏 852，两条玻璃栏合计 81 */
const INNER = 852;
const BAR = 81;
const KB = 330;

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff",
};
function startServer(dir) {
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent((req.url || "/").split("?")[0]);
    let f = path.join(dir, u);
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(dir, "index.html");
    res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv)));
}

const BOOTSTRAP = `(() => {
  const cfg = window.__g = { bar: ${BAR}, kb: 0, inner: ${INNER} };

  /* ① 假 visualViewport：布局视口不动，只有可视视口知道栏杆/键盘 */
  const ev = new EventTarget();
  const fake = {
    get height() { return cfg.inner - cfg.bar - cfg.kb; },
    get width() { return window.innerWidth; },
    /* 轮 509：offsetTop 不再是 0 —— iOS 为了让光标露出来会把可视视口整体上推，
     * 上推量正好等于「玻璃栏 + 键盘高」，于是 offsetTop + height ≈ innerHeight。
     * 之前这里写死 0，等于把真机最要命的那个分支整个跳过（八轮假绿的真因）。 */
    /* 只有键盘弹起时才上推（推的量 = 玻璃栏 + 键盘高，于是 offsetTop+height ≈ inner）；
     * 无键盘时可视视口就停在顶上，offsetTop = 0。 */
    get offsetTop() { return cfg.kb > 0 ? cfg.bar + cfg.kb : 0; },
    get offsetLeft() { return 0; },
    get pageTop() { return 0; },
    get pageLeft() { return 0; },
    get scale() { return 1; },
    addEventListener: ev.addEventListener.bind(ev),
    removeEventListener: ev.removeEventListener.bind(ev),
    dispatchEvent: ev.dispatchEvent.bind(ev),
  };
  Object.defineProperty(window, "visualViewport", { configurable: true, get: () => fake });

  /* ② 只对宽高探针伪造 getBoundingClientRect（其余透传，条自身几何要真量） */
  const orig = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function () {
    const r = orig.call(this);
    const h = this.style && this.style.height;
    if (h === "100svh" || h === "100dvh" || h === "100lvh") {
      const v = h === "100lvh" ? cfg.inner : cfg.inner - cfg.bar - (h === "100dvh" ? cfg.kb : 0);
      return { ...r, height: v, bottom: r.top + v };
    }
    return r;
  };

  window.__gSet = (kb) => {
    cfg.kb = kb;
    fake.dispatchEvent(new Event("resize"));
    fake.dispatchEvent(new Event("scroll"));
  };
  window.__gCfg = cfg;
})();`;

const INSTALL = `(() => {
  const host = document.createElement("div");
  host.id = "g-host";
  host.innerHTML = '<div class="dm-page dm-page--chat" id="g-chat">' +
      '<div class="dm-wrap"><div class="dm-thread">' +
        '<div class="dm-scroll"><div style="height:1600px"></div></div>' +
      '</div></div></div>';
  document.body.appendChild(host);

  const bar = document.createElement("div");
  bar.className = "cmt-main-bar";
  bar.id = "g-bar";
  bar.innerHTML = '<textarea class="wp-composer-input" rows="1" placeholder="说点温柔的话"></textarea>' +
                  '<button class="cmt-send" type="button">发送</button>';
  document.body.appendChild(bar);

  const picker = document.createElement("div");
  picker.className = "wp-composer-picker";
  picker.id = "g-picker";
  picker.innerHTML = '<div style="height:200px"></div>';
  document.body.appendChild(picker);

  /* 屏幕坐标（= 布局 − offsetTop）才是用户看到的位置。vt 默认 0。 */
  const R = (el, vt) => {
    const r = el.getBoundingClientRect();
    const d = vt || 0;
    return { t: +(r.top - d).toFixed(1), b: +(r.bottom - d).toFixed(1), h: +r.height.toFixed(1) };
  };
  window.__gMeasure = () => {
    const cs = getComputedStyle(document.documentElement);
    const vt = Math.round(window.visualViewport.offsetTop);
    const chat = document.getElementById("g-chat");
    const b = document.getElementById("g-bar");
    const pk = document.getElementById("g-picker");
    return {
      inner: Math.round(window.innerHeight),
      vvH: Math.round(window.visualViewport.height),
      kbVar: cs.getPropertyValue("--kb-h").trim(),
      kbb: cs.getPropertyValue("--kbb").trim(),
      vph: cs.getPropertyValue("--vph").trim(),
      panelVar: cs.getPropertyValue("--kb-last").trim(),
      capVar: cs.getPropertyValue("--kb-cap").trim(),
      /* 轮 509：Chromium 不会真的平移布局，伪造的 offsetTop 只影响 JS 读数。
       * 所以这里把几何**换算成屏幕坐标**再交给断言：屏幕 = 布局 − offsetTop。
       * 这正是真机上用户看到的位置；不换算就等于又在测一个不存在的世界。 */
      vvTop: Math.round(window.visualViewport.offsetTop),
      chat: chat ? R(chat, vt) : null,
      bar: b ? R(b, vt) : null,
      picker: pk ? Object.assign(R(pk), { bottom: getComputedStyle(pk).bottom }) : null,
    };
  };
  return true;
})()`;

async function main() {
  const srv = await startServer(DIST);
  const base = "http://127.0.0.1:" + srv.address().port + "/";
  const dbg = 9800 + Math.floor(Math.random() * 150);
  const profile = path.join(os.tmpdir(), "wp-ios26-" + Date.now());
  const child = spawn(EDGE, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--remote-debugging-port=" + dbg, "--user-data-dir=" + profile,
    "--window-size=420,900", "about:blank",
  ], { stdio: "ignore" });

  let ver = null;
  for (let i = 0; i < 80 && !ver; i++) {
    await sleep(200);
    try { ver = await fetch(`http://127.0.0.1:${dbg}/json/version`).then((r) => r.json()); } catch (e) {}
  }
  if (!ver) throw new Error("edge-not-ready");
  const list = await fetch(`http://127.0.0.1:${dbg}/json/list`).then((r) => r.json());
  const ws = new WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });

  let id = 0;
  const pending = new Map();
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (method, params) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, (m) => (m.error ? rej(new Error(method + " → " + m.error.message)) : res(m.result)));
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout: 30000 });
    if (r.exceptionDetails) throw new Error("page-exception: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result?.value;
  };

  await send("Runtime.enable", {});
  await send("Page.enable", {});
  await send("Page.addScriptToEvaluateOnNewDocument", { source: BOOTSTRAP });
  await send("Emulation.setDeviceMetricsOverride", { width: 393, height: INNER, deviceScaleFactor: 3, mobile: true });
  await send("Page.navigate", { url: base + "?g=" + Date.now() });
  await sleep(1800);
  await evaluate(INSTALL);
  await sleep(900);

  const fails = [];
  const checks = [];
  const add = (name, ok, detail) => { checks.push({ name, ok, detail }); if (!ok) fails.push(`${name} → ${detail}`); };

  const closed = await evaluate("__gMeasure()");
  console.log("无键盘：", JSON.stringify({ kbb: closed.kbb, vph: closed.vph, kbVar: closed.kbVar, barB: closed.bar.b }));
  add("G1 无键盘：条底边 = 玻璃栏上沿",
    closed.bar && Math.abs(closed.bar.b - (INNER - BAR)) <= 1.5,
    `条底=${closed.bar?.b} 期望=${INNER - BAR} (kbb=${closed.kbb} vph=${closed.vph})`);
  add("G1b 无键盘：--kbb = 栏高",
    Math.abs(parseFloat(closed.kbb) - BAR) <= 2, `--kbb=${closed.kbb} 期望=${BAR}`);
  add("G4 无键盘：kb 必须为 0（栏不是键盘）",
    parseFloat(closed.kbVar || "0") === 0, `--kb-h=${closed.kbVar}`);
  add("G1c 无键盘：面板变量不涨（没打字就不该有面板高）",
    parseFloat(closed.panelVar || "0") === 0, `--kb-last=${closed.panelVar}`);

  await evaluate(`__gSet(${KB})`);
  await sleep(900);
  const open = await evaluate("__gMeasure()");
  console.log("键盘态：", JSON.stringify({ kbb: open.kbb, panel: open.panelVar, barB: open.bar.b }));
  add("G2 键盘态：条底边 = 键盘上沿",
    open.bar && Math.abs(open.bar.b - (INNER - BAR - KB)) <= 2,
    `条底=${open.bar?.b} 期望=${INNER - BAR - KB} (kbb=${open.kbb})`);
  /* 轮 509：面板高要的是**键盘本体高**，不是让位量（栏+键盘）。
   * 面板态：条底 = inner − 栏，输入行再被 padding-bottom 顶上去 ⇒ 行底 = inner − 栏 − 面板高。
   * 键盘态：行底 = inner − 栏 − 键盘。
   * 两者相等 ⇔ 面板高 = 键盘。取栏+键盘会多抬一条栏，用户看到输入条往下跳 81px。 */
  add("G3 面板变量 = 键盘本体高（开面板时输入行不跳）",
    Math.abs(parseFloat(open.panelVar || "0") - KB) <= 2,
    `--kb-last=${open.panelVar} 期望=${KB}`);
  /* 键盘态行底（屏幕）= inner − kbb − offsetTop；面板态行底（屏幕）= inner − 栏 − 面板高。 */
  const kbRowBottom = INNER - parseFloat(open.kbb || "0") - (open.vvTop || 0);
  const pkRowBottom = INNER - BAR - parseFloat(open.panelVar || "0");
  add("G3b 键盘态与面板态输入行底重合（开面板不跳）",
    Math.abs(pkRowBottom - kbRowBottom) <= 2,
    `面板态行底=${pkRowBottom} 键盘态行底=${kbRowBottom}`);

  /* 面板本身的样式在 WpComposer.vue 的 scoped style 里（要 data-v 属性），
     手工造的 div 拿不到，所以这里不断言它的几何；「面板与条同吃 --kbb」由
     keyboard-policy-test 的 CSS 断言锁住，不重复造一个测不到的东西。 */

  await evaluate(`__gSet(0)`);
  await sleep(800);
  const back = await evaluate("__gMeasure()");
  add("G5 收起键盘完全复原",
    back.bar && Math.abs(back.bar.b - (INNER - BAR)) <= 1.5,
    `条底=${back.bar?.b} 期望=${INNER - BAR}`);

  for (const c of checks) console.log((c.ok ? "ok   " : "FAIL ") + c.name + (c.ok ? "" : " :: " + c.detail));
  console.log(`\nios26-glass-test: ${checks.filter((c) => c.ok).length} pass, ${fails.length} fail`);

  ws.close(); srv.close();
  try { child.kill(); } catch (e) {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error("IOS26_FAIL:", e.message); process.exit(1); });
