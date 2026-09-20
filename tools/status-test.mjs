/* 陪你大厅状态（#4 状态上云）规则层单测（纯函数 + i18n 键 + 前后端契约 + 迁移覆盖）
 * ------------------------------------------------------------
 * 为什么这些断言值得写：
 *  1. 四个状态 key 是「前端按钮 → Worker 白名单 → profiles.status → 大厅流」的
 *     全链路主键，前后端名单一旦漂移，用户点了状态会被 400 挡掉却看不出原因；
 *  2. 24h 新鲜窗口有两个实现（前端 statusFresh 过滤展示、Worker status_at=gte 过滤查询），
 *     阈值必须齐平，否则会出现「大厅列了 TA 但点进主页没有徽章」这类不一致；
 *  3. emoji 只在 i18n 文案里（与心情打卡同一惯例）—— 模板若再拼一次就成了
 *     「 工作中 💻」，这类重复只有靠源码断言钉住；
 *  4. 未跑迁移时整条链路必须优雅降级（写失败提示「功能没开启」、流不渲染），
 *     所以 getProfile/setStatus 的老库兼容分支与 README 的降级说明都要在。
 * 运行：node tools/status-test.mjs
 */
import fs from "node:fs";
import { STATUS_KEYS, STATUS_WINDOW_MS, statusFresh } from "../src/utils/statuses.js";
import { messages } from "../src/i18n.js";

let pass = 0;
const fails = [];
function ok(name, cond, extra = "") {
  if (cond) pass++;
  else fails.push(name + (extra ? ` —— ${extra}` : ""));
}
const read = (p) => fs.readFileSync(p, "utf8");
const has = (src, ...parts) => parts.every((p) => src.includes(p));
const home = read("src/views/HomeView.vue");
const todayPane = read("src/components/TodayPane.vue");   /* T6 抽件：大厅/打卡/主视觉在这里 */
const wallerView = read("src/views/WallerView.vue");
const wall = read("src/utils/wall.js");
const api = read("worker/api.js");
const sbAdapter = read("src/utils/api/db.supabase.js");
const gwAdapter = read("src/utils/api/db.gateway.js");
const migration = read("MIGRATION_profile_status.sql");
const setupSql = read("SUPABASE_SETUP.sql");
const readme = read("README.md");

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u;

/* ───────── 常量与新鲜窗口纯函数 ───────── */
ok("四个状态 key 固定且顺序稳定",
  JSON.stringify(STATUS_KEYS) === JSON.stringify(["working", "studying", "sleepless", "chilling"]),
  JSON.stringify(STATUS_KEYS));
ok("新鲜窗口 = 24 小时", STATUS_WINDOW_MS === 24 * 60 * 60 * 1000, String(STATUS_WINDOW_MS));
ok("statusFresh：刚设置算新鲜", statusFresh(new Date().toISOString()) === true);
ok("statusFresh：23 小时前仍新鲜", statusFresh(new Date(Date.now() - 23 * 3600 * 1000).toISOString()) === true);
ok("statusFresh：24 小时零 1 秒前已过期（边界不含糊）",
  statusFresh(new Date(Date.now() - (24 * 3600 * 1000 + 1000)).toISOString()) === false);
ok("statusFresh：空/非法值都当过期（不抛错）",
  statusFresh("") === false && statusFresh(null) === false && statusFresh(undefined) === false && statusFresh("昨天") === false);
ok("statuses.js 不再导出 emoji 映射（emoji 归 i18n 文案，避免模板重复拼）",
  !read("src/utils/statuses.js").includes("STATUS_EMOJI"));

