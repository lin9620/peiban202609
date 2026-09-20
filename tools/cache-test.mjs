/* 本地优先缓存单测（纯 Node，无需浏览器/服务器/网络；存储走 utils/storage.js 的内存降级）
 *   node tools/cache-test.mjs
 * 覆盖：读写往返 · TTL 过期 · SWR 命中/回写/去抖 · 无缓存 onError · 有缓存网络失败静默保留
 *       · fetcher 返回 null 不覆盖 · 换用户隔离 · 前缀清理 · 容量淘汰最旧 · null 不写缓存
 */
import assert from "node:assert/strict";
import {
  cacheKey, cacheGet, cachePeek, cacheSet, cacheDrop, swr, CACHE_MAX_ENTRIES,
} from "../src/utils/cache.js";

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log("PASS  " + name); }
  catch (e) { fail++; console.log("FAIL  " + name + "  → " + (e && e.message)); }
}

await t("T1 set/get 往返（嵌套对象/数组无损）", async () => {
  const rows = [{ id: 1, body: "你好", tags: ["a", "b"] }, { id: 2, body: null }];
  cacheSet("t1", rows);
  assert.deepEqual(cacheGet("t1"), rows);
  assert.deepEqual(cachePeek("t1"), rows);
});

await t("T2 cacheGet 受 maxAge 约束；cachePeek 不受（陈旧也先渲染）", async () => {
  cacheSet("t2", { n: 1 });
  assert.deepEqual(cacheGet("t2", { maxAge: -1 }), null);   /* 负 TTL 必然超龄 → 查询不命中 */
  assert.deepEqual(cachePeek("t2"), { n: 1 });             /* SWR 照样先渲染 */
  assert.deepEqual(cacheGet("t2", { maxAge: 60000 }), { n: 1 });
});

await t("T3 swr 命中：cached 同步上屏，fresh 后到覆盖并回写", async () => {
  cacheSet("t3", [{ id: 1 }]);
  const seen = [];
  const hit = await swr(
    "t3",
    {
      cached: (d) => seen.push(["cached", d]),
      fresh: (d) => seen.push(["fresh", d]),
    },
    async () => [{ id: 1 }, { id: 2 }],
  );
  assert.equal(hit, true);
  assert.equal(seen.length, 2);
  assert.equal(seen[0][0], "cached");
  assert.equal(seen[1][0], "fresh");
  assert.equal(seen[1][1].length, 2);
  assert.deepEqual(cachePeek("t3"), [{ id: 1 }, { id: 2 }]);   /* 新数据已回写 */
});

await t("T4 swr fresh 与缓存相同 → fresh 钩子不触发（不闪重渲染）", async () => {
  const same = [{ id: 9 }];
  cacheSet("t4", JSON.parse(JSON.stringify(same)));
  let freshCalls = 0;
  await swr("t4", { fresh: () => freshCalls++ }, async () => JSON.parse(JSON.stringify(same)));
  assert.equal(freshCalls, 0);
});

await t("T5 swr 无缓存：cached 不触发；成功 fresh+缓存；失败 onError", async () => {
  let cachedCalls = 0;
  const hit = await swr("t5", { cached: () => cachedCalls++, fresh: () => {} }, async () => ["x"]);
  assert.equal(hit, false);
  assert.equal(cachedCalls, 0);
  assert.deepEqual(cachePeek("t5"), ["x"]);
  let err = null;
  cacheDrop("t5b");
  await swr("t5b", { onError: (e) => { err = e; } }, async () => { throw new Error("boom"); });
  assert.ok(err && err.message === "boom");
});

await t("T6 swr 有缓存但网络失败 → 静默保留缓存（onError 不触发）", async () => {
  cacheSet("t6", ["keep"]);
  let err = null, freshCalls = 0;
  const hit = await swr(
    "t6",
    { fresh: () => freshCalls++, onError: (e) => { err = e; } },
    async () => { throw new Error("offline"); },
  );
  assert.equal(hit, true);
  assert.equal(err, null);
  assert.equal(freshCalls, 0);
  assert.deepEqual(cachePeek("t6"), ["keep"]);
});

await t("T7 fetcher 返回 null（拉取失败语义）→ 不覆盖不回写", async () => {
  cacheSet("t7", ["old"]);
  await swr("t7", { fresh: () => assert.fail("不应触发") }, async () => null);
  assert.deepEqual(cachePeek("t7"), ["old"]);
});

await t("T8 换用户不串数据（key 带用户域）", async () => {
  cacheSet(cacheKey("dm:convs", "u1"), [{ c: 1 }]);
  cacheSet(cacheKey("dm:convs", "u2"), [{ c: 2 }]);
  assert.deepEqual(cachePeek(cacheKey("dm:convs", "u1")), [{ c: 1 }]);
  assert.deepEqual(cachePeek(cacheKey("dm:convs", "u2")), [{ c: 2 }]);
});

await t("T9 cacheDrop 按前缀清理；其它域保留", async () => {
  cacheSet("dm:convs|u9", [1]);
  cacheSet("dm:msgs|u9|c1", [2]);
  cacheSet("wall:posts|u9", [3]);
  cacheDrop("dm:");
  assert.equal(cachePeek("dm:convs|u9"), null);
  assert.equal(cachePeek("dm:msgs|u9|c1"), null);
  assert.deepEqual(cachePeek("wall:posts|u9"), [3]);
});

await t("T10 容量护栏：超出上限淘汰最旧", async () => {
  cacheDrop("t10:");
  for (let i = 0; i < CACHE_MAX_ENTRIES + 5; i++) cacheSet("t10:" + i, { i });
  assert.equal(cachePeek("t10:0"), null);                                    /* 最旧的被淘汰 */
  assert.equal(cachePeek("t10:4"), null);
  assert.deepEqual(cachePeek("t10:" + (CACHE_MAX_ENTRIES + 4)), { i: CACHE_MAX_ENTRIES + 4 }); /* 最新还在 */
});

await t("T11 null/undefined 不写缓存（避免空快照顶掉好数据）", async () => {
  cacheSet("t11", ["good"]);
  cacheSet("t11", null);
  cacheSet("t11", undefined);
  assert.deepEqual(cachePeek("t11"), ["good"]);
});

await t("T12 key 为空时 swr 只走网络（翻页等非缓存路径）", async () => {
  let cachedCalls = 0, freshCalls = 0;
  await swr(null, { cached: () => cachedCalls++, fresh: () => freshCalls++ }, async () => ["p"]);
  assert.equal(cachedCalls, 0);
  assert.equal(freshCalls, 1);
  assert.deepEqual(cachePeek(""), null);
});

console.log("TOTAL " + (pass + fail) + "  PASS " + pass + "  FAIL " + fail);
process.exit(fail ? 1 : 0);