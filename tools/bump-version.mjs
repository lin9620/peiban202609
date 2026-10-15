/* 发版前 bump 版本号（轮 297）
 * ---------------------------------------------------------------
 * 用法：
 *   npm run release -- 1.2        把 versionCode +1、versionName 写成 "1.2"
 *   npm run release -- 1.2 --dry-run   只打印将要改成什么，不落盘
 *
 * 为什么要有这个脚本：
 *   versionCode 是客户端判断「有没有新版」的**唯一依据**（vite 的 appVersion 插件在
 *   构建期把它从 build.gradle 烤进网页端，APK 里也带着同一个值）。忘了 bump 的后果
 *   不是「没提示更新」这么轻 —— 要么功能永远不触发，要么 version.json 比包里的值大，
 *   用户装完仍算「有新版」→ **无限循环**；叠上「必须更新」就是永远关不掉的窗。
 *   手改两行容易漏、容易写错格式，所以固化成一条命令。
 *
 * 为什么不让 `npm run build` 自动 bump：
 *   开发期天天跑 build，自动 bump 会让 versionCode 变成「今天构建了几次」，与发了几个
 *   版本毫无关系，还会和用户手机上已装的 APK 对不上 —— 那正是死循环的源头。
 *   版本号必须是人决定的发版动作。
 *
 * 运行：node tools/bump-version.mjs <versionName> [--dry-run] [--file=<path>]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/* 版本名给「人看」，格式放宽：1 / 1.2 / 1.2.3 / 1.2.3-beta 都收，
 * 但不许空、不许带空格与路径分隔符（它会被写进 JSON 与弹窗文案）。 */
const NAME_RE = /^\d+(?:\.\d+){0,3}(?:[-+][0-9A-Za-z.-]+)?$/;

function parseGradle(src) {
  const c = src.match(/^(\s*)versionCode\s+(\d+)\s*$/m);
  const n = src.match(/^(\s*)versionName\s+"([^"]*)"\s*$/m);
  if (!c || !n) return null;
  return { code: parseInt(c[2], 10), name: n[2], indentC: c[1], indentN: n[1] };
}

/** 纯函数：给定当前值与目标版本名，算出新的文件内容。返回 null = 参数不合法。 */
export function applyBump(src, versionName) {
  const cur = parseGradle(src);
  if (!cur) return null;
  const name = String(versionName || "").trim();
  if (!NAME_RE.test(name)) return null;
  const next = cur.code + 1;
  if (!Number.isSafeInteger(next) || next <= 0) return null;
  /* 只替换第一处命中的那一行，缩进原样保留，别顺手动到别的配置 */
  const out = src
    .replace(/^(\s*)versionCode\s+\d+\s*$/m, `${cur.indentC}versionCode ${next}`)
    .replace(/^(\s*)versionName\s+"[^"]*"\s*$/m, `${cur.indentN}versionName "${name}"`);
  return { out, cur, next, name };
}

function main(argv) {
  const dry = argv.includes("--dry-run");
  const fileArg = argv.find((a) => a.startsWith("--file="));
  const target = fileArg
    ? fileArg.slice("--file=".length)
    : join(ROOT, "android", "app", "build.gradle");
  const versionName = argv.find((a) => !a.startsWith("--"));

  let src;
  try { src = readFileSync(target, "utf8"); }
  catch (e) { console.error(`[bump-version] CANNOT_READ ${target} :: ${e.message}`); process.exit(1); }

  if (!versionName) {
    const cur = parseGradle(src);
    console.error("[bump-version] USAGE  npm run release -- <versionName> [--dry-run]");
    if (cur) console.error(`[bump-version] CURRENT  versionCode ${cur.code}  versionName "${cur.name}"`);
    console.error("[bump-version] EXAMPLE  npm run release -- 1.2");
    process.exit(1);
  }

  const r = applyBump(src, versionName);
  if (!r) {
    console.error(`[bump-version] BAD_VERSION_NAME "${versionName}"`);
    console.error("[bump-version] EXPECT  digits with up to 3 dot groups, optional suffix: 1 / 1.2 / 1.2.3 / 1.2.3-beta");
    process.exit(1);
  }

  if (dry) {
    console.log(`[bump-version] DRY_RUN  versionCode ${r.cur.code} -> ${r.next}   versionName "${r.cur.name}" -> "${r.name}"`);
    console.log("[bump-version] NOTHING WRITTEN");
    return;
  }

  try { writeFileSync(target, r.out, "utf8"); }
  catch (e) { console.error(`[bump-version] CANNOT_WRITE ${target} :: ${e.message}`); process.exit(1); }

  /* 回读确认 —— 写盘这种事不能只信 writeFileSync 没抛异常 */
  const back = parseGradle(readFileSync(target, "utf8"));
  if (!back || back.code !== r.next || back.name !== r.name) {
    console.error("[bump-version] VERIFY_FAILED  file did not contain the new values after write");
    process.exit(1);
  }

  console.log(`[bump-version] OK  versionCode ${r.cur.code} -> ${r.next}   versionName "${r.cur.name}" -> "${r.name}"`);
  console.log("[bump-version] NEXT (order matters):");
  console.log(`[bump-version]   1. npm run build          # vite bakes versionCode ${r.next} into the web bundle`);
  console.log("[bump-version]   2. npm run cap:sync");
  console.log(`[bump-version]   3. build the APK (assembleDebug)  -> carries versionCode ${r.next}`);
  console.log("[bump-version]   4. npm run apk:web");
  console.log(`[bump-version]   5. Admin panel -> App release -> upload; versionCode is pre-filled with ${r.next} - do not edit it`);
  console.log("[bump-version] DONE");
}

const invokedDirectly = process.argv[1] && /bump-version\.mjs$/.test(process.argv[1].replace(/\\/g, "/"));
if (invokedDirectly) main(process.argv.slice(2));
