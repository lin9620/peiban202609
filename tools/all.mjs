/* 全量测试统一入口（轮 402）
 * ------------------------------------------------------------
 * 为什么要有这个文件：
 *   项目里有 90+ 个独立测试脚本，此前靠 jiaojie.md 里手写的命令清单人肉串跑，
 *   真实项数与文档对不上（踩坑 #19），"全量 45 套"这种口径每次都要重新数。
 *   本文件把「有哪些测试、各自属于哪一层、跑多久、过没过」固化成一条命令。
 *
 * 用法：
 *   node tools/all.mjs                  # 默认只跑 fast 层（离线单测/静态扫描，最常用）
 *   node tools/all.mjs --tier=mount     # 构建产物挂载冒烟（需要 dist/，会启动无头浏览器）
 *   node tools/all.mjs --tier=fast,mount
 *   node tools/all.mjs --tier=live      # 需要 CDP 9222 / 本地 dev 服务器 / 真机
 *   node tools/all.mjs --tier=prod      # 线上只读探针（读生产，不写）
 *   node tools/all.mjs --tier=net       # 线上端到端（**会注册 wp-* 测试账号、写真实数据**）
 *   node tools/all.mjs --all            # fast + mount + prod（不含 live/net，避免误触）
 *   node tools/all.mjs --only=i18n,dm   # 按文件名子串过滤（逗号分隔，任一命中）
 *   node tools/all.mjs --list           # 只列清单，不执行
 *   node tools/all.mjs --bail           # 首个失败即停
 *   node tools/all.mjs --json           # 额外写 _scratch/test-report.json
 *
 * 分层口径（新增测试请照此归类，否则会出现在"未分层"告警里）：
 *   fast  —— 纯 Node：纯函数单测、源码静态断言、构建产物文本扫描。无网络、无浏览器。
 *   mount —— 需要 dist/ 产物 + 无头浏览器真实挂载（page-smoke）。改 .vue 必跑。
 *   live  —— 需要外部活体环境：CDP 9222 的浏览器、localhost:5173 的 dev 服务器、adb 真机。
 *   prod  —— 线上**只读**探针（live-check / online-check / live-bundle-check / cloud-verify）。
 *   net   —— 线上**端到端写数据**（*-e2e.mjs：自造 wp-* 账号，会改生产库）。谨慎。
 *
 * 退出码：0 全过 / 1 有失败 / 2 用法或前置条件错误。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOOLS = path.join(ROOT, "tools");

/* ═══════════════════════ 清单 ═══════════════════════
 * note 只用于「跑起来需要什么」，出现在 --list 与失败提示里。 */
