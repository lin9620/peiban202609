/* ═══ 轮 470 · 多浏览器内核矩阵：不再「只在我这台机上量准」═══
 *
 * 为什么要有这个工装：
 *   前几轮都是拿一台真机（小米浏览器）量出数字，再照那个数字调判据。换台机、换个内核，
 *   读数语义就变了 —— 用户原话「不要换个手机换个浏览器又出现不同的空白距离问题」。
 *   这台机上「量准」不构成任何保证。
 *
 * 它怎么做到「模拟别的浏览器」而仍然可信：
 *   · 渲染是真的：无头 Edge 真实排版 + 真实构建产物（dist）+ 真实 CSS，几何全用
 *     getBoundingClientRect 量，不做任何推算；
 *   · 只有「浏览器上报的视口读数」是伪造的 —— 而各家内核的差异恰恰只体现在这几个数上
 *     （innerHeight / visualViewport.height / offsetTop / 认不认 dvh / 派不派发事件）。
 *   · 两种键盘机制分开模拟，这一点很关键：
 *       resize  模式（Chromium / 小米）= 直接改 CDP 视口高度，布局视口真的缩，
 *                100dvh 跟着缩 —— 与真实 resizes-content 同构；
 *       overlay 模式（iOS Safari / 国产内核）= 窗口高度不动（布局视口不变），
 *                只让 visualViewport.height 变小 —— 与真实 overlay 键盘同构。
 *     两者混用会得出假结论，所以必须分开。
 *
 * 断言只看用户能看见的事实（不重算被测代码的公式）：
 *   ① 吸底评论条的下沿必须落在「可见区底」上，不许被键盘盖住、也不许悬空留缝；
 *   ② 聊天容器必须正好铺满可见区，且文档不可被推动（那正是「一拉就露白」的病根）；
 *   ③ 收起键盘后必须完整回到初始几何（不许留内联残值）。
 *
 * 用法：
 *   node tools/kb-matrix.mjs                     # 全矩阵
 *   node tools/kb-matrix.mjs --only=ios-safari   # 只跑某个内核
 *   node tools/kb-matrix.mjs --devices=393x852   # 只跑某个尺寸
 *   node tools/kb-matrix.mjs --json=_scratch/kb-matrix.json
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith("--" + n + "="));
  return hit ? hit.split("=").slice(1).join("=") : d;
};
const DIST = path.resolve(arg("dist", "dist"));
const ONLY = arg("only", "");
const DEV_FILTER = arg("devices", "");
const JSON_OUT = arg("json", "");

const EDGE = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => fs.existsSync(p));
if (!EDGE) { console.error("KB_MATRIX_FAIL: msedge-not-found"); process.exit(1); }
if (!fs.existsSync(path.join(DIST, "index.html"))) {
  console.error("KB_MATRIX_FAIL: dist-not-found（先 npm run build）"); process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 内核样本 ────────────────────────────────────────────────────────────
 * mode     : resize = 键盘缩布局视口（改 CDP 视口高）；overlay = 布局视口不动、只缩可视视口
 * dvh      : 认不认 100dvh（Chromium 108 以下 / 部分国产内核不认）
 * toolbar  : 无键盘时 visualViewport.height 比 innerHeight 少的量（浏览器工具栏被重复扣）
 * events   : 键盘起落时是否派发 visualViewport 事件（有的内核只派发 window.resize）
 * noVV     : 老内核完全没有 visualViewport
 * kbRatio  : 键盘占屏高比例（0.42 ≈ 常见中文输入法）
 */
const PROFILES = [
  { id: "chromium-android", desc: "Chromium 108+ / resizes-content", mode: "resize", dvh: true, toolbar: 0, events: true, kbRatio: 0.42 },
  { id: "miui-browser", desc: "小米浏览器 / 缩布局视口 + 工具栏重复扣 + 不认 dvh", mode: "resize", dvh: false, toolbar: 31, events: true, kbRatio: 0.42 },
  { id: "ios-safari", desc: "iOS Safari / overlay 键盘（inner 不变）", mode: "overlay", dvh: true, toolbar: 0, events: true, kbRatio: 0.42 },
  { id: "ios-safari-pushed", desc: "iOS Safari / 键盘把可视视口上推 24px", mode: "overlay", dvh: true, toolbar: 0, events: true, kbRatio: 0.42, vvTopExtra: 24 },
  { id: "overlay-silent", desc: "国产 overlay 内核 / 不派发 visualViewport 事件", mode: "overlay", dvh: true, toolbar: 0, events: false, kbRatio: 0.42 },
  { id: "old-webview-no-vv", desc: "老 WebView（无 visualViewport）/ 窗口直接缩", mode: "resize", dvh: false, toolbar: 0, events: true, noVV: true, kbRatio: 0.42 },
  /* App 壳（APK）：adjustNothing → 窗口永不缩，键盘高度由原生插件写进 --kb-h。
   * 这条路上 fixedBar / chatViewport 都必须早退（混进来会把条顶穿，轮 322 踩过），
   * 全靠 CSS 的 calc(100dvh - var(--kb-h))。列在这里是为了防止「修网页端时把 App 顶掉」。 */
  { id: "app-shell", desc: "App 壳 / 原生 --kb-h，窗口不缩", mode: "native", dvh: true, toolbar: 0, events: true, kbRatio: 0.42 },
];

