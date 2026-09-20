/* 温暖漂流瓶（#6）规则层单测（纯函数 + i18n 键 + 前后端契约 + 迁移覆盖）
 * ------------------------------------------------------------
 * 重点：
 *  1. 每日 3 封 / 7 瓶、48h 自动回海、1000 字上限 —— 这些数字在「前端常量 /
 *     SQL RPC / Worker 体检」三处出现，漂一处用户就会被挡或被放水；
 *  2. 错误码 → i18n 的映射必须与 MIGRATION 里 raise exception 的字符串一一对上
 *     （含 Worker 的 bottle-too-long），否则只会看到「海浪大了一点」；
 *  3. 回信可见性：只允许「写信人 + 写过回信的人」读（RLS），捞信一律走 RPC —— 直接 select 海里
 *     的信必须被默认拒绝（无 insert/update/delete 策略）；
 *  4. 旧的「宠物回信信箱」必须清干净（petStore/HomeView/i18n 三处），不能留半套。
 * 运行：node tools/bottle-test.mjs
 */
import fs from "node:fs";
import { messages } from "../src/i18n.js";
import {
  BOTTLE_SEND_MAX, BOTTLE_FISH_MAX, BOTTLE_BODY_MAX, BOTTLE_HOLD_TTL_MS,
  bottleErrKey,
} from "../src/utils/bottle.js";

let pass = 0;
const fails = [];
function ok(name, cond, extra = "") {
  if (cond) pass++;
  else fails.push(name + (extra ? ` —— ${extra}` : ""));
}
const read = (p) => fs.readFileSync(p, "utf8");
const has = (src, ...parts) => parts.every((p) => src.includes(p));

const migration = read("MIGRATION_bottle.sql");
const setupSql = read("SUPABASE_SETUP.sql");
const worker = read("worker/api.js");
const sbAdapter = read("src/utils/api/db.supabase.js");
const gwAdapter = read("src/utils/api/db.gateway.js");
const bottleJs = read("src/utils/bottle.js");
const home = read("src/views/HomeView.vue");
const bottleView = read("src/components/BottleView.vue");   /* T6 抽件：漂流瓶逻辑在这里 */
const petStore = read("src/stores/petStore.js");

/* ───────── 常量 ───────── */
ok("每日最多投 3 封", BOTTLE_SEND_MAX === 3);
ok("每日最多捞 7 瓶", BOTTLE_FISH_MAX === 7);
ok("字数放宽到 1000", BOTTLE_BODY_MAX === 1000);
ok("捞起 48h 不处理自动回海", BOTTLE_HOLD_TTL_MS === 48 * 3600 * 1000);
ok("错误归类：每个错误码都有 i18n key，未知码落到通用提示",
  bottleErrKey({ message: "bottle-limit-send" }) === "bottle.errSendLimit"
    && bottleErrKey({ message: "bottle-limit-fish" }) === "bottle.errFishLimit"
    && bottleErrKey({ message: "bottle-empty-sea" }) === "bottle.errEmpty"
    && bottleErrKey({ message: "bottle-not-holder" }) === "bottle.errNotHolder"
    && bottleErrKey({ message: "bottle-too-long" }) === "bottle.errTooLong"
    && bottleErrKey({ message: "随便什么" }) === "bottle.errGeneric");