const MANIFEST = [
  /* ── fast：纯 Node，无网络无浏览器 ───────────────────────── */
  ...[
    "admin-test", "admin-dau-test", "announcement-test", "api-contract-test", "app-download-test", "app-shell-test",
    "daily-story-test",
    "app-version-test", "arity-test", "auth-test", "avatar-test", "back-stack-test",
    "bottle-autosize-test", "bottle-chat-test", "bottle-gap-test", "bottle-records-speed-test",
    "bottle-test", "bottle-vac-test", "cache-test", "chat-height-test", "chat-look-test", "cmt-style-test",
    "cmt-teleport-test",
    "card-tap-test", "comment-test", "community-safe-area-test", "dm-entry-fail-test", "dm-first-open-test",
    "dm-map-test", "dm-race-test", "dm-recall-menu-test", "dm-scroll-test", "dm-search-test",
    "dm-send-jump-test", "dm-send-ux-test", "dm-tail-cache-test", "dm-test", "dm-vac-test", "dm-mute-test",
    "emoji-panel-test", "feed-archive-test", "feed-autoload-test", "feed-perf-test", "feed-window-test", "font-test",
    "fold-text-test", "food-painter-test", "gateway-contract-test", "home-panes-test",
    "i18n-test", "i18n-usage-test", "icon-test", "skin-gate-test", "kb-math-test", "keyboard-policy-test", "lang-detect-test", "content-lang-test", "template-scope-test", "messages-gap-test",
    "migration-check-test", "mood-test", "notify-test", "notif-prefs-test", "pet-home-test", "pet-visual-test",
    "post-detail-test", "post-nav-test", "privacy-test", "proto-chat-test", "rail-test",
    "react-multikind-test", "react-queue-test", "report-test", "responsiveness-test", "rps-test",
    "seo-test", "snack-test", "splash-test", "status-counts-test", "status-test", "story-test",
    "maintenance-test", "owner-delete-test", "follow-test", "follow-feed-test", "menu-close-test", "mypost-comments-test", "scoped-class-test",
    "tabbar-copy-test", "tap-guard-test", "teleport-test", "uifix-test", "undef-check",
    "userScope-test", "wall-addviews-test", "wall-composer-test", "wall-reaction-test",
    "wall-refresh-test", "wall-empty-test", "wall-end-test", "wall-rules-test", "wall-test", "web-refresh-test", "worker-test",
    "tdz-check",
  ].map((n) => ({ file: `${n}.mjs`, tier: "fast" })),

  /* ── mount：dist/ + 无头浏览器真实挂载 ───────────────────── */
  { file: "page-smoke.mjs", tier: "mount", note: "需 dist/（先 npm run build）" },
  /* 轮 434：虚拟滚动的真实浏览器实测（滚到底 + 原路回顶 + 进详情再回来）。
     需要**同源构建**的产物（VITE_API_BASE= npx vite build）与网络：它会真的去读生产数据。 */
  { file: "feed-virtual-live.mjs", tier: "mount", note: "需同源 dist/ + 无头浏览器 + 网络" },
  /* 轮 470：多内核矩阵 —— 6 种浏览器语义 × 4 种屏幕，真实排版量「输入条/聊天页」的几何。
     不需要网络也不写真数据（注入 DOM + 伪造视口读数），只要求 dist/ 是最新的。约 100s。 */
  { file: "kb-matrix.mjs", tier: "mount", note: "需 dist/（先 npm run build），约 100s" },

  /* 备份脚本的自检（--self-test 不连库、不碰网络，纯逻辑：脱敏/占位符/轮转/还原清单解析） */
  { file: "backup.mjs", tier: "fast", args: ["--self-test"], note: "备份脚本自检" },
  /* 存量语言回填的自检（--self-test 不连库：检测→变化判定→SQL 生成，含 bigint/uuid 两种主键） */
  { file: "backfill-lang.mjs", tier: "fast", args: ["--self-test"], note: "回填脚本自检" },

  /* ── live：需要 CDP / dev server / 真机 ─────────────────── */
  { file: "smoke.mjs", tier: "live", note: "需 dev 服务器 localhost:5173" },
  { file: "web-probe.mjs", tier: "live", note: "需 dev server 或 --url" },
  { file: "feed-window-live.mjs", tier: "live", note: "需 dev server + CDP 9222" },
  { file: "dm-compose-test.mjs", tier: "live", note: "需 CDP 9222" },
  { file: "wall-keep-test.mjs", tier: "live", note: "需 CDP 9222" },
  { file: "env-probe.mjs", tier: "live", note: "环境探针（只读）" },
  /* 轮 422/423 的按压玻璃真机验收（走 CDP 真触摸 + 取色），需要 9222 已转发 */
  { file: "press-verify.mjs", tier: "live", note: "需 CDP 9222（按压帧取色）" },
  { file: "row-glass-verify.mjs", tier: "live", note: "需 CDP 9222（会话行玻璃）" },
  { file: "row2-verify.mjs", tier: "live", note: "需 CDP 9222（高亮搬家）" },
  /* 轮 474：进会话首帧逐帧录制（定位「输入条弹起又折叠」的塌缩帧），需真机 WebView 调试口 */
  { file: "kb-enter-probe.mjs", tier: "live", args: ["--port=9333", "--click=.dm-row|1"], note: "需真机 CDP（进会话首帧）" },

  /* ── prod：线上只读探针 ─────────────────────────────────── */
  { file: "live-check.mjs", tier: "prod", note: "部署后跑，读线上" },
  { file: "online-check.mjs", tier: "prod", note: "读线上" },
  { file: "live-bundle-check.mjs", tier: "prod", note: "本地 dist vs 线上逐字节" },
  { file: "cloud-verify.mjs", tier: "prod", note: "读 Supabase（需 .env）" },

  /* ── net：线上端到端，会写真实数据 ─────────────────────── */
  { file: "cloud-e2e.mjs", tier: "net", note: "会注册 wp-* 账号" },
  { file: "dm-e2e.mjs", tier: "net", note: "会发真实私信" },
  { file: "dm-mute-e2e.mjs", tier: "net", note: "免打扰静音口径，会发真实私信" },
  { file: "notif-prefs-e2e.mjs", tier: "net", note: "通知偏好关闭效果，会发帖/评论/摸宠物" },
  { file: "bottle-e2e.mjs", tier: "net", note: "会投/捞漂流瓶" },
  { file: "status-e2e.mjs", tier: "net", note: "会写状态" },
  { file: "nick-e2e.mjs", tier: "net", note: "会改昵称" },
  { file: "img-cache-e2e.mjs", tier: "net", note: "走线上图片缓存" },
  { file: "dislike-e2e.mjs", tier: "net", note: "会投厌恶票" },
  { file: "story-b3-e2e.mjs", tier: "net", note: "会写故事" },
  { file: "wall-addviews-e2e.mjs", tier: "net", note: "会加浏览量" },
];

