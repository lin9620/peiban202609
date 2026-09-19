/* 私信 + 通知中心 云端端到端实测（Node 直跑）：
 *   node tools/dm-e2e.mjs
 * 流程：注册 A/B 双账号 → 开会话 → 互发 → 未读/已读水位 → 撤回 → 免打扰/隐藏/拉黑
 *       → 消息请求 → 通知触发器（评论/回应/宠物互动）→ 偏好开关 → 匿名 RLS → 收尾。
 * 前置：MIGRATION_dm_notifications.sql 与 MIGRATION_notifications_drop_dm.sql（#23 私信退出通知中心）均已执行。
 * 说明：会话/消息无用户级删除（设计如此），测试会话会留在库里（双方列表里可见，无碍）。
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
const rpcErr = async (sb, name, args) => {
  const { error } = await sb.rpc(name, args);
  return error ? String(error.message) : "";
};

const sbA0 = createClient(URL_, KEY, { auth: { persistSession: false } });
const ts = Date.now().toString(36);
const EMAIL_A = `wp-dm-a-${ts}@gmail.com`, EMAIL_B = `wp-dm-b-${ts}@gmail.com`;
const PW = "warm-paws-123";
const NICK_A = "测试员A", NICK_B = "测试员B";

/* T0 迁移前置检查：匿名拉会话列表，表不存在会报 42P01 */
{
  const { error } = await sbA0.rpc("dm_list_convs", { p_limit: 1, p_offset: 0 });
  if (error && /42P01|schema cache|Could not find the function/.test(String(error.code) + error.message)) {
    console.log("NEED_MIGRATION：MIGRATION_dm_notifications.sql 尚未在 Supabase 执行（" + error.message + "）。");
    process.exit(2);
  }
  ok("T0 RPC dm_list_convs 存在（匿名返回空列表或 auth-required）", true);
}

/* 注册 A / B（若项目开了邮箱确认则无法继续写操作） */
const signup = async (sb, email, nick) => {
  const { data, error } = await sb.auth.signUp({ email, password: PW, options: { data: { nickname: nick } } });
  if (error || !data || !data.session) return null;
  return data;
};
const sA = await signup(sbA0, EMAIL_A, NICK_A);
if (!sA) { console.log("NEED_VERIFY：项目开启了邮箱确认（注册无 session），无法做写操作 e2e。"); process.exit(2); }
const sbB0 = createClient(URL_, KEY, { auth: { persistSession: false } });
const sB = await signup(sbB0, EMAIL_B, NICK_B);
if (!sB) { console.log("NEED_VERIFY：B 注册无 session。"); process.exit(2); }
const uidA = sA.user.id, uidB = sB.user.id;
console.log(`账号就绪 A=${uidA.slice(0, 8)}… B=${uidB.slice(0, 8)}…`);
/* (待续1) */

/* 会话：找或建 + 幂等 */
let convId = 0;
{
  const { data, error } = await sbA0.rpc("dm_open", { p_other: uidB });
  ok("T1 dm_open 建会话", !error && data && data.conv_id > 0, error ? `(${error.message})` : `(conv=${data && data.conv_id})`);
  convId = data ? data.conv_id : 0;
  const { data: again } = await sbA0.rpc("dm_open", { p_other: uidB });
  ok("T1b 重复 open 幂等（同一会话）", again && again.conv_id === convId, `(conv=${again && again.conv_id})`);
}

/* 发消息 + 会话冗余 */
{
  const { data, error } = await sbA0.rpc("dm_send", { p_conv: convId, p_body: "你好B，这是一条私信", p_image: null });
  ok("T2 dm_send A→B", !error && data && data.msg_id > 0, error ? `(${error.message})` : `(msg=${data && data.msg_id})`);
}

