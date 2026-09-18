import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
/* 构建期直接读 i18n 词典（Node 下可安全加载：storage.js 有 typeof window 守卫），
 * 让预渲染的静态正文与页面文案共用同一份词条，不存在第二份文案 */
import { messages } from "./src/i18n.js";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

/* 构建产物里刷新站点地图的 lastmod（public/sitemap.xml 是开发期副本，日期会陈旧） */
function seoSitemap() {
  return {
    name: "seo-sitemap",
    apply: "build",
    closeBundle() {
      const file = path.join(rootDir, "dist", "sitemap.xml");
      if (!fs.existsSync(file)) return;
      const today = new Date().toISOString().slice(0, 10);
      const xml = fs.readFileSync(file, "utf8").replace(/<lastmod>[^<]*<\/lastmod>/g, `<lastmod>${today}</lastmod>`);
      fs.writeFileSync(file, xml);
      console.log(`\n  seo-sitemap  sitemap.xml lastmod → ${today}\n`);
    },
  };
}

/* 隐私政策页的联系邮箱：与 src/views/PrivacyView.vue 里的 CONTACT_MAIL、
 * MIGRATION_add_admin.sql 里登记的管理员邮箱保持同一个（privacy-test P34 会校验一致） */
const PRIVACY_MAIL = "linyi0123456@outlook.com";

const escapeHtml = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/* 把隐私政策正文真正写进静态 HTML（只用于 /privacy）。
 *
 * 为什么必须这么做：这页是给「站点外的人」看的 —— Google 存品牌页时会抓取
 * 你填的 Privacy policy URL，OAuth 审核方也可能直接取 HTML。纯 SPA 壳子
 * （<div id="app"></div>）在不执行 JS 的抓取方面前等于空白页，政策写得再全
 * 也读不到。所以这里在构建期把 i18n 词条（唯一文案来源）展开成静态标记。
 *
 * 章节由键名约定派生（s1t..s13t，配 sNp1 / sNl / sNnote），与
 * src/views/PrivacyView.vue 的 SECTIONS 表同构；改文案只动 i18n.js，
 * 漏改由 privacy-test P31/P32 兜住。挂载后 Vue 会接管这个容器，视觉无差别。 */
function privacyStaticHtml(locale) {
  const P = messages[locale].privacy;
  const parts = [
    '<section class="card legal-head">',
    `<h1 class="legal-title">🔒 ${escapeHtml(P.title)}</h1>`,
    `<p class="sub">${escapeHtml(P.intro)}</p>`,
    `<p class="notice legal-updated">${escapeHtml(P.updated)}</p>`,
    "</section>",
  ];
  for (let i = 1; i <= 13; i++) {
    const head = P[`s${i}t`];
    if (!head) continue;
    const para = P[`s${i}p1`];
    const list = P[`s${i}l`];
    const note = P[`s${i}note`];
    parts.push('<section class="card legal-sec">');
    parts.push(`<h2>${escapeHtml(head)}</h2>`);
    if (para) {
      /* 正文里的 {mail} 占位符跟组件里 t(key, {mail}) 是同一套约定 */
      parts.push(`<p class="legal-p">${escapeHtml(String(para).replace("{mail}", PRIVACY_MAIL))}</p>`);
      if (String(para).includes("{mail}")) {
        parts.push(`<p class="legal-mail">${escapeHtml(PRIVACY_MAIL)}</p>`);
      }
    }
    if (Array.isArray(list) && list.length) {
      parts.push('<ul class="legal-list">');
      for (const it of list) parts.push(`<li>${escapeHtml(it)}</li>`);
      parts.push("</ul>");
    }
    if (note) parts.push(`<p class="notice">${escapeHtml(note)}</p>`);
    parts.push("</section>");
  }
  /* 无 JS 时也要能回到首页，等价于组件里 back() 的 router.push({name:"home"}) */
  parts.push(`<div class="legal-foot"><a href="/">${escapeHtml(P.back)}</a></div>`);
  return parts.join("\n      ");
}

