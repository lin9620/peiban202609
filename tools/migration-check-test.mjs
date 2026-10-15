/* 迁移自检纯逻辑单测（轮 301 · 零碰撞：只测新文件，不碰 AdminView/i18n） */
import assert from "node:assert/strict";
import { probeRow, probeSummary, MIGRATION_PROBES_301 } from "../src/utils/migrationCheck.js";

const out = [];
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; out.push("PASS  " + name); }
  catch (e) { fail++; out.push("FAIL  " + name + "  → " + e.message); }
}

t("M1 probeRow：形状归一，脏值安全", () => {
  assert.deepEqual(
    probeRow({ key: "comment_delete", ok: true, code: 200, ms: 12.7, hint: "x.sql" }),
    { key: "comment_delete", ok: true, code: "200", ms: 12, hint: "x.sql" });
  const d = probeRow();
  assert.equal(d.ok, false, "缺字段按未通过计");
  assert.equal(d.ms, null);
});

t("M2 probeSummary：全部通过才 ALL PASS；空数组不算通过", () => {
  assert.equal(probeSummary([{ key: "a", ok: true }]).all, true);
  assert.equal(probeSummary([{ key: "a", ok: true }, { key: "b", ok: false }]).all, false);
  assert.equal(probeSummary([]).all, false, "没测到不能说通过");
  assert.equal(probeSummary(null).total, 0);
});

t("M3 轮 301 三项探测定义齐（comment_delete/feed修后版/counts_301）", () => {
  const keys = MIGRATION_PROBES_301.map((x) => x.key);
  assert.ok(keys.includes("comment_delete"));
  assert.ok(keys.includes("wall_feed_page_295"));
  assert.ok(keys.includes("comment_counts_301"));
  for (const p of MIGRATION_PROBES_301) {
    assert.ok(p.sql && p.how, p.key + " 缺 sql/how 说明");
  }
});

out.push("");
out.push("TOTAL " + (pass + fail) + "  PASS " + pass + "  FAIL " + fail);
console.log(out.join("\n"));
if (fail) process.exit(1);