const DEVICES = [
  { id: "360x640", w: 360, h: 640, dpr: 2 },
  { id: "393x852", w: 393, h: 852, dpr: 3 },
  { id: "412x915", w: 412, h: 915, dpr: 2.625 },
  { id: "852x393", w: 852, h: 393, dpr: 3 },   /* 横屏：键盘更矮、可见区更扁 */
];

/* ── 静态服务（SPA 回退，与线上托管同构）── */
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff", ".map": "application/json",
};
function startServer(dir) {
  const srv = http.createServer((req, res) => {
    const raw = req.url || "/";
    const u = decodeURIComponent(raw.split("?")[0]);
    let f = path.join(dir, u);
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(dir, "index.html");
    /* ?capapp=1 → 直接把 class 写进 <html>。
     * 为什么不在页面脚本里加：addScriptToEvaluateOnNewDocument 跑在文档创建前，
     * 那时 documentElement 还不存在；靠 setTimeout / rAF 补又可能晚于 main.js，
     * fixedBar 已经先跑了一遍（实测就是这样：类加上去了，内联 top 已经写死）。
     * 从 HTML 里带进去才是「起始即原生壳」，与真机 APK 等价。 */
    if (/[?&]capapp=1(&|$)/.test(raw)) {
      let html = fs.readFileSync(f, "utf8");
      html = html.replace(/<html(\s|>)/, '<html class="cap-app"$1');
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv)));
}

/* ── 页内工装：装伪视口 + 造 DOM + 量几何 ────────────────────────────────
 * 注入时机是「文档脚本执行之前」（Page.addScriptToEvaluateOnNewDocument），
 * 这样 app 启动时绑定的就是伪视口对象 —— 后塞进去的话事件监听会漏掉。 */
const BOOTSTRAP = (p) => `(() => {
  ${
    p.mode === "native"
      ? `/* App 壳：把 cap-app 挂得越早越好（main.js 也是靠这个类走原生分支）。
           文档脚本执行前 documentElement 可能还没建好，轮询到有为止。 */
  (() => { let n = 0; const tick = () => {
      const de = document.documentElement;
      if (de) { de.classList.add("cap-app"); return; }
      if (n++ < 500) setTimeout(tick, 0);
    }; tick(); })();
  /* 关键：只挂 cap-app 类是不够的 —— isNativeShell() 先问 Capacitor，问到 "web" 就直接
     返回 false，根本不看类名。Capacitor 官方给了自定义平台入口（createCapacitor 读
     win.CapacitorCustomPlatform.name），把它设成 android 才是「真·原生壳」。 */
  window.CapacitorCustomPlatform = { name: "android" };`
      : ""
  }
  const cfg = window.__kbCfg = {
    mode: ${JSON.stringify(p.mode)},
    gap: ${p.toolbar || 0},
    kb: 0,
    topExtra: ${p.vvTopExtra || 0},
    dispatch: ${p.events === false ? "false" : "true"},
  };
  const real = window.visualViewport;
  const ev = new EventTarget();
  const r0 = (v) => Math.max(0, Math.round(v));
  const fake = {
    /* overlay：布局视口不动，键盘只吃掉可视视口；resize：布局视口已缩，vv 跟随真实值 */
    get height() {
      const base = cfg.mode === "overlay" ? window.innerHeight : (real ? real.height : window.innerHeight);
      return r0(base - cfg.kb - cfg.gap);
    },
    get width() { return real ? real.width : window.innerWidth; },
    get offsetTop() { return r0((real ? real.offsetTop : 0) + cfg.topExtra); },
    get offsetLeft() { return real ? real.offsetLeft : 0; },
    get pageTop() { return this.offsetTop; },
    get pageLeft() { return 0; },
    get scale() { return 1; },
    addEventListener: ev.addEventListener.bind(ev),
    removeEventListener: ev.removeEventListener.bind(ev),
    dispatchEvent: ev.dispatchEvent.bind(ev),
  };
  ${p.noVV ? "" : `Object.defineProperty(window, "visualViewport", { configurable: true, get: () => fake });`}
  /* dvh 能力伪造：只拦 height/100dvh 这一条，别的一律透传真实现 */
  ${
    p.dvh === false
      ? `const rs = CSS.supports.bind(CSS);
  CSS.supports = (a, b) => (/dvh/.test(String(b)) ? false : rs(a, b));`
      : ""
  }
  window.__kbSet = (patch) => {
    Object.assign(cfg, patch);
    if (cfg.dispatch !== false) {
      fake.dispatchEvent(new Event("resize"));
      fake.dispatchEvent(new Event("scroll"));
    }
  };
  window.__kbTruth = () => ({ mode: cfg.mode, kb: cfg.kb, gap: cfg.gap, topExtra: cfg.topExtra, noVV: ${p.noVV ? "true" : "false"} });
})();`;

