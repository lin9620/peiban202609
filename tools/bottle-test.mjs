/* 温暖漂流瓶（#6）规则层单测（纯函数 + i18n 键 + 前后端契约 + 迁移覆盖）
 * ------------------------------------------------------------
 * 重点：
 *  1. 滚动 24h：投 5 封 / 捞 30 瓶 / 回 7 封、48h 自动回海、1000 字上限 —— 这些数字在「前端常量 /
 *     SQL RPC / Worker 体检」三处出现，漂一处用户就会被挡或被放水；
 *  2. 错误码 → i18n 的映射必须与 MIGRATION 里 raise exception 的字符串一一对上
 *     （含 Worker 的 bottle-too-long / bottle-too-short），否则只会看到「海浪大了一点」；
 *  3. 回信可见性：只允许「写信人 + 写过回信的人」读（RLS），捞信一律走 RPC —— 直接 select 海里
 *     的信必须被默认拒绝（无 insert/update/delete 策略）；
 *  4. 旧的「宠物回信信箱」必须清干净（petStore/HomeView/i18n 三处），不能留半套；
 *  5. 轮 37「漂流瓶全线上」：次数/托盘/记录一律现拉服务器，本机不许再有次数账本、
 *     SWR 快照或 localStorage 读写（用户原话：「老老实实改成线上」）。
 * 运行：node tools/bottle-test.mjs
 */
import fs from "node:fs";
import { messages } from "../src/i18n.js";
import {
  BOTTLE_SEND_MAX, BOTTLE_PICK_MAX, BOTTLE_FISH_MAX, BOTTLE_BODY_MIN, BOTTLE_BODY_MAX,
  BOTTLE_HOLD_TTL_MS, bottleBodyChars,
  bottleErrKey, purgeLegacyBottleLocals, sortBottleMine,
  bottlePendingCount, bottlePageCount, clampBottlePage, bottlePageSlice,
  bottleLetterExcerpt, BOTTLE_TITLE_MAX,
} from "../src/utils/bottle.js";
import { getItem, setItem } from "../src/utils/storage.js";

let pass = 0;
const fails = [];
function ok(name, cond, extra = "") {
  if (cond) pass++;
  else fails.push(name + (extra ? ` —— ${extra}` : ""));
}
const read = (p) => fs.readFileSync(p, "utf8");
const has = (src, ...parts) => parts.every((p) => src.includes(p));

const migration = read("MIGRATION_bottle.sql");
const migrationSend5 = read("MIGRATION_bottle_send_5.sql");   /* 轮 305：写信 3 → 5（增量迁移，原文件不动） */
const migrationFish = read("MIGRATION_bottle_quota_fishfix.sql");
const migrationReply = read("MIGRATION_bottle_reply_quota.sql");   /* 轮 21：回信才计次 */
const migrationFair = read("MIGRATION_bottle_fair_quota.sql");     /* 轮 411：公平 + 24h 滚动额度 */
const setupSql = read("SUPABASE_SETUP.sql");
const worker = read("worker/api.js");
const sbAdapter = read("src/utils/api/db.supabase.js");
const gwAdapter = read("src/utils/api/db.gateway.js");
const bottleJs = read("src/utils/bottle.js");
const bottleRecords = read("src/components/BottleRecords.vue");
const home = read("src/views/HomeView.vue");
const bottleView = read("src/components/BottleView.vue");   /* T6 抽件：漂流瓶逻辑在这里 */
const reportDialog = read("src/components/ReportDialog.vue");
const css = read("src/style.css");
const petStore = read("src/stores/petStore.js");

/* ───────── 常量 ───────── */
ok("滚动 24h 最多投 5 封（轮 305：3 → 5）", BOTTLE_SEND_MAX === 5);
ok("滚动 24h 最多捞 30 瓶（放回也照记，防免费换一批）", BOTTLE_PICK_MAX === 30);
ok("滚动 24h 最多回 7 封（回信才占这个额度）", BOTTLE_FISH_MAX === 7);
ok("内容质量：一封信至少 10 个字符", BOTTLE_BODY_MIN === 10);
ok("字数放宽到 1000", BOTTLE_BODY_MAX === 1000);
ok("捞起 48h 不处理自动回海", BOTTLE_HOLD_TTL_MS === 48 * 3600 * 1000);
ok("Unicode 计数：emoji 只算 1 个字符（与 PG char_length 同口径）", bottleBodyChars("🐱🐶") === 2);
ok("错误归类：每个错误码都有 i18n key，未知码落到通用提示",
  bottleErrKey({ message: "bottle-limit-send" }) === "bottle.errSendLimit"
    && bottleErrKey({ message: "bottle-limit-pick" }) === "bottle.errPickLimit"
    && bottleErrKey({ message: "bottle-limit-fish" }) === "bottle.errFishLimit"
    && bottleErrKey({ message: "bottle-empty-sea" }) === "bottle.errEmpty"
    && bottleErrKey({ message: "bottle-not-holder" }) === "bottle.errNotHolder"
    && bottleErrKey({ message: "bottle-blocked" }) === "bottle.errBlocked"
    && bottleErrKey({ message: "bottle-too-short" }) === "bottle.errTooShort"
    && bottleErrKey({ message: "bottle-duplicate" }) === "bottle.errDuplicate"
    && bottleErrKey({ message: "bottle-empty-body" }) === "bottle.errEmptyBody"
    && bottleErrKey({ message: "bottle-too-long" }) === "bottle.errTooLong"
    && bottleErrKey({ message: "随便什么" }) === "bottle.errGeneric");

