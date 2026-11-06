/* 真机过渡逐帧录屏（调试基建）
 *   用法：node tools/screencast-tap.mjs --x=542 --y=718 --tag=first [--back=1]
 *   前置：adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
 *   行为：开 Page.startScreencast（jpeg q92，逐帧），第 350ms 用 `adb shell input tap`
 *         打真手指，录 2600ms；--back=1 时录完发硬件返回键。
 *   产物：.cast/<tag>/f000.jpg ... + index.json（到达时间戳、是否关键帧）
 *   为什么要这个：screencap 一次 300~500ms，抓不到「按下→离开」之间那一帧；
 *   screencast 是渲染管线直接吐帧，能看到用户真正看到的每一帧。
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import WebSocket from "ws";

const ADB = "C:/Users/lin/AppData/Local/Android/Sdk/platform-tools/adb.exe";
const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith("--" + n + "="));
  return hit ? hit.split("=").slice(1).join("=") : d;
};
const X = Number(arg("x", "542"));
const Y = Number(arg("y", "718"));
const TAG = arg("tag", "run");
const BACK = arg("back", "0") === "1";
const TAP_AT = Number(arg("tapAt", "350"));
/* --taps=350,540,690;2400,540,900  → 按时间点连打多次（时间,x,y），用 ; 分隔 */
const TAPS = (arg("taps", "") || "")
  .split(";")
  .filter(Boolean)
  .map((s) => s.split(",").map(Number))
  .map(([t, x, y]) => ({ t, x, y, done: false }))
  .sort((a, b) => a.t - b.t);
const TOTAL = Number(arg("dur", "2600"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = path.join(".cast", TAG);
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

const adb = (...args) =>
  new Promise((res) => {
    const p = spawn(ADB, args, { stdio: "ignore" });
    p.on("close", (c) => res(c));
    p.on("error", () => res(-1));
  });

async function main() {
  const list = await fetch("http://127.0.0.1:9222/json").then((r) => r.json());
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("no-page-target");
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
  let id = 0;
  const send = (method, params = {}) =>
    new Promise((res) => {
      const mid = ++id;
      const onMsg = (raw) => {
        const m = JSON.parse(raw);
        if (m.id === mid) { ws.off("message", onMsg); res(m.result); }
      };
      ws.on("message", onMsg);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });

  const frames = [];
  const t0 = Date.now();
  const started = Date.now();
  let tapDone = false;
  let backDone = false;

  ws.on("message", async (raw) => {
    const m = JSON.parse(raw);
    if (m.method === "Page.screencastFrame") {
      const { data, sessionId, metadata } = m.params;
      const idx = frames.length;
      const ts = Date.now() - t0;
      fs.writeFileSync(path.join(dir, "f" + String(idx).padStart(3, "0") + ".jpg"), Buffer.from(data, "base64"));
      frames.push({ i: idx, ts, w: metadata.deviceWidth, h: metadata.deviceHeight });
      send("Page.screencastFrameAck", { sessionId }).catch(() => {});
      if (!tapDone && ts >= TAP_AT) {
        tapDone = true;
        await adb("shell", "input", "tap", String(X), String(Y));
      }
      for (const tp of TAPS) {
        if (!tp.done && ts >= tp.t) {
          tp.done = true;
          await adb("shell", "input", "tap", String(tp.x), String(tp.y));
        }
      }
      if (BACK && !backDone && ts >= TOTAL - 900) {
        backDone = true;
        await adb("shell", "input", "keyevent", "KEYCODE_BACK");
      }
    }
  });

  try { await send("Emulation.setFocusEmulationEnabled", { enabled: true }); } catch (e) {}
  try { await send("Page.setWebLifecycleState", { state: "active" }); } catch (e) {}
  await send("Page.enable");
  await send("Page.startScreencast", { format: "jpeg", quality: 92, everyNthFrame: 1 });
  while (Date.now() - started < TOTAL) await sleep(60);
  await send("Page.stopScreencast").catch(() => {});
  ws.close();
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(frames, null, 0));
  console.log("frames", frames.length, "tapAt", TAP_AT, "->", dir);
  process.exit(0);
}

main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