/* —— SEO 预渲染正文（文案唯一来源是 i18n，不新造句子）——
 * 为什么必须做：Googlebot 对「不执行 JS 只有一行 slogan 的页面」极其保守，
 * 表现就是 GSC 里「已抓取 - 尚未编入索引」。把每个页面最核心的 2-3 句真实文案
 * 在构建期写进静态 HTML（Vue 挂载时会被替换，视觉无差别），无 JS 的抓取方
 * 才能读到「这一页到底是干什么的」。h2 而非 h1：noscript 里已有唯一 h1。 */
function seoHero(en) {
  const H = escapeHtml;
  return (title, paras) =>
    `<section class="card seo-hero"><h2 class="seo-title">${H(title)}</h2>` +
    paras.map((p) => `<p>${H(p)}</p>`).join("") +
    `<ul class="seo-links">
      <li><a href="/pet">Meet your little pet</a></li>
      <li><a href="/community">The Warm Wall</a></li>
      <li><a href="/privacy">Privacy Policy</a></li>
    </ul></section>`;
}

/* seoRoutes：子页独立 HTML（title/canonical/OG/正文）+ 首页正文 + 404 页。
 * 404 页是给「不存在的路径」用的：此前 not_found_handling=SPA 会把任意
 * 乱路径都当首页 200 返回（软 404 原料，拖累整站收录）；改成 404-page 后
 * 未知路径返回真 404。真实路由全部有静态文件，不依赖回退。 */