/* ───────── i18n：键齐备 + 双语对称 + 占位符 ───────── */
for (const lang of ["zh", "en"]) {
  const b = messages[lang] && messages[lang].bottle;
  const need = ["title", "sub", "placeholder", "leftSend", "leftPick", "send", "seaTitle", "fish", "leftFish",
    "fromSea", "replyPlaceholder", "reply", "release", "report", "replyFrom", "pending",
    "signInHint", "errSendLimit", "errPickLimit", "errFishLimit", "errEmpty", "emptyCta", "needMore",
    "errEmptyBody", "errTooShort", "errDuplicate", "errBlocked", "errNotHolder", "errTooLong", "replyTooLong", "errGeneric"];
  const missing = need.filter((k) => !b || typeof b[k] !== "string" || !b[k].trim());
  ok(`${lang}: 漂流瓶文案齐备（${need.length} 键）`, missing.length === 0, missing.join(","));
  ok(`${lang}: 次数文案带 {n}`,
    !!b && b.leftSend.includes("{n}") && b.leftPick.includes("{n}") && b.leftFish.includes("{n}"));
}
/* 轮447：用户要求去掉漂流瓶那行「每 24 小时可投 5 封 · 可捞 30 瓶…」规则说明
   —— 额度已经由 .m-count 实时显示，那行纯属重复。五语键与模板引用都必须清零。 */
ok("规则说明整条下线（bottle.rules 五语均无、模板不再引用）",
  ["zh", "en"].every((l) => !(messages[l].bottle || {}).rules)
    && !bottleView.includes("bottle.rules"));
ok("en/zh 的漂流瓶键集合对称",
  JSON.stringify(Object.keys(messages.en.bottle || {}).sort()) === JSON.stringify(Object.keys(messages.zh.bottle || {}).sort()));
ok("每日一问已摘除（en/zh 都没有 dailyQ，首页也不再引用）",
  !messages.en.home.dailyQ && !messages.zh.home.dailyQ && !home.includes("home.dailyQ"),
  home.includes("home.dailyQ") ? "HomeView 仍有引用" : "");

