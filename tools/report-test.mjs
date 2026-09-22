/* 举报 / 审核 / 拉黑契约测试（轮 33；纯 Node，SQL 契约 + 双模式适配器 + 前端接线 + 纯函数）
 *   node tools/report-test.mjs
 * 覆盖：迁移与 SETUP 同源（reports 表 / 评论 hidden / 三 RPC / 下架复核 / 红点统计）
 *       · Worker 路由白名单 · db 双模式成对 · 错误码↔i18n 闭环 · 通知 reportDone 分支
 *       · userBlocks 过滤与换域重置 · 前端三视图接线（举报入口 / 拉黑过滤 / 管理页签）
 * 说明：SQL 行为（阈值自动隐藏、防刷）无法离线跑 Postgres，行为契约以「文件同源断言」锁形；
 *       上线后由「用户执行迁移 + 线上探针」闭环（见 jiaojie.md 交付流程）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";

let pass = 0;
const fails = [];
function ok(name, cond, extra = "") {
  if (cond) pass++;
  else fails.push(name + (extra ? ` —— ${extra}` : ""));
}
const read = (p) => fs.readFileSync(new URL("../" + p, import.meta.url), "utf8");
const has = (src, ...parts) => parts.every((p) => src.includes(p));

const migration = read("MIGRATION_reports.sql");
const setupSql = read("SUPABASE_SETUP.sql");
const worker = read("worker/api.js");
const sbAdapter = read("src/utils/api/db.supabase.js");
const gwAdapter = read("src/utils/api/db.gateway.js");
const i18n = read("src/i18n.js");
const reportDialog = read("src/components/ReportDialog.vue");
const userBlocks = read("src/utils/userBlocks.js");
const community = read("src/views/CommunityView.vue");
const postDetail = read("src/views/PostDetailView.vue");
const waller = read("src/views/WallerView.vue");
const admin = read("src/views/AdminView.vue");
const notifyRules = read("src/utils/notifyRules.js");

/* ───────── 1) 迁移文件契约 ───────── */
ok("reports 表存在且 target_type 只收 post/comment",
  has(migration, "create table if not exists public.reports", "target_type in ('post','comment')"));
ok("同人同目标唯一（partial unique，系统条目不受限）",
  has(migration, "reports_reporter_target_uniq", "where reporter_id is not null"));
ok("同一目标待复核只排一次",
  has(migration, "reports_auto_pending_uniq", "where source = 'auto' and status = 'pending'"));
ok("RLS：本人或管理员可读；直连写入被拒（无 insert 策略）",
  has(migration, "alter table public.reports enable row level security",
    "reporter_id = auth.uid() or is_admin()"));
ok("评论 hidden 列 + 读策略升级（作者/管理员例外）",
  has(migration, "add column if not exists hidden", "hidden = false or user_id = auth.uid() or is_admin()"));
ok("report_create 存在且 revoke anon（authenticated 才能举报）",
  has(migration, "create or replace function public.report_create",
    "revoke all on function public.report_create(text, bigint, text, text) from public, anon"));
ok("report_create 防刷：每人每日 10 条 + 同目标幂等去重",
  has(migration, ">= 10 then", "on conflict do nothing"));
ok("评论 ≥3 人举报自动隐藏，且只自动隐藏一次（恢复后交人工）",
  has(migration, "rr.target_id = wc.id) >= 3", "wc.hidden_at is null"));
ok("帖子不因举报数下架（拍板口径：仅厌恶阈值下架）",
  !migration.includes("target_type = 'post' then") || !has(migration, "post 报告阈值"));
ok("admin_report_page：pending/handled 两档 + 聚合人数 + 内容丢失标记",
  has(migration, "create or replace function public.admin_report_page",
    "'pending','handled'", "content_gone", "'reporters'"));
ok("admin_report_handle：五动作 + 幂等 + 处理后给举报人发 system 通知",
  has(migration, "create or replace function public.admin_report_handle",
    "'dismiss','remove_post','restore_post','delete_comment','unhide_comment'",
    "already", "report_handled"));
ok("厌恶下架进待复核队列（source=auto，无举报人）",
  has(migration, "values (null, 'post', p_post, 'auto', 'auto')"));

