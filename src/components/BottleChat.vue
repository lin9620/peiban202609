<script setup>
/* 轮 142 · 私信页「漂流瓶」段中列：**独立的漂流瓶聊天框**
 * ------------------------------------------------------------
 * 与「会话」段的 dm-thread 各自单开、状态不共用（用户口径）：
 * 同一人在两边都出现时，就是两块聊天框各显示同样内容，互不影响。
 *
 * 三种形态：
 *   ① 没选信 → 空态（bottle.chatPick）
 *   ② 待我决定（choose）→ 原信 + 回信 + 「同意 / 拒绝」（同意即建会话 → 转 ③）
 *   ③ 已建会话（accepted）→ 消息流 + 输入区 —— **轮 339 起交给 DmVacChat**，
 *      与会话段同一套组件画法/键盘行为/表情/失败重发；本组件只管数据。
 *
 * 头部仍是旧 .dm-thread-head（头像 + 昵称 + 「温暖漂流瓶」胶囊 + 父级 ⋯ 菜单），
 * 组件的头用 hide-header 藏掉 —— 两段的头部/消息流/输入区现在完全一致。
 */
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import { NAvatar, NButton } from "naive-ui";
import { useRouter } from "vue-router";
import { t } from "../i18n.js";
import { bottleChatState, bottleChatDecide, bottleErrKey } from "../utils/bottle.js";
import * as dmApi from "../utils/dm.js";
import { validateSend, sendErrKey, mergeTail, nextMsgKey, findSentEcho, dropEchoedDrafts, claimPendingEcho, dropEchoedPending, maxPositiveId } from "../utils/dmRules.js";
import { dmStoreLoad, dmStoreSave, dmStoreUpsert, dmStoreReplace, dmStoreRemove } from "../utils/dmStore.js";
import { idbMerge, idbLoad, idbRemoveRows, idbOlderThan } from "../utils/dmIdb.js";
import { refreshBadge } from "../stores/badgeStore.js";
import { avatarUrlFor } from "../utils/avatar.js";   /* 轮 238:萌宠头像池 */
import DmVacChat from "./DmVacChat.vue";

const props = defineProps({
  letter: { type: Object, default: null },   /* 左列选中的漂流瓶记录行（bottle_letters.*） */
  meId: { type: String, default: "" },
  peerName: { type: String, default: "" },   /* 父级解析好的对方昵称（取不到时已兜底） */
  /* 轮379：父级按「账号:会话」保存的未发送草稿；切到别的分段再回来也不丢。 */
  drafts: { type: Object, default: () => ({}) },
  /* 轮381：消息页被 KeepAlive 缓存/已切到别的路由时，本组件不会卸载；
     轮询和已读必须跟父页一起停，否则人在首页也会替漂流瓶聊天清红点。 */
  pageActive: { type: Boolean, default: true },
});
const emit = defineEmits(["accepted", "peer", "decided", "draft"]);   /* accepted(convId) / peer({...meta}) / decided(accept|decline) / draft */

const router = useRouter();
/* 轮 143 · 点头像/昵称进对方空间（与会话段聊天头 #15 同口径；没解析到对方时不动） */
function goUser(id) {
  if (id) router.push({ name: "waller", params: { id } });
}

const state = computed(() => bottleChatState(props.letter, props.meId));
const peerId = computed(() => {
  const l = props.letter;
  if (!l) return "";
  return l.user_id === props.meId ? l.reply_by : l.user_id;
});
const peerInitial = computed(() => (props.peerName || "?").slice(0, 1).toUpperCase());
const statusTk = computed(() => ({
  picked: "bottle.stPicked", inhand: "bottle.stInHand", drifting: "bottle.pending",
  waiting: "bottle.chatWaiting", declined: "bottle.chatDeclined",
}[state.value] || "bottle.pending"));

const convId = computed(() => (props.letter && props.letter.conv_id) || "");
/* 只有「已建会话」才有消息流/输入区；待决定/其它状态走说明区 */
const chatting = computed(() => state.value === "accepted" && !!convId.value);

/* 组件要的「当前会话另一人」——稳定对象，免得父级每次渲染都换引用触发组件重排 */
const vacConvs = computed(() => []);
const vacPeer = computed(() => ({ other_id: peerId.value, nickname: props.peerName, accepted: true }));

/* ─────────── 消息数据（与会话段同源：本地库秒开 → 网络增量 → IndexedDB 镜像） ─────────── */
const msgs = ref([]);
let msgsConv = "";           /* msgs 现在装的是哪个会话（轮 157b：防跨会话误合并） */
const loadingMsgs = ref(false);
const hasMore = ref(true);
const oldestId = ref(null);
const busyDecide = ref(false);
/* 轮377：decide 的 RPC 在飞时用户可能切到另一封信。旧请求回来只能刷新列表，
 * 不能再把 busyDecide 按回 false 去解锁新信的按钮，也不能把旧错误写到新信上。 */
let decideSeq = 0;
const sendErr = ref("");

