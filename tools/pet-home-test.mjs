/* 宠物主页（/u/:id）纯逻辑单测（Node 直跑，无需浏览器/网络）
 *   node tools/pet-home-test.mjs
 * 覆盖：手绘厨房清洗、公开快照白名单（私人数据不上云）、互动计数独立列、
 *       图片引用外置（dataURL / Storage 路径）与行体积安全阀、防抖队列的安全性
 */
import assert from "node:assert/strict";
import {
  cleanDishes, petHomeSnapshot, petCounts, isImageRef, imgRefHash, parseImageDataUrl,
  resolvePetImg, shrinkPetPayload, PET_HOME_DISH_LIMIT, PET_IMG_PATH_MAX, queuePetHomeSync,
} from "../src/utils/wall.js";

const out = [];
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; out.push("PASS  " + name); }
  catch (e) { fail++; out.push("FAIL  " + name + "  → " + e.message); }
}
/* 合法 dataURL：isUsableDataUrl 要求真图那样的长度（>128）；base64 段必须是 4 的倍数（否则 atob 抛，属脏数据） */
const IMG_B64 = "A".repeat(140);
const b64 = (n) => (String(n) + "A".repeat(144)).slice(0, 144);
const img = (n) => `data:image/jpeg;base64,${b64(n)}`;
const PNG = `data:image/png;base64,${IMG_B64}`;

/* ═════════ cleanDishes：手绘厨房进快照前的清洗 ══════════ */

t("T1 非数组 / 脏输入安全返回空数组", () => {
  assert.deepEqual(cleanDishes(null), []);
  assert.deepEqual(cleanDishes("x"), []);
  assert.deepEqual(cleanDishes([null, 1, "a", {}]), [], "非对象条目全部跳过");
});

