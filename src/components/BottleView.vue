<!-- 温暖漂流瓶（T6 抽件）：写信投海 / 捞信回信放回 / 记录两栏分页。
     轮 37 起**全线上**：次数、托盘、记录一律现拉服务器（本机不再留次数账本、不再用
     SWR 快照顶显示），页面里没有一份「本地缓存」决定行为。
     桌面首页收尾与手机「漂流瓶」联（默认联）共用同一组件。 -->
<script setup>
import { ref, computed, watch, onMounted, onDeactivated, nextTick } from "vue";
import { useRouter, useRoute } from "vue-router";
import { NButton, NInput, NModal, useDialog } from "naive-ui";
import ReportDialog from "./ReportDialog.vue";
import { isMobileNav } from "../stores/uiStore.js";
import { t } from "../i18n.js";
import { langName, uiLang } from "../utils/contentLang.js";
/* 轮446：作者撤回 / 隐藏自己投的信 —— 两个 can* 是纯函数判据（有单测）。
   注意：大括号里不写注释，undef-check 的解析器会把注释和标识符粘在一起（既有踩坑）。 */
import {
  BOTTLE_BODY_MIN, BOTTLE_BODY_MAX, BOTTLE_SEND_MAX, BOTTLE_PICK_MAX, BOTTLE_FISH_MAX,
  bottleBodyChars, bottleErrKey,
  bottleSend, bottleFish, bottleReply, bottleRelease, bottleHeld, bottleQuota,
  bottleRecords, bottleChatState, bottleChatDecide, purgeLegacyBottleLocals,
  sortBottleMine, bottlePendingCount, bottlePageCount, bottlePageSlice, clampBottlePage,
  canWithdrawLetter, canHideLetter, bottleWithdraw, bottleHide, bottleUnhide, bottleHiddenLetters,
} from "../utils/bottle.js";
import { relativeTime } from "../utils/dmRules.js";
/* 轮 319：记录卡长文本折叠（信文/回信各钳 4 行，真溢出才给「展开全文」） */
import { needsFold, foldKey, isOverflowing } from "../utils/foldText.js";
import { cloud } from "../utils/supabase.js";

const router = useRouter();   /* #17 记录里「去聊天」直接进会话页 */
const route = useRoute();       /* 轮 238:离开漂流瓶联自动关弹窗 */
/* 托盘只在漂流瓶联显示(桌面内联不受影响) */
const trayOn = computed(() => !isMobileNav.value || route.query.tab === "bottle");
const cloudSigned = computed(() => !!(cloud.ready && cloud.user));
/* 轮 356：Vant autosize 不传 maxHeight 时会按 scrollHeight 一路长高——手机上一封
 * 长信能写到 1000 字，输入框实测长到 1200px，整屏都被它铺满（用户实报）。
 * 主写信框封 160px（约 6 行），回信框封 120px；超出部分在框内滚动，不再撑高页面。 */
const MAIL_AUTOSIZE = { maxHeight: 160 };
const REPLY_AUTOSIZE = { maxHeight: 120 };
const mailDraft = ref("");
const mailField = ref(null);      /* 「空海时引导」用：把焦点送回写信框 */
const mailChars = computed(() => bottleBodyChars(mailDraft.value.trim()));
const replyDraft = ref("");
const mailBusy = ref(false);
const mailHint = ref("");
const fishing = ref(false);
const fished = ref(null);       /* 刚捞起、还没处理的这封 */
const held = ref([]);           /* 我之前捞起、还没回的信（换页/刷新后找回来） */
const trayErr = ref("");        /* 托盘读取失败提示（轮 37：直连服务器，失败如实说，不用旧快照顶） */

/* 待处理信箱（轮 18）：新捞的 + 之前捞起没回的，合并去重逐封处理。
 * 旧版只显示一封、且手里压着一封就禁捞新信——「每天能捞 7 次」被做成了
 * 「捞 1 次就被锁」。现在多封并存互不阻塞，捞瓶按钮只看剩余次数。 */
const pending = ref([]);
/* 轮 241：id 一律 String() 归一比较 —— 捞信 RPC 与 bottle_held 两条链的 id 类型
 * 可能一侧 number 一侧 string（Supabase RPC json vs SETOF 的经典坑，真机实证：
 * bottle_release 返回 200、托盘却还在 = filter/Map key 因类型不等失效，pending 被复活）。 */
function mergePending() {
  const map = new Map();
  for (const l of held.value) map.set(String(l.id), l);
  if (fished.value && fished.value.id != null) map.set(String(fished.value.id), fished.value);
  pending.value = [...map.values()];
}

/* 轮 22/25：捞信结果一律居中弹窗——捞到（就地回信/放回）、没捞到、限额，全部有明确反馈；
 * 「先收着，稍后回」按用户要求移除（捞到就当场回信或放回，不许囤） */
const fishPop = ref({ show: false, mode: "msg", letter: null, msg: "" });
/* 轮 439：捞到的信不是本语言时给一句「这封信是英语写的」。
   用到 langName 而不是 langBadge —— 这里要读成句子，不能是 EN 这种代码。 */
const fishLang = computed(() => {
  const l = fishPop.value.letter;
  if (!l || !l.lang || l.lang === "und") return "";
  return l.lang === uiLang() ? "" : langName(l.lang);
});
/* 轮 411：举报弹窗；同一封信举报后不再发给我，3 人举报后全局隐藏 */
const reportShow = ref(false);
const reportTarget = ref(null);
function openReport(l) {
  if (!l || !l.id) return;
  reportTarget.value = { type: "bottle", id: l.id, label: String(l.body || "").slice(0, 80) };
  reportShow.value = true;
}

/* 轮 26：捞信悬死兜底——正常一网 1-3s；超时只是给出口，不给「永远转圈」死局。
 * 轮 254（用户拍板）：8s → 6s，超时提示改「没捞到」口径（等 6 秒没反应 = 没捞到）。 */
const FISH_TIMEOUT = 6000;

/* ═══ 轮 254 · 捞网会话代际（修「切走再回来，旧弹窗又弹出来」）═══
 * 真因：HomeView 被 KeepAlive 保活，轮 238 的 watch 只关掉了弹窗**本体**；
 * 在飞的 bottleFish() promise 落地时（超时/出错/捞到），回调又按
 * `route.query.tab === "bottle"` 决定弹不弹 —— 用户此时若已切回漂流瓶联，
 * 旧弹窗就复活（用户实报：「切回别的页面再返回，又弹出之前的弹窗」）。
 * 修法：离开漂流瓶（切页签 / 切页失活）即作废当前会话（fishGen++），
 * 在飞请求落地时会话已失效 → 一律不补弹窗：捞到的信走托盘找回，提示全部丢弃。 */
let fishGen = 0;
/* 轮 303：投信会话代际——与 fishGen 并列（捞信/投信各自作废互不影响）。
 * 投信落地时若人已切走（tab/失活），提示弹窗一律不补弹（信已在库里，记录区照常刷新）。 */
