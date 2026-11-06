/* 存量内容语言回填（轮 439）
 * ------------------------------------------------------------
 * 为什么要有这个文件：
 *   MIGRATION_content_lang.sql 里只能用 SQL 正则做「含汉字 → zh」这种粗判，
 *   对 no-han、纯拼音、英文夹一两个汉字、西语/葡语的旧帖全都判成 und。
 *   真正的检测器在 src/utils/langDetect.js（JS，四道关卡），必须让存量数据也
 *   过一遍同一个检测器，否则线上会出现「新帖有角标、老帖永远无角标」的不一致。
 *
 * 两种数据通道（**很关键，别搞混**）：
 *   A. REST + anon key（默认）：零配置，但受 RLS 限制 —— bottle_letters 在 RLS 下
 *      anon 一行都读不到（漂流瓶设计上只能通过 RPC 捞信），所以**漂瓶存量永远是盲区**。
 *      脚本会检测到「其他表有数据、漂瓶 0 条」并告警，不会假装一切正常。
 *   B. 直连 Postgres（--apply-db）：读 .env.backup 里的 SUPABASE_DB_URL，走 service 权限，
 *      三张表都能读全、也能直接写。需要 `npm i -D pg`（已装）。
 *
 * 做法：
 *   1) 拉三张表（id + 正文）——默认只读；
 *   2) 用产品同一个 detectLang() 逐条重算；
 *   3) 输出：
 *      · _scratch/backfill-lang.sql  —— 贴进 Supabase SQL Editor 一键执行（不带 --apply-db 时）
 *      · _scratch/backfill-lang.json —— 逐条明细，便于抽查与留档
 *
 * 用法：
 *   node tools/backfill-lang.mjs             # 只体检 + 生成 SQL（不动数据库）
 *   node tools/backfill-lang.mjs --only-und  # 只修当前仍是 und 的行（最保守）
 *   node tools/backfill-lang.mjs --apply-db  # 直连读全 + 事务写回（一条命令跑完，推荐）
 *   node tools/backfill-lang.mjs --apply     # 用 anon key PATCH 自己的行（能改几条算几条）
 *   node tools/backfill-lang.mjs --self-test # 不联网，自检检测→SQL 生成链路
 *
 * 退出码：0 正常 / 1 生成或执行失败 / 2 前置条件缺失（没 .env、没连接串、迁移未跑）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectLang, SUPPORTED } from "../src/utils/langDetect.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const OUT_DIR = path.join(ROOT, "_scratch");
const SQL_FILE = path.join(OUT_DIR, "backfill-lang.sql");
const JSON_FILE = path.join(OUT_DIR, "backfill-lang.json");

const log = (s = "") => console.log(s);
const die = (m, c = 2) => { console.error(`\n[!] ${m}\n`); process.exit(c); };

/* 三张表：正文取哪一列、主键类型（决定 SQL 里的 ::uuid / ::bigint 转换） */
const TABLES = [
  { table: "wall_posts", body: ["body"], idType: "uuid", label: "暖心墙帖子" },
  { table: "bottle_letters", body: ["body"], idType: "uuid", label: "漂流瓶信件" },
  { table: "stories", body: ["title", "body"], idType: "bigint", label: "故事" },
];

/* ── .env ─────────────────────────────────────────────────── */
function readEnv() {
  const p = path.join(ROOT, ".env");
  if (!fs.existsSync(p)) die("缺 .env（需要 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY）");
  const txt = fs.readFileSync(p, "utf8");
  const get = (k) => {
    const m = txt.match(new RegExp("^\\s*" + k + "\\s*=\\s*(\\S+)\\s*$", "m"));
    return m ? m[1] : "";
  };
  const url = get("VITE_SUPABASE_URL").replace(/\/$/, "");
  const key = get("VITE_SUPABASE_ANON_KEY");
  if (!url || !key) die("VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY 为空");
  return { url, key };
}

