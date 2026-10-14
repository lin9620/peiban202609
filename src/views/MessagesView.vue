/* 私信（/messages 会话列表；/messages/:id 具体会话）
 * ------------------------------------------------------------
 * 大站做法：
 *  - 左列会话列表（头像 / 昵称 / 最后一条预览 / 相对时间 / 未读红点 / 免打扰图标）；
 *  - 搜索框过滤会话；「消息请求」单独分组（陌生人首条消息，同意后才进列表）；
 *  - 右列气泡对话：我的靠右、对方靠左、跨天日期分隔、顶部「加载更早」分页；
 *  - 发送：Enter 发送 / Shift+Enter 换行、乐观上屏 + 发送中/失败标记；
 *  - 撤回（15 分钟内，显示「已撤回」占位）、免打扰、隐藏会话、拉黑/解除；
 *  - 打开会话即抬已读水位（服务端 dm_mark_read）；滚动到底部；仅在可见时轮询新消息。
 */
<script setup>
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch, defineAsyncComponent, onActivated, onDeactivated } from "vue";
import { useRoute, useRouter } from "vue-router";
import { NButton, NInput, NAvatar, NTag } from "naive-ui";
import { t, i18n } from "../i18n.js";
import { cloud } from "../utils/supabase.js";
import * as dmApi from "../utils/dm.js";
import { cacheKey, swr } from "../utils/cache.js";
import { dmStoreLoad, dmStoreSave, dmStoreDrop } from "../utils/dmStore.js";
import { restoreScroll } from "../utils/scrollMem.js";
import { avatarUrlFor } from "../utils/avatar.js";   /* 轮 238:萌宠头像池 */
import { idbMerge, idbOlderThan, idbServerDone, idbDrop } from "../utils/dmIdb.js";
import {
  previewText, sortConvs, filterConvs, withDayDividers, displayMsg,
  validateSend, sendErrKey, canRecall, relativeTime, rowView, mergeTail,
} from "../utils/dmRules.js";
import { badge, refreshBadge, badgeLocal, badgeDmConvPatch } from "../stores/badgeStore.js";
import { onDmInsert } from "../utils/dmRealtime.js";   /* 轮 269：前台秒达 */
/* 轮 34：拉黑已全站生效（私信拦截 + 暖心墙内容隐藏）——这里走 userBlocks 的包装，
 * 让「拉黑名单」的内容过滤缓存与私信名单始终是同一份 */
import { blockUser, unblockUser, refreshBlocks, isBlocked } from "../utils/userBlocks.js";
import BottleRecords from "../components/BottleRecords.vue";
/* 轮 142 · 桌面「漂流瓶」段：行式列表（左列）+ 独立聊天框（中列）——与会话段的 dm-thread 各自单开 */
import BottleChatList from "../components/BottleChatList.vue";
import BottleChat from "../components/BottleChat.vue";
import { isMobileNav, pushBack, popBack } from "../stores/uiStore.js";
/* T7 消息 Tab 内分栏（私信 | 通知）：通知段直接复用 NotificationsView
 * （数据层零重写；异步 chunk 不拖慢首屏；挂载即拉第 0 页，配 SWR 缓存秒开） */
const NotificationsView = defineAsyncComponent(() => import("./NotificationsView.vue"));

const route = useRoute();
const router = useRouter();

const convs = ref([]);       // 会话列表
const q = ref("");           // 搜索
const loadingConvs = ref(false);
const convsLoaded = ref(false);   /* 轮 266：服务端**明确应答过**（哪怕空列表）才算已加载——
    * 「还没有会话」只在它为 true 时才显示；此前一律给骨架屏。
    * 修用户报障：弱网下网络失败/未返回时旧版把「还没查到」渲染成「还没有会话」（假空）。 */
const failed = ref(false);
const signedIn = computed(() => !!(cloud.ready && cloud.user));

const activeId = ref(String(route.params.id || "")); // 当前会话（空串 = 只看列表）
const msgs = ref([]);        // 当前会话消息（旧→新）
let msgsConv = "";           // msgs 现在装的是哪个会话（轮 157b：防跨会话误合并）
/* 轮 225 · 会话切换竞态守卫：每次「按会话拉消息」发号（msgSeq），响应回来时校验号与当前会话。
 * 用户实测：快速点开 A → 返回 → 点 B → 点 C，多按几次后 C 里出现 B 甚至 A 的记录。
 * 根因：loadMessages / tick 在 await 期间用户已经切走，旧响应回来**无条件**写 msgs.value，
 * 于是「最后返回的那份」赢了 —— 与用户当前点的是谁完全无关。
 * 两道判据缺一不可：① 号被更新的请求顶掉（同一会话连点也要防）；② 当前会话已不是它。 */
let msgSeq = 0;
const isStale = (mySeq, id) => mySeq !== msgSeq || String(activeId.value) !== String(id);
const body = ref("");
const sending = ref(false);
const sendErr = ref("");
const loadingMsgs = ref(false);
const hasMore = ref(true);
const oldestId = ref(null);
const listEl = ref(null);
const userScrolling = ref(false);   /* 轮 173：用户手动上滑标记——追底停手 */
const listRevealed = ref(true);     /* 轮 176：进会话先隐藏消息区，钉底稳定后再显示——
    首帧 fallback 字体排版 → webfont 换装撑高内容 = 落点错位闪现（用户实测跳闪） */
const entryReady = ref(false);      /* 轮 180：首屏（fresh）数据落定才允许显示——
    缓存窗口与 fresh 窗口高度不同，缓存先渲染再被替换 = ±千px 可见跳变（逐帧采样实锤） */
/* 轮 193 调试（临时）：揭示来源追踪 */
watch(listRevealed, (v) => {
  if (typeof window === "undefined") return;
  window.__wpRev = window.__wpRev || [];
  const el = listEl.value;
  window.__wpRev.push({
    v, t: Math.round(performance.now() % 1e7),
    top: el ? Math.round(el.scrollTop) : -1,
    h: el ? Math.round(el.scrollHeight) : -1,
    font: (document.fonts && document.fonts.status) || "?",
    entryReady: entryReady.value,
  });
});
function fontsOk() {                /* 轮 178b：webfont 没在加载中 = 排版稳定（每帧实时判定，
    fonts.ready 有「触发过早误放行」的坑，弃用）；加载失败也会落到 loaded，不会永藏 */
      return !(document.fonts && document.fonts.status === "loading");
    }
/* 轮 238 · 字体「静默」判定：文楷按 unicode-range 分块加载，两批之间 fonts.status
 * 会短暂读回 "loaded"——fontsOk() 被骗过 → 揭示落在震荡中段 → 下一个子集到达继续
 * 重排 = 内容闪现又跳没（长消息子集多、窗口多，用户实测「闪现出来又消失」）。
 * 记录最后一次字体活动时刻，揭示前要求静默 ≥150ms（loading/loadingdone 都算活动）。 */
let lastFontActivity = -1e9;
if (typeof document !== "undefined" && document.fonts) {
  const markFontActivity = () => { lastFontActivity = performance.now(); };
  document.fonts.addEventListener("loading", markFontActivity);
  document.fonts.addEventListener("loadingdone", markFontActivity);
}
const fontQuiet = () =>
  !document.fonts || performance.now() - lastFontActivity > 150;
let scrollGen = 0;                  /* 轮 176b：滚动链代数——平滑滚动接管时作废旧追帧链 */
const pinning = ref(false);         /* 轮 173b：进会话钉底中（直到首屏数据落定） */
let entryFallback = 0;              /* 轮 249：openConv 的 2s 揭示兜底句柄——新一轮必须清掉旧的 */
function onListTouch() { userScrolling.value = true; }
function onListWheel() { userScrolling.value = true; }
const meta = ref(null);      // 当前会话元信息（昵称 / 免打扰 / 拉黑 / 消息请求）
const menuFor = ref("");     // 展开操作菜单的会话 id
const fromList = ref(false); // 手机形态：本会话是从会话列表点进来的（← 用 router.back 回列表）

const REQ = "requests";      // 伪会话分组键（消息请求）

/* 轮 142 · 分段口径（一体化私信页）：
 *  - 手机形态（三段，原样不动）：漂流瓶 | 会话 | 通知
 *  - 桌面形态（两段，参考图）：会话 | 漂流瓶 —— 两段**各自单开聊天框**（会话=dm-thread，
 *    漂流瓶=BottleChat），不共用；通知不进桌面私信页（顶栏铃铛/通知页仍可达）。
 * 进聊天/回列表强制回「会话」段。 */
const seg = ref("dm");
const dmBadge = computed(() => badge.dm + badge.requests);

/* T7 系统返回键：漂流瓶/通知段是消息 Tab 的**内部层级** → 先回会话段（App 惯例），
 * 已被接管则不再回退路由/最小化 App；离开本页弹栈。
 * 说明：聊天页共用「消息」Tab，但那时 seg 恒为 dm，这里返回 false 交回默认策略。 */
function segBack() {
  if (seg.value === "dm") return false;
  seg.value = "dm";
  return true;
}
const meId = computed(() => (cloud.user && cloud.user.id) || "");

/* #15 点头像/名字进对方主页（列表行与聊天头部共用） */
function goUser(id) {
  if (id) router.push({ name: "waller", params: { id } });
}

/* 常规会话 / 消息请求 分组（被拉黑的会话在 rowView 里把未读清零）。
 * 轮 238：拉黑的会话**即时从列表隐藏**（服务端 dm_list_convs 同口径）——
 * 过滤以全站拉黑权威名单 isBlocked 为准（响应式；冷启动用快照、refreshBlocks 校准），
 * 行上的乐观标志只作补充——SWR 缓存快照里的行 blocked 是旧值，只看行标志会漏（用户实测）。 */
const normal = computed(() => sortConvs(filterConvs(convs.value.filter((c) => c.accepted !== false && !c.blocked && !isBlocked(c.other_id)), q.value)).map(rowView));
const requests = computed(() => sortConvs(filterConvs(convs.value.filter((c) => c.accepted === false && !c.blocked && !isBlocked(c.other_id)), q.value)).map(rowView));

