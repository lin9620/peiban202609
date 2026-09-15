/* 线上部署验证：node tools/live-check.mjs（部署后跑一次，应输出 LIVE ALL PASS） */
const BASE = "https://dale.de5.net";
const out = [];
let bad = 0;
async function check(name, path, fn) {
  try {
    const r = await fetch(BASE + path, { redirect: "manual" });
    const ok = await fn(r);
    if (!ok) bad++;
    out.push((ok ? "PASS " : "FAIL ") + name + "  [" + r.status + "]");
  } catch (e) {
    bad++;
    out.push("FAIL " + name + "  ERR " + e.message);
  }
}

await check("资产缓存 immutable", "/", async (r) => {
  const m = (await r.text()).match(/\/assets\/[^"']+\.js/);
  if (!m) return false;
  const a = await fetch(BASE + m[0] + "?cb=" + Date.now());
  return (a.headers.get("cache-control") || "").includes("immutable");
});
await check("根路径 200", "/", (r) => r.status === 200);
await check("/pet 200 + canonical 独立", "/pet?cb=" + Date.now(), async (r) =>
  r.status === 200 && (await r.text()).includes('rel="canonical" href="https://dale.de5.net/pet"'));
await check("/community 200 + canonical 独立", "/community?cb=" + Date.now(), async (r) =>
  r.status === 200 && (await r.text()).includes('href="https://dale.de5.net/community"'));
await check("/profile 200", "/profile", (r) => r.status === 200);
await check("robots.txt 200 且含 Sitemap", "/robots.txt?cb=" + Date.now(), async (r) =>
  r.status === 200 && (await r.text()).includes("Sitemap:"));
await check("sitemap.xml 恰好 4 条 <loc>", "/sitemap.xml?cb=" + Date.now(), async (r) =>
  ((await r.text()).match(/<loc>/g) || []).length === 4);
await check("og-image.png 200（PNG 可部署）", "/og-image.png", (r) =>
  r.status === 200 && (r.headers.get("content-type") || "").includes("image/png"));
await check("favicon.png 200", "/favicon.png", (r) => r.status === 200);
await check("未知路径 SPA 回退 200", "/this-path-does-not-exist?cb=" + Date.now(), (r) => r.status === 200);
await check("安全头 nosniff", "/", (r) => r.headers.get("x-content-type-options") === "nosniff");
await check("安全头 X-Frame-Options", "/", (r) => r.headers.get("x-frame-options") === "SAMEORIGIN");
await check("安全头 CSP（含 object-src none）", "/", (r) => {
  const csp = r.headers.get("content-security-policy") || "";
  return csp.includes("object-src 'none'") && csp.includes("frame-ancestors 'self'");
});
await check("安全头 HSTS", "/", (r) => /max-age=\d{6,}/.test(r.headers.get("strict-transport-security") || ""));

out.push("");
out.push(bad === 0 ? "LIVE ALL PASS (" + (out.length - 2) + ")" : "LIVE FAILED=" + bad);
console.log(out.join("\n"));
process.exit(bad ? 1 : 0);
