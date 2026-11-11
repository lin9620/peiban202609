#!/usr/bin/env node
/*
 * 生产 Supabase schema 基线工具
 * ------------------------------------------------------------
 * 目的：把当前测试库的「结构」固化成可审查、可校验、可重复生成的一份 SQL；
 *       生产新项目只灌 schema，不灌 auth 用户、不灌业务数据、不灌 Storage 文件。
 *
 * 用法：
 *   node tools/schema-baseline.mjs dump
 *       从测试库重新生成 supabase/baseline/{schema,platform,baseline}.sql + manifest.json
 *       需要 pg_dump（PostgreSQL 客户端，版本 >= 服务端大版本）：
 *         - PATH 里有 pg_dump
 *         - 或设置 PG_BIN 指向 PostgreSQL 的 bin 目录
 *         - 或 --pg-bin=<bin 目录 | pg_dump.exe 路径>
 *
 *   node tools/schema-baseline.mjs verify --url=<生产连接串>
 *       把目标库和 manifest 逐项比对（表/函数/触发器/策略/索引/RLS/Storage/Realtime）。
 *
 *   node tools/schema-baseline.mjs apply --url=<空生产库连接串> --yes
 *       把 baseline.sql 灌进目标库。默认拒绝：
 *         - public 已有业务表
 *         - auth.users 已有用户
 *       整个 basline 在一个事务里执行，失败自动回滚。
 *
 * 连接串来源（按优先级）：
 *   --url=... / SUPABASE_DB_URL / WP_DB_URL / DATABASE_URL / .env.backup
 *   .env.backup 已被 .gitignore 忽略，绝不进 git。
 *
 * 安全：
 *   - 日志只显示脱敏后的连接串
 *   - pg_dump 使用 --schema-only，产出里没有 COPY / INSERT 数据
 *   - 不读取、不写入 service_role key
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "supabase", "baseline");
const SCHEMA_FILE = path.join(DIR, "schema.sql");
const PLATFORM_FILE = path.join(DIR, "platform.sql");
const BASELINE_FILE = path.join(DIR, "baseline.sql");
const MANIFEST_FILE = path.join(DIR, "manifest.json");

const argv = process.argv.slice(2);
const cmd = argv[0] || "dump";
const has = (f) => argv.includes(f);
const valOf = (n) => {
  const a = argv.find((x) => x.startsWith(`${n}=`));
  return a ? a.slice(n.length + 1) : null;
};

const log = (s = "") => console.log(s);
const die = (msg, code = 2) => {
  console.error(`\n[!] ${msg}\n`);
  process.exit(code);
};

/* ── 连接串 ───────────────────────────────────────────────── */
function readEnvBackup() {
  const f = path.join(ROOT, ".env.backup");
  if (!fs.existsSync(f)) return {};
  const out = {};
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

function resolveUrl() {
  const fromCli = valOf("--url");
  const env = process.env;
  const file = readEnvBackup();
  return fromCli
    || env.SUPABASE_DB_URL || env.WP_DB_URL || env.DATABASE_URL
    || file.SUPABASE_DB_URL || file.WP_DB_URL || file.DATABASE_URL
    || null;
}

function redact(url) {
  return String(url || "").replace(/(:\/\/[^:/@]+:)([^@]*)@/, (all, head, pw) =>
    /^\[?your[-_ ]?password\]?$/i.test(String(pw).trim()) ? all : `${head}***@`);
}

function parseDbUrl(raw) {
  const u = new URL(raw);
  return {
    host: u.hostname,
    port: u.port || "5432",
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, "") || "postgres",
    ssl: true,
  };
}

function makeClient(raw) {
  return new Client({ connectionString: raw, ssl: { rejectUnauthorized: false } });
}

/* ── pg_dump 定位 ─────────────────────────────────────────── */
function isExe(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
}

