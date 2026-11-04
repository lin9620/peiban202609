/* 数据库备份（轮 402）
 * ------------------------------------------------------------
 * 为什么要有这个文件：
 *   全站真实数据（帖子 / 评论 / 私信 / 漂流瓶 / 故事 / 宠物 / 通知）只存在
 *   Supabase 一个地方，免费版**没有 PITR、没有自动备份**。一次误删或一次
 *   `delete from` 就是永久损失。本脚本负责把 public/auth/storage 三个 schema
 *   导成一份可恢复的 dump，并做轮转 + 完整性校验。
 *
 * 用法：
 *   node tools/backup.mjs --check          # 只体检：pg_dump 在不在、连接串有没有、连得上吗
 *   node tools/backup.mjs                  # 备份一份，保留最近 14 份
 *   node tools/backup.mjs --keep=30        # 保留最近 30 份
 *   node tools/backup.mjs --schema=public  # 只导 public（最小可用集，排错用）
 *   node tools/backup.mjs --self-test      # 不碰数据库，自检轮转/校验/脱敏逻辑
 *   node tools/backup.mjs --drill          # 恢复演练：把最新 dump 灌进临时空库，逐表比对内容指纹，验完删库
 *   node tools/backup.mjs --drill --file=backups/xxx.dump   # 演练指定的一份
 *   node tools/backup.mjs --drill --keep-drill              # 演练后保留临时库（排查用，记得手工删）
 *
 * 连接串从哪来（二选一，都不进 git）：
 *   1) 环境变量  SUPABASE_DB_URL="postgresql://postgres.<ref>:<密码>@aws-0-<region>.pooler.supabase.com:5432/postgres"
 *   2) 项目根目录 `.env.backup` 里写一行  SUPABASE_DB_URL=...（已在 .gitignore）
 *   取值路径：Supabase Dashboard → Project Settings → Database → Connection string → URI。
 *   ⚠️ 用 **Direct connection（5432）** 或 **Session pooler**；Transaction pooler（6543）不支持 pg_dump。
 *
 * pg_dump 从哪来：
 *   本机需装 PostgreSQL 客户端（版本 ≥ 服务端大版本）。没装时脚本会打印安装命令，不擅自装。
 *
 * 退出码：0 成功 / 1 备份或校验失败 / 2 前置条件缺失（没工具、没连接串）
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valOf = (n) => {
  const a = argv.find((x) => x.startsWith(`${n}=`));
  return a ? a.slice(n.length + 1) : null;
};

const DIR = path.resolve(ROOT, valOf("--dir") || "backups");
const KEEP = Math.max(1, parseInt(valOf("--keep") || "14", 10) || 14);
const SCHEMAS = (valOf("--schema") || "public,auth,storage").split(",").map((s) => s.trim()).filter(Boolean);
const DUMP_RE = /^warmpaws-\d{8}-\d{6}\.dump$/;
/* 有数据就必须在的核心表：一份 dump 里连它们都没有，等于没备份到东西 */
const MUST_HAVE = ["profiles", "wall_posts", "wall_comments", "dm_messages", "pets"];

