/* 启动页主题预览（把 index.html 里那块静态启动页原样抽出来，逐主题生成一个独立页面）
 *   用法：node tools/splash-preview.mjs [--out=.probe12]
 *   产出：<out>/sp-<theme>.html —— 每份都是完整 HTML，<html data-theme="…" class="cap-app">，
 *        样式与 DOM 与线上启动页**同一份文本**（不是照着抄的复刻版），所以预览即真机。
 *   截图（桌面 Chrome 无头）：
 *     chrome --headless=new --disable-gpu --screenshot=sp-cream.png \
 *       --window-size=393,895 --force-device-scale-factor=2 file:///…/sp-cream.html
 *   为什么不直接开 index.html：那份页面里启动页默认 display:none（网页端不闪），
 *   只有 html.cap-app 才显示 —— 预览页补上这个类，其余保持原样。 */
import fs from "node:fs";
import path from "node:path";

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith("--" + name + "="));
  return hit ? hit.split("=").slice(1).join("=") : dflt;
};
const outDir = arg("out", ".probe12");
const html = fs.readFileSync("index.html", "utf8");

/* 抽出启动页整块（含它自己的 <style>）：从 <div id="app-splash" 到它的收尾 </div> */
const START = '<div id="app-splash"';
const END_MARK = '<div class="sp-dots"><i></i><i></i><i></i></div>\n  </div>';
const i = html.indexOf(START);
const j = html.indexOf(END_MARK);
if (i < 0 || j < 0) {
  console.error("找不到启动页块（index.html 结构变了？）");
  process.exit(1);
}
const block = html.slice(i, j + END_MARK.length);

/* 主题表从 src/data/themes.js 取，避免和页面里的白名单各写一份 */
const themes = [...fs.readFileSync("src/data/themes.js", "utf8").matchAll(/key:\s*"([a-z]+)"/g)]
  .map((m) => m[1]);
if (!themes.length) { console.error("主题表为空"); process.exit(1); }

fs.mkdirSync(outDir, { recursive: true });
for (const key of themes) {
  const page = `<!DOCTYPE html>
<html lang="zh" data-theme="${key}" class="cap-app">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
<title>splash · ${key}</title>
<style>html, body { margin: 0; height: 100%; background: #faf9f5; }</style>
</head>
<body>
${block}
</body>
</html>
`;
  fs.writeFileSync(path.join(outDir, `sp-${key}.html`), page);
}
console.log(`splash-preview: ${themes.length} 套 → ${outDir}/sp-<theme>.html（${themes.join(" / ")}）`);
