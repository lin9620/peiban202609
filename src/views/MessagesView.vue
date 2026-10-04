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
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch, defineAsyncComponent } from "vue";
import { useRoute, useRouter } from "vue-router";
import { NButton, NInput, NAvatar, NTag } from "naive-ui";
import { t, i18n } from "../i18n.js";
import { cloud } from "../utils/supabase.js";
import * as dmApi from "../utils/dm.js";
import { cacheKey, swr } from "../utils/cache.js";
import {
  previewText, sortConvs, filterConvs, withDayDividers, displayMsg,
  validateSend, sendErrKey, canRecall, relativeTime, rowView, mergeTail,
  dmMsgsKey, dmPeekWindow, dmCacheWindow, dmWin,
} from "../utils/dmRules.js";
import { badge, refreshBadge } from "../stores/badgeStore.js";
/* 轮 34：拉黑已全站生效（私信拦截 + 暖心墙内容隐藏）——这里走 userBlocks 的包装，
 * 让「拉黑名单」的内容过滤缓存与私信名单始终是同一份 */
import { blockUser, unblockUser, refreshBlocks } from "../utils/userBlocks.js";
import BottleRecords from "../components/BottleRecords.vue";
import { SwipeCell as VanSwipeCell } from "vant";
import "vant/es/swipe-cell/style";   /* 轮 190：会话左滑操作（微信式） */
import EmojiPicker from "../components/EmojiPicker.vue";   /* 轮 164：表情按钮 */
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
const failed = ref(false);
const signedIn = computed(() => !!(cloud.ready && cloud.user));

const activeId = ref(String(route.params.id || "")); // 当前会话（空串 = 只看列表）
const msgs = ref([]);        // 当前会话消息（旧→新）
let msgsConv = "";           // msgs 现在装的是哪个会话（轮 157b：防跨会话误合并）
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
function fontsOk() {                /* 轮 178b：webfont 没在加载中 = 排版稳定（每帧实时判定，
    fonts.ready 有「触发过早误放行」的坑，弃用）；加载失败也会落到 loaded，不会永藏 */
      return !(document.fonts && document.fonts.status === "loading");
    }
let scrollGen = 0;                  /* 轮 176b：滚动链代数——平滑滚动接管时作废旧追帧链 */
const pinning = ref(false);         /* 轮 173b：进会话钉底中（直到首屏数据落定） */
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

/* 常规会话 / 消息请求 分组（被拉黑的会话在 rowView 里把未读清零） */
const normal = computed(() => sortConvs(filterConvs(convs.value.filter((c) => c.accepted !== false), q.value)).map(rowView));
const requests = computed(() => sortConvs(filterConvs(convs.value.filter((c) => c.accepted === false), q.value)).map(rowView));

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
  if (!headMenu.value) return;
  if (e.target && e.target.closest && e.target.closest(".dm-head-tools")) return;
  headMenu.value = false;
}

/* 是否可以直接发：对方不是待处理请求、双方都没拉黑 */
const canType = computed(() => {
  if (!activeId.value) return false;
  const c = activeConv.value || meta.value || {};
  if (c.blocked) return false;
  if (c.accepted === false) return false;
  return true;
});
const blockedByMe = computed(() => !!(activeConv.value || meta.value || {}).blocked);

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
  try {
    /* 轮 34：走 userBlocks 包装 —— 私信名单与暖心墙内容过滤缓存同步更新，
     * 解除后 TA 的帖子/评论在墙里立刻恢复显示，不用刷新页面 */
    await unblockUser(b.user_id);
    blockedRows.value = blockedRows.value.filter((x) => x.user_id !== b.user_id);
    await loadConvsImplicit();   /* 解除后会话恢复可见 */
  } catch (e) { /* 静默，行保留 */ }
  finally { blockedBusy.value = ""; }
}
function toggleBlockedPanel() {
  showBlocked.value = !showBlocked.value;
  if (showBlocked.value) loadBlocked();
}