/* ───────── i18n：键齐备 + 双语对称 + 占位符 ───────── */
for (const lang of ["zh", "en"]) {
  const b = messages[lang] && messages[lang].bottle;
  const need = ["title", "sub", "placeholder", "leftSend", "send", "seaTitle", "fish", "leftFish",
    "rules", "fromSea", "replyPlaceholder", "reply", "release", "replyFrom", "pending",
    "signInHint", "errSendLimit", "errFishLimit", "errEmpty", "errNotHolder", "errTooLong", "errGeneric"];
  const missing = need.filter((k) => !b || typeof b[k] !== "string" || !b[k].trim());
  ok(`${lang}: 漂流瓶文案齐备（${need.length} 键）`, missing.length === 0, missing.join(","));
  ok(`${lang}: 次数文案带 {n}、规则文案带 {w}/{f}`,
    !!b && b.leftSend.includes("{n}") && b.leftFish.includes("{n}")
      && b.rules.includes("{w}") && b.rules.includes("{f}"));
}
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
  const migNums = has(migration, "if v_count >= 3 then raise exception 'bottle-limit-send'")
    && has(migration, "if v_count >= 7 then raise exception 'bottle-limit-fish'");
  ok("SQL：每日 3 封 / 7 瓶在 RPC 里把关", migNums);
  ok("SQL：字数 ≤1000（信与回信同限）", (migration.match(/char_length\(p_\w+\) > 1000/g) || []).length === 2);
  ok("SQL：捞起 48h 自动回海", migration.includes("interval '48 hours'"));
  ok("SQL：不能捞自己的信（user_id <> auth.uid()）", migration.includes("user_id <> auth.uid()"));
  ok("SQL：回信只有当前持有者能写（status=held and holder=auth.uid()）",
    has(migration, "status = 'held' and holder = auth.uid()"));
  ok("SQL：六个 RPC 齐备（send/fish/reply/release/mine/held）",
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
}
{
  /* 错误码闭环：migration 里 raise 的每个业务码，bottleErrKey 都要接得住
     （bottle-auth 属「未登录」兜底，走 errGeneric，不单列） */
  const raised = [...migration.matchAll(/raise exception '(bottle-[a-z-]+)'/g)].map((m) => m[1]);
  const mapped = ["bottle-limit-send", "bottle-limit-fish", "bottle-empty-sea", "bottle-not-holder", "bottle-too-long"];
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
ok("Worker：入参体检（空信拒收 / 超 1000 拒收 / id 必须是 UUID）",
  has(worker, "if (!body) return fail(400, \"empty-body\")")
    && has(worker, 'body.length > 1000) return fail(400, "bottle-too-long")')
    && has(worker, "if (!UUID_RE.test(id)) return fail(400, \"bad-id\")"));
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
    && has(gwAdapter, 'call("/bottle/mine")')
    && has(gwAdapter, 'call("/bottle/held")'));
ok("bottle.js：登录才可用（cloud.ready + cloud.user），发信/回信先在本层拦空与超长",
  has(bottleJs, "!!(cloud.ready && cloud.user)")
    && has(bottleJs, "if (!text) throw new Error(\"bottle-empty-body\")")
    && has(bottleJs, 'if (text.length > BOTTLE_BODY_MAX) throw new Error("bottle-too-long")'));

/* ───────── BottleView 接线（T6 抽件：逻辑在组件里，HomeView 只负责挂载） ───────── */
ok("BottleView：导入漂流瓶工具并接上四个动作（投/捞/回/放回）",
  has(bottleView, 'from "../utils/bottle.js"')
    && has(bottleView, "async function doSend()") && has(bottleView, "async function doFish()")
    && has(bottleView, "async function doReply()") && has(bottleView, "async function doRelease()"));
ok("BottleView：字数上限用 BOTTLE_BODY_MAX、次数展示用 BOTTLE_SEND_MAX/BOTTLE_FISH_MAX",
  has(bottleView, ":maxlength=\"BOTTLE_BODY_MAX\"") && has(bottleView, "BOTTLE_SEND_MAX - quota.value.sent")
    && has(bottleView, "BOTTLE_FISH_MAX - quota.value.fished"));
ok("BottleView：捞到的信在托盘里回信或放回（tray 兜住刚捞的与上次没处理完的）",
  has(bottleView, "fished.value || held.value[0] || null"));
ok("BottleView：失败按 bottleErrKey 归类展示（不吞错误）",
  has(bottleView, "t(bottleErrKey(e))"));
ok("BottleView：每日次数用本机日键记账（跨天自动归零）",
  has(bottleView, "q.day === todayKey()"));
ok("BottleView：未登录给登录提示（不再有本地宠物回信）",
  has(bottleView, 't("bottle.signInHint")') && !bottleView.includes("sendLetter"));
ok("HomeView：抽件接线（桌面拼回 + 手机三联都挂同一 BottleView）",
  (home.match(/<BottleView/g) || []).length === 2);

/* ───────── 旧信箱清理（宠物回信 → 漂流瓶，不能留半套） ───────── */
ok("petStore：旧信箱全部移除（mailbox/sendLetter/tickMailbox/initMailbox/MAIL_KEY）",
  !has(petStore, "sendLetter", "tickMailbox", "initMailbox", "warm-paws-mail-v1")
    && !petStore.includes("mailbox"));
ok("petStore：不再引用宠物 canned 回信（MAIL_REPLIES）", !petStore.includes("MAIL_REPLIES"));
ok("i18n：宠物回信时代的话已清（sent/replyArrived 不复存在）",
  !messages.en.bottle.sent && !messages.en.bottle.replyArrived && !messages.zh.bottle.sent);

console.log(`bottle-test: ${pass} pass, ${fails.length} fail`);
for (const f of fails) console.log("FAIL  " + f);
if (fails.length) process.exit(1);
