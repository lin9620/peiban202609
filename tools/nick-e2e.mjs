/* 改昵称同步旧内容署名（轮 9）的线上实测
 *   node tools/nick-e2e.mjs
 * 走与浏览器同一条链路（直连 Supabase REST + 用户 JWT，RLS 照常执行）：
 *   A. 未跑迁移时 rename_me 缺失 → 前端应走「只改档案」退化路径（改名成功、旧帖留旧名）
 *   B. 跑完 MIGRATION_nickname_sync.sql 后 → 旧帖/旧评论署名一起改，并返回改动行数
 * 前置：无（A 与 B 都会跑，按线上实际能力给出结论）。
 * 副作用：注册 1 个测试账号（邮箱 wp-nick-*），建 1 帖 1 评论验证署名，结束前删除；
 *         档案行无 delete 策略会留存（不影响他人）。
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
const info = (n, extra = "") => console.log("INFO  " + n + (extra ? "  " + extra : ""));

const sbAnon = createClient(URL_, KEY, { auth: { persistSession: false } });
const email = "wp-nick-" + Date.now() + "@gmail.com";
const OLD = "旧名字";
const NEW = "新名字";
const { data: su, error: suErr } = await sbAnon.auth.signUp({
  email, password: "warm-paws-123", options: { data: { nickname: OLD } },
});
if (suErr || !su || !su.session) {
  console.log("NEED_VERIFY 注册无 session：" + (suErr ? suErr.message : "no session"));
  process.exit(2);
}
const uid = su.user.id;
const sb = createClient(URL_, KEY, {
  auth: { persistSession: false },
  global: { headers: { Authorization: "Bearer " + su.session.access_token } },
});
await sb.auth.setSession(su.session);
console.log("PASS  注册成功（" + email + "）  uid=" + uid); pass++;

/* 造一条帖 + 一条评论（author_name 冗余写死为 OLD） */
const { data: post, error: pErr } = await sb.from("wall_posts")
  .insert({ user_id: uid, author_name: OLD, body: "改名探针帖" }).select("*").single();
ok("发帖成功且署名 = 旧名字", !pErr && post && post.author_name === OLD, pErr ? pErr.message : "author_name=" + (post && post.author_name));
const { data: cmt, error: cErr } = await sb.from("wall_comments")
  .insert({ post_id: post.id, user_id: uid, author_name: OLD, body: "改名探针评论" }).select("*").single();
ok("评论成功且署名 = 旧名字", !cErr && cmt && cmt.author_name === OLD, cErr ? cErr.message : "");

/* A. RPC 是否已就绪 */
const rpc = await sb.rpc("rename_me", { p_nick: NEW });
const missing = !!rpc.error && (/pgrst202|42883|does not exist|could not find the function/i.test(rpc.error.message || "")
  || ["PGRST202", "42883", "42703", "42P01"].includes(String(rpc.error.code || "").toUpperCase()));
if (missing) {
  info("rename_me 尚未就绪（code=" + (rpc.error && rpc.error.code) + " msg=" + (rpc.error && rpc.error.message) + "）→ 先验退化路径");
  const up = await sb.from("profiles").update({ nickname: NEW }).eq("id", uid);
  ok("退化路径：profiles 改名成功（RLS self update）", !up.error, up.error ? up.error.message : "");
  const p2 = await sb.from("wall_posts").select("author_name").eq("id", post.id).maybeSingle();
  const c2 = await sb.from("wall_comments").select("author_name").eq("id", cmt.id).maybeSingle();
  ok("退化路径：旧帖署名仍是旧名（这就是要跑迁移的原因）",
    p2.data && p2.data.author_name === OLD, "author_name=" + (p2.data && p2.data.author_name));
  ok("退化路径：旧评论署名仍是旧名", c2.data && c2.data.author_name === OLD);
  info("→ 在 Supabase SQL Editor 跑 MIGRATION_nickname_sync.sql 后重跑本探针");
} else {
  ok("rename_me RPC 可用", !rpc.error, rpc.error ? rpc.error.message : JSON.stringify(rpc.data));
  const row = Array.isArray(rpc.data) ? rpc.data[0] : rpc.data;
  ok("返回改了 1 帖 1 评论", row && row.posts === 1 && row.comments === 1, JSON.stringify(row));
  const p2 = await sb.from("wall_posts").select("author_name").eq("id", post.id).maybeSingle();
  const c2 = await sb.from("wall_comments").select("author_name").eq("id", cmt.id).maybeSingle();
  ok("旧帖署名已同步为新名", p2.data && p2.data.author_name === NEW, "author_name=" + (p2.data && p2.data.author_name));
  ok("旧评论署名已同步为新名", c2.data && c2.data.author_name === NEW, "author_name=" + (c2.data && c2.data.author_name));
  const pr = await sb.from("profiles").select("nickname").eq("id", uid).maybeSingle();
  ok("profiles.nickname 也已更新", pr.data && pr.data.nickname === NEW);
  /* 越权：不能用别人的身份改名（auth.uid 为准，函数不接 id） */
  const other = await sbAnon.rpc("rename_me", { p_nick: "匿名乱改" });
  ok("匿名调 rename_me 被拒（auth-required）", !!other.error && /auth-required/i.test(other.error.message || ""),
    other.error ? other.error.message : "竟然成功了");
  /* 空/超长 */
  const e1 = await sb.rpc("rename_me", { p_nick: "   " });
  const e2 = await sb.rpc("rename_me", { p_nick: "x".repeat(25) });
  ok("空昵称被拒（empty-nickname）", !!e1.error && /empty-nickname/i.test(e1.error.message || ""));
  ok("超长昵称被拒（nick-too-long，25 字 > 24）", !!e2.error && /nick-too-long/i.test(e2.error.message || ""));
  /* 幂等：再改一次仍能同步（旧帖已是新名） */
  const again = await sb.rpc("rename_me", { p_nick: NEW });
  ok("重复改名幂等（第二次仍返回 1 帖 1 评论）",
    !again.error && (Array.isArray(again.data) ? again.data[0] : again.data).posts === 1);
}

/* 清理：删帖（cascade 带走评论）。profiles 无 delete 策略，行会留存但不含内容 */
{
  const d1 = await sb.from("wall_posts").delete().eq("id", post.id);
  const d2 = await sb.from("wall_comments").delete().eq("id", cmt.id);
  console.log(!d1.error && !d2.error ? "清理完成（探针帖/评论已删；测试档案行留存）" : "清理提示：删除可能未完全成功");
}

console.log("\nTOTAL " + (pass + fail) + "  PASS " + pass + "  FAIL " + fail);
process.exit(fail ? 1 : 0);