/* 轮 316 · 乐观行临时 id 生成器（同会话段）：同一毫秒连发两条不撞 id */
let lastTempId = 0;
function nextTempId() {
  const t = -Date.now();
  lastTempId = t < lastTempId ? t : lastTempId - 1;
  return lastTempId;
}
/* 轮 376：还在飞的发送（负数 id）；本地库先存「发送中」行，重进时只有这些
 * id 还算 pending，进程被杀留下的孤儿 pending 降级成失败行。 */
const livePending = new Set();
function reviveLocal(m) {
  if (!m || !(m.id < 0) || !m.pending || livePending.has(String(m.id))) return m;
  return { ...m, pending: false, failed: true };
}

/* 轮 376：分页锚点取**最小正数 id**，不能拿 msgs[0] —— 确认行/补拉历史
 * 都可能让 raw 数组暂时不是 id 序，msgs[0] 不一定是服务端最旧那条。 */
function oldestServerId(list) {
  let min = null;
  for (const m of Array.isArray(list) ? list : []) {
    const id = Number(m && m.id);
    if (Number.isFinite(id) && id > 0 && (min == null || id < min)) min = id;
  }
  return min;
}

/* 轮 376：BottleChat 也有自己的异步链（切信/轮询/发送/撤回）。旧版没有序号守卫，
 * 切到另一封信后，上一封的 loadMessages/tick 回来会直接改当前 msgs，
 * 甚至把 A 的消息写进 B 的本地库。msgSeq 与 convId 双校验，过期整份丢弃。 */
let msgSeq = 0;
/* 轮380：切到别的段/路由时组件会卸载，但在途的 load/轮询/决定 RPC 还会回来。
 * 旧代码只清 interval，回来仍会写本地库、抬已读，甚至 emit accepted 打开会话。 */
let alive = true;

