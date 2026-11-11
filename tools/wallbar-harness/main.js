/* 轮 504 · 暖心墙评论条 / 表情面板的真几何回归台
 * ------------------------------------------------------------
 * 用户：「暖心墙也有问题啊」（iPhone Safari 两张：输入条跑到页面顶部、表情面板最后一排被切）。
 *
 * 上一轮（503）在聊天页修的是同一类病：**两个参照系**。
 *   · 条的 bottom 来自 --kb-h（间接推导，任一道闸门失效就停在 0 或一个残留大值）
 *   · 表情面板 position:fixed 锚**布局视口**底，而 iOS 底部工具栏浮在页面之上
 * 这个工装不改任何业务代码，只把暖心墙那一套（.wall-scroller + .cmt-main-bar + WpComposer）
 * 原样挂起来，用假的 visualViewport 喂「键盘弹起 / 可视视口上推」两种状态，
 * 量条和面板的真实 rect —— 拍照猜像素不算证据。
 *
 * 跑法：node tools/wallbar-drive.mjs [--keep]
 */
import { createApp, h, ref, nextTick } from "vue";
import "../../src/style.css";
import WpComposer from "../../src/components/WpComposer.vue";
import { initKeyboardInset } from "../../src/utils/keyboardInset.js";
import { initFixedBar } from "../../src/utils/fixedBar.js";

/* ── 假 visualViewport ─────────────────────────────────────────────
 * Chromium 的 visualViewport 是只读对象，但它挂在 window 上可重定义。
 * keyboardInset / fixedBar 都是每次现读 window.visualViewport，所以换掉这个 getter 就够。 */
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
} catch (e) { /* 老内核忽略：那这轮量出来就代表「读不到可视视口」的表现 */ }

/* 键盘 = 可视视口变矮；上推 = offsetTop 变大。两者都要派事件，真实内核就是这么通知的。 */
window.__kbSim = (h, top, scale) => {
  vvState.height = h > 0 ? h : window.innerHeight;
  vvState.offsetTop = top > 0 ? top : 0;
  vvState.scale = scale > 0 ? scale : 1;
  (vvOn.resize || []).forEach((f) => f({}));
  (vvOn.scroll || []).forEach((f) => f({}));
  window.dispatchEvent(new Event("resize"));
};

/* 真机 iPhone 的安全区（harness 里没有刘海，手工给上；条的内边距就用它） */
document.documentElement.style.setProperty("--sab", "34px");
document.documentElement.style.setProperty("--sat", "47px");

const App = {
  setup() {
    const barOpen = ref(false);
    const draft = ref("");
    const openBar = () => {
      barOpen.value = true;
      nextTick(() => {
        const ta = document.querySelector(".cmt-main-bar textarea");
        if (ta) ta.focus();
      });
    };

    return () => {
      const cards = [];
      for (let i = 0; i < 12; i++) {
        cards.push(h("div", { class: "fake-card", key: i }, [
          h("div", { style: "font-size:12px;color:#8e8b82" }, "113 次浏览 · 奖杯 0"),
          h("p", {}, `第 ${i + 1} 张帖子`),
          /* 卡内占位条 = 点开底部输入条的入口（与真组件同款类名/文案） */
          h("div", { class: "cmt-entry", "data-entry": i, onClick: openBar }, "说点温柔的话…"),
          h("div", { class: "cmt-toggle" }, "0 条评论 ▾"),
        ]));
      }
      return h("div", { class: "shell shell--mobile-nav" }, [
        h("div", { class: "wall-scroller" }, cards),
        barOpen.value ? h("div", { class: "cmt-bar-mask" }) : null,
        barOpen.value
          ? h("div", { class: "cmt-main-bar" }, [
              h(WpComposer, {
                modelValue: draft.value,
                "onUpdate:modelValue": (v) => { draft.value = v; },
                placeholder: "说点温柔的话…",
              }),
            ])
          : null,
      ]);
    };
  },
};

createApp(App).mount("#app");
initKeyboardInset();
initFixedBar();
window.__ready = true;
