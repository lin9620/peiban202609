/* 轮 365 · 管理中心最近 24 小时日活
 *   node tools/admin-dau-test.mjs
 *
 * 锁四件事：
 *   1) SQL 用 auth.users.last_sign_in_at 的滚动 24h 窗口，不是注册时间/自然日；
 *   2) admin_overview 返回 dau_24h + recent_logins，admin_users_page 返回 last_sign_in_at；
 *   3) 前端卡片、最近登录面板、用户名单都接上这些字段；
 *   4) 中英文案成对，且空数据有兜底。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { messages } from "../src/i18n.js";
import { ratePct } from "../src/utils/admin.js";

const VIEW = fs.readFileSync("src/views/AdminView.vue", "utf8");
const CSS = fs.readFileSync("src/style.css", "utf8");
const SQL = fs.readFileSync("MIGRATION_admin_dau.sql", "utf8");
const SETUP = fs.readFileSync("SUPABASE_SETUP.sql", "utf8");

let pass = 0;
const fails = [];
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fails.push(name + " —— " + e.message); } };

t("D1 SQL 按 last_sign_in_at 的滚动 24h 统计，去重且只算有 profiles 的账户", () => {
  assert.match(SQL, /last_sign_in_at\s*>=\s*now\(\)\s*-\s*interval\s*'24 hours'/i,
    "没有滚动 24h 条件");
  assert.match(SQL, /count\(distinct\s+u\.id\)/i, "DAU 没有按账户去重");
  assert.match(SQL, /join\s+public\.profiles\s+p\s+on\s+p\.id\s*=\s*u\.id/i,
    "DAU 没有和 profiles 同口径 join");
  assert.doesNotMatch(SQL, /dau_24h[\s\S]{0,240}created_at/i,
    "DAU 误用了注册时间 created_at");
});

t("D2 admin_overview 返回 dau_24h / recent_logins", () => {
  assert.match(SQL, /'dau_24h'\s*,/);
  assert.match(SQL, /'recent_logins'\s*,/);
  assert.match(SQL, /order\s+by\s+u\.last_sign_in_at\s+desc/i, "最近登录没有按时间倒序");
  assert.match(SQL, /limit\s+8/i, "最近登录没有限制条数");
  assert.match(SQL, /'last_sign_in_at'\s*,\s*u\.last_sign_in_at/i);
});

t("D3 admin_users_page 补 last_sign_in_at（用户名单可核对）", () => {
  const usersFn = SQL.slice(SQL.indexOf("function public.admin_users_page"));
  assert.match(usersFn, /'last_sign_in_at'\s*,\s*u\.last_sign_in_at/i);
});

t("D4 新库 SUPABASE_SETUP 与迁移同口径", () => {
  assert.match(SETUP, /'dau_24h'\s*,/);
  assert.match(SETUP, /'recent_logins'\s*,/);
  assert.match(SETUP, /last_sign_in_at\s*>=\s*now\(\)\s*-\s*interval\s*'24 hours'/i);
  assert.match(SETUP, /'last_sign_in_at'\s*,\s*u\.last_sign_in_at/i);
});

t("D5 前端总览卡 / 最近登录面板接上字段", () => {
  assert.match(VIEW, /dauReady = computed\(\(\) => !!\(ov\.value && Object\.prototype\.hasOwnProperty\.call\(ov\.value, "dau_24h"\)\)\)/);
  assert.match(VIEW, /ratePct\(ov\.value && ov\.value\.dau_24h, ov\.value && ov\.value\.users_total\)/);
  assert.match(VIEW, /value:\s*dauReady\.value \? fmtNum\(o\.dau_24h\) : "—"/);
  assert.match(VIEW, /t\("admin\.cards\.dau"\)/);
  assert.match(VIEW, /ov\.value && ov\.value\.recent_logins/);
  assert.match(VIEW, /t\("admin\.recentLogins\.title"\)/);
  assert.match(VIEW, /u\.last_sign_in_at/);
});

t("D6 用户名单行显示最近登录（不再只显示注册时间）", () => {
  assert.match(VIEW, /t\("admin\.usersCol\.lastLogin"\)/);
  assert.match(VIEW, /dayTimeOf\(u\.last_sign_in_at\)/);
  assert.match(VIEW, /u\.last_sign_in_at === undefined \? "—"/, "迁移未跑时没有显示未知");
});

t("D7 中英文案成对，空数据/占比有兜底", () => {
  for (const lang of ["en", "zh"]) {
    const a = messages[lang].admin;
    assert.ok(a.cards.dau, `${lang} cards.dau 缺失`);
    assert.ok(a.cards.dauSub.includes("{p}"), `${lang} cards.dauSub 缺 {p}`);
    assert.ok(a.cards.dauPending, `${lang} cards.dauPending 缺失`);
    assert.ok(a.recentLogins.title && a.recentLogins.hint && a.recentLogins.empty,
      `${lang} recentLogins 文案不全`);
    assert.ok(a.usersCol.lastLogin && a.usersCol.never, `${lang} usersCol 最近登录文案不全`);
  }
});

t("D9 手机用户名单不把昵称/最近登录挤成竖排单字", () => {
  const m = CSS.match(/@media \(max-width: 640px\) \{[\s\S]*?\n\}/);
  assert.ok(m, "找不到 640px 媒体查询");
  assert.match(m[0], /\.admin-u-id \{ display: none; \}/, "手机没有隐藏 UID 列");
  assert.match(m[0], /\.admin-u-mail \{ width: auto; flex: 1; min-width: 0; \}/,
    "手机邮箱列没有改成弹性宽度");
  assert.match(m[0], /\.admin-u-at \{ width: 92px;/, "手机注册时间列没有收窄");
});

t("D8 登录率纯函数：脏值不吹牛、上限 100", () => {
  assert.equal(ratePct(3, 10), 30);
  assert.equal(ratePct(2, 3), 67);
  assert.equal(ratePct(0, 10), 0);
  assert.equal(ratePct(3, 0), 0);
  assert.equal(ratePct("x", 10), 0);
  assert.equal(ratePct(12, 10), 100);
});

console.log(`admin-dau-test: ${pass} pass, ${fails.length} fail`);
if (fails.length) { for (const f of fails) console.log("  FAIL " + f); process.exit(1); }
