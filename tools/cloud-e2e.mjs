/* 云端暖心墙端到端实测（Node 直跑，不打浏览器）：
 *   node tools/cloud-e2e.mjs
 * 流程：注册 → 自动建档 → 发帖 → 评论 → 回应唯一约束 → 匿名读 → 匿名写被拒 → 清理。
 * 若项目开启了邮箱验证，会输出 NEED_VERIFY 并说明如何关闭。
 */
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = fs.readFileSync(path.join(root, ".env"), "utf8");
const get = (k) => { const m = env.match(new RegExp("^\\s*" + k + "\\s*=\\s*(\\S+)\\s*$", "m")); return m ? m[1] : ""; };
const URL = get("VITE_SUPABASE_URL"), KEY = get("VITE_SUPABASE_ANON_KEY");

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => {
  if (c) { pass++; console.log("PASS  " + n + (extra ? "  " + extra : "")); }
  else { fail++; console.log("FAIL  " + n + (extra ? "  " + extra : "")); }
};

const sbAnon = createClient(URL, KEY, { auth: { persistSession: false } });

/* T1 RLS：匿名写必须被拒绝 */
{
  const { error } = await sbAnon.from("wall_posts")
    .insert({ user_id: "00000000-0000-0000-0000-000000000000", body: "anon should fail" });
  ok("T1 RLS 匿名写 wall_posts 被拒", !!error, error ? "(" + error.code + ")" : "竟然成功了?!");
}

/* 注册（新式 key + 随机邮箱） */
const email = "wp-e2e-" + Date.now() + "@gmail.com";
const NICK = "云端测试员";
const { data: su, error: suErr } = await sbAnon.auth.signUp({
  email, password: "warm-paws-123",
  options: { data: { nickname: NICK } },
});
if (suErr || !su || !su.session) {
  console.log("NEED_VERIFY 项目开启了邮箱确认（注册无 session，无法做写操作 e2e）。");
  console.log("→ Supabase 后台：Authentication → Sign In / Providers → Email → 关闭 Confirm email，然后重跑本脚本。");
  console.log("(auth error: " + (suErr ? suErr.message : "no session") + ")");
  process.exit(2);
}
const uid = su.user.id;
const sb = createClient(URL, KEY, { auth: { persistSession: false }, global: { headers: { Authorization: "Bearer " + su.session.access_token } } });
sb.auth.setSession ? await sb.auth.setSession(su.session) : null;
console.log("PASS  T2 邮箱注册成功（" + email + "）"); pass++;

/* T3 触发器自动建档 */
{
  const { data, error } = await sb.from("profiles").select("nickname").eq("id", uid).maybeSingle();
  ok("T3 注册触发器自动建档+昵称", !error && data && data.nickname === NICK,
    data ? "(nickname=" + data.nickname + ")" : (error ? error.message : "无档案"));
}

/* T4 发帖 + 读回 */
let postId = 0;
{
  const { data, error } = await sb.from("wall_posts")
    .insert({ user_id: uid, author_name: NICK, body: "云端的第一个抱抱 🫂" })
    .select("*").single();
  ok("T4 云端发帖成功", !error && data && data.body.includes("抱抱"), error ? error.message : "");
  postId = data ? data.id : 0;
}

/* T5 评论 + 读回 */
let cmtId = 0;
{
  const { data, error } = await sb.from("wall_comments")
    .insert({ post_id: postId, user_id: uid, author_name: NICK, body: "同感，抱抱你" })
    .select("*").single();
  ok("T5 云端评论成功", !error && data && data.body === "同感，抱抱你", error ? error.message : "");
  cmtId = data ? data.id : 0;
}

/* T6 回应唯一约束：同帖同人同种第二次必须失败 */
{
  const { error: e1 } = await sb.from("wall_reactions")
    .insert({ post_id: postId, user_id: uid, kind: "hug" });
  const { error: e2 } = await sb.from("wall_reactions")
    .insert({ post_id: postId, user_id: uid, kind: "hug" });
  ok("T6 回应首次成功", !e1, e1 ? e1.message : "");
  ok("T7 重复回应被主键拒绝", !!e2, e2 ? "(" + e2.code + ")" : "");
}

