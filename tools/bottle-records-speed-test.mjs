/* 轮 338 · 漂流瓶记录「转圈不动 / 很慢」——超时、丢飞行、SWR 缓存、名单并发
 *   node tools/bottle-records-speed-test.mjs
 *
 * 线上现象：私信页 → 漂流瓶 → 「正在找回漂流瓶记录……」，十几秒到几十秒不回来；
 * 刷新键 disabled（loading 卡住），只能整页重进。排查：接口偶发 20~45s 不返回
 * （Worker/上游链路卡住），而代码里没有任何超时；昵称还是 30 个串行请求。
 * 这里锁四件事：
 *   R1 读接口 15s 超时，超时抛 errTimeout（写接口绝不套超时）
 *   R2 超时把这趟单飞扔掉 —— 再点刷新是真的重新发请求
 *   R3 记录 SWR：上次列表先画（切段/进页不干等）
 *   R4 昵称并发解析，且不再占着 loading
 *   R5 网关侧（VITE_API_GATEWAY=1 的构建）也有请求级超时兜底
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bottleErrKey } from "../src/utils/bottle.js";
import { singleFlight, dropFlight } from "../src/utils/inflight.js";
import { messages } from "../src/i18n.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BOTTLE = fs.readFileSync(path.join(root, "src/utils/bottle.js"), "utf8");
const INFLIGHT = fs.readFileSync(path.join(root, "src/utils/inflight.js"), "utf8");
const GW = fs.readFileSync(path.join(root, "src/utils/api/db.gateway.js"), "utf8");
const LIST = fs.readFileSync(path.join(root, "src/components/BottleChatList.vue"), "utf8");
const RECS = fs.readFileSync(path.join(root, "src/components/BottleRecords.vue"), "utf8");
let pass = 0, fail = 0; const out = [];
const t = (name, fn) => {
  try { fn(); pass++; out.push("ok   " + name); }
  catch (e) { fail++; out.push("FAIL " + name + " :: " + e.message); }
};
const has = (src, re, msg) => { if (!re.test(src)) throw new Error(msg); };
const no = (src, re, msg) => { if (re.test(src)) throw new Error(msg); };

/* R1 · 超时口径 */
t("R1 超时错误 → bottle.errTimeout（别混进「海浪大」）", () => {
  assert.equal(bottleErrKey(Object.assign(new Error("timeout"), { timeout: true })), "bottle.errTimeout");
  assert.equal(bottleErrKey(new Error("timeout")), "bottle.errTimeout");
  assert.equal(bottleErrKey(new Error("boom")), "bottle.errGeneric");
});