/* 轮 268：行未读 = max(列表权威值, badge 行级映射)——badge 请求（30s 轮询 + 角标本地缓存
 * 秒出）比会话列表快，映射先到就先亮红点（修「顶/底红点都在，中间行红点等好几秒才出现」）。
 * 两边都来自服务端权威时刻；openConv/轮询清行时两者同步清，max 不会让红点复活。 */
function rowUnread(c) {
  const a = Number(c.unread) || 0;
  const b = Number((badge.dmConvs || {})[String(c.conv_id)]) || 0;
  return Math.max(a, b);
}

/* 带日期分隔的消息流 */
const flow = computed(() => withDayDividers(msgs.value.map(displayMsg)));

const activeConv = computed(() =>
  convs.value.find((c) => String(c.conv_id) === String(activeId.value)) || null);
const title = computed(() =>
  (meta.value && meta.value.nickname) || (activeConv.value && activeConv.value.nickname) || "");

/* 轮 142 · 桌面「漂流瓶」段状态（与会话段各自独立、不共用聊天框） */
const bottleRow = ref(null);     // 左列选中的信（bottle_letters 行）
const bottleName = ref("");      // 该信的对方昵称（左列解析后带回；空 = 走兜底文案）
const bottleMeta = ref({});      // 已建会话时的会话元信息（免打扰/拉黑与会话段同源）

/* 头部「…」菜单的数据源：随「当前段 + 当前选中的人」变（会话段看会话；漂流瓶段看这封信的人） */
const dmPeer = computed(() => {
  const c = activeConv.value || meta.value || {};
  return {
    user_id: c.other_id || "", nickname: title.value || "",
    muted: !!c.muted, blocked: !!c.blocked, conv_id: activeId.value,
  };
});
const bottlePeer = computed(() => {
  const l = bottleRow.value || {};
  const m = bottleMeta.value || {};
  const uid = l.user_id === meId.value ? (l.reply_by || "") : (l.user_id || "");
  return {
    user_id: m.other_id || uid, nickname: m.nickname || bottleName.value || "",
    muted: !!m.muted, blocked: !!m.blocked, conv_id: m.conv_id || l.conv_id || "",
  };
});
const curPeer = computed(() => (seg.value === "bottle" ? bottlePeer.value : dmPeer.value));
const peerInitial = computed(() => (curPeer.value.nickname || "?").slice(0, 1).toUpperCase());
/* 菜单的操作对象：会话段=当前会话；漂流瓶段=该信已建的会话（还没会话就不出动作按钮） */
const curConv = computed(() =>
  convs.value.find((c) => String(c.conv_id) === String(curPeer.value.conv_id)) || null);
/* 轮 143 · 中列头部右上角「…」菜单（原右列资料卡内容迁入，只在桌面渲染） */
const headMenu = ref(false);
watch(seg, () => { headMenu.value = false; });
/* 轮144：点菜单外空白处自动关（菜单内各项点击已各自 headMenu=false；
 * 文档级 pointerdown 兜住页面任意位置——列表/滚动区/输入框/另一侧都算“空白”） */
function onDocPointerDown(e) {
  /* 轮 209：会话行 ⋯ 菜单同样点空白关——轮 197 把全部操作收进 ⋯ 后高频使用，
   * 之前只有头部菜单有点空白关，列表行的菜单点哪儿都不收（用户实测）。 */
  if (menuFor.value) {
    const t = e.target;
    const inMenu = t && t.closest && (t.closest(".dm-menu") || t.closest(".dm-more"));
    if (!inMenu) menuFor.value = "";
  }
  if (!headMenu.value) return;
  if (e.target && e.target.closest && e.target.closest(".dm-head-tools")) return;
  headMenu.value = false;
}

/* 是否可以直接发：对方不是待处理请求、双方都没拉黑 */
const canType = computed(() => {
  if (!activeId.value) return false;
  const c = activeConv.value || meta.value || {};
  if (c.blocked) return false;
  /* 轮 238：以全站拉黑权威名单为准（换设备/冷启动后行标志可能是缓存旧值） */
  if (isBlocked(c.other_id || c.user_id)) return false;
  if (c.accepted === false) return false;
  return true;
});
const blockedByMe = computed(() =>
  !!(activeConv.value || meta.value || {}).blocked
  || isBlocked((activeConv.value && activeConv.other_id) || (meta.value && meta.value.other_id)));

/* #19 已拉黑列表：集中查看、逐个解除（RPC dm_blocks / dm_unblock；拉黑本身零通知） */
const showBlocked = ref(false);
const blockedRows = ref([]);
const blockedBusy = ref("");
async function loadBlocked() {
  try { blockedRows.value = (await dmApi.blocks()) || []; }
  catch (e) { blockedRows.value = []; }
}
async function unblockOne(b) {
  blockedBusy.value = b.user_id;
  /* 轮 238 · 乐观更新：行先从面板消失；失败放回原位。
   * 会话行的拉黑态也同步翻（响应式，列表过滤立即生效），隐式刷新只做兜底。 */
  const idx = blockedRows.value.findIndex((x) => x.user_id === b.user_id);
  const removed = idx >= 0 ? blockedRows.value.splice(idx, 1)[0] : null;
  const convRow = convs.value.find((x) => x.other_id === b.user_id);
  if (convRow) convRow.blocked = false;
  try {
    /* 轮 34：走 userBlocks 包装 —— 私信名单与暖心墙内容过滤缓存同步更新，
       解除后 TA 的帖子/评论在墙里立刻恢复显示，不用刷新页面 */
    await unblockUser(b.user_id);
    loadConvsImplicit();   /* 解除后会话恢复可见（后台兜底，不挡操作反馈） */
  } catch (e) {   /* 静默回滚 */
    if (removed) blockedRows.value.splice(Math.min(idx, blockedRows.value.length), 0, removed);
    if (convRow) convRow.blocked = true;
  }
  finally { blockedBusy.value = ""; }
}
function toggleBlockedPanel() {
  showBlocked.value = !showBlocked.value;
  if (showBlocked.value) loadBlocked();
}

/* ─────────── 数据加载 ─────────── */

/* 轮 238 · 拉黑行保留（tombstone）：服务端 dm_list_convs **不返回**被拉黑的会话，
 * 若刷新时直接整体替换 convs，解除拉黑时本地已无行可恢复（只能等服务端再刷）= 不跟手。
 * 这里把「本地已拉黑、服务端没返回」的行（带完整 conv_id）拼回去——它们被 normal/
 * requests 过滤着不可见，解除拉黑即时恢复。 */
function withBlockedTombstones(rows) {
  const served = new Set((rows || []).map((r) => r.conv_id));
  const extra = convs.value.filter((c) => c.blocked && !served.has(c.conv_id));
  return extra.length ? (rows || []).concat(extra) : rows;
}

async function loadConvs() {
  if (!signedIn.value) return;
  loadingConvs.value = true;
  /* 本地优先（SWR）：有缓存先渲染不闪「载入中」，后台刷新；换账号靠 key 里的 uid 隔离 */
  await swr(
    cacheKey("dm:convs", meId.value),
    {
      cached: (rows) => { convs.value = withBlockedTombstones(rows); loadingConvs.value = false; },
      fresh: (rows) => {
        convs.value = withBlockedTombstones(rows);
        failed.value = false;
        convsLoaded.value = true;   /* 服务端明确应答（含空列表）——「还没有会话」从此刻起才可信 */
        convsRetryN = 0;            /* 成功即停快速重试 */
      },
      onError: () => { failed.value = true; scheduleConvsRetry(); },
    },
    () => dmApi.listConvs(200, 0),
  );
  loadingConvs.value = false;
}

/* 轮 266：网络失败快速重试（旧版失败后要等 15s 后的轮询才可能恢复，
 * 期间列表显示「还没有会话」= 用户看到的「假空」）。3s 一试、最多 3 次，成功即停。 */
let convsRetryN = 0;
let convsRetryTimer = 0;
function scheduleConvsRetry() {
  if (convsRetryN >= 3 || convsRetryTimer) return;
  convsRetryN += 1;
  convsRetryTimer = setTimeout(() => { convsRetryTimer = 0; loadConvs(); }, 3000);
}

async function openBottleChat(id) {
  /* 轮 238：**先开聊天**（本地库秒开），列表刷新转后台——
   * 旧版 await loadConvs() 挡在前面，用户实测「慢的要死，不是存本地吗」：
   * 存了本地也被会话列表的网络刷新堵死。列表数据由后台刷新补齐。 */
  openConv(String(id));
  loadConvs();
}

async function loadMeta(id) {
  try { meta.value = await dmApi.convMeta(id); } catch (e) { /* 用列表里的行兜底 */ }
}