/* 造两套真实结构的 DOM（用真实类名 → 真实 CSS 生效） */
const INSTALL = `(() => {
  const host = document.createElement("div");
  host.id = "kbmat-host";
  host.innerHTML =
    '<div class="dm-page dm-page--chat" id="kbmat-chat">' +
      '<div class="dm-wrap"><div class="dm-thread">' +
        '<div class="dm-scroll"><div style="height:1600px"></div></div>' +
      '</div></div>' +
    '</div>';
  /* App 壳档：真机上 .dm-page 是挂在 .shell（整屏）里的；本工装把它直接塞进 body 末尾，
     会排在首页内容下面（t=1083）。这里只把宿主钉到视口顶，被测的仍是 .dm-page 自己的
     CSS 高度 calc(100dvh - var(--kb-h))，没有替它算任何东西。 */
  if (window.__kbCfg && window.__kbCfg.mode === "native") {
    host.style.position = "fixed";
    host.style.top = "0";
    host.style.left = "0";
    host.style.width = "100%";
  }
  document.body.appendChild(host);

  const bar = document.createElement("div");
  bar.className = "cmt-main-bar";
  bar.id = "kbmat-bar";
  bar.innerHTML = '<textarea class="wp-composer-input" rows="1" placeholder="说点温柔的话"></textarea>' +
                  '<button class="cmt-send" type="button">发送</button>';
  document.body.appendChild(bar);

  const R = (el) => { const r = el.getBoundingClientRect(); return { t: +r.top.toFixed(2), b: +r.bottom.toFixed(2), h: +r.height.toFixed(2), w: +r.width.toFixed(2) }; };
  window.__kbHarness = {
    measure() {
      const chat = document.getElementById("kbmat-chat");
      const bar = document.getElementById("kbmat-bar");
      const sc = document.querySelector("#kbmat-chat .dm-scroll");
      const y0 = window.scrollY;
      window.scrollTo(0, 400);
      const pushed = window.scrollY > 0;
      window.scrollTo(0, y0);
      const vv = window.visualViewport;
      const cs = chat ? getComputedStyle(chat) : null;
      return {
        inner: Math.round(window.innerHeight),
        vvH: vv ? Math.round(vv.height) : null,
        vvTop: vv ? Math.round(vv.offsetTop) : null,
        kbVar: getComputedStyle(document.documentElement).getPropertyValue("--kb-h").trim() || "0px",
        kbb: getComputedStyle(document.documentElement).getPropertyValue("--kbb").trim(),
        vph: getComputedStyle(document.documentElement).getPropertyValue("--vph").trim(),
        dvh: CSS.supports("height", "100dvh"),
        chat: chat ? Object.assign(R(chat), { pos: cs.position, inlineH: chat.style.height || "auto", inlineTop: chat.style.top || "auto" }) : null,
        bar: bar ? Object.assign(R(bar), { inlineTop: bar.style.top || "auto", inlineBottom: bar.style.bottom || "auto", cssBottom: getComputedStyle(bar).bottom }) : null,
        chatScroller: sc ? +sc.scrollTop.toFixed(1) : null,
        docPushed: pushed,
        htmlClass: document.documentElement.className,
        barDbg: window.__wpBarDebug ? window.__wpBarDebug.runs : null,
        chatFix: document.documentElement.classList.contains("wp-chat-fix"),
      };
    },
    destroy() {
      document.getElementById("kbmat-host")?.remove();
      document.getElementById("kbmat-bar")?.remove();
    },
  };
  return true;
})()`;