const log = (s = "") => console.log(s);
const die = (msg, code = 2) => { console.error(`\n[!] ${msg}\n`); process.exit(code); };
const kb = (n) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${(n / 1024).toFixed(0)}KB`);
const stamp = (d = new Date()) => {
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/* ── 连接串：env 优先，其次 .env.backup ───────────────────── */
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
  const file = readEnvBackup();
  const fromCli = valOf("--url");
  return fromCli
    || process.env.SUPABASE_DB_URL || process.env.WP_DB_URL || process.env.DATABASE_URL
    || file.SUPABASE_DB_URL || file.WP_DB_URL || file.DATABASE_URL
    || null;
}

/* 占位符守卫：模板串没替换掉就别去连库——否则报“密码认证失败”，人会以为密码错。
   只认「整段就是占位符」，不在全串里找 your 之类弱特征：密码里真的可能有 your，
   误判一次就等于把真密码锁在门外（S14 钉住这条）。 */
function isPlaceholder(url) {
  const s = String(url || "");
  if (/<region>|<ref>|<数据库密码>/i.test(s)) return true;
  const m = s.match(/:\/\/([^:/@]+):([^@]*)@/);
  if (!m) return false;
  let pw = m[2];
  try { pw = decodeURIComponent(pw); } catch { /* 保留原样 */ }
  pw = pw.trim();
  return pw === "" || /^\[?your[-_ ]?password\]?$/i.test(pw) || /^<.*>$/.test(pw);
}

/* 日志里永不出现密码（踩坑录精神：凭据不进输出，也别进截图）。
   但占位符不脱敏——把 `[YOUR-PASSWORD]` 打成 *** 会让“还没填密码”看起来像“已填好”，
   我第一次真备份就被这个骗了一次。 */
function redact(url) {
  return String(url).replace(/(:\/\/[^:/@]+:)([^@]*)@/, (all, head, pw) =>
    /^\[?your[-_ ]?password\]?$/i.test(String(pw).trim()) ? all : `${head}***@`);
}

/* ── pg_dump 定位：PATH → Windows 常见安装目录 ─────────────── */
function isExe(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
}

function findPgBin(name) {
  /* PG_BIN 优先：绿色版 / 便携版把 bin 目录指过来即可，不必改系统 PATH */
  const pgBinDir = process.env.PG_BIN && process.env.PG_BIN.trim();
  if (pgBinDir) {
    for (const cand of [path.join(pgBinDir, `${name}.exe`), path.join(pgBinDir, name)]) {
      if (isExe(cand)) {
        const v = spawnSync(cand, ["--version"], { encoding: "utf8" });
        return { bin: cand, version: (v.stdout || "").trim() };
      }
    }
  }
  const probe = spawnSync(name, ["--version"], { encoding: "utf8" });
  if (!probe.error && probe.status === 0) {
    const v = (probe.stdout || "").trim();
    return { bin: name, version: v };
  }
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
    /* 版本号从大到小试 */
    subs.sort((a, b) => parseFloat(b.replace(/^[^\d]*/, "")) - parseFloat(a.replace(/^[^\d]*/, "")));
    for (const sub of subs) {
      const cands = [
        path.join(root, sub, "bin", `${name}.exe`),
        path.join(root, sub, "bin", name),
      ];
      for (const c of cands) {
        if (isExe(c)) {
          const v = spawnSync(c, ["--version"], { encoding: "utf8" });
          return { bin: c, version: (v.stdout || "").trim() };
        }
      }
    }
  }
  return null;
}

const INSTALL_HINT = [
  "本机没有 pg_dump（PostgreSQL 客户端）。三选一装：",
  "  · winget:  winget install --id PostgreSQL.PostgreSQL.17 -e   （装整套，约 300MB，需管理员）",
  "  · 绿色版:  只解压 PostgreSQL 的 bin 目录，然后 set PATH=%PATH%;<解压目录>\\bin",
  "  · Docker:  docker run --rm postgres:17 pg_dump ...（本机当前没装 docker）",
].join("\n");

/* ── 轮转：只删本脚本自己的产物，绝不碰目录里别的东西 ───── */
function rotate(dir, keep) {
  if (!fs.existsSync(dir)) return { removed: [], kept: [] };
  const dumps = fs.readdirSync(dir)
    .filter((f) => DUMP_RE.test(f))
    .sort() // 文件名里的时间戳可字典序比较
    .reverse();
  const kept = dumps.slice(0, keep);
  const removed = dumps.slice(keep);
  for (const f of removed) {
    try { fs.unlinkSync(path.join(dir, f)); } catch { /* 删不掉就留着，不影响备份成功 */ }
  }
  return { removed, kept };
}

function sha256(file) {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(file));
  return h.digest("hex").toUpperCase();
}

function appendManifest(rec) {
  try {
    fs.appendFileSync(path.join(DIR, "MANIFEST.jsonl"), JSON.stringify(rec) + "\n");
  } catch (e) {
    log(`[!] 写 MANIFEST.jsonl 失败（备份本身已成功）：${e.message}`);
  }
}

/* ── 校验：pg_restore --list 能读出表结构才算“可恢复” ──────
 * 注意 pg_restore --list 的行格式（踩过的坑）：
 *   207; 1259 16391 TABLE public profiles postgres          ← 最后一个是 owner
 *   3456; 0 16391 TABLE DATA public profiles postgres       ← 同上
 * 所以表名不能取「最后一个 token」，必须按 TABLE DATA <schema> <table> <owner> 定位。 */
function parseRestoreList(text) {
  const lines = String(text).split(/\r?\n/);
  const tableData = lines.filter((l) => /\sTABLE DATA\s/.test(l));
  const names = new Set();
  for (const l of tableData) {
    const m = l.match(/\sTABLE DATA\s+(\S+)\s+(\S+)/);
    if (m) names.add(m[2].replace(/"/g, ""));
  }
  const missing = MUST_HAVE.filter((t) => !names.has(t));
  return {
    tables: tableData.length,
    names: [...names],
    missing,
    entries: lines.filter((l) => /^\d+;/.test(l)).length,
  };
}

function verifyDump(file, restoreBin) {
  const r = spawnSync(restoreBin, ["--list", file], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) {
    return { ok: false, reason: (r.stderr || r.error?.message || "pg_restore --list 失败").trim().slice(0, 400) };
  }
  return { ok: true, ...parseRestoreList(r.stdout) };
}

/* ═══════════════════════ 自检（不碰数据库） ═══════════════════════ */
function selfTest() {
  let pass = 0, fail = 0;
  const ok = (n, c, extra = "") => { if (c) { pass++; log(`PASS  ${n} ${extra}`); } else { fail++; log(`FAIL  ${n} ${extra}`); } };

  ok("S1 密码脱敏：URL 里的密码被替换，主机与用户名保留",
    redact("postgresql://postgres.abc:Secr3t!@aws-0-ap.aws.com:5432/postgres")
      === "postgresql://postgres.abc:***@aws-0-ap.aws.com:5432/postgres");
  ok("S2 没有密码的 URL 原样返回（不误伤）",
    redact("postgresql://user@host:5432/db") === "postgresql://user@host:5432/db");
  ok("S3 文件名格式符合 DUMP_RE（轮转只认这种）",
    DUMP_RE.test(`warmpaws-${stamp()}.dump`) && !DUMP_RE.test("warmpaws-manual.dump") && !DUMP_RE.test("other-20260101-000000.dump"));

  /* 轮转：造 5 份 dump + 1 个「别人的文件」，keep=2 后只剩 2 份，且别人的文件必须还在 */
  const tmp = fs.mkdtempSync(path.join(process.env.TEMP || "/tmp", "wp-backup-selftest-"));
  try {
    const names = ["warmpaws-20260101-000001.dump", "warmpaws-20260102-000002.dump", "warmpaws-20260103-000003.dump",
      "warmpaws-20260104-000004.dump", "warmpaws-20260105-000005.dump"];
    for (const n of names) fs.writeFileSync(path.join(tmp, n), "x");
    fs.writeFileSync(path.join(tmp, "别动我.txt"), "keep me");
    const { removed, kept } = rotate(tmp, 2);
    const left = fs.readdirSync(tmp).filter((f) => DUMP_RE.test(f)).sort();
    ok("S4 轮转只留最近 keep 份", left.length === 2 && kept.length === 2 && removed.length === 3, `留下 ${left.join(",")}`);
    ok("S5 轮转按时间戳保留最新的两份", left.join() === "warmpaws-20260104-000004.dump,warmpaws-20260105-000005.dump");
    ok("S6 轮转不碰目录里非本脚本的文件", fs.existsSync(path.join(tmp, "别动我.txt")));
    ok("S7 空目录轮转不报错", (() => { const e = fs.mkdtempSync(path.join(tmp, "empty-")); const r = rotate(e, 3); return r.removed.length === 0 && r.kept.length === 0; })());
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  /* 必含表清单与 SUPABASE_SETUP 保持一致（防止有人改了表名、备份校验却还在看旧名字） */
  const setup = path.join(ROOT, "SUPABASE_SETUP.sql");
  if (fs.existsSync(setup)) {
    const sql = fs.readFileSync(setup, "utf8");
    const absent = MUST_HAVE.filter((t) => !new RegExp(`create table if not exists public\\.${t}\\b`, "i").test(sql));
    ok("S8 MUST_HAVE 里的表都真实存在于 SUPABASE_SETUP.sql", absent.length === 0, absent.join(",") || "");
  } else {
    ok("S8 SUPABASE_SETUP.sql 存在", false);
  }

  /* S9/S10：pg_restore --list 的解析（真实行格式，末位是 owner 不是表名 —— 这里踩过一次） */
  const sample = [
    ";",
    "; Archive created at 2026-11-04 03:40:00 UTC",
    ";     dbname: postgres",
    ";",
    "5; 2615 2200 SCHEMA - public postgres",
    "7; 1259 16391 TABLE public profiles postgres",
    "8; 0 16391 TABLE DATA public profiles postgres",
    "9; 0 16393 TABLE DATA public wall_posts postgres",
    "10; 0 16395 TABLE DATA public wall_comments postgres",
    "11; 0 16397 TABLE DATA public dm_messages postgres",
    "12; 0 16399 TABLE DATA public pets postgres",
  ].join("\n");
  const parsed = parseRestoreList(sample);
  ok("S9 解析 TABLE DATA 取到表名（不是 owner）",
    parsed.tables === 5 && parsed.names.includes("profiles") && !parsed.names.includes("postgres"),
    `tables=${parsed.tables} names=${parsed.names.join(",")}`);
  ok("S10 核心表齐全时不报缺失", parsed.missing.length === 0);
  const partial = parseRestoreList("8; 0 16391 TABLE DATA public profiles postgres\n");
  ok("S11 核心表缺失时如实点名", partial.missing.length === MUST_HAVE.length - 1 && partial.missing.includes("wall_posts"),
    partial.missing.join(","));

  /* S13~S15：占位符守卫本身（这三个坑是 2026-11-04 第一次真备份时现场踩的）
     —— 当时 connect 弹窗 Copy 出来的是 [YOUR-PASSWORD]，而 redact() 把它打成 ***，
        导致日志看起来“格式正确”，我误判成用户填好了，白绕一大圈。 */
  ok("S13 `[YOUR-PASSWORD]` 必须判成占位符",
    isPlaceholder("postgresql://postgres.abc:[YOUR-PASSWORD]@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres"));
  ok("S14 密码里含 your 的真实串不能被误判（误判会让真密码用不了）",
    !isPlaceholder("postgresql://postgres.abc:YourName2026@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres"));
  ok("S15 模板尖括号仍判占位符", isPlaceholder("postgresql://postgres.abc:<数据库密码>@aws-0-<region>.pooler.supabase.com:5432/postgres"));
  ok("S16 占位符不做脱敏（否则日志会让占位符看起来像真密码）",
    redact("postgresql://u:[YOUR-PASSWORD]@h:5432/db").includes("[YOUR-PASSWORD]"),
    redact("postgresql://u:[YOUR-PASSWORD]@h:5432/db"));
  ok("S17 真密码照旧脱敏", redact("postgresql://u:RealPw123@h:5432/db").endsWith(":***@h:5432/db"),
    redact("postgresql://u:RealPw123@h:5432/db"));

  /* S12：真 pg_restore 在（可选）时，喂一份垃圾文件必须判「不可信」，不能当成功 */
  const probeRestore = findPgBin("pg_restore");
  if (probeRestore) {
    const junk = path.join(fs.mkdtempSync(path.join(process.env.TEMP || "/tmp", "wp-junk-")), "junk.dump");
    fs.writeFileSync(junk, "this is not a dump");
    const v = verifyDump(junk, probeRestore.bin);
    ok("S12 非 dump 文件被 pg_restore 拒绝时，校验判定为失败（不放过坏备份）", v.ok === false, (v.reason || "").slice(0, 60));
    try { fs.rmSync(path.dirname(junk), { recursive: true, force: true }); } catch { /* ignore */ }
  } else {
    log("SKIP  S12 本机无 pg_restore，跳过「坏产物必须判失败」实证");
  }

  log(`\nTOTAL ${pass + fail}  PASS ${pass}  FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
}