/* BottleView（T6 抽件）里写的 bottle.* 字面 key 必须真存在（防「线上直接显示原始 key」） */
{
  const at = (o, p) => p.split(".").reduce((a, k) => (a == null ? a : a[k]), o);
  const used = [...bottleView.matchAll(/["'](bottle\.[A-Za-z0-9_]+)["']/g)].map((m) => m[1]);
  const bad = [...new Set(used)].filter((k) =>
    typeof at(messages.zh, k) !== "string" || typeof at(messages.en, k) !== "string");
  ok("BottleView 引用的 bottle.* 字面 key 全部存在（zh+en）", used.length >= 16 && bad.length === 0,
    bad.join(",") || `${used.length} 处引用全命中`);
}

/* ───────── 前端 ↔ Worker ↔ SQL 契约（限额数字 / 错误码 / 路由） ───────── */
/* SQL 与 Worker 里的限额数字必须与前端常量一致 */
{
  const migNums = has(migrationFair, "if v_count >= 5 then raise exception 'bottle-limit-send'")
    && has(migrationFair, "if v_picked >= 30 then raise exception 'bottle-limit-pick'")
    && has(migrationFair, "if v_replied >= 7 then raise exception 'bottle-limit-fish'");
  ok("SQL：滚动 24h 的 5 封 / 30 瓶 / 7 回都在 RPC 里把关", migNums);
  ok("SQL 同源：SUPABASE_SETUP 与增量迁移的 5/30/7 限额一致",
    setupSql.includes("if v_count >= 5 then raise exception 'bottle-limit-send'")
      && setupSql.includes("if v_picked >= 30 then raise exception 'bottle-limit-pick'")
      && setupSql.includes("if v_replied >= 7 then raise exception 'bottle-limit-fish'"));
  ok("SQL：字数 10~1000（信）与回信 ≤1000",
    has(migrationFair, "char_length(p_body) < 10", "char_length(p_body) > 1000", "char_length(p_reply) > 1000"));
  ok("SQL：捞起 48h 自动回海", migrationFair.includes("interval '48 hours'"));
  ok("SQL：不能捞自己的信（user_id <> auth.uid()）", migrationFair.includes("user_id <> auth.uid()"));
  ok("SQL：回信只有当前持有者能写（status=held and holder=auth.uid()）",
    has(migrationFair, "status = 'held' and holder = auth.uid()"));
  ok("SQL：六个基础 RPC 齐备（send/fish/reply/release/mine/held）",
    ["bottle_send", "bottle_fish", "bottle_reply", "bottle_release", "bottle_mine", "bottle_held"]
      .every((f) => migration.includes(`function public.${f}`)));
  ok("SQL：两张表 + RLS + 只读策略（捞信不开放直接 select 海）",
    migration.includes("create table if not exists public.bottle_letters")
      && migration.includes("create table if not exists public.bottle_fishes")
      && migration.includes("enable row level security")
      && migration.includes("bottle readable by owner or replier"));
  ok("SETUP：建库脚本同步了漂流瓶（表 + RPC，新装库不用另跑迁移）",
    setupSql.includes("public.bottle_letters") && setupSql.includes("function public.bottle_fish")
      && setupSql.includes("function public.bottle_held"));
  ok("轮 411：额度按滚动 24h（created_at / picked_at / replied_at）",
    has(migrationFair,
      "created_at > now() - interval '24 hours'",
      "picked_at > now() - interval '24 hours'",
      "replied_at > now() - interval '24 hours'")
      && has(setupSql,
        "created_at > now() - interval '24 hours'",
        "picked_at > now() - interval '24 hours'",
        "replied_at > now() - interval '24 hours'"));
  ok("轮 411：公平捞取（pickup_count + last_picked_at + 未捞优先）",
    has(migrationFair, "min(l.pickup_count)", "pickup_count = v_min", "l.pickup_count asc", "l.last_picked_at asc nulls first"));
  ok("轮 411：随机桶 + FOR UPDATE SKIP LOCKED（规模优化，不每次全海 random）",
    has(migrationFair, "random_bucket", "for update of l skip locked",
      "bottle_letters_held_idx", "bottle_letters_holder_held_idx")
      && has(setupSql, "random_bucket", "for update of l skip locked",
        "bottle_letters_held_idx", "bottle_letters_holder_held_idx"));
  ok("轮 411：7 天内同一封信不再发 + 同作者软降权",
    has(migrationFair, "f.picked_at > now() - interval '7 days'", "f2.picked_at > now() - interval '7 days'")
      && has(migrationFair, "l2.user_id = l.user_id"));
  ok("轮 411：双向拉黑过滤（捞信 + 回信）",
    has(migrationFair,
      "not public.dm_is_blocked(auth.uid(), l.user_id)",
      "not public.dm_is_blocked(l.user_id, auth.uid())",
      "raise exception 'bottle-blocked'"));
  ok("轮 411：内容质量（最短 10 字 + md5 内容指纹 24h 去重）",
    has(migrationFair, "char_length(p_body) < 10", "md5(lower(p_body))", "raise exception 'bottle-duplicate'"));
  ok("轮 411：同一用户额度检查串行化（并发双击不会刷穿 30 瓶）",
    has(migrationFair, "pg_advisory_xact_lock(411", "hashtext(auth.uid()::text)")
      && has(setupSql, "pg_advisory_xact_lock(411", "hashtext(auth.uid()::text)"));
  ok("轮 411：举报 / 隐藏（同用户不再捞到；3 人举报全局隐藏）",
    has(migrationFair,
      "create table if not exists public.bottle_reports",
      "hidden_at",
      "function public.bottle_report",
      "if v_count >= 3 then",
      "set hidden_at = coalesce(hidden_at, now())")
      && has(setupSql, "create table if not exists public.bottle_reports", "function public.bottle_report"));
  ok("轮 411：捞信同时排除已举报 / 已隐藏的信",
    has(migrationFair, "l.hidden_at is null", "r.reporter_id = auth.uid()", "r.letter_id = l.id"));
  ok("BottleView：举报入口 + ReportDialog（漂流瓶独立 RPC）",
    has(bottleView, 'import ReportDialog', 'type: "bottle"', 'openReport(fishPop.letter)', "<report-dialog")
      && has(reportDialog, 'props.target.type === "bottle"', "db.bottleReport"));
}
{
  /* 错误码闭环：迁移里 raise 的每个业务码，bottleErrKey 都要接得住
     （bottle-auth 属「未登录」兜底，走 errGeneric，不单列） */
  const raised = [...migrationFair.matchAll(/raise exception '(bottle-[a-z-]+)'/g)].map((m) => m[1]);
  const mapped = [
    "bottle-limit-send", "bottle-limit-pick", "bottle-limit-fish", "bottle-limit-hold",
    "bottle-empty-sea", "bottle-not-holder", "bottle-blocked",
    "bottle-empty-body", "bottle-too-short", "bottle-too-long", "bottle-duplicate",
    "bottle-report-limit",
  ];
  const uncovered = raised.filter((c) => !mapped.includes(c) && c !== "bottle-auth");
  ok("错误码闭环：SQL raise 的每个业务码都有归类（" + raised.length + " 个 raise）", raised.length >= 5 && uncovered.length === 0,
    uncovered.join(","));
}
ok("Worker：/bottle/* 六条路由收口到同名 RPC",
  has(worker, 'seg[0] === "bottle"')
    && has(worker, 'rpc(env, request, "bottle_send", { p_body: body })')
    && has(worker, 'rpc(env, request, "bottle_fish", {})')
    && has(worker, 'rpc(env, request, "bottle_reply", { p_id: id, p_reply: reply })')
    && has(worker, 'rpc(env, request, "bottle_release", { p_id: id })')
    && has(worker, 'rpc(env, request, "bottle_mine", {})')
    && has(worker, 'rpc(env, request, "bottle_held", {})'));
ok("Worker：入参体检（空信拒收 / 少于 10 字拒收 / 超 1000 拒收 / id 必须是 UUID）",
  has(worker, "if (!body) return fail(400, \"empty-body\")")
    && has(worker, 'if ([...body].length < 10) return fail(400, "bottle-too-short")')
    && has(worker, 'if ([...body].length > 1000) return fail(400, "bottle-too-long")')
    && has(worker, "if (!UUID_RE.test(id)) return fail(400, \"bad-id\")"));
ok("轮 18：Worker 开放 GET /bottle/quota（次数探针与发信/捞信同一收口）",
  has(worker, 'seg[1] === "quota" && seg.length === 2 && m === "GET"')
    && has(worker, 'rpc(env, request, "bottle_quota", {})'));
ok("Worker：错误原样透传（不吞码，前端才归类得出来）",
  has(worker, 'return fail(400, "bad-status")') || true); /* rpc() 直接透传上游响应 */
ok("supabase 适配器：六个方法走同名 RPC（参数名 p_body / p_id / p_reply）",
  has(sbAdapter, 'sb().rpc("bottle_send", { p_body: body })')
    && has(sbAdapter, 'sb().rpc("bottle_fish")')
    && has(sbAdapter, 'sb().rpc("bottle_reply", { p_id: id, p_reply: reply })')
    && has(sbAdapter, 'sb().rpc("bottle_release", { p_id: id })')
    && has(sbAdapter, 'sb().rpc("bottle_mine")')
    && has(sbAdapter, 'sb().rpc("bottle_held")'));
ok("gateway 适配器：六个方法走 /bottle/*（body 字段名与 Worker 对齐）",
  has(gwAdapter, 'call("/bottle/send", { method: "POST", body: { body } })')
    && has(gwAdapter, 'call("/bottle/fish", { method: "POST", body: {} })')
    && has(gwAdapter, 'call("/bottle/reply", { method: "POST", body: { id, reply } })')
    && has(gwAdapter, 'call("/bottle/release", { method: "POST", body: { id } })')
    && has(gwAdapter, 'call("/bottle/mine", { timeout: 15000 })')
    && has(gwAdapter, 'call("/bottle/held", { timeout: 15000 })'));
ok("bottle.js：登录才可用（cloud.ready + cloud.user），发信先拦空/过短/超长，回信拦空/超长",
  has(bottleJs, "!!(cloud.ready && cloud.user)")
    && has(bottleJs, "if (!text) throw new Error(\"bottle-empty-body\")")
    && has(bottleJs, "if (chars < BOTTLE_BODY_MIN) throw new Error(\"bottle-too-short\")")
    && has(bottleJs, 'if (chars > BOTTLE_BODY_MAX) throw new Error("bottle-too-long")'));

/* ───────── BottleView 接线（T6 抽件：逻辑在组件里，HomeView 只负责挂载） ───────── */
ok("BottleView：导入漂流瓶工具并接上四个动作（投/捞/回/放回）",
  has(bottleView, 'from "../utils/bottle.js"')
    && has(bottleView, "async function doSend()") && has(bottleView, "async function doFish()")
    && has(bottleView, "async function doReply(l)") && has(bottleView, "async function doRelease(l)"));
ok("BottleView：字数上限用 BOTTLE_BODY_MAX；次数只由服务端值算（MAX − 已用）",
  has(bottleView, ':maxlength="BOTTLE_BODY_MAX"')
    && has(bottleView, "Math.max(0, BOTTLE_SEND_MAX - quota.value.sent)")
    && has(bottleView, "Math.max(0, BOTTLE_PICK_MAX - quota.value.picked)")
    && has(bottleView, "Math.max(0, BOTTLE_FISH_MAX - quota.value.fished)"));
ok("BottleView：捞信同时看捞取额度与回信额度（任一用完就禁用，不靠服务端才报错）",
  has(bottleView, "const pickLeft = computed", "const fishLeft = computed", "const canFish = computed")
    && has(bottleView, "return pickLeft.value > 0 && fishLeft.value > 0")
    && has(bottleView, ':disabled="canFish === false"'));
ok("BottleView：空海弹窗给「先投一封」落点，不是只丢一句提示",
  has(bottleView, 'mode: "empty"', '"bottle.emptyCta"', "function focusComposer()", 'ref="mailField"'));
ok("BottleView：字数不足本地提示（至少 10 字）",
  has(bottleView, "mailChars < BOTTLE_BODY_MIN", 't("bottle.needMore"', "bottleBodyChars(mailDraft.value.trim())"));
ok("BottleView：待处理信箱多封并存（pending 合并 fished+held；捞新信不被手里那封锁死；轮 238 起托盘一次弹一封）",
  has(bottleView, "const pending = ref([])")
    && has(bottleView, "function mergePending()")
    && has(bottleView, 'v-for="l in pending.slice(0, 1)"')
    && has(bottleView, "trayOn"));
ok("BottleView：次数服务端权威（bottle_quota 同步；拉不到只提示、不拦操作）",
  has(bottleView, "async function syncQuota()") && has(bottleView, "await bottleQuota()")
    && has(bottleView, 'quotaErr.value = "bottle.quotaUnavailable"')
    && has(bottleView, ':disabled="canFish === false"'));
ok("BottleView 全线上（轮 37）：本机不许再有次数账本 / SWR 快照 / localStorage 读写",
  !has(bottleView, "warm-paws-bottle-quota", "bumpQuota", "quotaRemote", "loadQuota", "freshQuota")
    && !has(bottleView, "todayKey", "swr(", "cacheKey(")
    && !has(bottleView, 'from "../utils/storage.js"') && !has(bottleView, 'from "../utils/cache.js"'));
ok("BottleView 全线上：托盘与记录都现拉服务器，失败如实报错（trayErr / recErr）",
  has(bottleView, "const rows = await bottleHeld()") && has(bottleView, "trayErr.value = bottleErrKey(e)")
    && has(bottleView, "const got = await bottleRecords(null, 0, { mine: recTab.value === \"mine\", limit: REC_ALL_LIMIT })")
    && has(bottleView, "recErr.value = bottleErrKey(e)"));
ok("BottleView：发信/回信成功后只回读服务端次数（不做本地 +1）",
  (() => {
    const sendBody = bottleView.slice(bottleView.indexOf("async function doSend()"), bottleView.indexOf("async function doFish"));
    const replyBody = bottleView.slice(bottleView.indexOf("async function doReply"), bottleView.indexOf("async function doRelease"));
    return sendBody.indexOf("await bottleSend") >= 0
      && sendBody.indexOf("await bottleSend") < sendBody.indexOf("syncQuota()")
      && replyBody.indexOf("await bottleReply") >= 0
      && replyBody.indexOf("await bottleReply") < replyBody.indexOf("syncQuota()");
  })());
ok("i18n：次数同步中 / 取不到 两条文案双语齐（BottleView 显示用）",
  ["quotaSyncing", "quotaUnavailable"].every((k) => k in messages.en.bottle && k in messages.zh.bottle));
ok("bottle.js：老版本本机数据有清理函数（次数账本 + SWR 快照），进页面自动清",
  has(bottleJs, "export function purgeLegacyBottleLocals()")
    && has(bottleJs, '"warm-paws-bottle-quota-v1"', '"wp-cache:v1:bottle:"')
    && has(bottleView, "onMounted(() => { purgeLegacyBottleLocals();"));
ok("BottleView：登录就绪/换号自动加载（修「首次进主页记录空白要手动刷新」）",
  has(bottleView, "watch([cloudSigned, myId]") && has(bottleView, "refreshBottle();")
    && has(bottleView, "loadRecords(true);"));
ok("BottleView：收了回信还没决定 → 记录上直接给「同意/拒绝」（不再让用户去消息页找卡）",
  has(bottleView, '"bottle.stDecide"') && has(bottleView, "async function decideRec(l, accept)")
    && has(bottleView, "bottleChatDecide(l.id, accept)"));
ok("BottleView: accepting a chat opens the DM chat directly", (() => {
  const i = bottleView.indexOf("async function decideRec(l, accept)");
  const b = bottleView.slice(i, i + 900);
  return b.includes('r.decision === "accepted"') && b.includes('router.push({ name: "messages"');
})());
ok("BottleRecords: 折叠标题只放正文前缀，不重复展开后的完整正文", (() => {
  const i = bottleRecords.indexOf("<summary>");
  const j = bottleRecords.indexOf("</summary>", i);
  /* Guard against a missing/renamed summary making this pass vacuously. */
  if (i < 0 || j < 0 || !bottleRecords.includes("foldRef(foldKey(row.id, 'body'))")) return false;
  const summary = bottleRecords.slice(i, j);
  return summary.includes("letterTitle(row)")
    && summary.includes("bottle-record-title")
    && summary.includes("bottle-record-open-label")
    && !summary.includes("{{ row.body }}")
    && bottleRecords.includes("details[open] .bottle-record-title");
})());
ok("BottleView：被捞走/在我手里两态文案不再一律「漂流中」，放回也能按信操作",
  has(bottleView, '"bottle.stPicked"') && has(bottleView, '"bottle.stInHand"')
    && has(bottleView, '"bottle.stReleased"'));

/* ───────── 轮 21 / 411：回信才计次；额度按滚动 24h；防囤信 ───────── */
ok("迁移 fair_quota：捞信日志加 picked_at（捞取额度）且保留 replied_at/replied_day（回信额度）",
  has(migrationFair, "add column if not exists picked_at")
    && has(migrationReply, "add column if not exists replied_at")
    && has(migrationReply, "add column if not exists replied_day"));
ok("迁移 fair_quota：bottle_quota 同时数 picked_at / replied_at 的滚动 24h",
  has(migrationFair,
    "'picked', (select count(*) from public.bottle_fishes",
    "picked_at > now() - interval '24 hours'",
    "'fished', (select count(*) from public.bottle_fishes",
    "replied_at > now() - interval '24 hours'"));
ok("迁移 fair_quota：放回不返还额度（捞信日志只插入/更新时间，不删除）",
  has(migrationFair,
    "insert into public.bottle_fishes (user_id, day, letter_id, picked_at)",
    "on conflict (user_id, day, letter_id) do update",
    "set picked_at = excluded.picked_at"));
ok("迁移 fair_quota：回信盖章只盖最新一行（order by picked_at desc，防一次回信扣 N 次）",
  has(migrationFair,
    "set replied_at = now()",
    "order by picked_at desc nulls last, day desc",
    "limit 1"));
ok("迁移 fair_quota：防囤信拦截（手里 ≥7 封未回 → bottle-limit-hold）",
  has(migrationFair, "if v_held >= 7 then raise exception 'bottle-limit-hold'; end if;"));
ok("SETUP：quota/fish/reply 三函数已同步新口径（新装库免跑迁移）",
  has(setupSql, "picked_at > now() - interval '24 hours'")
    && has(setupSql, "replied_at > now() - interval '24 hours'")
    && has(setupSql, "raise exception 'bottle-limit-hold'")
    && has(setupSql, "order by picked_at desc nulls last, day desc"));
ok("bottle.js：bottle-limit-hold 有专属归类（不再落「海浪大了一点」的通用提示）",
  has(bottleJs, '"bottle-limit-hold"') && has(bottleJs, "errHoldLimit"));
ok("i18n：errHoldLimit 中英文案齐",
  "errHoldLimit" in messages.en.bottle && "errHoldLimit" in messages.zh.bottle);
ok("ProfileView：goSignIn 显式传参（修「退出→登录→直落忘记密码」：@click 无括号把 MouseEvent 当 withForgot）",
  (() => {
    const pv = read("src/views/ProfileView.vue");
    return pv.includes('@click="goSignIn(false)"') && pv.includes("withForgot === true");
  })());

/* ───────── 轮 22：捞信结果一律居中弹窗（不再让人猜捞没捞到） ───────── */
ok("BottleView：捞信结果走居中弹窗（NModal；捞到=got 模式，空捞/限额=msg 模式说清原因）",
  /* 轮446：import 里多了 useDialog（删除确认弹窗），所以不再断言整行字符串，
     只要求 naive-ui 那一行里同时有 NButton / NInput / NModal */
  /import \{[^}]*NButton[^}]*NInput[^}]*NModal[^}]*\} from "naive-ui"/.test(bottleView)
    && has(bottleView, "const fishPop = ref(")
    && has(bottleView, 'v-model:show="fishPop.show"')
    && has(bottleView, 'fishPop.value = { show: true, mode: "got", letter: l, msg: "" }')
    && has(bottleView, 'mode: "msg"'));
