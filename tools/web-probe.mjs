/* 网页版实测工装（独立于真机）：无头 Edge + CDP 精确设备模拟 + 真实站点/构建产物
 *   用法：node tools/web-probe.mjs --file=./tools/_expr_x.js [--url=https://warmpaws.de5.net/]
 *                                    [--w=393] [--h=852] [--wait=1500] [--dpr=2.75] [--shot=out.png]
 *                                    [--proxy=/sb=https://warmpaws.de5.net/sb]（可重复，需配 --serve）
 *                                    [--timeout=30000]（页面内求值的超时；长时间滚动的脚本要给大）
 *   行为：起无头 Edge（远程调试）→ Emulation.setDeviceMetricsOverride 精确模拟手机视口
 *         → 导航 → 等 load + wait ms → 在页面里求值 --file（awaitPromise/returnByValue）→ 打印 JSON
 *         → 传了 --shot 再截一张 PNG（肉眼验收排版，省得靠猜）
 *   附：--trace=1 时同时订阅 Console/异常，便于排查（默认关，只回值）
 *   退出：打印结果后关浏览器（临时 profile 一并删除）。 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith("--" + name + "="));
  return hit ? hit.split("=").slice(1).join("=") : dflt;
};
const file = arg("file", "");
const url = arg("url", "https://warmpaws.de5.net/");
const W = Number(arg("w", "393")), H = Number(arg("h", "852"));
const dpr = Number(arg("dpr", "2.75"));
const waitMs = Number(arg("wait", "1500"));
const trace = arg("trace", "0") === "1";
const PORT = Number(arg("port", "9333"));
const serve = arg("serve", "");          /* 传目录（如 dist）→ 起本地静态服务器 + SPA 回退，--url 可写相对路径 */
const servePort = Number(arg("servePort", "0")); /* 0 = 系统分配（避免并发/残留占用 8791） */
/* 轮 526 · `--ua=ios` / `--ua=android`。
 *
 * 以前这个探针只覆盖视口尺寸，不改 User-Agent —— 于是所有「iOS 工装」其实跑在
 * HeadlessChrome 的 UA 下：guessOverlayByUA() 判 resize、html 永远没有 kb-overlay 类、
 * bottomPin 的闭环校正一次都没跑过。也就是说 iOS 那几条断言里，
 * 「闭环把条拉回可视区底」这一整类从来没被真正验证。
 * 这里把 UA 也换成真机型，工装才配叫 iOS 工装。 */
const uaKind = arg("ua", "");
const UA_IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15"
  + " (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const UA_ANDROID = "Mozilla/5.0 (Linux; Android 14; 23054RA19C) AppleWebKit/537.36"
  + " (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
const evalTimeout = Number(arg("timeout", "30000"));   /* 页面内脚本要跑几十秒时调大 */
const shot = arg("shot", "");            /* 传路径 → 求值后再截一张 PNG（肉眼验收排版） */
let child = null;                        /* 提到模块作用域：退出时才能真正杀掉无头 Edge */

const EDGE = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => fs.existsSync(p));
if (!EDGE) { console.error("WEB_FAIL: msedge-not-found"); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = path.join(os.tmpdir(), "wp-web-probe-" + Date.now());

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff", ".map": "application/json",
};
/* ── 同源反代（--proxy=/sb=https://warmpaws.de5.net/sb）─────────────────────
 * 为什么需要：dist 里的云请求走 sbFetch 拼成 `${API_BASE}/sb/*`。给 App 用的构建把
 * API_BASE 写死成绝对地址，浏览器从 127.0.0.1 打开时就成了跨源 → 网关没开 CORS，
 * 整条数据链取不到（页面只剩空壳，看上去像「组件坏了」）。
 * 反过来把 API_BASE 留空（同源 /sb），再由本地服务器反代到网关 —— 与线上托管完全同构。
 * 支持多个 --proxy，写成 a=b 重复给即可。 */
const proxies = process.argv
  .filter((a) => a.startsWith("--proxy="))
  .map((a) => a.slice(8))
  .map((s) => { const i = s.indexOf("="); return i > 0 ? { from: s.slice(0, i), to: s.slice(i + 1) } : null; })
  .filter(Boolean);

async function forward(req, res, rule) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const dest = rule.to.replace(/\/$/, "") + (req.url || "").slice(rule.from.length);
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (/^(host|connection|accept-encoding|content-length)$/i.test(k)) continue;
    headers[k] = v;
  }
  try {
    const r = await fetch(dest, { method: req.method, headers, body });
    const buf = Buffer.from(await r.arrayBuffer());
    const h = {};
    r.headers.forEach((v, k) => {
      if (/^(content-encoding|content-length|transfer-encoding|connection)$/i.test(k)) return;
      h[k] = v;
    });
    res.writeHead(r.status, h);
    res.end(buf);
  } catch (e) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "proxy-failed: " + (e && e.message) }));
  }
}