async function loadMessages(id, { before = null } = {}) {
  if (!id) return;
  const mySeq = ++msgSeq;
  const owner = props.meId;
  if (!owner) return;   /* 轮 376：未认证不读不写任何本地库 */
  /* 轮 376：切信/换号都作废在途响应，旧账号的消息不许写进新账号的库。 */
  const stale = () => !alive || mySeq !== msgSeq || String(convId.value) !== String(id)
    || (!!owner && props.meId !== owner);
  if (msgsConv !== id) {
    msgs.value = [];
    /* 轮381：清屏后同步清掉窗口归属；否则 A→B→A 时 B 的加载刚清空 msgs、
     * msgsConv 仍停在 A，A 的发送确认会误以为窗口完整，覆盖 A 的历史。 */
    msgsConv = "";
    oldestId.value = null;
    hasMore.value = true;
  }
  loadingMsgs.value = true;
  try {
    /* ── 本地库秒开（同会话段口径）：进会话瞬间渲染本地完整历史 ── */
    if (before == null) {
      const local = dmStoreLoad(props.meId, id);
      if (local.msgs.length && !stale()) {
        /* 轮 376：同会话刷新不能整窗替换 —— 用户可能已经上滑翻过几页，
         * 本地库只存最近 400 条，整窗替换会把翻过的更早页丢掉。
         * 同会话只补当前没有的行；已有行以当前内存为准，避免本地旧正文
         * 把刚撤回/更新的行倒灌回去。首次进入（msgsConv 不同）才整窗落屏。 */
        const sameConv = msgsConv === id && msgs.value.length > 0;
        if (sameConv) {
          const have = new Set(msgs.value.map((m) => String(m.id)));
          /* 只补本地确认过的正数行；本地残留的失败/待发行不要重新倒灌。 */
          const extra = local.msgs.filter((m) => m.id > 0 && !have.has(String(m.id)));
          if (extra.length) {
            /* 轮382：本地库已有正式行时，先认领屏上的乐观行，别把同一条画两次。 */
            const claimed = claimPendingEcho(msgs.value, extra);
            const got = new Set(claimed.rows.map((m) => String(m.id)));
            const add = extra.filter((m) => !got.has(String(m.id)));
            msgs.value = dropEchoedDrafts(add.length ? claimed.rows.concat(add) : claimed.rows, local.msgs);
          }
          oldestId.value = oldestServerId(msgs.value);
        } else {
          const localRows = local.msgs.map(reviveLocal);
          /* 轮 376：发送时负数乐观行已同时写进内存和本地库；首帧拼回时
           * 不能把同一条 pending 再 concat 一遍（旧写法会重复一条）。 */
          const localIds = new Set(localRows.map((m) => String(m.id)));
          const pend = msgs.value.filter((m) => m.id < 0 && !localIds.has(String(m.id)));
          /* 轮378：本地库可能同时留着“超时失败草稿”和“服务端已确认行”；
           * 首帧先认领回显，别让用户一进来就看到失败 + 已发送两条。
           * 轮382：本地库若也已写入正式行，屏上同一条 pending 先被认领掉。 */
          const claimed = claimPendingEcho(pend, localRows);
          const have = new Set(localRows.map((m) => String(m.id)));
          const addPend = claimed.rows.filter((m) => !have.has(String(m.id)));
          const localSnap = dropEchoedPending(addPend.length ? localRows.concat(addPend) : localRows);
          msgs.value = dropEchoedDrafts(localSnap, localRows);
          hasMore.value = local.more;
          oldestId.value = oldestServerId(msgs.value);
        }
        msgsConv = id;
        loadingMsgs.value = false;
      }
      /* 轮 377：本地库可能只有一条失败草稿（没有正式历史）；IndexedDB 里有完整历史时
       * 也要先顶上来，不能等网络。旧版只读 localStorage，清缓存后首屏只剩草稿。 */
      const thinLocal = msgs.value.length > 0 && msgs.value.length < 5;
      if (!msgs.value.some((m) => Number(m.id) > 0) || thinLocal) {
        const rec = await idbLoad(id);
        if (stale()) return;
        const idbRows = rec && Array.isArray(rec.msgs)
          ? rec.msgs.filter((m) => m && m.id != null) : [];
        if (idbRows.length) {
          /* 轮378：全量库可能很长，首帧只上最近 400 条，更早的留给上滑。 */
          const latest = idbRows.slice(-400);
          const snap = dropEchoedPending(latest);
          const incoming = new Set(snap.map((m) => String(m.id)));
          const claimed = claimPendingEcho(msgs.value, snap);
          const keep = claimed.rows.filter((m) => m && !incoming.has(String(m.id)));
          msgs.value = dropEchoedDrafts(snap.concat(keep), snap);
          hasMore.value = !rec.serverDone || idbRows.length > latest.length;
          msgsConv = id;
          loadingMsgs.value = false;
          oldestId.value = oldestServerId(msgs.value);
          dmStoreSave(props.meId, id, msgs.value, hasMore.value);
        }
      }
    }
    /* ── 网络：增量拉取后合并（不替换渲染中的列表）── */
    const rows = (await dmApi.listMessages(id, { before, limit: 30 })) || [];
    if (stale()) return;
    /* 轮 376：同一页里网关重复给同一条时先去重，别让旧版列表出现两条。 */
    const asc = [];
    const seenNew = new Set();
    for (const r of (Array.isArray(rows) ? rows.slice().reverse() : [])) {
      const idKey = r && r.id != null ? String(r.id) : "";
      if (!r || r.id == null || seenNew.has(idKey)) continue;
      seenNew.add(idKey);
      asc.push(r);
    }
    if (before != null) {
      /* 服务端用 id < before，正常不会重叠；仍按 id 去重，防网关重复页。
       * 轮381：若整页都已在屏上，锚点不会前进；不能再把 hasMore 留成 true，
       * 否则每次上滑都重复同一页，用户永远翻不到更早。 */
      const seen = new Set(msgs.value.map((m) => String(m.id)));
      const add = asc.filter((m) => !seen.has(String(m.id)));
      msgs.value = add.concat(msgs.value);
      hasMore.value = rows.length === 30 && add.length > 0;
    } else if (msgsConv === id) {
      /* 重开/刷新同会话：尾部增量并入（保住已翻历史），不整窗替换。
       * 轮 375：有待发行时也走这里，别让整窗替换把刚确认的正数行抹掉。 */
      const { rows: merged } = mergeTail(msgs.value, asc);
      msgs.value = merged;
    } else {
      /* 轮 376：整窗替换不许吞掉在飞的乐观行，也不许吞掉发送已确认但不在
       * 这次首屏快照里的正数行（发完立刻重进时最容易撞上）。 */
      /* 轮382：快照自己可能同时带着「发送中」和「已发送」两条（上一条 RPC 还没回来），
       * 先在同一份快照里认领；再和屏上还在飞的乐观行认领。 */
      const snap = dropEchoedPending(asc);
      const incoming = new Set(snap.map((m) => String(m.id)));
      const claimed = claimPendingEcho(msgs.value, snap);
      /* 轮 377：负数待发行也只有不在 incoming 里才保留，防本地/IDB 同一条被 concat 两次。 */
      const keep = claimed.rows.filter((m) => !incoming.has(String(m.id)));
      msgs.value = dropEchoedDrafts(keep.length ? snap.concat(keep) : snap, snap);
      hasMore.value = rows.length === 30;
    }
    msgsConv = id;
    oldestId.value = oldestServerId(msgs.value);
    dmStoreSave(props.meId, id, msgs.value, hasMore.value);
    idbMerge(id, msgs.value);   /* 轮 204：镜像全量库 */
  } catch (e) {
    /* 轮 377：首屏网络失败时也要认领当前信，5s 轮询才能继续拉尾部救回；
     * 旧版把 msgsConv 清空，tick 的 msgsConv !== id 守卫会让它永远不再重试。 */
    if (!stale() && before == null && msgsConv !== id) { msgs.value = []; msgsConv = id; }
  } finally {
    if (!stale()) loadingMsgs.value = false;
  }
}

