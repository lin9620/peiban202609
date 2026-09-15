/* 线上站点验证（部署后跑）：node tools/online-check.mjs
 * 覆盖：HTTPS 可达 → 页面关键词 → 静态资源 → 云端配置 → SEO 资产 → Googlebot 索引体检
 * 设计：每个请求带 15s 超时 + 250ms 间隔，避免被 Cloudflare 限速时脚本无限挂住
 */
const BASE = "https://dale.de5.net";
const SUPA_REF = "rwulplykvipkshkxyxfe";
const BOT_UA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => {
  if (c) { pass++; console.log("PASS  " + n + (extra ? "  " + extra : "")); }
  else { fail++; console.log("FAIL  " + n + (extra ? "  " + extra : "")); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 单次请求：带间隔与超时，失败抛错由调用方兜成 FAIL */
async function get(path, headers) {
  await sleep(250);
  return fetch(BASE + path, { redirect: "follow", headers, signal: AbortSignal.timeout(15000) });
}

/* ─── ① 首页与静态资源 ─── */
let html = "";
try {
  const r = await get("/");
  ok("首页 HTTPS 可访问", r.status === 200, "HTTP " + r.status);
  html = await r.text();
} catch (e) {
  ok("首页 HTTPS 可访问", false, e.message + "（DNS/证书可能还在生效，等几分钟重跑）");
  process.exit(1);
}
ok("页面确为 Warm Paws", /warm|paws|暖爪|暖/i.test(html));
const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
ok("HTML 引用静态资源", assets.length > 0, "(共 " + assets.length + " 个)");
for (const a of assets.slice(0, 8)) {
  try {
    const r = await get(a);
    ok("资源 " + a.split("/").pop().slice(0, 30), r.status === 200, "HTTP " + r.status);
  } catch (e) { ok("资源 " + a, false, e.message); }
}

/* ─── ② 云端配置是否打进产物 ─── */
const mainJs = assets.find((a) => /index-.*\.js$/.test(a));
if (mainJs) {
  try {
    const t = await (await get(mainJs)).text();
    ok("线上产物包含云端 Supabase 配置", t.includes(SUPA_REF));
  } catch (e) { ok("检查主 JS 产物", false, e.message); }
}

/* ─── ③ HTML 元信息 ─── */
ok("HTML 含 canonical", html.includes(`<link rel="canonical" href="${BASE}/"`));
ok("HTML 含 OG 分享卡", html.includes(`property="og:image" content="${BASE}/og-image.png"`));

/* ─── ④ SEO 静态资产 ─── */
const seoFiles = [
  ["robots.txt", (t) => t.includes(`${BASE}/sitemap.xml`)],
  ["sitemap.xml", (t) => t.includes(`<loc>${BASE}/</loc>`)],
  ["og-image.png", null],
  ["favicon.png", null],
  ["apple-touch-icon.png", null],
];
for (const [file, check] of seoFiles) {
  try {
    const r = await get("/" + file);
    let bodyOK = true;
    if (check) bodyOK = check(await r.text());
    ok("线上 " + file, r.status === 200 && bodyOK, "HTTP " + r.status + (bodyOK ? "" : " 内容不符"));
  } catch (e) { ok("线上 " + file, false, e.message); }
}

/* ─── ⑤ 索引体检：模拟 Googlebot，排查「提交了站点地图却收录不了」 ─── */
try {
  const r = await get("/", { "User-Agent": BOT_UA });
  const t = await r.text();
  ok("Googlebot 抓取未被拦截", r.status === 200 && !r.headers.get("cf-mitigated"), "HTTP " + r.status);
  ok("无 x-robots-tag 禁索引头", !r.headers.get("x-robots-tag"));
  ok("页面正文不含 noindex", !/noindex/i.test(t));
  const rm = t.match(/<meta[^>]+name=["']robots["'][^>]*>/i);
  ok("meta robots 允许索引", !!rm && /index/i.test(rm[0]), rm ? rm[0] : "缺失");
} catch (e) { ok("Googlebot 索引体检", false, e.message); }
try {
  const r = await get("/no-such-page-xyz");
  ok("不存在路径返回 404（非软 404）", r.status === 404, "HTTP " + r.status);
} catch (e) { ok("软 404 检查", false, e.message); }

console.log("\nTOTAL " + (pass + fail) + "  PASS " + pass + "  FAIL " + fail);
process.exit(fail ? 1 : 0);