/* ─────────── 数据加载 ─────────── */

async function loadConvs() {
  if (!signedIn.value) return;
  loadingConvs.value = true;
  /* 本地优先（SWR）：有缓存先渲染不闪「载入中」，后台刷新；换账号靠 key 里的 uid 隔离 */
  await swr(
    cacheKey("dm:convs", meId.value),
    {
      cached: (rows) => { convs.value = rows; loadingConvs.value = false; },
      fresh: (rows) => { convs.value = rows; failed.value = false; },
      onError: () => { failed.value = true; },
    },
    () => dmApi.listConvs(200, 0),
  );
  loadingConvs.value = false;
}

async function openBottleChat(id) {
  await loadConvs();
  await openConv(String(id));
}

async function loadMeta(id) {
  try { meta.value = await dmApi.convMeta(id); } catch (e) { /* 用列表里的行兜底 */ }
}

async function loadMessages(id, { before = null } = {}) {
  if (!id) return false;
  let smoothed = false;   /* 轮 173c：fresh 有新消息时已平滑滚到新底，调用方免再瞬时滚 */
  loadingMsgs.value = true;
  const applyRows = (rows) => {
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
    msgsConv = id;
    hasMore.value = more != null ? more : rows.length === 30;
    oldestId.value = msgs.value.length ? msgs.value[0].id : null;
  };
  await swr(
    before == null ? dmMsgsKey(meId.value, id) : null,
    {
      /* 轮 157b：首屏先吃本地窗口（最多 60 条，含上次翻过的历史），立刻渲染不闪载入 */
      cached: (v) => {
        const w = dmWin(v);
        if (!w || !w.rows.length) return;
        applyRows(w.rows, w.more);
        loadingMsgs.value = false;
        scrollBottom();
      },
      fresh: (v) => {
        const w = dmWin(v);
        if (!w) return;
        if (before != null) {
          applyRows(w.rows, w.more);
          /* 历史页并入缓存窗口（更旧的页拼前面）；本页拉不满 30 = 没有更早了 */
          const hit = dmPeekWindow(meId.value, id);
          if (hit) dmCacheWindow(meId.value, id, w.rows.concat(hit.rows), w.more && hit.more);
        } else if (msgsConv === id && msgs.value.some((m) => m.id < 0)) {
          return;   /* 乐观消息在场：不动视图，交给轮询 / send 收敛 */
        } else if (msgsConv === id) {
          /* 重开同一会话：尾部增量并入，保住已翻的历史窗口 */
          const asc = w.rows.slice().reverse();
          const { rows, added } = mergeTail(msgs.value, asc);
          if (added) {
            /* 轮 173c/176b：新消息落下 → 作废追帧链（防瞬时重钉顶掉平滑）+ 平滑滑到新底 */
            pinning.value = false;
            scrollGen++;
            smoothed = true;
            entryReady.value = true;
            msgs.value = rows;
            nextTick(() => {
              const el = listEl.value;
              if (!el) return;
              el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
              /* 轮 178：平滑落定（gap<4）才显示；空闲期消息区隐藏，看不到顶部/中间帧 */
              const waitPin = () => {
                if (listRevealed.value) return;
                if (entryReady.value && el.scrollHeight - el.scrollTop - el.clientHeight < 4) { listRevealed.value = true; return; }
                requestAnimationFrame(waitPin);
              };
              requestAnimationFrame(waitPin);
              setTimeout(() => { entryReady.value = true; listRevealed.value = true; }, 1500);
            });
          } else if (rows !== msgs.value) {
            msgs.value = rows;
          }
          oldestId.value = msgs.value.length ? msgs.value[0].id : null;
        } else {
          applyRows(w.rows, w.more);
          entryReady.value = true;   /* 轮 180：首屏数据落定，才允许显示（钉稳门控） */
        }
        if (w.more === false) hasMore.value = false;
      },
      onError: () => { if (before == null && msgsConv !== id) applyRows([], false); },
    },
    () => dmApi.listMessages(id, { before, limit: 30 }).then((rows) => {
      rows = rows || [];
      /* 首屏按「窗口快照」落缓存（swr 直接缓存本返回值） */
      return before == null ? { rows, more: rows.length === 30 } : rows;
    }),
  );
  loadingMsgs.value = false;
  if (before == null) pinning.value = false;   /* 首屏落定，追底收兵（剩 20 帧收尾） */
  return smoothed;
}

