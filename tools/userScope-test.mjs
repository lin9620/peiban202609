/* 账号域（userScope）单测（纯 Node；存储走 utils/storage.js 的内存降级，无需浏览器）
 *   node tools/userScope-test.mjs
 * 背景（轮 32 用户报障）：宠物/金币等本地键原来是全局单键，同设备换账号直接读到别人的档
 * （新注册的号一进宠物就是 3 级）。这里钉住分域机制的每一环，防止回归。
 * 覆盖：分域读写往返 · 坏 JSON 兜底 · 老档迁移进 guest（幂等+迁移后触发 reload）·
 *       首次登录认领（不覆盖已有档、只认一次）· 换域顺序（flush 旧域 → reload 新域）·
 *       端到端复现原报障（A 认领老档后，新注册的 B 必须是全新档）。
 */
import assert from "node:assert/strict";
import { getItem, setItem, removeItem } from "../src/utils/storage.js";
import {
  GUEST_SCOPE, registerScopeBases, scopedKey, scopeGet, scopeSet, scopeGetRaw, scopeSetRaw,
  scopeHas, scopeRemove, scopeId, onScopeSwitch, initUserScope, claimForUser,
  pendingClaimKeys, setUserScope,
} from "../src/utils/userScope.js";

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log("PASS  " + name); }
  catch (e) { fail++; console.log("FAIL  " + name + "  → " + (e && e.message)); }
}
const clean = (...keys) => keys.forEach((key) => removeItem(key));

await t("T1 scopeSet/scopeGet 往返；缺值/坏 JSON 回退 fallback", async () => {
  clean(scopedKey("t1-base"));
  registerScopeBases(["t1-base"]);
  assert.equal(scopeId(), GUEST_SCOPE);                  // 未登录 = guest 域
  scopeSet("t1-base", { pets: [1, 2], n: null });
  assert.deepEqual(scopeGet("t1-base", []), { pets: [1, 2], n: null });
  assert.deepEqual(scopeGet("t1-miss", { d: 1 }), { d: 1 });   // 没写过 → fallback
  setItem(scopedKey("t1-bad"), "{oops");
  assert.deepEqual(scopeGet("t1-bad", "fb"), "fb");            // 坏 JSON → fallback 不抛
  clean(scopedKey("t1-base"), scopedKey("t1-bad"));
});

await t("T2 键名 = base:域；scopeSetRaw/scopeGetRaw 落在对的键上", async () => {
  registerScopeBases(["t2-base"]);
  scopeSetRaw("t2-base", "raw-值");
  assert.equal(getItem("t2-base:guest"), "raw-值");
  assert.equal(getItem("t2-base"), null);                // 不再写裸键
  assert.equal(scopeGetRaw("t2-base"), "raw-值");
  scopeRemove("t2-base");
  assert.equal(scopeGetRaw("t2-base"), null);
  clean("t2-base:guest");
});

await t("T3 initUserScope：无域老档搬进 guest + 登记待认领；幂等；搬完触发一次 reload", async () => {
  const base = "t3-legacy";
  registerScopeBases([base]);
  let reloads = 0;
  onScopeSwitch({ reload: () => { reloads++; } });
  setItem(base, JSON.stringify({ level: 3 }));           // 升级前的全局老档
  const moved = initUserScope();
  assert.ok(moved >= 1, "至少搬动了本测试登记的键");
  assert.equal(getItem(base), null);                     // 裸键删掉（不留第二份真相）
  assert.deepEqual(JSON.parse(getItem(scopedKey(base, GUEST_SCOPE))), { level: 3 });
  assert.ok(pendingClaimKeys().includes(base), "搬过的键要登记待认领");
  assert.equal(reloads, 1, "首次搬动后必须补一次 reload（模块级初始读档跑在迁移前）");
  const moved2 = initUserScope();                        // 幂等：再跑一次 0 搬动
  assert.equal(moved2, 0);
  assert.equal(reloads, 1, "没有搬动就不该重复 reload");
  clean(scopedKey(base, GUEST_SCOPE));
  claimForUser("t3-cleanup-uid");                        // 清空待认领，不污染后面的用例
  clean(scopedKey(base, "t3-cleanup-uid"));
});