async function loadMessages(id, { before = null } = {}) {
  if (!id) return false;
  /* 轮 225：本轮的号 —— await 回来后若号被顶掉、或用户已切走，这份数据整份丢弃 */
  const mySeq = ++msgSeq;
  const cid = String(id);
  const stale = () => isStale(mySeq, cid);
  /* 轮 214：切会话先清屏——上一个会话的消息只要还留在 msgs 里，任何时序竞态
   * （本地库为空的会话、网络慢、硬上限兜底揭示）都会让它闪出来
   * （用户实测「打开另一个会话有时跳闪前一个会话的内容」）。结构上清零，永绝后患。 */
  if (msgsConv !== cid) {
    msgs.value = [];
    oldestId.value = null;
    hasMore.value = true;
  }
  let smoothed = false;   /* 轮 173c：fresh 有新消息时已平滑滚到新底，调用方免再瞬时滚 */
  loadingMsgs.value = true;
  const applyRows = (rows, more) => {
    if (stale()) return false;   /* 轮 225：过期响应绝不落进列表（这是串会话的直接入口） */
    /* 服务端返回新→旧：反转为旧→新（渲染顺序） */
    const asc = rows.slice().reverse();
    if (before == null || msgsConv !== id) {
      msgs.value = asc;
    } else {
      /* 轮 157：向上翻历史的锚点保持——先量高、插行、下一帧把 scrollTop 补上差值。
       * 不补的话浏览器把视口钉在原 scrollTop 上，内容凭空「跳」一页；
       * 临时关平滑滚动，防浏览器动画与人锚点打架。 */
      const el = listEl.value;
      const oldH = el ? el.scrollHeight : 0;
      msgs.value = asc.concat(msgs.value);
      if (el) requestAnimationFrame(() => {
        const prevSb = el.style.scrollBehavior;
        el.style.scrollBehavior = "auto";
        el.scrollTop += el.scrollHeight - oldH;
        el.style.scrollBehavior = prevSb || "";
      });
    }
    msgsConv = cid;
    hasMore.value = more != null ? more : rows.length === 30;
    oldestId.value = msgs.value.length ? msgs.value[0].id : null;
    return true;
  };
  /* ── 轮 194：本地库秒开——进会话瞬间渲染本地完整历史（零网络等待、零闪跳）──
   * 193c 去掉缓存中间态后首次进入要等网络（用户实测 ~10s 空白）——
   * 正解是微信式本地库：localStorage 持久存每会话全量消息，进会话同步读取渲染。 */
  if (before == null) {
    const local = dmStoreLoad(meId.value, cid);
    if (local.msgs.length) {
      if (!applyRows(local.msgs.slice().reverse(), local.more)) return false;   /* 轮 225：已过期就别继续 */
      entryReady.value = true;   /* 轮 194：本地数据已落定，揭示门控即刻可开 */
      /* 轮 228 · 秒开：本地库命中的是**该会话的完整历史**（最多 400 条），此刻已同步渲染完毕，
       * ── 这就是「微信式秒开」该有的样子。不再去等「字体就绪 + 高度连续 hold ms」那道门：
       * 那道门是轮 176/180 为「30 条缓存窗口被 fresh 窗口整窗替换、高度 ±千 px」准备的，
       * 而本地库路径根本不存在整窗替换（网络回来只走 mergeTail 往尾部并）。
       * 用户实测反馈：本地库明明已经读出来了，点进会话却还要楞一下 —— 就是被这道门挡住的。
       * 注意必须走 scrollBottom 的 reveal 参数（钉底与揭示同一帧），不能在这里直接置 true，
       * 否则会先亮出列表顶部再跳到底（真机实测首帧距底 4649px）。 */
      scrollBottom(false, true);
      loadingMsgs.value = false;
    }
  }
  /* ── 网络：增量拉取后合并（不替换渲染中的列表）── */
  try {
    if (before != null) {
      /* 轮 204：翻历史优先吃本地全量库（IndexedDB）——本地有就直接补页，零网络零等待 */
      const idbRows = await idbOlderThan(cid, before, 30);
      if (stale()) return false;   /* 轮 225 */
      if (idbRows.length >= 5) {
        if (!applyRows(idbRows, true)) return false;   /* 本地页假设还有更早（网络层仍有则后续再补） */
        dmStoreSave(meId.value, cid, msgs.value, hasMore.value);
        loadingMsgs.value = false;
        return smoothed;
      }
    }
    const rows = (await dmApi.listMessages(cid, { before, limit: 30 })) || [];
    /* 轮 225：等响应这段就是竞态窗口 —— 用户可能已经返回列表或点开了别的会话。
     * 过期就整份丢弃：不写列表、不落本地库、不触发回填（否则会把 A 的消息存进 B 的库）。 */
    if (stale()) return false;
    const asc = rows.slice().reverse();
    if (before != null) {
      if (!applyRows(rows, rows.length === 30)) return false;
      idbMerge(cid, rows, { older: true });   /* 轮 204：网络历史页镜像进全量库 */
    } else if (msgsConv === cid && !msgs.value.some((m) => m.id < 0)) {
      /* 重开/刷新同会话：尾部增量并入（保住已翻历史），不整窗替换 */
      const { rows: merged, added } = mergeTail(msgs.value, asc);
      if (added) {
        pinning.value = false;
        scrollGen++;
        smoothed = true;
        msgs.value = merged;
        nextTick(() => { const el = listEl.value; if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }); });
      } else if (merged !== msgs.value) {
        /* 无新增但有原位更新（如对方撤回）：落回响应式数组。
         * 注意必须比对 mergeTail 的返回值——比对原始 rows 会把服务端倒序窗口塞进列表（轮194实测bug）。 */
        msgs.value = merged;
      }
      oldestId.value = msgs.value.length ? msgs.value[0].id : null;
    } else {
      if (!applyRows(rows, rows.length === 30)) return false;
      entryReady.value = true;   /* 轮 194：首进无本地库，网络落定即开揭示门控 */
    }
    if (stale()) return false;   /* 轮 225：落库前再确认一次 —— 防把 A 的消息写进 B 的本地库 */
    /* 本地库同步（全量落盘） */
    dmStoreSave(meId.value, cid, msgs.value, hasMore.value);
    idbMerge(cid, msgs.value);   /* 轮 204：镜像进全量库 */
    if (before == null) backfillOlder(cid);   /* 轮 204：静默回填更早历史（只写库不进 UI） */
  } catch (e) {
    if (stale()) return false;   /* 轮 225 */
    if (before == null && msgsConv !== cid) applyRows([], false);
  }
  if (stale()) return false;   /* 轮 225：过期时连 loadingMsgs/pinning 都不要碰（新请求在管） */
  loadingMsgs.value = false;
  if (before == null) pinning.value = false;
  return smoothed;
}

/* ── 轮 204 · 后台回填：把该会话服务器侧的更早历史分页拉全、只写 IndexedDB（不进 UI）。
 * 断点：backfilledTo（已回填到的最旧 id）；跑完置 serverDone=true 永久跳过。
 * 节流：每页 sleep 120ms；单次进会话最多 40 页（防失控），没拉完下次进会话续传。 */
const backfillBusy = new Set();
async function backfillOlder(convId) {
  if (backfillBusy.has(String(convId))) return;
  backfillBusy.add(String(convId));
  try {
    if (await idbServerDone(convId)) return;
    let watermark = null;
    for (let page = 0; page < 40; page++) {
      if (String(activeId.value) !== String(convId) && msgsConv !== convId) return;   /* 已离开该会话 */
      const rows = (await dmApi.listMessages(convId, { before: watermark, limit: 50 })) || [];
      if (!rows.length) { await idbMerge(convId, [], { serverDone: true }); return; }
      await idbMerge(convId, rows, { older: true });
      watermark = rows[rows.length - 1].id;   /* rows 新→旧，末条最旧 */
      if (rows.length < 50) { await idbMerge(convId, [], { serverDone: true }); return; }
      await new Promise((r) => setTimeout(r, 120));
    }
  } catch (e) { /* 静默：下次进会话续传 */ }
  finally { backfillBusy.delete(String(convId)); }
}

function scrollBottom(smooth = false, reveal = false) {
  nextTick(() => {
    const el = listEl.value;
    if (!el) { if (reveal) listRevealed.value = true; return; }   /* 没有容器就无所谓位置 */
    /* 轮 173：落地后连续几帧追钉底部——字体/内容晚到会把已排好的消息撑高，
     * 只滚一次会停在「中间」（用户实测：记录多了进会话落在半截）。
     * 用户一旦上滑（触摸/滚轮）立即停追，不打扰回看。 */
    userScrolling.value = false;
    const gen = ++scrollGen;   /* 轮 176b：新滚动链作废旧链——平滑滚动时不被追帧的瞬时重钉顶掉 */
    let frames = 0;
    /* 轮 196：挂载初期容器/内容高度未定型，会出现「内容恰好装满容器」的矮平台
     * （gap=0、高度稳定）——按旧条件会立即揭示，随后内容数倍展开 = 可见顶部闪帧
     * （线上逐帧实测 t≈+30ms 一帧）。前 40 帧不把平台当稳定；真短会话靠硬上限兜底。 */
    const plateau = () => el.scrollHeight <= el.clientHeight + 24 && frames < 40;
    const set = () => {
      el.scrollTop = el.scrollHeight;
      /* 轮 203：set() 只钉底、**永不揭示**——布局震荡期的瞬态钉稳（gap<4）会骗过即时揭示，
       * 随后内容继续重排 = 可见跳变（真机逐帧实测 sh 六段震荡 524→2682→1611→2659→2600→1786→1706）。
       * 揭示唯一通道 = chase 里「稳定持续 300ms」。 */
    };
    set();
    /* 轮 173b：进会话期间持续钉底（pinning）——旧缓存先落底、网络回来新消息把底撑下去，
       就会出现「停在中间一下再跳底部」的两段式落地；钉住后新消息落进来视线跟着走，无停顿 */
    /* 轮 193d：确定性状态机——隐藏期每帧钉底；「字体完成 + 高度连续 3 帧不变」
     * 双条件同时满足才揭示。任何单帧错位（字体换装/数据替换/重排）都发生在隐藏期，
     * 用户可见的第一帧必然已在最新位置。 */
    let stableFrames = 0;
    let lastH = -1;
    let stableSince = 0;
    const chase = () => {
      if (gen !== scrollGen) return;                   /* 已有新链（如平滑滚动）接管 */
      if (userScrolling.value) return;                 /* 用户上滑：立即停，不打扰回看 */
      if (frames > 600) { listRevealed.value = true; return; }   /* 硬上限 ~10s，防异常永藏 */
      set();
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
      /* 轮 238：字体静默也入稳定判据——分块加载的间隙 sh 会短暂不动，莫当真 */
      const settled = fontQuiet() && fontsOk() && entryReady.value && el.scrollHeight === lastH && !plateau() && gap < 4;
      lastH = el.scrollHeight;
      if (settled) stableFrames++; else stableFrames = 0;
      if (settled && !stableSince) stableSince = performance.now();
      if (!settled) stableSince = 0;
      /* 轮 205 → 轮 238：揭示等待自适应——字体静默且页面已活过 2.5s → 80ms 快车道
       * （微信式秒开）；字体仍在分块到达 → 300ms 保守（后段位移吞进隐藏期）。 */
      const hold = (fontQuiet() && performance.now() > 2500) ? 80 : 300;
      if (stableSince && performance.now() - stableSince >= hold && !listRevealed.value) listRevealed.value = true;
      frames++;
      requestAnimationFrame(chase);
    };
    if (smooth && el.scrollTo) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    requestAnimationFrame(chase);
    /* 轮 228 · 秒开揭示：**确认真的贴底了再亮**。
       为什么不能简单地在 set() 后面直接置 true：set() 执行时 DOM 刚 patch、内容高度还没
       展开完，scrollTop 会被夹回 0（真机实测揭示首帧 st=0 sh=5375 gap=4649 —— 等于先给
       用户看一眼列表顶，下一帧才跳到底，比慢更糟）。
       这里自己每帧钉底，**等到 gap<4 的那一帧才揭示** —— 揭示与钉底同帧，亮出来就在最新消息。
       本循环轮 249 起挂 scrollGen：旧版刻意不挂，但快速进出会话时上一轮的揭示循环还活着，
       会把新一轮还在钉稳期的页面提前揭示（真机 ~7% 概率间歇跳闪）；60 帧兜底保留。 */
    if (reveal) {
      let rf = 0, lastSh = -1, sameSh = 0;
      const myGen = scrollGen;   /* 轮 249：新一轮滚动链启动即作废旧揭示循环（快速进出的间歇跳闪源） */
      const revealWhenPinned = () => {
        if (myGen !== scrollGen) return;   /* 新链已接管 */
        if (listRevealed.value) return;
        const e2 = listEl.value;
        if (!e2) { listRevealed.value = true; return; }
        e2.scrollTop = e2.scrollHeight;
        const sh = e2.scrollHeight;
        const g = sh - e2.scrollTop - e2.clientHeight;
        /* 「高度连续 2 帧不变」= 内容已定型，这一步不能省：
           刚 patch 完的瞬间内容还没铺开，scrollHeight 只是「刚好装满容器」的矮值，
           此时 gap 天然为 0 —— 假贴底。真机实测就是被它骗过：判据认为已到底 → 揭示 →
           下一帧内容展开成 5375px，画面其实停在顶部（首帧距底 4649px）。
           内容定型后再确认 gap<4，亮出来才是真的最新消息。
           轮 238：还要字体静默——长消息的文楷分块在两批之间 sh 会短暂不动，
           「2 帧稳定」被假象骗过 → 揭示后继续重排 = 闪现又跳没（用户实测）。
           短会话（本来就不够一屏）同样会很快定型 + gap=0，一样秒开；
           60 帧（~1s）兜底优先于字体静默，绝不把消息区永久藏住。 */
        if (sh === lastSh) sameSh++; else { sameSh = 0; lastSh = sh; }
        if (((sameSh >= 2 && g < 4) && fontQuiet()) || ++rf > 60) { listRevealed.value = true; return; }
        requestAnimationFrame(revealWhenPinned);
      };
      requestAnimationFrame(revealWhenPinned);
    }
  });
}