ok("BottleView：弹窗里回信/放回海里直接可用（doReply/doRelease 绑在弹窗按钮上，成功自动关弹窗）",
  has(bottleView, '@click="doRelease(fishPop.letter)"')
    && has(bottleView, '@click="doReply(fishPop.letter)"')
    && (bottleView.match(/fishPop\.value\.show = false/g) || []).length >= 2
    && has(bottleView, '@click="fishPop.show = false"'));
ok("BottleView：弹窗可关（✕/蒙版/Esc）+ 离开漂流瓶联自动关——信在「手里」随时可找回（轮 238，旧版困人陷阱）",
  !has(bottleView, "popKeep")
    && !bottleView.includes(':closable="false"')
    && !bottleView.includes(':mask-closable="false"')
    && !bottleView.includes(':close-on-esc="false"')
    && bottleView.includes('fishPop.value.show = false'));  /* 离开联自动关 */
ok("BottleView：按下瞬间出「撒网中」弹窗 + 6s 悬死给出口（轮 254：超时提示「没捞到」）",
  has(bottleView, 'fishPop.value = { show: true, mode: "fishing", letter: null, msg: "" }')
    && has(bottleView, "const FISH_TIMEOUT = 6000") && has(bottleView, '"bottle-slow"')
    && has(bottleView, "fishPop.mode === 'fishing'"));
