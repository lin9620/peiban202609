/* 暖心墙刷新「有无新内容」判定单测（Node 直跑，无需浏览器/服务器/网络）
 *   node tools/wall-refresh-test.mjs
 * 覆盖：hasNewPosts（wallRules.js，轮 333 提取的纯函数）
 *   - 本批含新 dbId → hasNew=true，newRows 仅含新行
 *   - 本批全是旧 dbId → hasNew=false，newRows=[]
 *   - 空/脏输入安全（null、undefined、含 null 行、含无 dbId 行）
 *   - existingDbIds 既可传 Set 也可传数组
 *   - 不修改入参数组
 */
import assert from "node:assert/strict";
import { hasNewPosts } from "../src/utils/wallRules.js";

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("PASS  " + name); }
  catch (e) { fail++; console.log("FAIL  " + name + "  → " + e.message); }
}

/* ── 基本判定 ── */
t("T1 本批含新 dbId → hasNew=true，newRows 仅含新行", () => {
  const fetched = [
    { dbId: 1, text: "old" },
    { dbId: 2, text: "new1" },
    { dbId: 3, text: "new2" },
  ];
  const known = new Set([1]);
  const r = hasNewPosts(fetched, known);
  assert.equal(r.hasNew, true);
  assert.deepEqual(r.newRows.map((p) => p.dbId), [2, 3]);
});

t("T2 本批全是旧 dbId → hasNew=false，newRows=[]", () => {
  const fetched = [
    { dbId: 1, text: "a" },
    { dbId: 2, text: "b" },
  ];
  const known = new Set([1, 2]);
  const r = hasNewPosts(fetched, known);
  assert.equal(r.hasNew, false);
  assert.deepEqual(r.newRows, []);
});

t("T3 existingDbIds 为空 → 所有有 dbId 的行都算新", () => {
  const fetched = [
    { dbId: 5, text: "x" },
    { dbId: 6, text: "y" },
  ];
  const r = hasNewPosts(fetched, []);
  assert.equal(r.hasNew, true);
  assert.deepEqual(r.newRows.map((p) => p.dbId), [5, 6]);
});

/* ── 输入安全 ── */
t("T4 fetchedRows 为 null/undefined → hasNew=false，不抛", () => {
  assert.equal(hasNewPosts(null, [1]).hasNew, false);
  assert.equal(hasNewPosts(undefined, [1]).hasNew, false);
});

t("T5 fetchedRows 含 null / 非对象 → 过滤掉，不影响判定", () => {
  const fetched = [null, "x", 42, { dbId: 9, text: "ok" }];
  const r = hasNewPosts(fetched, []);
  assert.equal(r.hasNew, true);
  assert.deepEqual(r.newRows.map((p) => p.dbId), [9]);
});

t("T6 行 dbId 为 null/undefined → 不算新内容，被过滤", () => {
  const fetched = [
    { dbId: null, text: "no-id" },
    { dbId: undefined, text: "no-id2" },
    { text: "no-dbId-at-all" },
    { dbId: 7, text: "has-id" },
  ];
  const r = hasNewPosts(fetched, []);
  assert.equal(r.hasNew, true);
  assert.deepEqual(r.newRows.map((p) => p.dbId), [7]);
});

t("T7 existingDbIds 为数组（非 Set）也能正常工作", () => {
  const fetched = [{ dbId: 1 }, { dbId: 2 }];
  const r = hasNewPosts(fetched, [1]);
  assert.equal(r.hasNew, true);
  assert.deepEqual(r.newRows.map((p) => p.dbId), [2]);
});

/* ── 不修改入参 ── */
t("T8 不修改入参数组（调用方可安全复用）", () => {
  const fetched = [{ dbId: 1 }, { dbId: 2 }];
  const known = [1];
  const fetchedBefore = JSON.stringify(fetched);
  const knownBefore = JSON.stringify(known);
  hasNewPosts(fetched, known);
  assert.equal(JSON.stringify(fetched), fetchedBefore);
  assert.equal(JSON.stringify(known), knownBefore);
});

/* ── 空结果 ── */
t("T9 fetchedRows 为空数组 → hasNew=false", () => {
  const r = hasNewPosts([], [1, 2]);
  assert.equal(r.hasNew, false);
  assert.deepEqual(r.newRows, []);
});

console.log(`\nTOTAL ${pass + fail}  PASS ${pass}  FAIL ${fail}`);
if (fail > 0) process.exitCode = 1;