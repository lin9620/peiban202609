<script setup>
/* 会话页 · vue-advanced-chat 外壳（轮 330 起）
 * ------------------------------------------------------------
 * 这一层只做两件事：把「我们的会话/消息行」翻成组件的 rooms/messages，把组件里的
 * 用户动作（点会话 / 发送 / 撤回 / 上滑 / 返回）抛回去。
 *
 * 不碰数据：缓存三层（dmStore 首帧 → SWR 会话列表 → IndexedDB 全量历史）、发送队列、
 * 已读水位、拉黑过滤，全都还在 MessagesView 里。换组件只换画法。
 *
 * 两个坑（轮 328/329 实测，别改回去）：
 *   ① messagesLoaded 只认 false→true 的**变化**，一开始给 true 就永远转圈；
 *   ② 换会话时若先清空消息区再等数据，中间必然有「空列表帧」= 闪跳。
 *      所以 roomId 与 messages 必须在同一个 tick 一起提交，让组件开 loader 后
 *      立刻发现「已有消息」→ 下一帧滚到底并关掉。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { register } from "vue-advanced-chat";
import { convToRoom, convsToRooms, rowsToMessages } from "../utils/dmMap.js";
import { BODY_MAX, canRecall } from "../utils/dmRules.js";
import { avatarUrlFor } from "../utils/avatar.js";
import { hideEmojiSearchIn } from "../utils/emojiPanel.js";
import { scheduleEmojiWarm } from "../utils/emojiWarm.js";
import { isApp } from "../stores/uiStore.js";
import { webSwapNeeded, setPanelOpen } from "../utils/keyboardInset.js";
import { startBottomPin, stopBottomPin } from "../utils/bottomPin.js";
import { syncViewportVars } from "../utils/viewportVars.js";
/* 轮 533 · iOS 走专属控制器（utils/iosKb.js），这里只判一次「是不是 iOS」。
 * 用户：「苹果的你搞个单独的，代码隔离一下」—— 所以下面凡是要分内核的地方，
 * iOS 一律用这个**编译期常量**，不再去读 window.__wpVars 那种运行时快照。 */
import { isIosKbDevice } from "../utils/iosKb.js";
import { kickChatViewport } from "../utils/chatViewport.js";
import { createEmojiSkel } from "../utils/emojiSkel.js";
import { t } from "../i18n.js";

register();

const props = defineProps({
  convs: { type: Array, default: () => [] },        /* 现网 conv 行（原样） */
  messages: { type: Array, default: () => [] },     /* 现网 msg 行（原样） */
  roomId: { type: String, default: "" },            /* 当前会话 conv_id */
  meId: { type: String, default: "" },
  peerName: { type: String, default: "" },          /* 对方昵称（1:1 会话，用来给 senderId 配名） */
  loadingMessages: { type: Boolean, default: false },
  recallMinutes: { type: Number, default: 15 },
  /* 旧版头部/输入区的能力，原样搬到组件里（见 THEME_CSS 的「旧版设计」段） */
  canType: { type: Boolean, default: true },        /* 消息请求 / 被我拉黑 → 不给输入 */
  gate: { type: String, default: "" },              /* canType=false 时显示的原因 */
  /* 轮 353：发送/撤回失败的原因（旧版输入框上方那行红字）。空串 = 不显示。
     陌生人首聊 3 条上限（first-limit）就是靠它提示，组件本身没有这个位置。 */
  err: { type: String, default: "" },
  placeholder: { type: String, default: "" },       /* 输入框占位（桌面带键位说明） */
  showBack: { type: Boolean, default: false },      /* 手机聊天页：头部 ← 返回 */
  /* 轮 339：漂流瓶聊天框复用这个外壳时，头部仍用旧页面那条（带「温暖漂流瓶」胶囊
     和父级注入的 ⋯ 菜单），组件自己的头藏掉 —— 只借它的消息流 + 输入区。 */
  hideHeader: { type: Boolean, default: false },
  /* 当前会话的「对方」信息（activeConv 或深链补来的 meta）：昵称 / 对方 id。
     列表还没加载到这一行时，用它合成一个 room，否则组件会渲染出没有标题栏、
     没有输入框的空壳（轮 331 深链实测）。 */
  peer: { type: Object, default: null },
  /* 轮379：父级按「账号:会话」保存的未发送草稿。组件只在挂载/切会话时读它，
     不在每次输入时回写，避免 textarea 被父级 prop 反复赋值、光标跳到末尾。 */
  drafts: { type: Object, default: () => ({}) },
});

const emit = defineEmits(["send", "recall", "load-more", "room-action", "back", "resend", "draft"]);


const el = ref(null);
/* 组件内部的 loadingMessages 只认 messagesLoaded 由 false → true 的变化 */
const loaded = ref(false);
const curRoom = ref("");
const curMsgs = ref([]);
/* 轮379：每个会话的未发送草稿。key = 账号:会话，避免换号后把 A 的草稿显示给 B。
   草稿只在「切会话 / 组件卸载」时抛给父级，输入过程中不碰父级 props。 */
const draftKey = (room) => `${String(props.meId || "")}:${String(room || "")}`;
const localDrafts = new Map();
for (const [k, v] of Object.entries(props.drafts || {})) {
  if (typeof v === "string" && v) localDrafts.set(String(k), v);
}
const draftSeed = ref("");

const nameOf = (uid) => {
  const id = String(uid || "");
  if (!id) return "";
  if (id === String(props.meId)) return "我";
  return props.peerName || "";
};

const rooms = computed(() => {
  const list = convsToRooms(props.convs, { meId: props.meId, avatarOf: avatarUrlFor });
  const cid = String(props.roomId || "");
  if (!cid || list.some((r) => String(r.roomId) === cid)) return list;
  const p = props.peer || {};
  const now = new Date().toISOString();
  const synth = convToRoom(
    {
      conv_id: cid, other_id: p.other_id, nickname: p.nickname,
      last_preview: "", last_message_at: now, created_at: now,
      unread: 0, accepted: p.accepted !== false, muted: false, hidden: false, blocked: false,
    },
    { meId: props.meId, avatarOf: avatarUrlFor }
  );
  return synth ? list.concat([synth]) : list;
});

/* 轮 341：这条能不能撤回 —— 别人的、超 15 分钟的、在飞/失败的都不给菜单。
   （组件只认 senderId 的 onlyMe 过滤，时间窗得我们自己算。） */
const canRecallRow = (row) => !!row && !row.pending && !row.failed && canRecall(row, props.meId);
/* 轮 376：limit 不能固定 300 —— 上滑翻过 300 条后，loadMessages 已把更早页并进
 * props.messages，但 rowsToMessages 只取最近 300 条，新翻出来的页永远不会上屏。
 * 传当前行数（至少 300）才能把已加载的历史全部交给组件。 */
const mapMsgs = () => rowsToMessages(props.messages, {
  nameOf, meId: props.meId, canRecall: canRecallRow,
  limit: Math.max(300, props.messages.length),
});

/* roomId + messages 同一 tick 提交（见文件头 ②）。
   冷启动首开长会话时，IndexedDB/网络可能超过 600ms 才回来。旧版一到 600ms 就把新会话
   按空消息提交（loaded false→true），组件先亮一帧「还没有消息」，消息到了再填上——
   就是用户说的首开跳闪；第二次打开命中 dmStore 就同步有消息，所以不再出现。
   现在：**已知会话 + 还在加载 + 暂无消息**时立刻换房并保持 loader（loaded=false），
   等消息到场或父级 loadingMessages 落回 false 再收 loader。绝不提交空态。
   深链首帧 rooms 还没到才继续等（壳子没标题/输入区），600ms 兜底也带上加载态。 */
let commitSeq = 0;
const commit = (room, msgs, loading = false) => {
  const seq = ++commitSeq;
  curRoom.value = room;
  curMsgs.value = msgs;
  if (msgs.length) {
    /* 轮377：nextTick 前若已切到「空消息 + 还在加载」的新会话，旧回调不能把
     * loaded 提前置 true，否则新会话会先亮一帧空态。 */
    if (!loaded.value) nextTick(() => { if (seq === commitSeq) loaded.value = true; });
    return;
  }
  loaded.value = false;
  if (!loading) nextTick(() => { if (seq === commitSeq) loaded.value = true; });
};
let holdTimer = 0;
let heldRoom = "";
/* 轮 377：依赖里原来写的是不存在的 props.rooms（永远是 undefined），rooms 晚到时
 * watch 不会重跑，深链首开只能死等 600ms 兜底。这里只依赖「当前房间是否已出现在
 * rooms 里」这个布尔值：rooms 晚到会触发，但普通会话列表刷新不会每 15s 重映射全部消息。 */
const roomKnown = computed(() => {
  const cid = String(props.roomId || "");
  return !cid || rooms.value.some((r) => String(r.roomId) === cid);
});
watch(
  () => [props.roomId, props.messages, props.meId, props.peerName, props.loadingMessages, roomKnown.value],
  () => {
    const nextRoom = String(props.roomId || "");
    const nextMsgs = mapMsgs();
    /* 深链首帧：roomId 有了但 rooms 还没到 —— 组件在这个状态下会渲染出一个「没头没尾」
       的壳（无标题栏、无输入框，消息区被挤到底部），之后也不再自愈。等 rooms 里有这个会话
       （或用它的昵称）再提交。 */
    const known = roomKnown.value;
    if (!known && nextRoom !== curRoom.value) {
      heldRoom = nextRoom;
      clearTimeout(holdTimer);
      holdTimer = setTimeout(() => {
        if (heldRoom === nextRoom) commit(nextRoom, mapMsgs(), props.loadingMessages);
      }, 600);
      return;
    }
    clearTimeout(holdTimer);
    heldRoom = "";
    /* 已知会话、消息还没到：先换房开 loader，别把空态亮出来（首开长记录就在这条路上） */
    if (!nextMsgs.length && props.loadingMessages) {
      commit(nextRoom, nextMsgs, true);
      return;
    }
    commit(nextRoom, nextMsgs);
  },
  { immediate: true }
);

/* ── 轮 340 · 进会话一律落到底 ─────────────────────────────────────
 * 组件自己的滚动有两道门：`autoScroll.receive.newAfterScrollUp`（默认 false）——
 * 「最后一条是对方发的」时**不滚**；而且它走 setTimeout(50) + smooth。
 * 本地库秒开（消息随 roomId 同帧到场）时组件根本等不到 messages 变化，干脆不滚。
 * 实测 150 条 + 12× CPU 降速：甲（缓存/对方收尾）停在顶部，乙停在半截；
 * 等网络的丙/丁反而落底 —— 这就是「有时顶部、有时底部」。
 * 外壳这里补一道：换房 / 首屏消息到场 / loader 收尾 → 直接 scrollTop 到底（瞬移），
 * 再用 ResizeObserver + rAF 追 1.2s（父级定高、消息逐条挂上、字体头像都可能后面才定）；
 * 用户一往上滑（wheel / 手指下滑 / PageUp）立刻撤销，不把人从历史里拽回来。 */
let entryPin = false;
let needPin = true;
let userStopped = false;
let entryAt = 0;
let touchY = 0;
let ro = null;
let rafId = 0;
/* 轮 351 · 首帧别画在顶部 ────────────────────────────────────────────
 * 冷启动第一次进长会话：父级（shell--chat 的 .dm-thread）还没定高时，
 * 列表 clientHeight == scrollHeight（整段撑开），scrollTop 写不进去 ——
 * 这一帧画出来就是「最早的消息」，下一帧才跳到底（用户报的「第一次进去会跳闪」）。
 * 钉底成功之前先不画：visibility 不参与布局，量高照常；只藏本轮挂载的第一次。 */
let firstPinDone = false;
let gateTimer = 0;
const isPinned = (n) => {
  const ch = n.clientHeight;
  if (ch < 80 || ch > window.innerHeight + 2) return false;   /* 没挂上 / 还没被父级定高 */
  return n.scrollHeight - n.scrollTop - ch < 2;
};
const revealList = (n) => {
  firstPinDone = true;
  clearTimeout(gateTimer);
  gateTimer = 0;
  if (n.style.visibility === "hidden") n.style.visibility = "";
};
const listNode = () => {
  const n = el.value;
  const sr = n && n.shadowRoot;
  return sr ? sr.getElementById("messages-list") : null;
};
const clearPin = () => {
  entryPin = false;
  cancelAnimationFrame(rafId);
  rafId = 0;
  if (ro) { ro.disconnect(); ro = null; }
};
const pinOnce = () => {
  const n = listNode();
  if (!n) return;
  /* 组件的 scrollToBottom 会给容器挂 .vac-scroll-smooth（scroll-behavior:smooth），
     直接赋值 scrollTop 会变成 1s 的平滑动画（真机看着就是「点进去先停在顶部再往下溜」）。
     这里先摘掉类、再用内联 scroll-behavior:auto 强制瞬移 —— 旧版就是瞬移。 */
  n.classList.remove("vac-scroll-smooth");
  const prev = n.style.scrollBehavior;
  n.style.scrollBehavior = "auto";
  n.scrollTop = n.scrollHeight;
  n.style.scrollBehavior = prev;
  /* 轮 351：落到底之前不亮（见上面 firstPinDone 注释） */
  if (!firstPinDone) {
    if (isPinned(n)) revealList(n);
    else n.style.visibility = "hidden";
  }
};
/* 进房后追 1.2s：刚挂载时 .vac-container-scroll 可能还没被父级 flex 约束成可滚区
   （实测 scrollHeight=18342 时 scrollTop 写不进去，一直是 0），
   父级一旦定高 / 消息一条条挂上，ResizeObserver 立刻补一枪；
   rAF 循环兜住「布局同帧内变化、RO 下一帧才来」的那一帧。 */
