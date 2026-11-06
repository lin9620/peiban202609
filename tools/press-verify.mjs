/* 轮 422b 验收：玻璃必须在「按下去」那一帧亮着，且每一次点都一样。
 * 做法：CDP 真触摸 mousePressed → 按住 90ms 时抓图（此时手指还在屏上）→ mouseReleased。
 *       连做三轮，比 P1/P2/P3 三张「按下帧」；再点头部 ← 回列表，确认回去之后**没有**常驻高亮。
 */
import { writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const OUT = "D:\\05ruanjian\\peiban\\.probe6";
mkdirSync(OUT, { recursive: true });
const LOG = `${OUT}\\press.log`;
writeFileSync(LOG, "");
const log = (...a) => { const s = a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" "); console.log(s); appendFileSync(LOG, s + "\n"); };

class S {
  constructor(ws) { this.ws = ws; this.id = 0; this.w = new Map(); }
  static async open(u) { const ws = new WebSocket(u); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    const s = new S(ws); ws.onmessage = (m) => { const o = JSON.parse(m.data); const q = s.w.get(o.id);
      if (q) { s.w.delete(o.id); o.error ? q.j(new Error(JSON.stringify(o.error))) : q.r(o.result); } }; return s; }
  send(m, p = {}) { const id = ++this.id; return new Promise((r, j) => { this.w.set(id, { r, j });
    this.ws.send(JSON.stringify({ id, method: m, params: p }));
    setTimeout(() => { if (this.w.has(id)) { this.w.delete(id); j(new Error("timeout " + m)); } }, 12000); }); }
  async ev(e) { const r = await this.send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("EVAL " + JSON.stringify(r.exceptionDetails).slice(0, 220)); return r.result.value; }
  down(x, y) { return this.send("Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1, pointerType: "touch" }); }
  up(x, y) { return this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1, pointerType: "touch" }); }
  async tap(x, y) { await this.down(x, y); await sleep(50); await this.up(x, y); }
  async shot(n) { const r = await this.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    writeFileSync(`${OUT}\\${n}.png`, Buffer.from(r.data, "base64")); }
}

const STATE = `(() => {
  const sh = document.querySelector('.shell');
  const t = document.querySelector('.dm-thread');
  const inChat = !!(sh && /shell--chat/.test(sh.className));
  const rows = [...document.querySelectorAll('.dm-row')].slice(0, 3).map(e => {
    const cs = getComputedStyle(e), r = e.getBoundingClientRect();
    return { cls: e.className, bg: cs.backgroundColor, sh: cs.boxShadow.slice(0, 30), act: e.matches(':active'),
             rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] };
  });
  return { route: location.pathname, inChat, rows };
})()`;

const row1 = `(() => { const e = document.querySelector('.dm-row'); if (!e) return null;
  const r = e.getBoundingClientRect(); if (r.width < 10) return null;
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`;
const BACK = `(() => { const v = document.querySelector('vue-advanced-chat');
  const b = v && v.shadowRoot && v.shadowRoot.querySelector('.dm-vac-back'); if (!b) return null;
  const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`;
const TAB = `(() => { const it = [...document.querySelectorAll('.van-tabbar-item,.tabbar-item,.tab-item')];
  const e = it.find(i => /消息/.test(i.textContent || '')); if (!e) return null;
  const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`;

async function waitRows(s, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const st = await s.ev(STATE).catch(() => null);
    if (st && (st.inChat || (st.rows[0] && st.rows[0].rect[2] > 100))) return st;
    await sleep(350);
  }
  return null;
}

async function main() {
  const lt = await fetch("http://127.0.0.1:9222/json/list").then(r => r.json());
  const s = await S.open(lt.find(p => p.type === "page").webSocketDebuggerUrl);
  await s.send("Page.enable"); await s.send("Runtime.enable");

  let st = await s.ev(STATE);
  if (!/^\/messages/.test(st.route)) {
    const tab = await s.ev(TAB);
    if (tab) { await s.tap(tab.x, tab.y); await sleep(1500); }
    st = await waitRows(s);
  }
  if (st && st.inChat) {
    const bb = await s.ev(BACK);
    if (bb) { await s.tap(bb.x, bb.y); await sleep(1500); }
    st = await waitRows(s);
  }
  if (!st) { log("!! 没到列表"); process.exit(1); }
  log("## 列表起点 " + JSON.stringify(st.rows.map(r => r.cls)));
  await s.shot("L0");

  for (let i = 1; i <= 3; i++) {
    const rw = await s.ev(row1);
    if (!rw) { log("!! 无行"); break; }
    await s.down(rw.x, rw.y);
    await sleep(90);
    const p = await s.ev(STATE);           /* 手指还按着 */
    await s.shot(`P${i}`);
    await s.up(rw.x, rw.y);
    const r0 = p.rows[0];
    log(`\n## 第${i}次按下  active=${r0.act} bg=${r0.bg}`);
    log(`   shadow=${r0.sh}`);
    await sleep(1600);
    const bb = await s.ev(BACK);
    if (!bb) { log("!! 没进会话"); break; }
    await s.tap(bb.x, bb.y);
    await sleep(1700);
    const back = await s.ev(STATE);
    await s.shot(`L${i}`);
    log(`## 第${i}次返回  首行=${back.rows[0].cls} bg=${back.rows[0].bg}`);
  }
  log("\nDONE");
  process.exit(0);
}
main().catch(e => { log("FAIL " + e.message); process.exit(1); });