if (has("--self-test")) selfTest();

/* ═══════════════════════ 环境体检 ═══════════════════════ */
const pgDump = findPgBin("pg_dump");
const pgRestore = findPgBin("pg_restore");
const url = resolveUrl();

log("── 备份环境体检 ──────────────────────────────");
log(`  pg_dump     : ${pgDump ? `${pgDump.version}  (${pgDump.bin})` : "未找到"}`);
log(`  pg_restore  : ${pgRestore ? `${pgRestore.version}` : "未找到"}`);
log(`  连接串      : ${url ? redact(url) : "未配置"}`);
log(`  备份目录    : ${DIR}`);
log(`  保留份数    : ${KEEP}`);
log(`  导出 schema : ${SCHEMAS.join(", ")}`);
log("");

if (has("--check")) {
  let bad = 0;
  if (!pgDump) { log(`[!] 缺 pg_dump。\n${INSTALL_HINT}`); bad++; }
  if (!pgRestore) { log("[!] 缺 pg_restore（校验用，与 pg_dump 同目录）。"); bad++; }
  if (!url) {
    log("[!] 没配连接串。把下面一行写进项目根目录 `.env.backup`（已在 .gitignore）：");
    log("    SUPABASE_DB_URL=postgresql://postgres.<ref>:<密码>@aws-0-<region>.pooler.supabase.com:5432/postgres");
    log("    取值：Supabase Dashboard → Project Settings → Database → Connection string → URI（Direct / Session pooler）");
    bad++;
  }
  if (!bad && url) {
    /* 真连一次：只导一个不存在的表，鉴权通过即返回 0（比 pg_isready 更能证明权限够） */
    const probe = spawnSync(pgDump.bin, ["--schema-only", "--no-owner", "--no-privileges", "-t", "public.__wp_probe__", url],
      { encoding: "utf8", timeout: 30_000 });
    if (probe.status === 0) log("[OK] 连通性与权限通过（能读到 catalog）");
    else { log(`[!] 连接失败：${(probe.stderr || "").trim().split("\n").slice(-3).join(" ")}`); bad++; }
  }
  log(bad ? `\n结论：还不能备份（${bad} 项待处理）\n` : "\n结论：可以备份，直接跑 `node tools/backup.mjs`\n");
  process.exit(bad ? 2 : 0);
}

