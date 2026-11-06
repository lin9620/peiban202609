/* 生成「故事页收藏按钮」对照 harness（修复前 / 修复后）
 * 为什么用 harness 而不是真机截图：真机截图是物理屏幕，用户正在用手机时截到的是他手里的画面
 * （轮 425 踩过：截出来是相册/聊天）；而这里的 bug 是纯 CSS 特异性问题，用同一份真实产物 CSS
 * 渲染同一段按钮 markup，就是最直接的复现证据。
 */
import fs from "node:fs";

const BODY = (glass) => `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="main.css">
<link rel="stylesheet" href="${glass}">
<style>
  html, body { margin: 0; background: #faf9f5; font-family: "Microsoft YaHei", sans-serif; }
  .wrap { width: 393px; padding: 20px 18px; box-sizing: border-box; }
  .lab { font-size: 12.5px; color: #8b7b6f; margin: 18px 0 6px; }
  .st-read-foot { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding-top: 12px; border-top: 1px solid rgba(120,102,88,.12); }
  .st-hint { font-size: 12px; color: #a08d80; }
</style></head><body><div class="wrap">
  <p class="lab">① 还没收藏</p>
  <div class="st-read-foot">
    <button class="st-btn st-btn--ghost">♥ 点赞 12</button>
    <button class="st-btn st-btn--ghost st-btn--mark">★ 收藏</button>
    <span class="st-hint">12 赞 · 4 次阅读</span>
  </div>
  <p class="lab">② 点过收藏（marked = true）</p>
  <div class="st-read-foot">
    <button class="st-btn st-btn--ghost st-btn--on">♥ 已赞 13</button>
    <button class="st-btn st-btn--ghost st-btn--mark st-btn--on">★ 已收藏</button>
    <span class="st-hint">13 赞 · 4 次阅读</span>
  </div>
</div></body></html>`;

fs.writeFileSync(".probe10/h-before.html", BODY("old-glass.css"));
fs.writeFileSync(".probe10/h-after.html", BODY("new-glass.css"));
console.log("harness ok");
