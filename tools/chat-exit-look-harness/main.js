import "../../src/style.css";
import { initViewportVars } from "../../src/utils/viewportVars.js";
import { initChatViewport, kickChatViewport, releaseChatViewport } from "../../src/utils/chatViewport.js";

const list = document.getElementById("list");
const page = document.getElementById("page");
const thread = document.getElementById("thread");
const shell = document.getElementById("shell");

/* 列表填 14 行，足够让文档比一屏高（真站列表也是这样） */
list.innerHTML = Array.from({ length: 14 }, (_, i) =>
  `<div class="dm-row" data-i="${i}"><div class="dm-ava">🐾</div>`
  + `<div class="dm-main"><b>会话 ${i + 1}</b><small>最后一条消息内容</small></div></div>`).join("");

initViewportVars();
initChatViewport();

const rect = (n) => {
  if (!n) return null;
  const r = n.getBoundingClientRect();
  return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
};
const snap = () => ({
  t: Math.round(performance.now()),
  inner: Math.round(window.innerHeight),
  scrollY: Math.round(window.scrollY),
  docH: document.documentElement.scrollHeight,
  page: rect(page),
  pageInline: page.style.position || "",
  list: rect(list),
  row0: rect(list.querySelector(".dm-row")),
  row1: rect(list.querySelectorAll(".dm-row")[1]),
  thread: rect(thread),
  threadPos: getComputedStyle(thread).position,
  listDisplay: getComputedStyle(list).display,
  shellPb: getComputedStyle(shell).paddingBottom,
  mainPt: getComputedStyle(document.querySelector("main")).paddingTop,
  cls: page.className,
  htmlCls: document.documentElement.className,
  shellCls: shell.className,
});

const frames = [];
let sampling = false;
function startSample(ms) {
  frames.length = 0;
  sampling = true;
  const stop = performance.now() + ms;
  const tick = () => {
    if (!sampling) return;
    frames.push(snap());
    if (performance.now() < stop) requestAnimationFrame(tick);
    else sampling = false;
  };
  requestAnimationFrame(tick);
}

window.__snap = snap;
window.__frames = () => frames;

/* 进入会话：外壳已经是 chat 形态，这里只把接管踢一脚 */
window.__enter = (opts) => {
  const o = Object.assign({ keyboard: false }, opts || {});
  page.classList.add("dm-page--chat");
  shell.classList.add("shell--chat");
  list.style.display = "none";
  thread.style.removeProperty("display");
  kickChatViewport();
  if (o.keyboard) {
    /* 模拟键盘态：chatViewport 会把盒子写成 inner − 键盘高，这里直接写成 484 */
    page.style.position = "fixed";
    page.style.top = "0px";
    page.style.left = "0px";
    page.style.width = "393px";
    page.style.height = "484px";
    page.style.overflow = "hidden";
    page.style.transition = "none";
  }
  return snap();
};

const FREEZE = ["position", "top", "left", "width", "height", "margin", "zIndex"];
const freezeOut = () => {
  const r = thread.getBoundingClientRect();
  thread.style.position = "fixed";
  thread.style.top = Math.round(r.top) + "px";
  thread.style.left = Math.round(r.left) + "px";
  thread.style.width = Math.round(r.width) + "px";
  thread.style.height = Math.round(r.height) + "px";
  thread.style.margin = "0";
  thread.style.zIndex = "40";
};

/* 退出：逐步复刻 MessagesView.beginThreadOut 的时序 */
window.__exit = (opts) => {
  const o = Object.assign({ release: true, freeze: true }, opts || {});
  startSample(900);
  document.documentElement.classList.add("dm-exiting");
  if (o.freeze) freezeOut();
  page.classList.add("dm-page--exit");
  thread.classList.add("dm-thread--out");
  list.style.display = "";
  if (o.release) releaseChatViewport();
  const done = () => {
    page.classList.remove("dm-page--exit");
    thread.classList.remove("dm-thread--out");
    page.classList.remove("dm-page--chat");
    shell.classList.remove("shell--chat");
    list.style.display = "";
    thread.style.display = "none";
    for (const k of FREEZE) thread.style[k] = "";
    requestAnimationFrame(() => document.documentElement.classList.remove("dm-exiting"));
  };
  thread.addEventListener("animationend", done, { once: true });
  setTimeout(done, 420);
  return snap();
};

window.__ready = true;
