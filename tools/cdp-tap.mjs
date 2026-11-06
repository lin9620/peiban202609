/* 真机点击（调试基建）
 *   用法：node tools/cdp-tap.mjs --xy="195,420" [--gap=600] [--swipe="195,600,195,200,220"] [--wait=400]
 *   前置：adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
 *   行为：用 `adb shell input tap` 打真手指（走 Android 原生输入栈，含 fling/点击判定），
 *         坐标是 **CSS px**（内部 × dpr 转物理像素）；--swipe 打一次滑动（x1,y1,x2,y2,ms）。
 *         每次手势之间隔 --gap 毫秒。做完等 --wait 后打印页面路径与探针日志尾部。
 *   为什么要这个：CDP 的 Input.dispatchTouchEvent 绕过了原生输入栈，
 *         测不出「甩动后第一次 tap 被吞」这类系统级行为。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";

const ADB = "C:/Users/lin/AppData/Local/Android/Sdk/platform-tools/adb.exe";
const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith("--" + n + "="));
  return hit ? hit.split("=").slice(1).join("=") : d;
};
const XY = (arg("xy", "") || "").split(";").filter(Boolean).map((s) => s.split(",").map(Number));
const SWIPE = (arg("swipe", "") || "").split(";").filter(Boolean).map((s) => s.split(",").map(Number));
const GAP = Number(arg("gap", "700"));
const WAIT = Number(arg("wait", "400"));
const DPR = Number(arg("dpr", "2.75"));
const LOG = arg("log", "1") !== "0";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const adb = (...args) =>
  new Promise((res) => {
    const p = spawn(ADB, args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout.on("data", (b) => (out += b.toString()));
    p.on("close", (c) => res({ code: c, out: out.trim() }));
    p.on("error", () => res({ code: -1, out: "" }));
  });

async function main() {
  for (const [x, y] of XY) {
    const px = Math.round(x * DPR), py = Math.round(y * DPR);
    await adb("shell", "input", "tap", String(px), String(py));
    console.log(`tap css(${x},${y}) px(${px},${py})`);
    await sleep(GAP);
  }
  for (const [x1, y1, x2, y2, ms] of SWIPE) {
    const p = (v) => Math.round(v * DPR);
    await adb("shell", "input", "swipe", String(p(x1)), String(p(y1)), String(p(x2)), String(p(y2)), String(ms || 200));
    console.log(`swipe css(${x1},${y1})->(${x2},${y2}) ${ms || 200}ms`);
    await sleep(GAP);
  }
  await sleep(WAIT);
  if (!LOG) return;
  /* 打印页面状态 + 探针日志（探针没注入就只报路径） */
  const list = await fetch("http://127.0.0.1:9222/json").then((r) => r.json());
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("no-page-target");
  const { default: WebSocket } = await import("ws");
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
  const r = await new Promise((res) => {
    ws.once("message", (raw) => res(JSON.parse(raw)));
    ws.send(JSON.stringify({
      id: 1, method: "Runtime.evaluate",
      params: {
        expression: `(() => ({ path: location.pathname + location.search, log: (window.__tapLog || []).slice(-40) }))()`,
        returnByValue: true, awaitPromise: true,
      },
    }));
  });
  ws.close();
  const v = r.result && r.result.result && r.result.result.value;
  console.log(JSON.stringify(v, null, 1));
}

main().catch((e) => { console.error("TAP_FAIL:", e.message); process.exit(1); });
