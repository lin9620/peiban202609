/* 皮肤作用域守护（轮406）：磨砂玻璃皮肤**只准在移动壳 / 移动网页生效，桌面网页保持原样**
 * 运行：node tools/skin-gate-test.mjs
 *
 * 口径演变（别再改回去）：
 *   轮 404 顶层静态 import     → 桌面网页也被换皮（用户：「网页端我没让你改啊」）
 *   轮 405 只认 html.cap-app   → 手机浏览器打开网页还是旧的（用户：「手机浏览器也要新样式」）
 *   轮 406 跟 isMobileNav 同线 → App + 手机浏览器（<900px）生效，桌面（≥900px）不变
 *
 * 静默 fail 的形态是「样式看着没问题、测试全绿，只是桌面网页也变了」。
 * 所以这里钉死：
 *   ① 不许静态 import "./glass.css"（那会进整个网页端的 CSS 包）
 *   ② 必须用 ?url 拿资源 URL，再用 <link media> 控制下载/生效
 *   ③ 初始 apply 与跨 900px 的 watch 都必须带 isMobileNav
 *   ④ index.html 不许预载 glass（那是绕过门控）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

let pass = 0;
const fails = [];
const ok = (name, cond) => (cond ? pass++ : fails.push(name));

const main = read("src/main.js");
const glass = read("src/glass.css");
const html = read("index.html");

/* ── ① 引入方式：只拿 URL，不许静态进 CSS 包 ── */
ok("main.js 不许有静态 import \"./glass.css\"（那会进桌面网页的 CSS 包）",
  !/^\s*import\s+["']\.\/glass\.css["']/m.test(main));
ok("main.js 必须用 ?url 引入 glass.css",
  /import\s+glassSkinUrl\s+from\s+["']\.\/glass\.css\?url["']/.test(main));
ok("必须创建 <link id=wp-glass rel=stylesheet>",
  /createElement\(\s*["']link["']\s*\)/.test(main)
  && /\.id\s*=\s*["']wp-glass["']/.test(main)
  && /\.rel\s*=\s*["']stylesheet["']/.test(main));
ok("link.href 必须用 glassSkinUrl", /\.href\s*=\s*glassSkinUrl/.test(main));

/* ── ② 门控与切换 ── */
ok("主门控必须跟 uiStore 的 isMobileNav 同一条线",
  /import\s*\{\s*isMobileNav\s*\}\s*from\s*["']\.\/stores\/uiStore\.js["']/.test(main));
ok("初始 apply 必须由 isMobileNav 门控",
  /applyGlassSkin\(\s*forceGlassSkin\s*\|\|\s*isMobileNav\.value\s*\)/.test(main));
ok("窗口跨 900px 要跟着切（watch isMobileNav）",
  /watch\(\s*isMobileNav\s*,/.test(main));
ok("关皮肤用 media=\"not all\"（桌面根本不去取）",
  /media\s*=\s*["']not all["']/.test(main));
ok("开皮肤用 media=\"all\"", /media\s*=\s*["']all["']/.test(main));
ok("门控认 ?skin=glass 预览参数", /skin=glass/.test(main));
ok("门控认 localStorage 的 wp-skin", /wp-skin/.test(main));

/* ── ③ 首屏不许预载 ── */
ok("index.html 不许出现 glass（那是绕过门控的首屏预载）", !/glass/i.test(html));

/* ── ④ 皮肤本身的关键令牌还在（防被当成垃圾文件删空） ── */
ok("glass.css 存在且有内容（> 15KB）", glass.length > 15000);
ok("卡片圆角令牌 --r-card: 23px", /--r-card:\s*23px/.test(glass));
ok("说明文字 62% 令牌 --ink-62", /--ink-62:/.test(glass));
ok("九色 pastel 令牌齐全（8 色 × 2 变体）",
  ["blue", "yellow", "mint", "peach", "pink", "lilac", "celadon", "gray"]
    .every((c) => new RegExp(`--p-${c}-a:`).test(glass) && new RegExp(`--p-${c}-ink:`).test(glass)));
ok("夜间主题有独立分支（否则浅字压白玻璃看不见）",
  /html\[data-theme="night"\]/.test(glass));
ok("磨砂玻璃真的用了 backdrop-filter", /backdrop-filter:\s*blur\(/.test(glass));
ok("底部渐隐遮罩存在（悬浮条下面那 8px 缝隙会露出半行正文）", /body::after/.test(glass));
ok("底部渐隐有深色版本（夜间不能横一条米白光带）",
  /--g-fade:\s*246/.test(glass) && /html\[data-theme="night"\][\s\S]{0,1200}?--g-fade:/.test(glass));

console.log(`TOTAL ${pass + fails.length} PASS ${pass} FAIL ${fails.length}`);
for (const f of fails) console.log("FAIL  " + f);
if (fails.length) process.exit(1);