/* 轮 376：非当前会话的确认/撤回/失败行 —— 只更新已有历史，不凭空造残缺首帧。 */
async function persistInactive(id, row, { allowCreate = false, replaceId = null, removeId = null } = {}) {
  const owner = props.meId;
  if (!owner || !id || !row || row.id == null) return;
  try {
    if (replaceId != null) {
      /* 发送时已先把负数乐观行写进本地库；确认后必须换成正式行。 */
      dmStoreReplace(owner, id, replaceId, row);
    } else if (allowCreate || dmStoreLoad(owner, id).msgs.length) {
      dmStoreUpsert(owner, id, row);
    }
    const rec = await idbLoad(id);
    if (props.meId !== owner) return;   /* 等 IDB 期间换号：旧账号行不写进本机镜像 */
    /* allowCreate = 发送确认行/失败草稿：即使本地库还没有历史，也要镜像这一条；
     * 否则用户发的第一句在切走再进来时只剩 localStorage，清缓存就丢。 */
    if (rec && Array.isArray(rec.msgs) && (rec.msgs.length || allowCreate)) await idbMerge(id, [row]);
    /* 轮 376：tick/applyTail 可能把负数乐观行也镜像进 IDB；确认后摘掉。 */
    if (removeId != null) await idbRemoveRows(id, [removeId]);
  } catch (e) { /* 本地库不可用：进会话网络兜底 */ }
}

async function syncMeta() {
  const id = convId.value;
  const owner = props.meId;
  if (!id || !owner) return;
  try {
    const meta = await dmApi.convMeta(id);
    if (!alive || String(convId.value) !== String(id) || props.meId !== owner) return;   /* 轮 376：切信/换号后旧 meta 不许盖新头 */
    emit("peer", meta);
  } catch (e) { /* 用左列名字兜底 */ }
}

/* 轮381：漂流瓶聊天也要遵守「人真的在看才清红点」。旧版 tick 在 await 回来
 * 直接 markRead，手机切到后台收消息也会把红点清掉；后台回来又没有补一次，
 * 用户会看到「明明有新消息，红点却没了」。 */
const canClearRead = (id) => alive && !!id && !!props.meId && props.pageActive
  && chatting.value && String(convId.value) === String(id)
  && !(typeof document !== "undefined" && document.hidden);
function markBottleRead(id) {
  if (!canClearRead(id)) return;
  refreshBadge({ after: dmApi.markRead(id).catch(() => {}) });
}
function onBottleVisible() {
  if (!props.pageActive) return;
  if (typeof document !== "undefined" && document.hidden) return;
  if (chatting.value) markBottleRead(convId.value);
}
/* 从别的路由回到缓存中的消息页：父级 pageActive 变 true，补一次已读/轮询。 */
watch(() => props.pageActive, (v) => {
  if (!v) return;
  onBottleVisible();
  if (chatting.value) tick();
});
/* 选中一封信 → 已建会话就拉消息并抬已读；其它状态只发一次 peer（资料卡用左列名字） */
async function onLetter() {
  if (!alive) return;
  msgSeq++;
  decideSeq++;              /* 轮377：切信也作废旧决定请求的 loading/错误回写 */
  busyDecide.value = false;                 /* 轮 376：切信即作废上一封信所有在途响应 */
  msgs.value = [];
  msgsConv = "";
  oldestId.value = null;
  hasMore.value = true;
  loadingMsgs.value = false;
  sendErr.value = "";
  if (!props.letter) return;
  const owner = props.meId;
  if (peerId.value) emit("peer", { user_id: peerId.value, nickname: props.peerName });
  if (!chatting.value || !owner) return;
  const id = convId.value;
  await Promise.all([loadMessages(id), syncMeta()]);
  if (!alive || String(convId.value) !== String(id) || props.meId !== owner) return;   /* 轮 376：切走/换号后不要再抬旧会话已读 */
  /* 轮 254：等「已读」落库再刷角标（旧写法并发发，拉回旧值 → 红点不跟手）。
   * 轮381：后台加载完也不清，回到前台由 visibilitychange 补。 */
  markBottleRead(id);
}
watch(() => [props.letter && props.letter.id, convId.value, props.meId], onLetter, { immediate: true });

async function decide(accept) {
  if (busyDecide.value || !props.letter) return;
  const letter = props.letter;
  const letterId = letter.id;
  const owner = props.meId;
  if (!owner) return;
  const seq = ++decideSeq;
  busyDecide.value = true;
  try {
    const result = await bottleChatDecide(letterId, accept);
    if (!result || !["accepted", "declined"].includes(result.decision)) throw new Error("bottle-invalid-result");
    refreshBadge();
    if (!alive || seq !== decideSeq) { emit("decided", result.decision); return; }
    /* 轮 376：等 RPC 期间可能已经切到另一封信/换号。旧代码在 await 后读 props.letter，
     * 会把 A 的决定写进 B、甚至替 B 发 accepted 打开错会话。切走了只刷新列表，
     * 不再动当前信的头/不发 accepted。 */
    if (props.meId !== owner || !props.letter || props.letter.id !== letterId) {
      emit("decided", result.decision);
      return;
    }
    props.letter.chat_decision = result.decision;
    props.letter.conv_id = result.conv_id;
    emit("decided", result.decision);
    if (result.decision === "accepted" && result.conv_id) emit("accepted", result.conv_id);
  } catch (e) {
    if (alive && seq === decideSeq && props.meId === owner && props.letter && props.letter.id === letterId) {
      sendErr.value = t(bottleErrKey(e));
    }
  } finally {
    if (seq === decideSeq) busyDecide.value = false;
  }
}