/* 轮 157：触顶自动翻历史——rAF 节流 + passive 监听，滚到顶 140px 内自动拉上一批；
 * 「加载更早」按钮保留（可见的 loading 态兜底）。 */
let topRaf = 0;
function onScrollTop() {
  if (topRaf) return;
  topRaf = requestAnimationFrame(() => {
    topRaf = 0;
    /* 轮 196：入场布局竞态会有一瞬 scrollTop=0——那不是用户在回看，是钉底还没落。
     * 入场机（追底中/未揭示）期间不自动翻历史，否则每次进会话都误跑一趟翻历史，
     * 网络回来再全列表重渲染 = 第二次可见跳变（逐帧实测 t≈+1.4s 第二波闪）。 */
    if (pinning.value || !listRevealed.value) return;
    const el = listEl.value;
    if (!el || loadingMsgs.value || !hasMore.value || !oldestId.value || !activeId.value) return;
    if (el.scrollTop < 140) loadMessages(activeId.value, { before: oldestId.value });
  });
}

async function openConv(id) {
  seg.value = "dm";
  menuFor.value = "";
  headMenu.value = false;
  const same = String(activeId.value) === String(id);
  activeId.value = String(id);
  /* 轮 254 · 红点跟手：进会话那一刻就把本地行未读清零 + 导航角标同步递减（0ms 跟手），
   * 网络 markRead → refreshBadge 只做服务端校正（失败也不影响观感，下轮轮询自愈）。
   * 不等 loadMessages/网络往返，用户「点进去马上返回」红点也已经消了。
   * 轮 268：行未读的乐观来源有两个（列表行值 + badge 行级映射），取 max 才是「用户
   * 眼睛看到的未读」——只按行值减会漏掉「快照旧、映射新」的场景；映射一并清掉防复活。 */
  {
    const row = convs.value.find((c) => String(c.conv_id) === String(id));
    const fromRow = row && Number(row.unread) > 0 ? Number(row.unread) : 0;
    const fromMap = Number((badge.dmConvs || {})[String(id)]) || 0;
    const lost = Math.max(fromRow, fromMap);
    if (row && lost) row.unread = 0;
    if (lost) badgeLocal({ dm: Math.max(0, badge.dm - lost) });
    badgeDmConvPatch(id, 0);
  }
  /* 双形态导航（微信式）：
   *  - 手机形态：聊天是独立整屏页 → push，历史保留列表 → ← 钮 / 系统返回键都能回列表；
   *  - 桌面形态：列表与聊天同页双列 → replace，点会话不污染浏览器历史（原行为不变）。 */
  if (isMobileNav.value) {
    if (!same) fromList.value = true;
    router.push({ name: "messages", params: { id: String(id) } }).catch(() => {});
  } else {
    router.replace({ name: "messages", params: { id: String(id) } }).catch(() => {});
  }
  meta.value = null;
  /* 轮 238：meta 拉取不再阻塞本地库渲染——标题等 meta 回来后响应式补上。
   * 旧版 await loadMeta 把「本地秒开」堵在一个网络请求后面（漂流瓶/深链进入尤其明显）。 */
  if (!convs.value.some((c) => String(c.conv_id) === String(activeId.value))) {
    loadMeta(activeId.value);
  }
  pinning.value = true;   /* 轮 173b：进会话钉底，直到首屏数据落定 */
  listRevealed.value = false;   /* 轮 176：消息区先隐，钉底稳了再显示（防首帧错位跳闪） */
  entryReady.value = false;     /* 轮 180：显示门控重置——等 fresh 数据落定 */

  /* 轮 180 → 238：兜底只揭示已落定的；揭示前先同步钉一次底（否则 2s 兜底亮出
   * 来的可能还是顶部/半截位置 —— 长消息 + 字体震荡时尤其如此），亮出来的就是最新消息。
   * 轮 249（用户实测「快速点击偶发一闪而过」）：必须清掉上一轮的兜底 —— 快速进出会话时
   * 旧 setTimeout 照常触发，把新一轮还在钉稳期的页面提前揭示 = 间歇跳闪（~7% 概率）。 */
  clearTimeout(entryFallback);
  entryFallback = setTimeout(() => {
    if (entryReady.value && !listRevealed.value) {
      const el2 = listEl.value;
      if (el2) el2.scrollTop = el2.scrollHeight;
      listRevealed.value = true;
    }
  }, 2000);   /* 轮 180：兜底只揭示已落定的 */
  const smoothed = await loadMessages(id);
  /* 轮 225：等消息期间用户又点了别的会话 / 返回了列表 → 别再动滚动与已读标记
   * （否则会用旧会话的落点把新会话的屏滚乱，这是「切完位置乱跳」的另一半）。 */
  if (String(activeId.value) !== String(id)) return;
  if (!smoothed) scrollBottom();   /* 有新消息时已平滑滚过，不再瞬时跳 */
  /* 轮 254：先等「已读」落库再刷角标（旧写法两个并发发，读还没写进去就拉 → 拉回旧值，
   * 红点要等下一轮 30s 轮询才消 —— 用户实测「点进去马上返回，红点不跟手」）。 */
  refreshBadge({ after: dmApi.markRead(id).catch(() => {}) });
}

/* ← 返回会话列表（手机形态）：从列表点进来 → 退一步（不留多余历史）；
 * 直链进来（通知中心 / 瓶子记录）→ 直接跳列表。 */
function backToList() {
  if (fromList.value) {
    fromList.value = false;
    router.back();
    return;
  }
  router.push({ name: "messagesList" }).catch(() => {});
}

/* ─────────── 发送 / 撤回 ─────────── */

async function send() {
  /* 轮 229：发送中不再把按钮置 disabled（点了发送瞬间 body 会被清空，:disabled 随即为真，
     Naive 就把整颗按钮调淡 —— 转圈挂在淡色底上很别扭，用户反馈「不协调」）。
     防重复发送改由这里挡：loading 态的 n-button 点击仍会派发 click。 */
  if (sending.value) return;
  const err = validateSend(body.value, null);
  if (err) { sendErr.value = t(err); return; }
  const text = body.value.trim();
  const convId = activeId.value;
  body.value = "";
  sendErr.value = "";
  sending.value = true;
  /* 乐观上屏：临时 id 为负，服务端确认后整段重载 */
  const temp = {
    id: -Date.now(), sender: meId.value, body: text, image_path: null,
    created_at: new Date().toISOString(), pending: true,
  };
  msgs.value = msgs.value.concat([temp]);
  scrollBottom(true);
  try {
    const r = await dmApi.send(convId, text, null);
    /* 轮 157：dm_send 直接回传 {msg_id, created_at} → 就地把乐观行换成正式行，
     * 不再整段重载 30 条（发送到「已发」少一次网络往返，弱网尤其明显） */
    const mid = r && r.msg_id;
    /* 轮 225：发送期间用户可能已经切走 —— 那时 msgs 装的是别人的消息，
     * 绝不能拿它去改列表 / 落库（会把 B 的消息写进 A 的本地库）。 */
    const onSameConv = String(activeId.value) === String(convId);
    if (mid != null) {
      if (onSameConv) {
        const rowSrv = {
          id: mid, sender: meId.value, body: text, image_path: null,
          created_at: r.created_at || temp.created_at, deleted_at: null,
        };
        msgs.value = msgs.value.map((m) => (m.id === temp.id ? rowSrv : m));
        oldestId.value = msgs.value.length ? msgs.value[0].id : null;
        /* 轮 194：本地库同步补上这条（不补的话退出重进会先看到本地库少一条） */
        dmStoreSave(meId.value, convId, msgs.value, hasMore.value);
        idbMerge(convId, msgs.value);   /* 轮 204：发送镜像全量库 */
      }
    } else if (onSameConv) {
      await loadMessages(convId);   /* 兜底：拿不到 msg_id（异常网关）才走整段重载 */
    }
    if (onSameConv) scrollBottom(true);
    const row = convs.value.find((c) => String(c.conv_id) === String(convId));
    if (row) { row.last_preview = text.slice(0, 80); row.last_message_at = new Date().toISOString(); }
    refreshBadge();
  } catch (e) {
    if (onSameConv) msgs.value = msgs.value.map((m) => (m.id === temp.id ? { ...m, pending: false, failed: true } : m));
    sendErr.value = t(sendErrKey(e));
  }
  sending.value = false;
}