await t("T4 首次登录认领：guest 老档复制给该账号（guest 副本保留），且只认一次", async () => {
  const base = "t4-claim";
  registerScopeBases([base]);
  setItem(base, JSON.stringify({ coins: 88 }));
  initUserScope();
  assert.equal(claimForUser("uid-A"), 1);
  assert.deepEqual(JSON.parse(getItem(scopedKey(base, "uid-A"))), { coins: 88 });
  assert.deepEqual(JSON.parse(getItem(scopedKey(base, GUEST_SCOPE))), { coins: 88 }, "guest 副本保留（登出还能看到游客档）");
  assert.equal(pendingClaimKeys().length, 0, "认领是一次性的");
  // 认领过就不再认领：之后登录的新账号拿不到这份档（应用代码升级后只写分域键，裸键不会再生）
  assert.equal(claimForUser("uid-B"), 0);
  assert.equal(getItem(scopedKey(base, "uid-B")), null, "B 不该拿到 A 认领过的档");
  clean(scopedKey(base, GUEST_SCOPE), scopedKey(base, "uid-A"), scopedKey(base, "uid-B"));
});

await t("T5 认领绝不覆盖：账号域已有自己的档时跳过", async () => {
  const base = "t5-keep";
  registerScopeBases([base]);
  setItem(base, JSON.stringify({ v: "legacy" }));
  initUserScope();
  setItem(scopedKey(base, "uid-A"), JSON.stringify({ v: "mine" }));   // A 本来就有档
  assert.equal(claimForUser("uid-A"), 0);
  assert.deepEqual(JSON.parse(getItem(scopedKey(base, "uid-A"))), { v: "mine" });
  clean(scopedKey(base, GUEST_SCOPE), scopedKey(base, "uid-A"));
});

await t("T6 换域顺序：flush 在旧域里落盘 → 切域 → reload 在新域里重读；同域 no-op", async () => {
  const seen = { flushScope: null, reloadScope: null, order: [] };
  onScopeSwitch({
    flush: () => { seen.flushScope = scopeId(); seen.order.push("flush"); },
    reload: () => { seen.reloadScope = scopeId(); seen.order.push("reload"); },
  });
  setUserScope("uid-A");
  assert.equal(seen.flushScope, GUEST_SCOPE, "flush 执行时还在旧域（guest）");
  assert.equal(seen.reloadScope, "uid-A", "reload 执行时已在新域");
  assert.deepEqual(seen.order, ["flush", "reload"]);
  assert.equal(scopeId(), "uid-A");
  assert.equal(setUserScope("uid-A"), false, "同域切换是无操作");
  setUserScope("");                                      // 登出 → guest
  assert.equal(seen.flushScope, "uid-A", "登出时先把当前态落回 A 的域");
  assert.equal(scopeId(), GUEST_SCOPE);
});

await t("T7 端到端复现原报障：A 认领老档后，新注册的 B 必须是全新档（不再继承 3 级宠物）", async () => {
  const SAVE = "t7-e2e-save";
  registerScopeBases([SAVE]);
  const legacyPet = JSON.stringify({ coins: 120, pets: [{ id: "p1", level: 3, name: "别人养的" }], activeId: "p1" });
  setItem(SAVE, legacyPet);                              // 升级前：这台机器上有人养到 3 级
  initUserScope();                                       // → guest 域 + 待认领
  setUserScope("uid-A");                                 // 老用户 A 登录 → 认领
  assert.deepEqual(JSON.parse(getItem(scopedKey(SAVE, "uid-A"))), JSON.parse(legacyPet), "A 的档跟过来了");
  setUserScope("");                                      // A 登出
  const bSaved = setUserScope("uid-B");                  // 新注册的 B 登录
  assert.equal(bSaved, true);
  assert.equal(getItem(scopedKey(SAVE, "uid-B")), null, "B 域里没有档 → 前端按全新玩家处理（1 级 + 50 金币）");
  assert.equal(scopeHas(SAVE, "uid-A"), true, "A 的档不受影响");
  setUserScope("");
  clean(scopedKey(SAVE, GUEST_SCOPE), scopedKey(SAVE, "uid-A"), scopedKey(SAVE, "uid-B"));
});

await t("T8 scopeHas/scopeRemove 域内判存与删除", async () => {
  registerScopeBases(["t8-x"]);
  scopeSet("t8-x", { a: 1 });
  assert.equal(scopeHas("t8-x", GUEST_SCOPE), true);
  assert.equal(scopeHas("t8-x", "uid-nope"), false);
  scopeRemove("t8-x");
  assert.equal(scopeHas("t8-x", GUEST_SCOPE), false);
});

console.log(`\nuserScope-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