/* 轮 339：发送入口只剩组件那一条（与「会话」段同一个 onVacSend 语义）。
 * 乐观上屏 / 失败行 / 落库全按旧逻辑，不新增第二套发送。 */
async function sendText(raw) {
  const err = validateSend(raw, null);
  if (err) { sendErr.value = t(err); return; }
  const text = String(raw || "").trim();
  const id = convId.value;
  const owner = props.meId;
  if (!id || !owner) return;
  const onSame = () => String(convId.value) === String(id);
  sendErr.value = "";
  /* 轮 377：发送前已有 id；超时/没回 msg_id 时用来认领服务端已经插入的回显。 */
  const beforeIds = new Set(msgs.value.map((m) => String(m.id)));
  /* 轮382：发送前窗口最大正式 id，供重开后的快照去重使用（与会话段同口径）。 */
  const beforeMax = maxPositiveId(msgs.value);
  const temp = {
    id: nextTempId(), sender: owner, body: text, image_path: null,
    created_at: new Date().toISOString(), pending: true,
    key: nextMsgKey(msgs.value),   /* 轮 352：稳定行 key（与会话段同款） */
    before_max: beforeMax,
  };
  msgs.value = msgs.value.concat([temp]);
  livePending.add(String(temp.id));
  /* 轮381：切到别的信再切回来时，activeId 已经回到 A，但 msgs 可能还是空的/
   * 还在加载。旧写法只看 convId，会把确认行 concat 进空列表甚至覆盖 A 的本地库；
   * 失败行也会同样把整段历史写没。只认 msgsConv：loadMessages 清屏时会同步清空，
   * 不能因为 temp 还挂在列表里就认定窗口属于这封信。 */
  const sameWindow = () => onSame() && String(msgsConv) === String(id);
  /* 轮 376：乐观行立刻落本地库；发完马上切信/重进时 RPC 可能还没回来。 */
  dmStoreUpsert(owner, id, temp);
  try {
    const r = await dmApi.send(id, text, null);
    /* dm_send 回传 {msg_id, created_at} → 就地落位，免整段重载（与会话段同款） */
    const mid = r && r.msg_id;
    const sameAccount = !!owner && props.meId === owner;
    if (mid != null) {
      const rowSrv = { id: mid, sender: owner, body: text, image_path: null,
        created_at: r.created_at || temp.created_at, deleted_at: null,
        key: temp.key };   /* 轮 352：沿用乐观行 key，组件原地更新不重挂 */
      if (!sameAccount) {
        /* 发送期间已登出/换号：服务器收到就行，旧账号本地行摘掉，重登后网络补。 */
        dmStoreRemove(owner, id, temp.id);
        idbRemoveRows(id, [temp.id]);
        msgs.value = msgs.value.filter((m) => String(m.id) !== String(temp.id));
      } else if (sameWindow()) {
        const rest = msgs.value.filter((m) => String(m.id) !== String(temp.id));
        /* 轮381：实时 INSERT 可能比 send RPC 先到，屏上已有这条但没有 key。
         * 把本次发送的稳定 key 补到已存在的行上，后面另一条同文发送超时认领时
         * 才能凭 key 认出「这条不是我的」，不会两条只留一条。 */
        const at = rest.findIndex((m) => String(m.id) === String(mid));
        msgs.value = at < 0
          ? rest.concat([rowSrv])
          : rest.map((m, i) => (i === at && (m.key == null || m.key === "")
            ? { ...m, key: temp.key } : m));
        dmStoreSave(props.meId, id, msgs.value, hasMore.value);
        const snapshot = msgs.value;
        await idbMerge(id, snapshot);
        await idbRemoveRows(id, [temp.id]);   /* 轮 376：别把负数乐观行留在全量库 */
        /* 轮 376：等全量库写完期间可能已切到另一封信，别把新信的锚点改成旧信的。 */
        if (props.meId === owner && String(convId.value) === String(id) && msgsConv === id) {
          oldestId.value = oldestServerId(msgs.value);
        }
      } else {
        /* 轮 376：发完已经切到别的信 —— 确认行必须落到**发送时那封信**的本地库，
         * 旧代码直接拿当前 msgs 落当前 conv，会把 A 的消息写进 B。 */
        await persistInactive(id, rowSrv, { allowCreate: true, replaceId: temp.id, removeId: temp.id });
        /* 轮381：人回到 A 但窗口尚未装回 A 时，只写库；把乐观行从当前
         * （不属于 A 的）列表里摘掉，等 loadMessages 装回完整历史。 */
        if (onSame()) msgs.value = msgs.value.filter((m) => String(m.id) !== String(temp.id));
      }
    } else if (!sameAccount) {
      /* 网关没回 msg_id 且已换号：别把旧账号的负数乐观行留在本地库转圈。 */
      dmStoreRemove(owner, id, temp.id);
      idbRemoveRows(id, [temp.id]);
      msgs.value = msgs.value.filter((m) => String(m.id) !== String(temp.id));
    } else if (onSame()) {
      await loadMessages(id);
      /* 轮378：loadMessages 期间可能换号/切信；先定住“还是不是同一封信”，
       * 不能拿新信的 msgs 去认领旧信的发送，也不能让旧信永远停在“发送中”。 */
      const stillSame = props.meId === owner && String(convId.value) === String(id) && msgsConv === id;
      /* 轮 377：快照里已经有这次发送的正式行，就认领它；别再标一条失败。 */
      const echo = stillSame ? findSentEcho(msgs.value, temp, beforeIds) : null;
      if (echo) {
        dmStoreRemove(owner, id, temp.id);
        msgs.value = msgs.value.filter((m) => String(m.id) !== String(temp.id));
        dmStoreSave(props.meId, id, msgs.value, hasMore.value);
        idbMerge(id, [echo]);
        idbRemoveRows(id, [temp.id]);
      } else if (!stillSame) {
        /* 换号/切信后拿不到回显：把旧信这条降级成失败草稿，重进旧信能点重发。 */
        const failedRow = { ...temp, pending: false, failed: true };
        dmStoreUpsert(owner, id, failedRow);
        idbMerge(id, [failedRow]);
      } else {
        /* 轮 376：网关没回 msg_id、拉回的快照也没确认这条时，别让它永远转「发送中」；
         * 降级成可重发的失败行（与 reviveLocal 同口径）。
         * 轮381：loadMessages 清屏会摘掉乐观行；即使 temp 已不在列表，也要补失败行，
         * 不能因为“找不到 pending 行”就让这条消息静默消失。 */
        const failedRow = { ...temp, pending: false, failed: true };
        msgs.value = msgs.value.some((m) => String(m.id) === String(temp.id))
          ? msgs.value.map((m) => (String(m.id) === String(temp.id) ? failedRow : m))
          : msgs.value.concat([failedRow]);
        dmStoreSave(props.meId, id, msgs.value, hasMore.value);
        idbMerge(id, msgs.value);
      }
    } else {
      /* 没回 msg_id 且已经切信：失败草稿写回发送时那封信，别留在本地库转圈。 */
      const failedRow = { ...temp, pending: false, failed: true };
      await persistInactive(id, failedRow, { allowCreate: true });
    }
    if (sameAccount) refreshBadge();
  } catch (e) {
    /* 失败行必须留在列表里 —— 行内红「!」，点它重发（组件能力） */
    const failedRow = { ...temp, pending: false, failed: true };
    const sameAccount = !!owner && props.meId === owner;
    /* 轮 377：超时/断网时实时行可能已经回来了；认领到回显就不再标失败。 */
    const echo = sameAccount && sameWindow() ? findSentEcho(msgs.value, temp, beforeIds) : null;
    if (echo) {
      dmStoreRemove(owner, id, temp.id);
      msgs.value = msgs.value.filter((m) => String(m.id) !== String(temp.id));
      dmStoreSave(props.meId, id, msgs.value, hasMore.value);
      idbMerge(id, [echo]);
      idbRemoveRows(id, [temp.id]);
    } else if (!sameAccount) {
      /* 登出/换号期间失败：不要把旧账号的失败行写进新账号的库。 */
      dmStoreRemove(owner, id, temp.id);
      idbRemoveRows(id, [temp.id]);
      msgs.value = msgs.value.filter((m) => String(m.id) !== String(temp.id));
    } else if (sameWindow()) {
      msgs.value = msgs.value.some((m) => String(m.id) === String(temp.id))
        ? msgs.value.map((m) => (String(m.id) === String(temp.id) ? failedRow : m))
        : msgs.value.concat([failedRow]);
      sendErr.value = t(sendErrKey(e));
      /* 轮 376：失败行落盘，返回列表再进来还能点红「!」重发。 */
      dmStoreSave(props.meId, id, msgs.value, hasMore.value);
      idbMerge(id, msgs.value);
    } else {
      /* 轮 376：切走后失败行也别丢；会话还没有任何历史时也要落库（第一句失败草稿）。
       * 轮381：切回 A 但 msgs 还没装回 A 也走这里；只写库，不拿空列表覆盖历史。
       * 如果人已经回到 A，错误原因仍要提示，加载完就能看到失败行。 */
      if (onSame()) {
        sendErr.value = t(sendErrKey(e));
        msgs.value = msgs.value.filter((m) => String(m.id) !== String(temp.id));
      }
      await persistInactive(id, failedRow, { allowCreate: true });
    }
  } finally {
    livePending.delete(String(temp.id));
  }
}

