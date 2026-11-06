/* 现网会话页换组件 · 接线锁（Node 直跑）
 *   node tools/dm-vac-test.mjs
 *
 * 轮 330 起 /messages 真正切到 vue-advanced-chat（组件版），旧布局原样留在 v-else 里。
 * 这个测试锁住「接线」这一层，防的是三类回归：
 *   ① 组件把自己当普通 Vue 组件传参 —— 自定义元素只吃 attribute，对象会变成 "[object Object]"；
 *   ② 点会话的事件链断掉（2.1.2 的 fetch-room 到不了宿主，必须再加 shadow 点击兜底）；
 *   ③ 首帧又退回「等网络」—— 微信式缓存要求进会话就用本地历史落屏。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
let pass = 0, fail = 0; const out = [];
function t(name, fn) {
  try { fn(); pass++; out.push("ok   " + name); }
  catch (e) { fail++; out.push("FAIL " + name + " :: " + e.message); }
}
/* 只报「缺什么」，不要把整份源码打出来 */
const has = (src, re, msg) => { if (!re.test(src)) throw new Error(msg); };
const hasNot = (src, re, msg) => { if (re.test(src)) throw new Error(msg); };

const MV = read("src/views/MessagesView.vue");
const VAC = read("src/components/DmVacChat.vue");
const FLAG = read("src/utils/dmUiFlag.js");
const MAP = read("src/utils/dmMap.js");
const SV = read("src/views/SettingsView.vue");
const BV = read("src/views/BlockedView.vue");

/* ───────── 开关与分支 ───────── */
t("V1 组件占满聊天那一列（头 / 消息流 / 输入区都是组件画的），旧版只在 v-else 兜底", () => {
  /* 轮 334（用户拍板）：「组件能改成新的全用新的」—— 聊天头、消息流、输入区不再各写一套，
     全交给组件；页面骨架（左列列表 / 段栏 / 已拉黑 / 搜索）仍是旧版。
     轮 333「组件只画消息流、旧头旧输入框留在外面」已作废。 */
  has(MV, /\n\s*<div v-else class="dm-wrap">/, "旧版两栏容器必须保留");
  hasNot(MV, /dm-wrap--vac|dm-vac-top/, "整页组件布局残留（段栏会跑到卡片顶上）");
  const i = MV.indexOf('class="card dm-thread"');
  assert.ok(i > 0, "找不到右列聊天框");
  const j = MV.indexOf("<DmVacChat", i);
  assert.ok(j > i, "组件必须挂在 .dm-thread 里");
  has(MV.slice(j, j + 900), /v-if="vacUi && seg === 'dm'"/, "组件只接会话段");
  has(MV.slice(j, j + 900), /@back="backToList"/, "组件头部的 ← 要接回旧返回");
  /* 旧聊天头 / 消息流 / 输入区整体挪进 v-else（legacy 才渲染） */
  const k = MV.indexOf("<template v-else>", j);
  assert.ok(k > j, "旧版那三块必须包进 v-else 里，否则会和组件重复渲染");
  has(MV.slice(k, k + 400), /<header class="dm-thread-head">/, "旧聊天头丢了");
  assert.ok(MV.indexOf('<div ref="listEl" class="dm-scroll"', k) > k, "旧消息流丢了");
  assert.ok(MV.indexOf('<footer class="dm-compose">', k) > k, "旧输入区丢了（legacy 还要用）");
});

t("V2 开关认 ?ui=vac / ?ui=legacy 并记住（可切回）", () => {
  has(FLAG, /q === "vac"/, "开关不认 ?ui=vac");
  has(FLAG, /q === "legacy"/, "开关不认 ?ui=legacy");
  has(FLAG, /localStorage\.setItem/, "开关没有记住选择");
  has(FLAG, /localStorage\.getItem/, "开关没有读取记忆");
  has(MV, /readDmUi\(route\.query\)/, "页面必须从开关文件读，不能自带一套");
});

t("V2b 默认就是新组件（只有显式 legacy 才回旧布局）", () => {
  /* 轮 332：用户拍板转正。写给以后想「为了保险先回旧默认」的人看：
     转回来只需要改这一行，但那就是把已经验过的新 UI 藏起来了。 */
  has(FLAG, /return localStorage\.getItem\(KEY\) !== "legacy"/, "默认值被改回旧布局了");
  hasNot(FLAG, /getItem\(KEY\) === "vac"/, "还是旧的「没记过 = 旧布局」写法");
});

/* ───────── 组件传参 ───────── */
t("V3 数组/对象 prop 一律传 JSON 字符串（自定义元素只吃 attribute）", () => {
  for (const k of ["rooms", "messages", "text-messages", "message-actions", "styles"]) {
    has(VAC, new RegExp(`:${k}="JSON\\.stringify\\(`), k + " 必须 JSON.stringify 后再传");
  }
  hasNot(VAC, /:messages="curMsgs"/, "直接传数组会让组件 castObject 成 [object Object]");
  hasNot(VAC, /:styles="STYLES"/, "styles 也必须序列化");
});

t("V4 布尔属性传 'true'/'false' 字符串", () => {
  has(VAC, /:single-room="'true'"/, "single-room 要传字符串布尔");
  has(VAC, /:messages-loaded="loaded \? 'true' : 'false'"/, "messages-loaded 要传字符串布尔");
});