function scrollBottom(smooth = false) {
  nextTick(() => {
    const el = listEl.value;
    if (!el) return;
    /* 轮 173：落地后连续几帧追钉底部——字体/内容晚到会把已排好的消息撑高，
     * 只滚一次会停在「中间」（用户实测：记录多了进会话落在半截）。
     * 用户一旦上滑（触摸/滚轮）立即停追，不打扰回看。 */
    userScrolling.value = false;
    const gen = ++scrollGen;   /* 轮 176b：新滚动链作废旧链——平滑滚动时不被追帧的瞬时重钉顶掉 */
    const set = () => {
      el.scrollTop = el.scrollHeight;
      /* 轮 178：钉稳（gap<4）才显示——揭示过早会露出未滚到位的中间态 */
      if (!listRevealed.value && el.scrollHeight - el.scrollTop - el.clientHeight < 4) listRevealed.value = true;
    };
    set();
    let frames = 0;
    /* 轮 173b：进会话期间持续钉底（pinning）——旧缓存先落底、网络回来新消息把底撑下去，
       就会出现「停在中间一下再跳底部」的两段式落地；钉住后新消息落进来视线跟着走，无停顿 */
    const chase = () => {
      if (gen !== scrollGen) return;                   /* 已有新链（如平滑滚动）接管 */
      if (userScrolling.value) return;                 /* 用户上滑：立即停，不打扰回看 */
      /* 轮 178b：字体没稳定前不收兵——追底穿过字体换装，落点始终钉在真底部 */
      if (frames > 300) return;                        /* 硬上限 ~5s，防异常环境永转 */
      if (frames++ > 20 && !pinning.value && fontsOk()) return;
      set();
      if (fontsOk() && entryReady.value && !listRevealed.value
        && el.scrollHeight - el.scrollTop - el.clientHeight < 4) listRevealed.value = true;
      requestAnimationFrame(chase);
    };
    if (smooth && el.scrollTo) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    requestAnimationFrame(chase);
  });
}

/* 轮 157：触顶自动翻历史——rAF 节流 + passive 监听，滚到顶 140px 内自动拉上一批；
 * 「加载更早」按钮保留（可见的 loading 态兜底）。 */