/* 组件里点红色「!」= 重发那条（同会话段口径：摘掉失败行，内容再走 sendText） */
function resend(id) {
  /* 轮381：摘行前先确认账号仍在、msgs 真的装着这封信；否则 sendText 会早退，
   * 失败行却已经从本地库/当前列表删掉，用户重进就再也找不到那句。 */
  if (!alive || !props.meId || !convId.value || String(msgsConv) !== String(convId.value)) return;
  const m = msgs.value.find((x) => String(x.id) === String(id) && x.failed);
  if (!m) return;
  const text = String(m.body || "").trim();
  if (!text) return;
  /* 先校验再摘行：万一内容已不合法（超长等），失败行不能被白白删掉。 */
  const err = validateSend(text, null);
  if (err) { sendErr.value = t(err); return; }
  dmStoreRemove(props.meId, convId.value, m.id);
  idbRemoveRows(convId.value, [m.id]);
  msgs.value = msgs.value.filter((x) => String(x.id) !== String(m.id));
  sendText(text);
}

function recallById(id) {
  const m = msgs.value.find((x) => String(x.id) === String(id));
  if (m) recall(m);
}

async function recall(m) {
  const id = convId.value;
  const owner = props.meId;
  if (!id || !owner) return;
  try {
    await dmApi.recall(m, owner);
    const patch = { ...m, deleted_at: new Date().toISOString(), body: "", image_path: null };
    /* 轮 376：撤回期间登出/换号 → 服务器已撤回，但本地不再写新账号的库。 */
    const sameAccount = !!owner && props.meId === owner;
    const hit = msgs.value.some((x) => String(x.id) === String(m.id));
    if (!sameAccount) {
      /* 旧账号本地库保持原样，重登后由网络校正。 */
    } else if (String(convId.value) === String(id) && hit) {
      msgs.value = msgs.value.map((x) =>
        (String(x.id) === String(m.id) ? { ...x, deleted_at: patch.deleted_at, body: "", image_path: null } : x));
      dmStoreSave(props.meId, id, msgs.value, hasMore.value);   /* 轮 194：撤回落盘 */
      idbMerge(id, msgs.value);   /* 轮 204：撤回镜像全量库 */
    } else {
      /* 轮 376：切信后 / 切回但列表还在加载时撤回成功，也更新原会话的已有历史，
       * 别让本地库继续留着旧正文。 */
      await persistInactive(id, patch);
    }
  } catch (e) {
    if (!!owner && props.meId === owner && String(convId.value) === String(id)) {
      const late = e && String(e.message || e).includes("too-late");
      sendErr.value = t(late ? "dm.errTooLate" : "dm.errNetwork");
    }
  }
}