const pinBottom = () => {
  /* 轮380：组件可能重建 #messages-list；只在 onMounted 绑一次的话，新节点上的
     「上滑就停止自动贴底」会失效。每次贴底顺手补绑（__wpPinBound 防重复）。 */
  bindScrollIntent();
  entryPin = true;
  pinOnce();
  nextTick(pinOnce);
  requestAnimationFrame(() => requestAnimationFrame(pinOnce));
  /* 轮 351：兜底 —— 面板若因异常一直没定高，也别把消息区永久藏住（正常一帧内就亮） */
  if (!firstPinDone && !gateTimer) {
    gateTimer = setTimeout(() => {
      gateTimer = 0;
      if (firstPinDone) return;
      const m = listNode();
      if (m) revealList(m);
    }, 900);
  }
  const n = listNode();
  if (n && !ro && typeof ResizeObserver !== "undefined") {
    ro = new ResizeObserver(() => { if (entryPin) pinOnce(); });
    ro.observe(n);
    const inner = n.querySelector(".vac-messages-container");
    if (inner) ro.observe(inner);
  }
  const t0 = performance.now();
  cancelAnimationFrame(rafId);
  const tick = () => {
    if (!entryPin) return;
    pinOnce();
    if (performance.now() - t0 < 1200) rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
};
const stopPin = () => { needPin = false; userStopped = true; clearPin(); };
const bindScrollIntent = () => {
  const n = listNode();
  if (!n || n.__wpPinBound) return;
  n.__wpPinBound = true;
  n.addEventListener("wheel", (e) => { if (e.deltaY < 0) stopPin(); }, { passive: true });
  n.addEventListener("mousedown", stopPin);
  n.addEventListener("touchstart", (e) => { touchY = e.touches[0] ? e.touches[0].clientY : 0; }, { passive: true });
  n.addEventListener("touchmove", (e) => {
    const y = e.touches[0] ? e.touches[0].clientY : touchY;
    if (y > touchY + 4) stopPin();   /* 手指下滑 = 想看更早的 */
  }, { passive: true });
  n.addEventListener("keydown", (e) => {
    if (e.key === "PageUp" || e.key === "Home" || e.key === "ArrowUp") stopPin();
  });
};
watch(curRoom, (r, old) => {
  if (r === old) return;
  /* 轮 376：首帧隐藏门控要按「每个会话」重新开，不是按组件挂载只开一次。
   * 旧版 firstPinDone 第一次钉底后永久为 true，切到第二个会话时不再隐藏，
   * 新会话若先画在顶部就会露一帧再跳到底。切房同时清掉上一房的 gateTimer / 追帧。 */
  firstPinDone = false;
  clearTimeout(gateTimer);
  gateTimer = 0;
  clearPin();
  needPin = true;
  userStopped = false;
  entryAt = Date.now();
});
watch([curRoom, curMsgs], ([room, msgs]) => {
  if (!room) { needPin = false; return; }
  if (needPin && msgs.length) { needPin = false; pinBottom(); }
}, { immediate: true });
/* loader 收尾（首屏 / 换房后 loaded 由 false→true）再补一枪：这之前消息区还压着透明层 */
watch(loaded, (v) => {
  if (v && !userStopped && Date.now() - entryAt < 2500) pinBottom();
});

const TEXT = {
  SEARCH: "搜索",
  ROOMS_EMPTY: "还没有会话",
  ROOM_EMPTY: "选择一个会话开始聊天",
  MESSAGES_EMPTY: "还没有消息，说点什么吧。",
  CONVERSATION_STARTED: "",
  TYPE_MESSAGE: "输入消息…",
  IS_TYPING: "正在输入…",
  IS_ONLINE: "在线",
  LAST_SEEN: "最后上线",
  NEW_MESSAGES: "新消息",
  MESSAGE_DELETED: "消息已撤回",
  CANCEL_SELECT_MESSAGE: "取消",
};
/* 输入框占位跟着旧页面走（桌面那句带「Enter 发送 · Shift+Enter 换行」） */
const texts = computed(() => (props.placeholder
  ? { ...TEXT, TYPE_MESSAGE: props.placeholder }
  : TEXT));

/* 消息菜单：只留撤回（组件内置的回复/编辑/多选我们都没有对应后端）。
   onlyMe = 别人的消息永远不出这条菜单（组件会按 senderId 过滤掉）。 */
const actions = computed(() => [{ name: "recall", title: t("dm.recall"), onlyMe: true }]);

/* 会话菜单 = 旧聊天头「…」那一份（看主页 / 免打扰 / 拉黑），标题随状态变 */
const curConv = computed(() => {
  const id = String(props.roomId || "");
  const row = (props.convs || []).find((c) => String(c.conv_id) === id);
  if (row) return row;
  const p = props.peer || {};
  return { conv_id: id, other_id: p.other_id, nickname: p.nickname, muted: !!p.muted, blocked: !!p.blocked };
});
const menuActions = computed(() => {
  const c = curConv.value || {};
  const list = [];
  if (c.other_id) list.push({ name: "profile", title: t("dm.viewHome") });
  list.push({ name: "mute", title: c.muted ? t("dm.unmute") : t("dm.mute") });
  list.push({ name: "block", title: c.blocked ? t("dm.unblock") : t("dm.block") });
  return list;
});


const STYLES = {
  general: {
    color: "var(--ink, #141413)",
    colorButton: "#ffffff",
    backgroundColorButton: "var(--accent, #cc785c)",
    colorButtonClear: "var(--accent, #cc785c)",
    backgroundInput: "var(--wash-strong, #fffdf9)",
    colorPlaceholder: "var(--ink-faint, #8e8b82)",
    colorCaret: "var(--accent, #cc785c)",
    colorSpinner: "var(--accent-deep, #a9583e)",
    borderStyle: "1px solid var(--hairline, #e6dfd8)",
    backgroundScrollIcon: "var(--wash-strong, #fffdf9)",
  },
  container: { border: "none", borderRadius: "0px", boxShadow: "none" },
  header: {
    /* 旧版聊天头是普通一条（虚线下方就是消息区），不是悬浮在消息上 */
    position: "static",
    width: "100%",
    background: "transparent",
    colorRoomName: "var(--ink, #141413)",
    colorRoomInfo: "var(--ink-faint, #8e8b82)",
  },
  footer: {
    /* 轮 419：透明 —— 让皮肤那层玻璃画布透上来。
     * 原来是 var(--page-bg)（不透明米色），把 .dm-thread 的 0.9 白玻璃整块盖死。
     * 输入框自己有 backgroundInput（--wash-strong）实底，透明不影响可读性。 */
    background: "transparent",
    borderStyleInput: "1px solid var(--hairline, #e6dfd8)",
    borderInputSelected: "var(--accent, #cc785c)",
    backgroundReply: "var(--accent-soft, #f5f0e8)",
    backgroundTag: "var(--accent-soft, #f5f0e8)",
    backgroundTagActive: "var(--card, #efe9de)",
  },
  /* 轮 419：消息区也是透明。
   * 病根就在这一行：`.vac-container-scroll` 拿它当 background，等于在玻璃卡上又刷了一层
   * 不透明米色。表现是「第一次进会话有玻璃、后面没有」——
   * 因为首次进来消息还在加载，渲染的是加载态（.vac-box-empty，本身无底色）→ 看得到玻璃；
   * 消息一到/第二次有缓存 → 米色铺满 → 玻璃再也看不见。 */
  content: { background: "transparent" },
  sidemenu: {
    background: "var(--page-bg, #faf9f5)",
    backgroundHover: "var(--accent-soft, #f5f0e8)",
    backgroundActive: "var(--card, #efe9de)",
    colorActive: "var(--accent-deep, #a9583e)",
    borderColorSearch: "var(--hairline, #e6dfd8)",
  },
  dropdown: { background: "var(--wash-strong, #fffdf9)", backgroundHover: "var(--accent-soft, #f5f0e8)" },
  message: {
    background: "var(--card, #efe9de)",
    backgroundMe: "var(--accent-soft, #f5f0e8)",
    color: "var(--ink, #141413)",
    colorStarted: "var(--ink-faint, #8e8b82)",
    colorUsername: "var(--ink-soft, #6c6a64)",
    colorTimestamp: "var(--ink-faint, #8e8b82)",
    backgroundDate: "var(--card, #efe9de)",
    colorDate: "var(--ink-soft, #6c6a64)",
    backgroundSystem: "var(--accent-soft, #f5f0e8)",
    colorSystem: "var(--ink-soft, #6c6a64)",
    backgroundDeleted: "var(--card, #efe9de)",
    colorDeleted: "var(--ink-faint, #8e8b82)",
    backgroundSelected: "var(--accent-soft, #f5f0e8)",
    backgroundReply: "rgba(20, 20, 19, 0.06)",
    colorReplyUsername: "var(--ink, #141413)",
    colorReply: "var(--ink-soft, #6c6a64)",
    colorNewMessages: "var(--accent, #cc785c)",
    backgroundScrollCounter: "var(--ink, #141413)",
    colorScrollCounter: "#ffffff",
    backgroundReaction: "var(--wash-strong, #fffdf9)",
    borderStyleReaction: "1px solid var(--hairline, #e6dfd8)",
    backgroundReactionHover: "var(--accent-soft, #f5f0e8)",
    borderStyleReactionHover: "1px solid var(--hairline, #e6dfd8)",
    colorReactionCounter: "var(--ink, #141413)",
    backgroundReactionMe: "var(--accent-soft, #f5f0e8)",
    borderStyleReactionMe: "1px solid var(--accent, #cc785c)",
    backgroundReactionHoverMe: "var(--accent-soft, #f5f0e8)",
    borderStyleReactionHoverMe: "1px solid var(--accent-deep, #a9583e)",
    colorReactionCounterMe: "var(--accent-deep, #a9583e)",
    backgroundAudioRecord: "#c64545",
    backgroundAudioLine: "rgba(20, 20, 19, 0.15)",
    backgroundAudioProgress: "var(--accent, #cc785c)",
    backgroundAudioProgressSelector: "var(--accent-deep, #a9583e)",
    colorFileExtension: "var(--ink-soft, #6c6a64)",
  },
  markdown: { background: "rgba(239, 233, 222, 0.7)", border: "rgba(230, 223, 216, 0.9)", color: "var(--accent, #cc785c)", colorMulti: "var(--ink, #141413)" },
  room: {
    colorUsername: "var(--ink, #141413)",
    colorMessage: "var(--ink-soft, #6c6a64)",
    colorTimestamp: "var(--ink-faint, #8e8b82)",
    colorStateOnline: "#5db872",
    colorStateOffline: "var(--ink-faint, #8e8b82)",
    backgroundCounterBadge: "var(--accent, #cc785c)",
    colorCounterBadge: "#ffffff",
  },
  emoji: { background: "var(--wash-strong, #fffdf9)" },
  icons: {
    search: "var(--ink-faint, #8e8b82)",
    add: "var(--accent, #cc785c)",
    toggle: "var(--ink, #141413)",
    menu: "var(--ink, #141413)",
    close: "var(--ink-faint, #8e8b82)",
    closeImage: "#ffffff",
    file: "var(--accent, #cc785c)",
    paperclip: "var(--accent, #cc785c)",
    closeOutline: "var(--ink, #141413)",
    closePreview: "#ffffff",
    send: "var(--accent, #cc785c)",
    sendDisabled: "var(--ink-faint, #8e8b82)",
    emoji: "var(--accent, #cc785c)",
    emojiReaction: "rgba(20, 20, 19, 0.3)",
    document: "var(--accent, #cc785c)",
    pencil: "var(--ink-faint, #8e8b82)",
    checkmark: "var(--ink-faint, #8e8b82)",
    checkmarkSeen: "var(--accent, #cc785c)",
    eye: "#ffffff",
    dropdownMessage: "#ffffff",
    dropdownMessageBackground: "rgba(20, 20, 19, 0.25)",
    dropdownRoom: "var(--ink-faint, #8e8b82)",
    dropdownScroll: "var(--ink, #141413)",
    microphone: "var(--accent, #cc785c)",
    audioPlay: "var(--ink, #141413)",
    audioPause: "var(--ink, #141413)",
    audioCancel: "#c64545",
    audioConfirm: "#5db872",
  },
};

/* ── 皮肤：轮 334「全用组件，但设计照旧版」；轮 335 起输入区连皮肤也不改
   头部 / 消息流 / 输入区**都是组件画的**（不再用旧页面那套 DOM）。
   这里只管头部的虚线 + 40px 头像、气泡/时间/日期/头像这些旧版细节；
   输入区（textarea / 发送键 / 占位 / 键盘保持）原样是组件的——见下面第 7 段。 */
const THEME_CSS = `
/* 1) 布局：头部在文档流里（组件默认定位于消息区上方，靠 margin-top:65px 让位） */
.vac-container-scroll { margin-top: 0 !important; }
.vac-messages-container { padding: 12px 2px 0 !important; }
.vac-message-wrapper .vac-message-container { position: relative; padding: 2px 2px 16px; min-width: 0 !important; }
/* 组件自带的「新消息」「回底气泡」旧版都没有 */
.vac-line-new, .vac-icon-scroll { display: none !important; }
/* 「会话开始于 X」= 旧版顶部那颗日期胶囊（文案里那句「会话开始于」在 TEXT 里置空） */
.vac-col-messages .vac-text-started {
  width: fit-content; margin: 2px auto 10px !important;
  background: var(--wash-mid, #f1ece2) !important; color: var(--ink-soft, #6c6a64) !important;
  border-radius: 999px; padding: 3px 12px;
  font-size: 11px !important; font-weight: 500;
}

/* 2) 头部 = 旧 .dm-thread-head：40px 头像、15px 昵称、右侧 ⋯
   轮 349：用户「不要虚线」——去掉头部下面那条虚线分隔（页面底色本身连成一片）。 */
.vac-room-header {
  height: 60px !important;
  background: transparent !important;
  border-bottom: 0 !important;
}
.vac-room-header .vac-room-wrapper { padding: 0 !important; }
.vac-room-header .vac-avatar {
  height: 40px; width: 40px; min-height: 40px; min-width: 40px; margin-right: 10px;
}
.vac-room-header .vac-room-name { font-size: 15px; font-weight: 600; }
/* 旧版头部只有昵称，没有「在线 / 最后上线」那行（我们本来也没有 presence） */
.vac-room-header .vac-room-info { display: none !important; }
.vac-room-header .vac-room-options { margin-left: auto; }
.vac-room-header .vac-room-options svg { height: 22px; width: 22px; }
/* 手机聊天页：旧版头部是「← 昵称」，没有头像和 ⋯（⋯ 在桌面那一列才出） */
@media (max-width: 899px) {
  .vac-room-header .vac-avatar { display: none !important; }
  .vac-room-header .vac-room-options { display: none !important; }
}
/* 注入的返回键（旧 .dm-thread-back：半透明圆底上的 ←） */
.dm-vac-back {
  flex: none; width: 34px; height: 34px; margin-right: 8px;
  display: inline-flex; align-items: center; justify-content: center;
  border: 0; border-radius: 50%; cursor: pointer;
  background: rgba(20, 20, 19, .05); color: var(--ink-soft, #6c6a64);
  font-size: 17px; line-height: 1;
}
.dm-vac-back:active { transform: scale(.92); }
@media (min-width: 900px) { .dm-vac-back { display: none !important; } }

/* 3) 日期 = 旧 .dm-day 的 11px 灰字
   轮 349：用户「不要日期的白色背景」——两条日期（顶部「10月24日」+ 消息中间的「今天」）
   都去掉胶囊底色，只留字；字体/位置照旧。 */
.vac-col-messages .vac-text-started,
.vac-message-wrapper .vac-card-info.vac-card-date,
.vac-messages-container .vac-card-info.vac-card-date,
.vac-card-info.vac-card-date {
  background: transparent !important;
  box-shadow: none !important;
  color: var(--ink-soft, #6c6a64) !important;
  font-size: 11px;
}
.vac-message-wrapper .vac-card-info.vac-card-date {
  border-radius: 999px;
  font-weight: 500; padding: 3px 12px; margin: 6px auto;
}

/* 4) 气泡 = 旧 .dm-bubble：卡片底 + 发丝边，16/16/16/4 */
.vac-message-wrapper .vac-message-card {
  border-radius: 16px 16px 16px 4px;
  border: 1px solid var(--hairline, #e6dfd8);
  background: var(--card, #efe9de);
  padding: 9px 13px;
  font-size: 13.5px; line-height: 1.5;
  box-shadow: none;
}
.vac-message-wrapper .vac-message-card .markdown p { margin: 0; }
/* 组件给 .vac-message-current 的底色是 !important 的，这里必须同权重压过去 */
.vac-message-wrapper .vac-message-card.vac-message-current:not(.vac-message-deleted) {
  background-color: var(--accent, #cc785c) !important;
  border-color: transparent;
  border-radius: 16px 16px 4px 16px;
}
.vac-message-wrapper .vac-message-card.vac-message-current:not(.vac-message-deleted),
.vac-message-wrapper .vac-message-card.vac-message-current:not(.vac-message-deleted) .vac-text,
.vac-message-wrapper .vac-message-card.vac-message-current:not(.vac-message-deleted) .vac-text * {
  color: #fff !important;
}

/* 5) 时间 = 旧 .dm-stamp：10.5px 灰字、**气泡下面**（组件默认在气泡里右下角） */
.vac-message-wrapper .vac-text-timestamp {
  position: absolute; left: 2px; bottom: 0;
  font-size: 10.5px; color: var(--ink-soft, #6c6a64) !important;
  text-align: left;
}
.vac-message-wrapper .vac-message-box.vac-offset-current .vac-text-timestamp {
  left: auto; right: 2px; text-align: right;
}
/* 旧版没有「已读双勾」 */
.vac-message-wrapper .vac-text-timestamp svg { display: none !important; }

/* 6) 头像 30px（旧 .dm-msg-avatar），组件的 42px 会把行撑高 */
.vac-message-wrapper .vac-avatar { height: 30px; width: 30px; min-height: 30px; min-width: 30px; margin: 0 8px 2px 0; }
.vac-message-wrapper .vac-avatar-current-offset { margin-right: 30px; }

/* 6b) 气泡最宽 74%（旧 .dm-msg-col 的 min(74%, 460px)）；组件默认 50% */
.vac-message-wrapper .vac-message-box { flex: 0 0 74%; max-width: 74%; }
.vac-message-wrapper .vac-message-box.vac-offset-current { flex: 0 0 74%; max-width: 74%; margin-left: 26%; }

/* 7) 输入区：**不画**。轮 335 用户拍板「键盘/输入区也用组件的」——
    输入框、纸飞机发送键、发送后保持键盘（keepKeyboardOpen / preventKeyboardFromClosing）
    全是组件自己的；这里只剩两条「颜色」：
      · 手机的 placeholder 组件默认设成 transparent（怕 iOS 聚焦缩放），旧版是显示的，
        只把颜色改回来，尺寸/边框/圆角一律不动；
      · 手机聊天页左右 14px 的留白（旧 .dm-thread 的边），补在头/消息流上。 */
@media (max-width: 899px) {
  .vac-textarea::placeholder { color: var(--ink-faint, #8e8b82) !important; }
  .vac-room-header .vac-room-wrapper { padding: 0 14px !important; }
  .vac-messages-container { padding-left: 14px !important; padding-right: 14px !important; }
}
/* 失败提示（旧版是「发送失败」红字，组件是红色感叹号） */
.vac-message-wrapper .vac-failure-container { align-self: flex-end; }

/* 8) 表情面板：组件自带 emoji-picker-element，这里只把它自己的 CSS 变量
   （emoji-picker 的 shadow DOM 从宿主继承）调成暖爪的米色/珊瑚色。
   表情按钮本身在 .vac-icon-textarea-left，颜色走 styles.icons.emoji。 */
/* 轮 400 · 微信式表情/键盘键：面板打开时按钮从笑脸切成键盘图标。
   图标由脚本塞进 .vac-svg-button（组件重画后会补），显示哪一枚由宿主类决定，
   所以不跟组件内部的 emojiOpened 状态抢 class。 */
#room-footer .vac-emoji-wrapper .vac-svg-button .wp-vac-emoji-swap {
  display: block; width: 24px; height: 24px; margin: 0 7px;
  color: var(--chat-icon-color-emoji, var(--accent, #cc785c));
}
#room-footer .vac-emoji-wrapper .vac-svg-button .wp-vac-emoji-swap svg {
  display: block; width: 24px; height: 24px; margin: 0 !important;
}
#room-footer .vac-emoji-wrapper .vac-svg-button .wp-vac-emoji-swap .wp-vac-kb { display: none; }
:host(.wp-emoji-open) #room-footer .vac-emoji-wrapper .vac-svg-button .wp-vac-emoji-swap .wp-vac-emoji { display: none; }
:host(.wp-emoji-open) #room-footer .vac-emoji-wrapper .vac-svg-button .wp-vac-emoji-swap .wp-vac-kb { display: block; }
@media only screen and (max-width: 768px) {
  #room-footer .vac-emoji-wrapper .vac-svg-button .wp-vac-emoji-swap { margin: 0 5px; }
}
.vac-emojis-container { background: transparent !important; }
emoji-picker {
  --background: var(--wash-strong, #fffdf9);
  --border-color: var(--hairline, #e6dfd8);
  --indicator-color: var(--accent, #cc785c);
  --input-border-color: var(--hairline, #e6dfd8);
  --outline-color: var(--accent, #cc785c);
  --category-emoji-size: 1.25rem;
}

/* 轮 353 · 发送失败原因（旧版 .dm-err 那行红字）
   注入到 #room-footer 最前面（脚本 syncErr），位置=输入条上方，和旧版一致。
   陌生人首聊 3 条上限（first-limit）/ 网络 / 撤回失败 都走这一行。 */
.vac-room-footer > .wp-dm-err {
  margin: 0 14px;
  padding-top: 8px;
  font-size: 12.5px;
  line-height: 1.4;
  text-align: center;
  color: #d9534f;
  overflow-wrap: anywhere;
}

/* 9) 轮 347 · 手机表情面板 = 贴底整宽（微信式），输入条落在面板上沿。
   面板高用 --wp-emoji-h（≈键盘高），footer 的 padding-bottom 同步撑到同高。

   轮 503 · 面板从「fixed 到布局视口底」改成「absolute 到 footer 的 padding 区」。
   病根（用户四张 iPhone 截图）：footer 的位置由 .dm-page 这个**页面盒子**决定，
   面板却锚在**布局视口**底 —— 两个参照系。iOS Safari 的底部工具栏浮在页面之上时，
   面板最后一排正好被它吃掉；键盘把可视视口顶开、页面跟着上移时更离谱：
   fixed 的面板留在原地，输入条和面板当场分家。
   改完只剩一个参照系：padding 有多高，面板就有多高，输入条必然压在面板上沿；
   页面盒子本身在可视区内，safe-area 也不用再单独让。 */
:host { --wp-emoji-h: var(--kb-panel-h, min(46vh, 320px)); }
/* 轮 524 · 盒子底该在哪 —— **不读 --chat-h**。
 *
 * chatViewport 写的 --chat-h 是「上一帧量到的盒子高」，键盘升起的头 ~65ms 里它还停在
 * 744，而 inner 已经 539 了。让位算式里 chat-h − vlh 于是多出 +205，
 * 输入行被算到屏幕上半部（真机冷启动逐帧：padB 327 → 532 → 382 → 327，条上下抽三下）。
 *
 * 这里用同一件事的**无滞后写法**：盒子高 = min(视口高, 键盘态盒子高)。
 * 键盘态盒子高（--kb-pageh）是锁死的常量，没量到之前退回视口高 —— 与 chatViewport
 * 的钉法逐像素一致，但它俩不需要等一帧才对齐。 */
:host { --chat-box: min(var(--vlh, 0px), var(--kb-pageh, var(--vlh, 0px))); }
/* 轮 521 · 面板的高度**不是固定值，而是「盒子底到视口底」那一段**。
 *
 * 用户原话：「别的软件都是键盘跟表情固定一个高度」「以键盘高度为准是做不到吗」。
 * 之前的错在于把「面板高」当成一个独立常量（= 键盘高 260），而页面盒子在两种状态下
 * 高度不同（键盘态 484 / 面板态 539，差的就是浏览器工具栏那条 55px）——
 * 两个各自正确的常量凑在一起，结果是输入条每切一次摆 55px。
 *
 * 现在反过来：页面盒子在面板态由 chatViewport 钉成键盘态的高度（--kb-pageh），
 * 面板高度取「视口底 − 盒子底」，两者永远严丝合缝，输入条一动不动。
 * 面板因此会随着工具栏在不在而 260 / 315 变一次 —— 但那是**面板去适应键盘占地**，
 * 不是输入条跟着跳；用户看到的是「键盘那块地方换成了表情」。
 * --kb-panel-h 也要一起给：vendored 库的面板 height 读的就是它。 */
:host(.wp-emoji-open) {
  /* 轮 524 · 面板高 = **锁定的键盘高**，一个常量，不再按「视口底 − 盒子底」算。
   *
   * 轮 521 那条 max(0, vlh − chat-h) 有两个真机抓到的坑（用户：「键盘-表情-键盘
   * 切换 第一次点键盘没反应，还有高度不一致」）：
   *   ① 冷启动（还没弹过键盘，--kb-pageh 为空）时盒子没被钉住，chat-h = vlh = 744
   *      ⇒ 面板高 = **0**，面板只有 1px —— 点了表情等于没反应；
   *   ② 键盘收起那一瞬浏览器底部工具栏会临时收起，vlh 从 744 跳到 799 再回来，
   *      而 chat-h 钉在 484 ⇒ 面板高 315 → 260 抖一截，最后一排表情被切掉。
   * 键盘高本来就是常量，面板就该是同一个常量：直接用 --kb-panel-h（= min(--kb-panel,420)，
   * 冷启动由 viewportVars 从 localStorage 恢复上次量到的真值，没记录才退 320 兜底）。
   * 面板「铺满到视口底」这件事交给底下的 bottom 算，不再靠改高度去凑。 */
  --wp-emoji-h: var(--kb-panel-h);
}
@media (max-width: 899px) {
  /* 轮 503：padding 必须落在 .vac-box-footer 而不是外层 .vac-room-footer —— 内层才是
     position:relative 的那一个（= 面板的定位宿主），padding 加在外层面板根本不动，
     会锚在「输入条下沿」往上长，反而盖住聊天记录。
     轮 350：原先是「过渡常驻在 footer 上 —— 面板→键盘交接时 padding 和 .dm-page 的
     height 同曲线同时长（.22s）各走 --wp-emoji-h，输入框原地不动」。
     轮 512：这条过渡在**打开面板**时反而制造闪烁 —— 面板是瞬现的（组件直接插节点），
     让位却慢 .22s，输入条会先被面板盖住、再从屏底爬上来（工装实测：面板 20ms 到位，
     padding 要 120ms 才涨满，中间 100ms 条被压住）。
     关面板那一侧由 :host(.wp-kb-swap) 钉住（下面那条 transition: none），
     所以这里不再需要常驻过渡：瞬时到位才不会露馅。 */
  /* 轮 514：wrapper 的 position 已由 vendored 库改成 static（见
     vendor/vue-advanced-chat/PATCHES.md 改动 1）—— 这里不再需要 :has() 去猜它。
     原文：库给 .vac-emoji-wrapper 自带 position:relative，absolute 会锚在那个
     按钮大的小盒子上（面板飘成一条竖线就是它）。 */
  /* 轮 520 · 让位 = 面板高 − 「键盘当前还占多高」+ 「视口过冲量」。
   *
   * 老式子 max(0, 面板高 − --vtop) 只在 overlay 型（iOS：布局视口不缩）上成立。
   * 在 resize 型（安卓/小米：innerHeight 自己缩）上 --vtop 恒为 0 ⇒ 让位整份 260
   * 跟键盘自身的收缩叠了两次。真机逐帧（_scratch/real/v520-vac.json）：
   *   点表情：输入条 433 → 180（−253px，窜到屏幕上半部）→ 495（+315px）→ 440
   *   点键盘：输入条 440 → 693（+253px）→ 488 → 433
   * 一次切换跳三下。用户说的「会话框表情/键盘切换也有问题」就是这个。
   *
   * 改用 --kb-now（键盘此刻实际占了多高，viewportVars 每帧写）：
   *   键盘全开  kb-now = 面板高 ⇒ padding 0，条在视口底 = 键盘上沿
   *   键盘全收  kb-now = 0      ⇒ padding 满，条仍在同一处
   *   动画中途  两者线性互补     ⇒ 条原地不动
   *
   * 三项修正，缺一项就分家：
   *   ① --kbb：面板是 fixed 贴**可视视口**底（库的 bottom:var(--kbb)），而输入条在
   *      页面盒子底。两者差着浏览器工具栏那 31px —— 真机逐帧里面板顶 477、条底 508，
   *      面板直接把输入条盖住一条。让位必须补上同一个 kbb。
   *   ② --kb-over：键盘收起时浏览器底部工具栏临时收一下，布局视口先报大 55px。
   *      面板与条一起抵掉，才不会跟着掉下去再弹回来。
   *   ③ --chat-h − --vlh：页面盒子是 chatViewport 写的内联像素高，靠 250ms 巡检更新，
   *      键盘动画期间会落后整整一拍（真机拍到 inner 已 799、盒子还停在 484 达 258ms）。
   *      让位是逐帧算的 —— 不补这一项，盒子还没长高条却先让位，条被算到屏幕上半部
   *      再弹回来（日志那条 ±315px）。盒子没动让位也不动，等它追上来再一起走。
   * --chat-h 未定义时退回 --vlh，修正项恒为 0。
   *
   * 与暖心墙那条吸底条同一套口径 —— 两页不再各推各的。 */
  :host(.wp-emoji-open) .vac-box-footer {
    padding-bottom: calc(7px + var(--wp-emoji-h));
    padding-bottom: calc(
      7px + var(--wp-emoji-h) + var(--kb-kbb, var(--kbb, 0px)) - var(--kb-now, 0px)
      + var(--chat-box, var(--vlh, 0px)) - var(--vlh, 0px) + var(--kb-over, 0px)
    );
  }
  /* 面板已收、键盘还没到：让位先钉住（同一个式子，只是关掉过渡别提前塌下去） */
  :host(.wp-kb-swap) .vac-box-footer {
    padding-bottom: calc(7px + var(--wp-emoji-h)) !important;
    padding-bottom: calc(
      7px + var(--wp-emoji-h) + var(--kb-kbb, var(--kbb, 0px)) - var(--kb-now, 0px)
      + var(--chat-box, var(--vlh, 0px)) - var(--vlh, 0px) + var(--kb-over, 0px)
    ) !important;
    transition: none !important;
  }
  /* 轮 526 · iOS（overlay 型）在交接给键盘的那一帧，让位只该是面板高。
   *
   * 上面那条是 resize 型的式子，里面的 chat-box 减 vlh 在 iOS 上恒 −330
   * （盒子钉在键盘态高度 522、布局视口还是 852），跟面板高正好抵消 ——
   * 工装实测交接那一帧让位从 337 塌到 88，输入行当场掉到屏幕 647。
   * iOS 上页面底本来就是键盘上沿，钉住 = 面板高，一个数都不加。 */
  /* 轮 533 · iOS 交接期不再「钉成面板高」，而是继续用同一条连续式子。
   *
   * 钉住的目的是「别提前塌下去」。旧式子 calc(面板高 − vtop) 只在首尾两端对，
   * 中间塌，所以必须钉一个常量把中间那段填平 —— 那是用不连续去补不连续。
   * 新式子本身就是连续的（见 PAD_EXPR_IOS 的推导），照常走就是一条直线，
   * 钉反而会造出一个台阶。这里保留 !important + 关过渡，只是为了让它在
   * .wp-emoji-open 摘掉、内联 padding 清空的那一帧仍然接得住。 */
  :host(.wp-kb-swap.ios-kb) .vac-box-footer {
    padding-bottom: calc(var(--ios-fw-pad, 10px) + var(--wp-emoji-h, 320px) - var(--vtop, 0px)
      - var(--kb-kbb, var(--kbb, 0px))) !important;
    transition: none !important;
  }
  /* 非 iOS 的 overlay 型内核（Firefox 安卓）保持轮 526 那条「钉成面板高」，
     与上面 iOS 那条分开写 —— iOS 换了连续式子，别的内核没换。 */
  :host(.wp-kb-swap.wp-kb-overlay:not(.ios-kb)) .vac-box-footer {
    padding-bottom: var(--wp-emoji-h, 320px) !important;
    transition: none !important;
  }
  /* 轮 533 · iOS：面板底贴的是**输入条的底**，不是可视区底。
   *
   * 库的媒体规则是 bottom:var(--kbb) + transform:translateY(var(--vtop))，
   * 语义是「面板底 = 可视区底」。在 iOS 上可视区底无键盘时是 771（底部工具栏上沿），
   * 于是面板占 441..771、输入行被顶到 441；而键盘态输入行在 505。
   * 同一个输入行每切一次跳 64px —— 用户说的「键盘跟表情不是一个高度」就是这一条。
   *
   * 把 --kbb 换成「页面盒子底 − 同一个基线」之后，面板顶正好压在输入行下沿
   * （505），两种状态同一个位置。
   *
   * 代价：面板最下面那 81px 落在底部工具栏后面（工具栏是覆盖层）。表情格子是
   * overflow-y:auto 的，滚一下就能看到；换来的是输入条彻底不再跳。
   *
   * 只在 .ios-kb 宿主上生效（那枚类由 isOverlayKb() 挂），安卓不受影响。 */
  :host(.ios-kb) { --ios-fw-pad: 17px; }
  :host(.ios-kb) .vac-emoji-wrapper .vac-emoji-picker:not(.vac-picker-reaction) {
    bottom: calc(var(--ios-fw-pad, 17px) - var(--kb-now, 0px)) !important;
  }
  /* 轮 514：几何全部交给 vendored 库（vendor/vue-advanced-chat 的 media 规则：
     position:fixed · left/right:0 · bottom:var(--kbb) · height:var(--kb-panel-h)）。
     以前这一大段 !important 是在跟库比优先级 —— 比不过就得内联钉，钉住又跟 --kbb
     打架（iOS 上面板沉到工具栏下面 81px 就是这么来的）。现在库自己就是对的，
     这里只留皮肤。 */
  /* 轮 520：选择器必须带 :not(.vac-picker-reaction) —— 库那条 media 规则就是这么写的，
     少一个伪类就少一分特异度，!important 也打不过它（改了半天以为是变量没值）。 */
  .vac-emoji-wrapper .vac-emoji-picker:not(.vac-picker-reaction) {
    /* 安全区不放在 picker 的 padding 上：库里的 emoji-picker 会撑满 padding box，
       手势条会压住最后一排。改成子元素矮一条 --sab，底部留白由面板背景补。 */
    padding: 0 !important;
    border-radius: 0 !important;
    border-top: 1px solid var(--hairline, #e6dfd8) !important;
    box-shadow: none !important;
    background: var(--wash-strong, #fffdf9) !important;
    overflow: hidden !important;
    /* 轮 520 · 面板自己也得扣掉「键盘此刻还占多高」。
     *
     * 库写的是 bottom:var(--kbb)，键盘还开着时那 260px 一点没扣 —— 真机逐帧
     * （_scratch/real/v520-vac.json t9892）拍到点表情那一瞬间面板顶冲到 217，
     * 也就是屏幕中部凭空冒出一块 260px 的面板，键盘还在下面顶着。这就是用户说的
     * 「一闪的东西」最直接的那一下。
     * 扣掉之后：键盘开着 ⇒ 面板整体沉到键盘后面（看不见，不打扰），
     * 键盘收起 ⇒ 它随 --kb-kbb/--kb-now 的比例平滑升上来，顶部始终等于输入条底。
     * 用 --kb-kbb 而不是 --kbb：那个是按键盘收起进度打过折的数（见 viewportVars），
     * 和输入条的让位算式吃的是同一个，两边永远不会分家。 */
    bottom: calc(var(--kb-kbb, var(--kbb, 0px)) - var(--kb-now, 0px)) !important;
    /* 轮 520b · 过渡必须关掉，否则上面那条 bottom 被库的 300ms 缓动吃掉。
     *
     * 库里面板是包在 Vue 的 transition（name=vac-slide-up）里的，
     * enter-active 那条规则是 transition: all .3s ease —— 连 bottom 一起缓动。
     * 【注意】这一段是模板字符串，注释里绝对不能出现反引号，否则提前闭合、
     * 剩下半行被当成 JS 表达式（「main is not defined」整页崩就是这么来的）。
     * 真机逐帧（_scratch/real/pk.json）：键盘收起后 --kb-now 已经 0，
     * 面板的 bottom 却还在 -260 → -20.4 → -13.7 → 0 里爬，比键盘晚整整 300ms。
     * 那 300ms 里输入条已经贴到页面底，面板还在屏幕外面 —— 底部空一条 260px 的带子，
     * 然后面板才"啪"地升上来。这就是「切换时有一闪」剩下的那一半。
     *
     * 关掉之后面板位置=纯函数(--kb-now)，键盘收多少它就升多少，逐帧跟着；
     * 不再有第二条时间线跟它赛跑。（面板本来就是瞬现的，库并没有位移动画要保留。） */
    transition: none !important;
    /* 轮 520c · 页面盒子还没跟上 innerHeight 的那一两帧，让位算式会被 CSS 截成 0
     * （padding 不能为负），输入条就停在「旧页面底」，而面板已经贴到「新视口底」——
     * 两者最多差出浏览器工具栏那一条。真机逐帧 _scratch/real/v520-vac.json：
     *   t10101  inner 已 799、页面盒子还是 484 → 条内容底 484、面板顶 539，裂开 55px
     * 这条裂口不能靠让位补（负数补不了），只能让面板跟着「截断后的实际让位」走：
     * 把同一个截断写进面板位置 —— 取两根式子里大的那根，正好在截断开始那一帧换分支。
     *   · 未截断：kb-kbb 减 kb-now（面板贴着条，随键盘一起走）
     *   · 已截断：vlh 减 chat-h 再减面板高（面板退回旧页面底，跟着条一起等盒子）
     * max() 写在第二条、旧式子留第一条 —— 不认 max() 的老内核整条无效、退回前者。 */
    bottom: max(
      calc(var(--kb-kbb, var(--kbb, 0px)) - var(--kb-now, 0px)),
      calc(var(--vlh, 0px) - var(--chat-box, var(--vlh, 0px)) - var(--wp-emoji-h, 320px))
    ) !important;
  }
  .vac-emoji-wrapper .vac-emoji-picker emoji-picker {
    width: 100% !important;
    height: calc(100% - var(--sab, env(safe-area-inset-bottom, 0px))) !important;
    --emoji-size: 1.35rem;
    --emoji-padding: .35rem;
  }
  /* 轮 521 · 打开瞬间的骨架（配方照抄 WpComposer 的 .wp-picker-skel）。
   *
   * 真机逐帧：格子是 17 → 179 → 187 长起来的，中间空 0.6 秒。面板位置第一帧就对，
   * 里面却是白的 —— 用户看到的就是「点了没反应」。
   * 8 列 × 34px 行高，跟真实网格同一套尺寸，真格子接上时不会跳。
   * 注意这一段在模板字符串里，注释中不许出现反引号。 */
  .wp-picker-skel {
    position: absolute;
    inset: 0;
    z-index: 3;
    display: grid;
    grid-template-columns: repeat(8, 1fr);
    grid-auto-rows: 34px;
    gap: 4px;
    padding: 10px 8px;
    background: var(--wash-strong, #fffdf9);
    pointer-events: none;
  }
  .wp-picker-skel i {
    border-radius: 8px;
    background: var(--hairline, #e6dfd8);
    opacity: .45;
    animation: wp-skel-pulse 1.1s ease-in-out infinite;
  }
  .wp-picker-skel i:nth-child(8n+2) { animation-delay: .08s; }
  .wp-picker-skel i:nth-child(8n+3) { animation-delay: .16s; }
  .wp-picker-skel i:nth-child(8n+4) { animation-delay: .24s; }
  .wp-picker-skel i:nth-child(8n+5) { animation-delay: .32s; }
  .wp-picker-skel i:nth-child(8n+6) { animation-delay: .4s; }
  @keyframes wp-skel-pulse {
    0%, 100% { opacity: .32; }
    50% { opacity: .62; }
  }
  @media (prefers-reduced-motion: reduce) {
    .wp-picker-skel i { animation: none; opacity: .45; }
  }
}
`;


/* 轮 347 · 手机表情面板贴底（微信式）
 * ------------------------------------------------------------
 * 组件自带的面板是 300px 浮窗（position:absolute; bottom:32px），在手机上会飘在
 * 聊天记录中间 —— 用户实报「哪个 app 这样放，微信都是跟输入法的键盘一起」。
 * 这里只做三件事，不碰组件内部逻辑：
 *   ① 面板出现/消失时给宿主挂 .wp-emoji-open（MutationObserver，点外面 / 发送 /
 *      切换会话这些「组件自己把 emojiOpened 置 false」的路径也能收干净）；
 *   ② 面板一出现就 blur 输入框 → 系统键盘收起，屏底让给面板；
 *   ③ 样式在 THEME_CSS 里改成 fixed 贴底、整宽、高 = --wp-emoji-h，
 *      同时把 footer 的 padding-bottom 撑到同高 → 输入条正好落在面板上沿。 */
let emojiMO = null;
let emojiWasOpen = false;
/* 轮 400 · 表情键的两种图标。组件原来的 SvgIcon 只有笑脸，面板开着时再点它
 * 只会把面板收掉、不还焦点，用户看到的就是「再点一下整个输入区塌回屏底」。
 * 这里把按钮内容换成「笑脸 + 键盘」两枚静态 SVG，显示哪一枚交给宿主类
 * .wp-emoji-open（见 THEME_CSS），点按钮的交接逻辑在 bindFooterTap 里。 */
const EMOJI_SWAP_HTML = `
<span class="wp-vac-emoji-swap" aria-hidden="true">
  <svg class="wp-vac-emoji" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" focusable="false">
    <circle cx="12" cy="12" r="8.4"></circle>
    <circle cx="9.3" cy="10" r=".7" fill="currentColor" stroke="none"></circle>
    <circle cx="14.7" cy="10" r=".7" fill="currentColor" stroke="none"></circle>
    <path d="M8.6 14.2c.9 1.3 2 2 3.4 2s2.5-.7 3.4-2"></path>
  </svg>
  <svg class="wp-vac-kb" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" focusable="false">
    <rect x="2.6" y="6.2" width="18.8" height="11.6" rx="2.2"></rect>
    <path d="M6 9.6h.01M9 9.6h.01M12 9.6h.01M15 9.6h.01M18 9.6h.01
             M6 12.4h.01M9 12.4h.01M12 12.4h.01M15 12.4h.01M18 12.4h.01
             M8 15.4h8"></path>
  </svg>
</span>`;
const syncEmojiIcon = (open) => {
  const sr = el.value && el.value.shadowRoot;
  const btn = sr && sr.querySelector("#room-footer .vac-emoji-wrapper .vac-svg-button");
  if (!btn) return;
  /* 组件重画按钮时会把我们的子节点抹掉，补回来即可；已有就绝不再动，
     避免 MutationObserver 自己触发死循环。 */
  if (!btn.querySelector(".wp-vac-emoji-swap")) btn.innerHTML = EMOJI_SWAP_HTML;
  btn.setAttribute("data-wp-emoji-key", open ? "keyboard" : "emoji");
};

/* 轮 498 · 面板让位改成「量出来的」内联让位（用户第四次报「表情开着，输入条不见了」）。
 * 旧做法只有两条命：① .vac-room-footer:has(.vac-emoji-picker) ② :host(.wp-emoji-open)。
 * ① 在 Chromium <105 和多数国产 WebView（X5/系统浏览器）里整套不认；② 依赖
 *   MutationObserver 挂上了没有 —— bind() 若跑在 shadowRoot 建好之前就直接 return，
 *   那个观察者从此再也挂不上，宿主永远没有 wp-emoji-open（本轮已改成退避重试）。
 * 两条同时失效时 footer 的 padding-bottom 归零，面板正好把输入条整条盖住：
 *   Edge/Chrome 上两条都通，所以前几轮在本机怎么测都是好的，用户机器上是空的。
 * 现在不看选择器、也不看变量：面板一出现就量它实际占掉多少（自身高度 + 底下到屏底的缝），
 * 直接写 footer 的内联 padding-bottom（内联压过一切规则），收起时清掉回落给 CSS。
 * 顺带兜住「面板比键盘矮一截」的机型：条永远落在面板上沿，差多少补多少。 */
/* 轮 520 · 让位只写一条表达式，不再量面板几何。
 *
 * 旧实现是「面板 DOM 出现后量它的 rect，写内联 padding」，还要 260ms 定时器补量一次、
 * 再挂 ResizeObserver 跟着面板换高矮重量。三个采样点全在赌时机；而且量出来的是
 * 面板自己有多高，跟「键盘此刻还占多高」是两件事 —— 安卓 resize 型内核上这两件事
 * 会同时发生，让位就被算了两次（逐帧数据见 THEME_CSS 那条规则上方的说明）。
 *
 * 现在式子里的每个量都由 viewportVars 每帧算好：面板高锁一次（--wp-emoji-h），
 * 键盘当前占高（--kb-now）与过冲量（--kb-over）逐帧更新。这里只负责把表达式挂上，
 * 浏览器自己会在每一帧重算 —— 一个采样点都不剩。 */
let emojiPadOn = false;
const sheetMode = () => typeof window !== "undefined"
  && typeof window.matchMedia === "function"
  && window.matchMedia("(max-width: 899px)").matches;
/* 轮 524 · 头上一笔 7px：库自己给 .vac-box-footer 的底内边距就是 7px
 * （`padding: 7px 2px calc(7px + safe-area)`）。这条内联表达式把 padding-bottom
 * 整条接管之后，那 7px 一并被抹掉 —— 键盘态条在 433..484、面板态掉到 440..484，
 * 每切一次输入行上下 7px，就是用户说的「高度不一致」。
 * 让位量的正解是「面板顶 − 条底」，而条底本来就该留这 7px，所以直接把它加回去。 */
const PAD_EXPR = "calc(7px + var(--wp-emoji-h, 320px) + var(--kb-kbb, var(--kbb, 0px))"
  + " - var(--kb-now, 0px) + var(--chat-box, var(--vlh, 0px)) - var(--vlh, 0px) + var(--kb-over, 0px))";
/* 轮 533 · iOS 的让位式子（重写，轮 526 那版只对上首尾两端）。
 *
 * 目标只有一个：**输入行的屏幕位置在「键盘态」和「面板态」完全一样。**
 * 这就是用户从第六轮就一直在说的「别的软件都是键盘跟表情固定一个高度」。
 *
 * 推导只用两条 iOS 事实（见 utils/iosKb.js 文件头）：
 *   ① 键盘贴着布局视口底长上来 ⇒ 可视区底（屏幕）= vtop + vvH ≡ innerHeight；
 *   ② 页面盒子底（屏幕）= 盒子高 − vtop，而 chatViewport 把盒子高钉成可视区高。
 * 于是输入行底（屏幕）= 可视区底 − pad，**pad 就是唯一的变量**：
 *
 *   键盘全开  pad = 7 + 面板高 − 键盘占高 − 0     = 7    （条贴键盘顶）
 *   面板全开  pad = 7 + 面板高 − 0     − kbb     = 256  （条贴面板顶）
 *
 * 也就是 pad = 7 + 面板高 − vtop − kbb(按键盘进度打折)。
 * --kb-kbb 正好就是这个「按进度打折的 kbb」：键盘全开 ⇒ 0，全收 ⇒ 81。
 * 所以中间每一帧都是同一个屏幕位置，线性、没有一帧是跳的。
 *
 * 旧式子 calc(面板高 − vtop) 只让首尾两端对上了，中间那 81px（iOS 底部工具栏）
 * 从来没被扣过 —— 逐帧工装（tools/ios-kb-drive.mjs）里「面板→键盘」那一段
 * 输入行从屏幕 405 一路窜到 174 再砸回 484，就是这 81px 在页面盒子和 fixed 面板
 * 两个参照系之间来回滚。用户说的「一堆问题」里，这条最难看出来也最难看。
 *
 * 另一个 7px：库给 .vac-box-footer 的底内边距本来就是 7px，这条内联表达式把
 * padding-bottom 整条接管后那 7px 会被抹掉（轮 524 踩过，每切一次上下 7px）。 */
const PAD_EXPR_IOS = "calc(var(--ios-fw-pad, 10px) + var(--wp-emoji-h, 320px) - var(--vtop, 0px)"
  + " - var(--kb-kbb, var(--kbb, 0px)))";
/* 非 iOS 的 overlay 型内核（Firefox 安卓 resizes-visual）沿用轮 526 那条，
 * 跟 iOS 彻底分开：iOS 那条现在挂着 --ios-fw-pad，别的内核没有这个变量。
 * 内容与轮 526 逐字一致（没有 7px 基线），改的是行为边界，不是行为。 */
const PAD_EXPR_OV = "calc(var(--wp-emoji-h, 320px) - var(--vtop, 0px))";
/* 轮 533 · iOS 是**编译期常量**，不是一个每帧去读的状态。
 *
 * 旧写法读 window.__wpVars.kind —— 那是「上几帧的采样结果」，键盘还没弹过的头几百
 * 毫秒里它是空的，isOverlayKb() 就会先返回 false 用上 resize 式子，等 kbUp 成立再跳回
 * overlay 式子。这与「第一下点表情输入条窜一下」是同一类病：判据比事实晚。
 * iOS 的 UA 不会变，所以这里一次性判死。安卓那一支仍然用运行时判定（FF 安卓
 * resizes-visual 也是 overlay，只有弹过键盘才看得出来）。 */
const IOS_KB = isIosKbDevice();
const isOverlayKb = () => {
  let ov = IOS_KB;
  if (!IOS_KB) {
    try {
      const wv = typeof window !== "undefined" && window.__wpVars;
      ov = !!wv && wv.kind === "overlay";
    } catch (e) { /* 忽略 */ }
  }
  /* 顺手把类挂到宿主上：CSS 里 .wp-kb-swap 的钉住规则要按内核分叉，
     而 CSS 读不到 JS 的 kind，只能靠类。
     轮 533：iOS 再挂一枚 .ios-kb —— 面板的定位基线（下面那条 --kbb）只在 iOS 上
     要改，用这枚类作用域住，安卓一个像素都不受影响。 */
  try {
    const n = el.value;
    if (n) {
      if (n.classList.contains("wp-kb-overlay") !== ov) n.classList.toggle("wp-kb-overlay", ov);
      if (IOS_KB && !n.classList.contains("ios-kb")) n.classList.add("ios-kb");
    }
  } catch (e) { /* 忽略 */ }
  return ov;
};
const emojiPad = (open) => {
  const n = el.value;
  const sr = n && n.shadowRoot;
  if (!sr) return;
  /* 轮 503：padding 必须加在 .vac-box-footer（position:relative 的那一层）上，
     它才是面板的定位宿主。加在外层 #room-footer 上面板不会跟着走。 */
  const foot = sr.querySelector("#room-footer .vac-box-footer")
    || sr.querySelector(".vac-box-footer")
    || sr.querySelector("#room-footer");
  if (!foot) return;
  emojiPadOn = !!open && sheetMode();
  const ov = isOverlayKb();
  if (IOS_KB) {
    /* 轮 533 · iOS 上**永远写内联**，开关面板都不留空。
     *
     * 空着的话键盘态吃的是「.dm-thread 10px 保底 + footer 7px」，面板态吃的是
     * 「thread 0 + footer 表达式」—— 两个参照系差 10px，于是点表情那一帧输入行
     * 先窜 10px 再回来（逐帧工装抓到的最后一处）。
     * 现在两态共用同一个基线 --ios-fw-pad（= 17px = 那 10 + 7 合并后的常量），
     * 键盘态就写它，面板态写「基线 + 面板高 − 键盘占高 − kbb」，中间的差值全被
     * 这一项吸收，输入行在整个切换里停在同一个像素上。
     * html.kb-ios 那条把 .dm-thread 的 10px 保底归零（见 style.css），两边是配套的。 */
    foot.style.paddingBottom = emojiPadOn
      ? PAD_EXPR_IOS
      : "var(--ios-fw-pad, 17px)";
    return;
  }
  /* 非 iOS 但仍然是 overlay 型的内核（Firefox 安卓 resizes-visual）沿用轮 526 那条
   * 式子，跟 iOS 分开 —— iOS 那条现在带 --ios-fw-pad，别的内核没有这个变量。 */
  foot.style.paddingBottom = emojiPadOn ? (ov ? PAD_EXPR_OV : PAD_EXPR) : "";
};

/* 轮 521 · 面板打开瞬间的骨架层（用户：「要照暖心墙那样补个骨架」）。
 *
 * 库每次点表情都重建 <emoji-picker>，格子要 0.6 秒才铺满（17 → 179 → 187），
 * 这期间面板位置已经对了、里面是白的 —— 看着像「点了没反应」。
 * 实现搬进 utils/emojiSkel.js（那段有三个边界要单独测：面板晚一帧才插入、
 * 面板被重建、数据拉不下来要收手），这里只负责开关。 */
const emojiSkel = createEmojiSkel(() => el.value);

/* 轮 521 · 面板开合的「唯一真源」标记，挂在 html 上。
 *
 * chatViewport 看不到 shadow tree，读这个类来判「面板是不是占着屏底」，
 * 然后把页面盒子钉成键盘态高度（--kb-pageh）。盒子不动 = 输入条不动。
 *
 * 为什么收起时不一律立刻摘：**点键盘键**那一下，面板先收、键盘后到（约 300ms）。
 * 这期间要是一并放开盒子，它会先从 484 弹回 744，键盘上来再回到 484 ——
 * 条先掉 260 再弹回，比原来的 55px 摆难看得多。所以只要宿主还挂着 wp-kb-swap
 * （= 正在交接给键盘），这里就先留着，等 endKbSwap 统一摘。 */
const setHtmlEmojiOpen = (v) => {
  try {
    const de = document.documentElement;
    if (de.classList.contains("wp-emoji-open") !== !!v) {
      de.classList.toggle("wp-emoji-open", !!v);
    }
  } catch (e) { /* 忽略 */ }
  /* 立刻同步一次：等 250ms 巡检的话，面板已经按旧盒子高画出来了 —— 第一帧就是错的 */
  try { kickChatViewport(); } catch (e) { /* 非聊天页 */ }
};

const setEmojiOpen = (open) => {
  const n = el.value;
  if (!n) return;
  n.classList.toggle("wp-emoji-open", open);
  if (open) setHtmlEmojiOpen(true);
  else if (!n.classList.contains("wp-kb-swap")) setHtmlEmojiOpen(false);
  /* 轮 503：面板开着 = 键盘让位必须为 0（页面要展开到整屏，面板才铺得满）。
     交给 keyboardInset 统一裁决：它会把 --kb-h 归零、并清掉「上次写过的值」，
     关面板时再按可视视口重算一次 —— 手动写变量会让那边的变化判据失灵。 */
  setPanelOpen(open);
  /* 聊天页底部那条 10px + safe-area 的让位，面板打开时归零：
     面板自己带 safe-area 内边距，否则输入条和面板之间会多出 34px 空条。 */
  const thread = n.closest(".dm-thread");
  if (thread) thread.classList.toggle("wp-emoji-open", open);
  if (open && !emojiWasOpen) {
    /* 轮 506：开面板这一刻是「键盘高度」唯一还能量到的时机（键盘马上要收）。
       先现读一次视口把 --kb-last 定住 —— 面板高 = --kb-panel-h = --kb-last，
       立刻就等于刚收起的那个键盘，不再等某次采样碰运气。
       用户第五次报「表情框跟输入框高度不一致」就是 --kb-last 一直是空、退回估计值 320。 */
    syncViewportVars();
    /* 键盘可能还开着：立刻把让位归零，页面在键盘下滑的同时展开，
       面板贴在页面底等它。等 keyboardWillHide 再归零会晚 200ms，
       那 200ms 里输入条会被 320px 的 footer padding 顶到半空。 */
    endKbSwap();
    try {
      /* 只收「组件内部当前焦点」——不 query 具体输入框、不抢焦点。
         点表情按钮时若键盘还开着，这一下让它收起；组件自己的 addEmoji 在手机上
         不会再 focus 回来（focusTextarea(true) 直接 return），所以面板期间键盘保持关闭。 */
      const sr = n.shadowRoot;
      const act = sr && sr.activeElement;
      if (act && typeof act.blur === "function") act.blur();
    } catch (e) { /* 无焦点环境 */ }
    /* 面板占掉 320px 后，原来贴底的最后一条会被挡；只在用户本来就在底部时才回底。 */
    const list = listNode();
    if (list && list.scrollHeight - list.scrollTop - list.clientHeight < 120) {
      setTimeout(() => {
        const n2 = listNode();
        if (n2) n2.scrollTop = n2.scrollHeight;
      }, 220);
    }
  }
  syncEmojiIcon(open);
  emojiPad(open);
  /* 轮 521：面板刚打开 → 铺骨架；收起来 → 立刻摘（别让它跟着面板一起被记住） */
  if (open && !emojiWasOpen) emojiSkel.mount();
  else if (!open) emojiSkel.drop();
  emojiWasOpen = open;
};
const syncEmoji = () => {
  const sr = el.value && el.value.shadowRoot;
  if (!sr) return;
  bindScrollIntent();    /* 轮380：列表节点重建后补回上滑意图监听 */
  syncTextareaLimit();   /* footer 重建后也把 2000 字上限补回去 */
  /* 轮 348：app 里不要表情搜索框（组件内置 picker 没有 ::part，只能塞 shadow style） */
  hideEmojiSearchIn(sr);
  bindFooterTap();
  syncErr();
  injectBack();          /* 轮381：会话列表刷新会让组件重画头部，← 被一起抹掉 */
  setEmojiOpen(!!sr.querySelector(".vac-emoji-picker"));
};
let emojiTries = 0;
let unmounted = false;
const observeEmoji = () => {
  const sr = el.value && el.value.shadowRoot;
  if (!sr) {
    /* 轮 498：bind() 可能跑在 shadowRoot 建好之前（自定义元素的升级时机各内核不一样）。
       旧写法在这里直接 return —— 这个 MutationObserver 就永远挂不上，宿主再也没有
       wp-emoji-open，面板让位只剩 :has() 一条命（国产内核不认 → 输入条被面板盖住）。
       这里退避重试，拿到就挂；组件卸载后自动停。 */
    if (emojiTries++ < 40) setTimeout(() => { if (!unmounted) observeEmoji(); }, 60);
    return;
  }
  emojiTries = 0;
  if (!emojiMO) {
    emojiMO = new MutationObserver(syncEmoji);
    emojiMO.observe(sr, { childList: true, subtree: true });
  }
  syncEmoji();
};

/* 轮 348 · 面板开着时点输入框：**别让库在 touchstart 就把面板收掉**。
 * 现象（真机）：点表情 → 面板贴底、键盘收起；再点「写点什么」→ 面板收了，但键盘不弹。
 * 原因：库的「点外面收面板」监听 touchstart；面板一收，footer 的 padding-bottom 从 320
 *   直接归零（无过渡），输入框同帧落回屏底 —— 手指抬起时已经不在输入框上，
 *   浏览器就不再给它焦点 → 输入法自然不弹。
 * 做法：touchstart 在输入区里截住（stopPropagation，面板先留着），让浏览器正常把焦点
 *   落在输入框；到 click 再收面板并补一次 focus（这时面板收起已经不影响点击目标）。
 *   面板本身、表情按钮上的点击一律不动（那里由组件自己 toggle）。 */
/* 轮 350 · 面板 → 键盘的交接（真机复现「坍缩再展开」）
 * 393×895 实测：点输入框后面板 ~150ms 收起、footer 的 320px 让位同帧开始收，
 * 输入框先掉到屏底（taY 533→840）；键盘 ~335ms 才起来，页面高度下压又把它顶回 533。
 * 做法：收起面板时先给宿主挂 .wp-kb-swap（让位钉在 --wp-emoji-h、过渡关掉），
 * 等 --kb-h > 0 的那一帧再摘掉 —— 页面高度和 padding 同曲线同时长地各走 320px，
 * 输入框原地不动，看起来就是「面板换成键盘」。
 * 1.2s 等不到键盘（外接键盘 / 焦点没落上）就兜底摘掉，退回旧行为。 */
/* 轮 520 · 交接期（面板已收、键盘还没到位）的唯一判据：--kb-now 追上 --wp-emoji-h。
 *
 * 旧版看的是「键盘开始动的信号」—— --kb-h > 0 / innerHeight 缩 120 / --kbb 变 60。
 * 于是键盘动画刚起头就把 .wp-kb-swap 摘了，那一刻 --kb-now 才一百多，让位式子里的
 * 「面板高 − kb-now」从已扣掉一半直接跳成全扣，输入条往下砸一截再被键盘顶回来。
 * 真机逐帧（_scratch/real/v520-vac.json）里那条 输入条跳 +253px 就是它。
 *
 * 现在只在**键盘真到位**（kb-now ≥ 面板高 − 6）时才摘类 —— 那时让位式子算出来正好是 0，
 * 摘掉不会有任何位移。读的是 window.__wpVars（viewportVars 每帧算好的快照），
 * 不是 getComputedStyle：这段跑在键盘弹出动画里，读样式会强制同步重排、把系统键盘
 * 的弹出打断（暖心墙那边实测过，条会直接从 DOM 消失）。
 * 40 帧约 660ms 还等不到（外接键盘 / 焦点没落上）就摘，宁可掉一下也不留残影。 */
let kbSwapRaf = 0;
let kbSwapFrames = 0;
const endKbSwap = () => {
  if (kbSwapRaf) { try { cancelAnimationFrame(kbSwapRaf); } catch (e) { /* 忽略 */ } kbSwapRaf = 0; }
  kbSwapFrames = 0;
  const n = el.value;
  if (n) {
    n.classList.remove("wp-kb-swap");
    /* 轮 521：交接结束 = 键盘真的到位了，这时候才放开页面盒子。
     * 面板若还开着（理论上不该，但外接键盘这类边界会撞上）就继续钉着。 */
    if (!n.classList.contains("wp-emoji-open")) setHtmlEmojiOpen(false);
  }
  const thread = n && n.closest(".dm-thread");
  if (thread) thread.classList.remove("wp-kb-swap");
};
/* 面板此刻的真实高度：直接量元素。
 * 轮 524：冷启动还没量到键盘时 window.__wpVars.panel 是 null，但面板**已经铺开了**
 * （--kb-panel-h 的 320 兜底）。旧写法拿 null 当「没有面板」直接判到位，让位当场塌陷，
 * 输入行从 433 弹到 373 再掉到 693 —— 用户说的「第一次点键盘没反应」。
 * 不能读 getComputedStyle 的 --kb-panel-h：自定义属性不注册时返回的是**声明原文**
 * （min(320px, 420px)），parseFloat 出来是 NaN。量元素最实在。 */
const panelElH = () => {
  try {
    const n = el.value;
    const sr = n && n.shadowRoot;
    const p = sr && sr.querySelector(".vac-emoji-picker");
    if (!p) return 0;
    const b = p.getBoundingClientRect();
    return b.height > 0 ? Math.round(b.height) : 0;
  } catch (e) { return 0; }
};
const swapReady = () => {
  const wv = (typeof window !== "undefined" && window.__wpVars) || null;
  if (!wv) return true;                       /* 读不到就按到位处理，别把类永远挂着 */
  const target = wv.panel > 0 ? wv.panel : panelElH();
  if (!(target > 0)) return true;
  return wv.kbNow >= target - 6;
};
const holdForKeyboard = () => {
  /* 判据沿用旧版：App 壳与 visualViewport 让位路线都要钉；
     webSwapNeeded 现在对 kb-resize / kb-overlay 都返回 true。 */
  if (!isApp && !webSwapNeeded()) return;
  const n = el.value;
  if (!n) return;
  n.classList.add("wp-kb-swap");
  const thread = n.closest(".dm-thread");
  if (thread) thread.classList.add("wp-kb-swap");
  if (kbSwapRaf) { try { cancelAnimationFrame(kbSwapRaf); } catch (e) { /* 忽略 */ } }
  kbSwapFrames = 40;
  const tick = () => {
    kbSwapRaf = 0;
    const nn = el.value;
    if (!nn) return;
    /* 轮 520：面板还开着 ≠ 「交接结束」。延迟收面板之后（见 bindFooterTap 里那次
     * 拦下的点击），holdForKeyboard 挂上时面板仍在，旧写法在这里直接 return，
     * 轮询从此断掉 —— 面板收完 .wp-kb-swap 却永远挂着（真机日志最后一次切换停在
     * wp-kb-swap，让位算式还按钉住的值在跑）。改成：等它关，关掉之后再判键盘。 */
    if (nn.classList.contains("wp-emoji-open")) {
      if (kbSwapFrames-- > 0) kbSwapRaf = requestAnimationFrame(tick);
      else endKbSwap();
      return;
    }
    if (swapReady() || kbSwapFrames <= 0) { endKbSwap(); return; }
    kbSwapFrames--;
    kbSwapRaf = requestAnimationFrame(tick);
  };
  kbSwapRaf = requestAnimationFrame(tick);
};

let footerTapBound = false;
/* 轮 520：「替用户收面板」那一次 btn.click() 会再次触发同一个 capture 监听，
 * 用这个标志放它过去（否则自己拦自己，面板永远收不掉）。 */
let closingPanel = false;
let footerTapNode = null;
let tapClosePending = false;
const bindFooterTap = () => {
  const sr = el.value && el.value.shadowRoot;
  const footer = sr && sr.querySelector("#room-footer");
  if (!footer) {
    footerTapBound = false;
    footerTapNode = null;
    return;
  }
  /* 轮380：VAC 切会话时可能整块重建 footer。旧写法只认一个布尔值，
     新 footer 就再也绑不上「点输入区先别收面板」的监听。 */
  if (footerTapBound && footer === footerTapNode) return;
  footerTapBound = true;
  footerTapNode = footer;
  const closeKeepFocus = () => {
    tapClosePending = false;
    const ta = sr.querySelector("textarea.vac-textarea");
    const btn = sr.querySelector(".vac-emoji-wrapper .vac-svg-button");
    holdForKeyboard();                                       /* 让位先钉住，等键盘接上再撤 */
    if (btn) btn.click();                                    /* 组件自己的 toggle → 收面板 */
    try { if (ta) ta.focus(); } catch (err) { /* 无焦点环境 */ }
  };
  const inInputArea = (e) => {
    const picker = sr.querySelector(".vac-emoji-picker");
    if (!picker) return false;
    const path = e.composedPath ? e.composedPath() : [];
    if (path.includes(picker)) return false;                 /* 点的是面板自己 */
    if (path.some((n) => n && n.classList && n.classList.contains("vac-emoji-wrapper"))) return false;
    const ta = sr.querySelector("textarea.vac-textarea");
    return path.includes(ta)
      || path.some((n) => n && n.classList && n.classList.contains("vac-box-footer"));
  };
  footer.addEventListener("touchstart", (e) => {
    if (!inInputArea(e)) return;
    tapClosePending = true;
    e.stopPropagation();                                     /* 别让库的 touchstart 先收面板 */
  }, true);
  footer.addEventListener("pointerdown", (e) => {
    /* 鼠标/笔：click 阶段才收面板，这时焦点已经落好，不存在「点空」问题 */
    if (e.pointerType === "touch") return;
    if (!inInputArea(e)) return;
    tapClosePending = true;
  }, true);
  footer.addEventListener("click", (e) => {
    if (!tapClosePending) return;
    const path = e.composedPath ? e.composedPath() : [];
    if (path.some((n) => n && n.classList && n.classList.contains("vac-emoji-wrapper"))) return;
    closeKeepFocus();
  }, true);
  /* 轮 400 · 面板开着时点「键盘键」：组件自己的 click 会把面板收掉，但它
   * 不会把焦点还回输入框；焦点不回来 → 系统键盘不弹 → footer 让位一收，
   * 用户看到的就是「再点一下直接折叠」。
   *
   * 轮 520 · 另外**别让它当场收**。真机 screencast（_scratch/real/cast-vac/f037）
   * 拍到：面板一摘、键盘要约 400ms 才从屏底上来，中间 260px 全是空白 —— 用户说的
   * 「一闪的东西」有一半就是这块白。面板多留一会儿不花任何代价：系统键盘是浮在
   * 网页之上的一层，它一到就把面板整块盖住，这时再收谁也看不见。
   * 所以这次点击先 stopImmediatePropagation 拦下，自己申请键盘，等 --kb-now 追上
   * --wp-emoji-h（键盘真到位）再替用户把按钮点下去。40 帧约 660ms 等不到
   * （外接键盘 / 焦点没落上）就直接收，不把面板永久吊着。 */
  footer.addEventListener("click", (e) => {
    /* 下面那次「替用户点」会再一次触发本监听 —— 放行给它，别自己拦自己。 */
    if (closingPanel) return;
    const picker = sr.querySelector(".vac-emoji-picker");
    /* 面板关闭时 Transition 里还会短暂留着节点，所以不能只看 picker；
       用宿主类确认真处于「面板打开」这一态。 */
    if (!picker || !el.value.classList.contains("wp-emoji-open")) return; /* 第一下交给组件打开 */
    const btn = footer.querySelector(".vac-emoji-wrapper .vac-svg-button");
    if (!btn) return;
    const path = e.composedPath ? e.composedPath() : [];
    if (!path.includes(btn)) return;                       /* 只接表情/键盘键本身 */
    e.stopImmediatePropagation();
    e.preventDefault();
    holdForKeyboard();                                     /* 让位先钉住 */
    /* 轮 510 · 键盘弹不起来的真因就是这里的 setTimeout。
     * iOS Safari 只在**用户手势的同步调用栈**里认 focus()；塞进 setTimeout(…, 0)
     * 就已经出栈，系统直接拒绝 → 面板收起、焦点没回去 = 用户说的「键盘折叠了」。
     * 当初加延时是想等面板从 DOM 摘掉，但消失的是 picker，textarea 一直没动过。 */
    const taNow = sr.querySelector("textarea.vac-textarea");
    try {
      if (taNow) {
        /* 轮 513：先 blur 再 focus。
         * iOS 对一个**已经是 activeElement** 的输入框调 focus() 是空操作 —— 键盘不会起来。
         * 而「面板收起」这条路上，textarea 可能仍然拿着焦点（组件自己切状态时不一定移交，
         * 观察者的 blur 也可能晚一拍），于是 focus() 什么都没发生：面板收掉了、键盘没回来，
         * 就是用户说的「切换键盘没效果」。blur() + focus() 在同一个手势栈里，等于重新申请
         * 一次键盘，iOS 认这个。 */
        if (sr.activeElement === taNow) {
          try { taNow.blur(); } catch (e2) { /* 忽略 */ }
        }
        taNow.focus();
      }
    } catch (err) { /* 无焦点环境 */ }
    /* 键盘到位了再收面板（判据与 .wp-kb-swap 的摘除完全一致：--kb-now ≥ 面板高 − 6） */
    let wait = 40;
    const closeWhenKb = () => {
      const nn = el.value;
      if (!nn) { closingPanel = false; return; }
      if (!nn.classList.contains("wp-emoji-open")) { closingPanel = false; return; }
      /* 判据与 .wp-kb-swap 的摘除完全一致：--kb-now 追上**面板此刻的真实高度**。
         轮 524：统一走 swapReady —— 冷启动 panel 还没锁时它退到 --kb-panel-h，
         否则这里会把 null 当「已到位」，面板一收，底下立刻露 260px 空白。 */
      const ready = swapReady();
      if (ready || wait-- <= 0) {
        closingPanel = true;
        try { btn.click(); } catch (e3) { /* 无 DOM 环境 */ }
        closingPanel = false;
        return;
      }
      requestAnimationFrame(closeWhenKb);
    };
    requestAnimationFrame(closeWhenKb);
    /* 组件在同一个 click 里还会 toggle 一次，可能把焦点挪到按钮上。
       补焦点只在**有 hover 的设备**上做：手机上补的这一次已经出栈，iOS 只会把焦点
       挪过去而不弹键盘，反而留下「有焦点、没键盘」的死状态；桌面点了按钮会丢焦点，
       才需要这一下。 */
    if (typeof window.matchMedia === "function" && window.matchMedia("(hover: hover)").matches) {
      setTimeout(() => {
        const ta2 = sr.querySelector("textarea.vac-textarea");
        if (!ta2 || sr.activeElement === ta2) return;
        try { ta2.focus(); } catch (err) { /* 无焦点环境 */ }
      }, 0);
    }
  }, true);
};

/* 轮 353 · 发送失败原因（旧版输入框上方那行红字）
 * ------------------------------------------------------------
 * 组件自带 footer 只画输入条，没有「为什么没发出去」的位置。陌生人首聊 3 条上限
 * （first-limit）失败时，旧版在输入框上方有一行红字；新版只剩消息行一个红「!」，
 * 用户看到的就是「发不出去，也没人告诉我为什么」。
 * 做法：把宿主的 err 作为一行 <p class="wp-dm-err"> 塞进 #room-footer 顶部
 * （与旧版同位置：输入条上方、红字），不碰组件逻辑。footer 随会话重建时，
 * emojiMO 的 childList 回调会走 syncEmoji → syncErr 补回来。 */
let errNode = null;
const syncErr = () => {
  const n = el.value;
  const sr = n && n.shadowRoot;
  const footer = sr && sr.querySelector("#room-footer");
  if (!footer) { errNode = null; return; }
  const text = String(props.err || "").trim();
  if (!text) {
    if (errNode && errNode.parentNode) errNode.parentNode.removeChild(errNode);
    errNode = null;
    return;
  }
  const fresh = !errNode || errNode.parentNode !== footer;
  if (fresh) {
    if (errNode && errNode.parentNode) errNode.parentNode.removeChild(errNode);
    errNode = document.createElement("p");
    errNode.className = "wp-dm-err";
    footer.insertBefore(errNode, footer.firstChild);
  }
  if (errNode.textContent !== text) errNode.textContent = text;
  /* 这行会多占约 20px：刚发完消息本来贴底 → 补一次贴底，别让最后一条被切掉。
     只在「本来就在底部」时补，翻历史时不打扰。 */
  if (fresh) {
    const list = listNode();
    if (list && list.scrollHeight - list.scrollTop - list.clientHeight < 120) {
      list.scrollTop = list.scrollHeight;
    }
  }
};

/* 轮378：组件自己的 textarea 没有 maxlength，超长时父级 send() 会先拒绝，
 * 但组件在 send-message 之后无条件 resetMessage()，用户刚打的整段字会被清空。
 * 把上限写到真正的输入框上，超长内容在输入/粘贴阶段就进不来。 */
const syncTextareaLimit = () => {
  const sr = el.value && el.value.shadowRoot;
  const ta = sr && sr.querySelector("textarea.vac-textarea");
  if (!ta) return;
  const cap = String(BODY_MAX);
  if (ta.getAttribute("maxlength") !== cap) ta.setAttribute("maxlength", cap);
};

/* 轮379：切会话前读真正的 textarea，表情/粘贴这类不走 typing-message 的改动也能带走。 */
const textareaValue = () => {
  const sr = el.value && el.value.shadowRoot;
  const ta = sr && sr.querySelector("textarea.vac-textarea");
  /* 轮381：区分「没有 textarea」和「textarea 是空的」。旧写法两者都返回 ""，
   * 切会话时再用 || 回落到 Map，用户明明清空了输入框，旧草稿又会被救回来。 */
  return ta ? String(ta.value || "") : null;
};
const saveDraft = (room, text, notify = false) => {
  const r = String(room || "");
  if (!r) return;
  const key = draftKey(r);
  const val = String(text || "");
  if (val) localDrafts.set(key, val);
  else localDrafts.delete(key);
  if (notify) emit("draft", { owner: String(props.meId || ""), roomId: r, text: val });
};

const injectTheme = () => {
  const n = el.value;
  if (!n || !n.shadowRoot) return;
  syncTextareaLimit();
  if (n.shadowRoot.querySelector("style[data-wp-dm]")) return;
  const st = document.createElement("style");
  st.setAttribute("data-wp-dm", "1");
  st.textContent = THEME_CSS;
  n.shadowRoot.appendChild(st);
};

/* 轮 339：藏掉组件头（漂流瓶复用本外壳时，头由旧页面画）。
   单独一条 style，开关只增删这一条，不碰主题那条。 */
const injectHead = () => {
  const n = el.value;
  const sr = n && n.shadowRoot;
  if (!sr) return;
  const old = sr.querySelector("style[data-wp-hidehead]");
  if (!props.hideHeader) { if (old) old.remove(); return; }
  if (old) return;
  const st = document.createElement("style");
  st.setAttribute("data-wp-hidehead", "1");
  st.textContent = ".vac-room-header{display:none !important;}.vac-container-scroll{margin-top:0 !important;}";
  sr.appendChild(st);
};

/* ── 事件接线 ──
 * ⚠️ 这个库用 Vue 的 defineCustomElement 包装，`$emit(x, payload)` 落到宿主上是
 *    `new CustomEvent(x, { detail: [payload] })` —— **detail 是数组**，不是对象。
 *    轮 331 探针实测：onSend 里直接读 e.detail.content 永远是 undefined，发送毫无反应。
 */
const payload = (e) => {
  const d = e && e.detail;
  return (Array.isArray(d) ? d[0] : d) || {};
};
/* 轮379：组件每次输入都会发 typing-message（带当前 roomId）。这里只记在本机 Map，
   不往上 emit —— 否则父页每个键都重算整页会话/消息映射，输入会卡。 */
let clearingDraft = false;
const onTyping = (e) => {
  if (clearingDraft) return;
  /* VAC 2.1.2 的 typing-message 只抛一个字符串（当前输入框内容），不是对象；
     旧写法按 d.message 取会永远拿到空串，把刚存的草稿又删掉。 */
  const raw = e && e.detail;
  const d = Array.isArray(raw) ? raw[0] : raw;
  const room = String((d && d.roomId) || curRoom.value || "");
  if (!room) return;
  const text = typeof d === "string" ? d : String(d && d.message != null ? d.message : "");
  saveDraft(room, text);
  /* 用户主动清空输入框时同步丢掉种子，防止首帧补草稿的重试把旧文字塞回来。 */
  if (!text && room === String(curRoom.value || "")) draftSeed.value = "";
};
/* 轮379：新会话没有草稿时，VAC 的 roomId watcher 可能先拿到**旧会话的 roomMessage**
   （Vue 同一次 patch 里 prop 的更新顺序），resetMessage 后又被旧值填回 textarea；
   而 roomMessage 为空时 VAC 的 watcher 是直接忽略的，结果 B 的草稿会留在 A 的输入框里。
   这里在新会话落定后只清一次，且用户已经重新输入/已有草稿时绝不碰。 */
const clearDraftTextarea = (room) => {
  nextTick(() => {
    if (String(props.roomId || "") !== room) return;
    if (draftSeed.value || localDrafts.get(draftKey(room))) return;
    const sr = el.value && el.value.shadowRoot;
    const ta = sr && sr.querySelector("textarea.vac-textarea");
    if (!ta || !ta.value) return;
    clearingDraft = true;
    try {
      ta.value = "";
      ta.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    } finally {
      clearingDraft = false;
    }
  });
};
/* 轮381：组件首次挂载/换会话时，draftSeed 可能在 VAC 内部 message ref 就绪前就传下去了
 * （实测 roomMessage 的 watcher 会错过首帧），导致父级明明有草稿、输入框却是空的。
 * 这里在 textarea 出现后补写一次；只在“空且种子仍是这段文字”时写，用户已输入就绝不碰。
 * 多试两拍是防 VAC 自己在换房后又 resetMessage 一次。 */
const applyDraftTextarea = (room, text, forceFirst = false) => {
  const r = String(room || "");
  const val = String(text || "");
  if (!r || !val) return;
  let tries = 0;
  let first = true;
  const attempt = () => {
    if (String(props.roomId || "") !== r) return;
    if (String(draftSeed.value || "") !== val) return;
    const sr = el.value && el.value.shadowRoot;
    const ta = sr && sr.querySelector("textarea.vac-textarea");
    /* 已经是这段草稿：只留重试，不在后续拍覆盖用户输入。 */
    if (ta && ta.value === val) {
      first = false;
    } else {
      /* 换会话后的第一拍，输入框里可能还是上一个会话的残留；这一拍允许替换。
         之后的重试只填空框，用户已经开始打字就绝不再碰。 */
      if (ta && ta.value && !(forceFirst && first)) return;
      if (ta) {
        clearingDraft = true;
        try {
          ta.value = val;
          ta.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        } finally {
          clearingDraft = false;
        }
      }
      first = false;
    }
    if (tries++ < 2) setTimeout(attempt, tries === 1 ? 120 : 220);
  };
  nextTick(attempt);
};
/* 轮388：父级在本地拦下「陌生人第 4 条」后，组件已经把输入框 reset 了。
 * 把被拦下的正文重新种回当前会话草稿，并等 VAC reset 完再写回 textarea。 */
const restoreDraft = (text, convId) => {
  const room = String(convId || curRoom.value || props.roomId || "");
  const val = String(text || "");
  /* 拦截后到 nextTick 之间用户可能已切走：只恢复仍停在原会话的输入框。 */
  if (!room || !val || String(props.roomId || "") !== room) return;
  draftSeed.value = val;
  localDrafts.set(draftKey(room), val);
  applyDraftTextarea(room, val, true);
};
defineExpose({ restoreDraft });
/* 切会话时先把旧会话输入框里的内容收进 Map，再把新会话的草稿作为 roomMessage 交给组件。
   flush:"sync" 保证在子组件收到新 roomId（并 resetMessage）之前读到旧 textarea。 */
watch(
  () => props.roomId,
  (next, prev) => {
    const n = String(next || "");
    const p = String(prev || "");
    if (p && p !== n) {
      const live = textareaValue();
      /* textarea 不存在（组件正在重建）才用 Map 兜底；存在但为空 = 用户清空了。 */
      saveDraft(p, live != null ? live : (localDrafts.get(draftKey(p)) || ""), true);
    }
    const seed = localDrafts.get(draftKey(n)) || "";
    draftSeed.value = seed;
    if (seed) applyDraftTextarea(n, seed, true);
    else clearDraftTextarea(n);
  },
  { immediate: true, flush: "sync" }
);
/* 2.1.2 只有「上滑加载更多」会发无 payload 的 fetch-messages，靠加载态翻转收尾 */
const onFetchMessages = async () => {
  if (!loaded.value) return;
  /* 轮378：上滑加载历史后要等一帧再关自己的 loader；这一帧前用户可能已切到
   * 另一个正在加载的会话，旧回调不能再把新会话的 loader 提前关掉。 */
  const seq = commitSeq;
  emit("load-more");
  loaded.value = false;
  await nextTick();
  if (seq === commitSeq) loaded.value = true;
};
const onAction = (e) => {
  const d = payload(e);
  const a = d.action || {};
  const m = d.message || {};
  if (a.name === "recall" || a.id === "recall") {
    /* 轮 341：菜单是按映射时的状态算的，万一停在聊天里跨过 15 分钟，这里再核一次 */
    const row = (props.messages || []).find((x) => String(x.id) === String(m._id));
    if (row && canRecallRow(row)) emit("recall", String(m._id));
  }
};
/* 发送：组件已经在 emit 之后自己清空输入框（resetMessage(true)），这里只把文字抛给旧发送队列。
   键盘保持不归页面管：组件内部 keepKeyboardOpen（点输入框/打字时置 true）+
   preventKeyboardFromClosing()（resetMessage 里回焦点）已经做了「发完键盘不折叠」。
   轮 335 删掉了页面手写的「发完手动回焦点」—— 两个 focus 抢同一个 textarea 只会打架。 */
const onSend = (e) => {
  const d = payload(e);
  /* 轮381：canType 刚翻 false（对方拉黑/消息请求过期）时 footer 还没移除，
   * 这一拍点发送父级会拒收；不能先把输入框/草稿清掉，否则用户的话直接丢。 */
  if (!props.canType) return;
  const text = String(d.content || "").trim();
  /* 轮379：组件 emit 后会自己 resetMessage；草稿同步清掉，切走再回来不能又冒出已发内容。 */
  const room = String(d.roomId || curRoom.value || "");
  /* 轮381：切会话瞬间可能还有旧房间排队的 send 事件；父级只认 activeId，
   * 直接转手会把 A 的文字发进 B。房间对不上就丢弃（也不动 B 的草稿）。 */
  if (room && String(props.roomId || "") !== room) return;
  /* 轮381：只输入空格再点发送时，组件也会 resetMessage 清空输入框；旧写法在
   * trim 后直接 return，Map 里还留着那串空格，切走再回来又出现在输入框。 */
  if (!text) {
    saveDraft(room, "", true);
    if (room === String(curRoom.value || "")) draftSeed.value = "";
    return;
  }
  saveDraft(room, "", true);
  if (room === String(curRoom.value || "")) draftSeed.value = "";
  emit("send", text);
};
/* 失败重发：组件对 failure:true 的消息画红「!」，点它发 open-failed-message。
   页面只负责「把这条再发一遍」（onVacResend → 旧 send()），组件不碰网络。 */
const onResend = (e) => {
  const d = payload(e);
  const m = d.message || {};
  if (m._id) emit("resend", String(m._id));
};
/* 头部「…」= 旧版菜单：看主页 / 免打扰 / 拉黑 */
const onMenuAction = (e) => {
  const d = payload(e);
  const name = String((d && (d.name || d.id)) || "");
  if (name) emit("room-action", name);
};

/* 返回键：single-room 模式下组件自己不出 ←，这里往它的头部塞一个（旧 .dm-thread-back 的样子） */
const onBack = () => emit("back");
const injectBack = () => {
  const n = el.value;
  const sr = n && n.shadowRoot;
  if (!sr) return;
  const wrap = sr.querySelector(".vac-room-header .vac-room-wrapper");
  if (!wrap) return;
  const old = wrap.querySelector(".dm-vac-back");
  if (!props.showBack) { if (old) old.remove(); return; }
  if (old) return;
  const b = document.createElement("button");
  b.type = "button";
  b.className = "dm-vac-back";
  b.textContent = "←";
  b.setAttribute("aria-label", "返回");
  b.addEventListener("click", onBack);
  wrap.insertBefore(b, wrap.firstChild);
};

let bound = null;
const bind = () => {
  const n = el.value;
  if (!n || bound === n) return;
  bound = n;
  n.__vacBound = true;   /* 探针用：确认事件真的挂上了 */
  n.addEventListener("fetch-messages", onFetchMessages);
  n.addEventListener("message-action-handler", onAction);
  n.addEventListener("send-message", onSend);
  n.addEventListener("menu-action-handler", onMenuAction);
  n.addEventListener("open-failed-message", onResend);
  n.addEventListener("typing-message", onTyping);
  injectTheme();
  observeEmoji();
};

watch(() => [curRoom.value, props.showBack], () => nextTick(() => { injectTheme(); injectBack(); observeEmoji(); }));
watch(() => props.hideHeader, () => nextTick(injectHead));
/* 轮 353：失败原因随 sendErr 变化重画（清空时把注入的那行摘掉） */
watch(() => props.err, () => nextTick(syncErr));

/* 轮 513 · 可视区底部的闭环校正（单独一条钩子，避免扰动 onMounted 里的首帧时序）。
 * 推的是 --kbb，页面高 / 吸底条 / 表情面板一起跟着走，见 utils/bottomPin.js。 */
onMounted(() => startBottomPin(() => {
  const n = el.value;
  if (!n) return null;
  return n.closest(".dm-page--chat") || n.closest(".dm-page") || n;
}));
onBeforeUnmount(() => {
  stopBottomPin();
  /* 骨架的 rAF 循环要跟着停，否则组件没了还在每帧查 shadowRoot */
  emojiSkel.drop();
  /* 轮 521：面板的 html 标记必须跟着组件一起走。
     留在 html 上的话，退出会话后 chatViewport 仍然认为「面板开着」，
     会把列表页的盒子也钉成键盘态高度 —— 整页矮一截。 */
  try { document.documentElement.classList.remove("wp-emoji-open"); } catch (e) { /* 忽略 */ }
});

onMounted(() => {
  bind();
  /* 轮 478：会话里的表情面板同样吃这份数据（库按 locale 共用一个 IndexedDB），
     进会话就空闲预热，点表情不再空等。 */
  scheduleEmojiWarm();
  if (draftSeed.value) applyDraftTextarea(curRoom.value || props.roomId, draftSeed.value, true);
  nextTick(() => { injectTheme(); injectBack(); injectHead(); syncErr(); });
  /* 轮 340：进会话钉底（首次挂载也算一次「进房」） */
  entryAt = Date.now();
  userStopped = false;
  nextTick(() => {
    bindScrollIntent();
    if (curMsgs.value.length) pinBottom();
  });
  /* 首帧：数据已就位，只把 messagesLoaded 翻一次（同帧完成，不留空白帧）。
     手机从列表首次点进会话时，组件挂载和父级 loadMessages 是同一轮：这里若无条件
     翻 true，会把 commit(..., loading=true) 刚开的 loader 又关掉，露出「还没有消息」。
     所以仍在加载且没有消息时保持 loader，等消息到场 / loadingMessages 落回 false。 */
  loaded.value = false;
  nextTick(() => {
    if (props.loadingMessages && !curMsgs.value.length) return;
    loaded.value = true;
  });
});

onBeforeUnmount(() => {
  commitSeq++;
  unmounted = true;
  clearTimeout(holdTimer);
  clearTimeout(gateTimer);
  gateTimer = 0;
  clearPin();
  endKbSwap();
  setPanelOpen(false);          /* 轮 503：卸载时撤掉「面板开」标记，别把 --kb-h 钉死在 0 */
  if (emojiMO) { emojiMO.disconnect(); emojiMO = null; }
  emojiWasOpen = false;
  /* 轮379：组件可能因切到漂流瓶/通知段而卸载；把每个会话的草稿交给父级保管。 */
  if (curRoom.value) {
    const live = textareaValue();
    saveDraft(curRoom.value,
      live != null ? live : (localDrafts.get(draftKey(curRoom.value)) || ""), true);
  }
  for (const [key, text] of localDrafts) {
    const i = key.indexOf(":");
    const owner = key.slice(0, i);
    const roomId = key.slice(i + 1);
    if (owner && roomId) emit("draft", { owner, roomId, text });
  }
  const n = bound;
  if (!n) return;
  n.removeEventListener("fetch-messages", onFetchMessages);
  n.removeEventListener("message-action-handler", onAction);
  n.removeEventListener("send-message", onSend);
  n.removeEventListener("menu-action-handler", onMenuAction);
  n.removeEventListener("open-failed-message", onResend);
  n.removeEventListener("typing-message", onTyping);
  bound = null;
});
</script>

<template>
  <div class="dm-vac-box">
    <!-- 自定义元素收到的全是 attribute（组件内部 castObject 会 JSON.parse），
         所以数组/对象一律传 JSON 字符串，布尔传 "true"/"false"（与原型页同口径）。
         表情 = 组件自带的 emoji-picker-element（轮 336 打开）：数据源默认在 jsDelivr，
         国内/离线会空转，所以把 en 那份 JSON 放进 public/emoji/data.json 自带，
         用 emoji-data-source 指过去 —— 逻辑一行没写，只给了地址。
         「: 补全」是组件的另一个开关（emojis-suggestion-enabled），旧版没有这个弹层，关掉。
         消息回应（show-reaction-emojis）要后端存，继续关。 -->
    <vue-advanced-chat
      ref="el"
      class="dm-vac"
      height="100%"
      theme="light"
      emoji-data-source="/emoji/data.json"
      :current-user-id="meId"
      :rooms="JSON.stringify(rooms)"
      :messages="JSON.stringify(curMsgs)"
      :room-id="curRoom"
      :room-message="draftSeed"
      :load-first-room="'false'"
      :rooms-loaded="'true'"
      :messages-loaded="loaded ? 'true' : 'false'"
      :single-room="'true'"
      :show-search="'false'"
      :show-add-room="'false'"
      :show-audio="'false'"
      :show-files="'false'"
      :show-emojis="'true'"
      :show-reaction-emojis="'false'"
      :emojis-suggestion-enabled="'false'"
      :show-footer="canType ? 'true' : 'false'"
      :textarea-auto-focus="'false'"
      :text-messages="JSON.stringify(texts)"
      :menu-actions="JSON.stringify(menuActions)"
      :message-actions="JSON.stringify(actions)"
      :styles="JSON.stringify(STYLES)"
    />
    <!-- 旧版：消息请求 / 被我拉黑时没有输入框，同一位置给一句说明 -->
    <p v-if="!canType" class="dm-vac-gate">{{ gate }}</p>
  </div>
</template>

<style scoped>
/* 宿主就是 .dm-thread 里「消息流」那一格：高度由旧页面的 flex 列分配，
   组件自己带聊天头 + 消息流 + 输入区，所以这里只负责填满、不自己算视口。 */
.dm-vac-box {
  display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; min-width: 0;
  width: 100%;
}
.dm-vac { display: block; flex: 1 1 auto; width: 100%; height: auto; min-height: 0; }
/* 与旧 .dm-compose 里那句说明同款：虚线以上、灰字居中 */
.dm-vac-gate {
  flex: none; margin: 0; padding: 12px 0 2px;
  border-top: 1px dashed rgba(204, 120, 92, .28);
  text-align: center; font-size: 12.5px; color: var(--ink-soft, #6c6a64);
}
</style>
