/* 按下那一刻的整屏截图（调试基建）
 *   用法：node tools/press-shot.mjs --tag=a [--x=542 --y=718] [--delay=260]
 *   前置：adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
 *   行为：先派发真手指 `adb shell input tap`，delay 毫秒后用 CDP Page.captureScreenshot 抓整屏，
 *         存 .probe8/<tag>.png。screencap 一次要 400ms 上下，抓不到 140~690ms 这段按压窗口；
 *         CDP 截图 50~100ms，能落在窗口里。抓完不改导航，由调用方决定返回。
 */
import fs from "node:fs";
import { spawn } from "node:child_process";
import WebSocket from "ws";

const ADB = "C:/Users/lin/AppData/Local/Android/Sdk/platform-tools/adb.exe";
const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith("--" + n + "="));
  return hit ? hit.split("=").slice(1).join("=") : d;
};
const TAG = arg("tag", "shot");
const X = arg("x", "542");
const Y = arg("y", "718");
const DELAY = Number(arg("delay", "260"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const adb = (...a) => new Promise((res) => { const p = spawn(ADB, a, { stdio: "ignore" }); p.on("close", res); p.on("error", res); });

async function main() {
  const list = await fetch("http://127.0.0.1:9222/json").then((r) => r.json());
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("no-page-target");
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
  let id = 0;
  const send = (method, params = {}) =>
    new Promise((res) => {
      const mid = ++id;
      const onMsg = (raw) => { const m = JSON.parse(raw); if (m.id === mid) { ws.off("message", onMsg); res(m.result); } };
      ws.on("message", onMsg);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  try { await send("Emulation.setFocusEmulationEnabled", { enabled: true }); } catch (e) {}
  adb("shell", "input", "tap", X, Y);
  await sleep(DELAY);
  const r = await send("Page.captureScreenshot", { format: "png" });
  fs.mkdirSync(".probe8", { recursive: true });
  fs.writeFileSync(`.probe8/${TAG}.png`, Buffer.from(r.data, "base64"));
  ws.close();
  console.log("saved .probe8/" + TAG + ".png");
  process.exit(0);
}
main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
