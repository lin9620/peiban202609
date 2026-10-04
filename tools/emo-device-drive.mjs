/* 真机驱动：用 CDP Input.dispatchMouseEvent 派发**可信**点击（非 el.click() 合成事件），
 * 在真实 App WebView 里复现用户描述的两串动作，逐帧取几何/文本/焦点。
 * 轮 184。 */
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const ADB = "C:\\Users\\lin\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe";
const PORT = 9222;

async function sh(args) {
  const p = spawn(ADB, args, { encoding: "utf8" });
  let o = ""; p.stdout.on("data", (d) => (o += d)); p.stderr.on("data", (d) => (o += d));
  await new Promise((r) => p.on("close", r)); return o.trim();
}

class Sess {
  constructor(ws) { this.ws = ws; this.id = 0; this.waits = new Map(); }
  static async open(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const s = new Sess(ws);
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      const w = s.waits.get(msg.id);
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
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("EVAL: " + JSON.stringify(r.exceptionDetails).slice(0, 500));
    return r.result.value;
  }
  /* 轮187 定点点击：用**真实元素自己的 rect** 打合成 click（target 是真节点）。
   * 被打破的就是 document 上那个 click 监听器，合成 click 走的是同一条路径，
   * 但完全不依赖坐标 —— 排掉「CDP 输入坐标 vs CSS 坐标缩放」这个噪声源。 */
  async clickEl(expr) {
    return this.eval(`(() => {
      const e = ${expr};
      if (!e) return { ok: false, why: 'not found' };
      e.scrollIntoView({ block: 'center' });
      const r = e.getBoundingClientRect();
      const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      e.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy }));
      return { ok: true, cx: Math.round(cx), cy: Math.round(cy),
               hit: hit ? hit.tagName + '.' + ((hit.className && hit.className.baseVal !== undefined) ? hit.className.baseVal : (hit.className || '')) : null };
    })()`);
  }
  /* 真·触摸点击：走 Input 域，浏览器当成真实用户手势（el.click() 是合成事件，测不出真问题） */
  async tap(x, y) {
    const base = { x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1, pointerType: "touch" };
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
    await sleep(50);
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
    await sleep(300);
  }
  async key(text) {
    for (const ch of text) {
      await this.send("Input.dispatchKeyEvent", { type: "keyDown", text: ch });
      await this.send("Input.dispatchKeyEvent", { type: "keyUp", text: ch });
      await sleep(40);
    }
  }
}

/* 在页面里找一个输入位：返回其输入框、表情按钮、面板的坐标与状态 */
export const PROBE = `(() => {
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const box = (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  const rows = [...document.querySelectorAll('.emo-root')].filter(vis);
  const row = rows.find(r => { const i = r.parentElement.querySelector('textarea, input'); return i && vis(i); });
  if (!row) return { found: false, roots: rows.length };
  const inp = row.parentElement.querySelector('textarea, input');
  const btn = row.querySelector('.emo-btn');
  const panel = document.querySelector('.emo-panel');
  const cs = getComputedStyle(inp);
  const c0 = panel && panel.querySelector('.emo-cell');
  return {
    found: true,
    inputVisible: vis(inp), inputBox: box(inp),
    inputOpacity: cs.opacity, inputDisplay: cs.display, inputVis: cs.visibility,
    btnBox: box(btn),
    panelOpen: !!panel,
    panelBox: panel ? box(panel) : null,
    panelCells: panel ? panel.querySelectorAll('.emo-cell').length : 0,
    cell0: c0 ? box(c0) : null,
    value: inp.value || '', caret: inp.selectionStart,
    focused: document.activeElement === inp,
    activeInfo: (() => { const a = document.activeElement; return a ? a.tagName + '.' + (typeof a.className === 'string' ? (a.className || '-') : 'svg') : 'null'; })(),
    innerH: window.innerHeight,
  };
})()`;

const LOG = process.env.EMO_LOG || "";
function emit(s) { console.log(s); if (LOG) { try { appendFileSync(LOG, s + "\n"); } catch (e) { /* ignore */ } } }

export let pass = 0; const fails = [];
export function ok(name, cond, info = "") {
  const line = cond ? "  ok  " + name : "FAIL  " + name + "  " + info;
  if (cond) pass++; else fails.push(name + "  " + info);
  emit(line);
}
export function say(s) { emit(s); }
export function report(tag) {
  emit(`\n${tag}: ${pass} pass, ${fails.length} fail`);
  fails.forEach((f) => emit("FAIL  " + f));
  return fails.length ? 1 : 0;
}

