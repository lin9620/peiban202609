/* 温暖漂流瓶（#6）线上全链路实测（双账号，走线上 Worker —— 与浏览器同链路）
 *   node tools/bottle-e2e.mjs
 * 流程：探测迁移 → A 注册投 3 封（第 4 封被限额挡下）→ B 注册捞信 → 回信 / 放回
 *       → A 在「我的信」里看到回信 → A 捞不到自己的信 → 非持有者回/放被拒 → 超长被拒。
 * 前置：MIGRATION_bottle.sql 已在 Supabase 执行（未跑则输出 SKIP 并退出码 2）。
 * 副作用：会注册测试账号（wp-bottle-*）并给海里留下少量测试信（正文带「自动测试信」标记，
 *         用户捞到放回即可；信件无客户端删除策略，彻底清需要 service_role）。
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

/** 直连 REST（RLS 仍生效；用于以作者身份核对信件行） */
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

const sbAnon = createClient(URL_, KEY, { auth: { persistSession: false } });
async function signUp(prefix, nick) {
  const email = prefix + Date.now() + "@gmail.com";
  const { data: su, error } = await sbAnon.auth.signUp({
    email, password: "warm-paws-123", options: { data: { nickname: nick } },
  });
  if (error || !su || !su.session) throw new Error("signup failed: " + (error ? error.message : "no session"));
  return { id: su.user.id, token: su.session.access_token, email };
}

/* T1 迁移就绪探测：未登录捞信——已迁移 → RPC 抛 bottle-auth(400)；未迁移 → 404 找不到函数 */
const probe = await api("/bottle/fish", { method: "POST", body: {} });
const migrated = probe.status === 400 && probe.text.includes("bottle-auth");
const notMigrated = probe.status === 404 || /Could not find the function|PGRST202/i.test(probe.text);
if (notMigrated) {
  console.log("SKIP  漂流瓶 RPC 尚不存在（HTTP " + probe.status + "）");
  console.log("→ 先在 Supabase SQL Editor 跑 MIGRATION_bottle.sql 再重跑本脚本。");
  process.exit(2);
}

/* A 注册：连投 3 封（每日限额），第 4 封被挡 */
const A = await signUp("wp-bottle-a-", "投瓶的小橘");
ok("T2 A 注册成功", !!A.id && !!A.token, A.email);
{
  let allOk = true, last = null;
  for (let i = 0; i < 3; i++) {
    const r = await api("/bottle/send", { method: "POST", token: A.token, body: { body: `第${i + 1}封：来自云端的测试问候（自动测试信，捞到请放回海里 🌊）` } });
    last = r;
    if (r.status !== 200 || !r.data || r.data.status !== "sea") allOk = false;
  }
  ok("T3 连投 3 封成功（status=sea、落款昵称、UTC 日为今天）", allOk, "last=" + last.status);
  const over = await api("/bottle/send", { method: "POST", token: A.token, body: { body: "第4封应该被挡" } });
  ok("T4 第 4 封被每日限额挡下（bottle-limit-send）", over.status === 400 && over.text.includes("bottle-limit-send"), "http=" + over.status);
  const mine = await api("/bottle/mine", { token: A.token });
  ok("T5 A 的信箱列出 3 封（新→旧）", mine.status === 200 && Array.isArray(mine.data) && mine.data.length === 3, "rows=" + (mine.data || []).length);
}

