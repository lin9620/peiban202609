/* 真机会话进入瞬间的逐帧探针（调试基建，非一次性探针）
 *   用法：node tools/kb-enter-probe.mjs --port=9333 --x=150 --y=314 [--ms=2500] [--pre=400] [--back=0]
 *   前置：adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>
 *
 * 做什么：先在页面里装满一个 rAF 采样器（window.__rec），再用 CDP 的
 * Input.dispatchTouchEvent 发一次**真实触摸**点开会话，然后回读采样。
 * 为什么不用合成的 click：合成 MouseEvent 不会唤起系统键盘，测不出「弹起又折叠」。
 * --back=1 先在页面里 history.back() 退回列表，等 900ms 再点（重复抓首帧用）。
 *
 * 采样字段（每渲染帧）：
 *   ih/vvh   视口高（resize / overlay 两种键盘机制各看一个）
 *   kb       --kb-h（只有 App 壳会写；网页端恒 0px，用来确认走的是哪条路）
 *   p        路由
 *   pg        .dm-page 高度 + 有没有 --chat 类
 *   thr       .dm-thread 高度
 *   box       .dm-vac-box 高度（宿主那层 flex 分配格）
 *   host      vue-advanced-chat 宿主高度 + 计算值
 *   win       shadow 里 .vac-card-window 高度 + 计算值
 *   ml        #messages-list top/bottom
 *   ft/fb     #room-footer top/bottom
 *   ae        深层 activeElement
 * 输出：只打印「与上一帧不同」的行，避免 150 帧噪音刷屏。
 */
import http from "node:http";
import WebSocket from "ws";

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith("--" + name + "="));
  return hit ? hit.split("=").slice(1).join("=") : dflt;
};
const port = arg("port", "9222");
const tapX = Number(arg("x", "0"));
const tapY = Number(arg("y", "0"));
const totalMs = Number(arg("ms", "2500"));
const preMs = Number(arg("pre", "400"));
const doBack = arg("back", "0") === "1";
const clickSel = arg("click", "");

