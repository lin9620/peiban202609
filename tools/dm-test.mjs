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
  mergeTail, dmWin, dmMsgsKey, dmCacheWindow, dmPeekWindow, DM_WINDOW_CAP,
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
  ok("合并：非数组入参不炸", mergeTail(null, null).added === false);
}

/* ───────── 轮 157：聊天性能四件套接线（会话段 + 漂流瓶段） ───────── */
{
  const bc = fs.readFileSync("src/components/BottleChat.vue", "utf8");
  ok("聊天落地追钉底部：rAF 连帧追 + 用户上滑停手（字体晚到不再停在半截）",
    mv.includes("requestAnimationFrame(chase)") && mv.includes("userScrolling.value = true")
    && bc.includes("requestAnimationFrame(chase)")
    && mv.includes('@touchstart.passive="onListTouch"') && bc.includes('@touchstart.passive="onListTouch"'));
  ok("进会话钉底：开钉到首屏落定（旧缓存落底→新消息落下不再两段式停顿）",
    mv.includes("pinning.value = true;") && mv.includes("if (before == null) pinning.value = false;")
    && bc.includes("pinning.value = true;") && bc.includes("pinning.value = false;")
    && mv.includes("if (userScrolling.value) return;") && bc.includes("if (userScrolling.value) return;")
    && mv.includes("&& !pinning.value") && bc.includes("&& !pinning.value"));
  ok("私信页：触顶自动翻历史（passive 滚动监听 + rAF 节流）",
    mv.includes('@scroll.passive="onScrollTop"') && mv.includes("requestAnimationFrame"));
  ok("私信页：翻历史锚点保持（scrollHeight 差值补偿）", mv.includes("el.scrollTop += el.scrollHeight - oldH"));
  ok("私信页：轮询走 mergeTail 增量合并", mv.includes("mergeTail(msgs.value, asc)"));
  ok("私信页：会话列表降频（每 3 拍一次，不再每 5s 全量拉 200 行）", mv.includes("tickN % 3 === 1"));
  ok("私信页：发送后就地落位（msg_id 直换 + 窗口缓存补条）",
    mv.includes("r.msg_id") && mv.includes("dmPeekWindow(meId.value, convId)"));
  ok("私信页：首屏走窗口缓存（dm:msgs 键 + dmWin 归一）",
    mv.includes("dmMsgsKey(meId.value, id)") && mv.includes("dmWin(v)"));
  ok("私信页：翻过的历史并入缓存窗口", mv.includes("w.rows.concat(hit.rows)"));
  ok("私信页：轮询防重叠（busy 门）", mv.includes("tickBusy"));
  ok("漂流瓶聊天框：同款四件套",
    bc.includes('@scroll.passive="onScrollTop"') &&
    bc.includes("el.scrollTop += el.scrollHeight - oldH") &&
    bc.includes("mergeTail(msgs.value, asc)") &&
    bc.includes("r.msg_id"));
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
  ok("窗口缓存：两视图共用同一键规则", fs.readFileSync("src/components/BottleChat.vue", "utf8").includes("dmMsgsKey(props.meId, id)"));
}

/* ───────── 轮 164：表情按钮接线（评论框/私信框五处 + 组件本身） ───────── */
{
  const picker = fs.readFileSync("src/components/EmojiPicker.vue", "utf8");
  const emojiCells = (picker.match(/"[^"]*[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}][^"]*"/gu) || []);
  const uniq = new Set(emojiCells);
  ok("表情面板：按钮同行找 textarea 光标插入（拿不到就追加）",
    picker.includes('parentElement.querySelector("textarea, input")')
    && picker.includes("selectionStart") && picker.includes("setSelectionRange"));
  ok("表情面板：fixed 定位 + teleport 到 body（防 overflow 裁剪/transform 陷阱）",
    picker.includes("position: fixed") && picker.includes('to="body"'));
  ok("表情面板：表情足量（≥56 格）且无重复", emojiCells.length >= 56 && uniq.size === emojiCells.length);
  ok("表情面板：i18n 键 emoji.title 在用", /t\(['"]emoji\.title['"]\)/.test(picker));
  const cases = [
    ["私信会话框", "src/views/MessagesView.vue", 1],
    ["漂流瓶聊天框", "src/components/BottleChat.vue", 1],
    ["帖子详情评论框", "src/views/PostDetailView.vue", 1],
    ["暖心墙（内联框+底部输入条）", "src/views/CommunityView.vue", 2],
  ];
  for (const [name, f, need] of cases) {
    const c = fs.readFileSync(f, "utf8");
    const used = (c.match(/<EmojiPicker /g) || []).length;
    const wired = c.includes('from "../components/EmojiPicker.vue"') || c.includes('from "./EmojiPicker.vue"');
    ok("表情按钮接入：" + name, used >= need && wired);
  }
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
  const picker = fs.readFileSync("src/components/EmojiPicker.vue", "utf8");
  ok("表情面板：手机端输入行骑在面板头上（推开输入行+面板钉行底+贴屏幕底）",
    picker.includes("marginBottom = \"34vh\"") && picker.includes('top: Math.round(r.bottom + 2)')
    && picker.includes('bottom: "0"'));
  ok("表情面板：手机端选完表情不拉起键盘（面板不被压住）",
    picker.includes("window.innerWidth >= 640") && picker.includes("setSelectionRange(caret, caret)"));
  ok("表情面板开着时点外不连带收评论条", cv.includes('document.querySelector(".emo-panel")'));
}

console.log(`dm-test: ${pass} pass, ${fails.length} fail`);
for (const f of fails) console.log("FAIL  " + f);
if (fails.length) process.exit(1);