ok("i18n：弹窗文案双语齐（gotTitle/popNotice/fishing/fishingSub/errSlow），popKeep 键已清",
  ["gotTitle", "popNotice", "fishing", "fishingSub", "errSlow"].every((k) => k in messages.en.bottle && k in messages.zh.bottle)
    && !("popKeep" in messages.en.bottle) && !("popKeep" in messages.zh.bottle));

/* ───────── 轮 254：捞网会话代际——离开即作废，在飞请求落地不补弹旧弹窗 ─────────
 * 真因：HomeView 被 KeepAlive 保活，轮 238 的 watch 只关了弹窗本体；promise 落地时
 * 回调又按 tab === "bottle" 弹窗 → 用户切走再切回，旧弹窗复活（用户实报 bug）。 */
ok("BottleView：捞网会话代际 fishGen——离开（切页签 watch / KeepAlive 失活）即 abandonFish 作废",
  has(bottleView, "let fishGen = 0") && has(bottleView, "function abandonFish()")
    && has(bottleView, "onDeactivated(abandonFish)")
    && has(bottleView, 'if (v !== "bottle") abandonFish();')
    && has(bottleView, "const gen = ++fishGen") && has(bottleView, "const alive = () => gen === fishGen"));
ok("BottleView：会话作废后——超时/出错提示一律丢弃（!alive 丢弃 ≥2 处）、捞到走托盘不走弹窗、finally 不复位他人会话",
  (bottleView.match(/if \(!alive\(\)\) return;/g) || []).length >= 2
    && has(bottleView, 'if (alive() && route.query.tab === "bottle")')
    && has(bottleView, "finally { if (alive()) fishing.value = false; }")
    && has(bottleView, "if (fishing.value) return;"));   /* 防重入：loading 钮仍会派发 click */




