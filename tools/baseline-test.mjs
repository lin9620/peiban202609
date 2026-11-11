/* 生产 schema 基线静态自检：
 * 不连数据库，只守住「生成文件没被手改、没混进数据/密钥、事务完整、计数对得上」。
 * 需要重新生成时：node tools/schema-baseline.mjs dump
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "supabase", "baseline");
const files = {
  schema: path.join(DIR, "schema.sql"),
  platform: path.join(DIR, "platform.sql"),
  baseline: path.join(DIR, "baseline.sql"),
};
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, "manifest.json"), "utf8"));
const read = (p) => fs.readFileSync(p, "utf8");
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

const out = [];
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; out.push("PASS  " + name); }
  catch (e) { fail++; out.push("FAIL  " + name + "  — " + e.message); }
}

t("B1 三份 SQL + manifest 都存在且非空", () => {
  for (const p of Object.values(files)) assert.ok(fs.statSync(p).size > 1000, p + " 太小");
  assert.ok(manifest.counts.tables > 0);
});

t("B2 文件 SHA256 与 manifest 一致（防止手改基线）", () => {
  for (const [k, p] of Object.entries(files)) {
    assert.equal(sha(p), manifest.sha256[k], k + ".sql 已漂移，请重新 dump");
  }
});

t("B3 schema 里没有 COPY / INSERT 数据", () => {
  const s = read(files.schema);
  assert.ok(!/^COPY .* FROM stdin;/m.test(s));
  assert.ok(!/^INSERT INTO /m.test(s));
});

t("B4 baseline 不含连接串、JWT 或 service_role key", () => {
  const all = Object.entries(files).map(([, p]) => read(p)).join("\n");
  assert.ok(!/postgres(ql)?:\/\//i.test(all), "不能把数据库连接串写进基线");
  assert.ok(!/eyJ[A-Za-z0-9_-]{20,}/.test(all), "不能把 JWT/anon/service key 写进基线");
  assert.ok(!/SUPABASE_SERVICE_ROLE_KEY|service_role_key/i.test(all));
});

t("B5 baseline.sql 有完整事务 begin/commit", () => {
  const s = read(files.baseline);
  assert.match(s, /\nbegin;\n/);
  assert.match(s, /\ncommit;\n/);
  assert.ok(s.indexOf("begin;") < s.indexOf("commit;"));
});

t("B6 表/函数/策略/触发器计数与 manifest 一致", () => {
  const s = read(files.schema);
  const count = (re) => (s.match(re) || []).length;
  assert.equal(count(/^CREATE TABLE /gm), manifest.counts.tables);
  assert.equal(count(/^CREATE (OR REPLACE )?FUNCTION /gm), manifest.counts.functions);
  assert.equal(count(/^CREATE POLICY /gm), manifest.counts.policies);
  assert.equal(count(/^CREATE (OR REPLACE )?TRIGGER /gm), manifest.counts.triggers);
});

t("B7 platform glue 覆盖 auth 触发器 / Storage / Realtime", () => {
  const s = read(files.platform);
  assert.ok(s.includes("on_auth_user_created"));
  assert.ok(s.includes("storage.buckets"));
  assert.ok(s.includes('"storage"."objects"'));
  assert.ok(s.includes("supabase_realtime"));
  assert.ok(s.includes("app_state"));
  assert.ok(s.includes("dm_messages"));
});

out.push("");
out.push("TOTAL " + (pass + fail) + "  PASS " + pass + "  FAIL " + fail);
console.log(out.join("\n"));
if (fail) process.exit(1);
