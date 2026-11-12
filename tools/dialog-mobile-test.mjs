/* 手机端确认弹窗（Naive UI dialog，≤640）回归测试
 * ------------------------------------------------------------
 * 这些弹窗是 teleport 到 body 的，组件 scoped 样式够不到，统一在 style.css 收口。
 * 这里钉住：只改 ≤640、居中卡片、顶部图标、48px 竖排按钮、关闭钮 38px 触控区，
 * 以及桌面端仍然走 Naive UI 默认布局。
 * 运行：node tools/dialog-mobile-test.mjs
 */
import fs from "node:fs";

let pass = 0;
const fails = [];
function ok(name, cond, extra = "") {
  if (cond) pass++;
  else fails.push(name + (extra ? ` — ${extra}` : ""));
}
const src = fs.readFileSync("src/style.css", "utf8");
const marker = "轮 511 · 手机端确认弹窗";
const start = src.indexOf(marker);
const block = start >= 0 ? src.slice(start) : "";

ok("T1 只在 ≤640 生效，弹窗卡片居中且接近满宽",
  block.includes("@media (max-width: 640px) {")
  && block.includes("width: calc(100vw - 40px) !important")
  && block.includes("max-width: 358px !important")
  && block.includes("border-radius: 26px !important"));
ok("T2 顶部图标、标题居中、正文左对齐",
  block.includes("flex-direction: column;")
  && block.includes("font-size: 20px;")
  && block.includes("text-align: center;")
  && block.includes("text-align: left;"));
ok("T3 图标是 42px 暖色圆形徽章",
  block.includes("width: 42px;")
  && block.includes("height: 42px;")
  && block.includes("background: var(--accent-soft);")
  && block.includes("color: var(--accent-deep) !important;"));
ok("T4 正文 14.5px / 1.66，长译文可滚动",
  block.includes("font-size: 14.5px;")
  && block.includes("line-height: 1.66;")
  && block.includes("max-height: calc(100dvh - 40px);")
  && block.includes("overflow-y: auto;"));
ok("T5 按钮竖排、间距 10px、48px 触控高度",
  block.includes("flex-direction: column !important;")
  && block.includes("gap: 10px;")
  && block.includes("height: 48px !important;")
  && block.includes("min-height: 48px !important;")
  && block.includes("width: 100% !important;"));
ok("T6 取消是软底描边，确定是暖色渐变",
  block.includes(".n-button--ghost {")
  && block.includes("background: var(--wash-mid) !important;")
  && block.includes("linear-gradient(135deg, var(--accent) 0%, var(--accent-deep) 100%) !important"));
ok("T7 关闭钮 38px 触控区、20px 图标",
  block.includes("--n-close-size: 38px !important;")
  && block.includes("--n-close-icon-size: 20px !important;")
  && block.includes("top: 8px !important;")
  && block.includes("right: 8px !important;"));
ok("T8 桌面不受影响：样式全部在 640 媒体查询内",
  block.indexOf("@media (max-width: 640px) {") >= 0
  && block.indexOf("@media (max-width: 640px) {") < block.indexOf("html body .n-modal-container .n-dialog {"));

if (fails.length) {
  console.error(`dialog-mobile-test: ${pass} pass, ${fails.length} fail`);
  for (const f of fails) console.error("FAIL  " + f);
  process.exit(1);
}
console.log(`dialog-mobile-test: ${pass} pass, 0 fail`);
