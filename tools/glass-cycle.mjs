/* 玻璃「第一次有、后面没有」取证 v2（轮 422）
 * v1 的致命错误：返回按钮 .dm-thread-back 注入在 vue-advanced-chat 的 shadow DOM 里，
 *   document.querySelector 查不到 → if(bb) 全部跳过 → 从未真正返回列表，三次截图是同一张。
 *   本版用 history.back() 退路由（router 是 history 模式），并用 shell 类名断言真的回到了列表。
 *
 * 每轮：列表 → 点第一条会话 → 等 1.5s 抓会话页 → history.back() → 等 1.2s 抓列表页
 * 产物：.probe3/c1.png c2.png c3.png（会话页）、l1.png l2.png l3.png（列表页）、cycle.json
 */
import { writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const OUT = "D:\\05ruanjian\\peiban\\.probe3";
mkdirSync(OUT, { recursive: true });
const LOG = `${OUT}\\cycle.log`;
writeFileSync(LOG, "");
const log = (...a) => { const s = a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" "); console.log(s); appendFileSync(LOG, s + "\n"); };

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
      setTimeout(() => { if (this.waits.has(id)) { this.waits.delete(id); rej(new Error("timeout " + method)); } }, 15000);
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
  }
  async shot(n) {
    const r = await this.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    writeFileSync(`${OUT}\\${n}.png`, Buffer.from(r.data, "base64"));
  }
}

const SNAP = `(() => {
  const shell = document.querySelector('.shell');
  const t = document.querySelector('.dm-thread');
  const list = document.querySelector('.dm-list');
  const g = (e) => { if (!e) return null; const cs = getComputedStyle(e), r = e.getBoundingClientRect();
    return { disp: cs.display, rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      bg: cs.backgroundColor, rad: cs.borderTopLeftRadius, sh: cs.boxShadow.slice(0, 90),
      bd: cs.borderTopWidth + ' ' + cs.borderTopColor, bdf: cs.backdropFilter || cs.webkitBackdropFilter, op: cs.opacity }; };
  const rows = [...document.querySelectorAll('.dm-row')].slice(0, 2).map(e => { const cs = getComputedStyle(e), r = e.getBoundingClientRect();
    return { cls: e.className, bg: cs.backgroundColor, sh: cs.boxShadow.slice(0, 60), rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] }; });
  return { url: location.href, shell: shell && shell.className, inChat: !!(shell && /shell--chat/.test(shell.className)),
           thread: g(t), list: g(list), rows, dpr: devicePixelRatio, vw: innerWidth, vh: innerHeight };
})()`;

const firstRow = `(() => { const e = document.querySelector('.dm-row'); if (!e) return null;
  const r = e.getBoundingClientRect(); if (r.width < 10) return null;
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`;

async function main() {
  const listT = await fetch("http://127.0.0.1:9222/json/list").then(r => r.json());
  const page = listT.find(p => p.type === "page");
  const s = await Sess.open(page.webSocketDebuggerUrl);
  await s.send("Page.enable"); await s.send("Runtime.enable");

  /* 0. 回到列表：最多退 4 步 */
  for (let k = 0; k < 4; k++) {
    const st = await s.eval(SNAP);
    if (!st.inChat) break;
    await s.eval("history.back()"); await sleep(1300);
  }
  const s0 = await s.eval(SNAP);
  log("## 起点", s0);
  if (s0.inChat) { log("!! 退不出会话，放弃"); return; }
  await s.shot("l0");

  const res = [];
  for (let i = 1; i <= 3; i++) {
    const rw = await s.eval(firstRow);
    if (!rw) { log(`!! 第${i}轮列表没有会话行`); break; }
    await s.tap(rw.x, rw.y);
    await sleep(1600);
    const c = await s.eval(SNAP);
    await s.shot(`c${i}`);
    log(`\n## 第${i}次进会话 inChat=${c.inChat}`, { thread: c.thread, rows: c.rows[0] });

    await s.eval("history.back()");
    await sleep(1400);
    const l = await s.eval(SNAP);
    await s.shot(`l${i}`);
    log(`## 第${i}次返列表 inChat=${l.inChat}`, { list: l.list, rows: l.rows });
    res.push({ i, chat: c, list: l });
  }
  writeFileSync(`${OUT}\\cycle.json`, JSON.stringify(res, null, 1));
  log("\nDONE");
  process.exit(0);
}
main().catch(e => { log("FAIL " + e.message); process.exit(1); });
