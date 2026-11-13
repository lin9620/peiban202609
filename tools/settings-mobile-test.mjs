/* 设置页手机端重设计（≤640）回归测试
 * ------------------------------------------------------------
 * 桌面端复用同一套 .set-* 结构，任何手机端样式都必须待在 640 断点里，
 * 不能改到桌面：这里同时锁定「断点范围」「身份卡盖过 glass.css 的 !important」
 * 「游客态整宽按钮」「44px+ 触控尺寸」和「主题/语言两列网格」。
 * 运行：node tools/settings-mobile-test.mjs
 */
import fs from "node:fs";

let pass = 0;
const fails = [];
function ok(name, cond, extra = "") {
  if (cond) pass++;
  else fails.push(name + (extra ? ` — ${extra}` : ""));
}
const read = (p) => fs.readFileSync(p, "utf8");
const src = read("src/views/SettingsView.vue");
const start = src.indexOf("@media (max-width: 640px)");
const end = src.indexOf("@media (max-width: 360px)");
const mobile = start >= 0 && end > start ? src.slice(start, end) : "";

ok("T1 手机端断点 640 存在，桌面 ≥900 铺满规则未动",
  start >= 0 && src.includes("@media (min-width: 900px) { .set-page { max-width: none; } }"));
ok("T2 身份卡用暖色渐变并 !important 盖过 glass.css 的白卡背景",
  mobile.includes(".set-user {")
  && /background:\s*\n?\s*linear-gradient\([^;]+!important/.test(mobile)
  && mobile.includes("border-radius: 24px !important"));
ok("T3 游客态绑定 class，按钮整宽换到第二行",
  src.includes("'set-user--guest': !cloudSigned")
  && mobile.includes(".set-user--guest { flex-wrap: wrap; }")
  && mobile.includes(".set-user--guest .set-go { flex: 0 0 100%; width: 100%; margin-top: 4px; }"));
ok("T4 行高 56px、发丝分隔线与放大的开关",
  mobile.includes("min-height: 56px")
  && mobile.includes(".set-row + .set-row::before")
  && mobile.includes(".set-switch { width: 46px; height: 26px; }")
  && mobile.includes(".set-switch.sm { width: 42px; height: 24px; }"));
ok("T5 主题/语言两列网格，语言最后一项独占整行",
  mobile.includes("grid-template-columns: repeat(2, minmax(0, 1fr))")
  && mobile.includes(".set-group > .set-opts > .set-opt:last-of-type:nth-child(odd)"));
ok("T6 展开面板去掉左缩进，输入框/按钮 44px 触控高度",
  mobile.includes(".set-panel { padding: 2px 14px 14px;")
  && mobile.includes(":deep(.van-field)")
  && mobile.includes("min-height: 44px"));
ok("T7 语言偏好开关不再被文字挤扁",
  mobile.includes(".lang-pref :deep(.van-switch) { flex: 0 0 auto; }"));
ok("T8 手机端不出现底部抽屉式 flex-end",
  !mobile.includes("flex-end"));

/* 轮 527 · 用户截图：暖奶油主题下「皮肤」托盘是一圈樱粉，跟陶土主色对不上。
 * 病根在 glass.css 的 :root 把 --accent-soft 写死成樱粉 —— 四套彩色主题各自覆盖了它，
 * 唯独默认的暖奶油没有，于是全站 127 处 accent-soft 表面全变粉。
 * 这里锁两件事：① 它必须跟主色同族（暖色：R>G>B）；② 身份卡渐变不许再借
 * --accent-deep —— 夜间主题为「字压在深底上读得出来」把它改成了浅陶土，
 * 借来做渐变第二档会让星夜蓝卡片从蓝渐变到陶土（日落色）。 */
const glass = read("src/glass.css");
const softM = glass.match(/--accent-soft:\s*rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
ok("T9 glass 皮肤的 --accent-soft 缺席或不是暖色（会被写死的樱粉带回去）",
  !!softM && +softM[1] > +softM[2] && +softM[2] > +softM[3],
  softM ? `实测 rgb(${softM[1]},${softM[2]},${softM[3]})` : "glass.css 里找不到 --accent-soft");
ok("T10 身份卡渐变不吃 --accent-deep（夜间那是给字色用的浅陶土）",
  !/linear-gradient\(135deg, var\(--accent\) 0%, var\(--accent-deep\) 100%\)/.test(mobile));

if (fails.length) {
  console.error(`settings-mobile-test: ${pass} pass, ${fails.length} fail`);
  for (const f of fails) console.error("FAIL  " + f);
  process.exit(1);
}
console.log(`settings-mobile-test: ${pass} pass, 0 fail`);