async function recall(m) {
  const convId = String(activeId.value);   /* 轮 225：先捕获归属会话——切走后就别再动当前列表/落库 */
  try {
    await dmApi.recall(m, meId.value);
    if (String(activeId.value) === convId) {
      msgs.value = msgs.value.map((x) =>
        (x.id === m.id ? { ...x, deleted_at: new Date().toISOString(), body: "", image_path: null } : x));
      dmStoreSave(meId.value, convId, msgs.value, hasMore.value);   /* 轮 194：撤回落盘 */
      idbMerge(convId, msgs.value);   /* 轮 204：撤回镜像全量库 */
    }
  } catch (e) {
    const late = e && String(e.message || e).includes("too-late");
    sendErr.value = t(late ? "dm.errTooLate" : "dm.errNetwork");
  }
  menuFor.value = "";
}

/* ────────── 会话操作：请求 / 免打扰 / 隐藏 / 拉黑 ─────────── */

async function acceptReq(c) {
  /* 轮 238 · 乐观更新：本地状态先落（按钮先消失、行先进「会话」组），网络只做确认，
   * 失败回滚 —— 旧写法 await 完才改界面，弱网点一下半天没动静（用户实测「不跟手」）。
   * 改的必须是 convs.value 里的原始行（rowView 展示拷贝不回流不响应，轮 197 结论）。 */
  const row = convs.value.find((x) => String(x.conv_id) === String(c.conv_id));
  if (row) row.accepted = true;
  if (meta.value && String(meta.value.conv_id) === String(c.conv_id)) meta.value.accepted = true;
  /* 轮 254：请求数角标本地先减（乐观跟手），网络落库后再拉服务端权威值校正。
     旧写法 refreshBadge 在 accept 之前并发发 —— 读还没写进去，角标不动。 */
  badgeLocal({ requests: Math.max(0, badge.requests - 1) });
  try { await dmApi.accept(c.conv_id); }
  catch (e) {   /* 静默回滚成请求态 */
    if (row) row.accepted = false;
    if (meta.value && String(meta.value.conv_id) === String(c.conv_id)) meta.value.accepted = false;
    badgeLocal({ requests: badge.requests + 1 });
  }
  refreshBadge();
}

async function rejectReq(c) {
  /* 轮 238 · 乐观更新：行先消失；失败插回原位（本地库等清空留到确认成功后） */
  const idx = convs.value.findIndex((x) => String(x.conv_id) === String(c.conv_id));
  const removed = idx >= 0 ? convs.value.splice(idx, 1)[0] : null;
  /* 轮 254：拒绝 = 请求态消一个 → 角标本地先减；落库后校正（旧写法 refresh 在 hide 之前发） */
  badgeLocal({ requests: Math.max(0, badge.requests - 1) });
  try {
    await dmApi.hide(c.conv_id);
    dmStoreDrop(meId.value, c.conv_id);   /* 轮 194：会话移出列表即清本地库 */
    idbDrop(c.conv_id);   /* 轮 204：全量库同清 */
  } catch (e) {   /* 静默回滚 */
    if (removed) convs.value.splice(Math.min(idx, convs.value.length), 0, removed);
    badgeLocal({ requests: badge.requests + 1 });
  }
  refreshBadge();
}

async function toggleMute(c) {
  const on = !c.muted;
  menuFor.value = "";
  /* 轮 238 · 乐观更新：🔇 图标先翻，网络只做确认；失败回滚。
   * 旧写法两个毛病：await 完才改 + 改的是 rowView 拷贝（不响应式），
   * 结果弱网点完没动静、图标要等下轮列表刷新才出现（用户实测「不跟手」）。 */
  const row = convs.value.find((x) => String(x.conv_id) === String(c.conv_id));
  if (row) row.muted = on;
  try { await dmApi.mute(c.conv_id, on); }
  catch (e) { if (row) row.muted = !on; }
}

async function hideConv(c) {
  menuFor.value = "";
  /* 轮 238 · 乐观更新：行先消失、聊天页先退出；失败插回原位。本地库清理等确认成功再做。 */
  const idx = convs.value.findIndex((x) => String(x.conv_id) === String(c.conv_id));
  const removed = idx >= 0 ? convs.value.splice(idx, 1)[0] : null;
  if (String(activeId.value) === String(c.conv_id)) {
    activeId.value = "";
    router.replace({ name: "messagesList" }).catch(() => {});
  }
  try {
    await dmApi.hide(c.conv_id);
    dmStoreDrop(meId.value, c.conv_id);   /* 轮 194：会话移出列表即清本地库 */
    idbDrop(c.conv_id);   /* 轮 204：全量库同清 */
    refreshBadge();       /* 轮 254：挪到落库之后（旧写法在写之前并发发，拉回旧值） */
  } catch (e) {   /* 静默回滚 */
    if (removed) convs.value.splice(Math.min(idx, convs.value.length), 0, removed);
  }
}

async function toggleBlock(c) {
  /* 轮 238 · 乐观更新：行上的拉黑态先翻（未读清零/列表过滤立即生效），菜单先收，
   * 网络只做确认；失败回滚。列表刷新降级为后台隐式刷（不再 await 挡住操作反馈）。 */
  const row = convs.value.find((x) => String(x.conv_id) === String(c.conv_id));
  const wasBlocked = !!(row ? row.blocked : (activeConv.value || meta.value || {}).blocked);
  menuFor.value = "";
  if (row) row.blocked = !wasBlocked;
  try {
    /* 轮 34：拉黑=全站生效（私信 + 暖心墙内容过滤），缓存同步走 userBlocks */
    if (wasBlocked) await unblockUser(c.other_id);
    else await blockUser(c.other_id);
  } catch (e) {   /* 静默回滚 */
    if (row) row.blocked = wasBlocked;
  }
  loadConvsImplicit();
  refreshBadge();
}

/* ─────────── 轮 142/143 · 漂流瓶段（桌面）：选中/同意/头部菜单操作 ─────────── */

/* 左列点一封信 → 中列 BottleChat 独立渲染（不碰会话段的 activeId） */
function pickBottle(row, name) {
  bottleRow.value = row;
  bottleName.value = name || "";
  bottleMeta.value = {};
  headMenu.value = false;
}

/* 同意聊天 → 数据库建会话：把新会话带进「会话」段列表 + 刷红点（中列继续停在漂流瓶聊天框） */
async function onBottleAccepted(convId) {
  await loadConvs();
  /* 轮 254：等「已读」落库再校正角标（旧写法 markRead 不 await 就 refresh，并发拉回旧值，
     红点要等下一轮 30s 轮询才消）。 */
  refreshBadge({ after: convId ? dmApi.markRead(convId).catch(() => {}) : null });
}

/* BottleChat 回传的人/会话信息（convMeta 或兜底名字）——头部「…」菜单据此显示 */
function onBottlePeer(info) {
  if (!info) return;
  if (info.nickname) bottleName.value = info.nickname;
  bottleMeta.value = { ...(bottleMeta.value || {}), ...info };
}

/* 资料卡的两个动作：有会话行就复用会话段的 toggleMute/toggleBlock；否则按 conv_id / user_id 直接调 */
async function mutePeer() {
  const row = curConv.value;
  if (row) return toggleMute(row);
  const id = curPeer.value.conv_id;
  if (!id) return;
  const on = !curPeer.value.muted;
  /* 轮 238 · 乐观更新：头部菜单态先翻；失败回滚 */
  bottleMeta.value = { ...(bottleMeta.value || {}), muted: on };
  try { await dmApi.mute(id, on); }
  catch (e) { bottleMeta.value = { ...(bottleMeta.value || {}), muted: !on }; }
}

async function blockPeer() {
  const row = curConv.value;
  if (row) return toggleBlock(row);
  const uid = curPeer.value.user_id;
  if (!uid) return;
  const blocked = curPeer.value.blocked;
  /* 轮 238 · 乐观更新：菜单态先翻；失败回滚 */
  bottleMeta.value = { ...(bottleMeta.value || {}), blocked: !blocked };
  try {
    if (blocked) await unblockUser(uid);
    else await blockUser(uid);
    refreshBadge();       /* 轮 254：挪到落库之后（旧写法在写之前并发发，拉回旧值） */
  } catch (e) {   /* 静默回滚 */
    bottleMeta.value = { ...(bottleMeta.value || {}), blocked };
  }
}

/* ─────────── 轮询（只在可见 + 有会话时跑） ─────────── */

let timer = null;
let tickN = 0;        /* 轮 157：轮询拍数 */
let tickBusy = false; /* 轮 157：上一拍没回来就跳过，弱网下不叠请求 */
async function tick() {
  if (tickBusy) return;
  if (typeof document !== "undefined" && document.hidden) return;
  if (!signedIn.value) return;
  tickN++;
  tickBusy = true;
  try {
    if (activeId.value) await pullTail(String(activeId.value));
    /* 会话列表不再每拍全量拉 200 行：每 3 拍（约 15s）一次，未读/预览仍够新鲜；
     * 后台 chatter 少 2/3，弱网下不跟用户操作抢带宽。消息轮询优先于列表刷新。 */
    if (tickN % 3 === 1) await loadConvsImplicit();
  } catch (e) { /* 静默 */ }
  finally { tickBusy = false; }
}

