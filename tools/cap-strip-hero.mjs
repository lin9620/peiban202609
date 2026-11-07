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
let files = 0, hero = 0, watch = 0, vp = 0;

/* 轮 322 · 键盘让位：App 里的视口策略必须从 resizes-visual 换成 overlays-content。
 * 原因（真机实测）：Chromium 只在文档加载时读 interactive-widget，运行时改 meta 无效；
 * 而 App 侧由 CSS 变量 --kb-h + 过渡自己让位，视口必须一动不动 —— 否则「视口缩 304」
 * 和「我们扣 320」会叠加，输入栏直接被顶穿。
 * 网页那份 dist/index.html 保持 resizes-visual（浏览器自己把可视视口平移到光标处）。 */
const VP_OLD = "interactive-widget=resizes-visual";
const VP_NEW = "interactive-widget=overlays-content";
/* 轮 462：网页端为了手势条去掉了 viewport-fit=cover（安卓浏览器 env 恒 0，内容会铺到
 * 手势条底下），但 App 这份必须留着 —— App 是 edge-to-edge 的 WebView，靠它把内容铺到
 * 屏幕最底，安全区由 MainActivity 的 --sat / --sab 负责；抽掉等于让 WebView 自己再内缩
 * 一条导航栏，底部白一条。两份 HTML 的差异就靠这里补回来。 */
const VP_COVER_ANCHOR = 'content="width=device-width, initial-scale=1.0, ';

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
      if (next.includes(VP_OLD)) {
        next = next.split(VP_OLD).join(VP_NEW);
        if (!next.includes("viewport-fit=cover") && next.includes(VP_COVER_ANCHOR)) {
          next = next.replace(VP_COVER_ANCHOR, VP_COVER_ANCHOR + "viewport-fit=cover, ");
        }
        vp++;
      }
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
console.log(`[cap-strip-hero] ${root} · index.html × ${files} · 剥 SEO 占位 × ${hero} · 放宽看门狗 × ${watch} · 视口 overlays-content × ${vp} · 剥内嵌 apk ✓`);
