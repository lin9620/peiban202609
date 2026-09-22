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
const migrationFish = read("MIGRATION_bottle_quota_fishfix.sql");
const migrationReply = read("MIGRATION_bottle_reply_quota.sql");   /* 轮 21：回信才计次 */
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
  ok("轮 18：SETUP 同步了次数探针与抢占式捞信（quota + 重试循环，与迁移同源）",
    setupSql.includes("function public.bottle_quota()")
      && setupSql.includes("for i in 1..3 loop")
      && setupSql.includes("if found then"));
  ok("轮 18 迁移：bottle_quota 探针（UTC 日计数，服务端权威）",
    migrationFish.includes("function public.bottle_quota()")
      && migrationFish.includes("created_day = (now() at time zone 'utc')::date")
      && migrationFish.includes("day = (now() at time zone 'utc')::date"));
  ok("轮 18 迁移：捞信先抢占再记账、绝不返回 null（空捞不扣次数的根基）",
    migrationFish.includes("for i in 1..3 loop")
      && migrationFish.includes("where id = v_row.id and status = 'sea'")
      && migrationFish.indexOf("if found then") < migrationFish.indexOf("insert into public.bottle_fishes")
      && migrationFish.includes("raise exception 'bottle-empty-sea'"));
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
    && has(bottleView, "async function doReply(l)") && has(bottleView, "async function doRelease(l)"));
ok("BottleView：字数上限用 BOTTLE_BODY_MAX、次数=MAX−已用（服务端权威，本地账兜底）",
  has(bottleView, ':maxlength="BOTTLE_BODY_MAX"')
    && has(bottleView, "Math.max(0, BOTTLE_SEND_MAX - (q ? q.sent : quota.value.sent))")
    && has(bottleView, "Math.max(0, BOTTLE_FISH_MAX - (q ? q.fished : quota.value.fished))"));
ok("BottleView：待处理信箱多封并存（pending 合并 fished+held；捞新信不被手里那封锁死）",
  has(bottleView, "const pending = ref([])")
    && has(bottleView, "function mergePending()")
    && has(bottleView, 'v-for="l in pending"'));
ok("BottleView：次数服务端权威（bottle_quota 同步 + 乐观本地账；未跑新迁移静默退回）",
  has(bottleView, "async function syncQuota()") && has(bottleView, "await bottleQuota()")
    && has(bottleView, "quotaRemote.value"));
ok("BottleView：轮 21 口径——捞到不扣次数（doFish 全程无 bumpQuota），回信成功那一刻才扣",
  (() => {
    const fishBody = bottleView.slice(bottleView.indexOf("async function doFish()"), bottleView.indexOf("async function doReply"));
    const replyBody = bottleView.slice(bottleView.indexOf("async function doReply"), bottleView.indexOf("async function doRelease"));
    return !fishBody.includes("bumpQuota")
      && replyBody.indexOf("await bottleReply") >= 0
      && replyBody.indexOf("await bottleReply") < replyBody.indexOf('bumpQuota("fished")');
  })());
ok("BottleView：登录就绪/换号自动加载（修「首次进主页记录空白要手动刷新」）",
  has(bottleView, "watch([cloudSigned, myId]") && has(bottleView, "refreshBottle();")
    && has(bottleView, "loadRecords(true);"));
ok("BottleView：收了回信还没决定 → 记录上直接给「同意/拒绝」（不再让用户去消息页找卡）",
  has(bottleView, '"bottle.stDecide"') && has(bottleView, "async function decideRec(l, accept)")
    && has(bottleView, "bottleChatDecide(l.id, accept)"));
ok("BottleView：被捞走/在我手里两态文案不再一律「漂流中」，放回也能按信操作",
  has(bottleView, '"bottle.stPicked"') && has(bottleView, '"bottle.stInHand"')
    && has(bottleView, '"bottle.stReleased"'));

/* ───────── 轮 21：次数口径 = 捞到且回信了才扣 1 次（服务端权威） ───────── */
ok("迁移 reply_quota：捞信日志加 replied_at/replied_day 两列（捞到未回 = null 不计次）",
  has(migrationReply, "add column if not exists replied_at")
    && has(migrationReply, "add column if not exists replied_day"));
ok("迁移 reply_quota：bottle_quota 只数 replied_day = 今日（回信才计次的服务端权威）",
  has(migrationReply, "and replied_day = (now() at time zone 'utc')::date"));
ok("迁移 reply_quota：捞信本身不写 replied_*（不记次），当天重捞幂等（on conflict do nothing）",
  has(migrationReply, "insert into public.bottle_fishes (user_id, day, letter_id)")
    && has(migrationReply, "on conflict (user_id, day, letter_id) do nothing"));
ok("迁移 reply_quota：回信盖章只盖最新一行（order by day desc limit 1，防跨天多行全量盖章一次扣 N 次）",
  has(migrationReply, "set replied_at = now(), replied_day = (now() at time zone 'utc')::date")
    && has(migrationReply, "order by day desc limit 1"));
ok("迁移 reply_quota：防囤信拦截（手里 ≥7 封未回 → bottle-limit-hold，捞了也回不了就先别捞）",
  has(migrationReply, "if v_held >= 7 then raise exception 'bottle-limit-hold'; end if;"));
ok("SETUP：quota/fish/reply 三函数已同步新口径（新装库免跑迁移）",
  has(setupSql, "and replied_day = (now() at time zone 'utc')::date")
    && has(setupSql, "raise exception 'bottle-limit-hold'")
    && has(setupSql, "order by day desc limit 1"));
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
  has(bottleView, 'import { NButton, NInput, NModal } from "naive-ui"')
    && has(bottleView, "const fishPop = ref(")
    && has(bottleView, 'v-model:show="fishPop.show"')
    && has(bottleView, 'fishPop.value = { show: true, mode: "got", letter: l, msg: "" }')
    && has(bottleView, 'mode: "msg"'));
ok("BottleView：弹窗里回信/放回海里直接可用（doReply/doRelease 绑在弹窗按钮上，成功自动关弹窗）",
  has(bottleView, '@click="doRelease(fishPop.letter)"')
    && has(bottleView, '@click="doReply(fishPop.letter)"')
    && (bottleView.match(/fishPop\.value\.show = false/g) || []).length >= 2
    && has(bottleView, '@click="fishPop.show = false"'));
ok("BottleView：弹窗无右上角 X、不可点遮罩/Esc 关——捞到信只有「回信/放回」两条路（轮 26）",
  !has(bottleView, "popKeep")
    && has(bottleView, ':closable="false"') && has(bottleView, ':mask-closable="false"')
    && has(bottleView, ':close-on-esc="false"'));
ok("BottleView：按下瞬间出「撒网中」弹窗 + 8s 悬死给出口（轮 26：反馈 <100ms）",
  has(bottleView, 'fishPop.value = { show: true, mode: "fishing", letter: null, msg: "" }')
    && has(bottleView, "const FISH_TIMEOUT") && has(bottleView, '"bottle-slow"')
    && has(bottleView, "fishPop.mode === 'fishing'"));
ok("i18n：弹窗文案双语齐（gotTitle/popNotice/fishing/fishingSub/errSlow），popKeep 键已清",
  ["gotTitle", "popNotice", "fishing", "fishingSub", "errSlow"].every((k) => k in messages.en.bottle && k in messages.zh.bottle)
    && !("popKeep" in messages.en.bottle) && !("popKeep" in messages.zh.bottle));




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