/** 完整跑一串「开面板→选表情→再点按钮收起」，返回逐帧快照 */
export async function cycle(s, tag, pickCell = 0) {
  const f = [];
  const a0 = await s.eval(PROBE);
  if (!a0.found) { say(`  (${tag} 无可用输入位，跳过)`); return null; }
  const h0 = a0.inputBox.height;
  /* 0.5 点击前先问：该点命中谁？（真机 tap 打在覆盖层上时，只有这能看见真相） */
  try {
    say(`  ${tag}PRE BTNBOX=${JSON.stringify(a0.btnBox)}` + await s.eval(`(() => {
      const r = document.querySelector('.emo-btn'); if (!r) return ' no-btn';
      const b = r.getBoundingClientRect();
      const x = b.x + b.width/2, y = b.y + b.height/2;
      const el = document.elementFromPoint(x, y);
      const chain = []; let e = el;
      while (e && chain.length < 6) { chain.push(e.tagName + '.' + (typeof e.className === 'string' ? (e.className||'-') : 'svg')); e = e.parentElement; }
      const cs = el ? getComputedStyle(el) : null;
      return JSON.stringify({ at: [Math.round(x), Math.round(y)],
        hitIsBtn: !!(el && (el === r || r.contains(el))), chain,
        hitPos: cs ? cs.position : null, hitZ: cs ? cs.zIndex : null,
        hitPE: cs ? cs.pointerEvents : null, hitOpacity: cs ? cs.opacity : null,
        hitBg: cs ? cs.backgroundColor : null, hitRect: el ? (() => { const q = el.getBoundingClientRect(); return [Math.round(q.x),Math.round(q.y),Math.round(q.width),Math.round(q.height)]; })() : null });
    })()`));
  } catch (e) { say(`  ${tag}PRE 探测失败`); }
  /* 1. 点表情按钮 → 面板开 */
  await s.tap(a0.btnBox.x + a0.btnBox.width / 2, a0.btnBox.y + a0.btnBox.height / 2);
  const a1 = await s.eval(PROBE); f.push(a1);
  /* 这一击的完整事件轨迹 + tap 坐标究竟命中了什么（真相就在这，别再靠猜） */
  try {
    say(`  ${tag}1 BTNBOX=${JSON.stringify(a0.btnBox)} vh=${await s.eval("window.innerHeight")} vv=${await s.eval("JSON.stringify({vh:visualViewport.height,off:visualViewport.offsetTop,scale:visualViewport.scale})")}`);
    say(`  ${tag}1 HIT=` + await s.eval(`(() => {
      const r = document.querySelector('.emo-btn'); if (!r) return 'no-btn';
      const b = r.getBoundingClientRect();
      const x = b.x + b.width/2, y = b.y + b.height/2;
      const el = document.elementFromPoint(x, y);
      return JSON.stringify({ want: [Math.round(x), Math.round(y)],
        hit: el ? el.tagName + '.' + (el.className || '') : null,
        hitIsBtn: !!(el && (el === r || r.contains(el))),
        topAtPoint: (() => { const t = document.elementFromPoint(x, y); let n = [], e = t;
          while (e && n.length < 5) { n.push(e.tagName + '.' + (typeof e.className === 'string' ? e.className : '')); e = e.parentElement; } return n; })() });
    })()`));
  } catch (e) { say(`  ${tag}1 HIT 探测失败`); }
  if (!a1.found) { say(`  ${tag}1 输入位在点表情按钮后消失（roots=${a1.roots}）`); return f; }
  ok(`${tag}1 点表情按钮 → 面板打开`, a1.panelOpen, JSON.stringify(a1).slice(0, 150));
  ok(`${tag}1 面板开时输入框仍可见（不能被面板顶没）`, a1.inputVisible);
  ok(`${tag}1 输入框高度未变（没被压扁/隐藏）`, Math.abs(a1.inputBox.height - h0) < 2, `${h0} -> ${a1.inputBox.height}`);
  if (!a1.cell0) return f;
  /* 2. 点一个表情 */
  const cells = await s.eval(`(() => { const p = document.querySelector('.emo-panel'); if (!p) return null;
    const c = [...p.querySelectorAll('.emo-cell')].slice(0,6).map(e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }); return c; })()`);
  const c = cells[pickCell] || cells[0];
  await s.tap(c.x + c.width / 2, c.y + c.height / 2);
  const a2 = await s.eval(PROBE); f.push(a2);
  ok(`${tag}2 点表情 → 文字插进去`, a2.value.length > a1.value.length, `"${a1.value}" -> "${a2.value}"`);
  ok(`${tag}2 点表情后输入框仍可见`, a2.inputVisible, JSON.stringify(a2).slice(0, 150));
  /* 3. 再点表情按钮 → 收起 */
  await s.tap(a2.btnBox.x + a2.btnBox.width / 2, a2.btnBox.y + a2.btnBox.height / 2);
  const a3 = await s.eval(PROBE); f.push(a3);
  ok(`${tag}3 再点表情按钮 → 面板收起`, !a3.panelOpen);
  ok(`${tag}3 收起后输入框仍可见`, a3.inputVisible, JSON.stringify(a3).slice(0, 200));
  ok(`${tag}3 收起后输入框高度回到初始值`, Math.abs(a3.inputBox.height - h0) < 2, `${h0} -> ${a3.inputBox.height}`);
  ok(`${tag}3 收起不吞内容`, a3.value === a2.value, `"${a2.value}" -> "${a3.value}"`);
  ok(`${tag}3 光标在文字末尾（不是跳到首个 —— 用户报的 bug）`, a3.caret === a3.value.length, `caret=${a3.caret} len=${a3.value.length}`);
  ok(`${tag}3 焦点已还给输入框（不用再点一次输入框）`, a3.focused, "activeElement=" + a3.activeInfo);
  /* 4. 收起后能直接继续打字 */
  if (a3.focused) { await s.key("X"); await sleep(250); }
  const a4 = await s.eval(PROBE); f.push(a4);
  ok(`${tag}4 收起后可直接接着打字（无需再点输入框）`, a4.value.length === a3.value.length + 1, `"${a3.value}" -> "${a4.value}"`);
  ok(`${tag}4 新字插在末尾（光标没跳回首）`, a4.value.endsWith("X"), `"${a4.value}"`);
  return f;
}