let sendGen = 0;
function abandonFish() {
  fishGen++;
  sendGen++;
  fishPop.value.show = false;
  fishing.value = false;   /* 会话作废即停转圈；旧会话 finally 见代际不符不再复位 */
}

/* ════════ 次数：唯一真相是服务端 bottle_quota()（轮 37 / 411）════════
 * 用户点名「什么每天捞 7 瓶、写 3 瓶，老老实实改成线上」。此前本机留着一本乐观
 * 账（`warm-paws-bottle-quota-v1:<uid>`）：服务端值还没回来（或拉不到）时它顶上去
 * 显示满额 —— 于是「明明用完了还显示还能捞」；账本本身也跨不了端（网页与 App 各记各的）。
 * 现在本机不再存任何次数：
 *   · 显示只认服务端值：没拉到 = null = 界面写「次数同步中…」，绝不编数字；
 *   · 发信/捞信/回信成功后一律重新拉服务端值，客户端不做 +1、不留账本；
 *   · 额度按滚动 24h 计：投 5 封 / 捞 30 瓶 / 回 7 封；
 *   · 拉不到（网络/未跑迁移）也不拦操作，如实提示「次数以服务器为准」，
 *     真限额由 SQL RPC 的 bottle-limit-* 兜底 —— 前端永远不替服务端做减法。 */
const myId = computed(() => (cloud.user && cloud.user.id) || "");
const quota = ref(null);        /* { sent, picked, fished } —— 只可能是服务端返回的值 */
const quotaErr = ref("");       /* 拉不到时的 i18n key（提示用，不拦操作） */
async function syncQuota() {
  if (!cloudSigned.value) { quota.value = null; quotaErr.value = ""; return; }
  try {
    const q = await bottleQuota();
    if (!q || typeof q.sent !== "number" || typeof q.fished !== "number") {
      quota.value = null;
      quotaErr.value = "bottle.quotaUnavailable";
      return;
    }
    /* 老服务端还没有 picked：按 0 处理，捞信上限仍由服务端兜底。 */
    quota.value = {
      sent: q.sent,
      fished: q.fished,
      picked: typeof q.picked === "number" ? q.picked : 0,
    };
    quotaErr.value = "";
  } catch (e) {
    quota.value = null;
    quotaErr.value = "bottle.quotaUnavailable";
  }
}
const sendLeft = computed(() => (quota.value ? Math.max(0, BOTTLE_SEND_MAX - quota.value.sent) : null));
const pickLeft = computed(() => (quota.value ? Math.max(0, BOTTLE_PICK_MAX - quota.value.picked) : null));
const fishLeft = computed(() => (quota.value ? Math.max(0, BOTTLE_FISH_MAX - quota.value.fished) : null));
/* 捞信要同时满足「捞取额度」和「回信额度」；未知（null）不拦，交给服务端兜底。 */
const canFish = computed(() => {
  if (pickLeft.value === null || fishLeft.value === null) return null;
  return pickLeft.value > 0 && fishLeft.value > 0;
});
/* 次数文案：拿到服务端值才显示数字；没拿到就说「同步中」（不编满额数字骗用户） */
const sendText = (v) => (v === null ? t("bottle.quotaSyncing") : t("bottle.leftSend", { n: v }));
const pickText = (v) => (v === null ? t("bottle.quotaSyncing") : t("bottle.leftPick", { n: v }));
const fishText = (v) => (v === null ? t("bottle.quotaSyncing") : t("bottle.leftFish", { n: v }));
/* 登录就绪/换号 → 次数与托盘一律重读（修「首次进主页漂流瓶记录空白，必须手动点刷新」：
 * 旧版只在 onMounted 拉一次，那时会话往往还没就绪，拉了个空就再也不拉了）。
 * 轮 41（真根因）：只挂「会话变化」监视是不够的 —— App 启动路径是
 * 「splash 等 initCloud 就绪 → 再挂 HomeView/BottleView」，会话先于组件就绪，
 * watch 永不触发 → 次数/托盘/记录一次都不查，直到点「捞一瓶」才第一次发请求
 * （用户报「进首页不提前查、点漂流瓶一直出不来」）。所以初始那一次必须**主动查**。
 *
 * ⚠️ 轮 42 修（轮 41 事故）：初始查询**不能**写成 watch(..., { immediate: true })。
 * immediate 会在 **watch 那一行同步执行**回调，而回调要动 recPage/recTab/recLoading
 * 这些**在后面才声明的 const** —— 此时它们还在 TDZ 里，直接
 * `ReferenceError: Cannot access 'ht' before initialization`（打包后 recPage 被压成 ht），
 * setup 抛错 → App.vue 错误边界接管 → 首页整页变「这里好像有点小状况」，
 * 漂流瓶/首页数据全都出不来（用户报「启动后首页啥也没有」）。 */
function onSessionChanged() {
  quota.value = null;      /* 换人就先清空：绝不拿上一个人的次数顶着显示 */
  quotaErr.value = "";
  fished.value = null;
  recPage.value = 0;
  recMineAll.value = [];
  if (cloudSigned.value) {
    refreshBottle();
    loadRecords(true);
    syncQuota();
  }
}
/* 只挂「会话就绪/换号」；初始那一次由下方 onMounted 显式调用（那时所有 const 都已就绪） */
watch([cloudSigned, myId], onSessionChanged);

async function refreshBottle() {
  if (!cloudSigned.value) return;
  /* #17 记录区改走 bottleRecords 分类分页；这里只管「捞起未回的信」找回（待处理信箱）。
   * 轮 37：不再先渲染本机快照（原来 swr 会先闪一份旧托盘）——手里的信必须是服务器
   * 此刻的真实持有，否则换号/换端会看到不属于自己的待回信。 */
  try {
    const rows = await bottleHeld();
    held.value = Array.isArray(rows) ? rows : [];
    trayErr.value = "";
  } catch (e) {
    held.value = [];
    trayErr.value = bottleErrKey(e);
  }
  fished.value = null;
  mergePending();
}