/* ───────── i18n：四个状态 + 大厅流文案，中英对称 ───────── */
for (const lang of ["zh", "en"]) {
  const c = messages[lang] && messages[lang].home && messages[lang].home.companions;
  ok(`${lang}: home.companions 四键文案齐备`, !!c && STATUS_KEYS.every((k) => typeof c[k] === "string" && c[k].trim()));
  ok(`${lang}: 每条状态文案自带 emoji（模板不再拼）`,
    !!c && STATUS_KEYS.every((k) => EMOJI_RE.test(c[k])), c ? JSON.stringify(STATUS_KEYS.map((k) => c[k])) : "");
  ok(`${lang}: 四条文案互不相同（防复制粘贴错文案）`,
    !!c && new Set(STATUS_KEYS.map((k) => c[k])).size === STATUS_KEYS.length);
  const keys = ["title", "choose", "youSet", "othersTitle", "anon", "loginHint", "syncFail", "syncNeedSetup", "agoMin", "agoHour"];
  ok(`${lang}: 大厅区块文案齐备（标题/在做什么/你在这里/此刻大厅里/匿名/登录提示/两条错误/相对时间）`,
    !!c && keys.every((k) => typeof c[k] === "string" && c[k].trim()),
    (c ? keys.filter((k) => typeof c[k] !== "string") : keys).join(","));
  ok(`${lang}: 未跑迁移的提示与同步失败是两句话（不能混用一句）`,
    !!c && c.syncNeedSetup !== c.syncFail);
}
/* 视图里写的字面 key 必须真存在 —— 防「模板写错键名、线上直接显示原始 key」
 * （T6 抽件：home.companions.* 的引用在 TodayPane + WallerView 两个视图） */
{
  const at = (o, p) => p.split(".").reduce((a, k) => (a == null ? a : a[k]), o);
  const used = [...(todayPane + wallerView).matchAll(/["'](home\.companions\.[A-Za-z0-9_]+)["']/g)].map((m) => m[1]);
  const bad = [...new Set(used)].filter((k) =>
    typeof at(messages.zh, k) !== "string" || typeof at(messages.en, k) !== "string");
  ok("两个视图引用的 home.companions.* 字面 key 全部存在（zh+en）", used.length >= 9 && bad.length === 0,
    bad.join(",") || `${used.length} 处引用全命中`);
}

/* ───────── 模板：不再重复 emoji，按钮/药丸直接用文案（T6 抽件后扫 TodayPane） ───────── */
ok("TodayPane 模板不再引用 emoji 映射/硬拼 emoji",
  !todayPane.includes("STATUS_EMOJI") && has(todayPane, '{{ t("home.companions." + k) }}'));
ok("大厅只渲染状态人数，不渲染个人昵称或个人列表",
  has(todayPane, "{{ statusLabel(row.status) }}", 't("home.companions.peopleCount", { n: row.count })')
    && !todayPane.includes("o.nickname") && !todayPane.includes("cloudFetchStatuses"));
ok("主页徽章同样只输出 statusLabel",
  has(wallerView, "{{ statusLabel(profStatus) }}") && !wallerView.includes("STATUS_EMOJI"));

/* ───────── 前端 ↔ Worker 契约（key 名单 / 时间戳归属 / 查询口径） ───────── */
{
  const m = api.match(/VALID_STATUS\s*=\s*new Set\(\[([^\]]*)\]\)/);
  const backendKeys = m ? m[1].split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean) : [];
  ok("前后端状态 key 名单完全一致（含顺序）", JSON.stringify(backendKeys) === JSON.stringify(STATUS_KEYS),
    `FE=${JSON.stringify(STATUS_KEYS)} BE=${JSON.stringify(backendKeys)}`);
}
ok("Worker 对白名单外的 key 回 400 bad-status（不是静默写入）",
  has(api, 'if (!(status === null || VALID_STATUS.has(status))) return fail(400, "bad-status")'));
ok("Worker 时间戳由服务端盖（客户端只送 status，改不了自己「几分钟前」）",
  has(api, "status, status_at: new Date().toISOString()"));
ok("Worker 路由：PATCH /users/:id/status（uid 必须合法）",
  has(api, 'if (seg[2] === "status" && m === "PATCH")') && has(api, 'if (!uid) return fail(400, "bad-id")'));
ok("Worker 路由：GET /statuses（匿名可读的大厅流）",
  has(api, 'if (seg[0] === "statuses" && seg.length === 1 && m === "GET")'));
ok("大厅流查询口径：四列 + status 非空 + 时间倒序 + limit",
  has(api, '"id,nickname,status,status_at"', '"status=not.is.null"', '"order=status_at.desc"', "limit=${limit}"));
ok("大厅流支持 since 时间窗（前端 24h 由它落地）", has(api, "if (since) parts.push(`status_at=gte."));
ok("老库未跑迁移：getProfile 退回两列查询（页面不因缺列而空白）",
  has(api, 'let res = await attempt("nickname,created_at,status,status_at")')
    && has(api, 'res = await attempt("nickname,created_at")'));

/* ───────── 两条数据链路（直连 Supabase / 走 Worker）都要实现 ───────── */
ok("supabase getProfile：先带状态列，缺列时退回两列",
  has(sbAdapter, 'select("nickname,created_at,status,status_at")')
    && has(sbAdapter, 'select("nickname,created_at")'));
ok("supabase setStatus：只写 status/status_at，且状态可为 null（清除）",
  has(sbAdapter, "update({ status, status_at: new Date().toISOString() })"));
ok("supabase listRecentStatuses：非空 + gte(since) + 倒序 + limit",
  has(sbAdapter, '.not("status", "is", null)', '.gte("status_at", since)', '{ ascending: false }', ".limit(limit)"));
ok("gateway setStatus：PATCH /users/:id/status，body 只带 status",
  has(gwAdapter, "`/users/${enc(userId)}/status`", '{ method: "PATCH", body: { status } }'));
ok("gateway listRecentStatuses：limit 与 since 都传给 Worker",
  has(gwAdapter, "`/statuses?limit=${enc(limit)}&since=${enc(since)}`"));
ok("gateway getProfile：/users/:id/profile", has(gwAdapter, "`/users/${enc(userId)}/profile`"));

/* ───────── wall.js 云封装：降级与错误归类 ───────── */
ok("cloudSetStatus：失败时记录 cloud.error（调用方用 errorKind 分类提示）并返回 false",
  has(wall, "cloud.error = e && e.message ? e.message : String(e)"));
ok("cloudFetchStatuses：默认窗口取 STATUS_WINDOW_MS，并把 since 算好传给数据层",
  has(wall, "windowMs = STATUS_WINDOW_MS")
    && has(wall, "new Date(Date.now() - windowMs).toISOString()"));
ok("cloudFetchStatuses：失败返回 null（调用方据此不渲染大厅流）",
  /cloudFetchStatuses[\s\S]{0,400}catch[\s\S]{0,200}return null;/.test(wall));
ok("cloudFetchProfile：档案行不存在时给空档案兜底（status/status_at 为 null）",
  has(wall, 'return data || { nickname: "", created_at: null, status: null, status_at: null }'));

/* ───────── 迁移与文档 ───────── */
ok("迁移幂等：add column if not exists 两列 + status_at desc 索引",
  has(migration, "add column if not exists status    text")
    && has(migration, "add column if not exists status_at timestamptz")
    && has(migration, "profiles_status_at_idx on public.profiles (status_at desc)"));
ok("迁移带列注释（说明 null 语义与 24h 窗口）",
  has(migration, "comment on column public.profiles.status is") && has(migration, "comment on column public.profiles.status_at is"));
ok("SUPABASE_SETUP.sql 同步了两列与索引（新装库不用另跑迁移）",
  has(setupSql, "status     text", "status_at  timestamptz")
    && has(setupSql, "profiles_status_at_idx on public.profiles (status_at desc)"));
ok("README 登记迁移文件并写清未跑时的降级行为",
  readme.includes("MIGRATION_profile_status.sql") && readme.includes("只存本机") && readme.includes("此刻大厅里"));

/* ───────── 视图接线（T6 抽件：大厅/状态逻辑在 TodayPane，HomeView 只负责挂载） ───────── */
ok("TodayPane：登录才上云，写失败按 errorKind 区分「未开启」与「同步失败」",
  has(todayPane, "if (isMember.value && !(await cloudSetStatus(next || null)))")
    && has(todayPane, 'errorKind(cloud.error) === "not-migrated" ? "setup" : "sync"'));
ok("TodayPane：再点一次同一状态即清除（本地与云端一起清）",
  has(todayPane, 'const next = myStatus.value === k ? "" : k')
    && has(todayPane, 'if (next) setItem("wp-status", next);') && has(todayPane, "removeItem(\"wp-status\")"));
ok("TodayPane：单独读取自己的档案，状态更新后刷新人数",
  has(todayPane, "await cloudFetchProfile(uid)", "await refreshStatusCounts()", "revision !== statusRevision"));
ok("TodayPane：云端不可用时不伪造人数，也不覆盖本机状态",
  has(todayPane, 'v-if="statusCounts"', "if (!profile ||", "if (!uid || !cloud.ready) return;"));
ok("HomeView：抽件接线（桌面拼回 + 手机三联都挂同一 TodayPane）",
  (home.match(/<TodayPane/g) || []).length === 2);
ok("WallerView：徽章只在 24h 内新鲜时显示（与大厅同一规则）",
  has(wallerView, "statusFresh(p.status_at)") && has(wallerView, "return p && p.status && statusFresh(p.status_at) ? p.status : \"\";"));

console.log(`status-test: ${pass} pass, ${fails.length} fail`);
for (const f of fails) console.log("FAIL  " + f);
if (fails.length) process.exit(1);