/* ── 检测：正文拼接 + 归一 ─────────────────────────────────── */
function textOf(row, cols) {
  return cols.map((c) => String(row[c] == null ? "" : row[c])).join("\n").trim();
}
/** 把一行原始数据算成一条回填记录 */
export function planRow(row, spec) {
  const text = textOf(row, spec.body);
  const r = detectLang(text);
  const cur = typeof row.lang === "string" ? row.lang : "und";
  return {
    id: row.id,
    table: spec.table,
    idType: spec.idType,
    cur,
    lang: r.lang,
    conf: r.conf,
    why: r.why,
    chars: text.length,
    // 只列摘要，SQL 文件里不含正文（贴进 SQL Editor 也不泄露内容）
    head: text.replace(/\s+/g, " ").slice(0, 60),
    change: r.lang !== cur,
  };
}

/** 生成可直接粘贴执行的 SQL：一条 update + values 列表，按表分组 */
export function buildSql(plan, { onlyUnd = false } = {}) {
  const head = [
    "-- 存量内容语言回填（由 tools/backfill-lang.mjs 生成，勿手改）",
    `-- 生成时间 ${new Date().toISOString()}`,
    "-- 前提：已执行 MIGRATION_content_lang.sql（lang 列 + check 约束已存在）",
    "",
  ];
  const parts = [head.join("\n")];
  let total = 0;
  for (const spec of TABLES) {
    const rows = plan.filter((p) => p.table === spec.table && p.change && (!onlyUnd || p.cur === "und"));
    if (!rows.length) continue;
    total += rows.length;
    const vals = rows.map((p) => `  ('${p.id}', '${p.lang}')`).join(",\n");
    parts.push(
      `-- ${spec.label}：${rows.length} 条\n` +
      `update public.${spec.table} t\n` +
      `   set lang = v.lang\n` +
      `  from (values\n${vals}\n` +
      `       ) as v(id, lang)\n` +
      ` where t.id = v.id::${spec.idType}\n` +
      `   and t.lang is distinct from v.lang;\n`,
    );
  }
  if (!total) {
    parts.push("-- 没有需要回填的行：所有存量数据的 lang 已与检测结果一致。\n");
  }
  /* 执行后自检：不该再有「含汉字却标成非 zh」的行 */
  parts.push(
    "-- 执行后自检（下面两条都应为 0）\n" +
    "select 'wall_posts 含汉字非 zh' as chk, count(*) as n from public.wall_posts where lang <> 'zh' and body ~ '[\\u4e00-\\u9fff]'\n" +
    "union all\n" +
    "select 'bottle_letters 含汉字非 zh', count(*) from public.bottle_letters where lang <> 'zh' and body ~ '[\\u4e00-\\u9fff]'\n" +
    "union all\n" +
    "select 'stories 含汉字非 zh', count(*) from public.stories where lang <> 'zh' and body ~ '[\\u4e00-\\u9fff]';\n",
  );
  return { sql: parts.join("\n"), total };
}

