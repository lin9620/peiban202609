import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

/* history 路由：为每个子路由生成独立静态 HTML（独立 title/canonical/OG），
 * 部署后 /pet、/community、/profile 直接返回对应页面，SEO 与分享卡片各自正确 */
function seoRoutes() {
  return {
    name: "seo-routes",
    apply: "build",
    closeBundle() {
      const distDir = path.join(rootDir, "dist");
      const tpl = path.join(distDir, "index.html");
      if (!fs.existsSync(tpl)) return;
      const SITE = "https://dale.de5.net";
      const ROOT_DESC =
        'content="Care for a little pet, draw its food, share kindness with gentle people."';
      const routes = [
        {
          dir: "pet",
          title: "Warm Paws · Meet Your Little Pet",
          desc: "Care for an adorable hand-drawn pet: draw its food, play gentle games, and watch it grow.",
        },
        {
          dir: "community",
          title: "Warm Paws · The Kindness Wall",
          desc: "Share gentle thoughts and kind replies on the cloud kindness wall — everyone can read, members can post.",
        },
        {
          dir: "profile",
          title: "Warm Paws · Your Gentle Corner",
          desc: "Your pets, coins, badges and gentle daily records — all in one cozy place.",
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
        fs.mkdirSync(path.join(distDir, r.dir), { recursive: true });
        fs.writeFileSync(path.join(distDir, r.dir, "index.html"), h);
        made++;
      }
      console.log(`\n  seo-routes  ${made} route pages → /pet /community /profile\n`);
    },
  };
}

export default defineConfig({
  plugins: [vue(), seoSitemap(), seoRoutes()],
  server: {
    port: 5173,
    open: true,
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