/* ───────── 2) SUPABASE_SETUP.sql 同步（新装库 = 完整真相源，坑 #6） ───────── */
for (const piece of [
  "create table if not exists public.reports",
  "create or replace function public.report_create",
  "create or replace function public.admin_report_page",
  "create or replace function public.admin_report_handle",
  "reports_auto_pending_uniq",
  "comments readable unless hidden",
  "values (null, 'post', p_post, 'auto', 'auto')",
  "'reports_pending'",
]) {
  ok("SETUP 同步：" + piece.slice(0, 40), setupSql.includes(piece));
}
ok("SETUP 的 admin_overview 与 wall_toggle_dislike 只保留一份定义（不制造双份真相）",
  (setupSql.match(/create or replace function public\.admin_overview\(\)/g) || []).length === 1
  && (setupSql.match(/create or replace function public\.wall_toggle_dislike\(p_post bigint\)/g) || []).length === 1);

/* ───────── 3) Worker 白名单（路由即文档） ───────── */
ok("Worker：POST /api/reports → report_create（参数透传）",
  has(worker, 'seg[0] === "reports" && seg.length === 1 && m === "POST"',
    '"report_create"', "p_target_type", "p_target_id", "p_reason", "p_detail"));
ok("Worker：GET /api/admin/reports?status= → admin_report_page",
  has(worker, 'seg[1] === "reports" && seg.length === 2 && m === "GET"',
    '"admin_report_page"', "p_status", "p_offset", "p_limit"));
ok("Worker：POST /api/admin/reports/:id/handle → admin_report_handle",
  has(worker, 'seg[3] === "handle" && m === "POST"', '"admin_report_handle"', "p_report", "p_action", "p_note"));

/* ───────── 4) db 双模式成对（0.2 铁律） ───────── */
ok("直连模式：reportCreate / adminReportPage / adminReportHandle 走 RPC",
  has(sbAdapter, 'rpc("report_create"', 'rpc("admin_report_page"', 'rpc("admin_report_handle"'));
ok("网关模式：同名方法走 /api/reports 与 /api/admin/reports*",
  has(gwAdapter, 'call("/reports", { method: "POST"', "`/admin/reports?status=", "/handle`"));
ok("两模式方法名一一对应（成对改，不许只改一头）",
  ["reportCreate(", "adminReportPage(", "adminReportHandle("]
    .every((m) => sbAdapter.includes(m) && gwAdapter.includes(m)));

/* ───────── 5) 错误码 ↔ i18n 闭环（坑 #14：PGRST202 判迁移未跑） ───────── */
const errPairs = [
  ["report-limit", "report.errLimit"], ["auth-required", "report.signIn"], ["target-gone", "report.errGone"],
];
for (const [code, key] of errPairs) {
  ok(`错误码 ${code} → ${key}`, reportDialog.includes(`m.includes("${code}")`) && reportDialog.includes(key));
}
ok("PGRST202 → 「功能还没开启」提示（区分函数缺失与权限拒绝）",
  has(reportDialog, "PGRST202", "report.errNotOpen"));
/* 原因枚举与关键文案「双语都真的有」（键的 zh/en 全量对称由 i18n-test 兜底） */
const bilingual = [
  ["Report this content", "举报这条内容"],
  ["Send report", "提交举报"],
  ["Spam or ads", "垃圾营销"], ["Harassment or abuse", "辱骂攻击"], ["Sexual content", "色情低俗"],
  ["Illegal", "违法违规"], ["Misinformation", "不实信息"], ["Other", "其他"],
  ["Tap again to confirm", "再点一次确认拉黑"], ["Unblock", "取消拉黑"],
  ["You blocked", "你拉黑了作者"],
  ["Pending", "待处理"], ["Take down", "下架帖子"], ["Restore post", "恢复帖子"],
  ["Delete comment", "删除评论"], ["Restore comment", "恢复评论"],
];
for (const [en, zh] of bilingual) ok(`双语成对：${en} / ${zh}`, i18n.includes(en) && i18n.includes(zh), en);

/* ───────── 6) 通知：处理结果走独立文案（notifyRules 纯函数真跑） ───────── */
const { itemView } = await import("../src/utils/notifyRules.js");
ok("system + event=report_handled → notif.reportDone",
  itemView({ id: 1, kind: "system", meta: { event: "report_handled" } }).key === "notif.reportDone");
ok("system 公告（无 event）仍是 notif.system",
  itemView({ id: 1, kind: "system", meta: { body: "公告" } }).key === "notif.system");

