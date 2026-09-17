/* 陪你大厅状态（#4 状态上云）线上全链路实测
 *   node tools/status-e2e.mjs
 * 走线上 Worker（https://dale.de5.net/api/*）—— 与浏览器完全同一条链路：
 *   注册 → 写状态（Worker 白名单 + 服务端盖章 + RLS self update）→ 状态流读回
 *   → 非法 key 被拒 → 匿名改不动 → 他人改不动 → 24h 窗口过期隐去 → 清除 → 清理。
 * 前置：MIGRATION_profile_status.sql 已在 Supabase 执行（未跑则输出 SKIP 并退出码 2）。
 * 副作用：会注册几个测试账号（邮箱名 wp-status-*），结束前把状态清空（profiles 无 delete 策略，
 *         客户端删不掉行 —— 行留存但不在状态流里可见；要彻底清行需 service_role）。
 */
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = fs.readFileSync(path.join(root, ".env"), "utf8");
const get = (k) => { const m = env.match(new RegExp("^\\s*" + k + "\\s*=\\s*(\\S+)\\s*$", "m")); return m ? m[1] : ""; };
const URL_ = get("VITE_SUPABASE_URL"), KEY = get("VITE_SUPABASE_ANON_KEY");
const BASE = "https://dale.de5.net/api";

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => {
  if (c) { pass++; console.log("PASS  " + n + (extra ? "  " + extra : "")); }
  else { fail++; console.log("FAIL  " + n + (extra ? "  " + extra : "")); }
};

