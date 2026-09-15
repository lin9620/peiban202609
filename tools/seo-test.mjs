/* SEO 资产检查：node tools/seo-test.mjs
 * 校验 robots.txt / sitemap.xml / index.html 元信息 / PNG 图标尺寸，
 * 以及构建产物 dist 里是否也带上了这些文件。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const exists = (p) => fs.existsSync(path.join(root, p));

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => {
  if (c) { pass++; console.log("PASS ", n, extra); }
  else { fail++; console.log("FAIL ", n, extra); }
};

const SITE = "https://dale.de5.net";

/* ─── ① robots.txt ─── */
const robots = exists("public/robots.txt") ? read("public/robots.txt") : "";
ok("T1 robots.txt 存在", robots.length > 0);
ok("T2 robots 允许抓取", /User-agent:\s*\*/i.test(robots) && /Allow:\s*\//i.test(robots));
ok("T3 robots 声明站点地图", robots.includes(`Sitemap: ${SITE}/sitemap.xml`));

/* ─── ② sitemap.xml ─── */
const sm = exists("public/sitemap.xml") ? read("public/sitemap.xml") : "";
ok("T4 sitemap.xml 存在", sm.length > 0);
ok("T5 XML 声明 + urlset 命名空间", sm.startsWith("<?xml") && sm.includes("http://www.sitemaps.org/schemas/sitemap/0.9"));
ok("T6 标签闭合平衡", (sm.match(/<url>/g) || []).length === (sm.match(/<\/url>/g) || []).length);
const locs = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
const expected4 = [`${SITE}/`, `${SITE}/pet`, `${SITE}/community`, `${SITE}/profile`].sort();
ok("T7 sitemap 登记全部 4 条 history 路由", locs.length === 4 && JSON.stringify([...locs].sort()) === JSON.stringify(expected4), locs.join(","));
ok("T8 lastmod 为 ISO 日期", /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/.test(sm));

/* ─── ③ index.html 元信息 ─── */
const html = read("index.html");
ok("T9 canonical 指向正式域名", html.includes(`<link rel="canonical" href="${SITE}/"`));
ok("T10 含 description", /<meta\s+name="description"/.test(html) && html.includes("一个温暖的角落"));
ok("T11 含 robots index,follow", html.includes('name="robots" content="index, follow"'));
ok("T12 图标使用真实 PNG（非内联 SVG）", html.includes('href="/favicon.png"') && html.includes('href="/apple-touch-icon.png"'));
ok("T13 OG 分享卡标签齐全", ["og:type", "og:title", "og:description", "og:url", "og:image", "og:image:width"].every((k) => html.includes(`property="${k}"`)));
ok("T14 OG 图片为绝对地址", html.includes(`property="og:image" content="${SITE}/og-image.png"`));
ok("T15 Twitter 大卡", html.includes('name="twitter:card" content="summary_large_image"'));
ok("T16 theme-color 已设置", /name="theme-color" content="#[0-9a-f]{6}"/i.test(html));
ok("T17 noscript 提供可读内容", html.includes("<noscript>") && /Warm Paws/.test(html.slice(html.indexOf("<noscript>"))));

/* ─── ④ JSON-LD 结构化数据 ─── */
const ldMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
let ld = null;
try { ld = ldMatch ? JSON.parse(ldMatch[1]) : null; } catch { ld = null; }
ok("T18 JSON-LD 可解析", !!ld);
ok("T19 JSON-LD 类型与地址正确", ld && ld["@type"] === "WebSite" && ld.url === `${SITE}/`);

/* ─── ⑤ PNG 图标：签名 + IHDR 尺寸 ─── */
function pngSize(p) {
  const b = fs.readFileSync(path.join(root, p));
  const sigOK = b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const ihdrOK = b.slice(12, 16).toString("ascii") === "IHDR";
  return { sigOK, ihdrOK, w: b.readUInt32BE(16), h: b.readUInt32BE(20), bytes: b.length };
}
const og = exists("public/og-image.png") ? pngSize("public/og-image.png") : null;
ok("T20 og-image.png 是合法 PNG", og && og.sigOK && og.ihdrOK);
ok("T21 og-image 尺寸 1200x630", og && og.w === 1200 && og.h === 630, og ? `${og.w}x${og.h}` : "");
const fav = exists("public/favicon.png") ? pngSize("public/favicon.png") : null;
ok("T22 favicon 为 192x192 PNG", fav && fav.w === 192 && fav.h === 192, fav ? `${fav.w}x${fav.h}` : "");
const ati = exists("public/apple-touch-icon.png") ? pngSize("public/apple-touch-icon.png") : null;
ok("T23 apple-touch-icon 为 180x180 PNG", ati && ati.w === 180 && ati.h === 180, ati ? `${ati.w}x${ati.h}` : "");

/* ─── ⑥ 构建产物（若已构建） ─── */
if (exists("dist/index.html")) {
  const files = ["dist/robots.txt", "dist/sitemap.xml", "dist/og-image.png", "dist/favicon.png", "dist/apple-touch-icon.png"];
  const missing = files.filter((f) => !exists(f));
  ok("T24 dist 内 SEO 文件齐全", missing.length === 0, missing.join(","));
  if (exists("dist/sitemap.xml")) {
    const today = new Date().toISOString().slice(0, 10);
    ok("T25 构建产物 lastmod 已刷新为今天", read("dist/sitemap.xml").includes(`<lastmod>${today}</lastmod>`), today);
  } else {
    ok("T25 构建产物 lastmod 已刷新为今天", false, "dist/sitemap.xml 缺失");
  }
  const dhtml = read("dist/index.html");
  ok("T26 产物 HTML 保留 canonical/OG", dhtml.includes(`rel="canonical"`) && dhtml.includes("og-image.png"));
} else {
  console.log("SKIP  T24~T26 尚未构建 dist（先跑 npm run build）");
}

/* ─── ⑦ history 路由产物（若已构建） ─── */
if (exists("dist/pet/index.html")) {
  const routeDirs = ["pet", "community", "profile"];
  const missingH = routeDirs.filter((d) => !exists(`dist/${d}/index.html`));
  ok("T27 每路由静态 HTML 已生成", missingH.length === 0, missingH.join(","));
  const petHtml = read("dist/pet/index.html");
  ok("T28 /pet canonical 独立", petHtml.includes(`<link rel="canonical" href="${SITE}/pet"`));
  ok("T29 /pet 标题独立", petHtml.includes("<title>Warm Paws · Meet Your Little Pet</title>"));
  const cHtml = exists("dist/community/index.html") ? read("dist/community/index.html") : "";
  ok("T30 /community 标题+canonical 独立", cHtml.includes("<title>Warm Paws · The Kindness Wall</title>") && cHtml.includes(`href="${SITE}/community"`));
  ok("T31 /profile 生成且描述独立", exists("dist/profile/index.html") && read("dist/profile/index.html").includes("Your pets, coins, badges"));
} else {
  console.log("SKIP  T27~T31 尚未构建 dist（先跑 npm run build）");
}
ok("T32 SPA 回退配置（wrangler not_found_handling）", exists("wrangler.jsonc") && read("wrangler.jsonc").includes("single-page-application"));
ok("T33 Cloudflare _headers 含安全头+资产缓存", exists("public/_headers") && read("public/_headers").includes("X-Content-Type-Options") && read("public/_headers").includes("/assets/*"));

console.log(`\nTOTAL ${pass + fail}  PASS ${pass}  FAIL ${fail}`);
if (fail > 0) process.exitCode = 1;