/* 轮 516 · 私信会话页「组装级」几何回归台（真挂 DmVacChat，含 THEME_CSS 注入）
 * ------------------------------------------------------------
 * 为什么必须组装级：vac-sheet-drive 只挂库本体，量的是「库自己的面板几何」。
 * 真机上输入行能不能不被面板盖住、切键盘时会不会跳，取决于**宿主注入的
 * :host(.wp-emoji-open) .vac-box-footer { padding-bottom }** —— 那套样式在
 * 影子树里，库本体 harness 根本没加载，所以过去的工装对这些问题一律假绿。
 *
 * 跑法：node tools/dm-sheet-drive.mjs [--keep]
 */
import { createApp, h } from "vue";
import "../../src/style.css";
import DmVacChat from "../../src/components/DmVacChat.vue";
import { initKeyboardInset } from "../../src/utils/keyboardInset.js";
import { initViewportVars } from "../../src/utils/viewportVars.js";
/* 轮 534 · 必须挂：真机上 .dm-page 是 position:fixed + 内联像素高（chatViewport 写的）。
 * 这个 harness 之前没挂，盒子高度由 CSS 的 100dvh 决定 = 852，而真机上面板态被钉成
 * 522 —— 于是工装量出输入条 505（绿），真机是 256（顶到屏幕上半部）。
 * 少了这一行，这个工装量的是一个真机上不存在的布局。 */
import { initChatViewport } from "../../src/utils/chatViewport.js";

/* ── 假 visualViewport（与 wallbar-harness 同一手法）─────────────────
 * iOS overlay 型：键盘弹起时 innerHeight 不变，只有 visualViewport 变矮/上推。 */
const vvState = { height: window.innerHeight, width: window.innerWidth, offsetTop: 0, offsetLeft: 0, scale: 1 };
const vvOn = { resize: new Set(), scroll: new Set() };
const fakeVV = {
  get height() { return vvState.height; },
  get width() { return vvState.width; },
  get offsetTop() { return vvState.offsetTop; },
  get offsetLeft() { return vvState.offsetLeft; },
  get scale() { return vvState.scale; },
  addEventListener(t, fn) { (vvOn[t] || (vvOn[t] = new Set())).add(fn); },
  removeEventListener(t, fn) { if (vvOn[t]) vvOn[t].delete(fn); },
  dispatchEvent() { return true; },
};
try {
  Object.defineProperty(window, "visualViewport", { configurable: true, get: () => fakeVV });
} catch (e) { /* 老内核忽略 */ }

window.__kbSim = (hgt, top, scale) => {
  vvState.height = hgt > 0 ? hgt : window.innerHeight;
  vvState.offsetTop = top > 0 ? top : 0;
  vvState.scale = scale > 0 ? scale : 1;
  (vvOn.resize || []).forEach((f) => f({}));
  (vvOn.scroll || []).forEach((f) => f({}));
  window.dispatchEvent(new Event("resize"));
};

/* ── 轮 537 · 第二种语义：内核真的缩布局视口 ──────────────────────
 * 真机（用户 2026-11-15 06:01 三张 kbdiag 照片）上 innerHeight 会从 549 掉到 422，
 * 因为线上 viewport 写了 interactive-widget=resizes-content，这版 Safari 照做了。
 * 那时 inner − vv 只剩 4px —— 只按 overlay 模拟的工装永远复现不出
 * 「面板不收 / 键盘键点不动」这两个症状。这里把 innerHeight 也做成可模拟的。 */
let simInner = 0;
const REAL_INNER = window.innerHeight;   /* 开机那一次的真值（探针窗口高） */
try {
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    get: () => (simInner > 0 ? simInner : REAL_INNER),
  });
} catch (e) { /* 老内核忽略 */ }
window.__kbSimResize = (inner, vvH, top) => {
  simInner = inner > 0 ? inner : 0;
  const base = simInner || REAL_INNER;
  vvState.height = vvH > 0 ? vvH : base;
  vvState.offsetTop = top > 0 ? top : 0;
  vvState.scale = 1;
  (vvOn.resize || []).forEach((f) => f({}));
  (vvOn.scroll || []).forEach((f) => f({}));
  window.dispatchEvent(new Event("resize"));
};

document.documentElement.style.setProperty("--sab", "34px");
document.documentElement.style.setProperty("--sat", "47px");

const ME = "u1";
const convs = [{
  conv_id: "r1", peer_id: "u2", peer_name: "测试会话", peer_avatar: "",
  last_text: "在吗", last_at: new Date().toISOString(), unread: 0,
}];
const msgs = [{
  msg_id: "m1", conv_id: "r1", sender_id: "u2", body: "在吗",
  created_at: new Date().toISOString(), kind: "text",
}];

const App = {
  render: () => h("div", { class: "shell shell--mobile-nav shell--chat" }, [
    h("div", { class: "dm-page dm-page--chat" }, [
      h("div", { class: "dm-wrap" }, [
        h("div", { class: "card dm-thread" }, [
          h(DmVacChat, {
            convs,
            messages: msgs,
            roomId: "r1",
            meId: ME,
            peerName: "测试会话",
            canType: true,
          }),
        ]),
      ]),
    ]),
  ]),
};

/* 轮 537 · 先把「这台设备量到过键盘高」写进 localStorage。
 *
 * 真机上 --kb-panel-h 是**锁过一次就一直记着**的（iosKb.savePanelLocked，跨会话保留）。
 * 工装每次都是全新 profile，如果不预置，resize 语义下（inner−vv 恒 4px）永远锁不上，
 * 面板就退回 CSS 的 320 兜底 —— 那是另一套几何，量出来的东西和真机不是一回事。
 * 用户那台机器上 --kb-panel-h = 259px（他 06:01 的截图里就写着），这里统一按 330 预置。 */
try {
  localStorage.setItem("wp-kb-panel-ios", JSON.stringify({ h: 330, w: 393, at: Date.now() }));
} catch (e) { /* 隐私模式忽略 */ }

createApp(App).mount("#app");

/* 与真页面同一条启动顺序：先视口变量（挂 kb-web / 判内核型），再键盘让位 */
initViewportVars();
initKeyboardInset();
initChatViewport();

requestAnimationFrame(() => { window.__ready = true; });