if (has("--print-cmd")) {
  /* 只打印不执行：环境不全也能看（缺工具/缺连接串时用占位符），方便核对参数 */
  const bin = pgDump ? pgDump.bin : "pg_dump";
  const shownUrl = url ? redact(url) : "<SUPABASE_DB_URL>";
  const outName = path.join(DIR, `warmpaws-${stamp()}.dump`);
  const shown = [bin, "--no-owner", "--no-privileges", "--format=custom", "-Z", "6",
    ...SCHEMAS.flatMap((s) => ["--schema", s]), "--file", outName, shownUrl]
    .map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
  log(shown);
  log("\n（只打印，未执行。去掉 --print-cmd 即真跑。）");
  process.exit(0);
}

if (!pgDump) die(`缺 pg_dump，无法备份。\n\n${INSTALL_HINT}`, 2);
if (!url) die("没配连接串（SUPABASE_DB_URL / .env.backup），先用 --check 看引导。", 2);
if (isPlaceholder(url)) die(
  "`.env.backup` 里的密码还是占位符，没换成真密码。\n\n" +
  "  常见原因：Connect 弹窗里点 Copy 复制出来的原文就是\n" +
  "    postgresql://postgres.<ref>:[YOUR-PASSWORD]@aws-0-<region>.pooler.supabase.com:5432/postgres\n" +
  "  其中 [YOUR-PASSWORD] 要手工替换成数据库密码（Supabase 不回显密码，只存哈希）。\n" +
  "  不记得密码：同一个弹窗里点 Reset database password，新密码只显示一次，当场复制。\n" +
  "  别用 @ : / ? # 这类符号，否则要写成 %40 这种形式，否则报错会伪装成“密码错”。", 2);
