/* 会话列表「选中行」取证：列表 → 进会话 → 返回 → 再进 → 再返回，
 * 每一步都抓「会话列表页」的截图 + 每一行的 computedStyle（含 :hover / .on 命中）。
 * 轮 422b。用法：先 adb forward，再 node tools/list-cycle.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const OUT = "D:\\05ruanjian\\peiban\\.probe3";
mkdirSync(OUT, { recursive: true });

class Sess {
  constructor(ws) { this.ws = ws; this.id = 0; this.waits = new Map(); }
  static async open(u) {
    const ws = new WebSocket(u);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const s = new Sess(ws);
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data); const w = s.waits.get(msg.id);
      if (w) { s.waits.delete(msg.id); msg.error ? w.rej(new Error(JSON.stringify(msg.error))) : w.res(msg.result); }
    };
    return s;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.waits.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.waits.has(id)) { this.waits.delete(id); rej(new Error("timeout " + method)); } }, 20000);
    });
  }
  async eval(e) {
    const r = await this.send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("EVAL " + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result.value;
  }
  async tap(x, y) {
    const b = { x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1, pointerType: "touch" };
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", ...b });
    await sleep(60);
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...b });
    await sleep(600);
  }
  async shot(n) {
    const r = await this.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    writeFileSync(`${OUT}\\${n}.png`, Buffer.from(r.data, "base64"));
  }
}

const SNAP = `(() => {
  const rows = [...document.querySelectorAll('.dm-row')].slice(0, 4).map(e => {
    const cs = getComputedStyle(e), r = e.getBoundingClientRect();
    return {
      cls: e.className,
      hover: e.matches(':hover'),
      bg: cs.backgroundColor, shadow: cs.boxShadow.slice(0, 60),
      radius: cs.borderTopLeftRadius,
      rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      name: (e.querySelector('.dm-name') || {}).textContent || '',
    };
  });
  const shell = document.querySelector('.shell');
  return { shell: shell && shell.className, dpr: devicePixelRatio, rows,
           onCount: rows.filter(r => /(^| )on( |$)/.test(r.cls)).length };
})()`;

const firstRow = `(() => { const e = document.querySelector('.dm-row'); if(!e) return null;
  const r = e.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`;
const backBtn = `(() => { const e = document.querySelector('.dm-thread-back'); if(!e) return null;
  const r = e.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`;
const msgTab = `(() => { const it=[...document.querySelectorAll('.van-tabbar-item,.tabbar-item,.tab-item')];
  const e=it.find(i=>/消息/.test(i.textContent||'')); if(!e) return null;
  const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`;

const out = [];
const P = (t, v) => { out.push(`\n### ${t}`); out.push(JSON.stringify(v, null, 1)); console.log(`### ${t}\n`, JSON.stringify(v, null, 1)); };

async function main() {
  const list = await fetch("http://127.0.0.1:9222/json/list").then(r => r.json());
  const page = list.find(p => p.type === "page");
  const s = await Sess.open(page.webSocketDebuggerUrl);
  await s.send("Page.enable"); await s.send("Runtime.enable");

  const b = await s.eval(backBtn);
  if (b) { await s.tap(b.x, b.y); await sleep(700); }
  const tab = await s.eval(msgTab);
  if (tab) { await s.tap(tab.x, tab.y); await sleep(800); }

  // A. 刚进列表（无选中 / 有残留选中）
  P("A 进列表", await s.eval(SNAP));
  await s.shot("listA");

  for (const i of [1, 2]) {
    const rw = await s.eval(firstRow);
    if (!rw) { console.log("无会话行"); break; }
    await s.tap(rw.x, rw.y);
    await sleep(1400);
    await s.shot(`chat${i}`);
    P(`第${i}次进会话后`, await s.eval(SNAP));
    const bb = await s.eval(backBtn);
    if (bb) await s.tap(bb.x, bb.y);
    await sleep(1000);
    P(`第${i}次返回列表`, await s.eval(SNAP));
    await s.shot(`list${i}`);
  }
  writeFileSync(`${OUT}\\list-state.txt`, out.join("\n"));
  console.log("OK");
  process.exit(0);
}
main().catch(e => { console.error("FAIL", e.message); process.exit(1); });
