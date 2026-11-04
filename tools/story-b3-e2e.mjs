/* 故事栏批 3 云端端到端实测（Node 直跑）：
 *   node tools/story-b3-e2e.mjs
 * 测什么：批 3 迁移（MIGRATION_story_b3.sql）在线上真实生效 ——
 *   ① story_set_like / story_set_bookmark 是【幂等的设置语义】（重复调用不翻反）
 *   ② story_my_flags 能取回「我赞了哪些/收藏了哪些」
 *   ③ story_get 返回 marked 字段，且收藏后 marked 变 true、取消后回 false
 *   ④ 匿名调用 story_get 仍可读（drop+create 后权限重授没漏）
 *   ⑤ 匿名调用写 RPC 被拒（只有 authenticated 有执行权）
 * 副作用：用临时账号点赞/收藏测试用故事 → 结束时全部撤销（恢复原状）。
 * 前置：MIGRATION_story.sql / MIGRATION_story_b2.sql / MIGRATION_story_b3.sql 均已执行。
 */
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = fs.readFileSync(path.join(root, ".env"), "utf8");
const get = (k) => { const m = env.match(new RegExp("^\\s*" + k + "\\s*=\\s*(\\S+)\\s*$", "m")); return m ? m[1] : ""; };
const URL_ = get("VITE_SUPABASE_URL"), KEY = get("VITE_SUPABASE_ANON_KEY");

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => {
  if (c) { pass++; console.log("PASS  " + n + (extra ? "  " + extra : "")); }
  else { fail++; console.log("FAIL  " + n + (extra ? "  " + extra : "")); }
};

const sb0 = createClient(URL_, KEY, { auth: { persistSession: false } });

/* ── T0 迁移前置：匿名调 story_get 拿一篇文章 ───────────────────── */
let storyId = 0;
{
  const { data, error } = await sb0.rpc("story_get", { p_id: 1 });
  if (error) {
    if (/42P01|42883|PGRST202|schema cache/i.test(String(error.code) + error.message)) {
      console.log("NEED_MIGRATION：MIGRATION_story_b3.sql 尚未执行（" + error.message + "）。");
      process.exit(2);
    }
    console.log("FAIL  T0 story_get 匿名可读 —— " + error.message);
    process.exit(1);
  }
  const row = (data && data[0]) || null;
  ok("T0 story_get 匿名可读（drop+create 后权限重授没漏）", !!row, row ? `(id=${row.id})` : "(空)");
  ok("T0 story_get 已带 marked 字段（收藏星有初态）", row && typeof row.marked === "boolean",
    row ? `(marked=${row.marked})` : "");
  const { data: list } = await sb0.rpc("story_feed", { p_limit: 20, p_offset: 0 });
  const cand = (list || []).find((x) => x && x.id);
  storyId = cand ? cand.id : (row ? row.id : 0);
}
if (!storyId) { console.log("FAIL  找不到可用于测试的故事"); process.exit(1); }

/* ── T1 匿名调用写 RPC 必须被拒（只有 authenticated 有执行权）──── */
{
  const { error } = await sb0.rpc("story_set_like", { p_id: storyId, p_on: true });
  ok("T1 匿名调 story_set_like 被拒（权限只给 authenticated）",
    !!error && /permission denied|42501/i.test(String(error.code) + error.message),
    error ? `(${error.code})` : "(居然成功了!)");
}

/* ── 注册临时账号 ────────────────────────────────────────────── */
const ts = Date.now().toString(36);
const EMAIL = `wp-story-b3-${ts}@gmail.com`, PW = "warm-paws-123";
const sb = createClient(URL_, KEY, { auth: { persistSession: false } });
const { data: s, error: suErr } = await sb.auth.signUp({
  email: EMAIL, password: PW, options: { data: { nickname: "批3测试" } },
});
if (suErr || !s || !s.session) {
  console.log("NEED_VERIFY：注册失败或项目开启了邮箱确认（无 session），无法做写操作 e2e。", suErr ? suErr.message : "");
  process.exit(2);
}
const uid = s.user.id;
console.log(`账号就绪 ${uid.slice(0, 8)}…  目标故事 id=${storyId}`);

const rpc = async (name, args) => {
  const { data, error } = await sb.rpc(name, args);
  return { data, error: error ? String(error.message) : "", code: error ? error.code : "" };
};