/* B 视角：列表未读 / 消息内容 / 水位 */
{
  const { data: convs } = await sbB0.rpc("dm_list_convs", { p_limit: 50, p_offset: 0 });
  const mine = (convs || []).find((c) => c.conv_id === convId);
  ok("T3 B 会话列表含该会话", !!mine);
  ok("T3b B 未读=1", mine && mine.unread === 1, mine ? `(unread=${mine.unread})` : "");
  ok("T3c 昵称=A", mine && mine.nickname === NICK_A, mine ? `(${mine.nickname})` : "");
  ok("T3d B 是「消息请求」(accepted=false)", mine && mine.accepted === false);
  const { data: msgs } = await sbB0.rpc("dm_list_messages", { p_conv: convId, p_before: null, p_limit: 30 });
  ok("T4 B 拉到消息正文", (msgs || []).some((m) => m.body === "你好B，这是一条私信"));
  await sbB0.rpc("dm_mark_read", { p_conv: convId });
  const { data: convs2 } = await sbB0.rpc("dm_list_convs", { p_limit: 50, p_offset: 0 });
  const mine2 = (convs2 || []).find((c) => c.conv_id === convId);
  ok("T5 已读水位后 B 未读=0", mine2 && mine2.unread === 0, mine2 ? `(unread=${mine2.unread})` : "");
  const { data: aConvs } = await sbA0.rpc("dm_list_convs", { p_limit: 50, p_offset: 0 });
  const aMine = (aConvs || []).find((c) => c.conv_id === convId);
  ok("T5b A 侧未读=0（自己发的不算）", aMine && aMine.unread === 0);
  /* B 回复一条 → 解除首聊限制（#22：对方回复前 A 最多 3 条；后续用例 A 要连发多条） */
  const { data: bSend, error: bErr0 } = await sbB0.rpc("dm_send", { p_conv: convId, p_body: "B 收到啦", p_image: null });
  ok("T5c B 回复成功（解除首聊限制）", !bErr0 && bSend && bSend.msg_id > 0, bErr0 ? `(${bErr0.message})` : "");
  const { data: aConvs2 } = await sbA0.rpc("dm_list_convs", { p_limit: 50, p_offset: 0 });
  const aMine2 = (aConvs2 || []).find((c) => c.conv_id === convId);
  ok("T5d A 未读=1（B 的回复）", aMine2 && aMine2.unread === 1, aMine2 ? `(unread=${aMine2.unread})` : "");
}

/* dm 通知（#23 迁移后）：触发器拦截 dm 通知 —— 通知中心无私信条目/计数，
 * 私信红点只走聊天入口的 dm_unread_total（与导航 💬 角标同一来源） */
{
  const { data: u } = await sbB0.rpc("notif_unread");
  ok("T6 dm 通知被拦截（dms 恒 0）", u && u.dms === 0, `(dms=${u && u.dms})`);
  const { data: page } = await sbB0.rpc("notif_page", { p_offset: 0, p_limit: 10, p_kinds: "dm", p_unread: true });
  ok("T6b 通知页无 dm 行", (page || []).length === 0, `(rows=${(page || []).length})`);
  const { data: t0 } = await sbB0.rpc("dm_unread_total");
  ok("T6c B 已读后聊天角标=0", t0 && t0.total === 0, `(total=${t0 && t0.total})`);
}

/* 撤回（15 分钟窗口内） */
{
  const { data: sent } = await sbA0.rpc("dm_send", { p_conv: convId, p_body: "这条要撤回", p_image: null });
  const { data: rc, error: rcErr } = await sbA0.rpc("dm_recall", { p_msg: sent.msg_id });
  ok("T7 撤回成功", !rcErr && rc && rc.ok === true, rcErr ? `(${rcErr.message})` : "");
  const { data: msgs } = await sbB0.rpc("dm_list_messages", { p_conv: convId, p_before: null, p_limit: 30 });
  const recalled = (msgs || []).find((m) => m.id === sent.msg_id);
  ok("T7b 撤回后内容清空 + deleted_at", recalled && recalled.body === "" && !!recalled.deleted_at);
  const { data: convs } = await sbB0.rpc("dm_list_convs", { p_limit: 50, p_offset: 0 });
  const mine = (convs || []).find((c) => c.conv_id === convId);
  ok("T7c 预览变 ⟲", mine && mine.last_preview === "⟲", mine ? `(${mine.last_preview})` : "");
  const { error: notMine } = await sbB0.rpc("dm_recall", { p_msg: sent.msg_id });
  ok("T7d 非作者撤回被拒", !!notMine, notMine ? `(${notMine.message})` : "");
}
/* (待续2) */

/* 消息请求：B 接受 */
{
  const { data: acc } = await sbB0.rpc("dm_accept", { p_conv: convId });
  ok("T8 dm_accept", acc && acc.ok === true);
  const { data: convs } = await sbB0.rpc("dm_list_convs", { p_limit: 50, p_offset: 0 });
  const mine = (convs || []).find((c) => c.conv_id === convId);
  ok("T8b accepted=true", mine && mine.accepted === true);
}

/* 免打扰：muted 后 B 再收 A 消息 → 不产生新 dm 通知（红点仍在） */
{
  await sbB0.rpc("dm_mute", { p_conv: convId, p_on: true });
  const { data: before } = await sbB0.rpc("notif_unread");
  await sbA0.rpc("dm_send", { p_conv: convId, p_body: "免打扰期间的消息", p_image: null });
  const { data: after } = await sbB0.rpc("notif_unread");
  ok("T9 免打扰：dm 通知不增", before && after && after.dms === before.dms, `(before=${before && before.dms} after=${after && after.dms})`);
  const { data: convs } = await sbB0.rpc("dm_list_convs", { p_limit: 50, p_offset: 0 });
  const mine0 = (convs || []).find((c) => c.conv_id === convId);
  const unread0 = mine0 ? mine0.unread : 0;
  await sbA0.rpc("dm_send", { p_conv: convId, p_body: "免打扰后再发一条", p_image: null });
  const { data: convs2 } = await sbB0.rpc("dm_list_convs", { p_limit: 50, p_offset: 0 });
  const mine = (convs2 || []).find((c) => c.conv_id === convId);
  ok("T9b 红点照常 +1", mine && mine.unread === unread0 + 1, mine ? `(unread=${mine.unread})` : "");
  await sbB0.rpc("dm_mute", { p_conv: convId, p_on: false });
  await sbB0.rpc("dm_mark_read", { p_conv: convId });
}

