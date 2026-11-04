/* 私信规则层单测（纯函数 + i18n 键 + 迁移 SQL 覆盖）
 * ------------------------------------------------------------
 * 为什么这些断言值得写：
 *  1. 撤回窗口 / 未读计数 / 日期分隔 / 排序 —— 前端算错用户立刻能看出来；
 *  2. 错误码 → i18n 键的映射必须与 MIGRATION 里 raise exception 的字符串一一对上，
 *     否则线上只会显示「网络不太顺」，排查靠猜；
 *  3. i18n 的 dm.* 键必须 en/zh 对称（i18n-test 也会查，这里再钉一次视图真正用到的那些）；
 *  4. 迁移文件必须真的建了 6 张表 + 15 个 dm_* 函数，且 SUPABASE_SETUP.sql 里同步了。
 * 运行：node tools/dm-test.mjs
 */
import fs from "node:fs";
import {
  RECALL_WINDOW_MS, BODY_MAX, IMAGE_PLACEHOLDER, RECALLED_PLACEHOLDER,
  previewText, canRecall, displayMsg, unreadOf, sortConvs, filterConvs,
  dayKey, withDayDividers, relativeTime, validateSend, sendErrKey, rowView,
  mergeTail, findSentEcho, dropEchoedDrafts, claimPendingEcho, dropEchoedPending, maxPositiveId, dmWin, dmMsgsKey, dmCacheWindow, dmPeekWindow, DM_WINDOW_CAP,
  firstLimitLocked, FIRST_CONTACT_LIMIT,
} from "../src/utils/dmRules.js";
import { messages } from "../src/i18n.js";

