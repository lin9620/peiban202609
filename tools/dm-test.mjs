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
  "dm.title", "dm.intro", "dm.needSignIn", "dm.loadFail", "dm.search", "dm.requests",
  "dm.conversations", "dm.accept", "dm.reject", "dm.empty", "dm.more", "dm.open",
  "dm.mute", "dm.unmute", "dm.hide", "dm.block", "dm.unblock", "dm.someone",
  "dm.mutedTag", "dm.requestTag", "dm.older", "dm.reachTop", "dm.sending",
  "dm.sendFailed", "dm.recalled", "dm.recall", "dm.noMessages", "dm.gateBlockedByMe",
  "dm.gateRequest", "dm.placeholder", "dm.hint", "dm.send", "dm.pickOne",
  "dm.emptyPreview", "dm.errEmpty", "dm.errTooLong", "dm.errBlocked", "dm.errBlockedByMe",
  "dm.errForbidden", "dm.errAuth", "dm.errNoUser", "dm.errNetwork", "dm.errTooLate", "dm.errFirstLimit",
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
for (const fn of ["dm_send", "notif_page", "notif_clear", "admin_broadcast"]) {
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
const isGroup = (n) => n.startsWith("dm") || n.startsWith("notif") || n === "adminBroadcast";
const D = [...names(direct)].filter(isGroup).sort();
const G = [...names(gateway)].filter(isGroup).sort();
ok("两实现 dm/notif 方法集一致", eq(D, G), `${D.join(",")} vs ${G.join(",")}`);
const NEED_METHODS = [
  "dmOpen", "dmListConvs", "dmListMessages", "dmConvMeta", "dmSend", "dmMarkRead",
  "dmHide", "dmUnhide", "dmMute", "dmAccept", "dmRecall", "dmBlock", "dmUnblock",
  "dmBlocks", "dmUnreadTotal", "notifPage", "notifUnread", "notifMark", "notifClear",
  "notifPrefsGet", "notifPrefsSet", "adminBroadcast",
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

console.log(`dm-test: ${pass} pass, ${fails.length} fail`);
for (const f of fails) console.log("FAIL  " + f);
if (fails.length) process.exit(1);