/* 尾部刷新：把该会话服务器侧最新 20 条 merge 进当前列表（原 tick 内的内联逻辑，
 * 轮 269 抽成函数——实时通道收到 INSERT 事件时直接复用同一条路：不手写 merge，
 * 实时行与 RPC 行的形状差异（nickname 等）由服务端全行覆盖，下一拍自愈）。
 * 轮 225 语义原样保留：只读不发号（mySeq = msgSeq），响应回来只校验号与会话；
 * 发号权仍归 loadMessages（openConv），轮询/实时绝不顶号。 */
async function pullTail(cid) {
  const mySeq = msgSeq;
  const got = (await dmApi.listMessages(cid, { before: null, limit: 20 })) || [];
  /* 等响应期间用户切走了会话（或发起了新的加载）→ 这份尾部数据属于旧会话，整份丢弃。 */
  if (isStale(mySeq, cid)) return false;
  const asc = got.slice().reverse();
  if (!asc.length) return false;
  /* 尾部增量合并（mergeTail）：已见行原位更新、新行追加——翻过的历史不再被冲掉 */
  const { rows, added } = mergeTail(msgs.value, asc);
  if (rows === msgs.value) return false;
  const el = listEl.value;
  const nearBottom = !el || (el.scrollHeight - el.scrollTop - el.clientHeight) < 120;
  msgs.value = rows;
  if (added) {
    if (nearBottom) scrollBottom(true);
    /* 轮 254：行未读本地先清 + 角标同步减（乐观跟手），等落库再校正 */
    const crow = convs.value.find((x) => String(x.conv_id) === String(cid));
    const clost = Math.max(
      crow && Number(crow.unread) > 0 ? Number(crow.unread) : 0,
      Number((badge.dmConvs || {})[cid]) || 0,   /* 轮 268：映射也算 */
    );
    if (crow && clost) crow.unread = 0;
    if (clost) badgeLocal({ dm: Math.max(0, badge.dm - clost) });
    badgeDmConvPatch(cid, 0);
    refreshBadge({ after: dmApi.markRead(cid).catch(() => {}) });
  }
  return added;
}

/* 轮询里的列表刷新：不动 loadingConvs，避免列表闪「载入中」 */
async function loadConvsImplicit() {
  try {
    convs.value = withBlockedTombstones((await dmApi.listConvs(200, 0)) || []);
    convsLoaded.value = true;   /* 轮 266：轮询也算服务端应答（首拉失败后轮询救回 = 空态可信） */
    failed.value = false;
    convsRetryN = 0;
  } catch (e) { /* 静默 */ }
}

/* 轮 269 · 实时 INSERT 回调：
 *  - 事件属于当前打开的会话 → pullTail 秒上屏（与 tick 同一条路，有 msgSeq 守卫）；
 *  - 属于别的会话 → 列表隐式刷新（节流 3s 一次，防连发刷屏）；行未读红点由 badge
 *    的 refreshBadge(conv 明细) 先亮（dmRealtime 已触发），列表回来再精确校正。 */
let offDmInsert = null;
let rtListAt = 0;
function armDmRealtime() {
  if (offDmInsert) return;
  offDmInsert = onDmInsert((row) => {
    if (!signedIn.value) return;
    const cid = String((row && row.conv_id) || "");
    if (!cid) return;
    if (activeId.value && String(activeId.value) === cid) {
      pullTail(cid).catch(() => {});
      return;
    }
    const now = Date.now();
    if (now - rtListAt < 3000) return;
    rtListAt = now;
    loadConvsImplicit();
  });
}
function disarmDmRealtime() {
  if (offDmInsert) { try { offDmInsert(); } catch (e) {} offDmInsert = null; }
}

function onVisible() {
  if (typeof document !== "undefined" && !document.hidden) { tickN = 0; tick(); }
}

onMounted(async () => {
  pushBack(segBack);
  document.addEventListener("pointerdown", onDocPointerDown);   /* 轮144：⋯菜单点空白关 */
  if (!signedIn.value) return;
  refreshBlocks();   /* 轮 34：进消息页同步拉黑名单（内容过滤与私信名单同源） */
  /* 轮 245（用户实测冷启动「漂流瓶→进聊天停顶/跳闪」）：openConv 不再等会话列表 ——
   * loadConvs 冷启动要走网络+本地库，把它 await 完才 openConv 会把钉底/揭示链堵在后面：
   * 期间 listRevealed 还是初始 true、DOM 停在旧位置（=先看到顶），openConv 终于跑起来
   * 才隐藏→钉底→揭示（=再跳一下到底）。并行后钉底链立刻接管。
   * openConv 只在 convs 里查不到会话时才顺带 loadMeta（convs 未就绪 = 必拉，语义仍对）。 */
  const firstOpen = activeId.value ? openConv(activeId.value) : null;
  await loadConvs();
  if (firstOpen) await firstOpen;
  timer = setInterval(tick, 5000);
  armDmRealtime();   /* 轮 269：实时回调挂载（本视图卸载即注销） */
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
});

/* 轮 218：保活期暂停轮询/监听（KeepAlive 下 onBeforeUnmount 不触发） */
/* 轮 247：区分「首次激活」与「真恢复」——KeepAlive 首次挂载也会触发 onActivated，
 * 无差别强制揭示会把 openConv 刚设的「隐藏待钉稳」立刻改回可见，钉底震荡全程裸奔
 * （真机逐帧实证：vis 从第一帧就是 visible、top 0→1811→1433→2841 折返跑 = 用户报的跳闪）。 */
let wasDeactivated = false;
onActivated(() => {
  if (!timer) timer = setInterval(tick, 5000);
  armDmRealtime();   /* 轮 269：保活恢复时重挂实时回调（与轮询同节奏） */
  document.addEventListener("pointerdown", onDocPointerDown);
  restoreScroll(route.path);   /* 轮 219：回位（KeepAlive 重插瞬间） */
  /* 轮 245 → 247/248 收口：真恢复时**只补滚动位置，绝不动 listRevealed** ——
   * ① 同会话恢复：缓存 DOM 本就处于揭示态（上次离开时 visible），只需把停在顶部的
   *    scrollTop 钉回底（修「第二次进聊天停顶」）；
   * ② 不同会话（如从别人主页「发私信」深链进来）：watch 会触发 openConv，钉稳揭示链
   *    全权接管 —— 这里若强制 listRevealed=true 会把「隐藏待钉稳」翻回可见，
   *    钉底震荡全程裸奔（真机逐帧实证：top 0→1811→1433→2841 折返跑 = 用户报的跳闪）；
   * ③ 首次挂载：onActivated 也会触发（KeepAlive 首次激活），wasDeactivated=false 拦住。 */
  if (wasDeactivated && route.name === "messages" && route.params.id && String(route.params.id) === activeId.value) {
    pinning.value = false;
    nextTick(() => { const el = listEl.value; if (el) el.scrollTop = el.scrollHeight; });
  }
  wasDeactivated = false;
});
onDeactivated(() => {
  wasDeactivated = true;
  clearInterval(timer); timer = 0;
  disarmDmRealtime();   /* 轮 269：保活期暂停实时回调（与轮询同节奏） */
  document.removeEventListener("pointerdown", onDocPointerDown);
});
onBeforeUnmount(() => {
  popBack(segBack);
  document.removeEventListener("pointerdown", onDocPointerDown);
  clearInterval(timer);
  disarmDmRealtime();   /* 轮 269 */
  clearTimeout(convsRetryTimer); convsRetryTimer = 0;   /* 轮 266：别把重试带进坟墓 */
  if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
});

/* 地址栏变了（通知中心点私信跳进来 / ← 钮 / 系统返回键）→ 切会话或回列表 */
watch(() => route.params.id, (v) => {
  /* 轮 237 · 只认私信路由自己的 :id —— 本页被 KeepAlive 保活，这个 watch 在别的页面也活着。
   * 从消息列表点头像「看 TA 的主页」跳 /u/:id 时，route.params.id 变成**用户 uuid**，
   * 旧代码把它当会话 id → openConv(uuid) → push /messages/<uuid>：用户刚落到主页就被
   * 劫持进一个空会话（标题落到「这位伙伴」、消息区全空，用户实测）。
   * /post/:id、/story/:id 等数字 id 同理会中招（读帖 7 会被拽进会话 7）。
   * 修法：route 不是 messages/messagesList 时一律无视 —— 此时本页不可见，:id 与本页无关。 */
  if (route.name !== "messages" && route.name !== "messagesList") {
    /* 轮 245（用户实测「从聊天物理返回漂流瓶 → 再点消息页 = 塌缩」）：无视 ≠ 不清理。
     * 离开消息组时会话态必须清空 —— 否则 params.id 从 "26"→undefined 被上面的守卫
     * 拦掉、再进 /messages 时 id 无变化 watch 不触发，activeId="26" 一路残留：
     * thread 的 v-show="!!activeId" 仍显示，但 inChat=false 已卸掉 shell--chat，
     * thread 落回基础 min-height:60vh = 聊天区塌缩、输入框悬空（用户截图实证）。
     * 页面不可见时清的是内部状态，不触碰任何滚动/焦点，对「看 TA 主页」等来回无感。 */
    if (activeId.value) resetConv();
    return;
  }
  const id = String(v || "");
  if (id) {
    if (id !== activeId.value) openConv(id);
    return;
  }
  /* 回到列表：清空当前会话（手机形态下 .dm-list 立刻接管整屏）+ 回私信段 */
  resetConv();
});

/* 轮 245：清会话态抽成一处（watch 的两个出口共用；与原「回到列表」分支逐字段同口径） */
function resetConv() {
  activeId.value = "";
  msgs.value = [];
  msgsConv = "";
  /* 轮 237：翻页游标一并复位 —— 只清 msgs 不清 oldestId/hasMore，下个会话首屏数据
   * 落定前会闪出「加载更早的消息」按钮（old 残留 + 空列表的矛盾态，用户截图实证）。 */
  oldestId.value = null;
  hasMore.value = true;
  meta.value = null;
  fromList.value = false;
  seg.value = "dm";
}

