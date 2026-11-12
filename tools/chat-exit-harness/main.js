/* 轮 517 · 「退出会话 → 会话列表」那一刻的接管拆除（真渲染）
 * ------------------------------------------------------------------
 * 用户（安卓浏览器）：「从某一条会话退出到会话列表有一个缩放的问题，之前没有的」。
 *
 * 这一台只量一件事：**退出那一帧，谁把 fixed 接管收回去了**。
 *   utils/chatViewport.js 进会话时给 .dm-page 写内联
 *     position:fixed / top / left / width / height / overflow:hidden
 *   并给 html/body 加 overflow:hidden + html.wp-chat-fix（CSS 里 height:100%）。
 *   退出只是把 `dm-page--chat` 这个**类**摘掉，内联样式不会自己消失。
 *   以前没人负责收摊，只能等 250ms 巡检 —— 这期间列表页被钉在一个裁切框里。
 *
 * 跑法：node tools/chat-exit-drive.mjs [--keep]
 */
import "../../src/style.css";
import {
  initChatViewport, kickChatViewport, releaseChatViewport,
} from "../../src/utils/chatViewport.js";

/* 列表 60 条，保证比一屏高（393×852 一屏放不下） */
const list = document.getElementById("list");
for (let i = 0; i < 60; i++) {
  const d = document.createElement("div");
  d.className = "dm-item";
  d.textContent = "会话 " + (i + 1);
  list.appendChild(d);
}

const shell = document.getElementById("shell");
const page = document.getElementById("page");
const thread0 = document.getElementById("thread");

const rect = (el) => {
  if (!el) return null;
  const b = el.getBoundingClientRect();
  return { t: Math.round(b.top), b: Math.round(b.bottom), h: Math.round(b.height), w: Math.round(b.width) };
};

const snap = () => {
  const de = document.documentElement;
  const th = document.getElementById("thread");
  return {
    fix: de.classList.contains("wp-chat-fix"),
    htmlOv: de.style.overflow || "",
    bodyOv: document.body.style.overflow || "",
    pagePos: page.style.position || "",
    pageH: page.style.height || "",
    pageW: page.style.width || "",
    pageOv: page.style.overflow || "",
    pageCls: page.className,
    listDisplay: getComputedStyle(list).display,
    listRect: rect(list),
    docScrollH: de.scrollHeight,
    docClientH: de.clientHeight,
    threadIn: !!th,
  };
};

/* 进会话 / 出会话的 DOM 变化（与 Vue 那边同一组：类 + v-show + v-else 的 section） */
const enterChat = () => {
  page.classList.add("dm-page--chat");
  shell.classList.add("shell--chat");
  list.style.display = "none";
  if (!document.getElementById("thread")) {
    const s = document.createElement("section");
    s.className = "card dm-thread";
    s.id = "thread";
    s.innerHTML = '<div class="dm-scroll" style="height:100%;overflow:auto"><div style="height:1600px"></div></div>';
    page.querySelector(".dm-wrap").appendChild(s);
  }
};

const exitChat = () => {
  page.classList.remove("dm-page--chat");
  shell.classList.remove("shell--chat");
  const th = document.getElementById("thread");
  if (th) th.remove();
  list.style.display = "";
};

initChatViewport();
kickChatViewport();

window.__ready = true;
window.__snap = snap;
window.__enter = () => { enterChat(); kickChatViewport(); return snap(); };
window.__exit = (withRelease) => {
  exitChat();
  if (withRelease) releaseChatViewport();
  return snap();
};
window.__thread0 = !!thread0;