/* 上滑加载更早（组件 fetch-messages → 这里） */
let loadingOlder = false;
async function loadMore() {
  if (loadingOlder || !hasMore.value || !oldestId.value || !convId.value || loadingMsgs.value) return;
  loadingOlder = true;
  try {
    const id = convId.value;
    const owner = props.meId;
    const before = oldestId.value;
    /* 轮378：上滑先吃 IndexedDB 的上一页。旧版直接走网络，断网时明明本地有
     * 全量历史却一直转/没反应，用户以为更早的消息丢了。 */
    let idbRows = [];
    try { idbRows = await idbOlderThan(id, before, 30); } catch (e) { idbRows = []; }
    if (!alive || !owner || props.meId !== owner || String(convId.value) !== String(id) || msgsConv !== id) return;
    /* 轮379：本地只剩 1~4 条更早历史也要先上屏（同 MessagesView）。 */
    if (idbRows.length > 0) {
      const have = new Set(msgs.value.map((m) => String(m.id)));
      const add = idbRows.filter((m) => m && m.id != null && !have.has(String(m.id)));
      if (add.length) {
        msgs.value = add.concat(msgs.value);
        oldestId.value = oldestServerId(msgs.value);
        hasMore.value = true;   /* 本地页之后可能还有更早，下一次上滑继续 */
        dmStoreSave(props.meId, id, msgs.value, hasMore.value);
        return;
      }
      /* 轮379：本地页全是已上屏的行时继续走网络，不能直接 return；
       * 否则 oldestId 不动，用户每次上滑都重复同一页却永远翻不动。 */
    }
    await loadMessages(id, { before });
  } finally {
    loadingOlder = false;
  }
}