function findPgDump() {
  const dirArg = valOf("--pg-bin") || process.env.PG_BIN;
  const candidates = [];
  if (dirArg) {
    const isFile = /\.exe$/i.test(dirArg) || /\/pg_dump$/i.test(dirArg);
    candidates.push(isFile ? dirArg : path.join(dirArg, "pg_dump.exe"));
    candidates.push(isFile ? dirArg : path.join(dirArg, "pg_dump"));
  }
  candidates.push("pg_dump", "pg_dump.exe");
  const roots = [
    "C:/Program Files/PostgreSQL",
    "C:/Program Files (x86)/PostgreSQL",
    "/usr/lib/postgresql",
    "/opt/homebrew/opt",
    "/usr/local/opt",
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    let subs = [];
    try { subs = fs.readdirSync(root); } catch { continue; }
    subs.sort((a, b) => parseFloat(b.replace(/^[^\d]*/, "")) - parseFloat(a.replace(/^[^\d]*/, "")));
    for (const sub of subs) {
      candidates.push(path.join(root, sub, "bin", "pg_dump.exe"));
      candidates.push(path.join(root, sub, "bin", "pg_dump"));
    }
  }
  for (const cand of candidates) {
    if (cand.includes(path.sep) || cand.includes("/")) {
      if (!isExe(cand)) continue;
    }
    const r = spawnSync(cand, ["--version"], { encoding: "utf8" });
    if (!r.error && r.status === 0) return { bin: cand, version: (r.stdout || "").trim() };
  }
  return null;
}

function pgDump(raw, outFile) {
  const pg = findPgDump();
  if (!pg) {
    die([
      "没有找到 pg_dump（PostgreSQL 客户端）。",
      "三选一：",
      "  1) 安装 PostgreSQL 17 客户端，并把 bin 加入 PATH",
      "  2) 设置 PG_BIN=<PostgreSQL 的 bin 目录>",
      "  3) 运行本脚本时加 --pg-bin=<PostgreSQL 的 bin 目录>",
      "注意：pg_dump 大版本必须 >= 服务端大版本（当前测试库是 PostgreSQL 17）。",
    ].join("\n"));
  }
  const c = parseDbUrl(raw);
  const env = {
    ...process.env,
    PGHOST: c.host,
    PGPORT: c.port,
    PGUSER: c.user,
    PGPASSWORD: c.password,
    PGDATABASE: c.database,
    PGSSLMODE: "require",
  };
  const r = spawnSync(pg.bin, [
    "--schema-only",
    "--no-owner",
    "--quote-all-identifiers",
    "--schema=public",
    "--file=" + outFile,
  ], { env, encoding: "utf8" });
  if (r.status !== 0) {
    const msg = String(r.stderr || r.stdout || "").replace(/postgres(ql)?:\/\/[^\s]+/gi, "postgresql://***");
    die(`pg_dump 失败：${msg || "未知错误"}`, r.status || 1);
  }
  return pg;
}

/* ── SQL 拼装 ─────────────────────────────────────────────── */
const HEADER = (stamp) => `-- ══════════════════════════════════════════════════════════════
-- Warm Paws · 生产 Supabase schema 基线
-- 生成时间：${stamp}
-- 来源：当前测试 Supabase 项目（schema-only）
-- 内容：public schema + 必要扩展 + auth 触发器 + Storage bucket/策略 + Realtime 表
-- 不含：auth 用户、业务数据、Storage 文件、service_role / anon key
--
-- 重新生成：node tools/schema-baseline.mjs dump
-- 校验：    node tools/schema-baseline.mjs verify --url=<目标库>
-- 应用：    node tools/schema-baseline.mjs apply --url=<空库> --yes
--
-- ⚠️ 这是生成文件，不要手改；改 schema 时先写 MIGRATION_*.sql，
--    在测试库应用并验证后，再重新 dump 基线。
-- ══════════════════════════════════════════════════════════════
`;

const EXTENSIONS = `-- 生产库通常已自带这些扩展；IF NOT EXISTS 保证可重复执行。
create schema if not exists "public";
create schema if not exists "extensions";
create extension if not exists "pgcrypto" with schema "extensions";
create extension if not exists "uuid-ossp" with schema "extensions";
create extension if not exists "pg_trgm" with schema "public";
`;