if (!pgRestore) log("[!] 没找到 pg_restore：本次跳过多表校验（建议补齐客户端后复跑 --check）\n");

/* ═══════════════════════ 恢复演练 --drill ═══════════════════════
 * 为什么要有：没演练过的备份不算备份。2026-11-04 第一份真备份手工演练过一次
 * （62 张表内容指纹与生产完全一致），把步骤固化下来，以后一条命令就能复验。
 * 判定标准不是“pg_restore 没报错”，而是**逐表内容指纹相等**——只比行数会漏掉
 * “行数一样但值变了”的情况。
 * 安全边界：只碰 wp_drill_ 前缀的库，演练完自动 DROP；--keep-drill 可留库排查。
 */
const DRILL_PREFIX = "wp_drill_";
const FINGERPRINT_SQL = `
select n.nspname || '.' || c.relname || '|' || coalesce((
  xpath('/row/c/text()', query_to_xml(
    format('select coalesce(md5(string_agg(h, %L order by h)), %L) as c
            from (select md5(t::text) as h from %I.%I t) s', '', 'EMPTY',
           n.nspname, c.relname), false, true, '')))[1]::text, 'ERR')
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relkind = 'r' and n.nspname in ('public', 'auth', 'storage')
order by 1;`;

/* 良性错误：全新库自带 public，恢复时必然报一句“已存在”，不算问题 */
const BENIGN = /schema "public" already exists/i;