let topRaf = 0;
function onScrollTop() {
  if (topRaf) return;
  topRaf = requestAnimationFrame(() => {
    topRaf = 0;
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
  /* 轮 157：从会话列表点进来时 activeConv 行已带昵称/免打扰/拉黑/请求态——不再单拉
   * conv_meta（每次开聊天少一次 RPC 往返）；深链直进（通知/瓶子记录）列表行缺失才拉。 */
  if (!convs.value.some((c) => String(c.conv_id) === String(activeId.value))) {
    await loadMeta(activeId.value);
  }
  pinning.value = true;   /* 轮 173b：进会话钉底，直到首屏数据落定 */
  listRevealed.value = false;   /* 轮 176：消息区先隐，钉底稳了再显示（防首帧错位跳闪） */
  entryReady.value = false;     /* 轮 180：显示门控重置——等 fresh 数据落定 */

  setTimeout(() => { if (entryReady.value && !listRevealed.value) listRevealed.value = true; }, 2000);   /* 轮 180：兜底只揭示已落定的 */
  const smoothed = await loadMessages(activeId.value);
  if (!smoothed) scrollBottom();   /* 有新消息时已平滑滚过，不再瞬时跳 */
  dmApi.markRead(id).catch(() => {});
  refreshBadge();
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
    if (mid != null) {
      const rowSrv = {
        id: mid, sender: meId.value, body: text, image_path: null,
        created_at: r.created_at || temp.created_at, deleted_at: null,
      };
      msgs.value = msgs.value.map((m) => (m.id === temp.id ? rowSrv : m));
      oldestId.value = msgs.value.length ? msgs.value[0].id : null;
      /* 首屏窗口缓存同步补上这条（不补的话 5s 内退出重进会先看到旧缓存少一条） */
      const win = dmPeekWindow(meId.value, convId);
      if (win) dmCacheWindow(meId.value, convId, [rowSrv].concat(win.rows), win.more);
    } else {
      await loadMessages(convId);   /* 兜底：拿不到 msg_id（异常网关）才走整段重载 */
    }
    scrollBottom(true);
    const row = convs.value.find((c) => String(c.conv_id) === String(convId));
    if (row) { row.last_preview = text.slice(0, 80); row.last_message_at = new Date().toISOString(); }
    refreshBadge();
  } catch (e) {
    msgs.value = msgs.value.map((m) => (m.id === temp.id ? { ...m, pending: false, failed: true } : m));
    sendErr.value = t(sendErrKey(e));
  }
  sending.value = false;
}

async function recall(m) {
  try {
    await dmApi.recall(m, meId.value);
    msgs.value = msgs.value.map((x) =>
      (x.id === m.id ? { ...x, deleted_at: new Date().toISOString(), body: "", image_path: null } : x));
  } catch (e) {
    const late = e && String(e.message || e).includes("too-late");
    sendErr.value = t(late ? "dm.errTooLate" : "dm.errNetwork");
  }
  menuFor.value = "";
}

/* ────────── 会话操作：请求 / 免打扰 / 隐藏 / 拉黑 ─────────── */

async function acceptReq(c) {
  try { await dmApi.accept(c.conv_id); } catch (e) { /* 静默 */ }
  /* 关键：改的是 convs.value 里的原始行（computed requests/normal 都从它过滤）。
   * 之前改的是 rowView 生成的展示拷贝 → 列表纹丝不动，按钮一直挂在原地（用户实测）。 */
  const row = convs.value.find((x) => String(x.conv_id) === String(c.conv_id));
  if (row) row.accepted = true;
  if (meta.value && String(meta.value.conv_id) === String(c.conv_id)) meta.value.accepted = true;
  refreshBadge();
}

async function rejectReq(c) {
  try { await dmApi.hide(c.conv_id); } catch (e) { /* 静默 */ }
  convs.value = convs.value.filter((x) => x.conv_id !== c.conv_id);
  refreshBadge();
}

async function toggleMute(c) {
  const on = !c.muted;
  try { await dmApi.mute(c.conv_id, on); } catch (e) { /* 静默 */ }
  c.muted = on;
  menuFor.value = "";
}

async function hideConv(c) {
  try { await dmApi.hide(c.conv_id); } catch (e) { /* 静默 */ }
  convs.value = convs.value.filter((x) => x.conv_id !== c.conv_id);
  if (String(activeId.value) === String(c.conv_id)) {
    activeId.value = "";
    router.replace({ name: "messagesList" }).catch(() => {});
  }
  menuFor.value = "";
  refreshBadge();
}

async function toggleBlock(c) {
  const blocked = (activeConv.value || meta.value || {}).blocked;
  try {
    /* 轮 34：拉黑=全站生效（私信 + 暖心墙内容过滤），缓存同步走 userBlocks */
    if (blocked) await unblockUser(c.other_id);
    else await blockUser(c.other_id);
  } catch (e) { /* 静默 */ }
  menuFor.value = "";
  await loadConvs();
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
  if (convId) dmApi.markRead(convId).catch(() => {});
  await loadConvs();
  refreshBadge();
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
  try { await dmApi.mute(id, on); } catch (e) { /* 静默 */ }
  bottleMeta.value = { ...(bottleMeta.value || {}), muted: on };
}

async function blockPeer() {
  const row = curConv.value;
  if (row) return toggleBlock(row);
  const uid = curPeer.value.user_id;
  if (!uid) return;
  const blocked = curPeer.value.blocked;
  try {
    if (blocked) await unblockUser(uid);
    else await blockUser(uid);
  } catch (e) { /* 静默 */ }
  bottleMeta.value = { ...(bottleMeta.value || {}), blocked: !blocked };
  refreshBadge();
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
    if (activeId.value) {
      /* 尾部增量合并（mergeTail）：已见行原位更新、新行追加——翻过的历史不再被轮询冲掉 */
      const got = (await dmApi.listMessages(activeId.value, { before: null, limit: 20 })) || [];
      const asc = got.slice().reverse();
      if (asc.length) {
        const { rows, added } = mergeTail(msgs.value, asc);
        if (rows !== msgs.value) {
          const el = listEl.value;
          const nearBottom = !el || (el.scrollHeight - el.scrollTop - el.clientHeight) < 120;
          msgs.value = rows;
          if (added) {
            if (nearBottom) scrollBottom(true);
            dmApi.markRead(activeId.value).catch(() => {});
            refreshBadge();
          }
        }
      }
    }
    /* 会话列表不再每拍全量拉 200 行：每 3 拍（约 15s）一次，未读/预览仍够新鲜；
     * 后台 chatter 少 2/3，弱网下不跟用户操作抢带宽。消息轮询优先于列表刷新。 */
    if (tickN % 3 === 1) await loadConvsImplicit();
  } catch (e) { /* 静默 */ }
  finally { tickBusy = false; }
}