let pass = 0;
const fails = [];
function ok(name, cond, extra = "") {
  if (cond) pass++;
  else fails.push(name + (extra ? ` —— ${extra}` : ""));
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const NOW = Date.parse("2026-09-17T12:00:00Z");
const iso = (ms) => new Date(ms).toISOString();

/* ───────── 常量与预览 ───────── */
ok("撤回窗口 = 15 分钟", RECALL_WINDOW_MS === 15 * 60 * 1000);
ok("正文上限 = 2000", BODY_MAX === 2000);
ok("占位符与 SQL 同源", IMAGE_PLACEHOLDER === "📷" && RECALLED_PLACEHOLDER === "⟲");
ok("预览：空会话给占位（走 t）",
  previewText("", (k) => `[${k}]`) === "[dm.emptyPreview]");
ok("预览：有内容原样透出", previewText("嗨，今天还好吗") === "嗨，今天还好吗");
ok("预览：非字符串不炸", previewText(null, (k) => `[${k}]`) === "[dm.emptyPreview]");

/* ───────── 撤回判定 ───────── */
const mine = { id: 1, sender: "me", created_at: iso(NOW - 60 * 1000) };
ok("本人 1 分钟前 → 可撤回", canRecall(mine, "me", NOW) === true);
ok("本人 14 分钟前 → 可撤回", canRecall({ ...mine, created_at: iso(NOW - 14 * 60 * 1000) }, "me", NOW) === true);
ok("本人 16 分钟前 → 不可", canRecall({ ...mine, created_at: iso(NOW - 16 * 60 * 1000) }, "me", NOW) === false);
ok("对方发的 → 不可", canRecall({ ...mine, sender: "other" }, "me", NOW) === false);
ok("已撤回 → 不可再撤", canRecall({ ...mine, deleted_at: iso(NOW) }, "me", NOW) === false);
ok("时间非法 → 不可", canRecall({ ...mine, created_at: "不是时间" }, "me", NOW) === false);
ok("未登录 → 不可", canRecall(mine, "", NOW) === false);

/* ───────── 展示态与未读 ───────── */
const recalled = displayMsg({ ...mine, body: "hi", image_path: "u/a.png", deleted_at: iso(NOW) });
ok("撤回的消息正文清空",
  recalled.body === "" && recalled.image_path === null && recalled.recalled === true,
  JSON.stringify(recalled));
ok("未撤回原样返回", displayMsg(mine).recalled === undefined);
const msgs = [
  { id: 1, sender: "me", created_at: iso(NOW) },
  { id: 2, sender: "other", created_at: iso(NOW) },
  { id: 3, sender: "other", created_at: iso(NOW) },
  { id: 4, sender: "other", created_at: iso(NOW), deleted_at: iso(NOW) },
];
ok("未读=水位之后的对方活消息（撤回不算）", unreadOf(msgs, 1, "me") === 2);
ok("水位到顶 → 0 未读", unreadOf(msgs, 4, "me") === 0);
ok("非数组 → 0", unreadOf(null, 0, "me") === 0);
/* 轮381：字符串 id 不能按字典序比（"9" > "100" 会是 true，未读数算反）。 */
ok("未读：字符串 id/水位按数值比较",
  unreadOf([
    { id: "9", sender: "o", created_at: iso(NOW) },
    { id: "100", sender: "o", created_at: iso(NOW) },
  ], "100", "me") === 0
  && unreadOf([
    { id: "9", sender: "o", created_at: iso(NOW) },
    { id: "100", sender: "o", created_at: iso(NOW) },
  ], "9", "me") === 1);

/* ───────── 排序与搜索 ───────── */
const convs = [
  { conv_id: 1, nickname: "A", last_message_at: iso(NOW - 3600_000), created_at: iso(NOW) },
  { conv_id: 2, nickname: "B", last_message_at: iso(NOW - 60_000), created_at: iso(NOW) },
  { conv_id: 3, nickname: "C", last_message_at: null, created_at: iso(NOW - 7200_000) },
];
ok("排序：最近动静优先", sortConvs(convs).map((c) => c.conv_id)[0] === 2);
ok("排序：无消息用 created_at 兜底", sortConvs(convs).map((c) => c.conv_id)[2] === 3);
ok("排序不改原数组", convs[0].conv_id === 1);
ok("搜索：昵称命中（不区分大小写）", filterConvs(convs, "b").length === 1);
ok("搜索：预览命中",
  filterConvs([{ conv_id: 9, nickname: "X", last_preview: "今晚吃面" }], "吃面").length === 1);
ok("搜索：空串全返回", filterConvs(convs, "  ").length === 3);

/* ───────── 日期分隔 ───────── */
const dayMsgs = [
  { id: 1, created_at: "2026-09-15T10:00:00+08:00" },
  { id: 2, created_at: "2026-09-15T23:00:00+08:00" },
  { id: 3, created_at: "2026-09-16T09:00:00+08:00" },
];
const flow = withDayDividers(dayMsgs);
ok("跨天才插分隔（3 条消息 → 2 个分隔）", flow.filter((x) => x.type === "day").length === 2);
ok("分隔在消息之前", flow[0].type === "day" && flow[1].type === "msg");
ok("dayKey 本地日期格式", /^\d{4}-\d{2}-\d{2}$/.test(dayKey(dayMsgs[0].created_at)));
ok("dayKey 非法时间 → 空串", dayKey("nope") === "");
ok("空数组不炸", withDayDividers(null).length === 0);
{
  /* 轮 376：确认行晚回来 / 补拉历史会让 raw 数组暂时乱序；日期分隔必须按发送时间，
   * 不能出现「今天 → 昨天 → 今天」。 */
  const messy = [
    { id: 3, created_at: "2026-09-16T09:00:00+08:00" },
    { id: 1, created_at: "2026-09-15T10:00:00+08:00" },
    { id: 2, created_at: "2026-09-15T23:00:00+08:00" },
  ];
  const f = withDayDividers(messy);
  const days = f.filter((x) => x.type === "day").map((x) => x.key);
  ok("日期分隔按时间排序，不乱序", days.length === 2 && days[0] === "2026-09-15" && days[1] === "2026-09-16");
  ok("排序后消息正文顺序稳定", f.filter((x) => x.type === "msg").map((x) => x.msg.id).join(",") === "1,2,3");
}

/* ───────── 相对时间 ───────── */
const T = (k, p = {}) => `${k}${p.n != null ? ":" + p.n : ""}`;
ok("刚刚", relativeTime(iso(NOW - 20_000), NOW, T) === "time.now");
ok("分钟前", relativeTime(iso(NOW - 5 * 60_000), NOW, T) === "time.minAgo:5");
ok("小时前", relativeTime(iso(NOW - 3 * 3600_000), NOW, T) === "time.hourAgo:3");
ok("昨天（本地日历）",
  relativeTime(new Date(NOW - 24 * 3600_000).toISOString(), NOW, T) === "time.yesterday");
ok("更早 → 月-日", /^\d{2}-\d{2}$/.test(relativeTime(iso(NOW - 10 * 86400_000), NOW, T)));
ok("非法时间 → 空串", relativeTime("x", NOW, T) === "");

/* ───────── 发送校验与错误码映射 ───────── */
ok("空正文无图片 → 报错", validateSend("   ", null) === "dm.errEmpty");
ok("只有图片 → 通过", validateSend("", "u/a.png") === null);
ok("超长 → 报错", validateSend("x".repeat(BODY_MAX + 1), null) === "dm.errTooLong");
ok("刚好 2000 → 通过", validateSend("x".repeat(BODY_MAX), null) === null);
const ERR = [
  ["blocked-by-me", "dm.errBlockedByMe"],
  ["blocked", "dm.errBlocked"],
  ["first-limit", "dm.errFirstLimit"],
  ["forbidden", "dm.errForbidden"],
  ["bad-conv", "dm.errForbidden"],
  ["empty-message", "dm.errEmpty"],
  ["auth-required", "dm.errAuth"],
  ["cloud-not-ready", "dm.errAuth"],
  ["no-user", "dm.errNoUser"],
  ["bad-target", "dm.errNoUser"],
  ["gateway-unreachable", "dm.errNetwork"],
];
for (const [raw, key] of ERR) {
  ok(`错误码映射 ${raw} → ${key}`, sendErrKey(new Error(raw)) === key, sendErrKey(new Error(raw)));
}
ok("blocked-by-me 优先于 blocked（先判细）",
  sendErrKey(new Error("blocked-by-me")) === "dm.errBlockedByMe");

/* ───────── 陌生人首聊 3 条：发送前本地拦截 ───────── */
const ME = "me-uuid", PEER = "peer-uuid";
const msgOf = (id, sender, extra = {}) => ({ id, sender, ...extra });
const myMsgs = (n, extra = {}) => Array.from({ length: n }, (_, i) => msgOf(i + 1, ME, extra));
ok("首聊上限常量 = 3", FIRST_CONTACT_LIMIT === 3);
ok("首聊：3 条无回复 → 本地锁死",
  firstLimitLocked(null, myMsgs(3), ME, PEER) === true);
ok("首聊：2 条无回复 → 仍可发送",
  firstLimitLocked(null, myMsgs(2), ME, PEER) === false);
ok("首聊：对方回复过 → 解锁",
  firstLimitLocked(null, myMsgs(3).concat([msgOf(4, PEER)]), ME, PEER) === false);
ok("首聊：对方回复已撤回 → 仍按未回复锁死",
  firstLimitLocked(null, myMsgs(3).concat([msgOf(4, PEER, { deleted_at: "2026-01-01" })]), ME, PEER) === true);
ok("首聊：失败行不占服务端条数（3 条已发 + 失败第 4 条 → 仍锁）",
  firstLimitLocked(null, myMsgs(3).concat([msgOf(-4, ME, { failed: true })]), ME, PEER) === true);
ok("首聊：多次重试留下的一串失败行不会撑长窗口、漏掉本地拦截",
  firstLimitLocked(null, myMsgs(3).concat(
    Array.from({ length: 10 }, (_, i) => msgOf(-10 - i, ME, { failed: true }))
  ), ME, PEER) === true);
ok("首聊：在飞的第 3 条也算一条",
  firstLimitLocked(null, myMsgs(2).concat([msgOf(-3, ME, { pending: true })]), ME, PEER) === true);
ok("首聊：撤回的我方消息不计数",
  firstLimitLocked(null, myMsgs(2).concat([msgOf(3, ME, { deleted_at: "2026-01-01" })]), ME, PEER) === false);
ok("首聊：同一条 pending + 确认行不重复计数",
  firstLimitLocked(null, [msgOf(1, ME), msgOf(-2, ME, { key: "k2" }),
    msgOf(2, ME, { key: "k2" })], ME, PEER) === false);
ok("首聊：新 RPC peer_replied=true → 不拦",
  firstLimitLocked({ peer_replied: true, my_count: 30 }, myMsgs(30), ME, PEER) === false);
ok("首聊：新 RPC peer_replied=false + my_count=3 → 不依赖窗口也拦",
  firstLimitLocked({ peer_replied: false, my_count: 3 }, [], ME, PEER) === true);
ok("首聊：新 RPC peer_replied=false + my_count=2 → 放行",
  firstLimitLocked({ peer_replied: false, my_count: 2 }, [], ME, PEER) === false);
ok("首聊：新 RPC 精确条数 + 本地在飞行取较大值",
  firstLimitLocked({ peer_replied: false, my_count: 2 }, myMsgs(2).concat([msgOf(-3, ME, { pending: true })]), ME, PEER) === true);
ok("首聊：老 RPC 长会话不凭一屏全是我方消息误锁",
  firstLimitLocked(null, myMsgs(30), ME, PEER) === false);
ok("首聊：缺 other_id → 不判，交给服务端",
  firstLimitLocked(null, myMsgs(3), ME, "") === false);

/* ───────── 列表行展示态 ───────── */
ok("被拉黑 → 未读清零（硬墙语义）", rowView({ unread: 5, blocked: true }).unread === 0);
ok("正常行保留未读", rowView({ unread: 3, blocked: false }).unread === 3);
ok("空行不炸", rowView(null) === null);

/* ───────── i18n：视图真正用到的键必须在 en/zh 都存在 ───────── */
function flat(obj, prefix = "") {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) Object.assign(out, flat(v, key));
    else out[key] = v;
  }
  return out;
}
const EN = flat(messages.en);
const ZH = flat(messages.zh);