/* 本地静态服务器 + SPA 回退（线上托管也有同款回退；缺文件→index.html） */
function startServer(dir) {
  const srv = http.createServer((req, res) => {
    const hitRule = proxies.find((p) => (req.url || "").startsWith(p.from));
    if (hitRule) { forward(req, res, hitRule); return; }
    const url = decodeURIComponent((req.url || "/").split("?")[0]);
    let file = path.join(dir, url);
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dir, "index.html");
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  srv.keepAliveTimeout = 1;
  return new Promise((res) => srv.listen(servePort, "127.0.0.1", () => res(srv)));
}

async function main() {
  let srv = null;
  let target = url;
  if (serve) {
    srv = await startServer(serve);
    target = "http://127.0.0.1:" + srv.address().port + (url.startsWith("http") ? "/" : url);
  }
  child = spawn(EDGE, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--remote-debugging-port=" + PORT, "--user-data-dir=" + profile,
    "--window-size=" + W + "," + H, "about:blank",
  ], { stdio: "ignore" });

  let ver = null;
  for (let i = 0; i < 60 && !ver; i++) {
    await sleep(250);
    try { ver = await fetch("http://127.0.0.1:" + PORT + "/json/version").then((r) => r.json()); }
    catch (e) { /* 还没起来 */ }
  }
  if (!ver) throw new Error("edge-not-ready");

  const list = await fetch("http://127.0.0.1:" + PORT + "/json/list").then((r) => r.json());
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("no-page-target");
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });

  let id = 0;
  const pending = new Map();
  const logs = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (trace && m.method === "Runtime.consoleAPICalled") {
      logs.push(m.params.type + ": " + (m.params.args || []).map((a) => a.value ?? a.description ?? "").join(" "));
    }
    if (trace && m.method === "Runtime.exceptionThrown") {
      logs.push("EXCEPTION: " + (m.params.exceptionDetails?.exception?.description || "").slice(0, 300));
    }
  });
  const send = (method, params) => new Promise((res) => {
    const mid = ++id;
    pending.set(mid, (m) => { if (m.error) throw new Error(method + " → " + m.error.message); res(m.result); });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });

  await send("Runtime.enable", {});
  await send("Page.enable", {});
  await send("Emulation.setDeviceMetricsOverride", {
    width: W, height: H, deviceScaleFactor: dpr, mobile: true,
  });
  if (uaKind === "ios" || uaKind === "android") {
    await send("Emulation.setUserAgentOverride", {
      userAgent: uaKind === "ios" ? UA_IOS : UA_ANDROID,
      platform: uaKind === "ios" ? "iPhone" : "Linux armv8l",
      acceptLanguage: "zh-CN,zh;q=0.9",
    });
  }
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await send("Page.navigate", { url: target });
  await sleep(waitMs);

  const expr = file ? fs.readFileSync(file, "utf8") : "location.href";
  const r = await send("Runtime.evaluate", {
    expression: expr, awaitPromise: true, returnByValue: true, timeout: evalTimeout,
  });
  console.log(JSON.stringify(r.result && r.result.value !== undefined ? r.result.value : r, null, 1));
  if (trace && logs.length) console.log("--- console ---\n" + logs.slice(-25).join("\n"));

  /* 截图（--shot=out.png）：求值后整屏一张，肉眼验收排版。
   * 用 Page.captureScreenshot（captureBeyondViewport=false 只取当前视口），
   * 失败只提示不影响返回值（截图是辅助手段，不是验收依据）。 */
  if (shot) {
    try {
      const cap = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
      const out = path.resolve(shot);
      fs.writeFileSync(out, Buffer.from(cap.data, "base64"));
      console.log("SHOT " + out + " (" + Math.round(fs.statSync(out).size / 1024) + " KB)");
    } catch (e) {
      console.log("SHOT_FAIL " + (e && e.message ? e.message : e));
    }
  }
  ws.close();
  if (srv) srv.close();
  try { child.kill(); } catch (e) {}
  return r.exceptionDetails ? 1 : 0;
}

main()
  .then((code) => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {} try { child && child.kill(); } catch (e) {} process.exit(code); })
  .catch((e) => {
    console.error("WEB_FAIL:", e.message);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e2) {}
    try { child && child.kill(); } catch (e3) {}
    process.exit(1);
  });
