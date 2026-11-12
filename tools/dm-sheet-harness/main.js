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

createApp(App).mount("#app");

/* 与真页面同一条启动顺序：先视口变量（挂 kb-web / 判内核型），再键盘让位 */
initViewportVars();
initKeyboardInset();

requestAnimationFrame(() => { window.__ready = true; });