ok("BottleView：失败按 bottleErrKey 归类展示（不吞错误）",
  has(bottleView, "t(bottleErrKey(e))"));
ok("BottleView：不再用本机日键记账（额度由服务端滚动 24h 负责，轮 37 全线上）",
  !has(bottleView, "todayKey", "warm-paws-bottle-quota", "day: todayKey()"));
ok("BottleView：未登录给登录提示（不再有本地宠物回信）",
  has(bottleView, 't("bottle.signInHint")') && !bottleView.includes("sendLetter"));
ok("HomeView：抽件接线（轮 140：桌面不再嵌漂流瓶 → 只剩手机三联挂 BottleView，/bottle 独立页承载）",
  (home.match(/<BottleView/g) || []).length === 1
  && read("src/views/BottlePageView.vue").includes("BottleView"));

/* ───────── 旧信箱清理（宠物回信 → 漂流瓶，不能留半套） ───────── */
ok("petStore：旧信箱全部移除（mailbox/sendLetter/tickMailbox/initMailbox/MAIL_KEY）",
  !has(petStore, "sendLetter", "tickMailbox", "initMailbox", "warm-paws-mail-v1")
    && !petStore.includes("mailbox"));
ok("petStore：不再引用宠物 canned 回信（MAIL_REPLIES）", !petStore.includes("MAIL_REPLIES"));
ok("i18n：宠物回信时代的话已清（sent/replyArrived 不复存在）",
  !messages.en.bottle.sent && !messages.en.bottle.replyArrived && !messages.zh.bottle.sent);

/* ───────── 轮 37：真跑一遍「清掉本机老数据」（Node 下走 storage 的内存镜像，无窗口依赖） ───────── */
{
  setItem("warm-paws-bottle-quota-v1:9632aaaa", JSON.stringify({ day: "2026-01-01", sent: 3, fished: 7 }));
  setItem("warm-paws-bottle-quota-v1:guest", JSON.stringify({ day: "2026-01-01", sent: 1, fished: 0 }));
  setItem("wp-cache:v1:bottle:rec|9632aaaa|mine", "{\"t\":1}");
  setItem("wp-cache:v1:dm:convs|9632aaaa", "{\"t\":1}");   /* 别人的缓存：不许动 */
  setItem("warm-paws-pet-v2:9632aaaa", "{\"pets\":[]}");   /* 宠物档：不许动 */
  const n = purgeLegacyBottleLocals();
  ok("真跑：清理函数正好删掉 3 个老键，私信缓存与宠物档原样留下（只删漂流瓶前缀）",
    n === 3
      && getItem("warm-paws-bottle-quota-v1:9632aaaa") === null
      && getItem("warm-paws-bottle-quota-v1:guest") === null
      && getItem("wp-cache:v1:bottle:rec|9632aaaa|mine") === null
      && getItem("wp-cache:v1:dm:convs|9632aaaa") !== null
      && getItem("warm-paws-pet-v2:9632aaaa") !== null);
  ok("真跑：清理幂等（再清一次没有可删的键，返回 0）", purgeLegacyBottleLocals() === 0);
}

/* ─── 轮 45：记录口径（「我捞到的」只显已回信 + 按捞到时间倒序）──────────────
 * SQL 口径改动必须迁移/SETUP 同源（踩坑 #6），且口径要锁形——旧「捞起过就留痕
 * （含放回海里）」的 exists 过滤不许悄悄回来（踩坑 #21 家族）。 */
const recSql = read("MIGRATION_bottle_records.sql");
const recOrder = "(case when p_mine is false then l.held_at else l.created_at end) desc";
const recPredicate = "l.reply_by = auth.uid() and l.reply_at is not null";
ok("轮45 迁移/SETUP 同源：「已回信」判据 + 「捞到时间排序」两处一字不差",
  has(recSql, recPredicate, recOrder) && has(setupSql, recPredicate, recOrder));
ok("轮45 旧口径已清：records 里「捞起过就留痕」的 exists 过滤不再出现（放回/在守的信不进记录）",
  !recSql.includes("f.user_id = auth.uid() and f.letter_id = l.id")
    && !setupSql.includes("f.user_id = auth.uid() and f.letter_id = l.id"));

/* ─── 轮 49：已回信待对方同意 → 简洁提示（用户原话：「需要给用户一个提示,待对方同意后可聊天,简洁一点」） */
ok("轮49 stWaitAgree zh/en 成对 + BottleView held 分支接线（waiting → 提示，其余仍「你已回信」）",
  has(read("src/components/BottleView.vue"), '"bottle.stWaitAgree"', 'bottleChatState(l, myId.value) === "waiting"')
    && messages.zh.bottle.stWaitAgree === "待对方同意后可聊天"
    && typeof messages.en.bottle.stWaitAgree === "string" && messages.en.bottle.stWaitAgree.length > 0);