async function doSend() {
  const body = mailDraft.value.trim();
  /* sendLeft === null（次数还没同步回来）不拦：交给服务端裁定，限额由 RPC 兜底。
     内容质量在本地先拦一次，避免短内容白跑一趟网络。 */
  if (!body || sendLeft.value === 0) return;
  if (bottleBodyChars(body) < BOTTLE_BODY_MIN) { mailHint.value = t("bottle.errTooShort"); return; }
  if (bottleBodyChars(body) > BOTTLE_BODY_MAX) { mailHint.value = t("bottle.errTooLong"); return; }
  /* 轮 315（用户拍板）：投信成功**不弹窗**，改行内提示；**不等**服务端回来——
   * 草稿立即清空、行内先闪「已投进海里」（乐观），后台 in-flight 慢慢走：
   * 跨境 1~2s 的串行链（bottleSend → quota → records → held）在后台完成，
   * 成功只补刷新（记录区照常自动添新瓶），失败才弹窗 + 草稿恢复。
   * 轮 315 沿用轮 303 的代际守卫（sendGen）——只护失败弹窗的补弹（切走不复活）。
   * 轮 317（用户拍板）：不许上来就报成功 —— 点击先「投递中」+转圈（立即有反馈但不撒谎），
   * 服务端真确认才翻「投递成功」；失败走红字+弹窗+草稿恢复。 */
  const gen = ++sendGen;
  const alive = () => gen === sendGen;
  mailBusy.value = true;
  mailHint.value = "sending";
  mailDraft.value = "";
  try {
    await bottleSend(body);
    mailHint.value = "sent";      /* 轮 317：服务端确认 → 才报成功 */
    syncQuota();          /* 轮 37：次数只回读服务端值，本机不做 +1、不留账本 */
    loadRecords(true);    /* 轮 303：自动刷新记录（代数守卫在 loadRecords 内部，切页签不串页） */
    refreshBottle();
    mailHint.value = "";  /* 后台链全跑完：提示任务已达成，自动收起 */
  } catch (e) {
    const k = bottleErrKey(e);
    mailHint.value = t(k);        /* 失败：行内红字 + 弹窗（限额/断网必须让用户知道） */
    mailDraft.value = body;       /* 失败：草稿恢复，信没丢 */
    /* 轮 254 口径：人已切走（sendGen 作废）→ 失败弹窗不补弹，行内红字留作回来看到的残影 */
    if (alive()) fishPop.value = { show: true, mode: "msg", letter: null, msg: t(k) };
    /* 轮 20：限额报错 = 服务端账本与显示错位的信号 → 立刻拉服务端次数对齐显示 */
    if (k === "bottle.errSendLimit") syncQuota();
  } finally { mailBusy.value = false; }
}

/* 空海引导（轮 411）：不是只丢一句「海里没信」，而是把落点送到写信框。 */
function focusComposer() {
  fishPop.value.show = false;
  nextTick(() => {
    try { if (mailField.value && typeof mailField.value.focus === "function") mailField.value.focus(); } catch (e) { /* 组件未挂载 */ }
    const el = mailField.value && mailField.value.$el ? mailField.value.$el : mailField.value;
    try { if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (e) { /* 老浏览器 */ }
  });
}

async function doFish() {
  if (canFish.value === false) return;   /* 未知（null）不拦：真限额由服务端 bottle-limit-* 兜底 */
  if (fishing.value) return;          /* 轮 254：loading 态的 n-button 仍会派发 click，防重入 */
  const gen = ++fishGen;
  const alive = () => gen === fishGen;
  fishing.value = true;
  mailHint.value = "";
  /* 轮 26：按下**瞬间**就弹「撒网中」——不再等网络回来才有反应（反馈 <100ms，
   * 出信快慢交给网络，正常一网 1-3s，用户要求 3s 内有结果）。 */
  fishPop.value = { show: true, mode: "fishing", letter: null, msg: "" };
  try {
    const l = await Promise.race([
      bottleFish(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("bottle-slow")), FISH_TIMEOUT)),
    ]);
    if (!l || !l.id) {
      /* 竞态兜底（轮 18）：服务端抢占落空返回空 → 明示「海里暂时没信」，绝不扣次数 */
      if (!alive()) return;   /* 轮 254：会话已作废——连空捞提示也不补弹 */
      mailHint.value = t("bottle.errEmpty");
      fishPop.value = { show: true, mode: "empty", letter: null, msg: t("bottle.errEmpty") };
      return;
    }
    fished.value = l;
    /* 轮 21 / 411：捞到记 1 次捞取额度（放回不返还）；回信另计回信额度，客户端完全不记账。
     * 这里只回读一次服务端权威值（服务端记账在 bottle_fish()/bottle_reply()）。 */
    mergePending();
    syncQuota();
    /* 轮 22：捞到了 → 居中弹窗直接展示这封信（可就地回信/放回，不再让人猜捞没捞到）。
     * 轮 254：会话已作废（人已切走）→ 与「不在漂流瓶联」同一条路：信进「手里」托盘，不补弹窗 */
    if (alive() && route.query.tab === "bottle") fishPop.value = { show: true, mode: "got", letter: l, msg: "" };
    else refreshBottle();   /* 人不在漂流瓶联:信进「手里」托盘,不弹窗 */
  } catch (e) {
    const k = String(e && e.message) === "bottle-slow" ? "bottle.errSlow" : bottleErrKey(e);
    /* 轮 20：限额报错 → 立即同步服务端次数（一次点击内对齐，不再「显示还能捞但说用完」） */
    if (k === "bottle.errFishLimit" || k === "bottle.errPickLimit") syncQuota();
    if (!alive()) return;   /* 轮 254：会话已作废——切走回来不补弹旧提示（超时/出错一律丢弃） */
    mailHint.value = t(k);
    /* 轮 22：点了捞却没动静的几类原因（海里空/额度用完/囤太多）也弹窗说清；
       空海走 empty 模式，额外给「先投一封」的落点。 */
    if (route.query.tab === "bottle") {
      fishPop.value = { show: true, mode: k === "bottle.errEmpty" ? "empty" : "msg", letter: null, msg: t(k) };
    } else mailHint.value = t(k);
  } finally { if (alive()) fishing.value = false; }
}

/* 回信/放回按信独立操作：待处理信箱可同时有多封，互不阻塞 */
const replyDrafts = ref({});
const busyId = ref("");
/* 轮 361：回信错误按信 id 贴在输入框旁。旧版只写页面顶部 mailHint，
 * 用户滚在记录卡/托盘里点「回信」时看不到任何反应，误以为按钮坏了。 */
const replyErr = ref({});
const replyText = (id) => String(replyDrafts.value[id] || "").trim();
const replyLen = (id) => bottleBodyChars(replyText(id));
const replyOver = (id) => replyLen(id) > BOTTLE_BODY_MAX;
function setReplyErr(id, msg) {
  const next = { ...replyErr.value };
  if (msg) next[id] = msg; else delete next[id];
  replyErr.value = next;
}
function replyTooLongText(n) {
  return n > BOTTLE_BODY_MAX
    ? t("bottle.replyTooLong", { n })
    : t("bottle.errTooLong");
}
function onReplyInput(id, value) {
  setReplyErr(id, "");
  const n = bottleBodyChars(String(value ?? replyDrafts.value[id] ?? "").trim());
  if (n > BOTTLE_BODY_MAX) setReplyErr(id, replyTooLongText(n));
}
/* 轮 24c：记录卡上「回信」→ 卡内展开输入框（replyOpen = 该信 id） */
const replyOpen = ref("");
function openReply(l) {
  if (!l) return;
  fishPop.value.show = false;
  replyOpen.value = replyOpen.value === l.id ? "" : l.id;
  setReplyErr(l.id, "");
}
async function doReply(l) {
  const body = String(replyDrafts.value[l.id] || "").trim();
  if (!l || !body || busyId.value) return;
  /* 轮 361：超限先在本地拦住，错误贴在当前输入框旁，不发请求。 */
  if (bottleBodyChars(body) > BOTTLE_BODY_MAX) {
    setReplyErr(l.id, replyTooLongText(bottleBodyChars(body)));
    return;
  }
  setReplyErr(l.id, "");
  busyId.value = l.id;
  mailHint.value = "";
  try {
    await bottleReply(l.id, body);
    setReplyErr(l.id, "");
    replyDrafts.value = { ...replyDrafts.value, [l.id]: "" };
    fished.value = null;
    replyOpen.value = "";
    held.value = held.value.filter((x) => String(x.id) !== String(l.id));
    /* 轮 21：回信成功才计 1 次（服务端 bottle_reply 盖章）；轮 37 本机不再记账，只回读服务端值 */
    mergePending();
    syncQuota();
    fishPop.value.show = false;   /* 轮 22：在弹窗里回的信 → 弹窗关闭 */
    refreshBottle();   /* 轮 238：记录/托盘后台刷新，不 await（回信成功已就地更新） */
  } catch (e) {
    const k = bottleErrKey(e);
    if (k === "bottle.errFishLimit" || k === "bottle.errPickLimit") syncQuota();
    setReplyErr(l.id, k === "bottle.errTooLong" ? replyTooLongText(bottleBodyChars(body)) : t(k));
  } finally { busyId.value = ""; }
}

