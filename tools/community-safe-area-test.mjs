/* 轮 357 · 暖心墙顶部安全区锁（Node 直跑，只读源码）
 *   node tools/community-safe-area-test.mjs
 *
 * 用户实报：App 里暖心墙顶部状态栏区域是一块空白，搜索栏被顶到状态栏下面，
 * 只露出下面的「推荐」排序行（截图红框圈住状态栏）。
 *
 * 根因：CommunityView 手机端的 .wall-scroller 是 position: fixed; inset: 0，
 * 它不继承 App 壳 main 的 padding-top；而这里原先只写了 env(safe-area-inset-top)，
 * Capacitor WebView 里这个 env() 常为 0（MainActivity 推的是 --sat），
 * 于是 fixed 滚动层从窗口最顶上开始，搜索栏正好压在状态栏下面。
 *
 * 这个锁要求：手机端 fixed 滚动层必须和 main 同口径使用 --sat / --sab，
 * 且不能再退回裸 env()。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(root, "src/views/CommunityView.vue"), "utf8");
let pass = 0, fail = 0; const out = [];
function t(name, fn) {
  try { fn(); pass++; out.push("ok   " + name); }
  catch (e) { fail++; out.push("FAIL " + name + " :: " + e.message); }
}

/* 只取手机端那个 :style 对象，避免误伤桌面分支 */
const mobileStyle = src.match(/:style="isMobileNav\s*\?\s*\{([\s\S]*?)\}\s*:\s*\{/);
t("S1 能找到暖心墙手机端 fixed 滚动层的 style 对象", () => {
  assert.ok(mobileStyle, "没找到 :style=\"isMobileNav ? { ... } : { ... }\"");
});

t("S2 顶部使用 --sat（App 壳推的真实状态栏高度），不是裸 env()", () => {
  assert.ok(mobileStyle, "style 对象缺失");
  const block = mobileStyle[1];
  assert.match(block, /paddingTop:\s*'var\(--sat,\s*env\(safe-area-inset-top,\s*0px\)\)'/,
    "paddingTop 没有用 var(--sat, env(safe-area-inset-top, 0px))");
  assert.doesNotMatch(block, /paddingTop:\s*'env\(safe-area-inset-top\)'/,
    "paddingTop 退回了裸 env(safe-area-inset-top)");
});

t("S3 底部也使用 --sab，和 main / TabBar 同口径", () => {
  assert.ok(mobileStyle, "style 对象缺失");
  const block = mobileStyle[1];
  assert.match(block, /paddingBottom:\s*'calc\(70px \+ var\(--sab,\s*env\(safe-area-inset-bottom,\s*0px\)\)\)'/,
    "paddingBottom 没有用 calc(70px + var(--sab, env(safe-area-inset-bottom, 0px)))");
});

t("S4 保留 fixed 全屏滚动层（不能为了安全区把它改成普通文档流）", () => {
  assert.ok(mobileStyle, "style 对象缺失");
  const block = mobileStyle[1];
  assert.match(block, /position:\s*'fixed'/, "position 不是 fixed");
  assert.match(block, /inset:\s*0/, "inset 不是 0");
  assert.match(block, /overflowY:\s*'auto'/, "overflowY 不是 auto");
});

console.log(out.join("\n"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