const httpGetJson = (p, path) => new Promise((res, rej) => {
  const req = http.request({ host: "127.0.0.1", port: p, path, method: "GET" }, (r) => {
    let s = ""; r.setEncoding("utf8");
    r.on("data", (d) => { s += d; });
    r.on("end", () => { try { res(JSON.parse(s)); } catch (e) { rej(new Error("bad-json")); } });
  });
  req.on("error", rej);
  req.setTimeout(5000, () => req.destroy(new Error("timeout")));
  req.end();
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RECORDER = `(() => {
  if (window.__recStop) window.__recStop();          /* 上一轮可能还挂着 rAF 循环 */
  const rec = [];
  window.__rec = rec;
  const t0 = performance.now();
  const H = (e) => (e ? Math.round(e.getBoundingClientRect().height) : -1);
  const T = (e) => (e ? Math.round(e.getBoundingClientRect().top) : -1);
  const B = (e) => (e ? Math.round(e.getBoundingClientRect().bottom) : -1);
  const cs = (e, k) => (e ? getComputedStyle(e)[k] : "-");
  const deepActive = () => {
    let a = document.activeElement, n = 0;
    while (a && a.shadowRoot && a.shadowRoot.activeElement && n++ < 6) a = a.shadowRoot.activeElement;
    return a;
  };
  const shot = () => {
    const de = document.documentElement;
    const vv = window.visualViewport;
    const host = document.querySelector("vue-advanced-chat");
    const sr = host && host.shadowRoot;
    const win = sr && sr.querySelector(".vac-card-window");
    const ml = sr && sr.querySelector("#messages-list");
    const ft = sr && sr.querySelector("#room-footer");
    const pg = document.querySelector(".dm-page");
    const ae = deepActive();
    rec.push({
      f: rec.length,
      t: Math.round(performance.now() - t0),
      p: location.pathname.replace(/^\\/messages/, "m"),
      ih: Math.round(window.innerHeight),
      vvh: vv ? Math.round(vv.height) : null,
      kb: de.style.getPropertyValue("--kb-h") || "0",
      pg: H(pg) + (pg && pg.classList.contains("dm-page--chat") ? "C" : "-") + "/" + cs(pg, "height") + "/" + (pg ? (pg.style.height || "∅") : "-") + "/" + (pg ? cs(pg, "position") : "-"),
      thr: H(document.querySelector(".dm-thread")),
      box: H(document.querySelector(".dm-vac-box")) + "/" + cs(document.querySelector(".dm-vac-box"), "flex"),
      host: H(host) + "/" + cs(host, "height"),
      win: H(win) + "/" + cs(win, "height"),
      ml: T(ml) + "-" + B(ml),
      ft: T(ft) + "-" + B(ft),
      ae: ae ? ae.tagName + (ae.id ? "#" + ae.id : "") : null,
      kbi: (() => { const i = window.__kbInfo; return i ? i.src + ":" + i.raw + "→" + i.kbH : "∅"; })(),
    });
  };
  /* 用定时器而不是 rAF：真机 WebView 上 rAF 有时一帧都不跑（实测 n=0，
   * 而页面 visibilityState 仍是 visible），定时器不受 vsync 影响、照常出数。
   * 16ms ≈ 一帧，够看清单帧差异。 */
  window.__recOn = true;
  const iv = setInterval(() => { if (window.__recOn) shot(); }, 16);
  window.__recStop = () => { window.__recOn = false; clearInterval(iv); };
  return "ok";
})()`;

async function main() {
  const list = await httpGetJson(port, "/json");
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("no-page-target");
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
  let id = 0;
  const send = (method, params) => new Promise((res, rej) => {
    const mid = ++id;
    /* 目标页面一旦整页导航（history.back() 跨到别的文档），WebSocket 会静默断开，
     * 回调永远不来 —— 不给超时就会一直挂着（实测 timeout 124 退出）。
     * 20s 是 evaluate 自带的上限，这里留一点余量。 */
    const to = setTimeout(() => { ws.off("message", onMsg); rej(new Error(method + ": timeout")); }, 20000);
    const onMsg = (raw) => {
      const m = JSON.parse(raw);
      if (m.id === mid) {
        clearTimeout(to);
        ws.off("message", onMsg);
        if (m.error) rej(new Error(method + ": " + JSON.stringify(m.error)));
        else res(m.result);
      }
    };
    ws.on("message", onMsg);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const evalJs = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout: 20000 });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
  };

  try { await send("Emulation.setFocusEmulationEnabled", { enabled: true }); } catch (e) { /* 老内核 */ }

  if (doBack) {
    await evalJs("history.back(); 'back'");
    await sleep(900);
  }

  await evalJs(RECORDER);
  await sleep(preMs);

  const hit = await evalJs(`(() => {
    const el = document.elementFromPoint(${tapX}, ${tapY});
    return el ? el.tagName + "." + (typeof el.className === "string" ? el.className.trim().split(/\\s+/).slice(0,2).join(".") : "") : null;
  })()`);

  /* 两种点法：
   *  · 默认真实触摸（Input.dispatchTouchEvent）—— 验键盘必须用它，合成事件不弹键盘；
   *  · --click=<selector> 走 DOM click() —— 有些机器上 dispatchTouchEvent 会无响应，
   *    而验「布局高度」根本不需要真触摸，DOM 点击足够触发路由。 */
  if (clickSel) {
    /* 支持 "selector|N" 取第 N 个（列表项没有稳定 id，只能按序号点） */
    const [sel, idxRaw] = clickSel.split("|");
    const idx = Number(idxRaw || "0");
    const r = await evalJs(`(() => {
      const list = document.querySelectorAll(${JSON.stringify(sel)});
      const el = list[${Number.isFinite(idx) ? idx : 0}];
      if (!el) return "no-match(" + list.length + ")";
      el.click();
      return "clicked:" + (el.className || el.tagName);
    })()`);
    console.log("tap-target:", r);
  } else {
    const tp = [{ x: tapX, y: tapY, radiusX: 2, radiusY: 2, force: 1, id: 1 }];
    await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: tp });
    await sleep(60);
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  }

  await sleep(totalMs);
  const rec = await evalJs("(() => { window.__recStop && window.__recStop(); return window.__rec; })()");
  ws.close();

  const keys = ["f", "t", "p", "ih", "vvh", "kb", "pg", "thr", "box", "win", "ml", "ft", "kbi"];
  console.log("tap-target:", hit);
  console.log(keys.join("\t"));
  let prev = null;
  for (const f of rec) {
    const line = keys.map((k) => (f[k] === null ? "-" : f[k])).join("\t");
    if (line !== prev) console.log(line);
    prev = line;
  }
  console.log("frames:", rec.length);
  process.exit(0);
}

main().catch((e) => { console.error("PROBE_FAIL:", e.message); process.exit(1); });
