/* 轮 514 · vendored 会话库的「手机表情面板」真几何回归台
 * ------------------------------------------------------------
 * 只挂 vue-advanced-chat 本体（不挂 DmVacChat 的业务层），目的是把这一轮的 fork
 * 改动变成**可量的数字**：
 *   · wrapper 是不是 static（不是的话面板以按钮为包含块，缩成一条竖线）
 *   · 手机端面板是不是 fixed + 整宽 + 贴屏底
 *   · bottom 是否真的吃 --kbb（iOS 底部工具栏 81px）
 *   · height 是否真的吃 --kb-panel-h（= 键盘高）
 *   · 面板上有没有残留内联 height/top/right（那些内联值就是过去要 !important 的原因）
 *
 * 跑法：node tools/vac-sheet-drive.mjs [--keep]
 */
import { createApp, h, nextTick } from "vue";
import { register } from "vue-advanced-chat";
import "emoji-picker-element";
import "../../src/style.css";

register();

const ME = "u1";
const rooms = [{
  roomId: "r1",
  roomName: "测试会话",
  avatar: "",
  unreadCount: 0,
  index: 0,
  users: [{ _id: "u1", username: "我" }, { _id: "u2", username: "对方" }],
  usersList: {},
  lastMessage: { content: "在吗", senderId: "u2", timestamp: "10:00", createdAt: "" },
}];
const messages = [{
  _id: "m1", senderId: "u2", content: "在吗", timestamp: "10:00", date: "2026-11-12",
  avatar: "", system: false, saved: false, distributed: false, seen: false,
  disableActions: false, disableReactions: false, reactions: {},
}];

const app = createApp({
  render: () => h("div", { class: "dm-thread", style: "display:flex;flex-direction:column;height:100%" }, [
    h("vue-advanced-chat", {
      "current-user-id": ME,
      "room-id": "r1",
      rooms: JSON.stringify(rooms),
      messages: JSON.stringify(messages),
      "rooms-loaded": "true",
      "messages-loaded": "true",
      "show-add-room": "false",
      "show-audio": "false",
      "show-files": "false",
      "show-emojis": "true",
      "show-reaction-emojis": "false",
      "emojis-suggestion-enabled": "false",
      "show-footer": "true",
      "textarea-auto-focus": "false",
      theme: "light",
      styles: JSON.stringify({}),
    }),
  ]),
});

const vm = app.mount("#app");

nextTick(() => {
  /* 等自定义元素升级完再放行，驱动脚本会轮询这个标记 */
  requestAnimationFrame(() => { window.__ready = true; });
  window.__vm = vm;
});
