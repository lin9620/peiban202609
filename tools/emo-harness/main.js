/* 轮 183 · 表情面板「真交互」回归台（不是字符串断言，是真挂载 + 真点）
 *
 * 为什么要有这个：轮 179/182 的修复全是读代码 + 断言源码文本做的，用户真机上一连报三次
 * （面板位置不对 / 高度不对 / 收起后光标回首字）。根因是**从没在真 DOM 上把这条交互
 * 走过一遍** —— 失焦元素的 selectionStart 被 v-model 复位、fixed 底条被 margin 顶出屏幕，
 * 这两件事静态读代码看不出来，只有真跑才暴露。
 *
 * 这里挂载的是**真的** EmojiPicker.vue + naive-ui 的**真的** n-input（不是 mock），
 * 结构照抄 .cmt-main-bar / .dm-input-row 的贴屏底几何，再用 CDP 真点。
 * 跑法：node tools/emo-drive.mjs
 */
import { createApp, h, ref, nextTick } from "vue";
import { create, NInput, NConfigProvider, NMessageProvider } from "naive-ui";
import EmojiPicker from "../../src/components/EmojiPicker.vue";
import "../../src/style.css";

/* 面板开启时假装「键盘弹起来了」：把 innerHeight 改小，并派发 resize。
 * 真机上键盘就是这样让窗口变矮的（视觉视口），headless 里键盘不存在，只能这样喂。
 * ⚠️ 关键：光改 window.innerHeight 是不够的 —— 那只是 JS 读数，**CSS 布局视口纹丝不动**，
 * 于是 position:fixed 的底条仍然停在真实屏底，读数全错（轮 183 假阴性就是这么来的）。
 * 所以还要把 .stage 的高度真的设成 innerHeight，让 flex 布局跟着键盘一起收缩。 */
let fakeKb = 0;
const realH = window.innerHeight;
Object.defineProperty(window, "innerHeight", { configurable: true, get: () => realH - fakeKb });
function keyboard(h) {
  fakeKb = h || 0;
  const st = document.querySelector(".stage");
  if (st) st.style.height = window.innerHeight + "px";   /* 布局视口真的变矮 */
  window.dispatchEvent(new Event("resize"));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight; };
const ta = (host) => host.querySelector("textarea, input");
function click(el) {
  /* 真事件：先 pointerdown（组件在 document 上挂了 pointerdown 收起）再 click */
  el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}
function typeInto(host, text, caret) {
  const el = ta(host);
  el.focus();
  el.value = text;
  el.setSelectionRange(caret, caret);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return el;
}

/* 两个真实宿主：① 暖心墙/详情页的贴屏底评论条 ② 消息会话的输入行 */
const Wall = {
  setup() {
    const draft = ref("");
    return { draft };
  },
  render() {
    return h("div", { class: "stage" }, [
      /* 真机 App 端聊天/评论区是「整屏页 + 内部滚动 + 输入区吸底」，
         这里照抄那个骨架：上方可伸缩滚动区 + 底部吸底一条。 */
      h("div", { class: "stage-scroll" }, "消息列表 / 评论列表"),
      h("div", { class: "cmt-main-bar", "data-bar": "wall" }, [
        h("div", { class: "emo-in" }, [
          h(NInput, { value: this.draft, type: "textarea", size: "small", onUpdateValue: (v) => (this.draft = v) }),
          h(EmojiPicker, { text: this.draft, "onUpdate:text": (v) => (this.draft = v) }),
        ]),
      ]),
    ]);
  },
};
const Chat = {
  setup() {
    const body = ref("");
    return { body };
  },
  render() {
    return h("div", { class: "stage" }, [
      h("div", { class: "stage-scroll" }, "消息列表"),
      h("footer", { class: "dm-compose" }, [
        h("div", { class: "dm-input-row" }, [
          h("div", { class: "emo-in" }, [
            h(NInput, { value: this.body, type: "textarea", size: "small", onUpdateValue: (v) => (this.body = v) }),
            h(EmojiPicker, { text: this.body, "onUpdate:text": (v) => (this.body = v) }),
          ]),
        ]),
      ]),
    ]);
  },
};

/* 一次只挂一个宿主：用 hash 选，避免两个宿主的选择器互相干扰读数 */
const WHICH = location.hash === "#wall" ? "wall" : "chat";
const hostRef = ref(null);          /* 生产构建里 app._instance 是 null，只能用模板 ref 拿 vm */
const app = createApp({
  render() {
    return h(NConfigProvider, null, {
      default: () => h(NMessageProvider, null, {
        default: () => (WHICH === "wall" ? h(Wall, { ref: hostRef }) : h(Chat, { ref: hostRef })),
      }),
    });
  },
});
app.mount("#app");

/* ══ 场景：完整走一遍用户描述的那串动作，每步都取实测值 ══ */
window.__scenario = async () => {
  const out = { host: WHICH, steps: [] };
  const log = (k, v) => out.steps.push([k, v]);
  const vm = hostRef.value;
  const host = document.querySelector(WHICH === "wall" ? ".cmt-main-bar" : ".dm-input-row");
  const bar = host;   /* 两边都量「输入行」本身；早先chat 量到 .dm-compose 外层容器，高度对不上，量错了元素 */
  const btn = host.querySelector(".emo-btn");
  const text = () => (WHICH === "wall" ? vm.draft : vm.body);

  /* ── 1. 输入文字，光标停在中间（模拟用户「打了一半」） ── */
  typeInto(host, "abcdef", 3);
  keyboard(310);                       /* 键盘弹着 */
  await sleep(60);
  log("typed", { text: text(), caret: ta(host).selectionStart, focused: document.activeElement === ta(host) });

  /* ── 2. 点表情按钮：面板开、键盘收、输入行被顶到面板上方 ── */
  click(btn);
  await nextTick(); await sleep(80);
  const panel = document.querySelector(".emo-panel");
  const barR0 = bar.getBoundingClientRect();
  log("sheetOpen", {
    panel: !!panel, cells: document.querySelectorAll(".emo-cell").length,
    panelH: panel ? Math.round(panel.getBoundingClientRect().height) : null,
    barVisible: vis(bar), barTop: Math.round(barR0.top), barBottom: Math.round(barR0.bottom),
    panelTop: panel ? Math.round(panel.getBoundingClientRect().top) : null,
    inputVisible: vis(ta(host)),
  });

  /* ── 3. 点第一个表情（连点两个，模拟连选） ── */
  const cells = document.querySelectorAll(".emo-cell");
  click(cells[0]); await nextTick(); await sleep(40);
  click(cells[1]); await nextTick(); await sleep(40);
  log("afterPick", { text: text(), stillOpen: !!document.querySelector(".emo-panel"), inputVisible: vis(ta(host)) });

  /* ── 4. 再点表情按钮收起：焦点必须回到输入框、光标必须还在插入处 ── */
  click(btn); await nextTick(); await sleep(120);
  const el = ta(host);
  const barR1 = bar.getBoundingClientRect();
  log("afterToggleOff", {
    closed: !document.querySelector(".emo-panel"),
    text: text(),
    focused: document.activeElement === el,
    caret: el.selectionStart,
    inputVisible: vis(el),
    barVisible: vis(bar), barBottom: Math.round(barR1.bottom),
    marginCleared: !bar.style.marginBottom,
  });
  keyboard(0);
  await sleep(80);
  log("final", { inputVisible: vis(el), barVisible: vis(bar), text: text() });
  return out;
};
window.__ready = true;