/* 逐帧抓「点进会话」的头 1.2 秒（轮 422c）
 * 目的：定位用户说的「第一次有玻璃、后面没有」到底落在哪一帧。
 * 做法：点第一条会话后，每 ~70ms 抓一张 WebView 截图 + 同步取 shell 类名 / .dm-thread 关键样式，
 *      连抓 16 帧；返回列表后再来一遍。两串帧按序号对比，找出差异帧。
 */
import { writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const OUT = "D:\\05ruanjian\\peiban\\.probe3\\frames";
mkdirSync(OUT, { recursive: true });
const LOG = `${OUT}\\..\\frames.log`;
writeFileSync(LOG, "");
const log = (...a) => { const s = a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" "); console.log(s); appendFileSync(LOG, s + "\n"); };

class Sess {
  constructor(ws) { this.ws = ws; this.id = 0; this.waits = new Map(); }
  static async open(u) {
    const ws = new WebSocket(u);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const s = new Sess(ws);
    ws.onmessage = (m) => { const msg = JSON.parse(m.data); const w = s.waits.get(msg.id);
      if (w) { s.waits.delete(msg.id); msg.error ? w.rej(new Error(JSON.stringify(msg.error))) : w.res(msg.result); } };
    return s;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.waits.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.waits.has(id)) { this.waits.delete(id); rej(new Error("timeout " + method)); } }, 12000);
    });
  }
  async eval(e) {
    const r = await this.send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("EVAL " + JSON.stringify(r.exceptionDetails).slice(0, 200));
    return r.result.value;
  }
  async tap(x, y) {
    const b = { x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1, pointerType: "touch" };
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", ...b });
    await sleep(40);
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...b });
  }
  async shot(path) {
    const r = await this.send("Page.captureScreenshot", { format: "jpeg", quality: 72, fromSurface: true });
    writeFileSync(path, Buffer.from(r.data, "base64"));
  }
}

/* 只取判断所需的最小集，尽量轻 */
const PROBE = `(() => {
  const sh = document.querySelector('.shell');
  const t = document.querySelector('.dm-thread');
  const out = { chat: !!(sh && /shell--chat/.test(sh.className)) };
  if (t) {
    const cs = getComputedStyle(t), r = t.getBoundingClientRect();
    out.t = [cs.display[0], Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height),
             cs.backgroundColor, cs.borderTopLeftRadius, (cs.backdropFilter || 'none').slice(0, 7), cs.opacity].join('|');
  }
  return out;
})()`;

const firstRow = `(() => { const e = document.querySelector('.dm-row'); if (!e) return null;
  const r = e.getBoundingClientRect(); if (r.width < 10) return null;
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`;

async function frames(s, tag, n = 16, gap = 70) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const st = await s.eval(PROBE);
    await s.shot(`${OUT}\\${tag}-${String(i).padStart(2, "0")}.jpg`);
    rows.push({ i, ...st });
    const rest = gap - 0;
    if (rest > 0) await sleep(rest);
  }
  return rows;
}

async function main() {
  const lt = await fetch("http://127.0.0.1:9222/json/list").then(r => r.json());
  const page = lt.find(p => p.type === "page");
  const s = await Sess.open(page.webSocketDebuggerUrl);
  await s.send("Page.enable"); await s.send("Runtime.enable");

  for (let k = 0; k < 4; k++) {
    const st = await s.eval(PROBE);
    if (!st.chat) break;
    await s.eval("history.back()"); await sleep(1200);
  }
  const all = [];
  for (let round = 1; round <= 2; round++) {
    const rw = await s.eval(firstRow);
    if (!rw) { log("无会话行"); break; }
    await s.tap(rw.x, rw.y);
    const fr = await frames(s, `r${round}`);
    log(`\n===== 第 ${round} 次进入 · 逐帧 =====`);
    for (const f of fr) log(`${String(f.i).padStart(2, "0")} chat=${f.chat ? 1 : 0} ${f.t || "-"}`);
    all.push(fr);
    await s.eval("history.back()"); await sleep(1500);
  }
  writeFileSync(`${OUT}\\..\\frames.json`, JSON.stringify(all, null, 1));
  log("DONE");
  process.exit(0);
}
main().catch(e => { log("FAIL " + e.message); process.exit(1); });
