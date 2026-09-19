/* 线上核验：#26 下架规则是否已是「双档」新规（唯一解判别器）
 *   node tools/dislike-e2e.mjs
 *
 * 为什么需要它：下架规则在库里改过三次，而每次改完都必须**重跑 SQL**（DDL 不能由前端部署带上）。
 * 历史上三次：
 *   ① 73ee2ba  纯比例：厌恶 ÷ 浏览 ≥ 1%（无最少人数）
 *   ② 39c9bb5  加下限：厌恶 ≥ 5 且 比例 ≥ 1%
 *   ③ e142150  #26 双档：浏览 < 100 → 厌恶 > 3；浏览 ≥ 100 → 比例 > 0.5%
 * 只看「4 个厌恶是否下架」无法区分 ① 与 ③（两者都会下架），所以本探针同时验两档：
 *
 *   低浏览档：浏览保持 < 100，逐个投厌恶
 *      ③ 新规 → 第 1 个不下架、第 4 个才下架
 *      ① 旧规 → 第 1 个就下架（1/2 = 50% ≥ 1%）  ← 唯一能区分的一步
 *   高浏览档：把浏览量推到 ≥ 100 后只投 1 个厌恶
 *      ③ 新规 → 1/120 ≈ 0.83% > 0.5% → 下架
 *      ① 旧规 → 1/120 ≈ 0.83% < 1%  → 不下架
 *   两档都断言，出的结论才是唯一解，不会「碰巧对上」。
 *
 * 判读口径：removed 一律取 **RPC 返回值**（权威）——下架后 RLS 让普通用户读不到该行，
 * 直接 select 会被策略挡成空，从而误报「行不见了」。
 * 清理：删两条探针帖（cascade 带走回应与浏览记录）+ 删测试档案。
 */
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const envTxt = fs.readFileSync(path.join(root, ".env"), "utf8");
const get = (k) => { const m = envTxt.match(new RegExp("^\\s*" + k + "\\s*=\\s*(\\S+)\\s*$", "m")); return m ? m[1] : ""; };
const URL_ = get("VITE_SUPABASE_URL"), KEY = get("VITE_SUPABASE_ANON_KEY");

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => {
  if (c) { pass++; console.log("PASS  " + n + (extra ? "  " + extra : "")); }
  else { fail++; console.log("FAIL  " + n + (extra ? "  " + extra : "")); }
};
const HINT = "  ← 线上 SQL 未更新：请到 Supabase → SQL Editor 重跑 MIGRATION_wall_daily_view_dislike.sql";

/* 5 个互不相同的登录账号：0 号发帖，1~4 号各投一次厌恶（厌恶按人去重，必须 4 个人） */
const N = 5;
const clients = [];
for (let i = 0; i < N; i++) {
  const c = createClient(URL_, KEY, { auth: { persistSession: false } });
  const { data, error } = await c.auth.signUp({
    email: `wp-dis-${Date.now()}-${i}@gmail.com`,
    password: "probe-Passw0rd!",
    options: { data: { nickname: "阈值探针" + i } },
  });
  if (error || !data || !data.session) { console.log("注册失败：" + (error && error.message)); process.exit(2); }
  c.uid = data.user.id;
  clients.push(c);
}
ok("5 个测试账号就绪（1 个发帖 + 4 个厌恶）", clients.length === N);

const sb = clients[0];

/* ── 低浏览档：浏览 < 100 ────────────────────────────── */
const postA = await sb.from("wall_posts")
  .insert({ user_id: sb.uid, author_name: "阈值探针0", body: "探针A：低浏览档（可删）" })
  .select("id,views,dislikes,removed").single();
if (postA.error || !postA.data) { console.log("建帖A失败：" + (postA.error && postA.error.message)); process.exit(2); }
const idA = postA.data.id;
ok("建帖 A（低浏览档探针）", !!idA, "id=" + idA);

/* 造 2 个浏览（用可控 viewer 键；< 100，必走低浏览档） */
for (let i = 0; i < 2; i++) {
  await sb.rpc("wall_add_view", { p_post: idA, p_viewer: `probe-a-${Date.now()}-${i}` });
}

const aSteps = [];
for (let i = 1; i <= 4; i++) {
  const { data, error } = await clients[i].rpc("wall_toggle_dislike", { p_post: idA });
  aSteps.push(error ? { err: error.message } : { dis: data.dislikes, views: data.views, removed: data.removed });
}
const a1 = aSteps[0], a4 = aSteps[3];