const NEED_DM = [
  "dm.title", "dm.needSignIn", "dm.loadFail", "dm.search", "dm.requests",
  "dm.conversations", "dm.accept", "dm.reject", "dm.empty", "dm.more", "dm.open",
  "dm.mute", "dm.unmute", "dm.hide", "dm.block", "dm.unblock", "dm.someone",
  "dm.requestTag", "dm.older", "dm.reachTop", "dm.sending",
  "dm.sendFailed", "dm.recalled", "dm.recall", "dm.noMessages", "dm.gateBlockedByMe",
  "dm.gateRequest", "dm.placeholder", "dm.hint", "dm.send", "dm.pickOne",
  "dm.emptyPreview", "dm.errEmpty", "dm.errTooLong", "dm.errBlocked", "dm.errBlockedByMe",
  "dm.errForbidden", "dm.errAuth", "dm.errNoUser", "dm.errNetwork", "dm.errTooLate", "dm.errFirstLimit",
  "dm.sendTo", "dm.opening", "dm.openingSlow",
  "time.now", "time.minAgo", "time.hourAgo", "time.yesterday",
];
for (const k of NEED_DM) {
  ok(`i18n 键存在 en:${k}`, typeof EN[k] === "string" && EN[k].length > 0);
  ok(`i18n 键存在 zh:${k}`, typeof ZH[k] === "string" && ZH[k].length > 0);
}
/* 视图里用模板串拼出来的键（notif.react.* / notif.petKind.*）也要在 */
for (const r of ["hug", "warm", "relate"]) {
  ok(`i18n 反应名 zh:notif.react.${r}`, typeof ZH[`notif.react.${r}`] === "string");
  ok(`i18n 反应名 en:notif.react.${r}`, typeof EN[`notif.react.${r}`] === "string");
}
for (const p of ["pat", "feed"]) {
  ok(`i18n 宠物动作 zh:notif.petKind.${p}`, typeof ZH[`notif.petKind.${p}`] === "string");
  ok(`i18n 宠物动作 en:notif.petKind.${p}`, typeof EN[`notif.petKind.${p}`] === "string");
}

/* ───────── 迁移 SQL：表 / RPC / 触发器 / SETUP 同步 ───────── */
const mig = fs.readFileSync("MIGRATION_dm_notifications.sql", "utf8");
const setup = fs.readFileSync("SUPABASE_SETUP.sql", "utf8");

const TABLES = ["dm_blocks", "dm_conversations", "dm_messages", "dm_states", "notifications", "notification_prefs"];
for (const tb of TABLES) {
  ok(`迁移建表 public.${tb}`, mig.includes(`create table if not exists public.${tb} (`));
  ok(`迁移开启 RLS ${tb}`, mig.includes(`alter table public.${tb}`));
}
const FUNCS = [
  "dm_is_blocked", "dm_find_conv", "dm_open", "dm_send", "dm_list_convs", "dm_list_messages",
  "dm_conv_meta", "dm_mark_read", "dm_hide", "dm_unhide", "dm_mute", "dm_accept", "dm_recall",
  "dm_block", "dm_unblock", "dm_blocks", "dm_unread_total",
  "notif_page", "notif_unread", "notif_mark", "notif_clear", "notif_prefs_get", "notif_prefs_set",
  "admin_broadcast", "notify_on_comment", "notify_on_reaction", "notify_on_pet",
];
for (const fn of FUNCS) {
  ok(`迁移建函数 ${fn}`, mig.includes(`create or replace function public.${fn}(`));
}
for (const trg of ["notify_wall_comment_trg", "notify_wall_reaction_trg", "notify_pet_interaction_trg"]) {
  ok(`迁移建触发器 ${trg}`, mig.includes(`create trigger ${trg}`));
}
/* notif_kind 白名单必须覆盖 6 类 */
const kindLine = (mig.match(/constraint notif_kind check \(kind in \(([^)]*)\)\)/) || [])[1] || "";
for (const k of ["comment", "reply", "reaction", "pet", "dm", "system"]) {
  ok(`notif_kind 含 ${k}`, kindLine.includes(`'${k}'`));
}
/* 与前端常量同源的约定 */
ok("SQL 里图片预览用 📷", mig.includes("'📷'"));
ok("SQL 里撤回预览用 ⟲", mig.includes("'⟲'"));
ok("SQL 撤回窗口 = 15 minutes", mig.includes("interval '15 minutes'"));
ok("SQL 会话有序对约束 user_a < user_b", mig.includes("check (user_a < user_b)"));
ok("SQL 唯一约束防并发重复建会话", mig.includes("unique (user_a, user_b)"));
ok("SETUP 同步了第 9 节", setup.includes("-- 9) 私信与通知中心"));
for (const fn of ["dm_send", "notif_page", "notif_clear", "admin_broadcast_start", "admin_broadcast_step", "admin_broadcasts_list"]) {
  ok(`SETUP 也含 ${fn}`, setup.includes(`create or replace function public.${fn}(`));
}
ok("SETUP 末尾有函数授权", setup.includes("grant execute on all functions in schema public"));