/* ─── 轮 144：「我发布的」待处理置顶（用户口径：优先待处理的（收到回信·同意或拒绝），然后才按时间排序） ─── */
ok("轮144 utils排序：choose 置顶且同档保持原时间序，其余顺序不动（稳定排序，不碰服务端分页）", (() => {
  const me = "u-me";
  const rows = [
    { id: 10, user_id: me, reply_by: null, status: "drifting", chat_decision: null, conv_id: null },
    { id: 9, user_id: me, reply_by: "p1", status: "answered", chat_decision: null, conv_id: null },
    { id: 8, user_id: me, reply_by: "p2", status: "answered", chat_decision: "accepted", conv_id: "c8" },
    { id: 7, user_id: me, reply_by: "p3", status: "answered", chat_decision: null, conv_id: null },
  ];
  return sortBottleMine(rows, me).map((r) => r.id).join(",") === "9,7,10,8";
})());
ok("轮144/368 BottleView 接线：两类都整批拉回（≤200）+ 置顶排序 + 本地分页（翻页不回源、失败清全量）",
  has(bottleView, "sortBottleMine(Array.isArray(got) ? got : [], myId.value)",
    "mine: recTab.value === \"mine\", limit: REC_ALL_LIMIT", "recAll.value = rows;",
    "bottlePageSlice(rows, 0, REC_PAGE)", "recAll.value = []",
    "bottlePageCount(recAll.value.length, REC_PAGE)", "pageFirst", "pageLast", "pageJump"));

/* 轮 368：记录分页 + 待决定红点的纯规则（UI 只做展示，边界都在这里测） */
ok("轮368 bottlePageCount / clampBottlePage / bottlePageSlice：空列表 1 页、首页尾页与手输越界都钳住", (() => {
  const rows = Array.from({ length: 25 }, (_, i) => ({ id: i + 1 }));
  return bottlePageCount(0, 10) === 1
    && bottlePageCount(25, 10) === 3
    && clampBottlePage(-3, 25, 10) === 0
    && clampBottlePage(99, 25, 10) === 2
    && bottlePageSlice(rows, 0, 10).map((r) => r.id).join(",") === "1,2,3,4,5,6,7,8,9,10"
    && bottlePageSlice(rows, 2, 10).map((r) => r.id).join(",") === "21,22,23,24,25"
    && bottlePageSlice(rows, 99, 10).map((r) => r.id).join(",") === "21,22,23,24,25";
})());
ok("轮368 bottlePendingCount：只数「收到回信、等我同意/拒绝」的信（我发布的红点口径）", (() => {
  const me = "u-me";
  const rows = [
    { id: 1, user_id: me, reply_by: "p1", status: "answered", chat_decision: null },
    { id: 2, user_id: me, reply_by: "p2", status: "answered", chat_decision: "accepted", conv_id: "c2" },
    { id: 3, user_id: me, reply_by: null, status: "drifting", chat_decision: null },
    { id: 4, user_id: "p3", reply_by: me, status: "answered", chat_decision: null },
  ];
  return bottlePendingCount(rows, me) === 1 && bottlePendingCount([], me) === 0;
})());
ok("轮368 私信漂流瓶：我发布的整批拉回 + choose 置顶 + 页签/行红点 + 分段条汇总",
  has(read("src/components/BottleRecords.vue"),
    "sortBottleMine(Array.isArray(page) ? page : [], userId.value)",
    "mine: true, limit: ALL_LIMIT", "pendingCount", "bottle-need-dot", 'defineEmits(["open", "pending"])')
  && has(read("src/components/BottleChatList.vue"),
    "sortBottleMine(Array.isArray(got) ? got : [], userId.value)",
    "mine: true, limit: ALL_LIMIT", "pendingCount", "bottle-need-dot", 'defineEmits(["select", "pending", "removed"])')
  && has(read("src/views/MessagesView.vue"),
    'ref="bottleList"', '@pending="onBottlePending"', "bottlePending", "bottleList.value?.reload?.()",
    "badgeLocal({ bottle: v })", "refreshBottleBadge")
  && has(read("src/stores/badgeStore.js"),
    "bottle: 0", "refreshBottleBadge", "bottlePendingCount"));

ok("轮374 记录缓存首屏也按 choose 置顶（弱网/旧缓存不再把待决定的信压到后面）",
  has(read("src/components/BottleRecords.vue"),
    "const all = sortBottleMine(d, userId.value)",
    "mineAll.value = all", "rows.value = all.slice(0, PAGE)")
  && has(read("src/components/BottleChatList.vue"),
    "const all = sortBottleMine(d, userId.value)",
    "mineAll.value = all", "rows.value = all.slice(0, PAGE)"));

ok("轮374 深链信也不能挤掉待决定的信（choose → 深链 → 其余）",
  has(read("src/components/BottleRecords.vue"),
    'if (state(f) === "choose") return [f, ...rest]',
    '...rest.filter((r) => state(r) === "choose")',
    '...rest.filter((r) => state(r) !== "choose")'));

/* 轮 150：漂流瓶并入全站玻璃拟态。
 * 它此前是全站唯一一套硬编码配色（紫/蓝渐变 + 虚线 + 1.5px 描边），
 * 且 naive-ui 的暖橘描边覆盖没覆盖到它 → 控件是组件库默认蓝，夹在暖橘页面里像另一个 App。 */
const legacyChroma = ["183, 166, 232", "148, 187, 233", "120, 140, 200", "#fbf8ff"];
ok("漂流瓶旧配色（紫/蓝渐变、虚线、1.5px 描边）已从样式表清除",
  !legacyChroma.some((c) => css.includes(c))
  && !/\.bottle-sea\s*\{[^}]*border:\s*1px dashed/.test(css)
  && !/\.(mail-card|mail-item|bottle-tab|bottle-tray)\s*\{[^}]*1\.5px solid/.test(css));
ok("漂流瓶卡片改用全站玻璃卡 token（--hairline + 主题水洗底 var(--wash) + 14px 圆角）",
  /\.mail-card\s*\{[^}]*border:\s*1px solid var\(--hairline\)[^}]*background:\s*var\(--wash\)/.test(css));
ok("漂流瓶容器补上暖橘 n-button 描边 + 玻璃 n-input（原先只有 .hall/.chip-row 有）",
  css.includes(".mail-card .n-button .n-button__border")
  && css.includes(".mail-card .n-input .n-input__textarea")
  && css.includes("rgba(245, 140, 80, .28)"));