/* T8 匿名能读到刚发的帖（公开读） */
{
  const { data, error } = await sbAnon.from("wall_posts").select("body").eq("id", postId).maybeSingle();
  ok("T8 匿名可读新帖（真·多人共享）", !error && data && data.body.includes("抱抱"));
}

/* T9 删除自己的评论（RLS 允许 own delete） */
{
  const { error } = await sb.from("wall_comments").delete().eq("id", cmtId);
  ok("T9 删除自己的评论", !error, error ? error.message : "");
}

/* T10 迁移探测：parent_id 存在才能测二级评论（没跑迁移就 SKIP，不当 FAIL） */
let hasParent = false;
{
  const { error } = await sb.from("wall_comments").select("parent_id").limit(1);
  hasParent = !error;
  if (hasParent) { pass++; console.log("PASS  T10 迁移已就绪（wall_comments.parent_id 存在）"); }
  else console.log("SKIP  T10 未跑 MIGRATION_two_level_comments.sql：跳过二级评论测试（" + error.message + "）");
}

/* T11~T15 二级评论：写入 / 回复的回复仍挂同一层 / 计数 / 级联删除 */
if (hasParent) {
  let topId = 0;
  {
    const { data, error } = await sb.from("wall_comments")
      .insert({ post_id: postId, user_id: uid, author_name: NICK, body: "一级评论（回复用）" })
      .select("*").single();
    ok("T11 一级评论 parent_id 为空", !error && data && (data.parent_id === null || data.parent_id === undefined),
      error ? error.message : "parent_id=" + (data ? data.parent_id : "?"));
    topId = data ? data.id : 0;
  }
  {
    const { data, error } = await sb.from("wall_comments")
      .insert({ post_id: postId, user_id: uid, author_name: NICK, body: "回复一级评论", parent_id: topId, reply_to_name: NICK })
      .select("*").single();
    ok("T12 二级回复写入 parent_id + reply_to_name（@谁）",
      !error && data && data.parent_id === topId && data.reply_to_name === NICK,
      error ? error.message : "parent_id=" + (data ? data.parent_id : "?"));
  }
  {
    /* 前端把「回复某条回复」也挂在同一一级评论下（两级封顶），云端只验证这种写法能落库 */
    const { data, error } = await sb.from("wall_comments")
      .insert({ post_id: postId, user_id: uid, author_name: NICK, body: "回复那条回复", parent_id: topId, reply_to_name: NICK })
      .select("*").single();
    ok("T13 回复「回复」仍挂同一一级评论（层级不会越叠越深）",
      !error && data && data.parent_id === topId, error ? error.message : "");
  }
  {
    /* 评论计数：该帖此刻应有 3 条（T9 已删掉 T5 那条，剩下的是一级 1 + 回复 2） */
    const { data, error } = await sb.from("wall_comments").select("post_id").eq("post_id", postId);
    const n = Array.isArray(data) ? data.length : -1;
    ok("T14 评论数聚合 = 3（进页面即显示真实条数，不必点开评论区）", !error && n === 3,
      "rows=" + n + (error ? " " + error.message : ""));
  }
  {
    /* FK on delete cascade：删一级评论，它的回复应一并消失 */
    await sb.from("wall_comments").delete().eq("id", topId);
    const { data } = await sb.from("wall_comments").select("id").eq("post_id", postId);
    const left = Array.isArray(data) ? data.length : -1;
    ok("T15 删一级评论级联删掉其回复（FK on delete cascade）", left === 0, "left=" + left);
  }
}

/* 清理：删帖（cascade 带走回应），删除档案 */
{
  await sb.from("wall_posts").delete().eq("id", postId);
  await sb.from("profiles").delete().eq("id", uid);
  console.log("清理完成（测试帖/档案已删）");
}

console.log("\nTOTAL " + (pass + fail) + "  PASS " + pass + "  FAIL " + fail);
process.exit(fail ? 1 : 0);