ok("低浏览档 · 第 1 个厌恶不下架（区分点：旧「纯比例 1%」规则会在这里误下架）",
  !a1.err && a1.removed === false && a1.dis === 1,
  a1.err ? a1.err : JSON.stringify(a1) + (a1.removed === true ? HINT : ""));

ok("低浏览档 · 第 4 个厌恶才下架（浏览 < 100 时 厌恶 > 3）",
  !a4.err && a4.removed === true && a4.dis === 4,
  a4.err ? a4.err : "views=" + a4.views + " dislikes=" + a4.dis + " removed=" + a4.removed);

/* 假删除：帖子行仍在库里（下架后普通用户读不到，所以用 RPC 取消一次拿权威计数）。
   注意必须用**投过厌恶的那个账号**（clients[1]）来取消 —— 用没投过的账号会让计数 +1 */
{
  const { data, error } = await clients[1].rpc("wall_toggle_dislike", { p_post: idA });
  ok("假删除：帖仍在库里（取消一次后计数回落到 3、removed 仍为 true，不会自动恢复）",
    !error && data && data.dislikes === 3 && data.removed === true,
    error ? "err=" + error.message : JSON.stringify(data));
}

/* ─ 高浏览档：浏览 ≥ 100 ────────────────────────────── */
await sb.from("wall_posts").delete().eq("id", idA);
const postB = await sb.from("wall_posts")
  .insert({ user_id: sb.uid, author_name: "阈值探针0", body: "探针B：高浏览档（可删）" })
  .select("id,views").single();
if (postB.error || !postB.data) { console.log("建帖B失败：" + (postB.error && postB.error.message)); process.exit(2); }
const idB = postB.data.id;
ok("建帖 B（高浏览档探针；删掉今日帖后可重发，顺带验证限额按天算）", !!idB, "id=" + idB);

/* 把浏览量推到 ≥ 100：viewer 键是自由文本（服务端只按「键 + UTC 日」去重），可精确控制分母 */
const TARGET = 120;
for (let i = 0; i < TARGET; i += 10) {
  await Promise.all(Array.from({ length: 10 }, (_, j) =>
    sb.rpc("wall_add_view", { p_post: idB, p_viewer: `probe-b-${Date.now()}-${i + j}` })));
}
const vB = await sb.rpc("wall_add_view", { p_post: idB, p_viewer: `probe-b-last-${Date.now()}` });
const viewsB = vB.data ? Number(vB.data.views) || 0 : 0;
ok("高浏览档 · 浏览量已推到 ≥ 100（分母足够走比例档）", viewsB >= 100, "views=" + viewsB);

{
  const { data, error } = await clients[1].rpc("wall_toggle_dislike", { p_post: idB });
  const ratio = viewsB > 0 ? ((1 / viewsB) * 100).toFixed(2) + "%" : "?";
  /* 1/120 ≈ 0.83%：新规 > 0.5% → 下架；旧的「≥1%」→ 不下架 */
  ok("高浏览档 · 1 个厌恶（" + ratio + " > 0.5%）即下架",
    !error && data && data.on === true && data.removed === true,
    error ? error.message : JSON.stringify(data) + (data && data.removed === false ? HINT : ""));
}

/* ─ 结论 ──────────────────────────────────────────── */
if (fail === 0) console.log("\n结论：线上已是 #26 双档新规（低浏览档按人数、高浏览档按 0.5% 比例）");
else console.log("\n结论：线上 SQL 与仓库不一致 —— 请重跑 MIGRATION_wall_daily_view_dislike.sql 后复跑本探针");

/* ── 清理 ──────────────────────────────────────────── */
{
  await sb.from("wall_posts").delete().eq("id", idB);
  for (const c of clients) await c.from("profiles").delete().eq("id", c.uid);
  const { data: left } = await sb.from("wall_posts").select("id").in("id", [idA, idB]);
  console.log(Array.isArray(left) && left.length === 0
    ? "清理完成（两条探针帖已删，5 个测试档案已清）"
    : "清理提示：探针帖可能仍在，请手动确认");
}

console.log("\nTOTAL " + (pass + fail) + "  PASS " + pass + "  FAIL " + fail);
process.exit(fail ? 1 : 0);