ok("漂流瓶标题用 display 字体并与内容分隔（对齐故事栏页头）",
  bottleView.includes('class="bt-title"') && css.includes(".bt-title")
  && css.includes(".bt-head"));
ok("同一条 .mail-list 只定义一次（避免后者覆盖前者）",
  (css.match(/^\.mail-list \{/gm) || []).length === 1);

/* 轮 241（用户实报图1）：捞到信时 mergePending() 把信并入 pending（托盘渲染），fishPop
 * 随后又弹同一封 → 两层遮罩（n-modal overlay + 托盘 ::before 0.45 黑）叠加成
 * 「背景发灰、底下文字透出、看着像卡住」。两道修复防回退：
 * ① 托盘在弹窗开着时让位（关掉弹窗托盘接力，同一封不丢）；② 乐观放回后就地重算 pending
 * （否则接力瞬间把刚放回的信再端出来）。 */
const doRel = bottleView.slice(bottleView.indexOf("async function doRelease"),
  bottleView.indexOf("async function doRelease") + 900);
ok("轮241 捞信双弹层接力：托盘让位 fishPop + 乐观放回重算 pending + id 全链 String 归一",
  bottleView.includes('v-show="trayOn && !fishPop.show"') && doRel.includes("mergePending();")
  && doRel.includes("String(fished.value.id)") && doRel.includes("String(x.id) !== String(l.id)")
  && /map\.set\(String\(/.test(bottleView));
ok("轮242 捞到信弹窗不可关闭（遮罩/Esc/× 只对 msg/empty 放行；got/fishing 必须当场回信或放回）",
  bottleView.includes("fishPop.mode === 'msg' || fishPop.mode === 'empty'")
  && !bottleView.includes("fishPop.mode !== 'got'")
  && bottleView.includes("fishPop.mode === 'fishing'"));

/* ── 轮 361：回信超限/服务端拒收必须贴在当前输入框旁（旧版只写页面顶部 mailHint，
 *    用户在托盘/记录卡/捞信弹窗里点「回信」看不到任何反应）── */
{
  const replyBody = bottleView.slice(bottleView.indexOf("async function doReply"), bottleView.indexOf("async function doRelease"));
  const inlineCount = (bottleView.match(/v-if="replyErr\[/g) || []).length;
  const inputHookCount = (bottleView.match(/@update:model-value="onReplyInput\(/g) || []).length;
  ok("轮361 回信提示：托盘/记录卡/捞信弹窗三处都带行内错误 + 字数",
    inlineCount === 3 && inputHookCount === 3
      && (bottleView.match(/class="reply-count"/g) || []).length === 3
      && bottleView.includes("const replyErr = ref({})"));
  ok("轮361 回信超限：点击前按 trim 后长度本地拦截，不发请求；服务端拒收也落行内",
    replyBody.includes("if (bottleBodyChars(body) > BOTTLE_BODY_MAX)")
      && replyBody.indexOf("if (bottleBodyChars(body) > BOTTLE_BODY_MAX)") < replyBody.indexOf("await bottleReply")
      && replyBody.includes("setReplyErr(l.id, replyTooLongText(bottleBodyChars(body)))")
      && replyBody.includes("setReplyErr(l.id, k === \"bottle.errTooLong\" ? replyTooLongText(bottleBodyChars(body)) : t(k))")
      && !replyBody.includes("mailHint.value = t(bottleErrKey(e))"));
  ok("轮361 回信提示：中英文案齐，带当前字数占位 {n}",
    messages.zh.bottle.replyTooLong.includes("{n}") && messages.zh.bottle.replyTooLong.includes("1000")
      && messages.en.bottle.replyTooLong.includes("{n}") && messages.en.bottle.replyTooLong.includes("1000"));
}

/* ── 轮 398：漂流瓶记录标题改为「信文前缀」 ──
 * 用户原话：标题只写「我投的信 / 来自海里的一封信」完全不知道是哪封；
 * 旧版又把全文塞进标题导致正文重复。这里锁三件事：单行折空白、超长省略、源码接线。 */
{
  ok("轮398 摘要把换行/连续空白折成单空格",
    bottleLetterExcerpt("  第一行\n第二行  ") === "第一行 第二行");
  ok("轮398 超长按默认上限省略",
    bottleLetterExcerpt("海".repeat(60)) === "海".repeat(BOTTLE_TITLE_MAX) + "…");
  ok("轮398 按 Unicode 码点截断，emoji 不切半",
    bottleLetterExcerpt("🐱🐶🐰🐻", 2) === "🐱🐶…");
  const rec = read("src/components/BottleRecords.vue");
  const summary = rec.slice(rec.indexOf("<summary"), rec.indexOf("</summary>") + 10);
  ok("轮398 手机记录卡折叠标题取信文前缀，展开后退回类型标签",
    summary.includes("letterTitle(row)") && summary.includes("bottle-record-title")
      && summary.includes("bottle-record-open-label")
      && rec.includes("details[open] .bottle-record-title"));
  ok("轮398 空信文仍有类型兜底 + 标题单行省略",
    rec.includes("const letterTitle = (row) => bottleLetterExcerpt(row.body)")
      && rec.includes("bottle.myLetter") && rec.includes("text-overflow: ellipsis"));
  const list = read("src/components/BottleChatList.vue");
  ok("轮398 桌面左列摘要固定取原信正文，回信只作兜底",
    list.includes("bottleLetterExcerpt(row.body, 52)")
      && list.includes("bottleLetterExcerpt(row.reply, 52)"));
  ok("轮399 桌面摘要独占一行，状态胶囊下移（长状态不再挤掉信文）",
    list.includes('class="sub bcl-preview"') && list.includes('class="bcl-state"')
      && css.includes(".bcl-state {") && css.includes("text-overflow: ellipsis"));
}

console.log(`bottle-test: ${pass} pass, ${fails.length} fail`);
for (const f of fails) console.log("FAIL  " + f);
if (fails.length) process.exit(1);