/* 隐藏：B 隐藏后列表不见；A 再发一条 → 复活 */
{
  await sbB0.rpc("dm_hide", { p_conv: convId });
  let { data: convs } = await sbB0.rpc("dm_list_convs", { p_limit: 50, p_offset: 0 });
  ok("T10 隐藏后 B 列表不见", !(convs || []).some((c) => c.conv_id === convId));
  await sbA0.rpc("dm_send", { p_conv: convId, p_body: "把会话顶回来", p_image: null });
  ({ data: convs } = await sbB0.rpc("dm_list_convs", { p_limit: 50, p_offset: 0 }));
  ok("T10b 新消息复活", (convs || []).some((c) => c.conv_id === convId));
}

/* 未读总览（角标） */
{
  await sbB0.rpc("dm_mark_read", { p_conv: convId });
  const { data: t } = await sbB0.rpc("dm_unread_total");
  ok("T11 B 角标 total=0", t && t.total === 0, `(total=${t && t.total})`);
  await sbA0.rpc("dm_send", { p_conv: convId, p_body: "角标 +1", p_image: null });
  const { data: t2 } = await sbB0.rpc("dm_unread_total");
  ok("T11b B 角标 total=1", t2 && t2.total === 1, `(total=${t2 && t2.total})`);
}
/* (待续3) */

/* 拉黑：A 拉黑 B → 双向禁发；解除后恢复 */
{
  const { data: blk } = await sbA0.rpc("dm_block", { p_user: uidB });
  ok("T12 dm_block", blk && blk.ok === true);
  const { error: aErr } = await sbA0.rpc("dm_send", { p_conv: convId, p_body: "x", p_image: null });
  ok("T12b A 拉黑后自己发 → blocked-by-me", aErr && /blocked-by-me/.test(aErr.message), aErr ? `(${aErr.message})` : "");
  const { error: bErr } = await sbB0.rpc("dm_send", { p_conv: convId, p_body: "x", p_image: null });
  ok("T12c B 被 A 拉黑 → blocked", bErr && /blocked/.test(bErr.message), bErr ? `(${bErr.message})` : "");
  const { data: aConvs } = await sbA0.rpc("dm_list_convs", { p_limit: 50, p_offset: 0 });
  ok("T12d A 列表隐藏被拉黑会话", !(aConvs || []).some((c) => c.conv_id === convId));
  const { data: list } = await sbA0.rpc("dm_blocks");
  ok("T12e 拉黑名单含 B", (list || []).some((x) => x.user_id === uidB));
  await sbA0.rpc("dm_unblock", { p_user: uidB });
  const { error: okErr } = await sbA0.rpc("dm_send", { p_conv: convId, p_body: "解除拉黑后能发了", p_image: null });
  ok("T12f 解除后恢复发送", !okErr, okErr ? `(${okErr.message})` : "");
}

/* 边界：自己/不存在用户/空消息 */
{
  const { error: self } = await sbA0.rpc("dm_open", { p_other: uidA });
  ok("T13 自己 → bad-target", !!self && /bad-target/.test(self.message));
  const { error: ghost } = await sbA0.rpc("dm_open", { p_other: "00000000-0000-0000-0000-000000000000" });
  ok("T13b 不存在用户 → no-user", !!ghost && /no-user/.test(ghost.message));
  const { error: empty } = await sbA0.rpc("dm_send", { p_conv: convId, p_body: "   ", p_image: null });
  ok("T13c 空白消息 → empty-message", !!empty && /empty-message/.test(empty.message));
}