function psqlRun(bin, conn, args) {
  return spawnSync(bin, ["-v", "ON_ERROR_STOP=1", "-d", conn, ...args], {
    encoding: "utf8", timeout: 20 * 60_000, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PGCONNECT_TIMEOUT: "20" },
  });
}
function fingerprints(psqlBin, conn) {
  const r = spawnSync(psqlBin, ["-tA", "-d", conn, "-c", FINGERPRINT_SQL], {
    encoding: "utf8", timeout: 10 * 60_000, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PGCONNECT_TIMEOUT: "20" },
  });
  if (r.error || r.status !== 0) {
    die(`取内容指纹失败（${conn.replace(/:[^:@/]+@/, ":***@")}）：\n${(r.stderr || r.error?.message || "").trim().slice(-400)}`, 1);
  }
  return r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

if (has("--drill")) {
  const psqlBin = findPgBin("psql");
  if (!psqlBin) die("--drill 需要 psql（和 pg_dump 同一个包里，用 PG_BIN 指过去即可）。", 2);
  if (!pgRestore) die("--drill 需要 pg_restore。", 2);

  const dumps = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => DUMP_RE.test(f)).sort() : [];
  const file = valOf("--file") ? path.resolve(ROOT, valOf("--file")) : (dumps.length ? path.join(DIR, dumps[dumps.length - 1]) : null);
  if (!file || !fs.existsSync(file)) die("没找到要演练的 dump。先跑一次 node tools/backup.mjs，或用 --file=backups/xxx.dump 指定。", 2);

  /* 库名只允许 [a-z0-9_]：这是 DROP 语句的唯一防线，别让它从外部构造出别的库名 */
  const db = (DRILL_PREFIX + stamp()).toLowerCase().replace(/[^a-z0-9_]/g, "");
  const drillUrl = url.replace(/\/[^/]+$/, `/${db}`);
  if (!drillUrl.includes(`/${db}`)) die("连接串结尾不是数据库名，无法拼出演练库地址。", 2);

  log(`── 恢复演练 ──────────────────────────────`);
  log(`  源文件      : ${path.relative(ROOT, file)}`);
  log(`  演练库      : ${db}（演练结束即删）`);
  log(`  判定标准    : 62 张表的逐表内容指纹必须与生产完全相等\n`);

  log(`[1/5] 建空库`);
  const mk = psqlRun(psqlBin.bin, url, ["-q", "-c", `drop database if exists ${db} with (force)`, "-c", `create database ${db}`]);
  if (mk.error || mk.status !== 0) die(`建库失败：\n${(mk.stderr || mk.error?.message || "").trim().slice(-400)}`, 1);

  log(`[2/5] 装前置扩展（pg_trgm/pgcrypto —— 生产上它们装在 public，不装则索引与非空约束恢复不出来）`);
  const ext = psqlRun(psqlBin.bin, drillUrl, ["-q", "-c", "create extension if not exists pg_trgm", "-c", "create extension if not exists pgcrypto"]);
  if (ext.error || ext.status !== 0) log(`      [!] 扩展安装有告警，继续：${(ext.stderr || "").trim().split("\n")[0]}`);

  log(`[3/5] 全量恢复（--no-owner --no-privileges）`);
  const tR = Date.now();
  const rest = spawnSync(pgRestore.bin, ["--no-owner", "--no-privileges", "--dbname", drillUrl, file], {
    encoding: "utf8", timeout: 30 * 60_000, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, PGCONNECT_TIMEOUT: "20" },
  });
  const errLines = (rest.stderr || "").split(/\r?\n/).filter((l) => /^pg_restore: error/i.test(l));
  const realErr = errLines.filter((l) => !BENIGN.test(l));
  const secs = ((Date.now() - tR) / 1000).toFixed(1);
  log(`      ${realErr.length ? "有" : "无"}非良性错误 · ${errLines.length} 条报错 · 用时 ${secs}s`);
  if (realErr.length) {
    for (const l of realErr.slice(0, 5)) log(`      ${l.slice(0, 160)}`);
  }

  log(`[4/5] 逐表内容指纹比对`);
  const a = fingerprints(psqlBin.bin, url);
  const b = fingerprints(psqlBin.bin, drillUrl);
  const mapA = new Map(a.map((l) => [l.split("|")[0], l.split("|")[1]]));
  const mapB = new Map(b.map((l) => [l.split("|")[0], l.split("|")[1]]));
  const missing = [...mapA.keys()].filter((k) => !mapB.has(k));
  const extra = [...mapB.keys()].filter((k) => !mapA.has(k));
  const differ = [...mapA.keys()].filter((k) => mapB.has(k) && mapA.get(k) !== mapB.get(k));
  const rows = a.length;
  log(`      生产 ${a.length} 张表 · 演练 ${b.length} 张表 · 缺失 ${missing.length} · 多出 ${extra.length} · 内容不一致 ${differ.length}`);
  for (const k of [...missing.slice(0, 5), ...differ.slice(0, 5), ...extra.slice(0, 5)]) log(`      → ${k}`);

  log(`[5/5] 清理演练库`);
  if (has("--keep-drill")) {
    log(`      按 --keep-drill 保留：${db}（排查完记得 drop database ${db} with (force)）`);
  } else {
    const dp = psqlRun(psqlBin.bin, url, ["-q", "-c", `drop database if exists ${db} with (force)`]);
    if (dp.error || dp.status !== 0) log(`      [!] 删库失败，请手工执行：drop database ${db} with (force)`);
    else log(`      已删除 ${db}`);
  }

  const bad = missing.length + extra.length + differ.length + realErr.length;
  log("");
  if (bad === 0) {
    log(`✅ 演练通过：${rows} 张表内容逐字节一致，恢复链路可信。`);
    process.exit(0);
  }
  log(`❌ 演练没通过（${bad} 处异常）。这份 dump 现在不能算“可恢复”。`);
  process.exit(1);
}