function makeIdempotent(s) {
  /* 让 baseline.sql 对“已经是同一套结构”的库也能重复执行。
   * 注意：IF NOT EXISTS 不会补列、改类型；结构变更仍必须走 MIGRATION_*.sql。
   * 这里只处理 pg_dump 会产出的对象类型（本库没有 TYPE/VIEW/ADD CONSTRAINT）。 */
  s = s.replace(/^CREATE TABLE /gm, "CREATE TABLE IF NOT EXISTS ");
  s = s.replace(/^CREATE SEQUENCE /gm, "CREATE SEQUENCE IF NOT EXISTS ");
  s = s.replace(/^CREATE FUNCTION /gm, "CREATE OR REPLACE FUNCTION ");
  s = s.replace(/^CREATE TRIGGER /gm, "CREATE OR REPLACE TRIGGER ");
  s = s.replace(/^CREATE (UNIQUE )?INDEX /gm, (m, uniq) => `CREATE ${uniq || ""}INDEX IF NOT EXISTS `);
  s = s.replace(
    /^CREATE POLICY ("(?:[^"]|"")*") ON ("[^"]+"\."[^"]+")/gm,
    "DROP POLICY IF EXISTS $1 ON $2;\nCREATE POLICY $1 ON $2",
  );
  /* pg_dump 用 ALTER TABLE ... ADD GENERATED ... IDENTITY 建 identity 列；
   * 第二次执行会报 sequence already exists，套一层 pg_attribute 判断。 */
  s = s.replace(
    /^ALTER TABLE ("[^"]+"\."[^"]+") ALTER COLUMN ("[^"]+") ADD GENERATED (ALWAYS|BY DEFAULT) AS IDENTITY \(\r?\n([\s\S]*?)^\);/gm,
    (m, table, col, mode, body) => {
      const rel = table.replace(/"([^"]+)"/g, "$1");
      const colName = col.replace(/"/g, "");
      return `DO $do$\nBEGIN\n  IF NOT EXISTS (\n    SELECT 1 FROM pg_attribute\n     WHERE attrelid = to_regclass('${rel}')\n       AND attname = '${colName}'\n       AND attidentity <> ''\n  ) THEN\n    ALTER TABLE ${table} ALTER COLUMN ${col} ADD GENERATED ${mode} AS IDENTITY (\n${body}    );\n  END IF;\nEND $do$;`;
    },
  );
  /* 主键/唯一/外键/CHECK 约束：重复执行时跳过已存在的同名约束。 */
  s = s.replace(
    /^ALTER TABLE (ONLY )?("[^"]+"\."[^"]+")\r?\n    ADD CONSTRAINT ("[^"]+") (.*);$/gm,
    (m, only, table, name, def) => {
      const rel = table.replace(/"([^"]+)"/g, "$1");
      const conName = name.replace(/"/g, "");
      return `DO $do$\nBEGIN\n  IF NOT EXISTS (\n    SELECT 1 FROM pg_constraint\n     WHERE conname = '${conName}'\n       AND conrelid = to_regclass('${rel}')\n  ) THEN\n    ALTER TABLE ${only || ""}${table}\n    ADD CONSTRAINT ${name} ${def};\n  END IF;\nEND $do$;`;
    },
  );
  return s;
}