/* 明确不是测试的脚本（生成器/构建器/驱动器），未分层检查时忽略 */
const NOT_TESTS = new Set([
  "apk-to-web.mjs", "build-until-good.mjs", "bump-version.mjs", "cap-strip-hero.mjs",
  "cdp-eval.mjs", "emo-device-drive.mjs", "emo-drive.mjs", "gen-avatars.mjs",
  "gen-icon-concepts.mjs", "gen-icons.mjs", "image-fit.mjs", "make-app-icon.mjs",
  "make-app-icon-legacy-blue.mjs", "make-app-icon-legacy-night.mjs", "make-og.mjs",
  "all.mjs", "backup.mjs",
]);

const TIER_TIMEOUT = { fast: 120_000, mount: 300_000, live: 300_000, prod: 120_000, net: 300_000 };
const TIER_LABEL = {
  fast: "离线单测 / 静态扫描",
  mount: "构建产物挂载冒烟",
  live: "活体环境（CDP / dev server / 真机）",
  prod: "线上只读探针",
  net: "线上端到端（写数据）",
};

/* ═══════════════════════ 参数 ═══════════════════════ */
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valOf = (name) => {
  const a = argv.find((x) => x.startsWith(`${name}=`));
  return a ? a.slice(name.length + 1) : null;
};
const usage = () => {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0].replace(/^\/\*/, ""));
};

if (has("--help") || has("-h")) { usage(); process.exit(0); }

const onlyArg = valOf("--only");
const only = onlyArg ? onlyArg.split(",").map((s) => s.trim()).filter(Boolean) : null;
let tiers;
if (has("--all")) tiers = ["fast", "mount", "prod"];
else if (valOf("--tier")) tiers = valOf("--tier").split(",").map((s) => s.trim()).filter(Boolean);
else tiers = ["fast"];

const badTier = tiers.find((t) => !TIER_LABEL[t]);
if (badTier) { console.error(`未知分层：${badTier}（可选：${Object.keys(TIER_LABEL).join(" / ")}）`); process.exit(2); }

let queue = MANIFEST.filter((m) => tiers.includes(m.tier));
if (only) queue = queue.filter((m) => only.some((o) => m.file.includes(o)));

