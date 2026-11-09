/* 真机 WebView 页面级截图（调试基建，非一次性探针）
 *   用法：node tools/cdp-shot.mjs --out=.probe10/x.png [--clip=0,500,393,200] [--scale=2]
 *   前置：adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
 *
 * 为什么不用 `adb exec-out screencap`：那是**物理屏幕**，用户正在用手机（相册/聊天）时
 * 截到的是他手里的画面，跟被测 WebView 完全无关 —— 这一坑在轮 425 踩过一次。
 * Page.captureScreenshot 拿的是这个 page 自己的渲染结果，与前台是谁无关。
 */
import fs from "node:fs";
import WebSocket from "ws";

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith("--" + name + "="));
  return hit ? hit.split("=").slice(1).join("=") : dflt;
};
const out = arg("out", ".probe10/shot.png");
const clipArg = arg("clip", "");
const scale = Number(arg("scale", "2"));
const port = arg("port", "9222");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const list = await fetch("http://127.0.0.1:" + port + "/json").then((r) => r.json());
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
  /* 后台时页面被判定 hidden：先伪装成可见，否则截出来是空白/冻结帧 */
  try { await send("Emulation.setFocusEmulationEnabled", { enabled: true }); } catch (e) {}
  try { await send("Page.setWebLifecycleState", { state: "active" }); } catch (e) {}
  await sleep(220);
  const params = { format: "png", fromSurface: true, captureBeyondViewport: false };
  if (clipArg) {
    const [x, y, width, height] = clipArg.split(",").map(Number);
    params.clip = { x, y, width, height, scale };
  }
  const r = await send("Page.captureScreenshot", params);
  if (!r || !r.data) throw new Error("no-image");
  fs.writeFileSync(out, Buffer.from(r.data, "base64"));
  ws.close();
  console.log(out);
  process.exit(0);
}

main().catch((e) => { console.error("SHOT_FAIL:", e.message); process.exit(1); });
