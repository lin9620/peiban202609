/* 部署后必跑：线上首页引用的每个 /assets/*.js 与本地 dist 逐字节比对
 *
 * 历史问题（轮 496 修）：本工具原来只认 `assets/index-*.js`，而入口早在
 * 某轮之后就改成了 `main-*.js` —— 于是匹配集合恒为空，输出 `entryRefs: []`
 * 却仍然 exit 0，看起来「通过」，实际一个字节都没核。踩坑 #25/#26 要防的
 * 正是「线上跑的是旧产物」，这个假绿把护栏本身废掉了。
 *
 * 现在的口径：
 *   1. 匹配范围放大到首页 HTML 里所有 /assets/*.js（入口 + modulepreload 分片）；
 *   2. 一个都没匹配到 = 入口规则又变了 → NO_ENTRY 直接失败，不许空对空通过；
 *   3. 逐个算 SHA-256 与本地 dist 同名文件比对，DIFF / MISSING 一律非零退出；
 *   4. 顺带查 Supabase slug 是否在产物里（防「构建时 env 丢了」）。
 */
import { readFileSync } from "node:fs";

const base = process.argv[2] || "https://warmpaws.de5.net/";

let slug = "";
try {
  const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
  slug = (env.match(/^VITE_SUPABASE_URL=https:\/\/([a-z0-9]+)\.supabase\.co/m) || [])[1] || "";
} catch { /* .env 缺失不致命，跳过 slug 检查 */ }

const sha16 = async (bytes) => {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
};

const html = await (await fetch(base, { redirect: "follow" })).text();
const names = [...new Set([...html.matchAll(/assets\/([\w.-]+\.js)/g)].map((m) => m[1]))];

/* 入口 = <script type="module" src="..."> 指向的那个；其余是 modulepreload 分片。
 * slug 只可能在入口 chunk 里（vendor 分片是 vue/naive/lottie，本来就不含），
 * 对分片查 slug 会稳定假红 —— 轮 496 第一版就踩了这个。 */
const entryName = (() => {
  for (const tag of html.match(/<script\b[^>]*>/g) || []) {
    if (!/type\s*=\s*["']module["']/.test(tag)) continue;
    const src = (tag.match(/src\s*=\s*["']([^"']+)["']/) || [])[1];
    const m = src && src.match(/assets\/([\w.-]+\.js)/);
    if (m) return m[1];
  }
  return "";
})();

if (!names.length) {
  console.log("NO_ENTRY  首页 HTML 里没有匹配到任何 /assets/*.js —— 入口命名规则可能又变了");
  console.log(JSON.stringify({ base, entryRefs: [] }, null, 2));
  process.exit(1);
}

const rows = [];
for (const n of names) {
  const row = { file: n };
  const res = await fetch(new URL(`assets/${n}`, base));
  if (!res.ok) {
    row.status = "MISSING_LIVE";
    rows.push(row);
    continue;
  }
  const liveBuf = new Uint8Array(await res.arrayBuffer());
  row.bytes = liveBuf.length;
  row.liveSha16 = await sha16(liveBuf);
  if (slug && n === entryName) row.liveHasSlug = new TextDecoder().decode(liveBuf).includes(slug);

  try {
    const localBuf = new Uint8Array(readFileSync(new URL(`../dist/assets/${n}`, import.meta.url)));
    row.localBytes = localBuf.length;
    row.localSha16 = await sha16(localBuf);
    row.status = row.liveSha16 === row.localSha16 ? "SAME" : "DIFF";
  } catch {
    row.status = "MISSING_LOCAL";
  }
  rows.push(row);
}

const bad = rows.filter((r) => r.status !== "SAME");
for (const r of rows) {
  const detail = r.status === "SAME"
    ? `${r.bytes} bytes  sha16 ${r.liveSha16}  local=live`
    : `live=${r.liveSha16 || "-"} local=${r.localSha16 || "-"} bytes live=${r.bytes ?? "-"} local=${r.localBytes ?? "-"}`;
  console.log(`${r.status === "SAME" ? "SAME" : "BAD "}  ${r.file.padEnd(34)} ${detail}`);
}

if (slug) {
  const entryRow = rows.find((r) => r.file === entryName);
  if (!entryName) {
    console.log("WARN  认不出入口 script，跳过 Supabase slug 检查（SHA 比对仍然有效）");
  } else if (!entryRow || entryRow.liveHasSlug !== true) {
    console.log(`BAD   入口 ${entryName} 里找不到 Supabase slug —— 构建时 env 可能丢了`);
    bad.push({ status: "NO_SLUG" });
  } else {
    console.log(`OK    Supabase slug 在入口 ${entryName} 里`);
  }
}

console.log(bad.length ? `\nLIVE BUNDLE FAIL (${bad.length}/${rows.length})` : `\nLIVE BUNDLE ALL PASS (${rows.length})`);
process.exit(bad.length ? 1 : 0);