/* ── REST 拉数据（只读） ──────────────────────────────────── */
async function rest(env, qs, init = {}) {
  const res = await fetch(`${env.url}/rest/v1/${qs}`, {
    ...init,
    headers: {
      apikey: env.key,
      Authorization: `Bearer ${env.key}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { ok: res.ok, status: res.status, body };
}

async function fetchAll(env, spec) {
  const cols = ["id", "lang", ...spec.body].join(",");
  const out = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const r = await rest(env, `${spec.table}?select=${cols}&order=id&limit=${PAGE}&offset=${from}`);
    if (!r.ok) {
      const msg = JSON.stringify(r.body);
      /* 42703 = undefined_column：lang 还没加 */
      if (/42703|does not exist|column .*lang/i.test(msg)) {
        die(`表 ${spec.table} 没有 lang 列 —— 请先在 Supabase SQL Editor 执行 MIGRATION_content_lang.sql`, 2);
      }
      die(`读 ${spec.table} 失败（${r.status}）：${msg}`, 1);
    }
    const rows = Array.isArray(r.body) ? r.body : [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

/* ── 直连 Postgres（--apply-db） ──────────────────────────── */
/** 连接串优先级：环境变量 → .env.backup → 无 */
function readDbUrl() {
  const fromEnv = (process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || "").trim();
  if (fromEnv) return fromEnv;
  const p = path.join(ROOT, ".env.backup");
  if (!fs.existsSync(p)) return "";
  const m = fs.readFileSync(p, "utf8").match(/^\s*SUPABASE_DB_URL\s*=\s*(\S+)\s*$/m);
  if (!m) return "";
  /* 占位符（还没填真密码）不算有 */
  return /<[^>]*>/.test(m[1]) ? "" : m[1];
}

async function openDb() {
  const url = readDbUrl();
  if (!url) {
    die(
      "没有数据库连接串。二选一：\n" +
      "  · 在 .env.backup 里写 SUPABASE_DB_URL=postgresql://...（Session pooler，端口 5432）\n" +
      "  · 或去掉 --apply-db，改用生成 SQL 手动粘贴的方式",
      2,
    );
  }
  let pg;
  try {
    pg = (await import("pg")).default;
  } catch {
    die("没装 pg 客户端：npm i -D pg", 2);
  }
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  try {
    await c.connect();
  } catch (e) {
    die(`连不上数据库：${String(e.message).slice(0, 200)}`, 1);
  }
  return c;
}

async function fetchAllDb(db, spec) {
  const cols = ["id", "lang", ...spec.body].join(", ");
  const r = await db.query(`select ${cols} from public.${spec.table} order by id`);
  return r.rows;
}

/** 事务内写回。表名只来自本文件的 TABLES 白名单，id 走参数绑定 */
async function applyDb(db, list) {
  const allow = new Set(TABLES.map((t) => t.table));
  await db.query("begin");
  try {
    let n = 0;
    for (const p of list) {
      if (!allow.has(p.table)) throw new Error("未知表 " + p.table);
      const r = await db.query(
        `update public.${p.table} set lang = $1 where id = $2 and lang is distinct from $1`,
        [p.lang, p.id],
      );
      n += r.rowCount;
    }
    await db.query("commit");
    return n;
  } catch (e) {
    await db.query("rollback");
    throw e;
  }
}

/* ── 主流程 ───────────────────────────────────────────────── */
async function main() {
  const onlyUnd = has("--only-und");
  const apply = has("--apply");
  const applyDbMode = has("--apply-db");
  const env = readEnv();

  /* --apply-db 走直连：能读全（包含 RLS 挡住的漂瓶），也能直接写 */
  const db = applyDbMode ? await openDb() : null;

  log(db ? "拉取存量数据（直连，service 权限，只读阶段）…" : "拉取存量数据（REST 只读）…");
  const plan = [];
  const counts = {};
  for (const spec of TABLES) {
    const rows = db ? await fetchAllDb(db, spec) : await fetchAll(env, spec);
    const recs = rows.map((r) => planRow(r, spec));
    plan.push(...recs);
    counts[spec.table] = rows.length;
    log(`  ${spec.table.padEnd(16)} ${String(rows.length).padStart(5)} 条`);
  }

  /* RLS 盲区告警：不直连时漂瓶恒为 0 条，别让人误以为「漂瓶全都没问题」 */
  if (!db && counts.bottle_letters === 0) {
    log(
      "\n[!] bottle_letters 读到 0 条 —— 大概率是 RLS 挡住了 anon 直查（漂流瓶只能通过 RPC 捞信）。\n" +
      "    也就是说**漂瓶存量这次没有被检测**。想覆盖它请加 --apply-db 走直连，\n" +
      "    或用 SQL 查：select id, body from public.bottle_letters where lang = 'und';",
    );
  }

  /* 分布 */
  const dist = {};
  for (const p of plan) dist[p.lang] = (dist[p.lang] || 0) + 1;
  const changes = plan.filter((p) => p.change);
  const toWrite = changes.filter((p) => !onlyUnd || p.cur === "und");

  log(`\n检测结果分布（共 ${plan.length} 条）：`);
  for (const l of [...SUPPORTED, "ja", "ko", "und"]) {
    if (dist[l]) log(`  ${l.padEnd(3)} ${String(dist[l]).padStart(5)}  ${((dist[l] / plan.length) * 100).toFixed(1)}%`);
  }
  const curDist = {};
  for (const p of plan) curDist[p.cur] = (curDist[p.cur] || 0) + 1;
  log(`当前库里已有标记：${Object.entries(curDist).map(([k, v]) => `${k}=${v}`).join(" ")}`);

  log(`\n需要改写：${toWrite.length} 条${onlyUnd ? "（--only-und：只动 und）" : ""}`);
  const byPair = {};
  for (const p of toWrite) {
    const k = `${p.cur} → ${p.lang}`;
    byPair[k] = (byPair[k] || 0) + 1;
  }
  for (const [k, v] of Object.entries(byPair)) log(`  ${k}  ${v} 条`);

  /* 有改写的逐条列出来，人工能一眼扫完 */
  if (toWrite.length && toWrite.length <= 60) {
    log("\n逐条明细：");
    for (const p of toWrite) {
      log(`  ${p.table}#${p.id}  ${p.cur}→${p.lang} conf=${p.conf.toFixed(2)} why=${p.why}  「${p.head}」`);
    }
  } else if (toWrite.length) {
    log("\n（明细较多，见 JSON 输出）");
  }

  /* ── 落盘 ── */
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const { sql, total } = buildSql(plan, { onlyUnd });
  fs.writeFileSync(SQL_FILE, sql, "utf8");
  fs.writeFileSync(JSON_FILE, JSON.stringify({ at: new Date().toISOString(), total: plan.length, dist, curDist, plan }, null, 2), "utf8");
  log(`\n写出 SQL：${path.relative(ROOT, SQL_FILE)}（${total} 条 update）`);
  log(`写出明细：${path.relative(ROOT, JSON_FILE)}`);

  /* ── 直连写回（--apply-db）：事务内一把梭，失败整体回滚 ── */
  if (db) {
    if (!toWrite.length) {
      log("\n--apply-db：没有需要改写的行，库已经是最新的。");
    } else {
      log(`\n--apply-db：事务内写回 ${toWrite.length} 条…`);
      const n = await applyDb(db, toWrite);
      log(`  已提交，实际改动 ${n} 行（与预期不一致通常是有并发写入）`);
      /* 写完立刻复检，确认没有「含汉字却标非 zh」的残留 */
      const chk = await db.query(
        `select 'wall_posts' t, count(*)::int n from public.wall_posts where lang <> 'zh' and body ~ '[一-龥]'
         union all select 'bottle_letters', count(*)::int from public.bottle_letters where lang <> 'zh' and body ~ '[一-龥]'
         union all select 'stories', count(*)::int from public.stories where lang <> 'zh' and body ~ '[一-龥]'`,
      );
      log("  自检（都应 0）：" + chk.rows.map((r) => `${r.t}=${r.n}`).join(" "));
    }
    const distAfter = await db.query(
      `select 'wall_posts' t, lang, count(*)::int n from public.wall_posts group by lang
       union all select 'stories', lang, count(*)::int from public.stories group by lang
       union all select 'bottle_letters', lang, count(*)::int from public.bottle_letters group by lang
       order by 1, 2`,
    );
    log("\n回填后库内分布：");
    for (const r of distAfter.rows) log(`  ${r.t.padEnd(15)} ${r.lang.padEnd(4)} ${r.n}`);
    await db.end();
  } else if (total) {
    log("→ 把 SQL 文件内容贴进 Supabase Dashboard → SQL Editor 执行即可。");
    log("  （或加 --apply-db 直连执行，一条命令跑完）");
  }

  /* ── 可选：用当前账号 PATCH 自己的行 ── */
  if (apply && toWrite.length) {
    log("\n--apply：尝试用 anon key 逐行 PATCH（RLS 只允许改自己的行）…");
    let okN = 0, denyN = 0;
    for (const p of toWrite) {
      const r = await rest(env, `${p.table}?id=eq.${p.id}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ lang: p.lang }),
      });
      if (r.ok) okN++; else denyN++;
    }
    log(`  成功 ${okN} 条，被拒/失败 ${denyN} 条（别人的行 anon 改不了，属正常）`);
    if (denyN) log("  → 其余仍需在 SQL Editor 里执行生成的 SQL。");
  }

  /* ── 收尾体检 ── */
  const stillUnd = plan.filter((p) => p.lang === "und");
  log(`\n仍判不出语言：${stillUnd.length} 条`);
  for (const p of stillUnd.slice(0, 10)) log(`  ${p.table}#${p.id}  「${p.head}」`);
  if (stillUnd.length > 10) log(`  ……另有 ${stillUnd.length - 10} 条（见 JSON）`);

  process.exitCode = 0;
}

/* ── 自检（不联网）：检测 → 变化判定 → SQL 生成 ─────────────── */
function selfTest() {
  let pass = 0, fail = 0;
  const ok = (n, c, extra = "") => {
    if (c) { pass++; log("PASS  " + n + (extra ? "  " + extra : "")); }
    else { fail++; log("FAIL  " + n + (extra ? "  " + extra : "")); }
  };
  const spec = TABLES[0];
  const mk = (id, body, lang) => ({ id, body, lang });

  const a = planRow(mk("u1", "今天有点累，但看到他笑了就好了", "und"), spec);
  ok("S1 中文旧帖判 zh", a.lang === "zh" && a.change === true, `${a.cur}→${a.lang}`);

  const b = planRow(mk("u2", "I miss my cat so much tonight", "und"), spec);
  ok("S2 英语旧帖判 en", b.lang === "en", `${b.lang} ${b.why}`);

  const c = planRow(mk("u3", "quiero mucho a mi perro", "und"), spec);
  ok("S3 西语旧帖判 es", c.lang === "es", `${c.lang} ${c.why}`);

  const d = planRow(mk("u4", "今天有点累，但看到他笑了就好了", "zh"), spec);
  ok("S4 已经是正确值不算改动", d.change === false);

  const e = planRow(mk("u5", "asdfgh kkkkk", "zh"), spec);
  ok("S5 乱敲落 und 且识别为需改写", e.lang === "und" && e.change === true, e.lang);

  const { sql, total } = buildSql([a, b, c, d, e]);
  ok("S6 只有 4 条进 SQL（正确值不重复写）", total === 4, `total=${total}`);
  ok("S7 SQL 含 uuid 强转", sql.includes("v.id::uuid"));
  ok("S8 SQL 带 is distinct from 幂等保护", sql.includes("is distinct from v.lang"));
  ok("S9 SQL 不含正文原文", !sql.includes("今天有点累"));
  ok("S10 SQL 带执行后自检", sql.includes("含汉字非 zh"));

  const onlyUnd = buildSql([a, d], { onlyUnd: true });
  ok("S11 --only-und 跳过非 und 行", onlyUnd.total === 1, `total=${onlyUnd.total}`);

  /* 故事表主键是 bigint，必须生成 ::bigint 而不是 ::uuid */
  const st = planRow({ id: 42, title: "无题", body: "I remember the rain", lang: "und" }, TABLES[2]);
  const stSql = buildSql([st]);
  ok("S12 故事表用 ::bigint 强转", stSql.sql.includes("v.id::bigint"), stSql.sql.includes("::bigint") ? "" : stSql.sql.slice(0, 200));
  ok("S13 故事标题+正文一起检测", st.lang === "en", `${st.lang} ${st.why}`);

  log(`\nTOTAL ${pass + fail}  PASS ${pass}  FAIL ${fail}`);
  process.exitCode = fail ? 1 : 0;
}

if (has("--self-test")) selfTest();
else await main();
