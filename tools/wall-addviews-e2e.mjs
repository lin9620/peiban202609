/* 批量记浏览线上实测（Node 直跑，不打浏览器）：node tools/wall-addviews-e2e.mjs
 * ------------------------------------------------------------
 * 为什么要有：`wall_add_views`（轮 302）是「20 次 wall_add_view 合成 1 次」的合并版，
 * 合并最怕的是**口径悄悄变了**（少计、多计、去重失效）。这个脚本用**两个不同的新访客**
 * 分别走「批量」与「逐帖」两条路，逐格对账 —— 两条路对同一帖的计数差必须恰好等于其中
 * 一条多记的那 1 次；再验「同一访客第二次不再 +1」（去重）与「帖不存在单条降级」。
 *
 * ⚠ 会真的 +浏览数（wall_post_views 没有 delete 策略，删不掉）：只挑最新 2 条帖、
 *   每个访客各 +1。介意的话跑完按脚本末尾提示的 SQL 手动删两行。
 *
 * 迁移未跑时输出 MIGRATION_MISSING 并退出码 2（此时前端会自动退回逐帖，功能不受影响）。
 */
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = fs.readFileSync(path.join(root, ".env"), "utf8");
const get = (k) => { const m = env.match(new RegExp("^\\s*" + k + "\\s*=\\s*(\\S+)\\s*$", "m")); return m ? m[1] : ""; };
const URL = get("VITE_SUPABASE_URL"), KEY = get("VITE_SUPABASE_ANON_KEY");
if (!URL || !KEY) { console.log("FAIL  .env 缺 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY"); process.exit(1); }

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => {
  if (c) { pass++; console.log("PASS  " + n + (extra ? "  " + extra : "")); }
  else { fail++; console.log("FAIL  " + n + (extra ? "  " + extra : "")); }
};

const sb = createClient(URL, KEY, { auth: { persistSession: false } });
const stamp = Date.now();
const viewerBatch = "e2e-batch-" + stamp;      /* 走批量 */
const viewerPerPost = "e2e-single-" + stamp;   /* 走逐帖（对照组） */
const BOGUS = 999999999;                        /* 不存在的帖 id */

/* 先探函数在不在（迁移没跑时 PostgREST 直接 PGRST202） */
const probe = await sb.rpc("wall_add_views", { p_posts: [], p_viewer: viewerBatch });
if (probe.error) {
  const code = String(probe.error.code || "");
  if (code === "PGRST202" || code === "42883" || /could not find the function/i.test(probe.error.message || "")) {
    console.log("MIGRATION_MISSING  wall_add_views 还没建 —— 请执行 MIGRATION_wall_add_views.sql。");
    console.log("                   （没跑也不影响线上：前端与 Worker 会自动退回逐帖 wall_add_view）");
    process.exit(2);
  }
  console.log("FAIL  探测失败：" + probe.error.message + " (" + code + ")");
  process.exit(1);
}
ok("T1 空数组调用安全（返回 ok:true / results 空）",
  probe.data && probe.data.ok === true && Array.isArray(probe.data.results) && probe.data.results.length === 0,
  JSON.stringify(probe.data));

/* 挑两条真实帖 */
const { data: posts, error: postErr } = await sb.from("wall_posts").select("id,views").eq("removed", false).order("created_at", { ascending: false }).limit(2);
if (postErr || !posts || posts.length < 2) {
  console.log("FAIL  取不到两条在架帖：" + (postErr ? postErr.message : "条数不足"));
  process.exit(1);
}
const [A, B] = posts;
console.log("      对账帖子：" + A.id + " / " + B.id);

/* T2 批量：两个真实帖 + 一个不存在的帖 */
const batch = await sb.rpc("wall_add_views", { p_posts: [A.id, B.id, BOGUS, A.id], p_viewer: viewerBatch });
ok("T2 批量返回 ok:true 且 results 为数组", !batch.error && batch.data && batch.data.ok === true && Array.isArray(batch.data.results),
  batch.error ? batch.error.message : JSON.stringify(batch.data));
const results = (batch.data && batch.data.results) || [];
const byId = new Map(results.map((r) => [Number(r.post), r]));
ok("T3 重复 id 只处理一次（去重）", results.length === 3, "results 长度 " + results.length);
ok("T4 存在的帖 counted:true（新访客第一次）", byId.get(A.id) && byId.get(A.id).ok === true && byId.get(A.id).counted === true, JSON.stringify(byId.get(A.id)));
ok("T5 不存在的帖单条降级 not-found（整体仍成功）",
  byId.get(BOGUS) && byId.get(BOGUS).ok === false && byId.get(BOGUS).reason === "not-found", JSON.stringify(byId.get(BOGUS)));
ok("T6 返回 views/dislikes/removed 三件套齐全",
  byId.get(A.id) && Number.isSafeInteger(Number(byId.get(A.id).views)) && byId.get(A.id).dislikes != null && typeof byId.get(A.id).removed === "boolean");
const afterBatchA = Number(byId.get(A.id).views);

/* T7 去重：同一访客第二次调用不再 +1 */
const again = await sb.rpc("wall_add_views", { p_posts: [A.id], p_viewer: viewerBatch });
const againA = Number(((again.data && again.data.results) || [{}])[0].views);
ok("T7 同一访客同日第二次不再计入（counted:false、views 不变）",
  again.data && again.data.results[0].counted === false && againA === afterBatchA,
  "counted=" + (again.data && again.data.results[0].counted) + " views " + afterBatchA + "→" + againA);

/* T8 对照：逐帖版（另一个新访客）—— 因为批量那次已经 +1，逐帖这次应恰好多 1 */
const singleA = await sb.rpc("wall_add_view", { p_post: A.id, p_viewer: viewerPerPost });
const singleB = await sb.rpc("wall_add_view", { p_post: B.id, p_viewer: viewerPerPost });
ok("T8 逐帖版同一访客也 counted:true", singleA.data && singleA.data.ok === true && singleA.data.counted === true, JSON.stringify(singleA.data));
ok("T9 批量 ↔ 逐帖逐格对账（views 差恰好 = 中间那一次）",
  Number(singleA.data.views) === afterBatchA + 1,
  "批量后 " + afterBatchA + " → 逐帖后 " + Number(singleA.data.views));
ok("T10 两条帖都记上了（不是只记了第一条）", singleB.data && singleB.data.ok === true && singleB.data.counted === true);
ok("T11 帖不存在时逐帖版回 not-found（与批量单条口径一致）",
  (await sb.rpc("wall_add_view", { p_post: BOGUS, p_viewer: viewerPerPost })).data.ok === false);

console.log("");
console.log("wall-addviews-e2e: " + pass + " PASS, " + fail + " FAIL");
if (fail === 0) {
  console.log("清理（可选的浏览数回滚；wall_post_views 无 delete 策略，需在 SQL Editor 用 service role 跑）：");
  console.log("  delete from public.wall_post_views where viewer_key in ('" + viewerBatch + "','" + viewerPerPost + "');");
  console.log("  update public.wall_posts p set views = (select count(*) from public.wall_post_views v where v.post_id = p.id) where p.id in (" + A.id + "," + B.id + ");");
}
process.exit(fail === 0 ? 0 : 1);
