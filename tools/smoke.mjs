/* 模块级冒烟：让 Vite 即时编译关键模块，编译失败会返回 500
 * 另含静态 SEO 文件（robots / sitemap / 图标）的可访问性检查
 * 前置：dev 服务器已运行（dev.cmd），node tools/smoke.mjs
 */
const BASE = "http://localhost:5173";
const targets = [
  "/", "/pet", "/community", "/profile", "/src/main.js", "/src/App.vue", "/src/router.js", "/src/theme.js",
  "/src/views/HomeView.vue", "/src/views/PetView.vue",
  "/src/views/CommunityView.vue", "/src/views/ProfileView.vue",
  "/src/components/SideRails.vue", "/src/components/LottiePet.vue",
  "/src/components/ShareCard.vue", "/src/components/SnackRain.vue",
  "/src/components/FoodPainter.vue", "/src/components/SeasonFx.vue",
  "/src/utils/comments.js", "/src/utils/storage.js", "/src/utils/lottiePet.js",
  "/src/utils/snackGame.js",
  "/src/utils/supabase.js", "/src/utils/wall.js",
  "/src/data/themes.js", "/src/data/pets.js", "/src/data/extras.js",
  "/src/stores/petStore.js",
  "/src/i18n.js",
  /* 静态 SEO 资产：Vite 会把 public/ 直接映射到根路径 */
  "/robots.txt", "/sitemap.xml", "/og-image.png", "/favicon.png", "/apple-touch-icon.png",
];
const out = [];
let bad = 0;
for (const t of targets) {
  try {
    const r = await fetch(BASE + t);
    const ok = r.ok;
    if (!ok) bad++;
    out.push((ok ? "OK  " : "FAIL") + " " + r.status + "  " + t);
  } catch (e) {
    bad++;
    out.push("FAIL ERR  " + t + "  " + e.message);
  }
}
out.push("", bad === 0 ? "MODULE_SMOKE ALL PASS (" + targets.length + ")" : "MODULE_SMOKE FAILED=" + bad);
console.log(out.join("\n"));