function cleanPublicDump(raw) {
  let s = raw;
  s = s.replace(/^\\(un)?restrict .*$/gm, "");
  s = s.replace(/^SET transaction_timeout = 0;$/gm, "-- SET transaction_timeout = 0; -- PG17-only; keep compatible");
  s = s.replace(
    /^SELECT pg_catalog\.set_config\('search_path', '', false\);$/gm,
    "SELECT pg_catalog.set_config('search_path', 'public, extensions', false);",
  );
  s = s.replace(/^CREATE SCHEMA "public";$/gm, 'CREATE SCHEMA IF NOT EXISTS "public";');
  s = s.replace(/"public"\."gin_trgm_ops"/g, '"gin_trgm_ops"');
  s = s.replace(/^(ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin".*)$/gm, "-- $1");
  if (/^COPY .* FROM stdin;/m.test(s) || /^INSERT INTO /m.test(s)) {
    die("pg_dump 产物里出现了数据语句（COPY/INSERT），已中止：基线必须是 schema-only。", 1);
  }
  return makeIdempotent(s);
}

function lit(v) {
  if (v === null || v === undefined) return "NULL";
  return `'${String(v).replace(/'/g, "''")}'`;
}

function ident(v) {
  return `"${String(v).replace(/"/g, '""')}"`;
}

function roleList(roles) {
  let arr = [];
  if (Array.isArray(roles)) {
    arr = roles.filter(Boolean);
  } else if (typeof roles === "string") {
    /* pg 对 text[] 有时返回 "{authenticated}" 字符串，不能当成单个 role 名 */
    arr = roles.replace(/^\{|\}$/g, "").split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
  }
  return arr.length ? arr.map(ident).join(", ") : "public";
}

function cmdSql(c) {
  return ({ r: "select", a: "insert", w: "update", d: "delete", "*": "all" })[c] || "all";
}

async function buildPlatform(client) {
  const buckets = (await client.query(
    "select id, name, public, file_size_limit, allowed_mime_types from storage.buckets order by id",
  )).rows;

  const policies = (await client.query(`
    select p.polname, p.polcmd, p.polpermissive,
           pg_get_expr(p.polqual, p.polrelid) as qual,
           pg_get_expr(p.polwithcheck, p.polrelid) as with_check,
           array(select rolname from pg_roles where oid = any(p.polroles)) as roles
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'storage' and c.relname = 'objects'
     order by 1
  `)).rows;

  const realtime = (await client.query(
    "select schemaname, tablename from pg_publication_tables where pubname = 'supabase_realtime' order by 1, 2",
  )).rows;

  const authTriggers = (await client.query(`
    select t.tgname, pg_get_triggerdef(t.oid, true) as def
      from pg_trigger t
     where t.tgrelid = 'auth.users'::regclass and not t.tgisinternal
     order by 1
  `)).rows;

  const lines = [];
  lines.push("-- ── Platform glue: auth trigger / storage buckets & policies / realtime ──");
  lines.push("set search_path = public, extensions, storage;");
  lines.push("");

  for (const t of authTriggers) {
    lines.push(`drop trigger if exists ${ident(t.tgname)} on "auth"."users";`);
    lines.push(`${t.def};`);
    lines.push("");
  }

  if (buckets.length) {
    lines.push("-- Storage buckets（只建 bucket，不建文件）");
    lines.push("insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values");
    lines.push(buckets.map((b) => `  (${lit(b.id)}, ${lit(b.name)}, ${b.public ? "true" : "false"}, ${b.file_size_limit === null ? "null" : Number(b.file_size_limit)}, ${b.allowed_mime_types === null ? "null" : lit(JSON.stringify(b.allowed_mime_types))}::text[])`).join(",\n"));
    lines.push("on conflict (id) do update set");
    lines.push("  name = excluded.name,");
    lines.push("  public = excluded.public,");
    lines.push("  file_size_limit = excluded.file_size_limit,");
    lines.push("  allowed_mime_types = excluded.allowed_mime_types;");
    lines.push("");
  }

  for (const p of policies) {
    const cmdName = cmdSql(p.polcmd);
    const bits = [];
    if (p.qual) bits.push(`using (${p.qual})`);
    if (p.with_check) bits.push(`with check (${p.with_check})`);
    lines.push(`drop policy if exists ${ident(p.polname)} on "storage"."objects";`);
    lines.push(`create policy ${ident(p.polname)} on "storage"."objects" as ${p.polpermissive ? "permissive" : "restrictive"} for ${cmdName} to ${roleList(p.roles)}${bits.length ? " " + bits.join(" ") : ""};`);
    lines.push("");
  }

  lines.push("-- Realtime publication（只加表，不复制数据）");
  lines.push(`do $$ begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;`);
  for (const t of realtime) {
    if (t.schemaname !== "public") continue;
    lines.push(`do $$ begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = ${lit(t.schemaname)}
       and tablename = ${lit(t.tablename)}
  ) then
    alter publication supabase_realtime add table ${ident(t.schemaname)}.${ident(t.tablename)};
  end if;
end $$;`);
  }
  lines.push("");
  return { sql: lines.join("\n"), buckets, policies, realtime, authTriggers };
}

async function buildManifest(client, pgInfo, files) {
  const tables = (await client.query(
    "select tablename from pg_tables where schemaname='public' order by 1",
  )).rows.map((r) => r.tablename);

  const functions = (await client.query(`
    select p.proname, pg_get_function_identity_arguments(p.oid) as args
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
     order by 1, 2
  `)).rows.map((r) => `${r.proname}(${r.args})`);

  const policies = (await client.query(
    "select policyname from pg_policies where schemaname='public' order by 1",
  )).rows.map((r) => r.policyname);

  const triggers = (await client.query(`
    select tgname from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname='public' and not t.tgisinternal
     order by 1
  `)).rows.map((r) => r.tgname);

  const indexes = (await client.query(
    "select indexname from pg_indexes where schemaname='public' order by 1",
  )).rows.map((r) => r.indexname);

  const rls = (await client.query(`
    select c.relname from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname='public' and c.relkind='r' and c.relrowsecurity
     order by 1
  `)).rows.map((r) => r.relname);

  const storageBuckets = (await client.query(
    "select id from storage.buckets order by 1",
  )).rows.map((r) => r.id);

  const storagePolicies = (await client.query(
    "select policyname from pg_policies where schemaname='storage' and tablename='objects' order by 1",
  )).rows.map((r) => r.policyname);

  const realtime = (await client.query(
    "select schemaname || '.' || tablename as t from pg_publication_tables where pubname='supabase_realtime' order by 1",
  )).rows.map((r) => r.t);

  const authTrigger = (await client.query(`
    select count(*)::int as n from pg_trigger t
     where t.tgrelid='auth.users'::regclass and not t.tgisinternal
  `)).rows[0].n;

  const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

  return {
    baseline_version: "2026-11-11",
    generated_at: new Date().toISOString(),
    source: "test-supabase",
    pg_dump: pgInfo.version,
    schema_only: true,
    counts: {
      tables: tables.length,
      functions: functions.length,
      policies: policies.length,
      triggers: triggers.length,
      indexes: indexes.length,
      rls_tables: rls.length,
      storage_buckets: storageBuckets.length,
      storage_policies: storagePolicies.length,
      realtime_tables: realtime.length,
      auth_triggers: authTrigger,
    },
    sha256: {
      schema: sha(SCHEMA_FILE),
      platform: sha(PLATFORM_FILE),
      baseline: sha(BASELINE_FILE),
    },
    objects: {
      tables,
      functions,
      policies,
      triggers,
      indexes,
      rls_tables: rls,
      storage_buckets: storageBuckets,
      storage_policies: storagePolicies,
      realtime_tables: realtime,
    },
  };
}

/* ── 对目标库做结构比对 ───────────────────────────────────── */
function diff(label, expected, actual) {
  const e = new Set(expected);
  const a = new Set(actual);
  const missing = expected.filter((x) => !a.has(x));
  const extra = actual.filter((x) => !e.has(x));
  if (!missing.length && !extra.length) {
    log(`  ✓ ${label}  ${expected.length}`);
    return true;
  }
  console.error(`  ✗ ${label}  期望 ${expected.length} / 实际 ${actual.length}`);
  if (missing.length) console.error(`    缺少: ${missing.slice(0, 20).join(", ")}${missing.length > 20 ? " …" : ""}`);
  if (extra.length) console.error(`    多出: ${extra.slice(0, 20).join(", ")}${extra.length > 20 ? " …" : ""}`);
  return false;
}

async function inspect(client) {
  const q = async (sql) => (await client.query(sql)).rows;
  return {
    tables: (await q("select tablename from pg_tables where schemaname='public' order by 1")).map((r) => r.tablename),
    functions: (await q(`
      select p.proname, pg_get_function_identity_arguments(p.oid) as args
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public'
         and not exists (select 1 from pg_depend d where d.objid=p.oid and d.deptype='e')
       order by 1,2
    `)).map((r) => `${r.proname}(${r.args})`),
    policies: (await q("select policyname from pg_policies where schemaname='public' order by 1")).map((r) => r.policyname),
    triggers: (await q(`
      select t.tgname from pg_trigger t join pg_class c on c.oid=t.tgrelid
      join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and not t.tgisinternal order by 1
    `)).map((r) => r.tgname),
    indexes: (await q("select indexname from pg_indexes where schemaname='public' order by 1")).map((r) => r.indexname),
    rls_tables: (await q(`
      select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and c.relkind='r' and c.relrowsecurity order by 1
    `)).map((r) => r.relname),
    storage_buckets: (await q("select id from storage.buckets order by 1")).map((r) => r.id),
    storage_policies: (await q("select policyname from pg_policies where schemaname='storage' and tablename='objects' order by 1")).map((r) => r.policyname),
    realtime_tables: (await q("select schemaname || '.' || tablename as t from pg_publication_tables where pubname='supabase_realtime' order by 1")).map((r) => r.t),
    auth_triggers: (await q("select count(*)::int as n from pg_trigger t where t.tgrelid='auth.users'::regclass and not t.tgisinternal"))[0].n,
  };
}

async function verify(url) {
  if (!fs.existsSync(MANIFEST_FILE)) die("没有 manifest.json，请先运行 dump。");
  const m = JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8"));
  const c = makeClient(url);
  await c.connect();
  try {
    log(`校验目标：${redact(url)}`);
    const got = await inspect(c);
    let ok = true;
    const keys = ["tables", "functions", "policies", "triggers", "indexes", "rls_tables", "storage_buckets", "storage_policies", "realtime_tables"];
    for (const k of keys) ok = diff(k, m.objects[k] || [], got[k] || []) && ok;
    if (got.auth_triggers !== m.counts.auth_triggers) {
      console.error(`  ✗ auth_triggers 期望 ${m.counts.auth_triggers} / 实际 ${got.auth_triggers}`);
      ok = false;
    } else {
      log(`  ✓ auth_triggers  ${got.auth_triggers}`);
    }
    const authUsers = (await c.query("select count(*)::int as n from auth.users")).rows[0].n;
    if (authUsers > 0) log(`  ⚠ auth.users 有 ${authUsers} 个用户；生产基线应只用于全新空项目。`);
    if (!ok) process.exitCode = 1;
    else log("\nSCHEMA VERIFY ALL PASS");
  } finally {
    await c.end().catch(() => {});
  }
}

async function apply(url) {
  if (!has("--yes")) {
    die("拒绝执行：apply 会改目标库结构。确认目标为空库后，加 --yes 再运行。\n" +
      "例：node tools/schema-baseline.mjs apply --url=<生产连接串> --yes");
  }
  if (!fs.existsSync(BASELINE_FILE)) die("没有 baseline.sql，请先运行 dump。");
  const sql = fs.readFileSync(BASELINE_FILE, "utf8");
  const c = makeClient(url);
  await c.connect();
  try {
    const tables = (await c.query("select count(*)::int as n from pg_tables where schemaname='public' and tablename not like 'pg_%'")).rows[0].n;
    if (tables > 0 && !has("--allow-nonempty")) {
      die(`目标 public 已有 ${tables} 张表，拒绝覆盖。\n如果确认是空库或要重建，请加 --allow-nonempty（危险操作，先备份）。`, 1);
    }
    let authUsers = 0;
    try {
      authUsers = (await c.query("select count(*)::int as n from auth.users")).rows[0].n;
    } catch { /* 非 Supabase 目标可能没有 auth.users */ }
    if (authUsers > 0 && !has("--allow-auth-users")) {
      die(`目标 auth.users 已有 ${authUsers} 个用户，拒绝执行。\n生产基线不应灌进已有用户的项目；确需继续请加 --allow-auth-users。`, 1);
    }
    if (has("--dry-run")) {
      log(`DRY RUN：${redact(url)}，将执行 ${(sql.length / 1024).toFixed(1)} KB SQL；未连接修改。`);
      return;
    }
    log(`开始应用基线：${redact(url)}`);
    await c.query(sql);
    log("基线应用完成。");
    log("建议立即运行：node tools/schema-baseline.mjs verify --url=<同一连接串>");
  } catch (e) {
    try { await c.query("ROLLBACK"); } catch { /* 已回滚 */ }
    const msg = String(e && e.message || e).replace(/postgres(ql)?:\/\/[^\s]+/gi, "postgresql://***");
    console.error(`\n[!] 应用失败，事务已回滚：${msg}\n`);
    process.exitCode = 1;
  } finally {
    await c.end().catch(() => {});
  }
}

/* ── main ─────────────────────────────────────────────────── */
async function main() {
  if (cmd === "dump") {
    const url = resolveUrl();
    if (!url) die("缺少连接串：--url / SUPABASE_DB_URL / .env.backup 任选其一。");
    fs.mkdirSync(DIR, { recursive: true });
    const stamp = new Date().toISOString();
    const tmp = path.join(os.tmpdir(), `warmpaws-schema-${Date.now()}.sql`);
    log(`从测试库导出 schema-only：${redact(url)}`);
    const pgInfo = pgDump(url, tmp);
    const raw = fs.readFileSync(tmp, "utf8");
    fs.rmSync(tmp, { force: true });
    const cleaned = cleanPublicDump(raw);
    fs.writeFileSync(SCHEMA_FILE, HEADER(stamp) + "\n" + EXTENSIONS + "\n" + cleaned, "utf8");

    const c = makeClient(url);
    await c.connect();
    let platform;
    try {
      platform = await buildPlatform(c);
    } finally {
      await c.end().catch(() => {});
    }
    fs.writeFileSync(PLATFORM_FILE, HEADER(stamp) + "\n" + platform.sql, "utf8");

    const baseline = HEADER(stamp) + "\nbegin;\n\n" + fs.readFileSync(SCHEMA_FILE, "utf8") + "\n\n" + fs.readFileSync(PLATFORM_FILE, "utf8") + "\ncommit;\n";
    fs.writeFileSync(BASELINE_FILE, baseline, "utf8");

    const c2 = makeClient(url);
    await c2.connect();
    let manifest;
    try {
      manifest = await buildManifest(c2, pgInfo, {});
    } finally {
      await c2.end().catch(() => {});
    }
    fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2) + "\n", "utf8");

    log("");
    log(`✓ ${path.relative(ROOT, SCHEMA_FILE)}  ${(fs.statSync(SCHEMA_FILE).size / 1024).toFixed(1)} KB`);
    log(`✓ ${path.relative(ROOT, PLATFORM_FILE)}  ${(fs.statSync(PLATFORM_FILE).size / 1024).toFixed(1)} KB`);
    log(`✓ ${path.relative(ROOT, BASELINE_FILE)}  ${(fs.statSync(BASELINE_FILE).size / 1024).toFixed(1)} KB`);
    log(`✓ ${path.relative(ROOT, MANIFEST_FILE)}`);
    log(`  tables=${manifest.counts.tables} functions=${manifest.counts.functions} policies=${manifest.counts.policies} triggers=${manifest.counts.triggers} indexes=${manifest.counts.indexes}`);
    log(`  storage_buckets=${manifest.counts.storage_buckets} storage_policies=${manifest.counts.storage_policies} realtime=${manifest.counts.realtime_tables}`);
    return;
  }

  if (cmd === "verify") {
    const url = resolveUrl();
    if (!url) die("缺少连接串：--url / SUPABASE_DB_URL / .env.backup 任选其一。");
    await verify(url);
    return;
  }

  if (cmd === "apply") {
    const url = resolveUrl();
    if (!url) die("缺少连接串：--url / SUPABASE_DB_URL / .env.backup 任选其一。");
    await apply(url);
    return;
  }

  die(`未知命令：${cmd}\n可用：dump | verify | apply`, 2);
}

main().catch((e) => {
  const msg = String(e && e.message || e).replace(/postgres(ql)?:\/\/[^\s]+/gi, "postgresql://***");
  console.error(`\n[!] ${msg}\n`);
  process.exit(1);
});