/* 可见时 5s 轮询（与私信同节拍；只在本段已建会话时跑） */
let timer = null;
let tickBusy = false; /* 轮 157：上一拍没回来就跳过 */
async function tick() {
  if (!alive || !props.pageActive) return;
  if (tickBusy) return;
  /* 轮381：首屏/切信加载还在跑时，msgsConv 已被清空；tick 若先回来会
   * 把「最新 20 条」当成整段历史写进本地库，把更早历史挤掉。 */
  if (loadingMsgs.value) return;
  if (typeof document !== "undefined" && document.hidden) return;
  if (!chatting.value) return;
  const id = convId.value;
  const seq = msgSeq;
  const owner = props.meId;
  if (!id || !owner) return;
  tickBusy = true;
  try {
    /* 轮 157：尾部增量合并（与会话段同款）——历史不再被轮询冲掉 */
    const got = (await dmApi.listMessages(id, { before: null, limit: 20 })) || [];
    /* 轮 376：等响应期间可能已切信/换号；旧版会把 A 的尾部并进 B。 */
    if (!alive || seq !== msgSeq || String(convId.value) !== String(id) || msgsConv !== id || props.meId !== owner) return;
    const asc = got.slice().reverse();
    if (asc.length) {
      const { rows, added } = mergeTail(msgs.value, asc);
      if (rows !== msgs.value) {
        msgs.value = rows;
        oldestId.value = oldestServerId(msgs.value);
        /* 轮 376：新增和原位更新（撤回等）都要落本地库；旧版只在 load/send 写，
         * 在漂流瓶聊天里收到消息后离开再进，本地库还是旧的。 */
        dmStoreSave(props.meId, id, msgs.value, hasMore.value);
        idbMerge(id, msgs.value);
        if (added) markBottleRead(id);
      }
    }
  } catch (e) { /* 静默 */ }
  finally { tickBusy = false; }
}
onMounted(() => {
  timer = setInterval(tick, 5000);
  document.addEventListener("visibilitychange", onBottleVisible);
});
onBeforeUnmount(() => {
  /* 轮380：先作废在途请求，再停轮询。只清 timer 挡不住已经 await 的
     loadMessages / onLetter / tick / decide 回来继续写。 */
  alive = false;
  msgSeq++;
  decideSeq++;
  clearInterval(timer);
  timer = null;
  document.removeEventListener("visibilitychange", onBottleVisible);
});
</script>

<template>
  <section class="card dm-thread bchat">
    <p v-if="!letter" class="sub dm-empty bchat-empty">{{ t("bottle.chatPick") }}</p>

    <template v-else>
      <header class="dm-thread-head">
        <n-avatar round :size="40" class="dm-msg-avatar clickable" :title="t('dm.viewHome')" :src="avatarUrlFor(peerId) || undefined" @click="goUser(peerId)"><template v-if="!avatarUrlFor(peerId)" #default>{{ peerInitial }}</template><template v-else #fallback>{{ peerInitial }}</template></n-avatar>
        <b class="dm-name dm-peer-link" :title="t('dm.viewHome')" @click="goUser(peerId)">{{ props.peerName || t("bottle.peerFallback") }}</b>
        <span class="bchat-tag">{{ t("bottle.title") }}</span>
        <span class="dm-spacer"></span>
        <!-- 轮 143 · 右上角「…」菜单由父级（MessagesView）注入：与会话头同一份内容 -->
        <slot name="headtools"></slot>
      </header>

      <!-- ② 待我决定 / 其它状态：原信 + 回信 + 说明（无输入框） -->
      <div v-if="!chatting" class="dm-scroll bchat-letter">
        <article class="bchat-card">
          <b class="sub">{{ letter.user_id === meId ? t("bottle.myLetter") : t("bottle.fromSea") }}</b>
          <p class="bchat-text">{{ letter.body }}</p>
        </article>
        <article v-if="letter.reply" class="bchat-card">
          <b class="sub">{{ t(letter.reply_by === meId ? "bottle.replyMine" : "bottle.replyFrom") }}</b>
          <p class="bchat-text">{{ letter.reply }}</p>
        </article>
        <template v-if="state === 'choose'">
          <p class="sub">{{ t("bottle.chatQuestion") }}</p>
          <p v-if="sendErr" class="sub dm-err">{{ sendErr }}</p>
          <div class="bchat-decide">
            <n-button type="primary" round size="small" :loading="busyDecide" @click="decide(true)">
              {{ t("bottle.chatAccept") }}
            </n-button>
            <button class="dm-act" :disabled="busyDecide" @click="decide(false)">{{ t("bottle.chatDecline") }}</button>
          </div>
        </template>
        <p v-else class="sub">{{ t(statusTk) }}</p>
      </div>

      <!-- ③ 已建会话：与会话段同一个组件（消息流 + 输入区 + 表情 + 失败重发 + 键盘保持）。
           头部仍用上面那条旧头（胶囊 + ⋯），组件自己的头藏掉。 -->
      <DmVacChat
        v-else
        hide-header
        :convs="vacConvs"
        :messages="msgs"
        :room-id="convId"
        :me-id="meId"
        :peer-name="peerName"
        :loading-messages="loadingMsgs"
        :placeholder="t('dm.placeholder')"
        :peer="vacPeer"
        :err="sendErr"
        :drafts="drafts"
        @send="sendText"
        @recall="recallById"
        @load-more="loadMore"
        @resend="resend"
        @draft="(e) => emit('draft', e)" />
    </template>
  </section>
</template>