/* 轮询里的列表刷新：不动 loadingConvs，避免列表闪「载入中」 */
async function loadConvsImplicit() {
  try {
    convs.value = (await dmApi.listConvs(200, 0)) || [];
  } catch (e) { /* 静默 */ }
}

function onVisible() {
  if (typeof document !== "undefined" && !document.hidden) { tickN = 0; tick(); }
}

onMounted(async () => {
  pushBack(segBack);
  document.addEventListener("pointerdown", onDocPointerDown);   /* 轮144：⋯菜单点空白关 */
  if (!signedIn.value) return;
  refreshBlocks();   /* 轮 34：进消息页同步拉黑名单（内容过滤与私信名单同源） */
  await loadConvs();
  if (activeId.value) await openConv(activeId.value);
  timer = setInterval(tick, 5000);
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
});

onBeforeUnmount(() => {
  popBack(segBack);
  document.removeEventListener("pointerdown", onDocPointerDown);
  clearInterval(timer);
  if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
});

/* 地址栏变了（通知中心点私信跳进来 / ← 钮 / 系统返回键）→ 切会话或回列表 */
watch(() => route.params.id, (v) => {
  const id = String(v || "");
  if (id) {
    if (id !== activeId.value) openConv(id);
    return;
  }
  /* 回到列表：清空当前会话（手机形态下 .dm-list 立刻接管整屏）+ 回私信段 */
  activeId.value = "";
  msgs.value = [];
  msgsConv = "";
  meta.value = null;
  fromList.value = false;
  seg.value = "dm";
});

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
          <p class="sub">{{ t("dm.blockedHint") }}</p>
          <p v-if="!blockedRows.length" class="sub">{{ t("dm.blockedEmpty") }}</p>
          <div v-for="b in blockedRows" :key="b.user_id" class="dm-blocked-row">
            <n-avatar round :size="30" class="post-avatar clickable" :title="t('dm.viewHome')" @click="goUser(b.user_id)">
              {{ (b.nickname || "?").slice(0, 1).toUpperCase() }}
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
            <n-avatar round :size="38" class="post-avatar clickable" :title="t('dm.viewHome')" @click.stop="goUser(c.other_id)">{{ (c.nickname || "?").slice(0, 1).toUpperCase() }}</n-avatar>
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
          <van-swipe-cell v-for="c in normal" :key="c.conv_id">
          <div
            class="dm-row" :class="{ on: String(c.conv_id) === String(activeId) }"
            @click="openConv(c.conv_id)">
            <n-avatar round :size="38" class="post-avatar clickable" :title="t('dm.viewHome')" @click.stop="goUser(c.other_id)">{{ (c.nickname || "?").slice(0, 1).toUpperCase() }}</n-avatar>
            <div class="dm-row-body">
              <div class="dm-row-top">
                <b class="dm-name">{{ c.nickname }}</b>
                <span class="sub dm-time">{{ when(c.last_message_at || c.created_at) }}</span>
              </div>
              <p class="sub dm-preview">
                <span v-if="c.muted" class="dm-muted">🔇</span>
                {{ previewText(c.last_preview, t) }}
              </p>
            </div>
            <span v-if="c.unread" class="dm-badge">{{ c.unread > 99 ? "99+" : c.unread }}</span>
            <button class="dm-more" :title="t('dm.more')" @click.stop="menuFor = (menuFor === String(c.conv_id) ? '' : String(c.conv_id))">⋯</button>
            <div v-if="menuFor === String(c.conv_id)" class="dm-menu">
              <button class="dm-menu-item" @click.stop="openConv(c.conv_id); menuFor = ''">{{ t("dm.open") }}</button>
              <button class="dm-menu-item" @click.stop="toggleMute(c)">{{ c.muted ? t("dm.unmute") : t("dm.mute") }}</button>
              <button class="dm-menu-item" @click.stop="hideConv(c)">{{ t("dm.hide") }}</button>
              <button class="dm-menu-item danger" @click.stop="toggleBlock(c)">{{ t("dm.block") }}</button>
            </div>
          </div>
          <template #right>
            <button class="dm-swipe-act" :class="{ on: c.muted }" @click.stop="toggleMute(c)">{{ c.muted ? t("dm.unmute") : t("dm.mute") }}</button>
            <button class="dm-swipe-act danger" @click.stop="hideConv(c)">{{ t("dm.hide") }}</button>
          </template>
          </van-swipe-cell>
        </template>

        <p v-if="!normal.length && !requests.length && !loadingConvs" class="sub dm-empty">{{ t("dm.empty") }}</p>
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
            <n-avatar v-if="!isMobileNav" round :size="40" class="dm-msg-avatar">{{ peerInitial }}</n-avatar>
            <b class="dm-name dm-peer-link" :title="t('dm.viewHome')" @click="goUser(activeConv && activeConv.other_id)">{{ title || t("dm.someone") }}</b>
            <span v-if="activeConv && activeConv.muted" class="dm-muted">🔇 {{ t("dm.mutedTag") }}</span>
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
                <n-avatar v-if="it.msg.sender !== meId" round :size="30" class="dm-msg-avatar">{{ peerInitial }}</n-avatar>
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
              <p class="sub dm-hint">{{ t("dm.hint") }}</p>
              <p v-if="sendErr" class="sub dm-err">{{ sendErr }}</p>
              <!-- 轮 68：微信式输入行——单行起、随内容长高（1~6 行），发送键在框右侧 -->
              <div class="dm-input-row">
                <div class="emo-in">
                <van-field
                  v-model="body" type="textarea" rows="1" autosize :maxlength="2000"
                  :placeholder="isMobileNav ? t('dm.placeholderMobile') : t('dm.placeholder')"
                  @keydown.enter.exact.prevent="send" />
                <EmojiPicker :text="body" @update:text="v => (body = v)" />
                </div>
                <n-button type="primary" round size="small" :loading="sending" :disabled="!body.trim()" @click="send">
                  {{ t("dm.send") }}
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
