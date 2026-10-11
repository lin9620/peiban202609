/* 轮 18 基建：App（Capacitor WebView）里剥掉构建预渲染写进 #app 的英文 SEO 占位。
 * 那段占位是给搜索引擎看的；App 冷启动 JS bundle 未就绪的几秒里它会裸露出来，
 * 就是用户反复反馈的「进入 app 先显示一堆英文乱码」。网页端保留（SEO 需要）。
 * 另外把看门狗的判定从「有 hero 才兜底」放宽为「6 秒未挂载就出中文兜底」，
 * 这样剥离后的 App 资源在 JS 起不来时也能给出中文提示而不是白屏。
 * 用法：node tools/cap-strip-hero.mjs [目录]   缺省处理 android/app/src/main/assets/public
 * 注意：以后 cap sync 会把带占位的 dist 拷回来 → 用 npm run cap:sync（已串好本脚本）。 */
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] || "android/app/src/main/assets/public";
const HERO_RE = /<section class="card seo-hero">[\s\S]*?<\/section>\s*/g;
const WATCH_OLD = 'if (!app || !app.querySelector(".seo-hero")) return;';
const WATCH_NEW = "if (!app) return;";
let files = 0, hero = 0, watch = 0;

function walk(dir) {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) walk(p);
    else if (name.name === "index.html") {
      files++;
      const html = readFileSync(p, "utf8");
      let next = html.replace(HERO_RE, "");
      if (next !== html) hero++;
      if (next.includes(WATCH_OLD)) { next = next.split(WATCH_OLD).join(WATCH_NEW); watch++; }
      if (next !== html) writeFileSync(p, next);
    }
  }
}
walk(root);
/* 轮 238 · 剥掉同步进 App 资源的网页用 APK（public/apk/）——
 * 「下载 App」是网页端功能，App 里点不了它；嵌进去 = App 体积白白翻倍。 */
try {
  rmSync(join(root, "apk"), { recursive: true, force: true });
} catch (e) { /* 没有 apk/ 目录就 nothing to do */ }
console.log(`[cap-strip-hero] ${root} · index.html × ${files} · 剥 SEO 占位 × ${hero} · 放宽看门狗 × ${watch} · 剥内嵌 apk ✓`);