/* ═══════════════════════ 备份 ═══════════════════════ */
fs.mkdirSync(DIR, { recursive: true });
const name = `warmpaws-${stamp()}.dump`;
const out = path.join(DIR, name);
const t0 = Date.now();

log(`[1/4] 导出 → ${path.relative(ROOT, out)}`);
const dumpArgs = [
  "--no-owner", "--no-privileges",
  "--format=custom", "-Z", "6",
  ...SCHEMAS.flatMap((s) => ["--schema", s]),
  "--file", out, url,
];
const dump = spawnSync(pgDump.bin, dumpArgs, { encoding: "utf8", timeout: 30 * 60_000, maxBuffer: 32 * 1024 * 1024 });

if (dump.error || dump.status !== 0) {
  try { fs.existsSync(out) && fs.unlinkSync(out); } catch { /* 半截文件删掉，别混进轮转 */ }
  const err = (dump.stderr || dump.error?.message || "").trim();
  const tail = err.split("\n").slice(-8).join("\n");

  /* 按错误类型给下一步，而不是一句“失败了”让人干瞪眼。
   * 注意区分：连接/鉴权 与 schema 权限 是两件完全不同的事，给错建议会浪费半小时。 */
  let hint = "";
  if (/password authentication failed|role .* does not exist/i.test(err)) {
    hint = "密码或用户名不对。连接串里的密码要用 **数据库密码**（Project Settings → Database → Reset database password 设的那个），\n" +
      "不是 anon key、不是登录密码；密码里的 @ : / ? # 必须做 URL 编码（@ → %40）。";
  } else if (/could not translate host name|nodename nor servname|Name or service not known/i.test(err)) {
    hint = "主机名解析失败：从 Dashboard 复制的连接串里 host 形如 aws-0-<region>.pooler.supabase.com，\n" +
      "容易漏掉 pooler 段或写错 region。";
  } else if (/Connection refused|timeout expired|could not connect|ECONNREFUSED/i.test(err)) {
    hint = "连不上：确认用的是 Direct connection / Session pooler（端口 5432），不是 Transaction pooler（6543 —— 它不支持 pg_dump）。\n" +
      "本机网络若要走代理，pg_dump 不读系统代理，需先设 HTTPS_PROXY 或用直连网络重试。";
  } else if (/server version|aborting because of server version mismatch/i.test(err)) {
    hint = "客户端版本低于服务端。装更新的 PostgreSQL 客户端（≥ 服务端大版本）。";
  } else if (/permission denied|must be owner|schema .* does not exist/i.test(err)) {
    hint = "schema 权限不足（Supabase 上偶发）。先退到最小集验证通路，再逐步加 schema：\n" +
      "  node tools/backup.mjs --schema=public";
  } else {
    hint = "把上面这段原文发我，或先跑 `node tools/backup.mjs --check` 复验连通性。";
  }
  die(`导出失败（exit ${dump.status}）。\n${tail}\n\n${hint}`, 1);
}