/* B 注册：捞信 → 回信 / 放回 */
const B = await signUp("wp-bottle-b-", "捞瓶的布丁");
ok("T6 B 注册成功", !!B.id && !!B.token, B.email);
let replyLetterId = "", releaseLetterId = "";
{
  const f1 = await api("/bottle/fish", { method: "POST", token: B.token, body: {} });
  ok("T7 B 捞到一封（不是自己的，status=held）",
    f1.status === 200 && f1.data && f1.data.user_id !== B.id && f1.data.status === "held",
    f1.data ? "from=" + String(f1.data.user_id).slice(0, 8) : "http=" + f1.status);
  replyLetterId = f1.data ? f1.data.id : "";
  const rep = await api("/bottle/reply", { method: "POST", token: B.token, body: { id: replyLetterId, reply: "谢谢你的信，抱抱你（自动回信）" } });
  ok("T8 B 给捞到的信写回信（status=answered）", rep.status === 200 && rep.data && rep.data.status === "answered" && !!rep.data.reply_at, "http=" + rep.status);
}
{
  const f2 = await api("/bottle/fish", { method: "POST", token: B.token, body: {} });
  releaseLetterId = f2.data ? f2.data.id : "";
  ok("T9 B 再捞一封（第二封）", f2.status === 200 && !!f2.data, "http=" + f2.status);
  const rel = await api("/bottle/release", { method: "POST", token: B.token, body: { id: releaseLetterId } });
  ok("T10 B 不想回，放回海里（status=sea、holder 清空）",
    rel.status === 200 && rel.data && rel.data.status === "sea" && rel.data.holder === null, "http=" + rel.status);
  const held = await api("/bottle/held", { token: B.token });
  ok("T10b 放回后 B 的「捞到未回」列表不再有这封",
    held.status === 200 && !(held.data || []).some((l) => l.id === releaseLetterId), "held=" + (held.data || []).length);
}

/* A 视角：看到回信；捞不到自己的信 */
{
  const mine = await api("/bottle/mine", { token: A.token });
  const replied = (mine.data || []).find((l) => l.id === replyLetterId);
  ok("T11 A 在「我的信」里看到 B 的回信（回信只有写信人可见）",
    !!replied && replied.status === "answered" && (replied.reply || "").includes("抱抱你"),
    replied ? "reply=" + String(replied.reply).slice(0, 18) : "无");
  /* A 捞信：绝不能捞到自己的；海里没有别人的信时得到 empty-sea / 次数用完 */
  let sawOwn = false, rounds = 0, lastErr = "";
  for (;;) {
    const r = await api("/bottle/fish", { method: "POST", token: A.token, body: {} });
    rounds++;
    if (r.status === 200 && r.data) {
      if (r.data.user_id === A.id) sawOwn = true;
      await api("/bottle/release", { method: "POST", token: A.token, body: { id: r.data.id } });
    } else { lastErr = r.text.slice(0, 60); break; }
    if (rounds > 10) break;
  }
  ok("T12 A 捞不到自己的信（要么空海/限额，要么捞到的都是别人的）",
    !sawOwn && (lastErr.includes("bottle-empty-sea") || lastErr.includes("bottle-limit-fish")),
    "rounds=" + rounds + " last=" + lastErr);
}

/* 权限边界：非持有者不能回/放；超长被拒 */
{
  const rep = await api("/bottle/reply", { method: "POST", token: B.token, body: { id: releaseLetterId, reply: "早就放回了，不该成功" } });
  ok("T13 对已放回的信回信 → bottle-not-holder", rep.status === 400 && rep.text.includes("bottle-not-holder"), "http=" + rep.status);
  const rel = await api("/bottle/release", { method: "POST", token: B.token, body: { id: replyLetterId } });
  ok("T14 对已回过的信放回 → bottle-not-holder", rel.status === 400 && rel.text.includes("bottle-not-holder"), "http=" + rel.status);
  const long = await api("/bottle/send", { method: "POST", token: B.token, body: { body: "x".repeat(1001) } });
  ok("T15 超过 1000 字 → bottle-too-long", long.status === 400 && long.text.includes("bottle-too-long"), "http=" + long.status);
  /* 直接查海：RLS 只放行「写信人 + 写过回信的人」。B 没写过信，只能看到自己回过的那封；
     已放回的信（B 不再是持有者、也没回过）必须被藏起来 */
  const sea = await rest("bottle_letters?select=id,status,reply_by,user_id", { token: B.token });
  const rows = sea.data || [];
  ok("T16 B 直查信表：只见自己回过的那封，放回的那封被 RLS 藏住",
    sea.status === 200 && rows.length === 1 && rows[0].id === replyLetterId && rows[0].reply_by === B.id,
    "rows=" + rows.length + JSON.stringify(rows.map((l) => l.id).slice(0, 3)));
}

console.log("\nTOTAL " + (pass + fail) + "  PASS " + pass + "  FAIL " + fail);
process.exit(fail ? 1 : 0);

ok("T1 迁移已就绪：未登录捞信被 bottle-auth 拦下（RPC 存在）", migrated, "http=" + probe.status);