/* ═══════════════════════ 未分层检查 ═══════════════════════
 * 新增了测试却忘了登记 → 这里必须叫出来。否则新测试永远不会被跑。 */
const registered = new Set(MANIFEST.map((m) => m.file));
const unclassified = fs.readdirSync(TOOLS)
  .filter((f) => f.endsWith(".mjs"))
  .filter((f) => /(-test|-check|-e2e|-verify|smoke|probe)\.mjs$/.test(f))
  .filter((f) => !registered.has(f) && !NOT_TESTS.has(f))
  .sort();

/* ═══════════════════════ 前置检查 ═══════════════════════ */
const problems = [];
if (tiers.includes("mount") && !fs.existsSync(path.join(ROOT, "dist", "index.html"))) {
  problems.push("mount 层需要 dist/index.html：先跑 `node node_modules/vite/bin/vite.js build`");
}
if (tiers.includes("live")) {
  problems.push("live 层需要外部活体环境（CDP 9222 / localhost:5173 / adb），本脚本不会替你启动 —— 失败多半是这个原因");
}
if (tiers.includes("net")) {
  problems.push("net 层会向生产库写真实数据（自造 wp-* 测试账号），确认这是你要的");
}
if (problems.length) {
  for (const p of problems) console.log(`[!] ${p}`);
  if (tiers.includes("mount") && !fs.existsSync(path.join(ROOT, "dist", "index.html"))) process.exit(2);
  console.log("");
}

/* dist 是否比源码旧（踩坑 #25 / 轮 80：陈旧 dist 上线过一次） */
function distStaleness() {
  try {
    const distIdx = path.join(ROOT, "dist", "index.html");
    if (!fs.existsSync(distIdx)) return null;
    const distTime = fs.statSync(distIdx).mtimeMs;
    let newest = 0, newestFile = "";
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else {
          const m = fs.statSync(p).mtimeMs;
          if (m > newest) { newest = m; newestFile = path.relative(ROOT, p); }
        }
      }
    };
    walk(path.join(ROOT, "src"));
    const idx = path.join(ROOT, "index.html");
    if (fs.existsSync(idx)) {
      const m = fs.statSync(idx).mtimeMs;
      if (m > newest) { newest = m; newestFile = "index.html"; }
    }
    return newest > distTime ? newestFile : null;
  } catch { return null; }
}

if (has("--list")) {
  console.log(`清单 ${queue.length} 项（分层：${tiers.join(",")}）\n`);
  for (const m of queue) {
    console.log(`  ${m.tier.padEnd(5)} ${m.file.padEnd(30)} ${m.note || ""}`);
  }
  if (unclassified.length) {
    console.log(`\n[!] ${unclassified.length} 个测试文件未分层（不会被任何 tier 跑到）：`);
    for (const f of unclassified) console.log(`    ${f}`);
  }
  process.exit(0);
}

if (!queue.length) {
  console.error("没有匹配的测试。用 --list 看清单。");
  process.exit(2);
}

/* ═══════════════════════ 执行 ═══════════════════════ */
const results = [];
const startedAll = Date.now();

function runOne(entry) {
  return new Promise((resolve) => {
    const file = path.join(TOOLS, entry.file);
    if (!fs.existsSync(file)) {
      resolve({ ...entry, status: "missing", code: -1, ms: 0, out: "", counts: null });
      return;
    }
    const t0 = Date.now();
    const child = spawn(process.execPath, [file, ...(entry.args || [])], {
      cwd: ROOT,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      windowsHide: true,
    });
    let out = "";
    let killed = false;
    const cap = (buf) => {
      out += buf.toString();
      if (out.length > 400_000) out = out.slice(-300_000); // 防某些测试刷屏占满内存
    };
    child.stdout.on("data", cap);
    child.stderr.on("data", cap);
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
    }, TIER_TIMEOUT[entry.tier] || 120_000);

    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ...entry, status: "error", code: -1, ms: Date.now() - t0, out: out + `\n${e.message}`, counts: null });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const counts = parseCounts(out);
      const status = killed ? "timeout" : code === 0 ? "pass" : "fail";
      resolve({ ...entry, status, code, ms: Date.now() - t0, out, counts });
    });
  });
}

