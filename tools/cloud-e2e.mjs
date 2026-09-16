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

/* T9b 主页数据匿名可读：/u/:id 页面的取数口径（profiles + 该用户未下架帖子） */
{
  const { data: pf, error: pe } = await sbAnon.from("profiles")
    .select("nickname,created_at").eq("id", uid).maybeSingle();
  let up = null, ue = null;
  ({ data: up, error: ue } = await sbAnon.from("wall_posts")
    .select("id").eq("user_id", uid).eq("removed", false));
  if (ue) {
    /* 未跑迁移（无 removed 列）时退回不过滤的查询，与 cloudFetchUserPosts 的降级一致 */
    ({ data: up, error: ue } = await sbAnon.from("wall_posts").select("id").eq("user_id", uid));
  }
  ok("T9b 主页数据匿名可读（profiles + 该用户帖子）",
    !pe && !!pf && pf.nickname === NICK && !ue && Array.isArray(up) && up.length >= 1,
    pe ? pe.message : (ue ? ue.message : "posts=" + (up ? up.length : -1)));
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

/* T16~T25 进阶规则实测：浏览去重 / 厌恶→1% 下架 / 每人每天一条（未迁移则 SKIP） */
let hasAdvanced = false;
{
  const { error } = await sb.from("wall_posts").select("views,dislikes,removed,created_day").limit(1);
  hasAdvanced = !error;
  if (hasAdvanced) { pass++; console.log("PASS  T16 迁移已就绪（wall_posts.views/dislikes/removed/created_day 存在）"); }
  else console.log("SKIP  T16 未跑 MIGRATION_wall_daily_view_dislike.sql：跳过进阶规则测试（" + error.message + "）");
}

if (hasAdvanced) {
  /* T17/T18 浏览计数：不锁死绝对总数 —— 测试帖会短暂出现在真实暖心墙上，
     真实访客的页面本来就会记浏览（且 RLS 没给测试改 views 的口子）。
     每个断言只锁「本次调用该发生什么」：counted 标志与「只涨不跌」 */
  {
    const { data: before } = await sb.from("wall_posts").select("views").eq("id", postId).maybeSingle();
    const v0 = before ? before.views : 0;
    const vk = "e2e-viewer-" + Date.now();          // 每次运行用新访客键：同日重跑不被去重挡住
    const v1 = await sb.rpc("wall_add_view", { p_post: postId, p_viewer: vk });
    const v2 = await sb.rpc("wall_add_view", { p_post: postId, p_viewer: vk });
    const counted = [v1.data && v1.data.counted, v2.data && v2.data.counted];
    const views = v1.data ? v1.data.views : -1;
    ok("T17 同一访客同一天只记一次浏览（第二次 counted=false，浏览数不再因 TA 上涨）",
      !v1.error && !v2.error && counted[0] === true && counted[1] === false && views >= v0 + 1,
      "views " + v0 + " → " + views + " counted=" + JSON.stringify(counted));
  }
  {
    const r = await sb.rpc("wall_add_view", { p_post: postId, p_viewer: "e2e-viewer-b-" + Date.now() });
    ok("T18 不同访客各算一次浏览（counted=true；总量因真实访客浮动，不锁死）",
      !r.error && r.data && r.data.counted === true,
      r.error ? r.error.message : "counted=true, views=" + (r.data ? r.data.views : "?"));
  }

  /* T19~T22 厌恶切换 + 1% 自动下架（假删除）。
     下架取决于「厌恶数 ÷ 浏览数 ≥ 1%」：1 个厌恶在 views≤100 时必下架；views>100 时
     比例不足 1%（真实访客把分母推大了），此时跳过 removed 断言 —— 阈值逻辑已由
     wall-rules-test.mjs 的纯函数单测覆盖，这里验证服务端把计数与状态写对 */
  {
    const on = await sb.rpc("wall_toggle_dislike", { p_post: postId });
    const removed = !!(on.data && on.data.removed);
    const views = on.data ? on.data.views : 0;
    const canJudge = views > 0 && views <= 100;
    ok("T19 厌恶生效：服务端重数并把 dislikes 写回帖子",
      !on.error && on.data && on.data.on === true && on.data.dislikes === 1,
      on.error ? on.error.message : JSON.stringify(on.data));
    if (!canJudge) {
      console.log("SKIP  T19b 下架判定：此刻 views=" + views + "（1 个厌恶不足 1%），跳过 removed 断言");
    } else {
      ok("T19b 达到 1% 即下架（removed=true）", removed === true, "views=" + views);
    }

    /* 帖子行仍在库里（假删除：前台看不见，数据没丢） */
    const { data: row } = await sb.from("wall_posts").select("removed,views,dislikes").eq("id", postId).maybeSingle();
    ok("T20 假删除：行还在，dislikes 已写回（不是物理删除）",
      !!row && row.dislikes === 1 && row.removed === removed, row ? JSON.stringify(row) : "行不见了?!");

    /* 取消厌恶：计数回 0；下架不因取消而自动恢复（避免帖子忽隐忽现） */
    const off = await sb.rpc("wall_toggle_dislike", { p_post: postId });
    ok("T21 取消厌恶：dislikes 归零" + (removed ? "，下架状态保持（不自动恢复）" : "，未下架状态不变"),
      !off.error && off.data && off.data.on === false && off.data.dislikes === 0 && off.data.removed === removed,
      off.error ? off.error.message : JSON.stringify(off.data));

    if (removed) {
      /* 看板的读写路径都不该再看到它（已跑迁移时查询带 removed=false 过滤） */
      const { data: visible } = await sb.from("wall_posts").select("id").eq("removed", false).eq("id", postId);
      ok("T22 下架帖不出现在「未下架」查询里（前台动态流的取数口径）",
        !visible || visible.length === 0, "visible rows=" + (visible ? visible.length : -1));
    }
  }

  /* T23~T25 每个用户每天最多一条 */
  {
    const { error: e1 } = await sb.from("wall_posts")
      .insert({ user_id: uid, author_name: NICK, body: "同一天的第二条应该被拒" });
    ok("T23 同日第二条被触发器拒绝（wall_daily_limit）",
      !!e1 && String(e1.message).includes("wall_daily_limit"), e1 ? e1.message : "竟然插进去了?!");

    /* 限额是「每天一条」而不是「终身一条」：删掉今天的帖后可以再发 */
    await sb.from("wall_posts").delete().eq("id", postId);
    const { data: again, error: e2 } = await sb.from("wall_posts")
      .insert({ user_id: uid, author_name: NICK, body: "删掉旧帖后重新发" })
      .select("*").single();
    ok("T24 删掉今天的帖后可以重新发（限额按天算，历史帖数清了就放开）",
      !e2 && !!again, e2 ? e2.message : "");
    if (again) postId = again.id;

    /* created_day 由数据库自动填（UTC 日） */
    const { data: day } = await sb.from("wall_posts").select("created_day").eq("id", postId).maybeSingle();
    ok("T25 created_day 自动填 UTC 日（前端与库判「今天」口径一致）",
      !!day && typeof day.created_day === "string" && day.created_day.length === 10,
      day ? "created_day=" + day.created_day : "");
  }
}

/* T26~T28 宠物主页实测：镜像同步 / 匿名可读 / 访客互动去重（未跑迁移则 SKIP） */
{
  const { error } = await sb.from("pet_profiles").select("data").limit(1);
  const hasPet = !error;
  if (hasPet) { pass++; console.log("PASS  T26 迁移已就绪（pet_profiles 存在）"); }
  else console.log("SKIP  T26 未跑迁移（pet_profiles 不存在）：跳过宠物主页测试（" + error.message + "）");

  if (hasPet) {
    const SNAP = {
      pet: { species: "cat", name: "云麻薯", personality: "粘人", level: 3, sleeping: false, custom: null },
      dishes: [{ id: "d1", name: "小鱼干", img: "data:image/jpeg;base64,e2e", effort: 2 }],
      counts: { pats: 0, feeds: 0 },
      updated: Date.now(),
    };
    await sb.from("pet_profiles").upsert({ user_id: uid, data: SNAP, updated_at: new Date().toISOString() });

    /* 匿名可读（主页是公开面），且私人字段没有跟着上来 */
    const { data: pub } = await sbAnon.from("pet_profiles").select("data").eq("user_id", uid).maybeSingle();
    ok("T27 宠物快照匿名可读（访客看得到 TA 的伙伴与厨房）",
      !!pub && pub.data && pub.data.pet && pub.data.pet.name === "云麻薯" && pub.data.dishes.length === 1,
      pub && pub.data && pub.data.pet ? "pet=" + pub.data.pet.name : "读不到");

    /* 访客互动：同人同日同类型只计一次 */
    const p1 = await sb.rpc("pet_interact", { p_owner: uid, p_kind: "pat", p_viewer: "e2e-viewer-1" });
    const p2 = await sb.rpc("pet_interact", { p_owner: uid, p_kind: "pat", p_viewer: "e2e-viewer-1" });
    ok("T28 摸摸头：首次 counted=true，同访客当天第二次不计",
      !p1.error && !p2.error && p1.data.counted === true && p2.data.counted === false
        && p1.data.counts.pats === 1,
      p1.error ? p1.error.message : JSON.stringify(p2.data && p2.data.counts));

    const f1 = await sb.rpc("pet_interact", { p_owner: uid, p_kind: "feed", p_viewer: "e2e-viewer-1" });
    ok("T29 投喂与摸头分开计数（同访客同日各自一次）",
      !f1.error && f1.data && f1.data.counted === true && f1.data.counts.feeds === 1 && f1.data.counts.pats === 1,
      f1.error ? f1.error.message : JSON.stringify(f1.data && f1.data.counts));
  }
}

/* 清理：删帖（cascade 带走回应/浏览记录），删除宠物主页与档案 */
{
  await sb.from("wall_posts").delete().eq("id", postId);
  await sb.from("pet_profiles").delete().eq("user_id", uid);
  await sb.from("profiles").delete().eq("id", uid);
  console.log("清理完成（测试帖/宠物主页/档案已删）");
}

console.log("\nTOTAL " + (pass + fail) + "  PASS " + pass + "  FAIL " + fail);
process.exit(fail ? 1 : 0);
