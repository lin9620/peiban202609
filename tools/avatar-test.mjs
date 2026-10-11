/* 萌宠头像池测试（轮 238）
 * ------------------------------------------------------------
 * 覆盖：
 *   · public/avatars/ 下 30 张 SVG 全部存在且是合法矢量图（有 svg 根 / viewBox / 无外链）
 *   · avatarIndexFor：uid 哈希确定性（同 uid 恒同图 = 跨设备一致）、无 uid → 0
 *   · avatarUrlFor：URL 形状 / 指向的文件真实存在
 *   · 分布：3000 个假 uuid 抽样，30 个桶都接得到用户（最小桶不塌）
 * 运行：node tools/avatar-test.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { avatarIndexFor, avatarUrlFor, AVATAR_COUNT } from "../src/utils/avatar.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "public", "avatars");

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; } else { fail++; console.error("FAIL", name); } };

/* ① 文件池完整 */
const files = readdirSync(DIR).filter((f) => f.endsWith(".svg")).sort();
ok(files.length === AVATAR_COUNT, `池子里正好 30 张 SVG（实际 ${files.length}）`);
ok(files[0] === "01.svg" && files[29] === "30.svg", "命名 01..30 连续");
for (const f of files) {
  const t = readFileSync(join(DIR, f), "utf8");
  ok(t.includes("<svg") && t.includes("viewBox=\"0 0 96 96\""), `${f} 是 96×96 viewBox 的 SVG`);
  ok(!/href\s*=/.test(t), `${f} 无外链引用（离线可用）`);
}

/* ② 哈希确定性 */
const uid = "37417df6-7531-434f-94e9-e7c0eb763413";
ok(avatarIndexFor(uid) === avatarIndexFor(uid), "同一 uid 两次哈希结果一致");
ok(avatarIndexFor(uid) !== avatarIndexFor(uid + "x"), "不同 uid 哈希不同（抽样）");
ok(avatarIndexFor("") === 0 && avatarIndexFor(null) === 0 && avatarIndexFor(undefined) === 0, "无 uid → 0（回退首字母）");

/* ③ URL 形状与文件真实存在 */
for (let i = 1; i <= AVATAR_COUNT; i++) {
  const url = avatarUrlFor("uid-" + i);
  ok(/^\/avatars\/\d{2}\.svg$/.test(url), `URL 形状 ${url}`);
  ok(files.includes(url.slice("/avatars/".length)), `${url} 指向的文件存在`);
}
ok(avatarUrlFor("") === "", "无 uid → 空 URL");

/* ④ 分布：3000 个假 uuid，30 桶都接得到（最小桶 ≥ 均值的 1/3） */
const buckets = new Array(AVATAR_COUNT).fill(0);
for (let i = 0; i < 3000; i++) {
  buckets[avatarIndexFor("user-" + i + "-" + Math.random().toString(36).slice(2, 8)) - 1]++;
}
const min = Math.min(...buckets);
ok(min >= 33, `分布均匀：最小桶 ${min}（均值 100），30 桶全有用户`);

console.log(`avatar-test: ${pass} pass, ${fail} fail`);
if (fail) process.exit(1);