t("T2 只收合法图片引用：外部 URL / 空串 / 垃圾串一律丢弃（不让垃圾字符串上云）", () => {
  const r = cleanDishes([
    { id: "a", name: "A", img: img("a") },
    { id: "b", name: "B", img: "https://example.com/x.jpg" },
    { id: "c", name: "C", img: "" },
    { id: "d", name: "D" },
    { id: "e", name: "E", img: "not-an-image" },
    { id: "f", name: "F", img: "data:,x" },
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

t("T8 自定义立绘：只带 img；非法/超长引用 → null，已外置的路径照样认", () => {
  const withCustom = petHomeSnapshot({ custom: { img: PNG, junk: 1 } }, []);
  assert.deepEqual(withCustom.pet.custom, { img: PNG });
  assert.equal(petHomeSnapshot({ custom: { img: 42 } }, []).pet.custom, null);
  /* 上限：一张超长 dataURL 不该把整个快照拖爆 */
  const huge = "data:image/png;base64," + "A".repeat(200001);
  assert.equal(petHomeSnapshot({ custom: { img: huge } }, []).pet.custom, null);
  /* 幂等：已经外置成 Storage 路径的立绘，重复同步不会把它弄丢 */
  assert.deepEqual(
    petHomeSnapshot({ custom: { img: "u1/pet-abc12345.png" } }, []).pet.custom,
    { img: "u1/pet-abc12345.png" },
  );
});

t("T9 dishes 走 cleanDishes（同一套清洗），坏菜不进快照", () => {
  const s = petHomeSnapshot(
    { species: "cat", name: "麻薯" },
    [{ id: "a", name: "小鱼干", img: img("a"), effort: 2 }, { id: "b", name: "坏菜", img: "http://nope" }],
  );
  assert.equal(s.dishes.length, 1);
  assert.equal(s.dishes[0].name, "小鱼干");
});


/* ═════════ 互动计数：必须是独立列 pats/feeds（data 会被主人同步整体覆盖） ═════════ */

t("T10 快照顶层只有 pet/dishes/updated —— 计数绝不进 data（否则同步时会清零）", () => {
  const s = petHomeSnapshot({ species: "cat", name: "麻薯" }, [], 1700000000000);
  assert.deepEqual(Object.keys(s).sort(), ["dishes", "pet", "updated"], "顶层只许这 3 个键");
  assert.equal(s.counts, undefined, "快照里不许出现 counts");
});

t("T11 计数从独立列读：{pats,feeds} 直接映射（数字/字符串都吃）", () => {
  assert.deepEqual(petCounts({ pats: 3, feeds: 5 }), { pats: 3, feeds: 5 });
  assert.deepEqual(petCounts({ pats: "7" }), { pats: 7, feeds: 0 }, "字符串数字化，缺的补 0");
});

t("T12 行缺失 / 脏值 → 全 0（负数、NaN、对象都不许漏成 NaN）", () => {
  assert.deepEqual(petCounts(null), { pats: 0, feeds: 0 });
  assert.deepEqual(petCounts(undefined), { pats: 0, feeds: 0 });
  assert.deepEqual(petCounts("x"), { pats: 0, feeds: 0 });
  assert.deepEqual(petCounts({ pats: -9, feeds: Number.NaN }), { pats: 0, feeds: 0 });
  assert.deepEqual(petCounts({ pats: {} }), { pats: 0, feeds: 0 });
});

/* ═════════ queuePetHomeSync：防抖队列安全性 ══════════ */
/* ═════════ 图片外置：dataURL → Storage 路径（行里只留短引用，实体在桶里） ══════════ */

t("T14 isImageRef：dataURL 与 Storage 路径合法；外部 URL / 伪路径一律拒", () => {
  assert.equal(isImageRef(img("x")), true, "合法 dataURL");
  assert.equal(isImageRef(PNG), true, "合法 png dataURL");
  assert.equal(isImageRef("u1/pet-abc12345.jpg"), true, "Storage 路径（<uid>/文件）");
  assert.equal(isImageRef("https://cdn.example.com/a.jpg"), false, "外部 URL 不收");
  assert.equal(isImageRef("u1/../secret.jpg"), false, "目录穿越拒掉");
  assert.equal(isImageRef("u1/sub/x.jpg"), false, "只允许两段（与 storage 策略前缀一致）");
  assert.equal(isImageRef("u1/pet a.jpg"), false, "含空白拒掉");
  assert.equal(isImageRef(""), false);
  assert.equal(isImageRef(null), false);
  assert.equal(isImageRef(42), false);
  assert.equal(isImageRef("data:image/png;base64," + "A".repeat(200001)), false, "dataURL 超上限（> DISH_IMG_MAX）");
  assert.equal(isImageRef("data:image/png;base64,AA"), false, "短伪 dataURL 不收（isUsableDataUrl 门槛）");
  assert.equal(isImageRef("x".repeat(PET_IMG_PATH_MAX + 1)), false, "路径超长");
});

t("T15 imgRefHash：同图同哈希、异图异哈希、固定 8 位十六进制", () => {
  assert.equal(imgRefHash("abc"), imgRefHash("abc"));
  assert.notEqual(imgRefHash("abc"), imgRefHash("abd"));
  assert.match(imgRefHash("abc"), /^[0-9a-f]{8}$/);
});

t("T16 parseImageDataUrl：解出 mime/ext/bytes/hash；非图 / 超限 → null", () => {
  const p = parseImageDataUrl(img("x"));
  assert.equal(p.mime, "image/jpeg");
  assert.equal(p.ext, "jpg");
  assert.ok(p.bytes.length > 0 && p.size === p.bytes.length, "解出真实字节");
  assert.match(p.hash, /^[0-9a-f]{8}$/);
  assert.equal(parseImageDataUrl(PNG).ext, "png");
  assert.equal(parseImageDataUrl("https://x/a.jpg"), null);
  assert.equal(parseImageDataUrl("data:,x"), null);
  assert.equal(parseImageDataUrl("data:image/png;base64," + "A".repeat(200001)), null, "超上限");
});

t("T17 resolvePetImg：dataURL / 完整 URL 原样，Storage 路径换成公开 URL", () => {
  const toUrl = (p) => "https://cdn/" + p;
  assert.equal(resolvePetImg(img("x"), toUrl), img("x"), "老数据 / 降级残留直接显示");
  assert.equal(resolvePetImg("https://x/a.jpg", toUrl), "https://x/a.jpg");
  assert.equal(resolvePetImg("u1/pet-a.jpg", toUrl), "https://cdn/u1/pet-a.jpg");
  assert.equal(resolvePetImg("u1/pet-a.jpg"), "", "没有 toUrl 时给空串（不抛错）");
  assert.equal(resolvePetImg(null, toUrl), "");
});

t("T18 shrinkPetPayload：已外置的行永不裁剪；降级残留的 dataURL 按预算丢图", () => {
  /* 正常行：图片都是短路径 —— 预算再小也不该动它（否则会白丢用户的图） */
  const slim = { pet: { custom: { img: "u1/pet-a.jpg" } }, dishes: [{ img: "u1/pet-b.jpg" }], updated: 1 };
  assert.equal(shrinkPetPayload(slim, 100).dropped, 0, "只丢 dataURL，不丢路径");
  /* 降级残留：超预算 → 从尾部丢菜图，立绘最后丢 */
  const fat = {
    pet: { custom: { img: PNG } },
    dishes: [{ img: img("a") }, { img: img("b") }, { img: img("c") }],
    updated: 1,
  };
  const r = shrinkPetPayload(fat, 400);
  assert.ok(r.dropped > 0, "确实丢了图");
  assert.ok(JSON.stringify(r.payload).length <= 400, "裁到预算内");
  assert.ok(r.payload.pet.custom, "立绘优先保留");
  /* 极端：没有菜图可丢 → 连立绘也丢，但行必须能写进去 */
  const r2 = shrinkPetPayload({ pet: { custom: { img: PNG } }, dishes: [], updated: 1 }, 100);
  assert.equal(r2.payload.pet.custom, null);
  assert.equal(r2.dropped, 1);
});

t("T19 cleanDishes 接受已外置的 Storage 路径（惰性迁移后的形态）", () => {
  const r = cleanDishes([
    { id: "a", name: "小鱼干", img: "u1/pet-abc12345.jpg", effort: 1 },
    { id: "b", name: "坏菜", img: "http://nope" },
  ]);
  assert.deepEqual(r.map((d) => d.id), ["a"]);
});

t("T13 非函数参数被忽略（不抛错）", () => {
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
