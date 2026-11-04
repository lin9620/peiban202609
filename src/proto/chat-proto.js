/* 会话页原型（轮 326 · 方案 B 评估用，独立入口 /proto-chat.html）
 *
 * 目的只有一个：把 `vue-advanced-chat@2.1.2`（MIT）真跑起来，让用户看「手感 + 皮肤」，
 * 顺便验证两件我们最担心的事：
 *   ① 它能不能吃我们的米色皮肤（styles 里的 CSS 变量）；
 *   ② 它自己不管键盘 —— 我们能不能用现有的 `--kb-h` 把窗口高度接上去。
 *
 * 这一页是**独立入口**：不引 router、不碰 MessagesView.vue、不读写任何后端数据
 * （全部硬编码样例）。验完可以直接删掉 proto-chat.html + src/proto/ 两个文件收回。
 */
import { createApp, h, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { register } from "vue-advanced-chat";
import { convsToRooms, rowsToMessages } from "../utils/dmMap.js";
import { readCachedConvs, readCachedMessages } from "./dm-cache.js";
import { avatarUrlFor } from "../utils/avatar.js";

register();

/* ───────────────────────── 样例数据 ───────────────────────── */

const ME = "me";
const NOW = Date.now();
const t = (minAgo) => new Date(NOW - minAgo * 60000);
const hhmm = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const day = (d) => `${d.getMonth() + 1}月${d.getDate()}日`;

/* 头像是 data URI 的 SVG 小圆牌（圆牌里放一个字），避免原型页去拉网络图 */
const av = (ch, bg) =>
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><circle cx="40" cy="40" r="40" fill="${bg}"/><text x="40" y="53" font-size="36" font-family="sans-serif" fill="#fff" text-anchor="middle">${ch}</text></svg>`
  );

const USER_QIU = { _id: "u_qiu", username: "球球的主人", avatar: av("球", "#b7a6e8"), status: { state: "online", lastChanged: "刚刚" } };
const USER_ME = { _id: ME, username: "我", avatar: av("我", "#cc785c"), status: { state: "online", lastChanged: "刚刚" } };
const USER_BUDIN = { _id: "u_budin", username: "布丁", avatar: av("布", "#9ed0f5") };
const USER_FU = { _id: "u_fu", username: "阿福", avatar: av("福", "#5db872") };

const ROOMS = [
  {
    roomId: "r_qiu",
    roomName: "球球的主人",
    avatar: av("球", "#b7a6e8"),
    unreadCount: 2,
    index: t(3).toISOString(),
    lastMessage: { _id: "m9", content: "周末一起带它去河边？", senderId: "u_qiu", username: "球球的主人", timestamp: hhmm(t(3)), seen: false, new: true },
    users: [USER_QIU, USER_ME],
  },
  {
    roomId: "r_budin",
    roomName: "布丁 & 阿福",
    avatar: av("布", "#9ed0f5"),
    unreadCount: 0,
    index: t(80).toISOString(),
    lastMessage: { _id: "n3", content: "照片存我这里了，随时来拿", senderId: ME, username: "我", timestamp: hhmm(t(80)), seen: true },
    users: [USER_QIU, USER_ME, USER_BUDIN],
  },
  {
    roomId: "r_patrol",
    roomName: "夜间巡逻小队",
    avatar: av("夜", "#6c6a64"),
    unreadCount: 7,
    index: t(200).toISOString(),
    lastMessage: { _id: "p4", content: "今晚十点老地方集合", senderId: "u_budin", username: "布丁", timestamp: hhmm(t(200)) },
    users: [USER_QIU, USER_ME, USER_BUDIN, USER_FU],
  },
];

const mk = (o) => ({
  system: false, saved: true, distributed: true, seen: false, deleted: false, failure: false,
  disableActions: false, disableReactions: false, ...o,
});

const MESSAGES = {
  r_qiu: [
    mk({ _id: "m1", content: "你好呀，看到你家球球的照片了，毛色真好看 🐾", senderId: ME, username: "我", date: day(t(1500)), timestamp: hhmm(t(1500)), seen: true }),
    mk({ _id: "m2", content: "谢谢！它最近刚换了粮，精神好多了", senderId: "u_qiu", username: "球球的主人", date: day(t(1490)), timestamp: hhmm(t(1490)) }),
    mk({ _id: "m3", content: "我家原来吃的那款它不太爱，后来换了低敏的才正常", senderId: ME, username: "我", date: day(t(1480)), timestamp: hhmm(t(1480)), seen: true }),
    mk({ _id: "m4", content: "球球完成了一次领养回访", senderId: "system", username: "", system: true, date: day(t(1400)), timestamp: hhmm(t(1400)) }),
    mk({
      _id: "m5",
      content: "就是这个，我问过医生了，说可以慢慢换",
      senderId: "u_qiu",
      username: "球球的主人",
      date: day(t(120)),
      timestamp: hhmm(t(120)),
      replyMessage: { _id: "m3", content: "我家原来吃的那款它不太爱，后来换了低敏的才正常", senderId: ME, username: "我", avatar: "" },
      reactions: { "🐾": ["me", "u_qiu"], "❤️": ["u_qiu"] },
    }),
    mk({ _id: "m6", content: "那我照着这个来，先混一半试三天", senderId: ME, username: "我", date: day(t(60)), timestamp: hhmm(t(60)), seen: true }),
    mk({ _id: "m7", content: "对，三天没问题再全换", senderId: "u_qiu", username: "球球的主人", date: day(t(58)), timestamp: hhmm(t(58)) }),
    mk({ _id: "m8", content: "这张是今天早上拍的", senderId: "u_qiu", username: "球球的主人", date: "今天", timestamp: hhmm(t(5)) }),
    mk({ _id: "m9", content: "周末一起带它去河边？", senderId: "u_qiu", username: "球球的主人", date: "今天", timestamp: hhmm(t(3)), new: true }),
  ],
  r_budin: [
    mk({ _id: "n1", content: "照片我都整理好了，一共 12 张", senderId: "u_budin", username: "布丁", date: day(t(120)), timestamp: hhmm(t(120)) }),
    mk({ _id: "n2", content: "谢啦，我挑两张放暖心墙", senderId: ME, username: "我", date: day(t(100)), timestamp: hhmm(t(100)), seen: true }),
    mk({ _id: "n3", content: "照片存我这里了，随时来拿", senderId: ME, username: "我", date: "今天", timestamp: hhmm(t(80)), seen: true }),
  ],
  r_patrol: [
    mk({ _id: "p1", content: "今晚风大，记得带外套", senderId: "u_fu", username: "阿福", date: "今天", timestamp: hhmm(t(240)) }),
    mk({ _id: "p2", content: "我带了两袋猫粮过去", senderId: ME, username: "我", date: "今天", timestamp: hhmm(t(220)), seen: true }),
    mk({ _id: "p3", content: "老地方见", senderId: "u_budin", username: "布丁", date: "今天", timestamp: hhmm(t(210)) }),
    mk({ _id: "p4", content: "今晚十点老地方集合", senderId: "u_budin", username: "布丁", date: "今天", timestamp: hhmm(t(200)) }),
  ],
};

/* ───────────────────────── 皮肤 & 文案 ───────────────────────── */

const TEXT = {
  ROOMS_EMPTY: "还没有会话",
  ROOM_EMPTY: "选一个会话",
  NEW_MESSAGES: "新消息",
  MESSAGE_DELETED: "这条消息已撤回",
  MESSAGES_EMPTY: "还没有聊过",
  CONVERSATION_STARTED: "会话开始于：",
  TYPE_MESSAGE: "发消息…",
  SEARCH: "搜索",
  IS_ONLINE: "在线",
  LAST_SEEN: "最后在线 ",
  IS_TYPING: "正在输入…",
  CANCEL_SELECT_MESSAGE: "取消",
};

/* 主题键取自组件内置 defaultThemeStyles（general/container/header/footer/content/
 * sidemenu/dropdown/message/markdown/room/emoji/icons）。值用我们站内的米色系
 * （src/style.css：--ink / --ink-soft / --ink-faint / --accent / --card / --hairline / --glass）。
 *
 * 一个已知限制：主题里只有 `message.color` 一个正文色，没有「我的气泡文字色」。
 * 我们现在是我方气泡用 --accent 底 + 白字；想做到这个效果得往 shadowRoot 里补一条
 * `.vac-message-current { color: #fff }`（可行，见轮 326 记录），原型先用浅珊瑚底。 */
const STYLES = {
  general: {
    color: "#141413",
    colorButton: "#ffffff",
    backgroundColorButton: "#cc785c",
    colorButtonClear: "#cc785c",
    backgroundInput: "#fffdf9",
    colorPlaceholder: "#8e8b82",
    colorCaret: "#cc785c",
    colorSpinner: "#a9583e",
    borderStyle: "1px solid #e6dfd8",
    backgroundScrollIcon: "#fffdf9",
  },
  container: { border: "none", borderRadius: "0px", boxShadow: "none" },
  header: { background: "#faf9f5", colorRoomName: "#141413", colorRoomInfo: "#8e8b82" },
  footer: {
    background: "#faf9f5",
    borderStyleInput: "1px solid #e6dfd8",
    borderInputSelected: "#cc785c",
    backgroundReply: "#f5f0e8",
    backgroundTag: "#f5f0e8",
    backgroundTagActive: "#efe9de",
  },
  content: { background: "#faf9f5" },
  sidemenu: {
    background: "#faf9f5",
    backgroundHover: "#f5f0e8",
    backgroundActive: "#efe9de",
    colorActive: "#a9583e",
    borderColorSearch: "#e6dfd8",
  },
  dropdown: { background: "#fffdf9", backgroundHover: "#f5f0e8" },
  message: {
    background: "#efe9de",
    backgroundMe: "#f3ddd4",
    color: "#141413",
    colorStarted: "#8e8b82",
    colorUsername: "#6c6a64",
    colorTimestamp: "#8e8b82",
    backgroundDate: "#efe9de",
    colorDate: "#6c6a64",
    backgroundSystem: "#f5f0e8",
    colorSystem: "#6c6a64",
    backgroundDeleted: "#efe9de",
    colorDeleted: "#8e8b82",
    backgroundSelected: "#f5f0e8",
    backgroundReply: "rgba(20, 20, 19, 0.06)",
    colorReplyUsername: "#141413",
    colorReply: "#6c6a64",
    colorNewMessages: "#cc785c",
    backgroundScrollCounter: "#141413",
    colorScrollCounter: "#ffffff",
    backgroundReaction: "#fffdf9",
    borderStyleReaction: "1px solid #e6dfd8",
    backgroundReactionHover: "#f5f0e8",
    borderStyleReactionHover: "1px solid #d8d0c7",
    colorReactionCounter: "#141413",
    backgroundReactionMe: "#f5e3da",
    borderStyleReactionMe: "1px solid #cc785c",
    backgroundReactionHoverMe: "#f5e3da",
    borderStyleReactionHoverMe: "1px solid #a9583e",
    colorReactionCounterMe: "#a9583e",
    backgroundAudioRecord: "#c64545",
    backgroundAudioLine: "rgba(20, 20, 19, 0.15)",
    backgroundAudioProgress: "#cc785c",
    backgroundAudioProgressSelector: "#a9583e",
    colorFileExtension: "#6c6a64",
  },
  markdown: { background: "rgba(239, 233, 222, 0.7)", border: "rgba(230, 223, 216, 0.9)", color: "#cc785c", colorMulti: "#141413" },
  room: {
    colorUsername: "#141413",
    colorMessage: "#6c6a64",
    colorTimestamp: "#8e8b82",
    colorStateOnline: "#5db872",
    colorStateOffline: "#8e8b82",
    backgroundCounterBadge: "#cc785c",
    colorCounterBadge: "#ffffff",
  },
  emoji: { background: "#fffdf9" },
  icons: {
    search: "#8e8b82",
    add: "#cc785c",
    toggle: "#141413",
    menu: "#141413",
    close: "#8e8b82",
    closeImage: "#ffffff",
    file: "#cc785c",
    paperclip: "#cc785c",
    closeOutline: "#141413",
    closePreview: "#ffffff",
    send: "#cc785c",
    sendDisabled: "#c9c4bb",
    emoji: "#cc785c",
    emojiReaction: "rgba(20, 20, 19, 0.3)",
    document: "#cc785c",
    pencil: "#8e8b82",
    checkmark: "#c9c4bb",
    checkmarkSeen: "#cc785c",
    eye: "#ffffff",
    dropdownMessage: "#ffffff",
    dropdownMessageBackground: "rgba(20, 20, 19, 0.25)",
    dropdownRoom: "#8e8b82",
    dropdownScroll: "#141413",
    microphone: "#cc785c",
    audioPlay: "#141413",
    audioPause: "#141413",
    audioCancel: "#c64545",
    audioConfirm: "#5db872",
  },
};

/* ───────────────────────── 页面 ───────────────────────── */

const App = {
  setup() {
    const el = ref(null);
    const rooms = ref(ROOMS);
    const roomId = ref("r_qiu");
    const messages = ref(MESSAGES.r_qiu);
    const singleRoom = ref(false);
    /* 组件内部的 loadingMessages 只认 messagesLoaded 由 false → true 的**变化**
       （源码：messagesLoaded(val) { if (val) this.updateLoadingMessages(false) }）。
       一开始就给 true 的话 watcher 不触发，消息区会永远转圈 —— 实测踩到过。 */
    const loaded = ref(false);

    /* ── 本地缓存模式（微信式，只读）：会话 = SWR localStorage，历史 = IndexedDB 全量库 ──
       这就是「换组件不动缓存」的证明：组件只换画法，数据仍从我们原有的两层缓存读。 */
    const cached = ref(false);
    const meId = ref("");
    const nameOf = (uid) => {
      const id = String(uid || "");
      if (!id) return "";
      if (id === String(meId.value)) return "我";
      for (const r of rooms.value) {
        const u = (r.users || []).find((x) => String(x._id) === id);
        if (u && u.username) return u.username;
      }
      return "";
    };
    function myId() {
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i) || "";
          if (!/^sb-.*-auth-token$/.test(k)) continue;
          const tok = JSON.parse(localStorage.getItem(k));
          const u = tok && (tok.user || (tok.currentSession && tok.currentSession.user));
          if (u && u.id) return u.id;
        }
      } catch (e) { /* 未登录 / 坏 token */ }
      return "";
    }
    async function loadCache() {
      meId.value = myId();
      if (!meId.value) return false;
      const rows = readCachedConvs(meId.value);
      if (!rows.length) return false;
      rooms.value = convsToRooms(rows, { meId: meId.value, avatarOf: avatarUrlFor });
      const first = rooms.value[0];
      if (!first) return false;
      roomId.value = first.roomId;
      const { msgs } = await readCachedMessages(first.roomId);
      messages.value = rowsToMessages(msgs, { nameOf });
      return true;
    }
    async function useCache(on) {
      cached.value = !!on;
      loaded.value = false;
      const ok = on ? await loadCache() : false;
      if (!ok) {
        cached.value = false;
        rooms.value = ROOMS;
        messages.value = MESSAGES.r_qiu;
        roomId.value = "r_qiu";
      }
      await new Promise((r) => setTimeout(r, 60));
      loaded.value = true;
    }

    const attrs = () => ({
      ref: el,
      /* 宿主自己跟 --kb-h 走；组件内部再用 height="100%" 填满宿主。
         （组件的 height prop 只作用于它内部容器，宿主不跟着改的话键盘会盖住输入栏） */
      style: "display:block;width:100%;height:calc(100dvh - var(--kb-h, 0px))",
      height: "100%",
      "current-user-id": ME,
      "room-id": roomId.value,
      rooms: JSON.stringify(rooms.value),
      messages: JSON.stringify(messages.value),
      "text-messages": JSON.stringify(TEXT),
      styles: JSON.stringify(STYLES),
      theme: "light",
      "show-add-room": "false",
      "show-search": "false",
      "show-audio": "false",
      "show-files": "false",
      "show-emojis": "true",
      "show-reaction-emojis": "true",
      "single-room": singleRoom.value ? "true" : "false",
      "rooms-list-opened": "true",
      "load-first-room": "false",
      "rooms-loaded": "true",
      "messages-loaded": loaded.value ? "true" : "false",
      "responsive-breakpoint": "900",
      "textarea-auto-focus": "false",
    });

    const onSend = (e) => {
      const d = e.detail || e;
      const now = new Date();
      messages.value = [
        ...messages.value,
        mk({
          _id: "local_" + now.getTime(),
          content: d.content || "",
          senderId: ME,
          username: "我",
          date: "今天",
          timestamp: hhmm(now),
          seen: false,
        }),
      ];
    };

    const onFetch = async () => {
      /* 组件「上滑加载更多 / 首帧」只发一个空事件（2.1.2 的 loadMoreMessages 不带 payload），
         靠 messagesLoaded 的 false→true 翻转收尾。
         注意别在「已经在加载态」时二次翻转（首帧那 120ms 内就是这么被翻没的）。 */
      if (!loaded.value) return;
      loaded.value = false;
      await nextTick();
      loaded.value = true;
    };

    /* 点会话由我们自己接管：2.1.2 点会话只发 `fetch-room`（它自己**不换**房间），
       `fetch-messages` 在打开会话时 payload 可能为空，靠它猜会话不可靠。
       换会话时**先把数据拿到手，再在同一个 tick 里一起提交 roomId + messages**：
       组件 onRoomChanged 会开 loader，但它紧接着立即 watch messages（此时已有内容）
       → 下一帧就滚到底并关掉 loader，不会出现「空列表转圈再弹出」的闪跳。 */
    const openRoom = async (cid) => {
      cid = String(cid);
      if (cid === roomId.value) return;
      const list = cached.value
        ? rowsToMessages((await readCachedMessages(cid)).msgs, { nameOf })
        : (Array.isArray(MESSAGES[cid]) ? [...MESSAGES[cid]] : []);
      roomId.value = cid;
      messages.value = list;
      if (!list.length) {
        /* 空会话没人来关 loader，手动收一次 */
        loaded.value = false;
        await nextTick();
        loaded.value = true;
      }
    };
    /* 组件点会话只发 `fetch-room`（它自己**不换**房间，这是它的设计），我们收到后换 prop；
       顺手在 shadow 里也接一层点击兜底（2.1.2 在某些布局下事件链会断）。 */
    const onFetchRoom = (e) => {
      const r = e.detail && e.detail.room;
      if (r && r.roomId) openRoom(r.roomId);
    };
    const onShadowClick = (e) => {
      const t = e.target;
      const item = t && t.closest ? t.closest(".vac-room-item") : null;
      if (item && item.id) openRoom(item.id);
    };

    const bind = () => {
      const node = el.value;
      if (!node) return;
      node.addEventListener("send-message", onSend);
      node.addEventListener("fetch-messages", onFetch);
      node.addEventListener("fetch-room", onFetchRoom);
      if (node.shadowRoot) node.shadowRoot.addEventListener("click", onShadowClick);
    };

    onMounted(() => {
      bind();
      /* 首帧：数据已经就位，只把 messagesLoaded 从 false 翻到 true（组件只认这个翻转）。
         尽量压在同一帧里，避免首屏出现「空白 → 消息弹出」的闪跳。 */
      loaded.value = false;
      nextTick(() => { loaded.value = true; });
    });
    onBeforeUnmount(() => {
      const node = el.value;
      if (!node) return;
      node.removeEventListener("send-message", onSend);
      node.removeEventListener("fetch-messages", onFetch);
      node.removeEventListener("fetch-room", onFetchRoom);
    });

    /* 探针/自检用：别的地方不改行为 */
    window.__proto = {
      setKb(px) { document.documentElement.style.setProperty("--kb-h", (Number(px) || 0) + "px"); },
      setSysBottom(px) { document.documentElement.style.setProperty("--sys-bottom", (Number(px) || 0) + "px"); },
      setSingle(v) { singleRoom.value = !!v; },
      useCache(v) { return useCache(!!v); },
      isCached() { return cached.value; },
      state() {
        const node = el.value;
        const sr = node && node.shadowRoot;
        const ta = sr ? sr.querySelector("textarea") : null;
        const r = node ? node.getBoundingClientRect() : null;
        return {
          hasEl: !!node,
          hasShadow: !!sr,
          kbH: getComputedStyle(document.documentElement).getPropertyValue("--kb-h").trim(),
          hostRect: r ? { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) } : null,
          textareaBottom: ta ? Math.round(ta.getBoundingClientRect().bottom) : null,
          messages: sr ? sr.querySelectorAll(".vac-message-wrapper").length : 0,
          rooms: sr ? sr.querySelectorAll(".vac-room-item").length : 0,
          viewport: window.innerHeight,
        };
      },
    };

    return () => [
      h("div", { class: "proto-switch" }, [
        h("button", { "data-on": cached.value ? "0" : "1", onClick: () => useCache(false) }, "样例"),
        h("button", { "data-on": cached.value ? "1" : "0", onClick: () => useCache(true) }, "我的缓存"),
        h("button", { "data-on": singleRoom.value ? "1" : "0", onClick: () => { singleRoom.value = true; } }, "只看会话"),
        h("button", { "data-on": singleRoom.value ? "0" : "1", onClick: () => { singleRoom.value = false; } }, "列表 + 会话"),
      ]),
      h("vue-advanced-chat", attrs()),
    ];
  },
};

createApp(App).mount("#app");