/** Worker 调用：token 有就带（浏览器里也是这样） */
async function api(p, { method = "GET", body, token } = {}) {
  const r = await fetch(BASE + p, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: "Bearer " + token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  return { status: r.status, data, text };
}

/** 绕过 Worker 直连 REST（用于伪造 status_at 检验 24h 窗口；RLS 仍会执行） */
async function rest(p, { method = "GET", body, token } = {}) {
  const r = await fetch(URL_ + "/rest/v1/" + p, {
    method,
    headers: {
      apikey: KEY,
      ...(token ? { authorization: "Bearer " + token } : {}),
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  return { status: r.status, data, text };
}

/* T1 迁移就绪探测：没跑迁移就没必要继续（线上应 200 []，未跑时 400 42703） */
const probe = await api("/statuses?limit=1");
if (probe.status !== 200) {
  console.log("SKIP  线上 /api/statuses 非 200（" + probe.status + " " + probe.text.slice(0, 80) + "）");
  console.log("→ 先在 Supabase SQL Editor 跑 MIGRATION_profile_status.sql 再重跑本脚本。");
  process.exit(2);
}
ok("T1 迁移已就绪：线上 /api/statuses 返回 200", probe.status === 200, "status=" + probe.status);

/* 注册测试账号（沿用 cloud-e2e 的套路） */
const email = "wp-status-" + Date.now() + "@gmail.com";
const NICK = "大厅测试员";
const sbAnon = createClient(URL_, KEY, { auth: { persistSession: false } });
const { data: su, error: suErr } = await sbAnon.auth.signUp({
  email, password: "warm-paws-123", options: { data: { nickname: NICK } },
});
if (suErr || !su || !su.session) {
  console.log("NEED_VERIFY 项目开启了邮箱确认（注册无 session），无法做写操作 e2e。");
  console.log("(auth error: " + (suErr ? suErr.message : "no session") + ")");
  process.exit(2);
}
const uid = su.user.id, token = su.session.access_token;
ok("T2 邮箱注册成功并拿到 JWT", !!uid && !!token, email);

/* 兜底：脚本中途崩溃也要让测试档案「不可见」。
   注意：profiles 没有 delete 策略（客户端删行返回 204 但 0 行生效），
   所以真正的清理是「把 status 置回 null」——行留存但不在状态流里。 */
process.on("uncaughtException", async (e) => {
  console.error("\n崩溃：" + e.message + "\n→ 先清空测试状态再退出");
  try {
    await api("/users/" + uid + "/status", { method: "PATCH", body: { status: null }, token });
    console.log("已清空测试状态（档案行 " + uid + " 留存，需 service_role 才能删行）");
  } catch (x) { console.log("清理失败，请手动把 " + uid + " 的 status 置 null"); }
  process.exit(1);
});

/* T3 初始档案：状态列为 null（主页徽章此时不该显示） */
{
  const r = await api("/users/" + uid + "/profile");
  ok("T3 档案含状态字段且初始为 null（Worker 查新列成功）",
    r.status === 200 && r.data && r.data.nickname === NICK && r.data.status === null && r.data.status_at === null,
    JSON.stringify(r.data));
}

/* T4 写状态：204 + 服务端盖章 status_at ≈ 现在 */
const t0 = Date.now();
{
  const w = await api("/users/" + uid + "/status", { method: "PATCH", body: { status: "working" }, token });
  const row = await rest("profiles?select=status,status_at&id=eq." + uid);
  const rec = row.data && row.data[0];
  const at = rec && rec.status_at ? Date.parse(rec.status_at) : NaN;
  ok("T4 PATCH 状态 → 204", w.status === 204, "status=" + w.status + " " + w.text.slice(0, 60));
  ok("T4b 库内写入正确：status=working 且 status_at 由服务端盖章（±60s）",
    !!rec && rec.status === "working" && Math.abs(at - t0) < 60000,
    "row=" + JSON.stringify(rec));
}

/* T5 状态流读回：近 24h 窗口里能找到我（带昵称） */
{
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const r = await api("/statuses?limit=30&since=" + encodeURIComponent(since));
  const mine = Array.isArray(r.data) ? r.data.find((x) => x.id === uid) : null;
  ok("T5 状态流包含我（id/nickname/status/status_at 齐全）",
    r.status === 200 && !!mine && mine.status === "working" && mine.nickname === NICK && !!mine.status_at,
    "mine=" + JSON.stringify(mine));
  ok("T5b 状态流按 status_at 倒序、且不含未设置状态的用户",
    Array.isArray(r.data) && r.data.every((x) => x.status && x.status_at)
      && r.data.every((x, i) => i === 0 || Date.parse(r.data[i - 1].status_at) >= Date.parse(x.status_at)),
    "rows=" + (Array.isArray(r.data) ? r.data.length : "?"));
}

/* T6 白名单：Worker 层拒绝不在 STATUS_KEYS 里的 key 与超长 key */
{
  const bad = await api("/users/" + uid + "/status", { method: "PATCH", body: { status: "coding" }, token });
  const long = await api("/users/" + uid + "/status", { method: "PATCH", body: { status: "x".repeat(120) }, token });
  ok("T6 白名单外 key（coding）→ 400", bad.status === 400, "status=" + bad.status);
  ok("T6b 超长未知 key → 400", long.status === 400, "status=" + long.status);
}

/* T7 匿名改不动（RLS self update 兜底） */
{
  const r = await api("/users/" + uid + "/status", { method: "PATCH", body: { status: "chilling" } });
  const row = await rest("profiles?select=status&id=eq." + uid);
  const now = row.data && row.data[0] && row.data[0].status;
  ok("T7 匿名 PATCH 状态无效（我的状态仍是 working）",
    r.status !== 204 || now === "working", "http=" + r.status + " status=" + now);
}

/* T8 他人改不动：新账号拿自己的 JWT 去改我的行 */
{
  const { data: su2 } = await sbAnon.auth.signUp({
    email: "wp-status-b-" + Date.now() + "@gmail.com", password: "warm-paws-123",
    options: { data: { nickname: "路人乙" } },
  });
  const token2 = su2 && su2.session ? su2.session.access_token : "";
  const r = await api("/users/" + uid + "/status", { method: "PATCH", body: { status: "sleepless" }, token: token2 });
  const row = await rest("profiles?select=status&id=eq." + uid);
  const now = row.data && row.data[0] && row.data[0].status;
  ok("T8 别人用自己 JWT 改我的状态无效（RLS 挡住）",
    !!token2 && now === "working", "http=" + r.status + " status=" + now + " otherToken=" + !!token2);
  /* 乙账号的状态清空（RLS 无 delete 策略，行删不掉；清空后不在状态流里可见） */
  if (su2 && su2.user) await rest("profiles?id=eq." + su2.user.id, { method: "PATCH", body: { status: null }, token: token2 });
}

/* T9 24h 窗口：把 status_at 改到 25h 前 → 默认窗口看不到，放大窗口又能看到 */
const old = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
{
  await rest("profiles?id=eq." + uid, { method: "PATCH", body: { status_at: old }, token });
  const w24 = await api("/statuses?limit=30&since=" + encodeURIComponent(new Date(Date.now() - 24 * 3600 * 1000).toISOString()));
  const w48 = await api("/statuses?limit=30&since=" + encodeURIComponent(new Date(Date.now() - 48 * 3600 * 1000).toISOString()));
  const in24 = Array.isArray(w24.data) && w24.data.some((x) => x.id === uid);
  const in48 = Array.isArray(w48.data) && w48.data.some((x) => x.id === uid);
  ok("T9 25h 前的状态在 24h 窗口里自动隐去（前端「过期不显示」的依据）", !in24, "in24=" + in24);
  ok("T9b 放大到 48h 窗口又能读到（是窗口过滤，不是数据丢失）", in48, "in48=" + in48);
}

/* T10 清除：status=null → 204，状态流不再有我；主页徽章回到 null */
{
  const w = await api("/users/" + uid + "/status", { method: "PATCH", body: { status: null }, token });
  const r = await api("/statuses?limit=30&since=" + encodeURIComponent(new Date(Date.now() - 48 * 3600 * 1000).toISOString()));
  const mine = Array.isArray(r.data) ? r.data.find((x) => x.id === uid) : null;
  const p = await api("/users/" + uid + "/profile");
  ok("T10 清除状态 → 204", w.status === 204, "status=" + w.status);
  ok("T10b 清除后不在任何窗口的状态流里（status=not.is.null 过滤生效）", !mine, "mine=" + JSON.stringify(mine));
  ok("T10c 主页徽章数据源回到 null（清除后不显示）",
    p.status === 200 && p.data && p.data.status === null, "status=" + (p.data && p.data.status));
}

/* T11 切换：不同 key 反复写都 OK（「再点一次清除」的交互依赖这个） */
{
  const a = await api("/users/" + uid + "/status", { method: "PATCH", body: { status: "studying" }, token });
  const row = await rest("profiles?select=status&id=eq." + uid);
  const s1 = row.data && row.data[0] && row.data[0].status;
  const b = await api("/users/" + uid + "/status", { method: "PATCH", body: { status: null }, token });
  const row2 = await rest("profiles?select=status&id=eq." + uid);
  const s2 = row2.data && row2.data[0] && row2.data[0].status;
  ok("T11 working→studying→null 的切换都按预期落库",
    a.status === 204 && s1 === "studying" && b.status === 204 && s2 === null, "s1=" + s1 + " s2=" + s2);
}

/* 清理：置空状态（RLS 无 delete 策略，客户端删不掉行 —— 行留存但已不可见） */
{
  await api("/users/" + uid + "/status", { method: "PATCH", body: { status: null }, token });
  const r = await api("/statuses?limit=50&since=" + encodeURIComponent(new Date(Date.now() - 48 * 3600 * 1000).toISOString()));
  const gone = !(Array.isArray(r.data) && r.data.some((x) => x.id === uid));
  console.log(gone
    ? "清理完成（测试状态已清空，状态流无残留；档案行 " + uid + " 留存）"
    : "清理提示：状态流仍有残留，需手动确认 " + uid);
}

console.log("\nTOTAL " + (pass + fail) + "  PASS " + pass + "  FAIL " + fail);
process.exit(fail ? 1 : 0);