async function doRelease(l) {
  if (!l || busyId.value) return;
  busyId.value = l.id;
  /* 轮 238 · 放回海里 = **乐观执行**：弹窗立即关、信立即从手里消失——「它走了」不需要
   * 等服务端点头（旧版 await RPC + await refreshBottle 两条慢链串行，用户实测 20s 无反应）。
   * RPC 后台确认；失败还原 + 弹窗告知。放回不扣次数，无需同步配额。 */
  const fromPopup = !!(fished.value && String(fished.value.id) === String(l.id));
  const heldSnapshot = held.value.slice();
  fishPop.value.show = false;
  fished.value = fromPopup ? null : fished.value;
  held.value = held.value.filter((x) => String(x.id) !== String(l.id));
  /* 轮 241：乐观放回后就地重算托盘。pending 是 mergePending() 的快照，不重算则
   * 弹窗关闭、托盘接力显示的瞬间会把刚放回的那封再端出来（与 v-show 接力修复配套）。 */
  mergePending();
  try {
    await bottleRelease(l.id);
  } catch (e) {
    held.value = heldSnapshot;
    if (fromPopup) { fished.value = l; fishPop.value = { show: true, mode: "got", letter: l, msg: "" }; }
    mailHint.value = t(bottleErrKey(e));
  } finally { busyId.value = ""; }
}

/* 轮 37：进页面先清掉老版本留在家里的本地漂流瓶数据（次数账本 + SWR 快照），
 * 再全部现拉服务器 —— 页面里不再有任何本地缓存参与显示。
 * 轮 42：初始查询在这里显式触发（onMounted 在 setup 全部执行完之后才跑，
 * onSessionChanged 里用到的 const 一定都已初始化 —— 修 TDZ 崩溃，见上方注释）。 */
onMounted(() => { purgeLegacyBottleLocals(); onSessionChanged(); });
/* 轮 238 · 离开漂流瓶联:弹窗即关（信在「手里」随时可找回）——
 * 旧版无关闭钮 + 蒙版不关 + 跟着人走到别的联（用户实测困在宠物页），全修。
 * 轮 254：升级为 abandonFish() —— 关弹窗之外还作废在飞会话（不补弹旧弹窗）。 */
watch(() => route.query.tab, (v) => {
  if (v !== "bottle") abandonFish();
});
/* 轮 254 · 切页（HomeView 被 KeepAlive 保活，watch(route.query.tab) 覆盖不到
 * 「离开首页整页」这条路）：组件失活即作废会话——切走再回来绝不弹旧弹窗。 */
onDeactivated(abandonFish);

/* —— 漂流瓶记录（#17）：我发布的 / 我捞到的 两类，按时间新→旧，10 条一页 ——
 * 轮 368：两类都先取最多 200 条到本地（沿用「我发布的」旧口径），再本地分页；
 * 这样首页/尾页/手输页码都能立即算出来，也保证待决定的信稳定置顶。 */
const REC_PAGE = 10;
const REC_ALL_LIMIT = 200;
const recTab = ref("mine");      /* mine = 我发布的；held = 我捞到的 */
const recRows = ref([]);
const recPage = ref(0);
const recLoading = ref(false);
const recAll = ref([]);          /* 当前页签的全量数据（≤200 条）——本地分页数据源 */
const recMineAll = ref([]);      /* 「我发布的」独立留一份：切到「我捞到的」时红点不消失 */
const recPageCount = computed(() => bottlePageCount(recAll.value.length, REC_PAGE));
const recPending = computed(() => bottlePendingCount(recMineAll.value, myId.value));
const recJump = ref(1);
watch(recPage, (p) => { recJump.value = p + 1; });

/* 轮 238 · 代数守卫：切换页签必须作废在途响应——
 * 旧版 recLoading 守卫会**吞掉点击**（挂载加载在飞时点另一页签 = 静默 return），
 * 且旧数据回来渲染在新页签下 = 内容与页签错位（用户实测「切换不跟手」）。 */
let recGen = 0;

function setRecPage(p) {
  const next = Math.min(Math.max(0, Math.floor(Number(p) || 0)), recPageCount.value - 1);
  recPage.value = next;
  recRows.value = bottlePageSlice(recAll.value, next, REC_PAGE);
}

async function loadRecords() {
  if (!cloudSigned.value) return;
  const gen = ++recGen;
  recLoading.value = true;
  recErr.value = "";
  /* 轮 37：记录列表也不再走本机快照（原来每栏第 0 页存一份 SWR 缓存，换号/换端会先闪
   * 别人的或过期的记录）——拉到的就是服务器此刻的记录，失败如实报错，不用旧快照假装成功。 */
  try {
    const got = await bottleRecords(null, 0, { mine: recTab.value === "mine", limit: REC_ALL_LIMIT });
    if (gen !== recGen) return;   /* 已被更新的切换作废：整批丢弃，不落任何数据 */
    const rows = recTab.value === "mine"
      ? sortBottleMine(Array.isArray(got) ? got : [], myId.value)
      : (Array.isArray(got) ? got : []);
    recAll.value = rows;
    if (recTab.value === "mine") recMineAll.value = rows;
    recPage.value = 0;
    recRows.value = bottlePageSlice(rows, 0, REC_PAGE);
    /* 轮446：顺手拉「已隐藏」清单（列表底部的「已隐藏 N 封」要用）；失败不挡主流程 */
    if (recTab.value === "mine") { hiddenRows.value = []; loadHidden(); }
  } catch (e) {
    if (gen !== recGen) return;
    recRows.value = [];
    recAll.value = [];
    if (recTab.value === "mine") recMineAll.value = [];
    recErr.value = bottleErrKey(e);
  } finally {
    if (gen === recGen) recLoading.value = false;
  }
}
function switchRecTab(x) {
  if (recTab.value === x) return;
  recTab.value = x;
  recRows.value = [];        /* 旧页签内容立即让位：加载态立现，不再挂着旧数据装作已切换 */
  loadRecords();
}
function recPageGo(d) {
  setRecPage(recPage.value + d);
}
function recJumpTo(value) {
  const n = Math.floor(Number(value) || 0);
  setRecPage(n > 0 ? n - 1 : 0);
}
const whenRec = (ts) => relativeTime(ts, Date.now(), t);

