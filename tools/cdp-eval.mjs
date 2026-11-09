/* 真机 WebView CDP 求值器（调试基建，非一次性探针）
 *   用法：node tools/cdp-eval.mjs --file=./tmp-expr.js [--wait=800]
 *   前置：adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
 *   行为：连 tcp:9222 第一个 page target → Runtime.evaluate（awaitPromise + returnByValue）
 *   表达式文件最后是一个 IIFE/表达式，返回值 JSON 打印；超时 20s。
 */
import fs from "node:fs";
import http from "node:http";
import WebSocket from "ws";

/* 本机调试口必须绕开系统代理：环境里 HTTP_PROXY 常指向 127.0.0.1:xxxxx（抓包/代理工具），
 * Node 的 fetch 会遵守它，于是连 127.0.0.1:9222 也走代理 → fetch failed。
 * 用最原始的 http.request 直连，不受 env proxy 影响。 */
const httpGetJson = (port, pathname) => new Promise((res, rej) => {
  const req = http.request({ host: "127.0.0.1", port, path: pathname, method: "GET" }, (r) => {
    let s = "";
    r.setEncoding("utf8");
    r.on("data", (d) => { s += d; });
    r.on("end", () => { try { res(JSON.parse(s)); } catch (e) { rej(new Error("bad-json")); } });
  });
  req.on("error", rej);
  req.setTimeout(5000, () => req.destroy(new Error("timeout")));
  req.end();
});

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith("--" + name + "="));
  return hit ? hit.split("=").slice(1).join("=") : dflt;
};
const file = arg("file", "");
const waitMs = Number(arg("wait", "500"));
/* 9222 常被历史转发/本机代理占着（占着时 curl 能通但内容是 upstream connect failed）。
 * 用 --port=9333 换一口，不必为了取一次数去杀别人的监听。 */
const port = arg("port", "9222");
/* 息屏/被遮挡时 WebView 的 rAF 冻结 → Vue 路由过渡（transition out-in）会停在中途、新视图不挂载。
 * 默认开 Emulation.setFocusEmulationEnabled：让页面自认「可见且聚焦」，取数不再受屏幕状态影响。
 * 需要真实可见性行为时传 --focus=0 关掉。 */
const focus = arg("focus", "1") !== "0";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const list = await httpGetJson(port, "/json");
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("no-page-target");
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
  let id = 0;
  const send = (method, params) => new Promise((res) => {
    const mid = ++id;
    const onMsg = (raw) => {
      const m = JSON.parse(raw);
      if (m.id === mid) { ws.off("message", onMsg); res(m.result); }
    };
    ws.on("message", onMsg);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  if (focus) {
    try { await send("Emulation.setFocusEmulationEnabled", { enabled: true }); }
    catch (e) { /* 老内核不支持则忽略 */ }
    /* 息屏/后台时页面被判定 hidden → 定时器被节流到「1 分钟 1 次」、rAF 冻结：
     * 强制置为 active 生命周期，取数不再被节流（--focus=0 可关掉看真实行为）。 */
    try { await send("Page.setWebLifecycleState", { state: "active" }); }
    catch (e) { /* 同上 */ }
  }
  if (waitMs) await sleep(waitMs);
  const expr = fs.readFileSync(file, "utf8");
  const r = await send("Runtime.evaluate", {
    expression: expr, awaitPromise: true, returnByValue: true, timeout: 20000,
  });
  ws.close();
  if (r.exceptionDetails) {
    console.log("EVAL_ERROR:", JSON.stringify(r.exceptionDetails).slice(0, 800));
    process.exit(1);
  }
  console.log(JSON.stringify(r.result.value, null, 1));
  process.exit(0);
}

main().catch((e) => { console.error("CDP_FAIL:", e.message); process.exit(1); });