/* ── 探针：真机当前页有哪些可点的入口 / 有哪些输入位（诊断用，不参与断言） ── */
if (process.argv.includes("--probe")) {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const t = list.find((x) => x.type === "page");
  const s = await Sess.open(t.webSocketDebuggerUrl);
  await s.send("Runtime.enable");
  const info = await s.eval(`(() => ({
    path: location.pathname,
    inputs: [...document.querySelectorAll('textarea, input')].map(e => {
      const r = e.getBoundingClientRect();
      return { ph: (e.placeholder||'').slice(0,14), tag: e.tagName, w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.y) };
    }),
    emoRoots: [...document.querySelectorAll('.emo-root')].map(e => { const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.y) }; }),
    btns: [...document.querySelectorAll('button')].map(e => { const r = e.getBoundingClientRect();
      return { t: ((e.getAttribute('aria-label')||'')+'|'+(e.textContent||'')).trim().slice(0,16), x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2), w: Math.round(r.width), h: Math.round(r.height) }; })
      .filter(b => b.w > 0 && b.h > 0 && b.y > 300).slice(0, 40),
  }))()`);
  if (LOG) appendFileSync(LOG, JSON.stringify(info, null, 1) + "\n");
  process.exit(0);
}

/* ── 主流程：连真机 → 场景 A 暖心墙评论 / 场景 B 消息会话 ── */
/* Windows 注意：import.meta.url 是 file:///D:/...，必须用 pathToFileURL 比对，
 * 字符串拼 file:// 少一个斜杠 → 守卫不成立 → 脚本空跑 exit 0（假绿）。 */
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const t = list.find((x) => x.type === "page");
  if (!t) { console.log("NO_PAGE（先 adb forward 到 localabstract:webview_devtools_remote_<pid>）"); process.exit(1); }
  const s = await Sess.open(t.webSocketDebuggerUrl);
  await s.send("Runtime.enable");
  /* 保证屏幕亮着、App 在前台 —— 轮 62 教训：息屏会让 Chromium 冻结，页面读数全 0 */
  await sh(["shell", "input", "keyevent", "KEYCODE_WAKEUP"]).catch(() => {});

  const SCENES = (process.env.EMO_SCENES || "A,B").split(",");
  const W = await s.eval("window.innerWidth");

  /* ── B 消息会话：/messages → 点第一条会话 → 拿到输入行 ── */
  async function openConversation() {
    await s.eval(`location.assign('/messages')`).catch(() => {});
    await sleep(4000);
    /* 会话列表第一条：排除 ⋯ 菜单与搜索框那一行，取靠上的可点行 */
    const c = await s.eval(`(() => {
      const rows = [...document.querySelectorAll('li, .dm-row, .conv-row, [class*="conv"]')]
        .filter(e => { const r = e.getBoundingClientRect(); return r.height > 40 && r.y > 120; })
        .filter(e => !e.querySelector('input, textarea'));
      if (!rows.length) return null;
      const r = rows[0].getBoundingClientRect();
      return { x: r.x + Math.min(r.width/2, 140), y: r.y + Math.min(r.height/2, 30), n: rows.length };
    })()`);
    if (!c) return false;
    await s.tap(c.x, c.y); await sleep(2500);
    return true;
  }

  /* ── A 暖心墙卡内评论输入框（真机，用户报的正是这一处）：
   *    App 端卡内是占位条 .cmt-entry（CommunityView:1709），点它弹底部输入条 .cmt-main-bar。
   *    别走帖子详情页 —— 社区列表是 div+@click，压根没有 /post/ 链接（上一轮空跑的原因）。 */
  async function openCommentBar() {
    await s.eval(`location.assign('/community')`).catch(() => {});
    await sleep(4500);
    /* 先让社区页有内容：有云端数据时列表可能有虚拟窗口，没卡就下拉刷新一次 */
    let entry = await s.eval(`(() => {
      const e = document.querySelector('.cmt-entry');
      if (!e) return null; const r = e.getBoundingClientRect();
      return { x: r.x + r.width/2, y: r.y + r.height/2, vis: r.width > 0 && r.height > 0 };
    })()`);
    if (!entry) {
      /* 没卡：可能空库/未登录，回退到 /messages 之外的空态也无法测 —— 如实报告 */
      say("  .cmt-entry 不存在，尝试下拉刷新一次");
      await sh(["shell", "input", "swipe", "200", "500", "200", "1400", "300"]);
      await sleep(3000);
      entry = await s.eval(`(() => {
        const e = document.querySelector('.cmt-entry');
        if (!e) return null; const r = e.getBoundingClientRect();
        return { x: r.x + r.width/2, y: r.y + r.height/2, vis: r.width > 0 && r.height > 0 };
      })()`);
    }
    say("  cmtEntry=" + JSON.stringify(entry));
    if (entry) { await s.tap(entry.x, entry.y); await sleep(1200); }
    const diag = await s.eval(`(() => ({
      path: location.pathname,
      emoRoots: document.querySelectorAll('.emo-root').length,
      textareas: [...document.querySelectorAll('textarea')].map(e => { const r = e.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.y), vis: r.width > 0 && r.height > 0 }; }),
      mainBar: !!document.querySelector('.cmt-main-bar'),
      mainBarDisp: (() => { const e = document.querySelector('.cmt-main-bar'); if (!e) return null;
        const cs = getComputedStyle(e); const r = e.getBoundingClientRect();
        return { display: cs.display, vis: cs.visibility, op: cs.opacity, h: Math.round(r.height), y: Math.round(r.y) }; })(),
    }))()`);
    say("  diag=" + JSON.stringify(diag));
    /* 埋点：抓这一击到底谁把条关了 —— 之前「点表情按钮→条消失」只靠猜，必须实测 */
    await s.eval(`(() => {
      window.__emoLog = [];
      const bar = document.querySelector('.cmt-main-bar') || document.querySelector('.emo-in');
      window.__barEl = bar;
      document.addEventListener('click', (e) => {
        const t = e.target;
        window.__emoLog.push({
          phase: 'doc-click(capture=false)',
          tgt: t && (t.tagName + '.' + (t.className.baseVal !== undefined ? t.className.baseVal : t.className || '')).slice(0, 40),
          insideBar: !!(bar && t && bar.contains(t)),
          hasPanel: !!document.querySelector('.emo-panel'),
          barStillInDom: !!(window.__barEl && document.body.contains(window.__barEl)),
        });
      }, false);
      return true;
    })()`);
    return true;
  }

  if (SCENES.includes("A")) {
    say("== A 帖子详情评论输入框（真机）==");
    await openCommentBar();
    say("  page: " + (await s.eval("location.pathname")) + " W=" + W);
    await cycle(s, "A");
    try {
      const lg = await s.eval("JSON.stringify(window.__emoLog || [])");
      say("  EVENTLOG=" + lg);
    } catch (e) { say("  EVENTLOG 读取失败"); }
  }
  if (SCENES.includes("B")) {
    say("== B 消息会话输入框（真机）==");
    const got = await openConversation();
    say("  page: " + (await s.eval("location.pathname")) + " conv=" + got);
    await cycle(s, "B");
  }

  process.exit(report("EMO_DEVICE"));
}
