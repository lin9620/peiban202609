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
const style = read("src/style.css");
const html = read("index.html");
/* 性能断言只看「真代码」：注释里会提到 backdrop-filter / filter: blur 这些词，
 * 不剥掉注释就会误报（本轮实际踩到，3 条假红）。 */
const css = glass.replace(/\/\*[\s\S]*?\*\//g, "");

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
  /--g-fade:\s*251/.test(glass) && /html\[data-theme="night"\][\s\S]{0,1200}?--g-fade:/.test(glass));
/* 轮 413 · 用户：「我不想要背景里面那些黑色」（圈的是卡片之间的缝）。
 * 缝里露出的是 237,233,244 紫灰 —— 薰衣草紫/雾蓝两团冷光斑落在奶油底上，
 * 亮度只差 2 级、色相差 11 级，在暖白卡片之间就是一条脏灰带。
 * 现在只留暖色光斑，且亮度必须整体在卡片（≈254）之下 10 级以内。 */
{
  const before = glass.match(/html::before\s*\{[\s\S]*?\n\}/);
  const bg = before ? before[0] : "";
  const cool = /rgba\(\s*(20[0-9]|21[0-9]|22[0-5]),\s*(20[0-9]|21[0-9]|22[0-9]),\s*2[4-5][0-9]/.test(bg);
  ok("背景层不许再出现冷色光斑（紫/蓝/薄荷，B 通道压过 R 的那类）", !!bg && !cool);
  ok("背景底色提亮到 #FBFAF7 一档（原来 #F6F4F1 压不住卡片对比）", /#FBFAF7/i.test(bg));
  ok("--g-bg-card 提到 0.90（底色变亮后卡片要更实才分得开）",
    /--g-bg-card:\s*rgba\(255,\s*255,\s*255,\s*0\.90\)/.test(glass));
}
/* 轮 408 · 会话页两条回归（用户截图：输入条下面一大块空白 / 输入条整条被米白雾蒙住）。
 * ① 那层渐隐只为补悬浮胶囊下的 8px 缝隙，会话页没有胶囊，却压在输入条上 → 必须关掉；
 * ② 86px 的胶囊让位带 !important，会把 style.css 里 shell--chat 的 padding-bottom:0 压掉。 */
ok("会话态必须关掉底部渐隐层（否则盖住输入条，看着像「底部都模糊」）",
  /body:has\(\.shell--chat\)::after\s*\{\s*display:\s*none/.test(glass));
ok("会话态 main 的胶囊让位必须归零（否则输入条下方多一条 86px 空带）",
  /\.shell--mobile-nav\.shell--chat main\s*\{\s*padding-bottom:\s*0\s*!important/.test(glass));
/* 轮 409 · 底部空白带：`.shell` 自带的 48px 让位在手机上必须归零，否则和 main 的让位相加
 * （134+sab），而悬浮胶囊只占 8+sab+56 —— 多出的 50~60px 在玻璃底上就是一条彩色空带。 */
ok("手机壳不许再叠 .shell 自带的 48px 让位（会和 main 的让位相加）",
  /\.shell--mobile-nav\s*\{\s*padding-bottom:\s*0\s*!important/.test(glass));
{
  const m = glass.match(/\.shell--mobile-nav main\s*\{\s*padding-bottom:\s*calc\((\d+)px/);
  const px = m ? Number(m[1]) : NaN;
  ok("main 的底部让位只在 70~80px（胶囊 8+56+呼吸 10 ≈ 74，越界又会空一条）",
    px >= 70 && px <= 80);
}
/* 轮 410 · 「每页自带滚动容器、不吃 main 的 padding」是照抄出来的假前提。
 * 实测 .home-pane 与 .pet-page 都是普通内容流，main 的让位对它们完全有效；
 * 再各补一份就是双层叠加：宠物页滚到底正文离胶囊 148px、四联 pane 底部 90px 空白。 */
ok("首页 .home-pane 不许再加底部让位（main 已让位，双层会空出一条）",
  /\.home-pane\s*\{\s*padding-bottom:\s*0\s*!important/.test(glass));
ok("宠物页 .pet-page 不许再加底部让位（它不是独立滚动层，实测双层空 148px）",
  /\.pet-page[\s\S]{0,90}?padding-bottom:\s*0\s*!important/.test(glass));
/* 轮 411 · 用户「今日页面有黑底」= 首页联条的选中项是 var(--ink) 墨黑胶囊。
 * 它在浅玻璃上就是一块黑，也不在九色 Pastel 里；改成主题色 --accent。 */
ok("首页联条选中项不许再用墨黑底（用户把这块黑叫「黑底」）",
  !/\.home-chips\s+\.home-chip\.on\s*\{[^}]*?background:\s*var\(--ink\)/.test(glass));
/* 它是 sticky，吸在 top:0 就会滑到全屏壳的状态栏底下叠字 —— 必须自己吃下 --sat。 */
ok("首页联条吸顶时必须自己吃下状态栏高度（否则压着状态栏叠字）",
  /\.home-chips\s*\{[^}]*?padding:\s*calc\(8px \+ var\(--sat/.test(glass));
/* 轮 411 · 「故事页左边有黑边」= .st-card--featured 的 border-left: 3px solid #d9a441（暗金竖边）
 * + .st-card 底色只有 42% 白，左半边透出的柔光更深。两条都得压掉。
 * 轮 413：描边从「白玻璃线」换成「7.5% 暖墨发丝线」—— 底色提亮后白线在浅底上等于隐形。 */
ok("故事卡必须用 1px 发丝描边压掉那条 3px 暗金左边",
  /\.st-card,[\s\S]{0,400}?border-left:\s*1px solid rgba\(120, 102, 88, 0\.075\)/.test(glass));
ok("故事卡不许再出现 3px 暗金左边", !/border-left:\s*3px solid #d9a441\s*(!important)?;/.test(glass));
ok("故事卡底色必须提到玻璃档（42% 白会让卡片左半边透出深色柔光）",
  /\.st-card[\s\S]{0,200}?background:\s*var\(--g-bg-card\)/.test(glass));

/* ── ⑤ 性能预算（轮 407）：磨砂玻璃不能落在「跟着列表滚动」的元素上 ──
 * 事故：轮 404~406 给 .card / .post-card / .status-card / .dm-list / .story-main 全挂了
 * backdrop-filter，首页实测 12 层模糊、合计 558,750 px²（≈1.7 个视口），
 * 三颗光斑还带 filter: blur(64px)、body 还带 background-attachment: fixed ——
 * 装到 Android WebView 上「每个页面都非常卡」。
 * 这几条断言就是防止以后有人为了「更玻璃」再把模糊加回滚动内容。 */
const block = (re) => {
  const m = css.match(re);
  if (!m) return null;
  const start = m.index + m[0].length;
  const end = css.indexOf("}", start);
  return end > start ? css.slice(start, end) : null;
};

for (const [name, re] of [
  ["卡片 .card/.glass", /\.card,\s*\n\.glass\s*\{/],
  ["帖卡 .post-card", /\.post-card\s*\{/],
  ["状态卡 .status-card", /\.status-card\s*\{/],
  ["会话列表 .dm-list", /\.dm-list\s*\{/],
  ["故事正文 .story-main", /\.story-main\s*\{/],
]) {
  const b = block(re);
  ok(`滚动内容不许挂 backdrop-filter（${name}）`, !!b && !/backdrop-filter:\s*blur/.test(b));
}
ok("全站不许再用 filter: blur()（光斑改用径向渐变，滤镜会每帧重算）",
  !/(?<!backdrop-)filter:\s*blur\(/.test(css));
ok("不许用 background-attachment: fixed（手机会每帧重绘整屏背景）",
  !/background-attachment:\s*fixed/.test(css));
ok("真模糊只留固定层/浮层：规则数 ≤ 8 处",
  (css.match(/(?<!-webkit-)backdrop-filter:\s*blur\(/g) || []).length <= 8);
ok("底部导航仍有真模糊（设计语言不能为了性能全丢）",
  /backdrop-filter:\s*blur\(18px\)/.test(css));

{
  /* 轮 412：卡片投影在左右 20px 的留白里染出一条灰带（用户叫「黑边 / 白块」）。
   * 卡片离屏幕边只有 20px，任何 blur ≥ 12px 的投影都会整条留白染色。
   *
   * 轮 529：用户报「四个页面字体/ui 不一致，故事页文字偏大」。故事卡改成跟全站卡片
   * 同一套几何（--r-card 圆角 / 16·16·14 内边距 / 10 卡距 / --g-shadow 接触影），
   * 所以这里不再要求「投影必须是 none」——那条是 412 年代一刀切的结果，代价是故事卡
   * 比别的卡矮一档。现在只锁「不许自造大投影」，接触影（blur 2px、alpha 4.5%）实测
   * 在缝里只压暗 4/255，肉眼不可见。
   *
   * 取值方式也改了：原来靠 `\.st-card[\s\S]{0,700}?` 往后扫，会串到隔壁
   * `.st-card--featured` 块的 margin-bottom 上「蒙混过关」（529 之前那条 12px 断言
   * 就是这样瞎过的）。现在切片只取 `.st-card` 自己那个规则块。 */
  const m = glass.match(/\.st-card,\s*\.st-card--featured\s*\{/);
  const stBlock = m ? glass.slice(m.index, glass.indexOf("}", m.index)) : "";
  const shadow = (stBlock.match(/box-shadow:\s*([^;]+);/) || [])[1] || "";
  ok("故事卡投影不许再染到侧边留白（blur ≤ 6px，只准 var(--g-shadow) 或 none）",
    !!stBlock && !/18px/.test(shadow)
    && (shadow.indexOf("var(--g-shadow)") >= 0 || shadow.trim() === "none"));
  ok("故事卡与其它三页同一套卡语言（圆角 --r-card · 内边距 16/16/14 · 卡距 10）",
    /border-radius:\s*var\(--r-card\) !important/.test(stBlock)
    && /padding:\s*16px 16px 14px !important/.test(stBlock)
    && /margin-bottom:\s*10px !important/.test(stBlock));
  ok("「排行榜 / 我的」两枚大钮必须有实底（--wash 42% 白压在玻璃上等于空壳）",
    /\.st-feed-navbtn[\s\S]{0,220}?background:\s*var\(--g-bg-card\)/.test(glass));
  ok("搜索框也要实底，不许只剩一条白条", /\.st-search\s*\{[^}]*background:\s*var\(--g-bg-card\)/.test(glass));
}

/* ── ⑬ 轮 414 ·「把那个黑色都去掉」──
 * 用户第 4 次圈背景里的「黑」。这次不再调色，直接把「暗」这个手段从皮肤里拿掉：
 * ① 所有 `background: var(--ink)` 的墨黑选中态换成主题色；
 * ② 34px/10% 的卡片大投影收成 1~2px 接触影（那团灰雾就是用户眼里的「黑」）；
 * ③ 故事卡投影归零，靠发丝线分界。
 *   （轮 529 修正：归零让故事卡比其它三页的卡「矮一档」，现在改成与主卡片共用
 *     同一条 --g-shadow 接触影 —— 实测缝里只压暗 4/255，肉眼不可见、不染灰带。） */
ok("皮肤里不许再有墨黑（--ink）填底的控件",
  !/background:\s*var\(--ink\)\s*!important/.test(glass));
{
  const m = glass.match(/--g-shadow:\s*([^;]+);/);
  const v = m ? m[1] : "";
  const blur = Number((v.match(/(\d+)px/g) || ["999px"])[0].replace("px", ""));
  const alphas = (v.match(/[\d.]+\)/g) || []).map((x) => Number(x.replace(")", "")));
  ok("卡片大投影必须收成接触影（模糊 ≤ 4px，alpha ≤ 0.06）",
    blur <= 4 && alphas.every((a) => a <= 0.06));
}
ok("主卡片与故事卡共用同一条接触影（--g-shadow），没有另起的投影值",
  /\.st-card,\s*\.st-card--featured\s*\{[\s\S]{0,900}?box-shadow:\s*var\(--g-shadow\),\s*var\(--g-hi\)\s*!important/.test(glass)
  && /\.card,\s*\.glass\s*\{[\s\S]{0,300}?box-shadow:\s*var\(--g-shadow\),\s*var\(--g-hi\)\s*!important/.test(glass));
ok("主卡片用发丝线代替投影分界",
  /\.card,[\s\S]{0,140}?border:\s*1px solid rgba\(120, 102, 88, 0\.06\)/.test(glass));

/* ── ⑭ 轮 415 ·「点底部＋号有很多问题」──
 * 真机实测到的三条根因，逐条钉住，不然下次重构又会悄悄退回去：
 * ① 胶囊挂着 backdrop-filter，会把 position:fixed 的后代困在胶囊内框里当包含块 ——
 *    遮罩实测只有 372×54，点弹层外面关不掉、直接穿透点到下面卡片。→ 弹层必须 Teleport 到 body。
 * ② 遮罩是 38% 墨黑 + 4px 模糊，浅色界面上就是一顶黑壳。→ 只许 ≤16% 暖色、不许 blur。
 * ③ .tabbar-sheet 自己刷了白玻璃底，里面三张 76% 白的卡只隔 10px，粘成一整块白板。
 *    → 容器必须透明无底无影，白卡交给每一项。 */
{
  const tabbar = fs.readFileSync(path.join(ROOT, "src/components/TabBar.vue"), "utf8");
  ok("＋ 弹层必须 Teleport 到 body（胶囊的 backdrop-filter 会把 fixed 困在胶囊里）",
    /<Teleport\s+to="body">[\s\S]{0,1200}?tabbar-sheet/.test(tabbar));
  ok("胶囊内部不许再直接挂遮罩/弹层", !/<van-tabbar[\s\S]*?class="tabbar-mask"[\s\S]*?<\/van-tabbar>/.test(tabbar));
  ok("弹层开着时按系统返回键先关弹层（走 backStack，不退页面）",
    /pushBack\(backFn\)/.test(tabbar) && /open\.value = false;\s*return true;/.test(tabbar));

  const maskRule = (glass.match(/\.tabbar-mask\s*\{[^}]*\}/) || [""])[0];
  ok("遮罩不许再用 38% 墨黑 + 4px 模糊（浅色界面上一顶黑壳）",
    !/rgba\(38,\s*30,\s*22/.test(glass) && /backdrop-filter:\s*none/.test(maskRule));
  ok("遮罩必须铺满全屏（含底部导航），不再是胶囊那么大小",
    /inset:\s*0;/.test(maskRule) && !/inset:\s*0 0 calc/.test(maskRule));

  const sheetRule = (glass.match(/\.tabbar-sheet\s*\{[^}]*\}/) || [""])[0];
  ok("弹层必须是贴底整块面板（小红书式），顶部圆角",
    /bottom:\s*0;/.test(sheetRule) && /border-radius:\s*24px 24px 0 0/.test(sheetRule));
  /* 轮 416：0.98 白看着「几乎不透」，但正文那种 28px 的粗字只透 2% 就能看见影子 ——
   * 面板里三层入口的字和背后的帖子标题叠在一起，整块读起来是脏的。
   * 遮罩已经把背景压下去了，面板本身必须**实色**（不允许任何 alpha）。 */
  ok("面板底色必须是实色（0.98 白仍会让正文大字透上来）",
    /background:\s*#FFFDFB\s*!important/.test(sheetRule) && !/background:\s*rgba\(255,\s*255,\s*255,\s*0\.[0-9]+\)\s*!important/.test(sheetRule));
  ok("面板从底部升起（translateY 100% → 0）",
    /@keyframes\s+tabbar-sheet-up\s*\{\s*from\s*\{\s*transform:\s*translateY\(100%\)/.test(glass));
  ok("三瓣入口是行不是卡：分隔用发丝线，不许再画白卡片",
    /\.tabbar-sheet\s+\.tabbar-opt\s*\{[^}]*?background:\s*none/.test(glass) &&
    /\.tabbar-sheet\s+\.tabbar-opt\s*\+\s*\.tabbar-opt\s*\{[^}]*?border-top:\s*1px solid rgba\(120, 102, 88, 0\.075\)/.test(glass));
  ok("三瓣入口不许再做 1° 微旋转（等宽齐边的一列，转了就是没对齐）",
    !/\.tabbar-sheet\s+\.tabbar-opt:nth-child\(1\)\s*\{\s*transform:\s*rotate/.test(glass));
}

/* ── ⑭ 轮 418 ·「一行字 + 一枚印章」──
 * 417 的「柔底胶囊 + 38 圆球」被用户判为「一点没变」。真正的病根是**形状语汇**：
 * 一条 373px 的栏里放两个实心面（选中胶囊 + 圆球），横着读就是「两个按钮 + 三个字」。
 * 所以这一组钉的是「一个面 + 一条线」的分层，而不是具体颜色：
 *   ① 主操作必须是横向圆角印章（宽 46 > 高 30、圆角 10），不许退回直径 38/46 的圆球；
 *   ② 选中项不许再垫实心底，只许一条 12×3 的短横（线）+ 主题色文字；
 *   ③ 字号不能退回 12.5（纯文字撑不住五分栏）。 */
ok("底部必须保持纯文字（不加图标）",
  !/\.tabbar\s+\.tab-ico/.test(glass));
{
  const m = glass.match(/\.tabbar\s+\.tab-compose-x\s*\{[^}]*\}/);
  const rule = m ? m[0] : "";
  const w = Number((rule.match(/width:\s*(\d+)px/) || [])[1]);
  const h = Number((rule.match(/height:\s*(\d+)px/) || [])[1]);
  const r = Number((rule.match(/border-radius:\s*(\d+)px/) || [])[1]);
  ok("中间 ＋ 必须是横向圆角印章（46×30 / 圆角 10），不许退回圆球",
    w === 46 && h === 30 && r === 10 && !/border-radius:\s*50%/.test(rule));
  ok("印章必须去掉白色描边圈（那圈白边让它读成贴纸而不是栏内元件）",
    /border:\s*0/.test(rule));
}
ok("选中项不许再垫实心色块（一条栏里只许有一个实心面）",
  !/van-tabbar-item__text[\s\S]{0,200}?background:\s*rgba\(204,\s*120,\s*92,\s*0\.11\)/.test(glass)
  && /background:\s*none\s*!important/.test(glass));
ok("选中项必须有字下短横（16×3 圆角 2，贴字盒底边）",
  /\.van-tabbar-item--active \.van-tabbar-item__text::after,[\s\S]{0,420}?bottom:\s*0;\s*width:\s*16px;\s*height:\s*3px;\s*border-radius:\s*2px/.test(glass));
ok("胶囊左右必须落在 18px 网格上（和全站卡片同一条竖边）",
  /left:\s*18px\s*!important;\s*right:\s*18px\s*!important/.test(glass));
ok("选中文字必须是主题色，不许再用 --ink 纯黑",
  /\.van-tabbar-item--active \.tab-label,[\s\S]{0,120}?color:\s*var\(--accent-deep\)/.test(glass)
  && !/\.tabbar\s+\.van-tabbar-item--active\s*\{\s*color:\s*var\(--ink\)/.test(glass));
ok("夜间选中色必须换成浅陶土（全局 #a9583e 压在深底上等于隐形）",
  /html\[data-theme="night"\][\s\S]{0,400}?--accent-deep:\s*#E8A184/.test(glass));
{
  const m = glass.match(/\.tabbar\s+\.tab-label\s*\{[^}]*\}/);
  const fs = Number(((m ? m[0] : "").match(/font-size:\s*([\d.]+)px/) || [])[1]);
  ok("页签字号 ≥ 13.5px（纯文字五分栏，12.5 太轻撑不住）", fs >= 13.5);
}
ok("胶囊用独立的 --g-tabbar（0.90），不吃 0.82 那一档",
  /background:\s*var\(--g-tabbar\)/.test(glass) && /--g-tabbar:\s*rgba\(255,\s*255,\s*255,\s*0\.90\)/.test(glass));
ok("底部渐隐必须高到能盖住胶囊下的缝（≥ 60px + 手势区）",
  (() => {
    const m = glass.match(/body::after\s*\{[\s\S]*?height:\s*calc\((\d+)px/);
    return m && Number(m[1]) >= 60;
  })());

/* ── ⑮ 轮 426 · 会话页必须**整页铺满**（420/421 的浮卡方案已作废）──
 * 420/421 把它做成「浮在暖色画布上的 23px 圆角玻璃卡 + 18px 画布边」，
 * 理由是解释「第一次点有玻璃」；423 的时序采样已证明真因是列表行的按压态，
 * 跟聊天面板无关。用户于是看到的是「会话详细页多了一圈边、不铺满了」。
 * 这一组钉住：不许再有画布边、不许再给 .dm-thread 加圆角/描边/投影/磨砂，
 * 而且必须显式把 `.card` 的 !important 玻璃底压回 var(--page-bg)（光删规则不够）。 */
ok("会话页不许再留画布边（.dm-page 不许有 18px 内边距）",
  !/\.shell--mobile-nav\.shell--chat \.dm-page\s*\{[^}]*padding:[^}]*18px/.test(glass));
{
  const m = glass.match(/\.shell--mobile-nav\.shell--chat \.dm-thread\.card\s*\{[^}]*\}/);
  const rule = m ? m[0] : "";
  ok("会话面板必须整屏铺满：圆角归零", /border-radius:\s*0\s*!important/.test(rule));
  ok("会话面板必须整屏铺满：描边、投影归零",
    /border:\s*0\s*!important/.test(rule) && /box-shadow:\s*none\s*!important/.test(rule));
  ok("会话面板底色必须回到 var(--page-bg)（不许再是半透明磨砂卡）",
    /background:\s*var\(--page-bg\)\s*!important/.test(rule));
  ok("会话面板不许再挂 backdrop 模糊", /backdrop-filter:\s*none\s*!important/.test(rule));
  ok("会话面板必须显式取消 .card 的玻璃底（那条是 !important，删规则不够）", rule.length > 0);
}
ok("轮 419 的满屏 --g-chat 方案不许回潮", !/--g-chat:/.test(glass));

/* ── ⑯ 轮 422 · 会话行的玻璃挂在「按下去」那一帧 ──
 * 用户原话（第 6 次）：「我说的是点击的时候有，谁让你改成点击之后、返回有这个」。
 * 所以口径钉死：**按压态（:active）就是玻璃**，常驻选中一律不许。
 * 真机时序（为什么必须挂 :active）：
 *   .on 是 click 之后才加上的，紧接着路由把整个列表 display:none；
 *   首次进入要等会话数据→慢→看得见那层粉；后面快了→一闪而过→「后面就没有了」。
 *   :active 在 touchstart 就生效，与路由快慢无关，每一次点都一样亮。
 * 另外触摸端 :hover 会一直粘在最后点的元素上，白 .42 既看不出玻璃、又会在按下期间盖掉按压态，
 * 所以 :hover 必须关在 @media (hover: hover) and (pointer: fine) 里。
 * 反回归：MessagesView 里不许再出现 lastConvId 这类「返回后还亮着」的常驻高亮。 */
{
  const m = glass.match(/\.dm-row:active,\s*\.dm-row\.press,\s*\.dm-row\.on:active\s*\{[^}]*\}/);
  const rule = m ? m[0] : "";
  /* 轮 531：这里的底色原来写死成樱粉 rgba(251,214,226,.44)（九色 pastel 时代），
   * 薄荷 / 薰衣草 / 星夜蓝下按下去是一块粉，跟页面毫无关系。改成主色族的 --accent-wash。
   * 断言口径跟着改：**只认变量，不许再出现具体色值** —— 写死哪个色都会在别的主题下错。 */
  ok("按压态必须是玻璃（主题色 wash 底 + 双层白色渐变）",
    /var\(--accent-wash\)/.test(rule) && /linear-gradient\(180deg/.test(rule));
  ok("按压态底色不许写死具体色值（樱粉 251,214,226 不许再出现）",
    !/rgba\(\s*251\s*,\s*214\s*,\s*226/.test(rule));
  ok("选中态（.dm-row.on）与按压态同一层变量",
    (() => {
      const r = glass.match(/\.dm-row\.on\s*\{[^}]*\}/);
      return !!r && /var\(--accent-wash\)/.test(r[0]);
    })());
  /* --accent-wash 是「按压/选中底色」的唯一来源。
   * 默认值在 glass.css 的 :root（= 暖奶油主题，主色陶土）→ 必须暖色 R>G>B；
   * 四套彩色主题各自覆盖，少写一套 = 那套主题下退回陶土，色相又错。 */
  ok("glass.css 的 --accent-wash 默认值必须是暖色（R>G>B，跟陶土主色同族）",
    (() => {
      const v = (glass.match(/--accent-wash:\s*([^;]+);/) || [])[1] || "";
      const m = v.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
      return !!m && +m[1] > +m[2] && +m[2] > +m[3];
    })());
  ok("四套彩色主题都必须覆盖 --accent-wash（sakura / mint / lavender / night）",
    ["sakura", "mint", "lavender", "night"].every((t) => {
      const i = style.indexOf(`html[data-theme="${t}"] {`);
      if (i < 0) return false;
      const blk = style.slice(i, style.indexOf("}", i));
      return /--accent-wash:/.test(blk);
    }));
  ok("会话行的投影不许再用旧陶土色（169,88,62 在薄荷/紫主题下是褐影）",
    !/169\s*,\s*88\s*,\s*62/.test((glass.match(/\.dm-row:active[\s\S]{0,700}?\}/) || [""])[0]));
  ok("按压态必须带顶部 1px 高光 + inset 发丝环（玻璃的物理特征）",
    /inset 0 1px 0 rgba\(255, 255, 255, 0\.96\)/.test(rule) && /inset 0 0 0 1px rgba\(255, 255, 255, 0\.52\)/.test(rule));
  ok("按压态过渡必须够快（≤ .08s，否则列表还没隐藏就结束了）",
    /transition:\s*background\s*\.0[0-8]s/.test(rule));
  ok("按压态必须同时认 :active 和 JS 加的 .press（:active 何时挂上不由我们定）",
    /\.dm-row:active/.test(rule) && /\.dm-row\.press/.test(rule));
  ok(":hover 必须关在有指针的媒体查询里（触摸端 hover 会粘住）",
    /@media \(hover: hover\) and \(pointer: fine\)\s*\{[\s\S]{0,200}?\.dm-row:hover/.test(glass));
  ok("裸的 .dm-row:hover 白底不许回潮",
    !/(^|\n)\.dm-row:hover\s*\{[^}]*background/.test(glass));
  ok("会话行必须 touch-action: manipulation（真机实测有 ~400ms 点击延迟）",
    /\.dm-row\s*\{[^}]*touch-action:\s*manipulation/.test(glass));
  ok("夜间按压态换成半透明白（不许拿粉色凑）",
    /html\[data-theme="night"\] \.dm-row:active/.test(glass) &&
    /html\[data-theme="night"\] \.dm-row\.press/.test(glass));
}
{
  const mv = read("src/views/MessagesView.vue");
  ok("不许再搞「返回后还亮着」的常驻选中（lastConvId 必须消失）",
    !/lastConvId/.test(mv));
  ok("行 class 只认 activeId + 按下瞬间的 pressedId",
    /on: String\(c\.conv_id\) === String\(activeId\), press: String\(c\.conv_id\) === String\(pressedId\)/.test(mv));
  ok("行必须在 touchstart/mousedown 当场加按压态（不等 click）",
    /@touchstart\.passive="onRowPress\(c\.conv_id\)"/.test(mv) && /@mousedown="onRowPress\(c\.conv_id\)"/.test(mv));
  /* 关键：真机实测第二次点「按下→列表隐藏」只隔 0ms，玻璃一帧都没画。
   * 所以 openConv 必须先补足 PRESS_MS 再动 activeId，否则等于没改。 */
  ok("openConv 必须先补足 PRESS_MS 再切页（不然第二次点还是 0 帧）",
    /PRESS_MS/.test(mv) && /held < PRESS_MS/.test(mv) &&
    /await new Promise\(\(r\) => setTimeout\(r, PRESS_MS - held\)\)/.test(mv));
  ok("补时必须在 activeId 赋值之前（顺序错了白补）",
    (() => {
      const s = mv.indexOf("held < PRESS_MS");
      const a = mv.indexOf("activeId.value = String(id)", s > 0 ? s : 0);
      return s > 0 && a > s && s < a + 200;
    })());
  ok("按压态必须在抬手后自己清掉（不许粘成常亮选中）",
    /pressedId\.value = ""/.test(mv) && /setTimeout\(\(\) => \{ pressedId\.value = ""; \}, 900\)/.test(mv));
}
/* ── ㉑ 轮 424 · 全局按压反馈（小红书那种「一点就有反应」）──
 * 用户：「app 里面大多数的点击都没有效果，改成小红书那样，点击有轻微的反馈」。
 * 口径：反馈挂在 pointerdown（不等 click）、幅度极小、系统灰块关掉、
 * 聊天区/输入框不做（会晃、会打断手势）。 */
{
  ok("系统 tap-highlight 必须关掉（否则自绘反馈和系统灰块打架）",
    /\.shell,\s*\.shell \*\s*\{\s*-webkit-tap-highlight-color:\s*transparent/.test(glass));
  ok("按压态：透明度这一档必须存在", /\.wp-press\s*\{\s*opacity:\s*0?\.\d+/.test(glass));
  ok("按压态：缩放只允许写在 .wp-press.wp-scale 上（不许裸 .wp-scale 波及全员）",
    /\.wp-press\.wp-scale\s*\{[^}]*transform:\s*scale\(0?\.9\d+\)/.test(glass));
  ok("过渡只挂在 .wp-live 上（不长期占用元素自己的 transition）",
    /\.wp-live\s*\{[^}]*transition:\s*opacity/.test(glass));
  ok("夜间按压态要更深一点（深底上 0.66 看不出来）",
    /html\[data-theme="night"\] \.wp-press\s*\{[^}]*opacity:\s*0?\.\d+/.test(glass));
  ok("大卡片要单独轻一档（0.66 会把正文压到发虚）",
    /\.wp-press\.wp-big\s*\{[^}]*opacity:\s*0?\.8\d/.test(glass));
  ok("可点元素必须去 300ms 点击延迟", /touch-action:\s*manipulation/.test(glass));
}
{
  const js = read("src/utils/tapFeedback.js");
  ok("反馈必须挂在 pointerdown 上（不是 click）", /addEventListener\("pointerdown"/.test(js));
  ok("聊天区/输入框必须排除（整块缩放会像屏幕在抖）",
    /SKIP = "\.dm-thread, \.dm-vac/.test(js));
  ok("手指移动超过阈值要撤掉（滚动时不许乱闪）", /MOVE_TOLERANCE/.test(js));
  ok("快点点一下也要亮够时间（否则等于没有）", /MIN_HOLD/.test(js));
  ok("有 transform 的元素只做透明度（identity 矩阵例外，否则大多数卡片根本不会缩）",
    /const tf = getComputedStyle\(el\)\.transform/.test(js) && /matrix\(1, 0, 0, 1, 0, 0\)/.test(js));
  const app = read("src/App.vue");
  ok("App 必须装机（onMounted 里 installTapFeedback）",
    /installTapFeedback\(\)/.test(app) && /import \{ installTapFeedback \}/.test(app));
  ok("App 卸载必须解绑", /unTapFeedback\(\); unTapFeedback = null/.test(app));
}

/* ── ㉒ 轮 425：故事页「收藏」按钮点完必须还看得见 ──
 * 用户报「story 页点收藏，收藏直接隐藏了，看不到了」。
 * 真机实测：点下去后 color rgb(255,255,255) / bg rgba(255,255,255,0.6)
 * —— 白字白底，按钮等于消失。原因是 `--mark` 的白芯片底带 !important，
 * 把 `--on` 的 accent-deep 实心底压掉了。 */
{
  ok("白芯片底只准给未选中的 ghost 收藏钮（不许再压掉选中态）",
    /\.st-btn--ghost\.st-btn--mark:not\(\.st-btn--on\)\s*\{[^}]*background:\s*rgba\(255, 255, 255, 0\.6\)\s*!important/.test(glass));
  ok("不许存在裸的 `.st-btn--mark { background: ... !important }`（就是它吃掉选中态）",
    !/(^|\n)\.st-btn--mark\s*\{[^}]*background:[^}]*!important/.test(glass));
  ok("选中态必须底/边/字一起写死（只改 color 会白字白底）",
    /\.st-btn--ghost\.st-btn--mark\.st-btn--on\s*\{[^}]*background:\s*var\(--accent-deep\)\s*!important[^}]*color:\s*#fff\s*!important/.test(glass));
  /* 选中态的文字色绝不能等于它自己的底色 —— 这是这条 bug 的唯一形态，值得直接钉 */
  const m = glass.match(/\.st-btn--ghost\.st-btn--mark\.st-btn--on\s*\{[^}]*\}/);
  const onRule = m ? m[0] : "";
  ok("选中态不许出现「白字 + 白底」", !(/color:\s*#fff/.test(onRule) && /background:\s*rgba\(255, 255, 255/.test(onRule)));
  ok("夜间收藏选中态要翻深字（--accent-deep 是淡蓝，白字对比只有 1.9:1）",
    /html\[data-theme="night"\] \.st-btn--ghost\.st-btn--mark\.st-btn--on\s*\{[^}]*color:\s*#1b1c24/.test(glass));
  ok("夜间点赞按钮同样翻深字", /html\[data-theme="night"\] \.st-btn--on\s*\{[^}]*color:\s*#1b1c24/.test(glass));
}

console.log(`TOTAL ${pass + fails.length} PASS ${pass} FAIL ${fails.length}`);
for (const f of fails) console.log("FAIL  " + f);
if (fails.length) process.exit(1);