function parseCounts(out) {
  const m = out.match(/TOTAL\s+(\d+)\s+PASS\s+(\d+)\s+FAIL\s+(\d+)/i);
  if (m) return { total: +m[1], pass: +m[2], fail: +m[3] };
  const p = (out.match(/\bPASS\b/g) || []).length;
  const f = (out.match(/\bFAIL\b/g) || []).length;
  if (p || f) return { total: p + f, pass: p, fail: f };
  return null;
}

const fmtMs = (ms) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
const MARK = { pass: "[OK]  ", fail: "[FAIL]", timeout: "[TIME]", missing: "[MISS]", error: "[ERR] " };

console.log(`跑 ${queue.length} 项 · 分层 ${tiers.join(",")} · node ${process.version}\n`);

for (let i = 0; i < queue.length; i++) {
  const entry = queue[i];
  const r = await runOne(entry);
  results.push(r);
  const counts = r.counts ? `  ${r.counts.pass}/${r.counts.total}` : "";
  console.log(`${MARK[r.status]} ${String(i + 1).padStart(2)}. ${entry.file.replace(/\.mjs$/, "").padEnd(26)} ${fmtMs(r.ms).padStart(7)}${counts}`);
  if (r.status !== "pass") {
    const tail = r.out.trimEnd().split("\n").slice(-30).join("\n");
    if (tail) console.log(tail.split("\n").map((l) => `      | ${l}`).join("\n"));
    if (has("--bail")) break;
  }
}

/* ═══════════════════════ 汇总 ═══════════════════════ */
const by = (s) => results.filter((r) => r.status === s).length;
const failed = results.filter((r) => r.status !== "pass");
const totalTests = results.reduce((n, r) => n + (r.counts ? r.counts.total : 0), 0);
const passedTests = results.reduce((n, r) => n + (r.counts ? r.counts.pass : 0), 0);

console.log(`\n${"─".repeat(64)}`);
console.log(
  `脚本 ${results.length} 项：通过 ${by("pass")} · 失败 ${by("fail")} · 超时 ${by("timeout")}` +
  ` · 缺失 ${by("missing")} · 异常 ${by("error")}`
);
if (totalTests) console.log(`断言 ${totalTests} 条：通过 ${passedTests} · 失败 ${totalTests - passedTests}`);
console.log(`总耗时 ${fmtMs(Date.now() - startedAll)}`);

if (!failed.length) console.log("\nALL OK\n");
else {
  console.log("\n失败清单：");
  for (const r of failed) console.log(`  · ${r.file}（${r.status}${r.code >= 0 ? ` · exit ${r.code}` : ""}）`);
  console.log("");
}

if (unclassified.length) {
  console.log(`[!] ${unclassified.length} 个测试文件未登记分层（不会被告警以外的任何 tier 跑到）：`);
  for (const f of unclassified) console.log(`    ${f}`);
  console.log("    → 请加到 tools/all.mjs 的 MANIFEST 里\n");
}

if (has("--json")) {
  const dir = path.join(ROOT, "_scratch");
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  const out = path.join(dir, "test-report.json");
  fs.writeFileSync(out, JSON.stringify({
    at: new Date().toISOString(), node: process.version, tiers,
    results: results.map(({ out: _o, ...rest }) => rest),
    totals: { scripts: results.length, pass: by("pass"), fail: failed.length, assertions: totalTests },
    unclassified,
  }, null, 2));
  console.log(`报告已写入 ${path.relative(ROOT, out)}`);
}

process.exit(failed.length ? 1 : 0);