/* 通知触发器（线上验证）：A 发帖 → B 评论/回应/摸宠物 → A 分类计数上涨 */
{
  const { data: post, error: pErr } = await sbA0.from("wall_posts")
    .insert({ user_id: uidA, author_name: NICK_A, body: "触发器测试帖" }).select("*").single();
  ok("T14 A 发帖", !pErr && !!post, pErr ? `(${pErr.message})` : "");
  if (post) {
    const { data: u0 } = await sbA0.rpc("notif_unread");
    await sbB0.from("wall_comments").insert({ post_id: post.id, user_id: uidB, author_name: NICK_B, body: "触发 comment 通知" });
    const { data: u1 } = await sbA0.rpc("notif_unread");
    ok("T14b 评论触发 A 的 comment 通知", u0 && u1 && u1.comments === u0.comments + 1, `(${u0 && u0.comments}→${u1 && u1.comments})`);
    const { error: rErr } = await sbB0.from("wall_reactions")
      .insert({ post_id: post.id, user_id: uidB, kind: "hug" });
    ok("T14c B 回应成功", !rErr, rErr ? `(${rErr.message})` : "");
    const { data: u2 } = await sbA0.rpc("notif_unread");
    ok("T14d 回应触发 reaction 通知", u1 && u2 && u2.reactions === u1.reactions + 1);
    const { error: petErr } = await sbB0.rpc("pet_interact", { p_owner: uidA, p_kind: "pat", p_viewer: uidB });
    ok("T14e B 摸 A 的宠物", !petErr, petErr ? `(${petErr.message})` : "");
    const { data: u3 } = await sbA0.rpc("notif_unread");
    ok("T14f 宠物互动触发 pet 通知", u2 && u3 && u3.pets === u2.pets + 1);
    /* 评论触发器回复链路：A 评论自己帖，B 回复 A 的评论 → A 收 reply */
    const { data: aC } = await sbA0.from("wall_comments")
      .insert({ post_id: post.id, user_id: uidA, author_name: NICK_A, body: "A 的评论" }).select("*").single();
    if (aC) {
      await sbB0.from("wall_comments")
        .insert({ post_id: post.id, parent_id: aC.id, user_id: uidB, author_name: NICK_B, body: "B 的回复" });
      const { data: u4 } = await sbA0.rpc("notif_unread");
      ok("T14g 回复触发 reply 通知", u3 && u4 && u4.comments === u3.comments + 1);
    }
    /* 收尾清理：帖子删掉（评论/回应级联），A 清空自己的通知 */
    await sbA0.from("wall_posts").delete().eq("id", post.id);
    await sbA0.rpc("notif_mark", { p_ids: null, p_all: true });
  }
}
/* (待续4) */

/* 偏好开关：B 关掉 reactions → A 回应 B 的帖子不再产生通知；恢复 */
{
  const { data: post, error: pErr } = await sbB0.from("wall_posts")
    .insert({ user_id: uidB, author_name: NICK_B, body: "偏好测试帖" }).select("*").single();
  if (post) {
    await sbB0.rpc("notif_prefs_set", { p_comments: true, p_reactions: false, p_pets: true, p_dms: true });
    const { data: b0 } = await sbB0.rpc("notif_unread");
    await sbA0.from("wall_reactions").insert({ post_id: post.id, user_id: uidA, kind: "warm" });
    const { data: b1 } = await sbB0.rpc("notif_unread");
    ok("T15 关掉 reactions 后回应不再通知", b0 && b1 && b1.reactions === b0.reactions, `(${b0 && b0.reactions}→${b1 && b1.reactions})`);
    await sbB0.rpc("notif_prefs_set", { p_comments: true, p_reactions: true, p_pets: true, p_dms: true });
    const { data: prefs } = await sbB0.rpc("notif_prefs_get");
    ok("T15b 偏好恢复全开", prefs && prefs.reactions === true);
    await sbB0.from("wall_posts").delete().eq("id", post.id);
  } else ok("T15 偏好测试帖（跳过：发帖失败）", false, pErr ? `(${pErr.message})` : "");
}

/* 管理员广播：非管理员 → {admin:false} 不产生 system 通知 */
{
  const { data: before } = await sbB0.rpc("notif_unread");
  const { data: bc } = await sbA0.rpc("admin_broadcast", { p_body: "测试公告" });
  ok("T16 非管理员广播 → admin:false", bc && bc.admin === false, `(sent=${bc && bc.sent})`);
  const { data: after } = await sbB0.rpc("notif_unread");
  ok("T16b 无 system 通知产生", before && after && after.system === before.system);
}

/* 匿名 RLS：读不到任何私信行，RPC 全被拒 */
{
  const sbAnon = createClient(URL_, KEY, { auth: { persistSession: false } });
  const { data: rows } = await sbAnon.from("dm_messages").select("id").limit(5);
  ok("T17 匿名读 dm_messages 为空", Array.isArray(rows) && rows.length === 0, `(got ${(rows || []).length})`);
  const err = await rpcErr(sbAnon, "dm_send", { p_conv: convId, p_body: "anon", p_image: null });
  ok("T17b 匿名 dm_send → auth-required", /auth-required/.test(err), `(${err})`);
}

console.log(`\ndm-e2e: ${pass} pass, ${fail} fail`);
if (fail) process.exit(1);