function seoRoutes() {
  return {
    name: "seo-routes",
    apply: "build",
    closeBundle() {
      const distDir = path.join(rootDir, "dist");
      const tpl = path.join(distDir, "index.html");
      if (!fs.existsSync(tpl)) return;
      const SITE = "https://dale.de5.net";
      /* og:description / twitter:description 共用的占位串（来自 index.html），子页替换用 */
      const ROOT_DESC =
        'content="Care for a little pet, draw its food, share kindness with gentle people."';
      const hero = seoHero(messages.en);
      const E = messages.en;
      const routes = [
        {
          dir: "pet",
          title: "Warm Paws · Meet Your Little Pet",
          desc: "Care for an adorable hand-drawn pet: draw its food, play gentle games, and watch it grow.",
          html: hero(E.pet.subtitle, [E.pet.tip, E.home.companions.hall]),
        },
        {
          dir: "community",
          title: "Warm Paws · The Kindness Wall",
          desc: "Share gentle thoughts and kind replies on the cloud kindness wall — everyone can read, members can post.",
          html: hero(E.community.title, [E.community.subtitle, E.community.cloudOn, E.community.empty]),
        },
        {
          dir: "profile",
          title: "Warm Paws · Your Gentle Corner",
          desc: "Your pets, coins, badges and gentle daily records — all in one cozy place.",
          html: hero(E.home.heroTitle, [E.profile.cloudReady, "Your pets, coins, badges and gentle daily records — all in one cozy place."]),
        },
        {
          /* 隐私政策：Google OAuth 发布要求一个可公开访问的政策页。
             除独立 title/canonical 外，还把正文预渲染进静态 HTML —— 不执行 JS
             的抓取方（Google 存品牌页时的校验、OAuth 审核）也能读到完整政策 */
          dir: "privacy",
          title: "Warm Paws · Privacy Policy",
          desc: "What Warm Paws stores, why it stores it, and how Google sign-in data is used — plain words, no tracking, no ads.",
          html: privacyStaticHtml("en"),
        },
      ];
      let made = 0;
      for (const r of routes) {
        let h = fs.readFileSync(tpl, "utf8");
        h = h
          .replace(/<title>[\s\S]*?<\/title>/, `<title>${r.title}</title>`)
          .replace(/<link rel="canonical" href="[^"]*"/, `<link rel="canonical" href="${SITE}/${r.dir}"`)
          .replace(/<meta property="og:url" content="[^"]*"/, `<meta property="og:url" content="${SITE}/${r.dir}"`)
          .replace(/<meta property="og:title" content="[^"]*"/, `<meta property="og:title" content="${r.title}"`)
          .replace(/<meta name="twitter:title" content="[^"]*"/, `<meta name="twitter:title" content="${r.title}"`);
        /* og:description 与 twitter:description 的 content 值相同，一次全部替换 */
        h = h.split(ROOT_DESC).join(`content="${r.desc}"`);
        /* <meta name="description"> 与 OG 那句不是同一个字符串，得单独换，
           否则子页面在搜索结果里仍显示全站通用描述 */
        h = h.replace(/<meta\s+name="description"[\s\S]*?\/>/, `<meta name="description" content="${r.desc}" />`);
        /* 需要正文的子页面：把内容塞进挂载点。Vue 挂载时会清空该容器，视觉无差别；
           不执行 JS 的抓取方则能读到真实内容而不是空壳 */
        if (r.html) {
          h = h.replace('<div id="app"></div>', `<div id="app">\n      ${r.html}\n    </div>`);
        }
        fs.mkdirSync(path.join(distDir, r.dir), { recursive: true });
        fs.writeFileSync(path.join(distDir, r.dir, "index.html"), h);
        made++;
      }
      /* 首页本体也注入正文（先做子页再做首页，子页拿到的模板仍是干净壳） */
      {
        let h = fs.readFileSync(tpl, "utf8");
        const heroHome = hero(E.home.heroTitle, [
          E.home.heroSub.split("{n}").join("Warm Paws"),
          E.home.companions.title + ". " + E.home.companions.hall,
          E.home.mood.title + " " + E.home.mood.subtitle,
        ]);
        h = h.replace('<div id="app"></div>', `<div id="app">\n      ${heroHome}\n    </div>`);
        fs.writeFileSync(tpl, h);
        made++;
      }
      /* 404 页：未知路径返回真 404（配合 wrangler not_found_handling=404-page）。
         noindex + 回首页链接；独立小 HTML，不依赖站点 JS。 */
      {
        const notFound = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Page not found · Warm Paws</title>
  <meta name="robots" content="noindex, follow" />
  <link rel="icon" type="image/png" sizes="192x192" href="/favicon.png" />
  <style>
    body { font-family: system-ui, sans-serif; background: #fff7ee; color: #5b4a3f;
           display: grid; place-items: center; min-height: 100vh; margin: 0; text-align: center; }
    a { color: #e07a3f; font-weight: 600; }
  </style>
</head>
<body>
  <main>
    <p style="font-size: 44px; margin: 0;">🐾</p>
    <h1>This page wandered off.</h1>
    <p>The address doesn't exist — the gentle rooms are still where they always were.</p>
    <p><a href="/">Back to Warm Paws</a></p>
  </main>
</body>
</html>
`;
        fs.writeFileSync(path.join(distDir, "404.html"), notFound);
        made++;
      }
      console.log(`\n  seo-routes  ${made} pages → /pet /community /profile /privacy / + 404.html\n`);
    },
  };
}

export default defineConfig({
  plugins: [vue(), seoSitemap(), seoRoutes()],
  server: {
    port: 5173,
    open: true,
    /* 本地联调 API 网关：配合 `npm run dev:api`（wrangler dev，端口 8787）。
     * 只有 VITE_API_GATEWAY=1 时前端才会发 /api 请求；默认直连模式不受影响 */
    proxy: {
      "/api": "http://127.0.0.1:8787",
    },
  },
  build: {
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        /* 第三方库分包：利于浏览器缓存，避免单文件过大 */
        manualChunks: {
          vue: ["vue", "vue-router"],
          naive: ["naive-ui"],
          lottie: ["lottie-web"],
        },
      },
    },
  },
});