t("R1 读接口统一 15s 超时，写接口不套", () => {
  has(BOTTLE, /const READ_TIMEOUT = 15000;/, "READ_TIMEOUT 不是 15s");
  has(BOTTLE, /return withTimeout\(db\.bottleMine\(\), READ_TIMEOUT\)/, "bottleMine 没套超时");
  has(BOTTLE, /singleFlight\("held"[\s\S]{0,80}READ_TIMEOUT/, "bottleHeld 没套超时");
  has(BOTTLE, /singleFlight\("quota"[\s\S]{0,80}READ_TIMEOUT/, "bottleQuota 没套超时");
  has(BOTTLE, /singleFlight\(key[\s\S]{0,120}READ_TIMEOUT/, "bottleRecords 没套超时");
  /* 写操作必须保持「没有超时」：超时 ≠ 没落库，不能给用户「失败」的错觉。
   * 全文只允许 5 处 return withTimeout( —— mine / held / quota / records /
   * bottleHiddenLetters（轮446 加的只读接口：已隐藏清单），全是只读。 */
  const wrapped = (BOTTLE.match(/return withTimeout\(/g) || []).length;
  assert.equal(wrapped, 5, `withTimeout 包了 ${wrapped} 处，应只包 5 个只读接口`);
  /* 轮446：撤回 / 隐藏 / 恢复显示都是写操作，绝不能套超时 */
  ["bottleWithdraw", "bottleHide", "bottleUnhide"].forEach((fn) => {
    const block = BOTTLE.slice(BOTTLE.indexOf(`export async function ${fn}`));
    const body = block.slice(0, block.indexOf("\n}"));
    assert.ok(!/withTimeout/.test(body), `${fn} 是写操作，不该套超时`);
  });
});

t("R2 超时要丢飞行（不然重试拿回同一个卡住的 Promise）", () => {
  has(BOTTLE, /\(\) => dropFlight\(key\)/, "bottleRecords 超时没丢飞行");
  has(BOTTLE, /dropFlight\("held"\)/, "bottleHeld 超时没丢飞行");
  has(INFLIGHT, /if \(flights\.get\(key\) === p\) flights\.delete\(key\);/, "旧请求晚到的 finally 会误删新飞行");
});

t("R2 dropFlight 语义：丢完再发就是新请求；老飞行晚到不许删新的", async () => {
  let calls = 0;
  const p1 = singleFlight("t-drop", () => { calls++; return new Promise(() => {}); });
  dropFlight("t-drop");
  const p2 = singleFlight("t-drop", () => { calls++; return Promise.resolve(1); });
  assert.notEqual(p1, p2, "丢了飞行还是同一个 Promise");
  assert.equal(await p2, 1);
  assert.equal(calls, 2);

  let resolveOld;
  const oldP = singleFlight("t-guard", () => new Promise((r) => { resolveOld = r; }));
  dropFlight("t-guard");
  const newP = singleFlight("t-guard", () => new Promise(() => {}));
  resolveOld("old");
  await oldP;
  assert.equal(singleFlight("t-guard", () => Promise.resolve("x")), newP, "老飞行的 finally 删掉了新飞行");
});

t("R3 记录 SWR：先画缓存再拉网络（key 不撞 purge 的 bottle: 前缀）", () => {
  has(LIST, /import \{ cacheKey, cachePeek, cacheSet \} from "\.\.\/utils\/cache\.js"/, "列表没接缓存");
  has(LIST, /cacheKey\("dm:bottle-records", userId\.value, mine\.value \? "mine" : "held"\)/, "缓存 key 不对");
  no(LIST, /cacheKey\("bottle:/, "缓存 key 用了 bottle: 前缀，会被 purgeLegacyBottleLocals 清掉");
  has(LIST, /function paintCache\(\)[\s\S]{0,700}?rows\.value = (?:d|all\.slice)/, "没有先画缓存");
  has(LIST, /offset = 0;\s*paintCache\(\);\s*load\(\);/, "reset 里没先画缓存再拉");
  has(LIST, /cacheSet\(ck\(\), rows\.value\)/, "成功后没回写缓存");
  has(RECS, /cacheKey\("dm:bottle-records", userId\.value, mine\.value \? "mine" : "held"\)/, "手机记录没接缓存");
  has(RECS, /paintCache\(\);\s*load\(\);/, "手机记录 reset 没先画缓存");
  has(RECS, /cacheSet\(ck\(\), rows\.value\)/, "手机记录没回写缓存");
});

t("R4 昵称并发解析，且不再占着 loading", () => {
  has(LIST, /Array\.from\(\{ length: Math\.min\(4, todo\.length\) \}, worker\)/, "昵称不是 4 路并发");
  has(LIST, /loading\.value = false;\s*\/\* 名单在后台补[\s\S]{0,60}\*\/\s*resolveNames\(rows\.value\);/, "loading 仍在等昵称");
  no(LIST, /await resolveNames\(rows\.value\)/, "还在 await 昵称（刷新键陪着等）");
});

t("R5 网关构建也有请求级超时兜底", () => {
  has(GW, /const TIMEOUT_DEFAULT = 30000;/, "网关默认超时不是 30s");
  has(GW, /const TIMEOUT_UPLOAD = 120000;/, "上传超时不是 120s");
  has(GW, /new AbortController\(\)[\s\S]{0,200}ctrl\.abort\(\)/, "没用 AbortController 掐请求");
  has(GW, /new Error\("gateway-timeout"\)[\s\S]{0,60}x\.timeout = true/, "超时没打 timeout 标记");
  has(GW, /call\(`\/bottle\/records\?\$\{qs\.join\("&"\)\}`, \{ timeout: 15000 \}\)/, "网关 records 不是 15s");
});

t("R6 文案：中英都有 errTimeout", () => {
  assert.ok(String(messages.en.bottle.errTimeout).includes("15s"), "英文缺 errTimeout");
  assert.ok(String(messages.zh.bottle.errTimeout).includes("15 秒"), "中文缺 errTimeout");
});

t("R7 超时后 30s 内不自动重试（否则提示被 15s 定时器闪没）", () => {
  has(LIST, /let errAt = 0;/, "列表没有 errAt");
  has(LIST, /error\.value = bottleErrKey\(e\); errAt = Date\.now\(\)/, "列表出错没记时刻");
  has(LIST, /if \(error\.value && Date\.now\(\) - errAt < 30000\) return;/, "列表没有 30s 冷却");
  has(RECS, /let errAt = 0;/, "卡片没有 errAt");
  has(RECS, /error\.value = bottleErrKey\(e\); errAt = Date\.now\(\)/, "卡片出错没记时刻");
  has(RECS, /if \(error\.value && Date\.now\(\) - errAt < 30000\) return;/, "卡片没有 30s 冷却");
});

console.log(out.join("\n"));
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
