/* 宠物主页（/u/:id）纯逻辑单测（Node 直跑，无需浏览器/网络）
 *   node tools/pet-home-test.mjs
 * 覆盖：手绘厨房清洗、公开快照白名单（私人数据不上云）、防抖队列的安全性
 */
import assert from "node:assert/strict";
import { cleanDishes, petHomeSnapshot, PET_HOME_DISH_LIMIT, queuePetHomeSync } from "../src/utils/wall.js";

const out = [];
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; out.push("PASS  " + name); }
  catch (e) { fail++; out.push("FAIL  " + name + "  → " + e.message); }
}
const img = (n) => "data:image/jpeg;base64,DISH" + n;

/* ═════════ cleanDishes：手绘厨房进快照前的清洗 ══════════ */

t("T1 非数组 / 脏输入安全返回空数组", () => {
  assert.deepEqual(cleanDishes(null), []);
  assert.deepEqual(cleanDishes("x"), []);
  assert.deepEqual(cleanDishes([null, 1, "a", {}]), [], "非对象条目全部跳过");
});

t("T2 只收 data:image 开头的图；其它一律丢弃（不让垃圾字符串上云）", () => {
  const r = cleanDishes([
    { id: "a", name: "A", img: "data:image/png;base64,OK" },
    { id: "b", name: "B", img: "https://example.com/x.jpg" },
    { id: "c", name: "C", img: "" },
    { id: "d", name: "D" },
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].id, "a");
});

t("T3 超长图直接跳过（异常 dataURL 不拖垮整个快照）", () => {
  const big = { id: "big", name: "Big", img: "data:image/jpeg;base64," + "x".repeat(200001) };
  const okDish = { id: "ok", name: "Ok", img: img("ok") };
  assert.deepEqual(cleanDishes([big, okDish]).map((d) => d.id), ["ok"]);
});

t("T4 截断到上限（" + PET_HOME_DISH_LIMIT + " 道），字段清洗：截长 + effort 数字化", () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ id: "d" + i, name: "菜" + i, img: img(i), effort: String(i) }));
  const r = cleanDishes(many);
  assert.equal(r.length, PET_HOME_DISH_LIMIT);
  assert.equal(r[0].effort, 0, "字符串 effort 转数字");
  const messy = [{ id: 123456789012345678901234567890123, name: "x".repeat(99), img: img("m"), effort: -5 }];
  const m = cleanDishes(messy);
  assert.ok(m[0].id.length <= 40 && m[0].name.length <= 30, "id/name 截断");
  assert.equal(m[0].effort, 0, "负数 effort 归 0");
});

/* ═════════ petHomeSnapshot：公开快照白名单 ══════════ */

t("T5 空 / 非对象 pet → null（没有宠物就没有快照）", () => {
  assert.equal(petHomeSnapshot(null, []), null);
  assert.equal(petHomeSnapshot("cat", []), null);
});

t("T6 白名单字段：私人数据（金币/亲密度/心情）绝不进快照", () => {
  const pet = {
    species: "cat", name: "麻薯", personality: "粘人", level: 7, sleeping: false,
    coins: 9999, bond: 88, mood: "happy", hunger: 10, lastTick: 123, /* 私人字段 */
  };
  const s = petHomeSnapshot(pet, [], 1700000000000);
  assert.deepEqual(Object.keys(s.pet).sort(), ["custom", "level", "name", "personality", "sleeping", "species"],
    "pet 只许这 6 个键");
  assert.equal(s.pet.level, 7);
  assert.equal(s.pet.custom, null);
  assert.equal(s.updated, 1700000000000);
  assert.equal(s.dishes.length, 0);
});

t("T7 字段兜底：缺 species → cat；缺 level → 1；sleeping 布尔化；超长截断", () => {
  const s = petHomeSnapshot({ name: "x".repeat(99), sleeping: "yes" }, []);
  assert.equal(s.pet.species, "cat");
  assert.equal(s.pet.level, 1);
  assert.equal(s.pet.sleeping, false, "非布尔 sleeping → false");
  assert.ok(s.pet.name.length <= 30);
});

t("T8 自定义立绘只带 img（不带其它杂项）；非字符串 img → null", () => {
  const withCustom = petHomeSnapshot({ custom: { img: "data:image/png;base64,ME", junk: 1 } }, []);
  assert.deepEqual(withCustom.pet.custom, { img: "data:image/png;base64,ME" });
  assert.equal(petHomeSnapshot({ custom: { img: 42 } }, []).pet.custom, null);
});

t("T9 dishes 走 cleanDishes（同一套清洗），坏菜不进快照", () => {
  const s = petHomeSnapshot(
    { species: "cat", name: "麻薯" },
    [{ id: "a", name: "小鱼干", img: img("a"), effort: 2 }, { id: "b", name: "坏菜", img: "http://nope" }],
  );
  assert.equal(s.dishes.length, 1);
  assert.equal(s.dishes[0].name, "小鱼干");
});

/* ═════════ queuePetHomeSync：防抖队列安全性 ══════════ */

t("T10 非函数参数被忽略（不抛错）", () => {
  assert.doesNotThrow(() => queuePetHomeSync(123));
  assert.doesNotThrow(() => queuePetHomeSync(null));
  assert.doesNotThrow(() => queuePetHomeSync(() => ({ pet: null }), 100), "登记合法工厂也不抛");
});

/* 到点路径：Node 里无云端配置（canUseWall=false）→ 100ms 后应静默跳过而不是炸 */
queuePetHomeSync(() => ({ pet: { species: "cat", name: "麻薯" }, dishes: [] }), 100);
await new Promise((r) => setTimeout(r, 650));

console.log(out.join("\n"));
console.log(`\nTOTAL ${pass + fail}  PASS ${pass}  FAIL ${fail}`);
process.exit(fail ? 1 : 0);