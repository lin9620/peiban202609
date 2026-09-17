/* 第 1 条行为回归：Node 模拟 Canvas，不替代浏览器像素/视觉验收。
 * 运行：node tools/food-painter-test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { ref, computed } from "vue";
import { cookbook, addDish, pruneCookbook, DISH_MAX, DISH_TTL_MS } from "../src/stores/petStore.js";

const source = fs.readFileSync(new URL("../src/components/FoodPainter.vue", import.meta.url), "utf8");
const script = source.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import .*;\s*$/gm, "");
const calls = [], images = [], dishes = [], events = [];
const context = {
  globalCompositeOperation: "destination-out",
  fillRect(...args) { calls.push(["fill", this.globalCompositeOperation, ...args]); },
  drawImage() { calls.push(["draw"]); },
  save() {}, restore() {}, setLineDash() {},
};
const canvas = { toDataURL: () => "data:image/png;base64,test" };
const sandbox = vm.createContext({
  ref, computed, onMounted() {}, t: (k) => k,
  addDish: (dish) => dishes.push(dish),
  defineEmits: () => (...args) => events.push(args),
  setTimeout() {},
  Image: class { constructor() { images.push(this); } },
  document: { createElement: () => ({ getContext: () => context, toDataURL: () => "saved-jpeg" }) },
});
vm.runInContext(script + '\nthis.api = {canvas, ctx, tool, template, name, strokes, colorsUsed, lengthPx, undoStack, save, undo};', sandbox);
const p = sandbox.api;
p.canvas.value = canvas;
p.ctx.value = context;
p.template.value = "fish";
p.tool.value = "eraser";
p.name.value = "小鱼干";
p.strokes.value = 4;
p.colorsUsed.value.add("orange");
p.lengthPx.value = 500;
p.undoStack.value.push("old-image");
p.undo(); // 暂不触发 onload，模拟加载中的撤销
p.save();
assert.equal(dishes.length, 1);
assert.equal(dishes[0].name, "小鱼干");
assert.equal(dishes[0].img, "saved-jpeg");
assert.equal(events[0][0], "saved");
assert.equal(p.tool.value, "brush");
assert.equal(p.template.value, "free");
assert.equal(p.name.value, "");
assert.equal(p.strokes.value, 0);
assert.equal(p.colorsUsed.value.size, 0);
assert.equal(p.lengthPx.value, 0);
assert.equal(p.undoStack.value.length, 0);
assert.deepEqual(calls.at(-1), ["fill", "source-over", 0, 0, 640, 480]);
const before = calls.length;
images[0].onload();
p.undo();
assert.equal(calls.length, before, "保存后的旧撤销不能恢复旧画面");

// 实际 store 行为；Node 使用内存存储，不访问线上、不改浏览器数据。
const originalNow = Date.now;
const now = 1800000000000;
try {
  Date.now = () => now;
  cookbook.splice(0);
  assert.equal(DISH_MAX, 7);
  assert.equal(DISH_TTL_MS, 48 * 3600 * 1000);
  for (let id = 0; id < 8; id++) addDish({ id, name: "test", createdAt: now });
  assert.deepEqual(cookbook.map((d) => d.id), [7, 6, 5, 4, 3, 2, 1]);
  assert.ok(cookbook.every((d) => d.expiresAt === now + DISH_TTL_MS));
  Date.now = () => now + DISH_TTL_MS - 1;
  assert.equal(pruneCookbook(), 0);
  Date.now = () => now + DISH_TTL_MS;
  assert.equal(pruneCookbook(), 7);
  assert.equal(cookbook.length, 0);
} finally {
  Date.now = originalNow;
  cookbook.splice(0);
}
console.log("food-painter-test: PASS (保存重置、橡皮模式、异步撤销、7份上限、48小时过期边界)");
