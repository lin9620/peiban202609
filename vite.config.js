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
      /* 轮 261：失败构建也会触发 closeBundle（rollup 出错时 bundle.close() 照跑）——
         此时 tpl 还是上一次构建的成品（首页正文已烤进挂载点，不再是干净壳），
         拿它当模板给子页 replace('<div id="app"></div>') 会全部失配，
         所有预渲染子页被首页 hero 覆盖（隐私正文整段丢失，privacy-test P34 实测踩过）。
         干净壳的唯一形态就是纯净挂载点；不匹配 = 壳不是本次新吐的，整段跳过，
         子页保留上次成功构建的正确产物。 */
      if (!fs.readFileSync(tpl, "utf8").includes('<div id="app"></div>')) {
        console.log("\n  seo-routes  跳过（index.html 已烤过正文，非本次干净壳——失败构建触发的 closeBundle）\n");
        return;
      }
      const SITE = "https://warmpaws.de5.net";
      /* og:description / twitter:description 共用的占位串（来自 index.html），子页替换用 */
      const ROOT_DESC_TEXT =
        'Care for a little pet, draw its food, share kindness with gentle people.';
      const ROOT_DESC = `content="${ROOT_DESC_TEXT}"`;
      const hero = seoHero(messages.en);
      const E = messages.en;
      /* 轮 86：/zh/* 中文预渲染 —— 中文长尾查询竞争小；文案唯一来源仍是 i18n 词条 */
      const ZH = messages.zh;
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
        /* ── 其余前端路由也要有静态文件：wrangler 是 not_found_handling=404-page，
              没有预渲染文件的路径（/messages、/settings、/login…）深链/刷新会真 404
              （线上实测过：/messages=404）。这些是应用页，抓取方只需 title/desc，
              正文留给 Vue（html 留空 = 不注入 hero，挂载即整页渲染）。 ── */
        {
          dir: "login",
          title: "Warm Paws · Sign in",
          desc: "Sign in to Warm Paws — your posts, comments and pet stay in step on every device.",
        },
        {
          dir: "settings",
          title: "Warm Paws · Settings",
          desc: "Skin, language and notifications — all in one gentle place.",
        },
        {
          dir: "messages",
          title: "Warm Paws · Messages",
          desc: "Gentle direct messages, kind notes and drift-bottle replies.",
        },
        {
          dir: "bottle",
          title: "Warm Paws · Drift Bottles",
          desc: "Write your heart down, seal it in a bottle and drop it into the warm sea.",
        },
        {
          dir: "my-posts",
          title: "Warm Paws · My Posts",
          desc: "All of your kindness-wall posts in one gentle list.",
        },
        {
          dir: "compose",
          title: "Warm Paws · Share a Post",
          desc: "Share a warm thought (and a picture) on the kindness wall.",
        },
        {
          /* 轮 148：/story 已改成纯阅读的发现页（不再是页签壳） */
          dir: "story",
          title: "Warm Paws · Story Hall",
          desc: "Read gentle stories from others — a daily pick and the newest ones, all in one place.",
        },
        {
          dir: "story/write",
          title: "Warm Paws · Write a Story",
          desc: "A quiet full-screen desk for your story — drafts save themselves as you go.",
        },
        {
          /* 轮 148 新增：我的（草稿箱/书架/数据面板） */
          dir: "story/mine",
          title: "Warm Paws · My Stories",
          desc: "Your drafts, published stories, saved shelf and writing numbers in one quiet place.",
        },
        {
          /* 轮 148 新增：排行榜（推荐/最新/月赞/标签） */
          dir: "story/rank",
          title: "Warm Paws · Story Rankings",
          desc: "Recommended, newest, most liked this month, and popular tags — see what readers loved.",
        },
        {
          dir: "notifications",
          title: "Warm Paws · Notifications",
          desc: "Replies, reactions and gentle news from the wall.",
        },
        {
          dir: "admin",
          title: "Warm Paws · Admin",
          desc: "Members-only care console for the kindness wall.",
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
      /* 轮 86：/zh/* 中文页 —— title 为页面名（非营销文案），desc/正文全部取自 zh 词条不新造句子 */
      const zhRoutes = [
        { dir: "pet", title: "暖爪 · 你的小宠物", desc: `${ZH.pet.subtitle}${ZH.pet.tip}`, html: hero(ZH.pet.subtitle, [ZH.pet.tip, ZH.home.companions.hall]) },
        { dir: "community", title: "暖爪 · 暖心墙", desc: `${ZH.community.subtitle}${ZH.community.cloudOn}`, html: hero(ZH.community.title, [ZH.community.subtitle, ZH.community.cloudOn, ZH.community.empty]) },
        { dir: "bottle", title: "暖爪 · 漂流瓶", desc: ZH.bottle.sub, html: hero(ZH.bottle.title, [ZH.bottle.sub]) },
        /* 轮 145：故事栏是内容页（中文长尾价值），跟 pet/community/bottle/profile/privacy 同批进 zh；
         轮 148：/story 变纯阅读发现页，另加 mine / rank 两个独立页 */
        { dir: "story", title: "暖爪 · " + ZH.story.title, desc: ZH.story.sub, html: hero(ZH.story.title, [ZH.story.sub]) },
        { dir: "story/mine", title: "暖爪 · 我的故事", desc: ZH.story.tabMine + " · " + ZH.story.mineSub, html: hero(ZH.story.tabMine, [ZH.story.mineSub]) },
        { dir: "story/rank", title: "暖爪 · 故事排行榜", desc: ZH.story.tabRank + " · " + ZH.story.rankSub, html: hero(ZH.story.tabRank, [ZH.story.rankSub]) },
        { dir: "profile", title: "暖爪 · 我的温柔角落", desc: ZH.profile.cloudReady, html: hero(ZH.home.heroTitle, [ZH.profile.cloudReady, ZH.home.companions.hall]) },
        { dir: "privacy", title: "暖爪 · 隐私政策", desc: ZH.privacy.intro, html: privacyStaticHtml("zh") },
      ];
      let made = 0;
      /* 轮 86：en/zh 共用装配器 —— title/canonical/og/description/正文注入/hreflang 一处维护。
       * zh=true 时：<html lang> 换 zh-CN，URL 前缀 /zh，其余口径一致。
       * hreflang 互指（en ↔ zh，x-default 落 en）每页带全组，插在 </head> 前。 */
      const bakePage = (h, { title, desc, dir, html, zh }) => {
        /* home（dir=""）保留尾斜杠 —— T9 钉住 canonical=https://warmpaws.de5.net/ 的既有口径。
         * 轮 236：「/zh」首页不能带尾斜杠 —— Cloudflare 对非根目录的 "/xxx/" 一律 307 去掉尾斜杠
         *   （实测 /zh/ → 307 → /zh；/pet/ → 307 → /pet）。于是每个 zh 页上的 hreflang="zh"
         *   以及 /zh/index.html 自己的 canonical 都指向一个会 307 的 URL，
         *   Google Search Console 报「网页会自动重定向」（用户实测收到该通知）。
         *   根路径 "/" 是例外（实测 200，不重定向），所以 selfEn 的既有口径不动。
         *   同时**这一行也是「别给子页写尾斜杠」的保证**：dir 非空时两边都不加尾斜杠。 */
        const selfEn = SITE + (dir ? "/" + dir : "/");
        const selfZh = SITE + "/zh" + (dir ? "/" + dir : "");
        const self = zh ? selfZh : selfEn;
        let out = h
          .replace(/<title>[\s\S]*?<\/title>/, `<title>${title}</title>`)
          .replace(/<link rel="canonical" href="[^"]*"/, `<link rel="canonical" href="${self}"`)
          .replace(/<meta property="og:url" content="[^"]*"/, `<meta property="og:url" content="${self}"`)
          .replace(/<meta property="og:title" content="[^"]*"/, `<meta property="og:title" content="${title}"`)
          .replace(/<meta name="twitter:title" content="[^"]*"/, `<meta property="og:title" content="${title}"`);
        /* og:description 与 twitter:description 的 content 值相同，一次全部替换 */
        out = out.split(ROOT_DESC).join(`content="${desc}"`);
        /* <meta name="description"> 与 OG 那句不是同一个字符串，得单独换，
           否则子页面在搜索结果里仍显示全站通用描述 */
        out = out.replace(/<meta\s+name="description"[\s\S]*?\/>/, `<meta name="description" content="${desc}" />`);
        out = out.replace("</head>",
          `<link rel="alternate" hreflang="en" href="${selfEn}" />\n` +
          `  <link rel="alternate" hreflang="zh" href="${selfZh}" />\n` +
          `  <link rel="alternate" hreflang="x-default" href="${selfEn}" />\n  ` +
          "</head>");
        if (zh) out = out.replace('<html lang="en">', '<html lang="zh-CN">');
        /* 需要正文的子页面：把内容塞进挂载点。Vue 挂载时会清空该容器，视觉无差别；
           不执行 JS 的抓取方则能读到真实内容而不是空壳。
           轮 83：外面包一层 .seo-static（index.html 首帧前的内联规则对有 JS 的浏览器
           display:none）——静态正文只给无 JS 的爬虫读，真人不再「先看英文占位再进正页」。
           不能直接给 <section> 加类：cap-strip-hero 的正则按 `<section class="card seo-hero">`
           原文匹配，动了 APK 剥离就静默失效。 */
        if (html) {
          out = out.replace('<div id="app"></div>', `<div id="app">\n      <div class="seo-static">${html}</div>\n    </div>`);
        }
        return out;
      };
      for (const r of routes) {
        let h = fs.readFileSync(tpl, "utf8");
        h = bakePage(h, { title: r.title, desc: r.desc, dir: r.dir, html: r.html, zh: false });
        fs.mkdirSync(path.join(distDir, r.dir), { recursive: true });
        fs.writeFileSync(path.join(distDir, r.dir, "index.html"), h);
        made++;
        /* 轮 86：同名 zh 页面（/zh/<dir>）在同一次循环生成 —— en/zh 永远成对，不会漂 */
        const zr = zhRoutes.find((x) => x.dir === r.dir);
        if (zr) {
          let zh = fs.readFileSync(tpl, "utf8");
          zh = bakePage(zh, { title: zr.title, desc: zr.desc, dir: r.dir, html: zr.html, zh: true });
          fs.mkdirSync(path.join(distDir, "zh", r.dir), { recursive: true });
          fs.writeFileSync(path.join(distDir, "zh", r.dir, "index.html"), zh);
          made++;
        }
      }
      /* 首页本体也注入正文（先做子页再做首页，子页拿到的模板仍是干净壳） */
      {
        /* 轮 261：干净壳只读一次给 en/zh 共用——旧代码先烤英文写回 tpl、zh 再重读，
           拿到的已是烤过英文正文的壳，replace('<div id="app"></div>') 失配，
           /zh 首页正文永远停留在英文 hero（head 是中文、正文是英文，实测踩过）。 */
        const clean = fs.readFileSync(tpl, "utf8");
        const heroHome = hero(E.home.heroTitle, [
          E.home.heroSub.split("{n}").join("Warm Paws"),
          E.home.companions.title + ". " + E.home.companions.hall,
          E.home.mood.title + " " + E.home.mood.subtitle,
        ]);
        let h = bakePage(clean, { title: "Warm Paws · A gentle place to be", desc: ROOT_DESC_TEXT, dir: "", html: heroHome, zh: false });
        fs.writeFileSync(tpl, h);
        made++;
        /* 轮 86：zh 首页 /zh */
        const zhHeroHome = hero(ZH.home.heroTitle, [
          ZH.home.heroSub.split("{n}").join("Warm Paws"),
          ZH.home.companions.title + "。" + ZH.home.companions.hall,
          ZH.home.mood.title + " " + ZH.home.mood.subtitle,
        ]);
        let zh = bakePage(clean, {
          title: "暖爪 · 一个可以安心落脚的地方",
          desc: `${ZH.home.heroTitle}。${ZH.home.heroSub.split("{n}").join("Warm Paws")}`,
          dir: "", html: zhHeroHome, zh: true,
        });
        fs.mkdirSync(path.join(distDir, "zh"), { recursive: true });
        fs.writeFileSync(path.join(distDir, "zh", "index.html"), zh);
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
    <h1>This page wandered off. · 走丢啦</h1>
    <p>The address doesn't exist — the gentle rooms are still where they always were.<br />
       这个地址不存在——温柔的房间还在老地方。</p>
    <p><a href="/">Back to Warm Paws · 回首页</a></p>
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

/* —— 构建产物 env 硬校验 ——
 * 踩过：偶发一次 npm run build 时 VITE_SUPABASE_URL 没进产物（同命令重跑即正常），
 * 那份坏包被部署后登录卡整个消失（cloud.ready=false 退化本地模式）。
 * 这里在 closeBundle 里直接断言：env 在 .env 里存在 → 产物里必须能找到。
 * 找不到直接让构建失败，坏包根本出不了门。 */
function envGuard() {
  return {
    name: "env-guard",
    apply: "build",
    closeBundle() {
      /* 从 .env 读 URL（只校验 URL 的项目 slug，不把密钥写进日志） */
      let slug = "";
      try {
        const env = fs.readFileSync(path.join(rootDir, ".env"), "utf8");
        const m = env.match(/^VITE_SUPABASE_URL=https:\/\/([a-z0-9]+)\.supabase\.co/m);
        if (m) slug = m[1];
      } catch (e) { /* 没有 .env 就不校验 */ }
      if (!slug) return;
      /* 只校验 index.html 真正加载的入口脚本（= 首屏 JS）：
       * 踩过：`@capacitor/browser` 这类动态 import 会额外产出一个 index-<hash>.js 懒块
       * （它只含插件代码、不含 env，属正常），旧口径「所有 index-*.js 都要含 slug」
       * 会误报成「env 没进产物」，把好包挡在门外。 */
      const distDir = path.join(rootDir, "dist");
      const html = fs.readFileSync(path.join(distDir, "index.html"), "utf8");
      const entries = [...html.matchAll(/src="\/assets\/([^"]+\.js)"/g)].map((m) => m[1]);
      const hasSlug = (f) => fs.readFileSync(path.join(distDir, "assets", f), "utf8").includes(slug);
      const bad = entries.filter((f) => !hasSlug(f));
      if (!entries.length || bad.length) {
        throw new Error(
          `[env-guard] VITE_SUPABASE_URL 没进首屏入口包（${bad.length ? bad.join(", ") : "入口脚本一个都没找到"}）——
           登录会整个失效。重跑一次 npm run build；若复现，检查 .env 是否被进程环境覆盖。`);
      }
      console.log(`\n  env-guard  VITE_SUPABASE_URL ✓ 已进产物（入口 ${entries.length} 个）\n`);
    },
  };
}

/* —— 轮 297 · 把 Android 的版本号烤进前端 ——
 * 权威来源是 android/app/build.gradle 的 versionCode / versionName —— 用户设备上
 * 装着的就是它，检查更新必须拿它跟服务端比。这里在构建期读出来塞进 define，
 * 前端才知道「我现在是第几版」。
 * 读不到（纯 web 构建、没有 android 目录）时退到 package.json 的 version，
 * 保证构建永远能出包、不会因为缺 gradle 就崩。
 * 「gradle 与产物不漂移」由 tools/app-version-test.mjs 钉住。 */
function appVersion() {
  const read = () => {
    try {
      const g = fs.readFileSync(path.join(rootDir, "android/app/build.gradle"), "utf8");
      const code = (g.match(/versionCode\s+(\d+)/) || [])[1];
      const name = (g.match(/versionName\s+"([^"]+)"/) || [])[1];
      if (code && name) return { code, name };
    } catch (e) { /* 没有 Android 工程 → 退 package.json */ }
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
      return { code: "1", name: String(pkg.version || "0.0.0") };
    } catch (e2) { /* 极端兜底：总得给个值，前端拿不到合法数字就不弹更新窗 */ }
    return { code: "0", name: "0.0.0" };
  };
  return {
    name: "app-version",
    config() {
      const v = read();
      return {
        define: {
          __APP_VERSION_CODE__: JSON.stringify(v.code),
          __APP_VERSION_NAME__: JSON.stringify(v.name),
        },
      };
    },
  };
}

export default defineConfig({
  plugins: [vue({
    /* 轮 188：emoji-picker-element 是 Web Component（自定义元素），别让 Vue 当组件解析 */
    template: { compilerOptions: { isCustomElement: (tag) => tag === "emoji-picker" } },
  }), seoSitemap(), seoRoutes(), envGuard(), appVersion()],
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