/* 我发布的一封的当前状态：被捞走 / 已有回信 / 还在海里；我捞到的：已回信 / 在我手里 / 已放回 */
function recState(l) {
  if (recTab.value === "mine") {
    /* 收到回信还没决定 → 直接在这条记录上给「同意 / 拒绝」按钮（用户反馈：点不了=没用） */
    if (bottleChatState(l, myId.value) === "choose") return "bottle.stDecide";
    if (l.status === "answered") return "bottle.stReplied";
    if (l.status === "held") return "bottle.stPicked";
    return "bottle.stSea";
  }
  /* 轮 49：已回信但对方还没同意/婉拒（chatState=waiting）→ 明示「待对方同意后可聊天」，
     不再笼统显示「你已回信」（用户：这时候要给提示，简洁一点）；同意后 canChat 直接进聊天。 */
  if (l.reply_by === myId.value) {
    if (bottleChatState(l, myId.value) === "waiting") return "bottle.stWaitAgree";
    return "bottle.stAnswered";
  }
  if (l.status === "held") return "bottle.stInHand";
  return "bottle.stReleased";
}

/* ═══ 轮 319 · 记录卡长文本折叠（信文/回信各自独立） ═══
 * 默认钳 4 行（fade 渐隐）；按钮只在**渲染后实测溢出**时出现（不猜字数）。
 * 收起态 clamp 生效 → clientHeight 被钳、scrollHeight 是内容全高，直接可比。
 * 状态键 `${id}|body` / `${id}|reply`——一长一短互不拖累；展开态只增不清（按钮不闪没）。 */
const foldOpen = ref({});     /* key → true = 已展开 */
const foldOver = ref({});     /* key → true = 收起态实测真溢出（按钮显隐的唯一依据） */
const foldEls = new Map();    /* key → 被钳元素（ref 工厂收集） */
const foldRef = (key) => (el) => { if (el) foldEls.set(key, el); else foldEls.delete(key); };
const foldIsOpen = (id, f) => !!foldOpen.value[foldKey(id, f)];
const foldBtn = (id, f) => !!foldOver.value[foldKey(id, f)];   /* 溢出过才显示按钮 */
function toggleFold(id, f) {
  const k = foldKey(id, f);
  foldOpen.value = { ...foldOpen.value, [k]: !foldOpen.value[k] };
}
function measureFolds() {
  const next = { ...foldOver.value };
  let chg = false;
  for (const [k, el] of foldEls) {
    /* 已展开的保持 true（收起再展开按钮不消失）；收起的现测 */
    const over = foldOpen.value[k] ? true : isOverflowing(el);
    if (!!next[k] !== over) { next[k] = over; chg = true; }
  }
  if (chg) foldOver.value = next;
}
watch(recRows, () => { nextTick(measureFolds); });   /* 换页/切签/刷新后补测 */
function canChat(l) {
  return bottleChatState(l, myId.value) === "accepted" && !!l.conv_id;
}
function openRec(l) {
  if (canChat(l)) router.push({ name: "messages", params: { id: String(l.conv_id) } });
}
/* 在记录列表里直接决定要不要和 TA 聊（不必再跑去消息页找那张卡片） */
const recBusy = ref("");
const recErr = ref("");
async function decideRec(l, accept) {
  if (recBusy.value) return;
  recBusy.value = l.id;
  recErr.value = "";
  try {
    const r = await bottleChatDecide(l.id, accept);
    if (!r || !["accepted", "declined"].includes(r.decision)) throw new Error("bottle-invalid-result");
    l.chat_decision = r.decision;
    if (r.conv_id) l.conv_id = r.conv_id;
    if (r.decision === "accepted" && r.conv_id) {
      router.push({ name: "messages", params: { id: String(r.conv_id) } });
    }
  } catch (e) {
    recErr.value = t(bottleErrKey(e));
  } finally { recBusy.value = ""; }
}

/* ═════════ 轮446 · 撤回 / 隐藏自己投的信 ═════════
 * 规则写在 utils/bottle.js 的 canWithdrawLetter / canHideLetter（纯函数、有单测），
 * 与数据库 bottle_letter_delete / _hide 的 where 条件**逐条对应** —— 两边口径必须一致，
 * 否则会出现「按钮点了没反应」（RPC 返回 false，界面又没有错误可看）。
 * 一句话：还在海里的能收回；已经进了别人手里的，只能自己眼不见为净。 */
const dialog = useDialog();
const recOpBusy = ref("");       /* 正在撤回/隐藏的那条 id（防连点） */
const recHint = ref("");         /* 操作成功的一句轻提示 */
let recHintTimer = 0;
function flashRec(tk) {
  recHint.value = t(tk);
  if (recHintTimer) clearTimeout(recHintTimer);
  recHintTimer = setTimeout(() => { recHint.value = ""; }, 3000);
}

/* 「已隐藏 N 封 · 查看」——最多 50 行，很轻，进页面 / 切到「我发布的」时顺带拉 */
const hiddenRows = ref([]);
const hiddenOpen = ref(false);
async function loadHidden() {
  if (!cloudSigned.value) return;
  try {
    const got = await bottleHiddenLetters();
    hiddenRows.value = Array.isArray(got) ? got : [];
  } catch (e) {
    hiddenRows.value = [];   /* 没跑迁移 / 网络失败：不显示折叠区，别挡主流程 */
  }
}

/* 从「我发布的」本地列表摘掉一条，并把分页钳回合法页（当前页可能就空了） */
function dropRecRow(id) {
  const keep = (x) => String(x.id) !== String(id);
  recAll.value = recAll.value.filter(keep);
  recMineAll.value = recMineAll.value.filter(keep);
  const p = clampBottlePage(recPage.value, recAll.value.length, REC_PAGE);
  recPage.value = p;
  recRows.value = bottlePageSlice(recAll.value, p, REC_PAGE);
}

function askConfirm(title, desc) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    dialog.warning({
      title, content: desc,
      positiveText: t("common.confirm"),
      negativeText: t("common.cancel"),
      onPositiveClick: () => done(true),
      onNegativeClick: () => done(false),
      onClose: () => done(false),
    });
  });
}

async function withdrawLetter(l) {
  if (!l || recOpBusy.value || !canWithdrawLetter(l)) return;
  if (!(await askConfirm(t("bottle.withdrawTitle"), t("bottle.withdrawDesc")))) return;
  recOpBusy.value = l.id;
  recErr.value = "";
  try {
    const ok = await bottleWithdraw(l.id);
    if (!ok) throw new Error("bottle-not-owner");
    dropRecRow(l.id);
    flashRec("bottle.withdrawn");
  } catch (e) {
    recErr.value = t(bottleErrKey(e));
    /* 并发：点撤回的同一瞬间被人捞走 → 就地改状态，按钮换成「隐藏」，别让用户反复点 */
    if (/bottle-already-picked/.test(String((e && e.message) || ""))) l.status = "held";
  } finally { recOpBusy.value = ""; }
}