const bytes = fs.statSync(out).size;
if (bytes < 1024) {
  try { fs.unlinkSync(out); } catch { /* ignore */ }
  die(`产物只有 ${bytes} 字节，明显不对（可能连到了错的库）。已删除。`, 1);
}
log(`      ${kb(bytes)}  用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

log("[2/4] 校验（pg_restore --list）");
let check = { ok: true, tables: 0, missing: [], names: [] };
if (pgRestore) {
  check = verifyDump(out, pgRestore.bin);
  if (!check.ok) die(`产物无法被 pg_restore 解析，备份不可信：${check.reason}`, 1);
  log(`      ${check.tables} 张表有数据 · ${check.entries} 个对象`);
  if (check.missing.length) {
    log(`      [!] 以下核心表在 dump 里没有数据：${check.missing.join(", ")}`);
    log("          全新库（还没有帖子/私信）时这属正常；已有数据时说明备份没覆盖到，请复查 schema 参数。");
  }
} else {
  log("      跳过（缺 pg_restore）");
}

log("[3/4] 指纹 + 台账");
const digest = sha256(out);
appendManifest({
  at: new Date().toISOString(), file: name, bytes, sha256: digest,
  schemas: SCHEMAS, tables: check.tables, missing: check.missing,
  seconds: +((Date.now() - t0) / 1000).toFixed(1), pg: pgDump.version,
});
log(`      SHA-256 ${digest}`);

log(`[4/4] 轮转（保留 ${KEEP} 份）`);
const { removed, kept } = rotate(DIR, KEEP);
log(`      现有 ${kept.length} 份${removed.length ? `，删除 ${removed.length} 份旧的：${removed.join(", ")}` : ""}`);

log(`
完成。
  文件：${out}
  大小：${kb(bytes)}
  恢复：pg_restore --clean --if-exists --no-owner -d "<目标库连接串>" "${name}"
        ⚠️ 恢复前先在空库演练过一次，别拿生产库当第一次实验（见 jiaojie 轮 402）。
`);
process.exit(0);