/* ──────── 适配层：两个实现的方法集必须一致（换后端时的红线） ───────── */
const direct = fs.readFileSync("src/utils/api/db.supabase.js", "utf8");
const gateway = fs.readFileSync("src/utils/api/db.gateway.js", "utf8");
const METHOD_RE = /^ {2}(?:async )?([a-zA-Z][A-Za-z0-9]*)\(/gm;
const names = (src) => {
  const out = new Set();
  for (const m of src.matchAll(METHOD_RE)) out.add(m[1]);
  return out;
};
const isGroup = (n) => n.startsWith("dm") || n.startsWith("notif")
  || n.startsWith("adminBroadcast");   /* 轮 238：公告三件套 Start/Step/(s)List */
const D = [...names(direct)].filter(isGroup).sort();
const G = [...names(gateway)].filter(isGroup).sort();
ok("两实现 dm/notif 方法集一致", eq(D, G), `${D.join(",")} vs ${G.join(",")}`);
const NEED_METHODS = [
  "dmOpen", "dmListConvs", "dmListMessages", "dmConvMeta", "dmSend", "dmMarkRead",
  "dmHide", "dmUnhide", "dmMute", "dmAccept", "dmRecall", "dmBlock", "dmUnblock",
  "dmBlocks", "dmUnreadTotal", "notifPage", "notifUnread", "notifMark", "notifClear",
  "notifPrefsGet", "notifPrefsSet",
  "adminBroadcastStart", "adminBroadcastStep", "adminBroadcasts",   /* 轮 238：分批推送三件套 */
];
for (const m of NEED_METHODS) {
  ok(`直连实现有 ${m}`, D.includes(m));
  ok(`网关实现有 ${m}`, G.includes(m));
}
/* Worker 路由：漏一个就会出现「直连能跑、线上 404」 */
const worker = fs.readFileSync("worker/api.js", "utf8");
for (const rpcName of ["dm_open", "dm_send", "dm_list_convs", "dm_list_messages", "dm_recall", "notif_clear"]) {
  ok(`Worker 翻译了 ${rpcName}`, worker.includes(`"${rpcName}"`));
}
ok("Worker 有 /api/notifications/clear 分支", worker.includes('seg[1] === "clear"'));

/* ───────── 视图与路由接线 ───────── */
const router = fs.readFileSync("src/router.js", "utf8");
ok("路由注册 /messages", router.includes('path: "/messages"'));
ok("路由注册 /messages/:id", router.includes('path: "/messages/:id"'));
ok("路由注册 /notifications", router.includes('path: "/notifications"'));
const app = fs.readFileSync("src/App.vue", "utf8");
ok("顶栏有私信入口", app.includes('to="/messages"'));
ok("顶栏有通知入口", app.includes('to="/notifications"'));
ok("登录后才显示入口（至少两处）", (app.match(/v-if="cloudSigned"/g) || []).length >= 2);
ok("角标接线到 badgeStore", app.includes("startBadge") && app.includes("badgeStore.js"));
const community = fs.readFileSync("src/views/CommunityView.vue", "utf8");
ok("暖心墙支持 ?post= 深链", community.includes("route.query.post") && community.includes("post-focus"));
const mv = fs.readFileSync("src/views/MessagesView.vue", "utf8");
ok("会话页轮询只在可见时跑", mv.includes("document.hidden") && mv.includes("visibilitychange"));
ok("会话页进页面即抬已读水位", mv.includes("markRead"));
/* 轮 344：冷开 / F5 时 initCloud 还没落位，不能先画「登录后才能收发私信」再恢复 */
ok("轮 344：私信页登录闸等 cloud.checking 落位（恢复中不画未登录）",
  /v-if="!signedIn && cloud\.checking"/.test(mv) && /v-else-if="!signedIn"/.test(mv));
{
  const waitAt = mv.indexOf('dm-auth-wait');
  const gateAt = mv.indexOf('v-else-if="!signedIn"');
  const needAt = mv.indexOf('t("dm.needSignIn")');
  ok("轮 344：等待期是中性 spinner，needSignIn 只在检查结束后的分支",
    waitAt > 0 && gateAt > waitAt && needAt > gateAt && mv.slice(waitAt, gateAt).includes("rn-busy"));
}

/* ───────── 轮 397：别人主页「发私信」点了像没反应 ─────────
 * 线上 /sb 代理实测 5~20s；旧按钮只 disabled 不改文案，首屏没有任何反馈。
 * 这里钉住：按钮立刻显示「正在打开…」、2.5s 后补慢网提示、25s 超时后恢复可点。 */
{
  const wv = fs.readFileSync("src/views/WallerView.vue", "utf8");
  const fn = wv.slice(wv.indexOf("async function startDm"), wv.indexOf("/* —— 拉黑"));
  ok("轮397：发私信按钮忙时显示 opening，而不是只置灰",
    wv.includes('dmBusy ? t("dm.opening")') && wv.includes(': "✉️ " + t("dm.sendTo")'));
  ok("轮397：openConv 有 25s 超时，且 finally 一定清定时器/恢复按钮",
    fn.includes("withTimeout(openConv(uid))") && fn.includes("finally")
    && fn.includes("clearTimeout(dmSlowTimer)") && fn.includes("dmBusy.value = false"));
  ok("轮397：2.5s 后显示慢网提示",
    fn.includes("dmSlowTimer = setTimeout") && fn.includes("dmSlow.value = true") && wv.includes('t("dm.openingSlow")'));
  ok("轮397：opening / openingSlow 中英成对",
    EN["dm.opening"] === "Opening…" && ZH["dm.opening"] === "正在打开…"
    && typeof EN["dm.openingSlow"] === "string" && typeof ZH["dm.openingSlow"] === "string");
}

/* ───────── 轮 296：冷开 / 刷新落在消息页，会话列表白等 5 秒 ─────────
 * 病根不是查询慢，是根本没发查询：signedIn = cloud.ready && cloud.user，
 * 而冷开 / F5 时路由组件挂载那一刻 initCloud() 还没跑完 → onMounted 第一句
 * `if (!signedIn.value) return` 早退，refreshBlocks / loadConvs / 轮询 / 实时回调
 * 全被跳过；当时全文件又没有 watch(signedIn)，早退后**没有任何东西回来补跑**，
 * 唯一活着的恢复通道是 onActivated 挂的 5 秒轮询（且走的是不吃缓存的 loadConvsImplicit）。 */
{
  const om = mv.slice(mv.indexOf("onMounted(() => {"), mv.indexOf("onMounted(() => {") + 900);
  ok("轮296：onMounted 不再用 if (!signedIn) 早退（早退 = 会话列表白等 5 秒的死路）",
    !/if\s*\(\s*!signedIn\.value\s*\)\s*return/.test(om));
  ok("轮296：onMounted 里调了 boot()（已登录立刻跑，不再被认证时序卡住）",
    /boot\(\);/.test(om));
  ok("轮296：有 watch(signedIn) 补跑通道（认证一就绪立刻拉，不再等轮询节拍）",
    /watch\(\s*signedIn\s*,/.test(mv) && /if\s*\(\s*!v\s*\)\s*\{\s*booted = false/.test(mv));
  ok("轮296：boot 幂等（booted 闸门 —— onMounted 与 watch 两条路径撞车只跑一次）",
    /let booted = false/.test(mv) && /if\s*\(\s*booted \|\| !signedIn\.value\s*\)\s*return/.test(mv));
  ok("轮296：保活期不把轮询拉回来（boot 读 wasDeactivated）",
    /if\s*\(\s*!timer && !wasDeactivated\.value\s*\)\s*timer = setInterval/.test(mv));
  /* ② 兜底那条路也要回写缓存 —— 不然下次冷启动照样没有可秒开的快照
   * 轮 320 修正：回写的是**合并后**的列表（merged，含本地刚发的预览），
   *   不是服务端原值 rows —— 写 rows 会把「我刚发的消息」从缓存里抹掉。 */
  const lci = mv.slice(mv.indexOf("async function loadConvsImplicit"),
    mv.indexOf("async function loadConvsImplicit") + 1600);
  ok("轮296：轮询兜底 loadConvsImplicit 回写 SWR 缓存（此前绕过缓存又不回写，冷启动永远没快照）",
    /cacheSet\(\s*cacheKey\("dm:convs",\s*meId\.value\)\s*,\s*(rows|merged)\s*\)/.test(lci));
  ok("轮320：回写的是合并后的列表（merged），不是服务端原值（否则抹掉刚发的预览）",
    /cacheSet\(\s*cacheKey\("dm:convs",\s*meId\.value\)\s*,\s*merged\s*\)/.test(lci));
}
const nv = fs.readFileSync("src/views/NotificationsView.vue", "utf8");
/* #14 偏好开关移到设置页；通知页负责分栏 + 每页 20 条手动翻页 */
ok("通知页有分栏与手动分页（每页 20 条）", nv.includes("TABS") && nv.includes("PAGE = 20") && nv.includes("goPage"));
ok("通知页不再内嵌偏好开关（已迁到设置页）", !nv.includes("prefsGet") && !nv.includes("prefsSet"));
ok("通知页点击会标记已读并跳转", nv.includes("openItem") && nv.includes("targetOf"));
const sv = fs.readFileSync("src/views/SettingsView.vue", "utf8");
ok("设置页收拢皮肤/语言/总通知开关/四类偏好（#13）",
  sv.includes("themeOptions") && sv.includes("langOptions") && sv.includes("prefsSet") && sv.includes("toggleMaster"));
const mvRouter = fs.readFileSync("src/router.js", "utf8");
ok("/settings 路由已注册", mvRouter.includes('"/settings"'));

/* ───────── 轮 157：轮询尾部增量合并 mergeTail ───────── */
{
  const a = { id: 1, sender: "o", body: "hi", created_at: iso(NOW - 60000) };
  const b = { id: 2, sender: "me", body: "yo", created_at: iso(NOW - 30000) };
  const tmp = { id: -999, sender: "me", body: "sending…", pending: true, created_at: iso(NOW - 1000) };
  const none = mergeTail([a, b, tmp], [b]);
  ok("合并：无新无变 → 返回同引用（不触发重渲染）", none.rows === undefined || none.rows.length === 3);
  ok("合并：空尾部原样退回", mergeTail([a], []).added === false);
  const upd = mergeTail([a, b], [{ ...a, deleted_at: iso(NOW) }]);
  ok("合并：已见行字段变了 → 原位更新（撤回状态能刷进来）且不算新增",
    upd.rows.length === 2 && upd.rows[0].deleted_at != null && upd.rows[1] === b && upd.added === false);
  const c = { id: 3, sender: "o", body: "new", created_at: iso(NOW) };
  const app = mergeTail([a, b, tmp], [b, c]);
  ok("合并：新消息插到乐观临时消息之前（临时行仍压尾）",
    app.added === true && app.rows.length === 4 && app.rows[2].id === 3 && app.rows[3] === tmp);
  const plain = mergeTail([a], [b]);
  ok("合并：无临时消息直接尾部追加", plain.added === true && plain.rows.length === 2 && plain.rows[1] === b);
  const dupTail = mergeTail([a, b], [c, c]);
  ok("合并：同一页重复 id 只追加一条（网关重复页不产生双气泡）",
    dupTail.added === true && dupTail.rows.length === 3 && dupTail.rows.filter((x) => x.id === c.id).length === 1);
  ok("合并：非数组入参不炸", mergeTail(null, null).added === false);
}

/* 轮 378：超时后进程被杀，重进时服务端回显要认领旧失败草稿，不能画成两条 */
{
  const failed = { id: -77, sender: "me", body: "same", image_path: null,
    created_at: iso(NOW - 60 * 1000), pending: false, failed: true };
  const echo = { id: 77, sender: "me", body: "same", image_path: null, created_at: iso(NOW - 50 * 1000) };
  const merged = mergeTail([failed], [echo]);
  ok("重启认领：失败草稿遇到服务端回显只留正式行",
    merged.rows.length === 1 && String(merged.rows[0].id) === "77");
  const older = { ...echo, created_at: iso(NOW - 20 * 60 * 1000) };
  ok("重启认领：更早的同文消息不误删失败草稿",
    mergeTail([failed], [older]).rows.length === 2);
  const other = { ...echo, sender: "other" };
  ok("重启认领：别人的同文消息不误删失败草稿",
    mergeTail([failed], [other]).rows.length === 2);
  ok("重启认领：纯函数只认 failed 负数行，不碰 pending",
    dropEchoedDrafts([{ ...failed, failed: false, pending: true }], [echo]).length === 1);
  const kd = { ...failed, key: 2 };
  ok("重启认领：同文但 key 不同的前一条成功消息，不能误删后一条失败草稿",
    dropEchoedDrafts([kd], [{ ...echo, key: 1 }]).length === 1);
  ok("重启认领：key 相同直接认领（不受同文时间窗干扰）",
    dropEchoedDrafts([kd], [{ ...echo, key: 2 }]).length === 0);
  ok("重启认领：有 key 的草稿遇到 20s 前的无 key 同文行，不误删",
    dropEchoedDrafts([kd], [{ ...echo, created_at: iso(NOW - 80 * 1000), key: null }]).length === 1);
  ok("会话段整窗替换也调用 dropEchoedDrafts（先清同快照的 pending/confirmed 重复）",
    mv.includes("const snap = dropEchoedPending(asc)")
    && mv.includes("dropEchoedDrafts(keep.length ? snap.concat(keep) : snap, snap)"));
}

/* 轮 377：发送超时/没回 msg_id 时，用服务端新回显认领乐观行，别标成失败两条 */
{
  const t0 = iso(NOW);
  const temp = { id: -9, sender: "o", body: "echo", image_path: null, created_at: t0, pending: true };
  const before = new Set(["1"]);
  const echo = findSentEcho([
    { id: 1, sender: "o", body: "echo", image_path: null, created_at: iso(NOW - 60000) },
    { id: 2, sender: "o", body: "echo", image_path: null, created_at: t0 },
  ], temp, before);
  ok("回显：发送前不存在的新正式行能认领", echo && echo.id === 2);
  ok("回显：发送前已有的同文消息不认领",
    findSentEcho([{ id: 1, sender: "o", body: "echo", created_at: t0 }], temp, before) === null);
  ok("回显：撤回/失败行不认领",
    findSentEcho([{ id: 2, sender: "o", body: "echo", created_at: t0, deleted_at: t0 }], temp, before) === null
    && findSentEcho([{ id: 3, sender: "o", body: "echo", created_at: t0, failed: true }], temp, before) === null);
  ok("回显：更早的同文待发行还在时，不认领新一条",
    findSentEcho([
      { id: -8, sender: "o", body: "echo", created_at: iso(NOW - 1000), pending: true },
      { id: 2, sender: "o", body: "echo", created_at: t0 },
    ], temp, before) === null);
  /* 轮381：连发两条同文，a 超时、b 成功。b 的确认行带 b 的 key，
   * a 的认领不能把 b 吃掉。 */
  const ktemp = { ...temp, key: 2 };
  ok("回显：候选行 key 明确属于另一条同文发送时不认领",
    findSentEcho([
      { id: 2, sender: "o", body: "echo", image_path: null, created_at: t0, key: 1 },
    ], ktemp, before) === null);
  ok("回显：候选行 key 与自己一致时正常认领",
    findSentEcho([
      { id: 2, sender: "o", body: "echo", image_path: null, created_at: t0, key: 2 },
    ], ktemp, before)?.id === 2);
}

/* 轮382：实时 INSERT 比发送回包先到 —— 正式行要认领屏上的 pending，不能两条 */
{
  const t0 = iso(NOW);
  const temp = { id: -9, sender: "me", body: "hello", image_path: null,
    created_at: t0, pending: true, key: 2 };
  const echo = { id: 9, sender: "me", body: "hello", image_path: null, created_at: t0 };
  const one = claimPendingEcho([temp], [echo]);
  ok("实时认领：同人同文同时间 → 只留正式行且沿用稳定 key",
    one.claimed === true && one.rows.length === 1
    && String(one.rows[0].id) === "9" && one.rows[0].key === 2);
  ok("实时认领：不同正文不认领",
    claimPendingEcho([temp], [{ ...echo, body: "other" }]).claimed === false);
  ok("实时认领：别人的同文不认领",
    claimPendingEcho([temp], [{ ...echo, sender: "other" }]).claimed === false);
  ok("实时认领：明确属于另一条同文发送的 key 不认领",
    claimPendingEcho([temp], [{ ...echo, key: 3 }]).claimed === false);
  ok("实时认领：时间差超过 10 分钟不认领",
    claimPendingEcho([temp], [{ ...echo, created_at: iso(NOW + 11 * 60 * 1000) }]).claimed === false);
  ok("实时认领：20s 前的同文旧消息（无 key）不能当成这次回显",
    claimPendingEcho([temp], [{ ...echo, created_at: iso(NOW - 20 * 1000), key: null }]).claimed === false);
  const near = { ...temp, id: -8, created_at: iso(NOW + 1000), key: 3 };
  ok("实时认领：同文连发时按时间最近配对，而不是乱吃",
    claimPendingEcho([temp, near], [echo, { ...echo, id: 10, created_at: iso(NOW + 1000) }]).rows
      .map((m) => String(m.id)).join(",") === "9,10");
  const merged = mergeTail([temp], [echo]);
  ok("mergeTail：实时正式行直接顶掉待发行（不再追加成两条）",
    merged.rows.length === 1 && merged.added === true
    && String(merged.rows[0].id) === "9" && merged.rows[0].key === 2);
  const localBoth = dropEchoedPending([temp, echo]);
  ok("同快照去重：pending + 无 key 的实时确认行只留确认行",
    localBoth.length === 1 && String(localBoth[0].id) === "9");
  ok("同快照去重：不同正文的 pending 不动",
    dropEchoedPending([temp, { ...echo, body: "other" }]).length === 2);
  ok("同快照去重：失败草稿交给 dropEchoedDrafts，不被 pending 逻辑吃掉",
    dropEchoedPending([{ ...temp, pending: false, failed: true }, echo]).length === 2);
  /* 轮382b：发送前最大 id 下限。重开 App 后本地快照可能同时留下 pending + 确认行，
   * 靠 id 判断「这条正式行是不是这次发送之后插入的」，不再赌设备时钟只差 5s。 */
  const guarded = { ...temp, before_max: 100 };
  ok("maxPositiveId：只数正数正式行",
    maxPositiveId([{ id: -3 }, { id: "7" }, { id: 12 }, null]) === 12);
  ok("实时认领：发送前最大 id 之后的正式行才认",
    claimPendingEcho([guarded], [{ ...echo, id: 101 }]).claimed === true);
  ok("实时认领：id 不大于发送前最大 id 的同文旧消息不认",
    claimPendingEcho([guarded], [{ ...echo, id: 90, key: null }]).claimed === false);
  ok("实时认领：同一稳定 key 时不受 id 下限/时钟差影响",
    claimPendingEcho([guarded], [{ ...echo, id: 90, key: 2, created_at: iso(NOW - 2 * 60 * 1000) }]).claimed === true);
  const snapWithOld = dropEchoedPending([
    { ...echo, id: 90 }, guarded, { ...echo, id: 101 },
  ]);
  ok("同快照去重：只认 id 下限之后的新回显，旧同文行保留",
    snapWithOld.length === 2 && snapWithOld.map((m) => String(m.id)).join(",") === "90,101");
  ok("同快照去重：只有发送前旧同文行时，不误删 pending",
    dropEchoedPending([{ ...echo, id: 90 }, guarded]).length === 2);
}

/* ───────── 轮 157：聊天性能四件套接线（会话段旧版仍在；漂流瓶段轮 339 起交给组件） ───────── */
{
  const bc = fs.readFileSync("src/components/BottleChat.vue", "utf8");
  ok("聊天落地追钉底部：rAF 连帧追 + 用户上滑停手（字体晚到不再停在半截）",
    mv.includes("requestAnimationFrame(chase)") && mv.includes("userScrolling.value = true")
    && mv.includes('@touchstart.passive="onListTouch"'));
  ok("进会话钉底：开钉到首屏落定（旧缓存落底→新消息落下不再两段式停顿）",
    mv.includes("pinning.value = true;") && mv.includes("if (before == null) pinning.value = false;")
    && mv.includes("if (userScrolling.value) return;")
    && mv.includes("settled = fontQuiet() && fontsOk() && entryReady.value && el.scrollHeight === lastH"));
  ok("私信页：触顶自动翻历史（passive 滚动监听 + rAF 节流）",
    mv.includes('@scroll.passive="onScrollTop"') && mv.includes("requestAnimationFrame"));
  ok("私信页：翻历史锚点保持（scrollHeight 差值补偿）", mv.includes("el.scrollTop += el.scrollHeight - oldH"));
  ok("私信页：轮询走 mergeTail 增量合并", mv.includes("mergeTail(msgs.value, asc)"));
  ok("私信页：会话列表降频（每 3 拍一次，不再每 5s 全量拉 200 行）", mv.includes("tickN % 3 === 1"));
  ok("轮 238：拉黑会话即时从列表隐藏（乐观翻状态 + 过滤 blocked，与服务端 dm_list_convs 同口径）",
    mv.includes("c.accepted !== false && !c.blocked && !isBlocked(c.other_id)") && mv.includes("!isBlocked(c.other_id)")
    && mv.includes("if (row) row.blocked = !wasBlocked;"));
  ok("私信页：发送后就地落位（msg_id 直换 + 本地库补条）",
    mv.includes("r.msg_id") && mv.includes("dmStoreSave(meId.value, convId, msgs.value, hasMore.value)"));
  ok("私信页：进会话本地库秒开（无网络先渲染）",
    mv.includes("dmStoreLoad(meId.value, cid)") && mv.includes("applyRows(local.msgs.slice().reverse(), local.more)"));
  ok("私信页：网络回来全量落盘本地库", mv.includes("dmStoreSave(meId.value, cid, msgs.value, hasMore.value)"));
  ok("私信页：删会话/拒请求清本地库", mv.includes("dmStoreDrop(owner, c.conv_id)"));
  ok("私信页：轮询防重叠（busy 门）", mv.includes("tickBusy"));
  ok("漂流瓶聊天框：消息流 + 输入区交给同一个组件（轮 339）",
    bc.includes('import DmVacChat from "./DmVacChat.vue"') &&
    bc.includes("hide-header") &&
    bc.includes("mergeTail(msgs.value, asc)") &&
    bc.includes("r.msg_id") &&
    !bc.includes("van-field"));
}

/* ───────── 轮 157b：消息窗口缓存（形状兼容 + 读写闭环） ───────── */
{
  const w30 = dmWin(Array.from({ length: 30 }, (_, i) => ({ id: i })));
  ok("窗口缓存：旧纯数组快照兼容（30 条=还有更早）", !!w30 && w30.rows.length === 30 && w30.more === true);
  ok("窗口缓存：新包装形状透出", dmWin({ rows: [{ id: 1 }], more: false }).more === false);
  ok("窗口缓存：垃圾入参 → null", dmWin(null) === null && dmWin({}) === null && dmWin({ rows: "x" }) === null);
  dmCacheWindow("u1", "c1", [{ id: 3 }, { id: 2 }, { id: 1 }], true);
  const rt = dmPeekWindow("u1", "c1");
  ok("窗口缓存：写入→读出闭环", !!rt && rt.rows.length === 3 && rt.rows[0].id === 3 && rt.more === true);
  dmCacheWindow("u1", "c1", Array.from({ length: DM_WINDOW_CAP + 10 }, (_, i) => ({ id: i })), true);
  ok("窗口缓存：超窗裁最旧（护栏生效）", dmPeekWindow("u1", "c1").rows.length === DM_WINDOW_CAP);
  ok("窗口缓存：键带用户域（换账号不串）", dmMsgsKey("a", "c") !== dmMsgsKey("b", "c"));
  ok("本地消息库：两视图共用同一 store（BottleChat 同款读写）",
    (() => {
      const bc = fs.readFileSync("src/components/BottleChat.vue", "utf8");
      return bc.includes("dmStoreLoad(props.meId, id)") && bc.includes("dmStoreSave(props.meId, id, msgs.value, hasMore.value)");
    })());
}

/* ───────── 轮 194：本地消息库（dmStore.js 读写闭环） ───────── */
{
  const { dmStoreLoad, dmStoreSave, dmStoreMerge, dmStoreDrop } = await import("../src/utils/dmStore.js");
  const U = "u194", C = "c194";
  dmStoreDrop(U, C);
  ok("本地消息库：空库 → 空数组 + more=true", (() => {
    const e = dmStoreLoad(U, C);
    return e.msgs.length === 0 && e.more === true;
  })());
  dmStoreSave(U, C, [{ id: 2, body: "b" }, { id: 1, body: "a" }], true);
  ok("本地消息库：写入→按 id 升序读出", (() => {
    const r = dmStoreLoad(U, C);
    return r.msgs.length === 2 && r.msgs[0].id === 1 && r.msgs[1].id === 2 && r.more === true;
  })());
  dmStoreSave(U, C, Array.from({ length: 450 }, (_, i) => ({ id: i + 1 })), false);
  ok("本地消息库：超 400 条裁最旧（护栏生效）", dmStoreLoad(U, C).msgs.length === 400);
  ok("本地消息库：合并去重保序", (() => {
    const m = dmStoreMerge([{ id: 3 }, { id: 1 }], [{ id: 2 }, { id: 1, body: "dup" }]);
    return JSON.stringify(m.map((x) => x.id)) === "[1,2,3]";
  })());
  dmStoreDrop(U, C);
  ok("本地消息库：删除→读回空库", dmStoreLoad(U, C).msgs.length === 0);
  dmStoreSave("ua", "c", [{ id: 1 }], true);
  ok("本地消息库：键带用户域（换账号不串）", dmStoreLoad("ub", "c").msgs.length === 0);
  dmStoreDrop("ua", "c");
}

/* ───────── 轮 204：全量库（IndexedDB）合并逻辑（纯函数部分） ───────── */
{
  const { mergeRows, olderRows, olderWatermark } = await import("../src/utils/dmIdb.js");
  ok("全量库合并：去重保序升序", (() => {
    const m = mergeRows([{ id: 3, b: "x" }, { id: 1 }], [{ id: 2 }, { id: 3, b: "y" }]);
    return JSON.stringify(m.map((x) => x.id)) === "[1,2,3]" && m[2].b === "y";
  })());
  ok("全量库合并：超软上限裁最旧", (() => {
    const m = mergeRows(Array.from({ length: 60 }, (_, i) => ({ id: i })), [], 50);
    return m.length === 50 && m[0].id === 10;
  })());
  ok("全量库合并：空行不炸", mergeRows(null, null).length === 0);
  ok("全量库合并：字符串 id 按数值排序", (() => {
    const m = mergeRows([{ id: "10" }, { id: "2" }], [{ id: "9" }]);
    return JSON.stringify(m.map((x) => x.id)) === '["2","9","10"]';
  })());
  ok("全量合并：裁上限时不能先裁掉负数失败草稿", (() => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: i + 1 }));
    many.push({ id: -5, body: "draft", failed: true });
    const m = mergeRows(many, [], 50);
    return m.length === 50 && m.some((x) => Number(x.id) === -5)
      && m.filter((x) => Number(x.id) > 0).length === 49;
  })());
  ok("全量库翻页：字符串 id 按数值比较（9 要算早于 100）", (() => {
    const m = olderRows([{ id: "9" }, { id: "10" }, { id: "100" }], "100", 30);
    return JSON.stringify(m.map((x) => x.id)) === '["9","10"]';
  })());
  ok("全量库翻页：字符串 beforeId 也能翻", (() => {
    const m = olderRows([{ id: "9" }, { id: "10" }, { id: "100" }], "10", 30);
    return JSON.stringify(m.map((x) => x.id)) === '["9"]';
  })());
  ok("全量库回填游标：字符串 id 取数值最小（999 要压过 1000）", (() => {
    return olderWatermark([{ id: "1000" }, { id: "999" }], null) === 999
      && olderWatermark([{ id: "999" }], "1000") === 999;
  })());
}