const when = (ts) => relativeTime(ts, Date.now(), t);
/* ── 轮 19④：分栏左右滑（像首页三联那样：左滑去右边的栏，右滑去左边的栏）──
 * 顺序与顶部按钮一致：漂流瓶 | 会话 | 通知；只认横向主轴，纵向滚动不受影响；
 * 会话打开时列表整页隐藏（v-show=false），天然不触发，不会把聊天页滑走。 */
const SEG_ORDER = ["bottle", "dm", "notif"];
let segX = 0, segY = 0, segArmed = false;
function segTouchStart(e) {
  const t0 = e.touches[0];
  segX = t0.clientX; segY = t0.clientY; segArmed = true;
}
function segTouchMove(e) {
  if (!segArmed) return;
  const t0 = e.touches[0];
  const dx = t0.clientX - segX, dy = t0.clientY - segY;
  if (Math.abs(dx) < 56) return;                  /* 不够长不触发 */
  if (Math.abs(dx) < Math.abs(dy) * 1.4) return;  /* 斜着走＝想滚动，不触发 */
  segArmed = false;                               /* 一次手势只切一栏 */
  if (e.target && e.target.closest && e.target.closest("input, textarea, select")) return;
  const i = SEG_ORDER.indexOf(seg.value);
  const next = dx < 0 ? i + 1 : i - 1;
  if (next >= 0 && next < SEG_ORDER.length) seg.value = SEG_ORDER[next];
}
function segTouchEnd() { segArmed = false; }
const clock = (ts) => {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const dayLabel = (ts) => new Date(ts).toLocaleDateString(
  i18n.locale === "zh" ? "zh-CN" : "en-US", { year: "numeric", month: "short", day: "numeric" });

/* 未登录 → 登录页（轮 17 统一口径）：带当前 fullPath（含会话 id），登录后按 ?redirect=
 * 直接回到原处，不再绕道「我的」页 */
function goSignIn() {
  router.push({ path: "/login", query: { redirect: route.fullPath || "/messages" } });
}
</script>

<template>
  <div class="dm-page">
    <section v-if="!signedIn" class="card dm-empty">
      <p class="sub">{{ t("dm.needSignIn") }}</p>
      <n-button type="primary" round @click="goSignIn">{{ t("profile.goSignIn") }}</n-button>
    </section>

    <div v-else class="dm-wrap">
      <!-- 左列：会话列表（手机形态 = 微信式列表页；进入会话后整页让给聊天区） -->
      <aside
        v-show="!isMobileNav || !activeId"
        class="card dm-list"
        :class="{ 'dm-list--seg': isMobileNav && seg === 'notif' }"
        @touchstart.passive="segTouchStart"
        @touchmove.passive="segTouchMove"
        @touchend.passive="segTouchEnd">
        <!-- T8 分栏（手机形态，原样不动）：漂流瓶 | 会话中心 | 通知 -->
        <div v-if="isMobileNav" class="dm-seg" role="tablist">
          <button type="button" class="dm-seg-btn" :class="{ on: seg === 'bottle' }" role="tab" :aria-selected="seg === 'bottle'" @click="seg = 'bottle'">
            {{ t("tab.segBottle") }}
          </button>
          <button type="button" class="dm-seg-btn" :class="{ on: seg === 'dm' }" role="tab" :aria-selected="seg === 'dm'" @click="seg = 'dm'">
            {{ t("tab.segDm") }}
            <span v-if="dmBadge" class="notif-count">{{ dmBadge > 99 ? "99+" : dmBadge }}</span>
          </button>
          <button type="button" class="dm-seg-btn" :class="{ on: seg === 'notif' }" role="tab" :aria-selected="seg === 'notif'" @click="seg = 'notif'">
            {{ t("tab.segNotif") }}
            <span v-if="badge.notif" class="notif-count">{{ badge.notif > 99 ? "99+" : badge.notif }}</span>
          </button>
        </div>
        <!-- 轮 142 · 桌面分栏（参考图）：会话 | 漂流瓶（通知不进桌面私信页；两段各自单开聊天框） -->
        <div v-else class="dm-seg dm-seg--desk" role="tablist">
          <button type="button" class="dm-seg-btn" :class="{ on: seg === 'dm' }" role="tab" :aria-selected="seg === 'dm'" @click="seg = 'dm'">
            {{ t("tab.segChat") }}
            <span v-if="dmBadge" class="notif-count">{{ dmBadge > 99 ? "99+" : dmBadge }}</span>
          </button>
          <button type="button" class="dm-seg-btn" :class="{ on: seg === 'bottle' }" role="tab" :aria-selected="seg === 'bottle'" @click="seg = 'bottle'">
            {{ t("tab.segBottle") }}
          </button>
        </div>

        <template v-if="seg === 'dm'">
        <van-field v-model="q" clearable :placeholder="t('dm.search')" class="dm-search" />

        <!-- #19 已拉黑：集中查看 / 解除（拉黑与解除都不通知对方） -->
        <div class="dm-blocked-bar">
          <button class="dm-act" @click="toggleBlockedPanel">
            {{ t("dm.blockedTitle") }}<template v-if="blockedRows.length"> · {{ blockedRows.length }}</template>
          </button>
        </div>
        <div v-if="showBlocked" class="dm-blocked">
          <!-- 轮 238：App 端不摆说明文字（用户拍板精简）；长解释留给桌面端 -->
          <p v-if="!isMobileNav" class="sub">{{ t("dm.blockedHint") }}</p>
          <p v-if="!blockedRows.length" class="sub">{{ t("dm.blockedEmpty") }}</p>
          <div v-for="b in blockedRows" :key="b.user_id" class="dm-blocked-row">
            <n-avatar round :size="30" class="post-avatar clickable" :title="t('dm.viewHome')" :src="avatarUrlFor(b.user_id) || undefined" @click="goUser(b.user_id)"><template v-if="!avatarUrlFor(b.user_id)" #default>{{ (b.nickname || "?").slice(0, 1).toUpperCase() }}</template><template v-else #fallback>{{ (b.nickname || "?").slice(0, 1).toUpperCase() }}</template>
            </n-avatar>
            <b class="dm-name">{{ b.nickname || t("dm.someone") }}</b>
            <button class="dm-act" :disabled="blockedBusy === b.user_id" @click="unblockOne(b)">
              {{ t("dm.blockedGo") }}
            </button>
          </div>
        </div>

        <p v-if="failed" class="notice">{{ t("dm.loadFail") }}</p>

        <!-- 消息请求：陌生人首条消息，同意才进列表 -->
        <template v-if="requests.length">
          <div class="dm-sec">
            <span class="sec-label">{{ t("dm.requests") }}</span>
            <span class="notif-count">{{ requests.length }}</span>
          </div>
          <div v-for="c in requests" :key="'r' + c.conv_id" class="dm-row req">
            <n-avatar round :size="38" class="post-avatar clickable" :title="t('dm.viewHome')" :src="avatarUrlFor(c.other_id) || undefined" @click.stop="goUser(c.other_id)"><template v-if="!avatarUrlFor(c.other_id)" #default>{{ (c.nickname || "?").slice(0, 1).toUpperCase() }}</template><template v-else #fallback>{{ (c.nickname || "?").slice(0, 1).toUpperCase() }}</template></n-avatar>
            <div class="dm-row-body">
              <div class="dm-row-top">
                <b class="dm-name">{{ c.nickname }}</b>
                <span class="sub dm-time">{{ when(c.last_message_at || c.created_at) }}</span>
              </div>
              <p class="sub dm-preview">{{ previewText(c.last_preview, t) }}</p>
              <div class="dm-req-acts">
                <button class="dm-act primary" @click="acceptReq(c)">{{ t("dm.accept") }}</button>
                <button class="dm-act" @click="rejectReq(c)">{{ t("dm.reject") }}</button>
              </div>
            </div>
          </div>
        </template>

        <template v-if="normal.length">
          <div class="dm-sec"><span class="sec-label">{{ t("dm.conversations") }}</span></div>
          <!-- 轮 197：用户点单——撤掉微信式左滑（轮 190 的 SwipeCell），操作全走 ⋯ 菜单
           * （打开 / 免打扰 / 隐藏会话 / 拉黑，本来就在里面），恢复以前的纯行样式 -->
          <div
            v-for="c in normal" :key="c.conv_id"
            class="dm-row" :class="{ on: String(c.conv_id) === String(activeId) }"
            @click="openConv(c.conv_id)">
            <n-avatar round :size="38" class="post-avatar clickable" :title="t('dm.viewHome')" :src="avatarUrlFor(c.other_id) || undefined" @click.stop="goUser(c.other_id)"><template v-if="!avatarUrlFor(c.other_id)" #default>{{ (c.nickname || "?").slice(0, 1).toUpperCase() }}</template><template v-else #fallback>{{ (c.nickname || "?").slice(0, 1).toUpperCase() }}</template></n-avatar>
            <div class="dm-row-body">
            <div class="dm-row-top">
              <b class="dm-name">{{ c.nickname }}</b>
              <!-- 轮 238 · 免打扰标改微信式：小灰标绝对定位在时间左侧（无文字、不参与 baseline
               * 对齐 —— svg 没有文字基线，进 flex 行会把整行撑高错位，实测 21px→34px） -->
              <span class="sub dm-time" :class="{ 'has-mute': c.muted }">
                <svg v-if="c.muted" class="dm-muted-ico" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" />
                  <path d="M16 9.8l4.4 4.4M20.4 9.8L16 14.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none" />
                </svg>
                {{ when(c.last_message_at || c.created_at) }}
              </span>
            </div>
            <p class="sub dm-preview">
              {{ previewText(c.last_preview, t) }}
            </p>
            </div>
            <span v-if="rowUnread(c)" class="dm-badge">{{ rowUnread(c) > 99 ? "99+" : rowUnread(c) }}</span>
            <button class="dm-more" :title="t('dm.more')" @click.stop="menuFor = (menuFor === String(c.conv_id) ? '' : String(c.conv_id))">⋯</button>
            <div v-if="menuFor === String(c.conv_id)" class="dm-menu">
              <button class="dm-menu-item" @click.stop="openConv(c.conv_id); menuFor = ''">{{ t("dm.open") }}</button>
              <button class="dm-menu-item" @click.stop="toggleMute(c)">{{ c.muted ? t("dm.unmute") : t("dm.mute") }}</button>
              <button class="dm-menu-item" @click.stop="hideConv(c)">{{ t("dm.hide") }}</button>
              <button class="dm-menu-item danger" @click.stop="toggleBlock(c)">{{ t("dm.block") }}</button>
            </div>
          </div>
        </template>

        <!-- 轮 266 · 首装/弱网骨架屏：服务端还没应答过（convsLoaded=false）且没失败时，
             给 3 条骨架行占位——对标微信/知乎：「加载中」绝不渲染成「还没有会话」。
             失败态由上方 loadFail 提示 + 3s 快速重试接管（成功后骨架自动让位）。 -->
        <div v-if="!convsLoaded && !failed" class="dm-sk-rows" aria-hidden="true">
          <div v-for="i in 3" :key="'sk' + i" class="dm-row">
            <span class="sk-circle"></span>
            <div class="dm-row-body">
              <span class="sk-line" style="width: 38%"></span>
              <span class="sk-line" style="width: 66%; margin-top: 8px"></span>
            </div>
          </div>
        </div>

        <p v-if="!normal.length && !requests.length && convsLoaded && !failed" class="sub dm-empty">{{ t("dm.empty") }}</p>
        </template>
        <!-- 轮 142 · 漂流瓶段：桌面 = 行式列表（选中交给中列 BottleChat）；手机 = 原卡片式 BottleRecords（零改动） -->
        <BottleChatList
          v-else-if="seg === 'bottle' && !isMobileNav"
          :selected-id="bottleRow && bottleRow.id" @select="pickBottle" />
        <BottleRecords v-else-if="seg === 'bottle'" @open="openBottleChat" />
        <NotificationsView v-else-if="seg === 'notif'" class="dm-seg-notif" />
      </aside>

      <!-- 中列（轮 142）：桌面「漂流瓶」段 = 独立聊天框 BottleChat（与会话段的 dm-thread 各自单开） -->
      <BottleChat
        v-if="!isMobileNav && seg === 'bottle'"
        :letter="bottleRow" :me-id="meId" :peer-name="bottleName"
        @accepted="onBottleAccepted" @peer="onBottlePeer">
        <!-- 轮 143 · 漂流瓶聊天头右上角同样出「…」菜单（内容与会话头同一份：curPeer 随段联动） -->
        <template #headtools>
          <div v-if="!isMobileNav" class="dm-head-tools">
            <button type="button" class="dm-more dm-head-more" :title="t('dm.more')" :aria-expanded="headMenu" @click="headMenu = !headMenu">⋯</button>
            <div v-if="headMenu" class="dm-menu dm-head-menu">
              <button v-if="curPeer.user_id" class="dm-menu-item" @click="headMenu = false; goUser(curPeer.user_id)">{{ t("dm.viewHome") }} →</button>
              <template v-if="curPeer.conv_id">
                <button class="dm-menu-item" @click="headMenu = false; mutePeer()">{{ curPeer.muted ? t("dm.unmute") : t("dm.mute") }}</button>
                <button class="dm-menu-item danger" @click="headMenu = false; blockPeer()">{{ curPeer.blocked ? t("dm.unblock") : t("dm.block") }}</button>
              </template>
              <p v-else class="sub dm-menu-note">{{ t("bottle.noChatYet") }}</p>
            </div>
          </div>
        </template>
      </BottleChat>

      <!-- 中列：当前会话（手机形态 = 微信式独立聊天页，带返回） -->
      <section v-else v-show="!isMobileNav || !!activeId" class="card dm-thread">
        <template v-if="activeId">
          <header class="dm-thread-head">
            <button v-if="isMobileNav" class="dm-thread-back" @click="backToList">←</button>
            <n-avatar v-if="!isMobileNav" round :size="40" class="dm-msg-avatar" :src="avatarUrlFor((activeConv && activeConv.other_id) || (meta && meta.other_id)) || undefined">{{ peerInitial }}<template #fallback>{{ peerInitial }}</template></n-avatar>
            <b class="dm-name dm-peer-link" :title="t('dm.viewHome')" @click="goUser(activeConv && activeConv.other_id)">{{ title || t("dm.someone") }}</b>
            <!-- 轮 244（用户拍板）：聊天头部**不挂**免打扰小灰标 —— 微信口径：免打扰标志只出现在
             * 会话列表行（时间左侧的小灰标，见上方 .dm-time.has-mute），聊天头部就是昵称本身；
             * 进到聊天里还顶着标志是多余的（用户实测「免打扰标志出现在聊天框之中，这不对」）。 -->
            <n-tag v-if="activeConv && activeConv.accepted === false" round size="small" :bordered="false" class="soft-tag">
              {{ t("dm.requestTag") }}
            </n-tag>
            <span class="dm-spacer"></span>
            <!-- 轮 143 · 右上角「…」菜单：原右列资料卡内容（看主页 / 静音 / 拉黑 / 无会话说明）迁到这 -->
            <div v-if="!isMobileNav" class="dm-head-tools">
              <button type="button" class="dm-more dm-head-more" :title="t('dm.more')" :aria-expanded="headMenu" @click="headMenu = !headMenu">⋯</button>
              <div v-if="headMenu" class="dm-menu dm-head-menu">
                <button v-if="curPeer.user_id" class="dm-menu-item" @click="headMenu = false; goUser(curPeer.user_id)">{{ t("dm.viewHome") }} →</button>
                <template v-if="curPeer.conv_id">
                  <button class="dm-menu-item" @click="headMenu = false; mutePeer()">{{ curPeer.muted ? t("dm.unmute") : t("dm.mute") }}</button>
                  <button class="dm-menu-item danger" @click="headMenu = false; blockPeer()">{{ curPeer.blocked ? t("dm.unblock") : t("dm.block") }}</button>
                </template>
                <!-- 漂流瓶还没建会话：没有可静音/拉黑的会话，如实说明（不摆空按钮） -->
                <p v-else-if="seg === 'bottle'" class="sub dm-menu-note">{{ t("bottle.noChatYet") }}</p>
              </div>
            </div>
          </header>

          <!-- 消息流 -->
          <div ref="listEl" class="dm-scroll" :style="{ visibility: listRevealed ? 'visible' : 'hidden' }"
            @scroll.passive="onScrollTop"
            @touchstart.passive="onListTouch" @wheel.passive="onListWheel">
            <div class="dm-topmore">
              <button v-if="hasMore && oldestId" class="dm-act" :disabled="loadingMsgs"
                @click="loadMessages(activeId, { before: oldestId })">{{ t("dm.older") }}</button>
              <span v-else class="sub">{{ t("dm.reachTop") }}</span>
            </div>

            <template v-for="it in flow" :key="it.key">
              <div v-if="it.type === 'day'" class="dm-day"><span>{{ dayLabel(it.ts) }}</span></div>
              <div v-else class="dm-line" :class="{ mine: it.msg.sender === meId }">
                <n-avatar v-if="it.msg.sender !== meId" round :size="30" class="dm-msg-avatar" :src="avatarUrlFor(it.msg.sender) || undefined"><template v-if="!avatarUrlFor(it.msg.sender)" #default>{{ peerInitial }}</template><template v-else #fallback>{{ peerInitial }}</template></n-avatar>
                <div class="dm-msg-col">
                  <div class="dm-bubble" :class="{ recalled: it.msg.recalled, failed: it.msg.failed }">
                    <p v-if="it.msg.recalled" class="dm-recalled">{{ t("dm.recalled") }}</p>
                    <p v-else class="dm-text">{{ it.msg.body }}</p>
                  </div>
                  <span class="dm-stamp">
                    {{ it.msg.pending ? t("dm.sending") : it.msg.failed ? t("dm.sendFailed") : clock(it.msg.created_at) }}
                    <button
                      v-if="canRecall(it.msg, meId) && !it.msg.pending"
                      class="dm-recall" :title="t('dm.recall')"
                      @click="recall(it.msg)">{{ t("dm.recall") }}</button>
                  </span>
                </div>
              </div>
            </template>

            <p v-if="!flow.length && !loadingMsgs" class="sub dm-empty">{{ t("dm.noMessages") }}</p>
          </div>

          <!-- 输入区 -->
          <footer class="dm-compose">
            <p v-if="!canType" class="notice dm-gate">
              {{ blockedByMe ? t("dm.gateBlockedByMe") : t("dm.gateRequest") }}
            </p>
            <template v-else>
              <!-- 轮 238：桌面键位说明只留桌面（手机键盘没有 Shift+Enter，纯占地方） -->
              <p v-if="!isMobileNav" class="sub dm-hint">{{ t("dm.hint") }}</p>
              <p v-if="sendErr" class="sub dm-err">{{ sendErr }}</p>
              <!-- 轮 68：微信式输入行——单行起、随内容长高（1~6 行），发送键在框右侧 -->
              <div class="dm-input-row">
                <van-field
                  v-model="body" type="textarea" rows="1" autosize :maxlength="2000"
                  :placeholder="isMobileNav ? t('dm.placeholderMobile') : t('dm.placeholder')"
                  @keydown.enter.exact.prevent="send" />
                <n-button type="primary" round size="small" class="dm-send-btn" :disabled="!sending && !body.trim()" @click="send">
                  <span :style="{ visibility: sending ? 'hidden' : 'visible' }">{{ t("dm.send") }}</span>
                  <span v-if="sending" class="dm-send-spin" aria-hidden="true"></span>
                </n-button>
              </div>
            </template>
          </footer>
        </template>

        <p v-else class="sub dm-empty">{{ t("dm.pickOne") }}</p>
      </section>

    </div>
  </div>
</template>
