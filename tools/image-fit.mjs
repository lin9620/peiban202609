/* 图片处理纯函数单元测试（Node 直跑：node tools/image-fit.mjs） */
import assert from "node:assert/strict";
import {
  fitSize, isSaneShape, validateImageFile, isUsableDataUrl,
  MAX_EDGE, MAX_FILE_BYTES, MAX_PET_EDGE,
} from "../src/utils/imaging.js";

const out = [];
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; out.push("PASS  " + name); }
  catch (e) { fail++; out.push("FAIL  " + name + "  → " + e.message); }
}

t("T1 横图 1800x1200 → 900x600", () => {
  assert.deepEqual(fitSize(1800, 1200), { width: 900, height: 600 });
});
t("T2 竖图 1200x1800 → 600x900（长边按高约束）", () => {
  assert.deepEqual(fitSize(1200, 1800), { width: 600, height: 900 });
});
t("T3 小图 800x600 不放大", () => {
  assert.deepEqual(fitSize(800, 600), { width: 800, height: 600 });
});
t("T4 极窄长条 1x10000 → 1x900（短边钳到 1 不产生 0）", () => {
  const r = fitSize(1, 10000);
  assert.equal(r.width, 1);
  assert.equal(r.height, 900);
});
t("T5 非法尺寸返回 null（0/负数/NaN）", () => {
  assert.equal(fitSize(0, 100), null);
  assert.equal(fitSize(100, -5), null);
  assert.equal(fitSize(NaN, NaN), null);
});
t("T6 比例体检：恰好 12:1 通过", () => {
  assert.equal(isSaneShape(1200, 100), true);
});
t("T7 比例体检：13:1 拒绝", () => {
  assert.equal(isSaneShape(1300, 100), false);
});
t("T8 像素体检：36MP 拒绝 / 25MP 通过", () => {
  assert.equal(isSaneShape(6000, 6000), false);
  assert.equal(isSaneShape(5000, 5000), true);
});
t("T9 0 尺寸体检拒绝", () => {
  assert.equal(isSaneShape(0, 100), false);
});
t("T10 文件预检：超过 5MB 拒绝 too-large", () => {
  const f = { type: "image/png", size: MAX_FILE_BYTES + 1 };
  assert.deepEqual(validateImageFile(f), { ok: false, reason: "too-large" });
});
t("T11 文件预检：非图片类型拒绝 not-image", () => {
  const f = { type: "application/pdf", size: 100 };
  assert.equal(validateImageFile(f).ok, false);
  assert.equal(validateImageFile(f).reason, "not-image");
});
t("T12 文件预检：正常图片通过", () => {
  assert.deepEqual(validateImageFile({ type: "image/jpeg", size: 1024 }), { ok: true, reason: "" });
});
t("T13 文件预检：null 拒绝", () => {
  assert.equal(validateImageFile(null).ok, false);
});
t("T14 isUsableDataUrl：拦截空产物 data:,", () => {
  assert.equal(isUsableDataUrl("data:,"), false);
  assert.equal(isUsableDataUrl(""), false);
  assert.equal(isUsableDataUrl(null), false);
});
t("T15 isUsableDataUrl：合法 jpeg/png 通过", () => {
  assert.equal(isUsableDataUrl("data:image/jpeg;base64," + "A".repeat(200)), true);
  assert.equal(isUsableDataUrl("data:image/png;base64," + "B".repeat(200)), true);
});
t("T16 isUsableDataUrl：非图片 mime 拒绝", () => {
  assert.equal(isUsableDataUrl("data:text/html;base64," + "A".repeat(200)), false);
});
t("T17 过短 dataURL 视为不可用", () => {
  assert.equal(isUsableDataUrl("data:image/jpeg;base64,AAAA"), false);
});
t("T18 常量约定：MAX_EDGE=900", () => {
t("T19 立绘上限：MAX_PET_EDGE=480 且比社区图更小", () => {
  assert.equal(MAX_PET_EDGE, 480);
  assert.ok(MAX_PET_EDGE < MAX_EDGE);
});
t("T20 fitSize 支持自定义最长边（立绘 1600x1200 → 480x360）", () => {
  assert.deepEqual(fitSize(1600, 1200, MAX_PET_EDGE), { width: 480, height: 360 });
});
  assert.equal(MAX_EDGE, 900);
});

out.push("");
out.push("TOTAL " + (pass + fail) + "  PASS " + pass + "  FAIL " + fail);
console.log(out.join("\n"));
process.exit(fail ? 1 : 0);