/* ───────── 7) userBlocks：过滤纯函数 + 换域重置（真跑，见第 9 节 T7） ───────── */
const ub = await import("../src/utils/userBlocks.js");
ub.blockState.ids = ["u-blocked-1", "u-blocked-2"];
ok("isBlocked 命中/未命中", ub.isBlocked("u-blocked-1") && !ub.isBlocked("u-ok"));
ok("filterBlocked 剔除被拉黑作者的行，空名单放行",
  ub.filterBlocked([{ userId: "u-blocked-1" }, { userId: "u-ok" }]).length === 1
  && (() => { const keep = ub.blockState.ids; ub.blockState.ids = []; const r = ub.filterBlocked([{ userId: "u-blocked-1" }]).length; ub.blockState.ids = keep; return r === 1; })());
ok("userBlocks 注册了换域 reload（换号不把 A 的名单带到 B）",
  userBlocks.includes("onScopeSwitch") && userBlocks.includes("blockState.loaded = false"));

/* ───────── 8) 前端接线（三个视图 + 管理端） ───────── */
ok("CommunityView：举报入口（帖/评）+ 弹窗挂载 + 拉黑过滤",
  has(community, "canReportPost(p)", "canReportCmt(cm)", "openReportCmt", "<ReportDialog", "filterBlocked(box.rows)", "filterBlocked(rows)"));
ok("举报入口对游客可见（canReport 不依赖 signedIn；登录要求收进弹窗）",
  !/canReportPost = \(p\) => .*signedIn/.test(community) && !/canReportCmt = \(cm\) => .*signedIn/.test(community)
  && !/canReportPost = \(\) => .*signedIn/.test(postDetail) && !/canReportCmt = \(cm\) => .*signedIn/.test(postDetail)
  && reportDialog.includes('t("report.signIn")'));
ok("PostDetailView：帖子/评论举报 + 作者被拉黑隐藏正文",
  has(postDetail, "openReportPost", "canReportCmt(cm)", "authorBlocked", "<ReportDialog", "filterBlocked(rows)"));
ok("WallerView：拉黑两步确认 + 撤销 + 名单刷新",
  has(waller, "blockArm", "toggleBlock", "blockUser(uid)", "unblockUser(uid)", "refreshBlocks()"));
ok("AdminView：举报页签（待处理/已处理）+ 红点 + 处理动作",
  has(admin, "'overview', 'posts', 'comments', 'reports'", "switchRepTab('pending')", "switchRepTab('handled')",
    "admin-tab-dot", "handleReport(r, 'remove_post')", "handleReport(r, 'unhide_comment')", "pendingReports > 0"));
ok("管理端待处理计数来自 admin_overview 的 reports_pending",
  has(admin, "ov.value && ov.value.reports_pending"));

/* ───────── 8b) 消息页拉黑管理走 userBlocks（轮 34：名单与内容过滤同一份缓存） ───────── */
const messages = read("src/views/MessagesView.vue");
ok("MessagesView：拉黑/解除走 userBlocks 包装（不再直调 dmApi.block/unblock）",
  has(messages, "blockUser(c.other_id)", "unblockUser(c.other_id)", "unblockUser(b.user_id)")
  && !/dmApi\.(block|unblock)\(/.test(messages));
ok("MessagesView：进页同步拉黑名单 + 拉黑提示升级为全站口径（文案在 i18n）",
  has(messages, "refreshBlocks()")
  && i18n.includes("TA 在暖心墙的帖子/评论也会对你隐藏")
  && i18n.includes("their posts & comments on the wall are hidden from you"));

/* ───────── 9) T7 场景真跑（userScope 换域 → userBlocks reload） ───────── */
{
  const { setUserScope } = await import("../src/utils/userScope.js");
  ub.blockState.ids = ["u-blocked-1"];
  ub.blockState.loaded = true;
  setUserScope("uid-t7");          // 换域 → flush/reload → userBlocks 重读快照
  const cleared = ub.blockState.ids.length === 0 && ub.blockState.loaded === false;
  setUserScope("");                // 回 guest，测试隔离
  ok("换号后拉黑名单重读新域（不把 A 的名单带到 B）", cleared);
}

console.log(`\nreport-test: ${pass} pass, ${fails.length} fail`);
for (const f of fails) console.log("  FAIL  " + f);
process.exit(fails.length ? 1 : 0);