async function hideLetter(l) {
  if (!l || recOpBusy.value || !canHideLetter(l, myId.value)) return;
  if (!(await askConfirm(t("bottle.hideTitle"), t("bottle.hideDesc")))) return;
  recOpBusy.value = l.id;
  recErr.value = "";
  try {
    const ok = await bottleHide(l.id);
    if (!ok) throw new Error("bottle-not-owner");
    dropRecRow(l.id);
    await loadHidden();          /* 「已隐藏 N 封」的数字要跟上 */
    flashRec("bottle.hidden");
  } catch (e) {
    recErr.value = t(bottleErrKey(e));
  } finally { recOpBusy.value = ""; }
}

async function restoreLetter(l) {
  if (!l || recOpBusy.value) return;
  recOpBusy.value = l.id;
  recErr.value = "";
  try {
    await bottleUnhide(l.id);
    hiddenRows.value = hiddenRows.value.filter((x) => String(x.id) !== String(l.id));
    await loadRecords();         /* 回到「我发布的」列表 */
    flashRec("bottle.unhidden");
  } catch (e) {
    recErr.value = t(bottleErrKey(e));
  } finally { recOpBusy.value = ""; }
}
</script>

<template>
  <section class="card mail-card">
    <header class="bt-head">
      <h2 class="bt-title">{{ t("bottle.title") }}</h2>
      <p class="sub">{{ t("bottle.sub") }}</p>
    </header>

    <template v-if="cloudSigned">
      <van-field
        ref="mailField"
        v-model="mailDraft"
        type="textarea" rows="3" :autosize="MAIL_AUTOSIZE" :maxlength="BOTTLE_BODY_MAX"
        :placeholder="t('bottle.placeholder')" />
      <div class="mail-send">
        <span class="m-count">{{ mailChars }}/{{ BOTTLE_BODY_MAX }} · {{ sendText(sendLeft) }}</span>
        <n-button type="primary" round :disabled="mailBusy || mailChars < BOTTLE_BODY_MIN || sendLeft === 0" @click="doSend">
          {{ t("bottle.send") }}
        </n-button>
      </div>
      <p v-if="mailDraft.trim() && mailChars < BOTTLE_BODY_MIN" class="streak-note">{{ t("bottle.needMore", { n: BOTTLE_BODY_MIN - mailChars }) }}</p>
      <p v-if="quotaErr" class="streak-note hall-warn">{{ t(quotaErr) }}</p>
      <!-- 轮 317：状态机 投递中(转圈) → 投递成功(绿) ；失败 = 行内红（弹窗见 doSend） -->
      <p v-if="mailHint" :class="'streak-note ' + (mailHint === 'sending' ? 'mail-sending' : mailHint === 'sent' ? 'mail-sent' : 'hall-warn')">
        <span v-if="mailHint === 'sending'" class="mail-spin" aria-hidden="true"></span>{{
          mailHint === "sending" ? t("bottle.sending") : mailHint === "sent" ? t("bottle.sentFlash") : mailHint }}</p>

      <div class="bottle-sea">
        <span class="sec-label">{{ t("bottle.seaTitle") }}</span>
        <n-button round :loading="fishing" :disabled="canFish === false" @click="doFish">
          {{ "\u{1F9CA}" }} {{ t("bottle.fish") }}
        </n-button>
        <span class="m-count">{{ pickText(pickLeft) }} · {{ fishText(fishLeft) }}</span>
      </div>

      <!-- 捞到的信（可同时持有几封，逐封回信或放回；捞新信不需要先处理手里的） -->
      <p v-if="trayErr" class="notice">{{ t(trayErr) }}</p>
      <!-- 轮 238 · 托盘 Teleport 到 body（position: fixed 在 .home-track 的 transform 里会被
       * 劫持包含块：居中变成「对 2405px 高的轨道居中」，托盘漂到任意联上 = 宠物页悬空卡、
       * 今日页黑边，用户实测）。一次只弹一封（旧版全部 fixed 叠在同一坐标互相糊脸）；
       * trayOn: 仅漂流瓶联显示，滑走即藏（信留在 pending，回来再弹）。 -->
      <teleport to="body" :disabled="!isMobileNav">
        <template v-for="l in pending.slice(0, 1)" :key="l.id">
          <!-- 轮 241（用户实报图1）：fishPop 弹窗开着时托盘必须让位 —— 捞到信时
             mergePending() 先把信并入 pending、随后 fishPop 又弹同一封，两层遮罩
             （n-modal overlay + 托盘 ::before .45 黑）叠加成「背景发灰、底下文字透出、
             看着像卡住」。弹窗关闭（回信/放回/关掉）托盘再接管同一封，接力不丢信。 -->
          <div v-show="trayOn && !fishPop.show" class="bottle-tray">
            <div class="m-q">{{ l.body }}</div>
            <span class="m-who">{{ t("bottle.fromSea") }}</span>
            <van-field
              v-model="replyDrafts[l.id]"
              type="textarea" rows="2" :autosize="REPLY_AUTOSIZE" :maxlength="BOTTLE_BODY_MAX"
              :placeholder="t('bottle.replyPlaceholder')"
              @update:model-value="onReplyInput(l.id, $event)" />
            <div class="reply-meta">
              <span class="reply-count" :class="{ over: replyOver(l.id) }">{{ replyLen(l.id) }}/{{ BOTTLE_BODY_MAX }}</span>
            </div>
            <p v-if="replyErr[l.id]" class="reply-err">{{ replyErr[l.id] }}</p>
            <div class="mail-send">
              <n-button type="primary" size="small" round
                :disabled="busyId === l.id || !String(replyDrafts[l.id] || '').trim()"
                @click="doReply(l)">
                {{ t("bottle.reply") }}
              </n-button>
              <n-button quaternary size="small" round :loading="busyId === l.id" :disabled="busyId === l.id" @click="doRelease(l)">
                {{ t("bottle.release") }}
              </n-button>
            </div>
          </div>
        </template>
      </teleport>

      <!-- #17 记录：我发布的 / 我捞到的，按发布时间新→旧，10 条一页；能聊天的点进去 -->
      <div class="mail-list">
        <div class="bottle-tabs">
          <button class="bottle-tab" :class="{ on: recTab === 'mine' }" @click="switchRecTab('mine')">
            {{ t("bottle.mineTab") }}
            <span v-if="recPending" class="notif-count">{{ recPending > 99 ? "99+" : recPending }}</span>
          </button>
          <button class="bottle-tab" :class="{ on: recTab === 'held' }" @click="switchRecTab('held')">
            {{ t("bottle.heldTab") }}
          </button>
        </div>
        <p v-if="recLoading" class="sub">{{ t("bottle.recordsLoading") }}</p>
        <p v-else-if="!recRows.length" class="sub">{{ t("bottle.recordsEmpty") }}</p>
        <div
          v-for="l in recRows" :key="l.id"
          class="mail-item" :class="{ clickable: canChat(l) }"
          @click="openRec(l)">
          <!-- 轮 319：信文钳 4 行（真溢出才出按钮；点按钮只切文本，不触发卡片跳转） -->
          <div
            class="m-q" :ref="foldRef(foldKey(l.id, 'body'))"
            :class="{ 'fold-clamp': needsFold(l.body) && !foldIsOpen(l.id, 'body'), 'fold-fade': foldBtn(l.id, 'body') && !foldIsOpen(l.id, 'body') }">{{ l.body }}</div>
          <button v-if="foldBtn(l.id, 'body')" type="button" class="fold-more" @click.stop="toggleFold(l.id, 'body')">
            {{ foldIsOpen(l.id, "body") ? t("bottle.foldLess") : t("bottle.foldMore", { n: l.body.length }) }}
          </button>
          <div class="m-meta">
            <span class="m-when">{{ whenRec(recTab === "mine" ? l.created_at : (l.held_at || l.created_at)) }}</span>
            <span class="m-state">
              <span v-if="bottleChatState(l, myId) === 'choose'" class="bottle-need-dot" :title="t('bottle.stDecide')" aria-hidden="true"></span>
              {{ t(recState(l)) }}
            </span>
          </div>
          <!-- 轮446：作者操作 —— 还在海里 → 撤回；已进别人手里 → 只有隐藏。
               显示条件与数据库 where 条件一一对应（utils/bottle.js 的两个 can* 纯函数）。 -->
          <div v-if="recTab === 'mine' && (canWithdrawLetter(l) || canHideLetter(l, myId))" class="mail-send bottle-owner-ops" @click.stop>
            <button v-if="canWithdrawLetter(l)" type="button" class="bottle-op bottle-op-danger"
              :disabled="recOpBusy === l.id" @click="withdrawLetter(l)">{{ t("bottle.withdraw") }}</button>
            <button v-else type="button" class="bottle-op"
              :disabled="recOpBusy === l.id" @click="hideLetter(l)">{{ t("bottle.hide") }}</button>
          </div>
          <!-- 轮 24c：押在手里的信，操作按钮直接放在记录卡上（此前只在顶部托盘/弹窗里，用户找不到） -->
          <div v-if="recTab === 'held' && l.status === 'held'" class="mail-send" @click.stop>
            <n-button type="primary" size="small" round
              :loading="busyId === l.id && replyOpen === l.id"
              :disabled="busyId === l.id"
              @click="openReply(l)">
              {{ t("bottle.reply") }}
            </n-button>
            <n-button quaternary size="small" round
              :loading="busyId === l.id && replyOpen !== l.id"
              :disabled="busyId === l.id"
              @click="doRelease(l)">
              {{ t("bottle.release") }}
            </n-button>
            <n-button v-if="l.user_id !== myId" quaternary size="small" round @click="openReport(l)">
              {{ t("bottle.report") }}
            </n-button>
          </div>
          <div v-if="replyOpen === l.id && recTab === 'held' && l.status === 'held'" class="mail-send" style="flex-direction: column; align-items: stretch; gap: 6px" @click.stop>
            <van-field
              v-model="replyDrafts[l.id]"
              type="textarea" rows="3" :autosize="REPLY_AUTOSIZE" :maxlength="BOTTLE_BODY_MAX"
              :placeholder="t('bottle.replyPlaceholder')"
              @update:model-value="onReplyInput(l.id, $event)" />
            <div class="reply-meta">
              <span class="reply-count" :class="{ over: replyOver(l.id) }">{{ replyLen(l.id) }}/{{ BOTTLE_BODY_MAX }}</span>
            </div>
            <p v-if="replyErr[l.id]" class="reply-err">{{ replyErr[l.id] }}</p>
            <n-button type="primary" size="small" round
              :disabled="busyId === l.id || !String(replyDrafts[l.id] || '').trim()"
              @click="doReply(l)">
              {{ t("bottle.replySend") }}
            </n-button>
          </div>
          <div v-if="l.reply" class="m-a">
            <!-- 轮 66：「我捞到的」里 l.reply 是我写出去的回信 → 标「我的回信」（原来误标「收到的回信」） -->
            <span class="m-who">{{ t(recTab === "held" ? "bottle.replyMine" : "bottle.replyFrom") }}</span>
            <!-- 轮 319：回信独立折叠（与信文互不拖累） -->
            <span
              class="m-body" :ref="foldRef(foldKey(l.id, 'reply'))"
              :class="{ 'fold-clamp': needsFold(l.reply) && !foldIsOpen(l.id, 'reply'), 'fold-fade': foldBtn(l.id, 'reply') && !foldIsOpen(l.id, 'reply') }">{{ l.reply }}</span>
            <button v-if="foldBtn(l.id, 'reply')" type="button" class="fold-more" @click.stop="toggleFold(l.id, 'reply')">
              {{ foldIsOpen(l.id, "reply") ? t("bottle.foldLess") : t("bottle.foldMore", { n: l.reply.length }) }}
            </button>
          </div>
          <!-- 收到回信还没决定：就在这条记录上直接同意 / 拒绝（同意后进聊天） -->
          <div v-if="bottleChatState(l, myId) === 'choose'" class="mail-send" @click.stop>
            <n-button type="primary" size="small" round :disabled="recBusy === l.id" @click="decideRec(l, true)">
              {{ t("bottle.chatAccept") }}
            </n-button>
            <n-button quaternary size="small" round :disabled="recBusy === l.id" @click="decideRec(l, false)">
              {{ t("bottle.chatDecline") }}
            </n-button>
          </div>
          <span v-if="canChat(l)" class="bottle-chat">{{ t("bottle.openChat") }} →</span>
        </div>
        <p v-if="recErr" class="notice">{{ t(recErr) }}</p>
        <p v-if="recHint" class="notice bottle-hint">{{ recHint }}</p>
        <div class="bottle-pager">
          <n-button size="tiny" round :disabled="recPage <= 0 || recLoading" @click="setRecPage(0)">
            « {{ t("bottle.pageFirst") }}
          </n-button>
          <n-button size="tiny" round :disabled="recPage <= 0 || recLoading" @click="recPageGo(-1)">
            ← {{ t("notif.prev") }}
          </n-button>
          <span class="sub bottle-page-now">
            {{ t("bottle.pageInfo", { p: recPage + 1 }) }} / {{ recPageCount }}
          </span>
          <n-button size="tiny" round :disabled="recPage >= recPageCount - 1 || recLoading" @click="recPageGo(1)">
            {{ t("notif.next") }} →
          </n-button>
          <n-button size="tiny" round :disabled="recPage >= recPageCount - 1 || recLoading" @click="setRecPage(recPageCount - 1)">
            {{ t("bottle.pageLast") }} »
          </n-button>
          <span class="bottle-page-jump">
            <input
              v-model.number="recJump" type="number" min="1" :max="recPageCount"
              class="bottle-page-input" :aria-label="t('bottle.pageJump')"
              @keyup.enter="recJumpTo(recJump)" />
            <n-button size="tiny" round :disabled="recLoading" @click="recJumpTo(recJump)">
              {{ t("bottle.pageGo") }}
            </n-button>
          </span>
        </div>

        <!-- 轮446：已隐藏的信。隐藏 = 从我的列表消失，**不是删除** ——
             不给恢复入口的话，用户会以为隐藏等于删除，然后来问信去哪了。 -->
        <div v-if="recTab === 'mine' && hiddenRows.length" class="bottle-hidden">
          <button type="button" class="bottle-hidden-toggle" @click="hiddenOpen = !hiddenOpen">
            {{ hiddenOpen ? t("bottle.hideCollapse") : t("bottle.hiddenN", { n: hiddenRows.length }) }}
          </button>
          <div v-if="hiddenOpen" class="bottle-hidden-list">
            <div v-for="h in hiddenRows" :key="h.id" class="mail-item bottle-hidden-item">
              <div class="m-q">{{ h.body }}</div>
              <div class="m-meta">
                <span class="m-when">{{ whenRec(h.created_at) }}</span>
                <button type="button" class="bottle-op"
                  :disabled="recOpBusy === h.id" @click.stop="restoreLetter(h)">{{ t("bottle.unhide") }}</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>
    <!-- 轮 59：游客空态从裸提示升级为居中块（此前一整屏渐变里孤零零一行字） -->
    <div v-else class="bottle-guest">
      <span class="bg-wave">🌊</span>
      <p class="notice">{{ t("bottle.signInHint") }}</p>
    </div>

    <!-- 轮 22：捞信结果居中弹窗（手机端核心反馈）——捞到可就地回信 / 放回海里（「先收着」已按用户要求移除）。
         轮 40：宽度必须显式给——n-modal 不给 width 会被容器撑满，原来的 max-width: 88vw
         在手机上≈343px 没事，桌面网页上就是 88vw≈1670px 的巨幕（用户报「弹窗也太大了吧」）。
         min(560px, 100vw-32px)：桌面 560px 居中，手机仍是留 16px 边距的近全宽。
         轮 242（用户拍板）：捞到信/捞的过程中弹窗**不可关闭**——点空白、Esc、右上× 全禁，
         必须「回信成功」或「放回海里」才消（旧版遮罩可点关，信还在手里 → 每次进漂流瓶联
         托盘又把它端出来，用户实测「后面每次进入又自动出现」）。msg 模式（没捞到/限额）
         保留三种关闭方式，否则「知道了」之外无路可走 = 死局。 -->
    <n-modal v-model:show="fishPop.show" preset="card" style="width: min(560px, calc(100vw - 32px))"
      :mask-closable="fishPop.mode === 'msg' || fishPop.mode === 'empty'" :esc="fishPop.mode === 'msg' || fishPop.mode === 'empty'" :closable="fishPop.mode === 'msg' || fishPop.mode === 'empty'"
      :title="fishPop.mode === 'got' ? t('bottle.gotTitle') : (fishPop.mode === 'fishing' ? t('bottle.fishing') : t('bottle.popNotice'))">
      <template v-if="fishPop.mode === 'fishing'">
        <div class="fish-wait">
          <span class="fw-rod">🎣</span>
          <p class="fw-sub">{{ t("bottle.fishingSub") }}</p>
        </div>
      </template>
      <template v-else-if="fishPop.mode === 'got' && fishPop.letter">
        <div class="m-q" style="font-size: 16px; line-height: 1.6">{{ fishPop.letter.body }}</div>
        <span class="m-who">{{ t("bottle.fromSea") }}</span>
        <!-- 轮 439：捞到的信不是本语言时说明一句。用户开了「优先本语言」还会捞到外文，
             是因为海里这个语言的信不够 —— 不解释的话会以为是 bug。 -->
        <span v-if="fishLang" class="m-who bottle-lang-hint">
          {{ t("bottle.otherLang", { lang: fishLang }) }}
        </span>
        <van-field
          v-model="replyDrafts[fishPop.letter.id]"
          type="textarea" rows="3" :autosize="REPLY_AUTOSIZE" :maxlength="BOTTLE_BODY_MAX"
          :placeholder="t('bottle.replyPlaceholder')" style="margin-top: 10px"
          @update:model-value="onReplyInput(fishPop.letter.id, $event)" />
        <div class="reply-meta">
          <span class="reply-count" :class="{ over: replyOver(fishPop.letter.id) }">{{ replyLen(fishPop.letter.id) }}/{{ BOTTLE_BODY_MAX }}</span>
        </div>
        <p v-if="replyErr[fishPop.letter.id]" class="reply-err">{{ replyErr[fishPop.letter.id] }}</p>
        <div class="mail-send" style="margin-top: 8px">
          <n-button type="primary" round
            :disabled="busyId === fishPop.letter.id || !String(replyDrafts[fishPop.letter.id] || '').trim()"
            @click="doReply(fishPop.letter)">
            {{ t("bottle.reply") }}
          </n-button>
          <n-button quaternary round :loading="busyId === fishPop.letter.id" :disabled="busyId === fishPop.letter.id" @click="doRelease(fishPop.letter)">
            {{ t("bottle.release") }}
          </n-button>
          <n-button quaternary round @click="openReport(fishPop.letter)">
            {{ t("bottle.report") }}
          </n-button>
        </div>
      </template>
      <template v-else-if="fishPop.mode === 'empty'">
        <p style="margin: 2px 0 14px; white-space: pre-wrap">{{ fishPop.msg }}</p>
        <div class="mail-send" style="margin-top: 8px">
          <n-button type="primary" round @click="focusComposer">{{ t("bottle.emptyCta") }}</n-button>
          <n-button quaternary round @click="fishPop.show = false">{{ t("common.gotIt") }}</n-button>
        </div>
      </template>
      <template v-else>
        <p style="margin: 2px 0 14px; white-space: pre-wrap">{{ fishPop.msg }}</p>
        <n-button type="primary" round @click="fishPop.show = false">{{ t("common.gotIt") }}</n-button>
      </template>
    </n-modal>

    <report-dialog v-model:show="reportShow" :target="reportTarget" />
  </section>
</template>

<style scoped>
/* 轮 361：回信错误/字数贴在当前输入框旁（托盘、记录卡、捞信弹窗共用） */
.reply-meta {
  display: flex;
  justify-content: flex-end;
  align-items: baseline;
  gap: 8px;
  margin-top: 6px;
  font-size: 12px;
  color: var(--ink-faint);
  font-weight: 500;
}
.reply-count.over { color: var(--warn); font-weight: 700; }
.reply-err {
  margin: 4px 0 0;
  color: var(--warn);
  font-size: 12px;
  font-weight: 600;
  line-height: 1.45;
}
</style>
