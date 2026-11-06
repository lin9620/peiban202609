/* 免打扰端到端实测（net 层：会注册两个 wp-* 临时账号、发真实私信、跑完删号）
 * ------------------------------------------------------------------
 * 验证的是**线上库里的函数**，不是前端：
 *   P1 收 2 条未读 → dm_unread_total.total = 2
 *   P2 设免打扰 → total = 0、convs = []（不进导航角标）
 *   P3 但会话行 unread 仍是 2（灰点要用的事实值不能被抹掉）
 *   P4 免打扰 + 关掉全部通知偏好 + 再来一条 → total 仍 0（通知偏好转私信本来就不管）
 *   P5 取消免打扰 → total 回到 3（能恢复，不是一次性黑洞）
 *   P6 删除会话（隐藏）后不再计入（顺手回归）
 * 运行：node tools/dm-mute-e2e.mjs
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
async function mkUser(tag) {
  const email = `wp-mute-${tag}-${stamp}@gmail.com`;
  const c = createClient(URL, KEY, { auth: { persistSession: false } });
  const { data, error } = await c.auth.signUp({
    email, password: "warm-paws-123", options: { data: { nickname: "静音测" + tag } },
  });
  if (error || !data || !data.session) {
    console.log("NEED_VERIFY  注册拿不到 session：" + (error ? error.message : "no session"));
    process.exit(2);
  }
  await c.auth.setSession(data.session);
  return { c, uid: data.user.id, email };
}

const A = await mkUser("a");
const B = await mkUser("b");

const open = await A.c.rpc("dm_open", { p_other: B.uid });
const conv = open.data && open.data.conv_id;
ok("P0 建会话", !!conv, "conv=" + conv);

await A.c.rpc("dm_send", { p_conv: conv, p_body: "在吗" });
await A.c.rpc("dm_send", { p_conv: conv, p_body: "今天还好吗" });

const unread = async () => {
  const u = await B.c.rpc("dm_unread_total");
  return (u.data && u.data) || { total: 0, requests: 0, convs: [] };
};
const convRow = async () => {
  const l = await B.c.rpc("dm_list_convs", { p_limit: 100, p_offset: 0 });
  return Array.isArray(l.data) ? l.data.find((x) => Number(x.conv_id) === Number(conv)) : null;
};

{
  const u = await unread();
  ok("P1 未读计入角标", u.total === 2, "total=" + u.total);
  ok("P1 行级明细也带上", Array.isArray(u.convs) && u.convs.length === 1, JSON.stringify(u.convs));
}

await B.c.rpc("dm_mute", { p_conv: conv, p_on: true });
{
  const u = await unread();
  ok("P2 免打扰后不进角标", u.total === 0, "total=" + u.total);
  ok("P2 行级明细一并清掉（不会在导航角标上补数字）", Array.isArray(u.convs) && u.convs.length === 0, JSON.stringify(u.convs));
  ok("P2 未接受的请求也不再催", u.requests === 0, "requests=" + u.requests);
}
{
  const row = await convRow();
  ok("P3 会话行仍保留事实未读（灰点靠它）", row && row.unread === 2, row ? "unread=" + row.unread : "无行");
  ok("P3 会话行带 muted 标记（前端据此不画红数字）", row && row.muted === true);
}

await B.c.from("notification_prefs").upsert({ user_id: B.uid, comments: false, reactions: false, pets: false, dms: false });
await A.c.rpc("dm_send", { p_conv: conv, p_body: "关了通知再发一条" });
{
  const u = await unread();
  ok("P4 关通知偏好不影响免打扰结论（仍不进角标）", u.total === 0, "total=" + u.total);
  const row = await convRow();
  ok("P4 事实未读涨到 3", row && row.unread === 3, row ? "unread=" + row.unread : "无行");
}

await B.c.rpc("dm_mute", { p_conv: conv, p_on: false });
{
  const u = await unread();
  ok("P5 取消免打扰后未读回到角标", u.total === 3, "total=" + u.total);
  ok("P5 行级明细恢复", Array.isArray(u.convs) && u.convs[0] && u.convs[0].unread === 3, JSON.stringify(u.convs));
}

await B.c.rpc("dm_hide", { p_conv: conv });
{
  const u = await unread();
  ok("P6 删除会话后不再计入角标", u.total === 0, "total=" + u.total);
}

/* 清理：删号（dm 数据随之 cascade） */
for (const u of [A, B]) {
  const r = await u.c.rpc("delete_my_account");
  ok("cleanup " + u.email, !r.error, r.error ? r.error.message : "");
}

console.log(`\n${pass} / ${pass + fails.length} 通过`);
if (fails.length) {
  console.log("\n失败项：");
  for (const f of fails) console.log("  ✗ " + f);
  process.exitCode = 1;
} else {
  console.log("全部通过");
}