/* ───────── 轮 165：刷新炸页/僵尸会话/表情贴底回归 ───────── */
{
  const cv = fs.readFileSync("src/views/CommunityView.vue", "utf8");
  const iDecl = cv.indexOf("let freshOk = true;");
  const iIf = cv.indexOf("if (fresh) {");
  ok("刷新成败标记声明在 if(fresh) 之前（函数作用域——块内声明=ReferenceError 炸整页）",
    iDecl > -1 && iIf > -1 && iDecl < iIf && cv.split("let freshOk").length === 2);
  const sb = fs.readFileSync("src/utils/supabase.js", "utf8");
  ok("僵尸会话自清：刷新失败判定死令牌→signOut（网络类失败不匹配）",
    sb.includes("async function deadSessionSignOut") && sb.includes("session missing")
      && sb.includes("invalid grant") && sb.includes('accessToken = "";'));
  ok("僵尸会话自清：清空本地 token 与 user 再 signOut", sb.includes('accessToken = "";') && sb.includes("cloud.user = null;"));
  ok("条内点击与占位条点击仍归各自逻辑管（占位条归 toggle，别被 document 抢先关掉）",
    /function mainBarDocClose\(e\)[\s\S]*?closest\("\.cmt-entry, \.bar-reply-tap"\)/.test(cv));
}

console.log(`dm-test: ${pass} pass, ${fails.length} fail`);
for (const f of fails) console.log("FAIL  " + f);
if (fails.length) process.exit(1);