async function main() {
  const srv = await startServer(DIST);
  const port = srv.address().port;
  const base = "http://127.0.0.1:" + port + "/";
  const dbgPort = 9500 + Math.floor(Math.random() * 300);
  const profile = path.join(os.tmpdir(), "wp-kbmat-" + Date.now());
  const child = spawn(EDGE, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--remote-debugging-port=" + dbgPort, "--user-data-dir=" + profile,
    "--window-size=900,1000", "about:blank",
  ], { stdio: "ignore" });

  let ver = null;
  for (let i = 0; i < 80 && !ver; i++) {
    await sleep(200);
    try { ver = await fetch(`http://127.0.0.1:${dbgPort}/json/version`).then((r) => r.json()); } catch (e) {}
  }
  if (!ver) throw new Error("edge-not-ready");
  const list = await fetch(`http://127.0.0.1:${dbgPort}/json/list`).then((r) => r.json());
  const page = list.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 128 * 1024 * 1024 });
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
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });

  const setViewport = (w, h, dpr) => send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: dpr, mobile: true });

  const profiles = ONLY ? PROFILES.filter((p) => p.id === ONLY) : PROFILES;
  const devices = DEV_FILTER ? DEVICES.filter((d) => d.id === DEV_FILTER) : DEVICES;
  if (!profiles.length) { console.error("KB_MATRIX_FAIL: no-profile " + ONLY); process.exit(1); }
  if (!devices.length) { console.error("KB_MATRIX_FAIL: no-device " + DEV_FILTER); process.exit(1); }

  const rows = [];
  const fails = [];

  for (const p of profiles) {
    const { identifier } = await send("Page.addScriptToEvaluateOnNewDocument", { source: BOOTSTRAP(p) });
    for (const d of devices) {
      const K = Math.round(d.h * p.kbRatio);         /* 键盘高度 */
      const visH = d.h - K;                          /* 键盘上方的可见高度 */
      const row = { profile: p.id, device: d.id, K, mode: p.mode, cases: {} };

      await setViewport(d.w, d.h, d.dpr);
      const capFlag = p.mode === "native" ? "&capapp=1" : "";
      await send("Page.navigate", { url: base + "?kbmat=" + Date.now() + capFlag });
      await sleep(1600);
      await evaluate(INSTALL);
      await sleep(700);                              /* 等 fixedBar / chatViewport 的低频巡检 */

      /* 键盘起落：三种机制各走各的路，混用一定得出假结论 */
      const kbOn = async (on) => {
        if (p.mode === "overlay") {
          await evaluate(`__kbSet({ kb: ${on ? K : 0} })`);
        } else if (p.mode === "native") {
          /* App 壳：窗口不动，原生插件写 --kb-h（CSS 的 calc 全靠它） */
          await evaluate(`document.documentElement.style.setProperty("--kb-h", "${on ? K : 0}px")`);
        } else {
          await setViewport(d.w, on ? visH : d.h, d.dpr);
        }
      };

      const closed = await evaluate("__kbHarness.measure()");
      await kbOn(true);
      await sleep(800);
      const open = await evaluate("__kbHarness.measure()");
      await kbOn(false);
      await sleep(700);
      const back = await evaluate("__kbHarness.measure()");

      /* 可见区底（期望值）—— 必须按键盘机制分开算，混用会得出假结论：
       *   resize 模式：布局视口就是可见区，键盘把窗口缩了 → 期望 = innerHeight。
       *                这里**绝不能**拿 vv 当基准：小米浏览器无键盘时 vv 比 inner 少 31px
       *                （工具栏被重复扣），拿它当真相等于把那个 bug 当成标准答案。
       *   overlay 模式：布局视口没动，键盘只盖住下半截 → 期望 = vvTop + vv.height。
       *   native 模式（App 壳）：窗口不动，键盘高度只有 --kb-h 知道 → 期望 = inner − K。 */
      const visBottom = (m) => (p.mode === "overlay" ? m.vvTop + m.vvH : p.mode === "native" ? m.inner - K : m.inner);
      const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol;

      const checks = [];
      const add = (name, ok, detail) => { checks.push({ name, ok, detail }); if (!ok) fails.push(`${p.id}@${d.id} · ${name} → ${detail}`); };

      /* ① 聊天容器：无键盘正好铺满、不被推动 */
      add("chat·收起态铺满可见区", closed.chat && near(closed.chat.b, closed.inner) && near(closed.chat.t, 0),
        `b=${closed.chat?.b} t=${closed.chat?.t} inner=${closed.inner}`);
      if (p.mode !== "native") {
        add("chat·收起态文档不可推动", closed.docPushed === false, `docPushed=${closed.docPushed}`);
      }

      /* ② 聊天容器：键盘态下沿贴住键盘上沿 */
      add("chat·键盘态贴住键盘上沿", open.chat && near(open.chat.b, visBottom(open)),
        `b=${open.chat?.b} 可见底=${visBottom(open)} (inner=${open.inner} vvH=${open.vvH} vvTop=${open.vvTop})`);
      add("chat·键盘态不越过可见区顶", open.chat && open.chat.t >= -1.5 && near(open.chat.t, open.vvTop || 0, 2),
        `t=${open.chat?.t} vvTop=${open.vvTop}`);
      /* App 壳不做文档锁（那是网页端 fixed 接管的配套动作）；本工装注入的 DOM 挂在可滚的
       * 首页上，所以这一条对 native 档不适用，跳过而不是放宽 —— 放宽等于把判据弄钝。 */
      if (p.mode !== "native") {
        add("chat·键盘态文档不可推动", open.docPushed === false, `docPushed=${open.docPushed}`);
      }

      /* ③ 评论条：无键盘贴底、键盘态不被盖住也不悬空 */
      add("bar·收起态贴底", closed.bar && near(closed.bar.b, closed.inner),
        `b=${closed.bar?.b} inner=${closed.inner}`);
      add("bar·键盘态贴住键盘上沿", open.bar && near(open.bar.b, visBottom(open)),
        `b=${open.bar?.b} 可见底=${visBottom(open)} (inner=${open.inner} vvH=${open.vvH} vvTop=${open.vvTop}) kbVar=${open.kbVar} cls=${open.htmlClass} barDbg=${open.barDbg} 内联=${open.bar?.inlineTop}/${open.bar?.inlineBottom}`);
      add("bar·键盘态完整可见", open.bar && open.bar.t >= -1 && open.bar.b <= visBottom(open) + 1.5,
        `t=${open.bar?.t} b=${open.bar?.b} 可见底=${visBottom(open)}`);

      /* ④ 收键盘后必须完全回到初始几何（不许留内联残值） */
      add("chat·收键盘复原", back.chat && near(back.chat.b, back.inner) && near(back.chat.t, 0),
        `b=${back.chat?.b} t=${back.chat?.t} inner=${back.inner}`);
      add("bar·收键盘复原", back.bar && near(back.bar.b, back.inner), `b=${back.bar?.b} inner=${back.inner}`);

      row.cases = { closed, open, back };
      row.checks = checks;
      rows.push(row);

      const bad = checks.filter((c) => !c.ok).length;
      console.log(
        `${bad ? "FAIL" : " ok "}  ${p.id.padEnd(18)} ${d.id.padEnd(8)} ` +
        `inner=${String(open.inner).padStart(3)} vv=${String(open.vvH).padStart(3)}/${String(open.vvTop).padStart(2)} ` +
        `kbVar=${open.kbVar.padStart(5)} dvh=${closed.dvh ? "y" : "n"} | ` +
        `chat b=${open.chat?.b} (期望 ${visBottom(open)})  bar b=${open.bar?.b}  kbb=${open.kbb} vph=${open.vph} ` +
        `bar 内联 top=${open.bar?.inlineTop}`
      );
    }
    await send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
  }

  console.log("\n" + "─".repeat(96));
  const cases = rows.length;
  const total = rows.reduce((n, r) => n + r.checks.length, 0);
  const passed = rows.reduce((n, r) => n + r.checks.filter((c) => c.ok).length, 0);
  console.log(`矩阵：${profiles.length} 内核 × ${devices.length} 尺寸 = ${cases} 组合 / ${total} 断言，通过 ${passed}`);

  if (fails.length) {
    console.log("\n失败清单：");
    fails.forEach((f) => console.log("  ✗ " + f));
  }

  if (JSON_OUT) {
    fs.mkdirSync(path.dirname(path.resolve(JSON_OUT)), { recursive: true });
    fs.writeFileSync(path.resolve(JSON_OUT), JSON.stringify({ rows, fails, passed, total }, null, 1));
    console.log("JSON " + path.resolve(JSON_OUT));
  }

  ws.close(); srv.close();
  try { child.kill(); } catch (e) {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error("KB_MATRIX_FAIL:", e.message); process.exit(1); });
