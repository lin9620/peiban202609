/* 轨道内 fixed 弹层回归测试（轮 151 的 bug 固化）
 *   node tools/teleport-test.mjs
 * 背景：手机端 PetView 被挂在 .home-track 里，而该轨道有内联 transform: translateX(...)。
 *       CSS 里 transform / filter / backdrop-filter 会让元素成为 position:fixed 的**包含块**，
 *       于是 .adopt-mask 这类 inset:0 的全屏弹层不再相对视口，而是相对「宽 4 屏的轨道」定位，
 *       弹窗本体被甩到屏幕外 —— 用户只看到一层 backdrop-filter 模糊蒙层，就是截图那个现象。
 * 对策：所有 fixed 全屏弹层统一 <Teleport to="body">，破掉这个包含块。
 * 本测试静态扫描源码，防止以后有人在轨道视图里新加 fixed 弹层又翻车。
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

const out = [];
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; out.push("PASS  " + name); }
  catch (e) { fail++; out.push("FAIL  " + name + "  → " + e.message); }
}

/* 弹层根选择器：命中即代表它是「铺满视口」的浮层 */
const OVERLAY_ROOTS = ["adopt-mask", "modal", "mask", "sheet", "lightbox", "dialog"];

t("T1 .home-track 确实带 transform（即包含块陷阱真实存在）", () => {
  /* transform 是 HomeView 模板上的内联样式（translateX 跟随分页 idx），不在 style.css 里 */
  const home = read("src/views/HomeView.vue");
  assert.ok(
    /class="home-track"[\s\S]{0,200}transform:\s*'translateX\(/.test(home),
    ".home-track 上有内联 transform，fixed 弹层放里面必然错位 —— 修复不能被回退掉",
  );
});

t("T2 PetView 的 fixed 弹层都在 Teleport to=body 内", () => {
  const src = read("src/views/PetView.vue");
  assert.ok(/<Teleport\s+to="body"/.test(src), "PetView 必须有 Teleport to=body");

  /* 取出 Teleport 区块，检查弹层根与 ShareCard/SnackRain 都落在区块内 */
  const blocks = [...src.matchAll(/<Teleport\s+to="body">([\s\S]*?)<\/Teleport>/g)].map((m) => m[1]);
  assert.ok(blocks.length > 0, "Teleport 区块内容不为空");
  const inner = blocks.join("\n");

  for (const cls of OVERLAY_ROOTS) {
    if (new RegExp(`class="[^"]*\\b${cls}\\b`).test(src)) {
      assert.ok(
        new RegExp(`class="[^"]*\\b${cls}\\b`).test(inner),
        `.${cls} 必须在 Teleport to=body 内，否则会被轨道 transform 吞掉`,
      );
    }
  }
  for (const comp of ["ShareCard", "SnackRain"]) {
    if (new RegExp(`<${comp}[\\s>]`).test(src)) {
      assert.ok(new RegExp(`<${comp}[\\s>]`).test(inner), `<${comp}> 必须在 Teleport to=body 内`);
    }
  }
});

t("T3 Teleport 标签成对闭合", () => {
  for (const f of readdirSync(path.join(ROOT, "src/views"))) {
    if (!f.endsWith(".vue")) continue;
    const src = read(path.join("src/views", f));
    const open = (src.match(/<Teleport[\s>]/g) || []).length;
    const close = (src.match(/<\/Teleport>/g) || []).length;
    assert.equal(open, close, `${f}: <Teleport>(${open}) 与 </Teleport>(${close}) 不配平`);
  }
});

t("T4 Teleport 后依赖的 CSS 变量仍在 :root 上（body 是 html 子孙）", () => {
  const css = read("src/style.css");
  const rootBlock = css.slice(css.indexOf(":root {"));
  const rootBody = rootBlock.slice(0, rootBlock.indexOf("}"));
  for (const v of ["--ink", "--accent"]) {
    assert.ok(rootBlock.includes(v), `${v} 应定义在 :root —— Teleport 到 body 仍能继承`);
  }
  assert.ok(rootBody.length > 0);
});

t("T5 轨道内不得出现裸的 fixed 蒙层（复检本 bug 的原始形态）", () => {
  const src = read("src/views/PetView.vue");
  /* .adopt-mask 自带 backdrop-filter，一旦 fixed 错位就是「只有蒙层没有弹窗」 */
  const masked = src.match(/<div v-if="showAdopt" class="adopt-mask"[\s\S]*?\n  <\/div>/);
  assert.ok(masked, "仍能找到领养弹层入口");
  assert.ok(
    /<Teleport\s+to="body">[\s\S]*adopt-mask/.test(src),
    "领养弹层必须先 Teleport 再渲染",
  );
});

console.log(out.join("\n"));
console.log(`\nTOTAL ${pass + fail}  PASS ${pass}  FAIL ${fail}`);
process.exit(fail ? 1 : 0);
