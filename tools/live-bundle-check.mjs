/* 临时探针：线上首页 → 取 index-*.js 名字 → 下载 bundle → 查 Supabase slug 是否在内
 * （交接文档 K 节：部署后要比对线上产物与本地 dist，并搜不会被混淆的真实字符串）。
 * 用完即删（tools/_* 规则）。 */
import { readFileSync } from "node:fs";

const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
const slug = (env.match(/^VITE_SUPABASE_URL=https:\/\/([a-z0-9]+)\.supabase\.co/m) || [])[1];
if (!slug) { console.log("NO_SLUG_IN_ENV"); process.exit(1); }

const base = process.argv[2] || "https://dale.de5.net/";
const html = await (await fetch(base, { redirect: "follow" })).text();
const names = [...html.matchAll(/assets\/(index-[\w-]+\.js)/g)].map((m) => m[1]);
const uniq = [...new Set(names)];
const out = { base, entryRefs: uniq };

for (const n of uniq) {
  const js = await (await fetch(new URL(`assets/${n}`, base))).text();
  out[n] = {
    bytes: js.length,
    hasSlug: js.includes(slug),
    sha256: (await crypto.subtle.digest("SHA-256", new TextEncoder().encode(js)))
      ? [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(js)))]
          .map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16)
      : "",
  };
}

/* 本地 dist 里同名文件的 sha16，便于直接比对 */
try {
  for (const n of uniq) {
    const local = readFileSync(new URL(`../dist/assets/${n}`, import.meta.url));
    const digest = await crypto.subtle.digest("SHA-256", local);
    out[n].localSha16 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
    const localText = readFileSync(new URL(`../dist/assets/${n}`, import.meta.url), "utf8");
    out[n].localHasSlug = localText.includes(slug);
  }
} catch (e) { out.localDistError = String(e).slice(0, 120); }

console.log(JSON.stringify(out, null, 2));
