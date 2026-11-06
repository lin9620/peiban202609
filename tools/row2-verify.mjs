/* 轮 422 验收补充：点「第二条」会话 → 返回，确认高亮会搬家（不会两行同时亮）。
 * 用法：node tools/row2-verify.mjs
 */
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

class S {
  constructor(ws) { this.ws = ws; this.id = 0; this.w = new Map(); }
  static async open(u) { const ws = new WebSocket(u); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    const s = new S(ws); ws.onmessage = (m) => { const o = JSON.parse(m.data); const q = s.w.get(o.id);
      if (q) { s.w.delete(o.id); o.error ? q.j(new Error(JSON.stringify(o.error))) : q.r(o.result); } }; return s; }
  send(m, p = {}) { const id = ++this.id; return new Promise((r, j) => { this.w.set(id, { r, j });
    this.ws.send(JSON.stringify({ id, method: m, params: p })); setTimeout(() => { if (this.w.has(id)) { this.w.delete(id); j(new Error("timeout")); } }, 12000); }); }
  async ev(e) { const r = await this.send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 200)); return r.result.value; }
  async tap(x, y) { const b = { x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1, pointerType: "touch" };
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", ...b }); await sleep(50);
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...b }); }
  async shot(p) { const r = await this.send("Page.captureScreenshot", { format: "png", fromSurface: true }); writeFileSync(p, Buffer.from(r.data, "base64")); }
}

const ROWS = `(() => [...document.querySelectorAll('.dm-row')].slice(0,3).map(e => {
  const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
  return { cls: e.className, bg: cs.backgroundColor, y: Math.round(r.y), x: Math.round(r.x + r.width/2) }; }))()`;
const BACK = `(() => { const v = document.querySelector('vue-advanced-chat');
  const b = v && v.shadowRoot && v.shadowRoot.querySelector('.dm-vac-back'); if (!b) return null;
  const r = b.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`;

const out = [];
const log = (m) => { console.log(m); out.push(m); };

async function main() {
  const lt = await fetch("http://127.0.0.1:9222/json/list").then(r => r.json());
  const s = await S.open(lt.find(p => p.type === "page").webSocketDebuggerUrl);
  await s.send("Page.enable"); await s.send("Runtime.enable");

  let rows = await s.ev(ROWS);
  if (!rows || !rows.length) { log("!! 不在列表页"); process.exit(1); }
  log("起点 " + JSON.stringify(rows.map(r => r.cls)));
  await s.shot("D:\\05ruanjian\\peiban\\.probe5\\R0.png");

  const t2 = rows[1];
  await s.tap(t2.x, t2.y + 30);
  await sleep(1800);
  const bb = await s.ev(BACK);
  if (!bb) { log("!! 没有返回键"); process.exit(1); }
  await s.tap(bb.x, bb.y);
  await sleep(1800);
  rows = await s.ev(ROWS);
  log("点第二条后 " + JSON.stringify(rows.map(r => r.cls + ' | ' + r.bg)));
  await s.shot("D:\\05ruanjian\\peiban\\.probe5\\R1.png");
  const onCount = rows.filter(r => /(^| )on( |$)/.test(r.cls)).length;
  log(onCount === 1 && /on/.test(rows[1].cls) ? "✅ 只有第二条亮着" : `❌ 高亮异常 onCount=${onCount}`);
  writeFileSync("D:\\05ruanjian\\peiban\\.probe5\\row2.log", out.join("\n") + "\n");
  process.exit(0);
}
main().catch(e => { console.error("FAIL", e.message); process.exit(1); });