/* ── T2 点赞：幂等设置语义 ───────────────────────────────────── */
{
  const before = (await rpc("story_get", { p_id: storyId })).data?.[0];
  const b0 = Number(before?.like_count ?? 0);
  const r1 = await rpc("story_set_like", { p_id: storyId, p_on: true });
  ok("T2 story_set_like(true) 成功", !r1.error, r1.error || `(count=${r1.data})`);
  const r2 = await rpc("story_set_like", { p_id: storyId, p_on: true });
  ok("T2 重复调 story_set_like(true) 不重复加计数（幂等）",
    !r2.error && Number(r2.data) === Number(r1.data),
    r2.error || `(第一次=${r1.data} 第二次=${r2.data})`);
  const g = (await rpc("story_get", { p_id: storyId })).data?.[0];
  ok("T2 赞后 story_get.liked=true", g && g.liked === true, g ? `(liked=${g.liked})` : "");
  const r3 = await rpc("story_set_like", { p_id: storyId, p_on: false });
  ok("T2 取消赞后计数回落（幂等的 false）",
    !r3.error && Number(r3.data) === b0, r3.error || `(期望=${b0} 实得=${r3.data})`);
  const g2 = (await rpc("story_get", { p_id: storyId })).data?.[0];
  ok("T2 取消赞后 story_get.liked=false", g2 && g2.liked === false, g2 ? `(liked=${g2.liked})` : "");
}

/* ── T3 收藏：幂等设置语义 + marked 跟着变 ───────────────────── */
{
  const r1 = await rpc("story_set_bookmark", { p_id: storyId, p_on: true });
  ok("T3 story_set_bookmark(true) 成功", !r1.error, r1.error || `(count=${r1.data})`);
  const r2 = await rpc("story_set_bookmark", { p_id: storyId, p_on: true });
  ok("T3 重复调 story_set_bookmark(true) 计数不变（幂等）",
    !r2.error && Number(r2.data) === Number(r1.data),
    r2.error || `(第一次=${r1.data} 第二次=${r2.data})`);
  const g = (await rpc("story_get", { p_id: storyId })).data?.[0];
  ok("T3 收藏后 story_get.marked=true（收藏星能亮）", g && g.marked === true, g ? `(marked=${g.marked})` : "");
  const r3 = await rpc("story_set_bookmark", { p_id: storyId, p_on: false });
  const g3 = (await rpc("story_get", { p_id: storyId })).data?.[0];
  ok("T3 取消收藏后 story_get.marked 回 false",
    !r3.error && g3 && g3.marked === false, r3.error || `(marked=${g3?.marked})`);
}

/* ── T4 story_my_flags：批量取赞/藏初态 ──────────────────────── */
{
  const r = await rpc("story_my_flags", { p_ids: [storyId, storyId + 1] });
  ok("T4 story_my_flags 返回行", !r.error && Array.isArray(r.data) && r.data.length >= 1,
    r.error || `(rows=${r.data?.length})`);
  const me = (r.data || []).find((x) => Number(x.story_id) === Number(storyId));
  ok("T4 story_my_flags 带 liked/marked 两个字段",
    me && typeof me.liked === "boolean" && typeof me.marked === "boolean",
    me ? `(liked=${me.liked} marked=${me.marked})` : "");
  await rpc("story_set_like", { p_id: storyId, p_on: true });
  const r2 = await rpc("story_my_flags", { p_ids: [storyId] });
  const me2 = (r2.data || []).find((x) => Number(x.story_id) === Number(storyId));
  ok("T4 my_flags.liked 与实际一致（点赞后为 true）", me2 && me2.liked === true,
    me2 ? `(liked=${me2.liked})` : "");
}

/* ── 收尾：撤销测试留下的赞/藏（恢复原状） ───────────────────── */
{
  await rpc("story_set_like", { p_id: storyId, p_on: false });
  await rpc("story_set_bookmark", { p_id: storyId, p_on: false });
  const g = (await rpc("story_get", { p_id: storyId })).data?.[0];
  ok("Z 收尾：赞/藏已全部撤销（liked=false marked=false）",
    g && g.liked === false && g.marked === false, g ? `(liked=${g.liked} marked=${g.marked})` : "");
}

console.log(`\nstory-b3-e2e: ${pass} pass, ${fail} fail  (账号 ${uid.slice(0, 8)}… 可在 Supabase 后台删除)`);
process.exit(fail ? 1 : 0);