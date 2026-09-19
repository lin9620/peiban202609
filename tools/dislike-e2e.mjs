/* 线上核验：#26 下架规则是否已是「双档」新规
 *   node tools/dislike-e2e.mjs
 * 判别设计（不依赖浏览量，避免真实访客把分母推过边界）：
 *   造 1 条临时帖 → 4 个不同账号各投 1 次「厌恶」（此时 views≈0，必走「<100」档）
 *     新规（浏览 <100 且 厌恶 >3，即 ≥4 人）→ 第 4 个落下时 removed=true
 *     旧规（厌恶 ≥5 且 比例 ≥1%）          → 只有 4 个 → removed=false
 *   只看这一条就能分辨线上 SQL 是否已更新到新规。
 * 判读口径：removed 一律取 **RPC 返回值**（权威，不受 RLS 影响）——
 *   下架后帖子对普通用户不可见，用「读帖子行」去验会被 RLS 挡住而误判。
 * 清理：删帖（cascade 带走回应）、删 4 个测试档案。
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

/* 4 个互不相同的登录账号（同一个人只能投一次厌恶，所以要 4 个人） */
const N = 4;
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
ok("4 个测试账号就绪（厌恶按人去重，必须 4 个人）", clients.length === N);

const sb = clients[0];
/* 造帖（走 RLS 正常路径） */
const { data: post, error: pErr } = await sb.from("wall_posts")
  .insert({ user_id: sb.uid, body: "探针：下架阈值判别（可删）", author_name: "阈值探针0" })
  .select("id,views,dislikes,removed").single();
if (pErr || !post) { console.log("建帖失败：" + (pErr && pErr.message)); process.exit(2); }
ok("建临时帖", !!post.id, "id=" + post.id + " views=" + post.views);

/* 依次投 4 次厌恶，观察每次返回的 removed */
const steps = [];
for (let i = 0; i < N; i++) {
  const { data, error } = await clients[i].rpc("wall_toggle_dislike", { p_post: post.id });
  steps.push(error ? { err: error.message } : { dis: data.dislikes, views: data.views, removed: data.removed });
}
const last = steps[N - 1];
ok("4 个不同人各投 1 次厌恶都成功写入",
  steps.every((s) => !s.err && s.dis != null), JSON.stringify(steps.map((s) => s.dis)));

const views = last && last.views;
if (views != null && views >= 100) {
  /* 真实访客把浏览量推过 100 → 走比例档，探针无法判别，如实说明而不是硬下结论 */
  console.log("SKIP  浏览量已达 " + views + "（≥100 走 0.5% 比例档）→ 本次无法判别，请重跑");
} else {
  ok("线上已是 #26 双档新规：浏览<100 时第 4 个厌恶即下架（removed=true）",
    !!(last && last.removed === true && last.dis === 4),
    "views=" + views + " dislikes=" + (last && last.dis) + " removed=" + (last && last.removed));
}

/* 假删除：帖子行仍在库里（不是物理删除）。
   注：下架后 RLS 让普通用户读不到该行，所以用 RPC 再点一次「取消厌恶」拿权威计数，
   而不是直接 select（直接 select 会被策略挡成空 → 误报「行不见了」）。 */
{
  const { data, error } = await sb.rpc("wall_toggle_dislike", { p_post: post.id });
  const still = !error && data && data.dislikes === 3 && data.removed === true;
  ok("假删除：贴子仍在库里（取消一次厌恶后计数回落到 3、removed 仍为 true，不会自动恢复）",
    still, error ? "err=" + error.message : JSON.stringify(data));
}

/* 清理：删帖（cascade 带走回应）+ 删 4 个测试档案 */
{
  await sb.from("wall_posts").delete().eq("id", post.id);
  for (const c of clients) await c.from("profiles").delete().eq("id", c.uid);
  const { data: left } = await sb.from("wall_posts").select("id").eq("id", post.id);
  console.log(Array.isArray(left) && left.length === 0
    ? "清理完成（探针帖已删，4 个测试档案已清）"
    : "清理提示：探针帖可能仍在，请手动确认");
}

console.log("\nTOTAL " + (pass + fail) + "  PASS " + pass + "  FAIL " + fail);
process.exit(fail ? 1 : 0);