t("V5 我方身份与当前会话都接上", () => {
  has(VAC, /:current-user-id="meId"/, "没传 current-user-id");
  has(VAC, /:room-id="curRoom"/, "没传 room-id");
  has(VAC, /curRoom\.value = room/, "curRoom 没有统一的提交入口");
  has(VAC, /const nextRoom = String\(props\.roomId \|\| ""\)/, "curRoom 没有跟着 props.roomId 走");
  has(VAC, /:rooms="JSON\.stringify\(rooms\)"/, "rooms 不是从 convs 映射来的");
  has(VAC, /convsToRooms\(props\.convs/, "rooms 必须走 convsToRooms");
});

/* ───────── 事件 ───────── */
t("V6 组件只当消息流（不渲染自己的会话列表 / 搜索）", () => {
  has(VAC, /:single-room="'true'"/, "single-room 没开 → 组件会自己画一列会话列表");
  has(VAC, /:show-search="'false'"/, "没有列表却还开着搜索");
  hasNot(VAC, /addEventListener\("fetch-room"/, "列表已由旧页面画，别再监听 fetch-room");
  hasNot(VAC, /vac-room-item/, "旧页面才是列表，组件里不该再有 .vac-room-item");
});

t("V6b 事件 detail 是数组（defineCustomElement 的坑）", () => {
  /* Vue 的 defineCustomElement 把 $emit(x, payload) 派发成
     new CustomEvent(x, { detail: [payload] }) —— 直接读 e.detail.action 永远是 undefined。 */
  has(VAC, /const payload = \(e\) => \{[\s\S]{0,160}Array\.isArray\(d\) \? d\[0\] : d/, "缺少 detail 归一函数");
  const code = VAC.replace(/\/\*[\s\S]*?\*\//g, "");
  has(code, /onAction[\s\S]{0,180}payload\(e\)/, "onAction 没走 payload()");
  hasNot(code, /e\.detail\.(content|action|message|room)/, "还在直接读 e.detail.xxx（数组上没有这些字段）");
});

t("V7 撤回 / 上滑 / 发送 / 会话菜单全从组件往外抛", () => {
  has(VAC, /defineEmits\(\[[^\]]*"send"[^\]]*"room-action"[^\]]*"back"[^\]]*\]\)/, "emits 少了（send / room-action / back）");
  has(VAC, /addEventListener\("message-action-handler",\s*onAction\)/, "没接 message-action-handler");
  has(VAC, /a\.name === "recall"/, "撤回动作没识别");
  has(VAC, /addEventListener\("fetch-messages",\s*onFetchMessages\)/, "没接 fetch-messages");
  has(VAC, /addEventListener\("send-message",\s*onSend\)/, "组件自己的输入区必须接 send-message");
  has(VAC, /const text = String\(d\.content \|\| ""\)\.trim\(\)/, "发送内容没从 payload().content 取");
  /* 轮 335（用户：「键盘/输入区也用组件的」）：发完保持键盘是组件自己做的
     （keepKeyboardOpen + resetMessage 里的 preventKeyboardFromClosing）。
     轮 348 唯一例外：表情面板开着时点输入框，必须在 touchstart/click 这一击里把焦点
     还给组件输入框 —— 库的「点外面收面板」监听 touchstart，面板一收输入框同帧落回
     屏底，抬手时已经点空，输入法永远不弹（真机现象 + 无头实测见 jiaojie 轮 348）。
     除 bindFooterTap 里那一下，页面仍然不许碰组件输入框的焦点。 */
  const tapBlock = (VAC.match(/const bindFooterTap = \(\) => \{[\s\S]*?\n\};/) || [""])[0];
  assert.ok(tapBlock.length > 200, "bindFooterTap 没了（表情面板点输入框会点空）");
  assert.ok(/ta\.focus\(\)/.test(tapBlock), "bindFooterTap 里没把焦点还给输入框");
  const limitBlock = (VAC.match(/const syncTextareaLimit = \(\) => \{[\s\S]*?\n\};/) || [""])[0];
  /* 轮379：切会话保存草稿要读一次真实 textarea 的值（表情/粘贴不走 typing 事件），
     只读 value、不抢焦点，和上面的 maxlength 一样属于允许的例外。 */
  const draftValueBlock = (VAC.match(/const textareaValue = \(\) => \{[\s\S]*?\n\};/) || [""])[0];
  /* 轮379：切到无草稿会话要主动清一次 textarea（VAC 会用旧 roomMessage 填回），
     只清值、不抢焦点，也是允许的例外。 */
  const draftClearBlock = (VAC.match(/const clearDraftTextarea = \(room\) => \{[\s\S]*?\n\};/) || [""])[0];
  /* 轮381：首帧补草稿也要读写 textarea 的值（VAC 会错过首次 roomMessage），
     同样不抢焦点，属于允许的例外。 */
  const draftApplyBlock = (VAC.match(/const applyDraftTextarea = \(room, text, forceFirst = false\) => \{[\s\S]*?\n\};/) || [""])[0];
  const outside = VAC.split(tapBlock).join("").split(limitBlock).join("").split(draftValueBlock).join("").split(draftClearBlock).join("").split(draftApplyBlock).join("");
  assert.ok(!/ta\.(focus|blur)\(/.test(outside), "bindFooterTap 之外又在抢组件的输入框焦点");
  assert.ok(!/querySelector\("textarea\.vac-textarea"\)/.test(outside), "bindFooterTap 之外又在手写输入框焦点逻辑");
  has(VAC, /keepKeyboardOpen/, "注释里要写明键盘交给组件的 keepKeyboardOpen");
  has(VAC, /addEventListener\("menu-action-handler",\s*onMenuAction\)/, "头部「…」菜单没接");
  for (const h of ["onVacSend", "onVacRecall", "onVacLoadMore", "onVacRoomAction"]) {
    has(MV, new RegExp(`@[a-z-]+="${h}"`), "模板里没接 " + h);
  }
  /* 发送仍落到旧队列（乐观上屏 / 失败重发 / IDB 镜像都在 send() 里） */
  has(MV, /function onVacSend\(text\)[\s\S]{0,200}body\.value = s;[\s\S]{0,40}send\(\)/, "onVacSend 没走旧 send()");
  has(MV, /<van-field[\s\S]{0,600}@keydown\.enter\.exact\.prevent="send"/, "legacy 分支的旧输入框必须还在");
});

t("V7b 上滑加载更早必须把上一页并进 UI（不能只回填 IndexedDB）", () => {
  const i = MV.indexOf("async function onVacLoadMore");
  assert.ok(i > 0, "onVacLoadMore 没了");
  const b = MV.slice(i, MV.indexOf("\n}", i)).replace(/\/\*[\s\S]*?\*\//g, "");
  has(b, /loadMessages\(id, \{ before \}\)/, "上滑没有调用 loadMessages(before) —— 界面不会出现更早消息");
  assert.ok(!/await backfillOlder\(id\)/.test(b), "上滑仍然只 await backfillOlder（只写库、不进 UI）");
  has(VAC, /limit: Math\.max\(300, props\.messages\.length\)/, "组件仍固定只画 300 条，翻过 300 条后的历史永远不会上屏");
});

/* ───────── 不闪跳 / 不转圈 ───────── */
t("V8 roomId 与 messages 同 tick 提交；有历史时不翻 loaded", () => {
  const i = VAC.indexOf("const commit = (room, msgs, loading = false)");
  assert.ok(i > 0, "缺少统一提交函数 commit()");
  const b = VAC.slice(i, i + 600);
  has(b, /curRoom\.value = room/, "commit 里没提交 roomId");
  has(b, /curMsgs\.value = msgs/, "commit 里没提交 messages");
  const iFlip = b.indexOf("loaded.value = false");
  const iMsg = b.indexOf("if (msgs.length)");
  assert.ok(iMsg > 0 && iFlip > iMsg, "loaded 翻转只能发生在「无消息」分支");
  has(b, /if \(!loading\) nextTick/, "加载中不许把 loader 收掉");
});

t("V8b 首开长会话先开 loader，不提交空态；深链 rooms 未到才等 600ms", () => {
  const i = VAC.indexOf("冷启动首开长会话");
  assert.ok(i > 0, "缺少首开长会话的说明/实现");
  const b = VAC.slice(i, i + 2200);
  has(b, /props\.loadingMessages/, "判断条件要用父级的 loadingMessages");
  has(b, /if \(!nextMsgs\.length && props\.loadingMessages\)/, "缺少「加载中且无消息」判断");
  has(b, /commit\(nextRoom, nextMsgs, true\)/, "加载中空消息没有带 loader 提交");
  /* 600ms 兜底只留给 rooms 还没到的深链首帧；已知会话不再等 600ms 后提交空态。
     从 setTimeout 本身起算窗口，避免锚点距离随注释变化而误报。 */
  const iTo = VAC.indexOf("holdTimer = setTimeout", i);
  assert.ok(iTo > 0, "缺少深链 600ms 兜底定时器");
  has(VAC.slice(iTo, iTo + 400), /setTimeout\([\s\S]{0,200}600\)/, "要有深链 600ms 兜底");
  has(b, /if \(!known && nextRoom !== curRoom\.value\)/, "600ms 兜底只该给 rooms 未到的深链首帧");
  has(MV, /:loading-messages="loadingMsgs"/, "页面没把 loadingMsgs 传下去");
});

t("V9 首帧 nextTick 翻转 + 上滑收尾有守卫（不转圈）", () => {
  has(VAC, /onMounted\(\(\) => \{[^}]*bind\(\)[\s\S]{0,220}nextTick\(/, "首帧没有 nextTick 收尾");
  has(VAC, /if \(!loaded\.value\) return;/, "fetch-messages 在加载态里不要再翻");
  hasNot(VAC, /setTimeout\([^)]*loaded/, "首帧不许用定时器拖出空白帧");
});

/* ───────── 微信式缓存（首帧必须本地落屏） ───────── */
t("V10 首帧走 IndexedDB（dmStore 只存一屏，换设备就没有）", () => {
  has(MV, /idbLoad/, "loadMessages 没 import 并使用 idbLoad");
  const i = MV.indexOf("轮 330 · IndexedDB 补首帧");
  assert.ok(i > 0, "缺少 IndexedDB 补首帧那段");
  const b = MV.slice(i, i + 1300);
  has(b, /const thinLocal = msgs\.value\.length > 0 && msgs\.value\.length < 5;/, "缺“本地只有几条”判定");
  has(b, /!msgs\.value\.some\(\(m\) => Number\(m\.id\) > 0\) \|\| thinLocal/, "补首帧没覆盖“本地只有一条已发送”");
  has(b, /stale\(\)/, "异步回来后必须做过期判断");
  has(b, /applyRows\(/, "读完要落到同一个 applyRows（保住分页水位）");
  has(b, /serverDone/, "hasMore 由全量库的 serverDone 决定");
});

t("V10b 空页 + serverDone 不能被 idbMerge 的早退吞掉", () => {
  const idb = read("src/utils/dmIdb.js");
  has(idb, /if \(!list\.length && serverDone == null\) return;/, "空页仍直接 return，backfill 永远标记不了 serverDone");
  has(idb, /if \(list\.length\) rec\.msgs = mergeRows/, "空页不能跳过已有 msgs");
});

t("V11 组件层不碰缓存（只画，不写）", () => {
  hasNot(VAC, /cacheSet\(|cachePatch\(|idbMerge\(|idbDrop\(|dmStoreSave\(/, "组件里出现了写缓存");
  hasNot(VAC, /cloud\.|dmApi\./, "组件里不许发请求");
});

t("V12 映射层仍是纯函数（Node 可测、可复用）", () => {
  const src = MAP.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/^import /m.test(src), "dmMap.js 不该有 import");
  assert.ok(!/document\.|window\.|localStorage|indexedDB/.test(src), "纯映射层混进环境依赖");
});

t("V15 列表里没有这一行时用 peer 合成 room（深链不能出「无头无输入框」的空壳）", () => {
  has(VAC, /const synth = convToRoom\(/, "缺少合成 room 的兜底");
  has(VAC, /list\.concat\(\[synth\]\)/, "合成的 room 没并回 rooms");
  has(VAC, /peer: \{ type: Object/, "缺少 peer prop");
  has(MV, /:peer="activeConv \|\| meta \|\| null"/, "页面没把对方信息传下去");
});

t("V16 漂流瓶 / 通知入口仍长在旧左列里（不再另起一条整页段栏）", () => {
  /* 轮 332 转正时为了让组件版有这两个入口，在整页顶上补了一条段栏 —— 用户看到的就是
     「段栏跑到卡片顶上、下面一整块组件」。轮 333 撤回：入口回旧左列，组件不再画段栏。 */
  const i = MV.indexOf('class="card dm-list"');
  assert.ok(i > 0, "找不到左列会话列表");
  const b = MV.slice(i, i + 3600);
  has(b, /seg = 'bottle'/, "左列没有漂流瓶入口");
  has(b, /seg = 'notif'/, "左列没有通知入口");
  hasNot(MV, /dm-vac-top|dm-wrap--vac/, "整页段栏已经撤掉，别再长回来");
});

t("V17 免打扰 / 拉黑改由组件头部「…」菜单承接（动作仍回旧函数）", () => {
  /* 轮 334：头部也是组件画的，所以菜单用组件的 menu-actions；
     动作名（profile / mute / block）由 onVacRoomAction 落回旧的 goUser / mutePeer / blockPeer。 */
  has(VAC, /:menu-actions="JSON\.stringify\(menuActions\)"/, "头部「…」菜单没接 menu-actions");
  has(VAC, /name: "mute"/, "菜单没有免打扰");
  has(VAC, /name: "block"/, "菜单没有拉黑");
  has(VAC, /name: "profile"/, "菜单没有看主页");
  has(MV, /@room-action="onVacRoomAction"/, "模板没接 room-action");
  has(MV, /function onVacRoomAction\(name\)[\s\S]{0,400}mutePeer\(\)/, "免打扰没接到 mutePeer");
  has(MV, /function onVacRoomAction\(name\)[\s\S]{0,400}blockPeer\(\)/, "拉黑没接到 blockPeer");
  /* 旧头部那套只在 legacy 分支里（别两边都挂一份） */
  const h = MV.indexOf('class="dm-thread-head"');
  assert.ok(h > 0, "找不到旧聊天头");
  has(MV.slice(h, h + 2400), /mutePeer\(\)/, "legacy 聊天头菜单也要留着");
});

t("V18 不自己造搜索框/列表（组件只画消息流）", () => {
  has(VAC, /:single-room="'true'"/, "single-room 没开");
  hasNot(VAC, /<input[^>]*dm-vac-search/, "别再手写一个搜索框");
  has(MV, /<van-field[\s\S]{0,120}v-model="q"/, "列表搜索仍是旧版那个 van-field");
});

t("V19 组件填满 .dm-thread 那一格（不许自己算视口高度）", () => {
  const css = read("src/style.css");
  hasNot(css, /dm-wrap--vac|dm-vac-top/, "轮 332 的整页布局残留");
  const i = VAC.indexOf(".dm-vac-box {");
  assert.ok(i > 0, "DmVacChat 缺 .dm-vac-box 样式");
  const b = VAC.slice(i, VAC.indexOf("}", i));
  has(b, /flex: 1 1 auto/, "要和旧版 flex 列一起分配高度");
  has(b, /min-height: 0/, "没有 min-height:0，flex 子项撑不出滚动");
  hasNot(b, /100dvh|100vh/, "不许再算视口高度");
});

t("V20 组件按旧版设计上色（头部 / 气泡 / 时间 / 日期 / 头像 / 输入区）", () => {
  /* 头部 = 旧 .dm-thread-head */
  has(VAC, /\.vac-room-header \{[\s\S]{0,160}height: 60px !important/, "头部高度不是旧版那条");
  /* 轮 349：用户「不要虚线」——头部下面那条细虚线去掉（页面底色连成一片）。
     三条视觉细账（虚线 / 日期底色 / 底栏上下留白）见 tools/chat-look-test.mjs。 */
  has(VAC, /\.vac-room-header \{[\s\S]{0,160}border-bottom: 0 !important/, "头部又长出分隔线了");
  hasNot(VAC, /\.vac-room-header \{[\s\S]{0,200}dashed/, "头部又是虚线");
  has(VAC, /\.vac-room-header \.vac-avatar \{[\s\S]{0,120}40px/, "头部头像不是 40px");
  has(VAC, /\.vac-room-header \.vac-room-info \{ display: none/, "「在线 / 最后上线」那行旧版没有");
  /* 输入区 = 组件原样（轮 335 用户拍板：「键盘/输入区也用组件的」）
     旧版那颗「发送」胶囊、胶囊输入框、虚线输入条都是页面 CSS 仿的 —— 全部删掉，
     只留组件自己的 textarea + 纸飞机发送键；颜色走 styles 的官方变量。 */
  hasNot(VAC, /content: "发送"/, "又用 CSS 画了个假「发送」键");
  hasNot(VAC, /\.vac-textarea \{/, "又在改组件输入框的结构 / 皮肤");
  hasNot(VAC, /\.vac-box-footer \{/, "又在改组件输入条的排版");
  hasNot(VAC, /\.vac-icon-textarea[\s\S]{0,300}svg \{ display: none/, "又把组件的发送图标藏了");
  has(VAC, /backgroundInput: "var\(--wash-strong/, "输入框底色要走组件 styles.backgroundInput");
  has(VAC, /send: "var\(--accent/, "发送键颜色要走组件 styles.icons.send");
  /* 气泡 / 时间 / 日期 / 头像 */
  has(VAC, /border-radius: 16px 16px 16px 4px/, "对方气泡圆角不是旧版那个");
  has(VAC, /border-radius: 16px 16px 4px 16px/, "我方气泡圆角不是旧版那个");
  has(VAC, /border: 1px solid var\(--hairline/, "气泡缺发丝边（旧 .dm-bubble 有）");
  has(VAC, /\.vac-message-wrapper \.vac-text-timestamp \{[\s\S]{0,220}position: absolute/, "时间要挪到气泡下面");
  has(VAC, /vac-card-info\.vac-card-date[\s\S]{0,240}border-radius: 999px/, "日期胶囊不是旧 .dm-day 那个");
  has(VAC, /\.vac-avatar \{[^}]*width: 30px/, "消息头像不是旧版 30px");
  has(SV, /to="\/settings\/blocked"/, "设置页没有跳到「已拉黑」独立页");
  has(SV, /t\("dm\.blockedTitle"\)/, "设置页没有「已拉黑」入口");
  hasNot(SV, /class="set-blocked-panel"/, "设置页还在内联展开拉黑名单");
  has(BV, /class="blocked-row"/, "独立页没有拉黑名单行");
  has(BV, /t\("dm\.blockedTitle"\)/, "独立页没有「已拉黑」标题");
  has(BV, /blockState\.rows/, "独立页没接本地拉黑名单快照");
  has(BV, /refreshBlocks\(\)/, "独立页没接拉黑名单后台校准");
  has(BV, /await unblockUser\(b\.user_id\)/, "独立页解除拉黑没走全站缓存包装");
  hasNot(MV, /class="dm-blocked-bar"/, "消息列表还留着已拉黑入口");
  hasNot(MV, /dmApi\.blocks\(\)/, "消息页还留着拉黑名单请求");
});

t("V21 手机聊天页：← 注入组件头部，桌面不出返回键", () => {
  has(VAC, /showBack: \{ type: Boolean/, "缺少 showBack prop");
  has(VAC, /b\.className = "dm-vac-back"/, "没有往组件头部塞 ← 按钮");
  has(VAC, /b\.addEventListener\("click", onBack\)/, "← 没接点击");
  has(VAC, /const onBack = \(\) => emit\("back"\)/, "← 没往外抛 back");
  has(VAC, /@media \(min-width: 900px\) \{ \.dm-vac-back \{ display: none !important; \}/, "桌面要藏 ←");
  has(VAC, /\.dm-vac-back \{[\s\S]{0,220}border-radius: 50%/, "← 不是旧 .dm-thread-back 的圆底");
  has(MV, /:show-back="isMobileNav"/, "页面没按手机形态传 show-back");
  /* 手机头部旧版没有头像和「…」 */
  has(VAC, /@media \(max-width: 899px\) \{[\s\S]{0,200}\.vac-room-header \.vac-avatar \{ display: none/, "手机头部要藏头像");
  has(VAC, /@media \(max-width: 899px\) \{[\s\S]{0,320}\.vac-room-header \.vac-room-options \{ display: none/, "手机头部要藏「…」");
});

t("V22 输入框占位 / 不能说话时的说明都跟着旧页面", () => {
  has(VAC, /placeholder: \{ type: String/, "缺少 placeholder prop");
  has(VAC, /const texts = computed/, "textMessages 没跟着占位走");
  has(VAC, /:text-messages="JSON\.stringify\(texts\)"/, "textMessages 还是常量");
  has(MV, /const composePlaceholder = computed/, "页面没按桌面/手机给占位");
  has(MV, /:placeholder="composePlaceholder"/, "占位没传下来");
  has(VAC, /canType: \{ type: Boolean/, "缺少 canType prop");
  /* 收输入区用组件的 show-footer prop，不再用 :host()/display:none 去戳组件内部 */
  has(VAC, /:show-footer="canType \? 'true' : 'false'"/, "不能说话时没让组件自己收输入区（show-footer）");
  hasNot(VAC, /:host\(\.vac-gate\)/, "别再拿 :host 去 display:none 组件的节点");
  has(VAC, /<p v-if="!canType" class="dm-vac-gate">/, "不能说话时缺那句说明");
  has(MV, /:can-type="canType"/, "页面没传 canType");
  has(MV, /:gate="gateText"/, "页面没传说明文案");
});

t("V23 表情 = 组件自带的 emoji-picker（数据自带，不靠 CDN）", () => {
  /* 轮 336（用户：「有没有现成的表情包功能」）：组件自带 emoji-picker-element，
     开 show-emojis 就出笑脸键。唯一要准备的是数据源 —— 默认从 jsDelivr 拉，
     国内会空转，所以把 en 那份 JSON 放进 public/ 自带，用 emoji-data-source 指过去。
     这一条锁住四件事：面板是开的、数据源是本地文件、没把 CDN 写回来、旧版没有的
     「: 补全」弹层和「消息回应」都保持关。 */
  has(VAC, /:show-emojis="'true'"/, "表情面板又被关了");
  has(VAC, /emoji-data-source="\/emoji\/data\.json"/, "表情数据源不是本地文件");
  hasNot(VAC, /cdn\.jsdelivr/, "别把第三方 CDN 写回来");
  has(VAC, /:emojis-suggestion-enabled="'false'"/, "旧版没有「: 补全」弹层");
  has(VAC, /:show-reaction-emojis="'false'"/, "消息回应要后端，不能开");
  has(VAC, /emoji-picker \{/, "表情面板没套暖爪配色");
  const f = path.join(root, "public/emoji/data.json");
  assert.ok(fs.existsSync(f), "缺少 public/emoji/data.json（构建后 /emoji/data.json 会 404）");
  assert.ok(fs.statSync(f).size > 100 * 1024, "表情数据文件太小，八成下坏了");
});

t("V24 失败重发 = 组件红「!」→ 旧 send()（不另写一套发送）", () => {
  /* 轮 336：组件对 failure:true 的消息画红「!」，点击发 open-failed-message。
     页面只做「摘掉失败行 + 塞回 body + send()」，网络/乐观上屏/失败标记全归旧队列。 */
  has(VAC, /addEventListener\("open-failed-message", onResend\)/, "组件失败事件没接");
  has(VAC, /removeEventListener\("open-failed-message", onResend\)/, "卸载时没摘监听");
  has(VAC, /emit\("resend", String\(m\._id\)\)/, "没把消息 id 抛给页面");
  has(MV, /@resend="onVacResend"/, "页面没接 resend");
  has(MV, /function onVacResend\(id\)/, "页面没有重发入口");
  has(MV, /x\.failed\)/, "重发只该认带 failed 标记的行");
  has(MV, /msgs\.value = msgs\.value\.filter\(\(x\) => String\(x\.id\) !== String\(m\.id\)\)/, "重发前没摘掉失败行（会留两条）");
  has(MV, /body\.value = text;\s*\n\s*send\(\);/, "重发没走同一条 send()");
});

t("V25 发送失败原因（陌生人首聊 3 条上限）在输入区上方要看得见", () => {
  /* 轮 353（用户实报：「陌生人只能发三条信息，新组件这里没有提示了」）：
     旧版把 sendErr 画在输入框上方；换组件后这行只留在 v-else 兜底页，
     first-limit 失败时用户只看到消息行一个红「!」，不知道是「对方回复前最多 3 条」。
     做法：页面把 sendErr 作为 err 传进组件，组件把它注入 #room-footer 顶部（旧位置）。
     这条锁住：prop 接线、注入位置、清空、样式、以及「切会话不把 A 的报错带到 B」。 */
  has(VAC, /err: \{ type: String, default: "" \}/, "组件没有 err prop");
  has(VAC, /const syncErr = \(\) => \{/, "没有 syncErr（注入失败原因那行）");
  has(VAC, /footer\.insertBefore\(errNode, footer\.firstChild\)/, "没插到输入区上方（#room-footer 最前）");
  has(VAC, /errNode\.className = "wp-dm-err"/, "注入节点的 class 不对");
  has(VAC, /watch\(\(\) => props\.err, \(\) => nextTick\(syncErr\)\)/, "err 变了没重画");
  has(VAC, /bindFooterTap\(\);\s*\n\s*syncErr\(\);/, "footer 重建（切会话）后没补回那行");
  has(VAC, /\.vac-room-footer > \.wp-dm-err \{[\s\S]{0,220}color: #d9534f/, "缺红字样式（旧 .dm-err 同色）");
  has(MV, /:err="sendErr"/, "页面没把 sendErr 传给组件");
  has(MV, /watch\(activeId, \(\) => \{ sendErr\.value = ""; \}\)/, "切会话没清掉上一条报错");
  has(MV, /<p v-if="sendErr" class="sub dm-err">/, "旧版兜底页那行别删");
  const BC = read("src/components/BottleChat.vue");
  has(BC, /:err="sendErr"/, "漂流瓶聊天框没传 sendErr（同组件同款坑）");
  const I18N = read("src/i18n.js");
  assert.equal((I18N.match(/errFirstLimit:/g) || []).length, 2, "中英两份 errFirstLimit 缺一");
});

t("V25b 陌生人第 4 条在写乐观行 / 调 dm_send 之前本地拦截", () => {
  /* 用户实报：「第四条应该本地就阻止，而不是发完返回才提示没发出去」。
     拦截必须早于 body 清空、乐观行落库和 dmApi.send；重发也要先判，不能先摘失败行。 */
  has(MV, /firstLimitLocked,/, "页面没引入本地首聊上限规则");
  has(MV, /function firstContactBlocked\(/, "没有当前会话的拦截入口");
  const sendBody = MV.slice(MV.indexOf("async function send()"), MV.indexOf("const mid = r && r.msg_id"));
  const guard = sendBody.indexOf("firstContactBlocked(owner, convId)");
  const clear = sendBody.indexOf('body.value = ""');
  const optimistic = sendBody.indexOf("msgs.value = msgs.value.concat([temp])");
  assert.ok(guard > 0 && guard < clear && clear < optimistic,
    "本地拦截必须早于清空输入框和乐观上屏");
  const resendBody = MV.slice(MV.indexOf("function onVacResend(id)"), MV.indexOf("function onVacRoomAction"));
  const rGuard = resendBody.indexOf("firstContactBlocked(meId.value, convId)");
  const rRemove = resendBody.indexOf("dmStoreRemove(meId.value, convId, m.id)");
  assert.ok(rGuard > 0 && rGuard < rRemove, "重发要先判首聊上限，不能先摘失败行");
  has(MV, /t\("dm\.errFirstLimit"\)/, "拦截后没复用 first-limit 文案");
  has(MV, /ref="vacChat"/, "VAC 没挂 ref，拦下后没法把正文放回去");
  has(VAC, /const restoreDraft = \(text, convId\) => \{/, "组件没有恢复草稿入口");
  has(VAC, /defineExpose\(\{ restoreDraft \}\)/, "恢复入口没暴露给页面");
  has(MV, /vc\.restoreDraft\(text, convId\)/, "拦下后没把正文恢复到输入框");
  has(VAC, /String\(props\.roomId \|\| ""\) !== room\) return;/, "切走后不能把旧会话正文塞进新会话");
});

t("V26 输入框有 2000 字上限，超长内容不会被组件先清空", () => {
  has(VAC, /import \{ BODY_MAX, canRecall \} from "\.\.\/utils\/dmRules\.js"/, "组件没拿 BODY_MAX");
  has(VAC, /const syncTextareaLimit = \(\) => \{/, "没有给组件 textarea 补上限");
  has(VAC, /ta\.setAttribute\("maxlength", cap\)/, "没把 maxlength 写到真正的输入框");
  has(VAC, /const cap = String\(BODY_MAX\)/, "上限不是 dmRules 的 2000");
  const i = VAC.indexOf("const injectTheme = () => {");
  const b = VAC.slice(i, i + 320);
  has(b, /syncTextareaLimit\(\);/, "切会话/重建 footer 后没补上限");
});

t("V27 会话本地库同会话补行也要认领重启前的失败草稿", () => {
  has(MV, /const claimed = claimPendingEcho\(msgs\.value, extra\);/, "同会话补行没先认领 pending");
  has(MV, /dropEchoedDrafts\(add\.length \? claimed\.rows\.concat\(add\) : claimed\.rows, local\.msgs\)/, "同会话补行没认领回显");
});

t("V28 全量库首帧只上最近 400 条，更早的留给上滑加载", () => {
  has(MV, /const latest = idbRows\.slice\(-400\)/, "全量库首帧没有截到最近 400 条");
  has(MV, /hasOlder \|\| !\(rec && rec\.serverDone\)/, "截断后没保留“还有更早”");
  /* 轮381：本地页/网络页若全是已上屏行，锚点不动时必须停止继续翻同一页。 */
  has(MV, /const prevOldest = oldestId\.value;[\s\S]{0,520}?pinning\.value = false;/, "本地空页没释放 pinning");
  has(MV, /if \(rows\.length === 30 && oldestId\.value === prevOldest\) hasMore\.value = false;/, "网络重复页仍保留 hasMore");
});

t("V29 切会话不丢输入框草稿，且输入过程中不把父页拖进重渲染", () => {
  has(VAC, /drafts: \{ type: Object, default: \(\) => \(\{\}\) \}/, "组件没接父级草稿表");
  has(VAC, /const localDrafts = new Map\(\);/, "组件没有本机草稿 Map");
  has(VAC, /:room-message="draftSeed"/, "草稿没有作为 roomMessage 交还给组件");
  has(VAC, /addEventListener\("typing-message", onTyping\)/, "没接 typing-message");
  has(VAC, /removeEventListener\("typing-message", onTyping\)/, "卸载时没解绑 typing-message");
  has(VAC, /saveDraft\(room, "", true\);/, "发送后没清掉草稿");
  has(VAC, /if \(room === String\(curRoom\.value \|\| ""\)\) draftSeed\.value = "";/, "发送后没清掉 roomMessage 种子");
  has(VAC, /const live = textareaValue\(\);/, "切会话前没读真实输入框内容");
  /* 轮381：没有 textarea 才回落到 Map；textarea 存在但为空 = 用户清空，不能复活旧草稿。 */
  has(VAC, /return ta \? String\(ta\.value \|\| ""\) : null;/, "textareaValue 没区分“没有输入框”和“输入框为空”");
  has(VAC, /live != null \? live : \(localDrafts\.get\(draftKey\(p\)\) \|\| ""\)/, "切会话仍用 || 把清空的草稿救回来");
  has(VAC, /if \(!text\) \{[\s\S]{0,120}?saveDraft\(room, "", true\);/, "只发空格后没清掉残留草稿");
  has(VAC, /const applyDraftTextarea = \(room, text, forceFirst = false\) => \{[\s\S]{0,1200}?ta\.value = val;/, "首次挂载草稿没补进 textarea（VAC 会错过首帧 roomMessage）");
  has(VAC, /if \(ta && ta\.value && !\(forceFirst && first\)\) return;/, "换会话第一拍仍会保留上一个会话的残留文字");
  has(VAC, /const seed = localDrafts\.get\(draftKey\(n\)\) \|\| "";[\s\S]{0,120}?if \(seed\) applyDraftTextarea\(n, seed, true\);/, "切回有草稿的会话没有补写输入框");
  has(VAC, /onMounted\(\(\) => \{[\s\S]{0,160}?if \(draftSeed\.value\) applyDraftTextarea/, "组件重新挂载时没恢复父级草稿");
  has(VAC, /if \(!text && room === String\(curRoom\.value \|\| ""\)\) draftSeed\.value = "";/, "用户清空输入框后旧种子还会被重试写回");
  has(VAC, /if \(room && String\(props\.roomId \|\| ""\) !== room\) return;/, "切会话瞬间旧房间的 send 会被发进新会话");
  has(VAC, /const onSend = \(e\) => \{[\s\S]{0,180}?if \(!props\.canType\) return;/, "canType 刚关闭时仍先清空输入框/草稿");
  has(VAC, /flush: "sync"/, "切会话读草稿必须早于子组件 resetMessage");
  has(VAC, /for \(const \[key, text\] of localDrafts\)/, "卸载时没把草稿交回父级");
  has(MV, /const vacDrafts = ref\(\{\}\)/, "父页没有草稿表");
  has(MV, /function onVacDraft\(e\)/, "父页没接 draft 事件");
  has(MV, /:drafts="vacDrafts"/, "草稿表没传给组件");
  has(MV, /@draft="onVacDraft"/, "模板没接 draft 事件");
  /* VAC 2.1.2 typing-message 的 detail 是字符串，不是 { message } 对象。 */
  has(VAC, /typeof d === "string" \? d :/, "typing-message 字符串载荷没接住（会把草稿清空）");
  has(VAC, /const raw = e && e\.detail;/, "typing-message 没先取 detail");
  /* VAC 切会话时可能先把旧 roomMessage 填回 textarea，而空 roomMessage 被忽略；
     新会话没有草稿时必须主动清一次，否则 B 的草稿会留在 A 的输入框里。 */
  has(VAC, /const clearDraftTextarea = \(room\) =>/, "新会话无草稿时没有主动清输入框");
  has(VAC, /if \(seed\) applyDraftTextarea\(n, seed, true\);[\s\S]{0,40}?else clearDraftTextarea\(n\);/, "切到无草稿会话没触发清理");
  has(VAC, /if \(draftSeed\.value \|\| localDrafts\.get\(draftKey\(room\)\)\) return;/, "清理前没让用户新输入/已有草稿");
  has(VAC, /let clearingDraft = false;/, "主动清理时没防止 typing 事件误删旧会话草稿");
});

t("V30 切到漂流瓶/通知段后，迟到的消息/已读不能替会话清红点", () => {
  has(MV, /if \(String\(activeId\.value\) !== String\(id\) \|\| seg\.value !== "dm"[\s\S]{0,80}?document\.hidden\)\) return;/, "openConv 等消息回来没校验当前段/前台");
  has(MV, /function markConversationRead\(cid\)/, "没有统一的清未读入口");
  has(MV, /if \(!id \|\| seg\.value !== "dm" \|\| !signedIn\.value\) return;/, "清未读入口没挡非会话段");
  has(MV, /const viewing = seg\.value === "dm" && !wasDeactivated\.value[\s\S]{0,80}?document\.hidden\)/, "applyTail 没判断当前是否在会话段/前台/消息页已切走");
  has(MV, /if \(viewing\) markConversationRead\(cid\);/, "applyTail 仍会在别的段清未读");
  has(MV, /watch\(seg, \(v\) => \{[\s\S]{0,220}?markConversationRead\(cid\);/, "切回会话段没有补一次已读");
  has(MV, /const wasDeactivated = ref\(false\)/, "后台状态不是响应式，模板传不给漂流瓶聊天");
  has(MV, /function onVisible\(\) \{[\s\S]{0,240}?if \(wasDeactivated\.value\) return;/, "页面已切走时回前台仍会替缓存会话清红点/跑轮询");
  has(MV, /if \(seg\.value === "dm" && cid && String\(msgsConv\) === cid\) markConversationRead\(cid\);/, "回到前台没有补一次已读");
  has(MV, /if \(typeof document === "undefined" \|\| !document\.hidden\) \{[\s\S]{0,120}?markConversationRead\(String\(activeId\.value\)\)/, "从别的页面回到缓存会话没有补一次已读");
  has(MV, /if \(wasDeactivated\.value && seg\.value === "dm" && route\.name === "messages"/, "停在漂流瓶段回消息页仍会替旧会话清红点/滚动");
  has(MV, /if \(!wasDeactivated\.value\) armDmRealtime\(\);/, "认证在缓存期间就绪时又把实时回调挂到后台页面");
});

t("V31 组件重建 footer / 消息列表 / 头部后仍要补绑监听和返回键", () => {
  has(VAC, /let footerTapNode = null;/, "footer 监听没记节点");
  has(VAC, /footer === footerTapNode/, "footer 重建后仍被旧布尔值挡住");
  has(VAC, /const pinBottom = \(\) => \{[\s\S]{0,180}?bindScrollIntent\(\);/, "贴底时没有补绑消息列表监听");
  has(VAC, /injectBack\(\);\s*\/\* 轮381：会话列表刷新会让组件重画头部/, "头部重画后没补回手机返回键");
  has(VAC, /const syncEmoji = \(\) => \{[\s\S]{0,160}?bindScrollIntent\(\);/, "footer/列表变化时没有补绑");
});

t("V8c 切会话后旧的 nextTick 不能提前关掉新会话 loader", () => {
  has(VAC, /let commitSeq = 0;/, "没有提交序号");
  has(VAC, /seq === commitSeq/, "nextTick 没校验提交序号");
  has(VAC, /commitSeq\+\+/, "卸载时没作废旧提交");
});

t("V8d 上滑加载的 nextTick 也不能提前关掉新会话 loader", () => {
  const i = VAC.indexOf("const onFetchMessages = async");
  assert.ok(i > 0, "找不到 onFetchMessages");
  const b = VAC.slice(i, i + 500);
  has(b, /const seq = commitSeq;/, "上滑加载没有捕获提交序号");
  has(b, /if \(seq === commitSeq\) loaded\.value = true;/, "旧 nextTick 仍会关新会话 loader");
});

console.log(out.join("\n"));
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
