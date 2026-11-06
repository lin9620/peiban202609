/* 轮 422 验收：真手指「点进会话 → 点头部 ← 返回」重复三轮，
 * 每轮回到列表都检查第一行是否还带着选中玻璃（class 有 on + 半透明粉底），并截图取像素。
 * 返回键走的是 App 里那颗 .dm-vac-back（在 vue-advanced-chat 的 shadow DOM 里），
 * 不是硬件 BACK —— 用户就是这么点的。
 */
import { writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const OUT = "D:\\05ruanjian\\peiban\\.probe5";
mkdirSync(OUT, { recursive: true });
const LOG = `${OUT}\\verify.log`;
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
  send(m, p = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.waits.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method: m, params: p }));
      setTimeout(() => { if (this.waits.has(id)) { this.waits.delete(id); rej(new Error("timeout " + m)); } }, 12000);
    });
  }
  async eval(e) {
    const r = await this.send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("EVAL " + JSON.stringify(r.exceptionDetails).slice(0, 240));
    return r.result.value;
  }
  async tap(x, y) {
    const b = { x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1, pointerType: "touch" };
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", ...b });
    await sleep(50);
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...b });
  }
  async shot(n) {
    const r = await this.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    writeFileSync(`${OUT}\\${n}.png`, Buffer.from(r.data, "base64"));
  }
}

const STATE = `(() => {
  const sh = document.querySelector('.shell');
  const inChat = !!(sh && /shell--chat/.test(sh.className));
  const rows = [...document.querySelectorAll('.dm-row')].slice(0, 3).map(e => {
    const cs = getComputedStyle(e), r = e.getBoundingClientRect();
    return { cls: e.className, bg: cs.backgroundColor, hover: e.matches(':hover'),
             sh: cs.boxShadow.slice(0, 40), rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] };
  });
  return { route: location.pathname, inChat, rows };
})()`;

const row1 = `(() => { const e = document.querySelector('.dm-row'); if (!e) return null;
  const r = e.getBoundingClientRect(); if (r.width < 10) return null;
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`;

const backHit = `(() => {
  const v = document.querySelector('vue-advanced-chat');
  const b = v && v.shadowRoot && v.shadowRoot.querySelector('.dm-vac-back');
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: Math.round(r.width), h: Math.round(r.height) };
})()`;

const msgTab = `(() => {
  const it = [...document.querySelectorAll('.van-tabbar-item,.tabbar-item,.tab-item')];
  const e = it.find(i => /消息/.test(i.textContent || ''));
  if (!e) return null;
  const r = e.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, n: it.length };
})()`;

async function ready(s, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const st = await s.eval(STATE).catch(() => null);
    if (st) return st;
    await sleep(400);
  }
  return null;
}

/* 等列表行真的排好版（首页/会话页都不算） */
async function waitRows(s, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const st = await s.eval(STATE).catch(() => null);
    if (st && st.inChat) return st;
    if (st && st.rows[0] && st.rows[0].rect[2] > 100) return st;
    await sleep(400);
  }
  return null;
}

async function main() {
  const lt = await fetch("http://127.0.0.1:9222/json/list").then(r => r.json());
  const page = lt.find(p => p.type === "page");
  const s = await Sess.open(page.webSocketDebuggerUrl);
  await s.send("Page.enable"); await s.send("Runtime.enable");

  let st = await ready(s);
  log("## 就绪", st && { route: st.route, inChat: st.inChat, rows: st.rows.length });
  if (!st) { log("!! 页面没就绪"); process.exit(1); }

  /* 冷启动落在首页 → 先点底部「消息」 */
  if (!/^\/messages/.test(st.route)) {
    const tab = await s.eval(msgTab);
    log("## 去消息页 tab=", tab);
    if (!tab) { log("!! 找不到消息页签"); process.exit(1); }
    await s.tap(tab.x, tab.y);
    await sleep(1600);
    st = await waitRows(s);
    log("## 到消息页", st && { route: st.route, rows: st.rows.length });
    if (!st) { log("!! 消息页没就绪"); process.exit(1); }
  }

  /* 若停在会话里，先点头部 ← 出来 */
  if (st.inChat) {
    const bb = await s.eval(backHit);
    if (bb) { await s.tap(bb.x, bb.y); await sleep(1400); }
  }
  st = await waitRows(s);
  log("## 列表起点", st && { inChat: st.inChat, row0: st.rows[0] });
  await s.shot("V0");

  for (let i = 1; i <= 3; i++) {
    const rw = await s.eval(row1);
    if (!rw) { log(`!! 第${i}轮没有会话行`); break; }
    await s.tap(rw.x, rw.y);
    await sleep(1700);
    const c = await s.eval(STATE);
    const bb = await s.eval(backHit);
    log(`\n## 第${i}轮 进会话 inChat=${c.inChat} 返回键=${bb ? "有 " + bb.w + "×" + bb.h : "没有"}`);
    if (!bb) { log("!! 找不到头部返回键，停"); break; }
    await s.tap(bb.x, bb.y);
    await sleep(1800);
    const b = await s.eval(STATE);
    await s.shot(`V${i}`);
    log(`## 第${i}轮 回列表 inChat=${b.inChat} 首行=${b.rows[0] && b.rows[0].cls} bg=${b.rows[0] && b.rows[0].bg} hover=${b.rows[0] && b.rows[0].hover}`);
    log(`   第二行=${b.rows[1] && b.rows[1].cls} bg=${b.rows[1] && b.rows[1].bg}`);
  }
  log("\nDONE");
  process.exit(0);
}
main().catch(e => { log("FAIL " + e.message); process.exit(1); });
