/* 通知偏好端到端实测（net 层：注册两个 wp-* 临时账号，跑完删号）
 * ------------------------------------------------------------
 * 用户报障：「设置里把评论/回应/宠物通知关掉，实际上也没有效果」。
 * 这脚本把「效果」拆成两半分别验：
 *   ① 生成侧：关掉后再有人评论 / 回应 / 摸宠物，通知还落不落表？
 *   ② 清理侧：关掉的那一刻，已经堆着的未读红点消不消？（用户看到的"没效果"是这一半）
 * 外加一条可逆性：重新打开后新互动必须照常计数，别把开关做成一次性的。
 * 运行：node tools/notif-prefs-e2e.mjs
 */
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = fs.readFileSync(path.join(root, ".env"), "utf8");
const get = (k) => { const m = env.match(new RegExp("^\\s*" + k + "\\s*=\\s*(\\S+)\\s*$", "m")); return m ? m[1] : ""; };
const URL = get("VITE_SUPABASE_URL"), KEY = get("VITE_SUPABASE_ANON_KEY");

let pass = 0;
const fails = [];
const ok = (n, c, extra = "") => {
  if (c) { pass++; console.log("PASS  " + n + (extra ? "  " + extra : "")); }
  else { fails.push(n + (extra ? "  " + extra : "")); console.log("FAIL  " + n + (extra ? "  " + extra : "")); }
};

const stamp = Date.now();
async function mk(tag, nick) {
  const email = `wp-pref-${tag}-${stamp}@gmail.com`;
  const c = createClient(URL, KEY, { auth: { persistSession: false } });
  const { data, error } = await c.auth.signUp({ email, password: "warm-paws-123", options: { data: { nickname: nick } } });
  if (error || !data?.session) { console.log("NEED_VERIFY  " + (error?.message || "no session")); process.exit(2); }
  await c.auth.setSession(data.session);
  return { c, uid: data.user.id, email };
}
const A = await mk("a", "偏好测甲");
const B = await mk("b", "偏好测乙");

const notifRows = async () =>
  (await B.c.from("notifications").select("id,kind,read_at").order("id", { ascending: false }).limit(80)).data || [];
const unread = async () => (await B.c.rpc("notif_unread")).data || {};
const unreadList = async () => {
  const r = await B.c.rpc("notif_page", { p_offset: 0, p_limit: 80, p_kinds: null, p_unread: true });
  return Array.isArray(r.data) ? r.data : [];
};
const setPrefs = (o) => B.c.rpc("notif_prefs_set", {
  p_comments: o.comments !== false, p_reactions: o.reactions !== false,
  p_pets: o.pets !== false, p_dms: true,
});

/* 一轮 = 一条新帖 + 评论 + 回应 + 宠物互动
 * pet 的 viewer_key 带上轮次：pet_interactions 主键是 (owner, viewer, day, kind)，
 * 同一 viewer 同一天同类只记一次（防刷）→ 插不进去就不会触发通知，
 * 这里用不同的 viewer_key 让每一轮都是「一次真实的互动」。 */
let petN = 0;
async function round(tag) {
  const p = await B.c.from("wall_posts")
    .insert({ user_id: B.uid, author_name: "偏好测乙", body: `偏好测试 ${tag} ${stamp}` })
    .select("id").single();
  if (p.error) { ok("发帖 " + tag, false, p.error.message); return; }
  const postId = p.data.id;
  const n = ++petN;
  await A.c.from("wall_comments").insert({ post_id: postId, user_id: A.uid, author_name: "偏好测甲", body: "评论 " + tag });
  await A.c.from("wall_reactions").insert({ post_id: postId, user_id: A.uid, kind: "hug" });
  await A.c.rpc("pet_interact", { p_owner: B.uid, p_kind: (n % 2 ? "pat" : "feed"), p_viewer: `${A.uid}-${n}` });
  await new Promise((r) => setTimeout(r, 150));
}

/* ── ① 全开：三类都要落表 ── */
await setPrefs({ comments: true, reactions: true, pets: true });
await round("r1");
{
  const kinds = (await notifRows()).map((x) => x.kind);
  ok("T1 评论生成通知", kinds.includes("comment"), JSON.stringify(kinds));
  ok("T2 回应生成通知", kinds.includes("reaction"));
  ok("T3 宠物生成通知", kinds.includes("pet"));
  const u = await unread();
  ok("T4 未读总数 = 3", u.total === 3, "total=" + u.total);
}

/* ── ② 关掉三类：已存在的红点必须当场消 ── */
await setPrefs({ comments: false, reactions: false, pets: false });
{
  const u = await unread();
  ok("T5 关闭后角标立刻归零（这就是用户说的「没效果」那一半）", u.total === 0, "total=" + u.total);
  ok("T6 评论未读清零", u.comments === 0, "comments=" + u.comments);
  ok("T7 宠物未读清零", u.pets === 0, "pets=" + u.pets);
  const list = await unreadList();
  ok("T8 通知列表里也没有未读了（不会出现「角标 0 但列表一堆未读」）", list.length === 0, "剩 " + list.length + " 条");
  const rows = await notifRows();
  ok("T9 历史行没被删掉（只标已读，记录还在）", rows.length === 3, "rows=" + rows.length);
  ok("T10 历史行确实变成已读态", rows.every((x) => x.read_at), JSON.stringify(rows.map((x) => x.read_at ? "read" : "unread")));
}

/* ── ③ 关着的时候再来一轮：一行都不许新增 ── */
{
  const before = (await notifRows()).length;
  await round("r2");
  const after = await notifRows();
  ok("T11 关闭后不再生成通知", after.length === before, `${before} → ${after.length}`);
  const u = await unread();
  ok("T12 关闭后角标仍是 0", u.total === 0, "total=" + u.total);
}

/* ── ④ 重新打开：新互动照常计数（开关可逆，不是一次性） ── */
await setPrefs({ comments: true, reactions: true, pets: true });
await round("r3");
{
  const u = await unread();
  ok("T13 重新打开后新通知恢复计数", u.total === 3, "total=" + u.total);
  const list = await unreadList();
  ok("T14 恢复的未读只含新产生的那三条", list.length === 3, "list=" + list.length);
  const kinds = list.map((x) => x.kind).sort();
  ok("T15 恢复的三种类型齐全", JSON.stringify(kinds) === JSON.stringify(["comment", "pet", "reaction"]), JSON.stringify(kinds));
}

/* ── ⑤ 总开关语义：一次关三类 ── */
await setPrefs({ comments: false, reactions: false, pets: false });
{
  const u = await unread();
  ok("T16 总开关关掉 = 三类未读一起消", u.total === 0, "total=" + u.total);
}

for (const u of [A, B]) {
  const r = await u.c.rpc("delete_my_account");
  ok("cleanup " + u.email, !r.error, r.error?.message);
}

console.log(`\n${pass} / ${pass + fails.length} 通过`);
if (fails.length) {
  console.log("\n失败项：");
  for (const f of fails) console.log("  ✗ " + f);
  process.exitCode = 1;
} else {
  console.log("全部通过");
}
