/* 暖心墙进阶规则单测（纯 Node，无需浏览器/服务器/网络）
 *   node tools/wall-rules-test.mjs
 * 覆盖：排序（最新 / 同感 / 抱抱 / 暖暖）· 浏览去重 · 厌恶 1% 下架 · 每人每天一条
 */
import assert from "node:assert/strict";
import {
  SORTS, SORT_MODES, DEFAULT_SORT, sortPosts, reactCount,
  VIEW_KEY, ANON_KEY, POST_DAY_KEY, postRef, utcDay, pruneStamps, collectViews,
  DISLIKE_RATIO, REMOVAL_MIN_VIEWS, dislikeRatio, ratioPct, shouldRemove,
  isVisible, visibleOnly, postedOnDay, canPostToday, errorKind,
} from "../src/utils/wallRules.js";

const out = [];
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; out.push("PASS  " + name); }
  catch (e) { fail++; out.push("FAIL  " + name + "  → " + e.message); }
}

const post = (id, ts, reacts = {}, extra = {}) => ({ id: "c" + id, dbId: id, ts, reacts, ...extra });

/* ══════════ 排序 ══════════ */

t("T1 排序方式共 4 种，默认最新，key 与 i18n 键齐备", () => {
  assert.equal(SORTS.length, 4);
  assert.equal(DEFAULT_SORT, "new");
  assert.deepEqual(SORT_MODES, ["new", "relate", "hug", "warm"]);
  for (const s of SORTS) assert.ok(s.tk.startsWith("community.sort"), s.key);
});

t("T2 最新排序：时间倒序", () => {
  const list = [post(1, 100), post(2, 300), post(3, 200)];
  assert.deepEqual(sortPosts(list, "new").map((p) => p.dbId), [2, 3, 1]);
});

t("T3 同感最多 / 抱抱最多 / 暖暖最多：各按对应回应数倒序", () => {
  const list = [
    post(1, 100, { hug: 1, warm: 9, relate: 2 }),
    post(2, 200, { hug: 5, warm: 0, relate: 8 }),
    post(3, 300, { hug: 3, warm: 4, relate: 1 }),
  ];
  assert.deepEqual(sortPosts(list, "hug").map((p) => p.dbId), [2, 3, 1]);
  assert.deepEqual(sortPosts(list, "warm").map((p) => p.dbId), [1, 3, 2]);
  assert.deepEqual(sortPosts(list, "relate").map((p) => p.dbId), [2, 1, 3]);
});

t("T4 票数相同时按时间倒序（并列也有稳定顺序）", () => {
  const list = [post(1, 100, { hug: 2 }), post(2, 500, { hug: 2 }), post(3, 300, { hug: 2 })];
  assert.deepEqual(sortPosts(list, "hug").map((p) => p.dbId), [2, 3, 1]);
});

t("T5 排序不改动入参数组（computed 里不能把源数组搅乱）", () => {
  const list = [post(1, 100), post(2, 300)];
  const copy = list.slice();
  sortPosts(list, "new");
  assert.deepEqual(list, copy);
});

t("T6 未知排序方式回退最新；空/脏输入不炸", () => {
  assert.deepEqual(sortPosts([post(1, 100), post(2, 300)], "bogus").map((p) => p.dbId), [2, 1]);
  assert.deepEqual(sortPosts(null, "hug"), []);
  assert.deepEqual(sortPosts(undefined, undefined), []);
});

t("T7 回应计数：缺字段 / 负数 / 脏值一律按 0 处理", () => {
  assert.equal(reactCount({ reacts: { hug: 3 } }, "hug"), 3);
  assert.equal(reactCount({ reacts: { hug: -5 } }, "hug"), 0);
  assert.equal(reactCount({ reacts: { hug: "x" } }, "hug"), 0);
  assert.equal(reactCount({}, "hug"), 0);
  assert.equal(reactCount(null, "hug"), 0);
});

/* ═════════ 浏览 ══════════ */

t("T8 postRef：云端帖用 dbId，本地帖用 id", () => {
  assert.equal(postRef({ dbId: 12, id: "c12" }), "12");
  assert.equal(postRef({ id: 1700000000000 }), "1700000000000");
  assert.equal(postRef({}), "");
  assert.equal(postRef(null), "");
});

t("T9 utcDay：UTC 日；坏输入不抛错", () => {
  assert.equal(utcDay(Date.parse("2026-03-05T23:59:59Z")), "2026-03-05");
  assert.equal(utcDay(Date.parse("2026-03-06T00:00:01Z")), "2026-03-06");
  assert.equal(typeof utcDay(Number.NaN), "string");
});

t("T10 浏览只留今天的记录（localStorage 不会越积越多）", () => {
  const pruned = pruneStamps({ "1": "2026-03-05", "2": "2026-03-06" }, "2026-03-06");
  assert.deepEqual(pruned, { "2": "2026-03-06" });
});

t("T11 同一访客对同一条帖，一天只算一次浏览（反复刷新不涨）", () => {
  const list = [post(1, 100), post(2, 200)];
  const day = "2026-03-06";
  const first = collectViews({}, list, "u1", day);
  assert.deepEqual(first.pending.map((p) => p.dbId), [1, 2], "第一次两条都记");
  const second = collectViews(first.stamps, list, "u1", day);
  assert.equal(second.pending.length, 0, "同一天再来不算");
  const nextDay = collectViews(second.stamps, list, "u1", "2026-03-07");
  assert.deepEqual(nextDay.pending.map((p) => p.dbId), [1, 2], "换一天重新算");
});

t("T12 同一台设备换身份（游客 → 登录）仍只算一次：不给自己刷浏览量", () => {
  const list = [post(1, 100)];
  const day = "2026-03-06";
  const anon = collectViews({}, list, "a-device-1", day);
  assert.equal(anon.pending.length, 1, "游客先看：算一次");
  const afterLogin = collectViews(anon.stamps, list, "u1", day);
  assert.equal(afterLogin.pending.length, 0, "同设备登录后再看：不重复算（人是同一个）");
  assert.deepEqual(afterLogin.stamps, { "1": day });
});

t("T12b 多访客各算一次由服务端保证（前端把「谁看过」交给云端去重）", () => {
  /* 同一帖，两台不同设备的本地记录互不影响 → 两边都会各报一次浏览 */
  const list = [post(1, 100)];
  const day = "2026-03-06";
  const deviceA = collectViews({}, list, "a-device-1", day);
  const deviceB = collectViews({}, list, "a-device-2", day);
  assert.equal(deviceA.pending.length, 1);
  assert.equal(deviceB.pending.length, 1);
  assert.deepEqual(deviceA.stamps, deviceB.stamps, "记录形状一致（都是按帖 + 日期）");
});

t("T13 示例帖与无身份访客不计浏览", () => {
  const list = [post(1, 100), { id: "s1", sample: true, ts: 1 }];
  assert.equal(collectViews({}, list, "").pending.length, 0);
  assert.deepEqual(collectViews({}, list, "u1", "2026-03-06").pending.map((p) => p.dbId), [1]);
});

/* ═════════ 厌恶比例 → 下架 ══════════ */

t("T14 下架线是 1%，阈值常量与需求一致", () => {
  assert.equal(DISLIKE_RATIO, 0.01);
  assert.equal(REMOVAL_MIN_VIEWS, 1);
});

t("T15 dislikeRatio：比例计算 + 没有浏览时为 0（不凭空下架）", () => {
  assert.equal(dislikeRatio(100, 1), 0.01);
  assert.equal(dislikeRatio(200, 3), 0.015);
  assert.equal(dislikeRatio(0, 5), 0);
  assert.equal(dislikeRatio("x", "y"), 0);
  assert.equal(dislikeRatio(10, 99), 1, "比例封顶 1，不会 >100%");
});

t("T16 shouldRemove：≥1% 下架；差一点点就不下架", () => {
  assert.equal(shouldRemove(100, 1), true, "100 浏览 1 厌恶 = 1% 恰好下架");
  assert.equal(shouldRemove(1000, 10), true, "1000 浏览 10 厌恶 = 1%");
  assert.equal(shouldRemove(1000, 9), false, "0.9% 还不到线");
  assert.equal(shouldRemove(99, 1), true, "1.01%");
  assert.equal(shouldRemove(0, 0), false);
  assert.equal(shouldRemove(0, 3), false, "没有浏览数不判比例");
});

t("T17 示例帖永不被下架（示范内容不该消失）", () => {
  assert.equal(shouldRemove(10, 10, { sample: true }), false);
});

t("T18 ratioPct：给用户看的百分比，一位小数", () => {
  assert.equal(ratioPct(1000, 1), "0.1%");
  assert.equal(ratioPct(100, 1), "1.0%");
  assert.equal(ratioPct(0, 0), "0.0%");
});

t("T19 visibleOnly / isVisible：已下架的帖子不进动态流", () => {
  const list = [post(1, 100), post(2, 200, {}, { removed: true }), post(3, 300)];
  assert.deepEqual(visibleOnly(list).map((p) => p.dbId), [1, 3]);
  assert.equal(isVisible({ removed: true }), false);
  assert.equal(isVisible({ removed: false }), true);
  assert.deepEqual(visibleOnly(null), []);
});

/* ═════════ 每人每天一条 ══════════ */

t("T20 postedOnDay：只认「本人 + 云端帖 + 同一天」，示例帖与本地帖不算数", () => {
  const day = "2026-03-06";
  const today = Date.parse("2026-03-06T10:00:00Z");
  const list = [
    { ...post(1, today), cloud: true, userId: "u1" },
    { ...post(2, today), cloud: true, userId: "u2" },
    { id: "s1", sample: true, ts: today },
    { id: 9, ts: today, userId: "u1" },              /* 本地帖：不参与云端限额 */
  ];
  assert.equal(postedOnDay(list, "u1", day), true, "自己的云端帖算");
  assert.equal(postedOnDay(list, "u3", day), false, "别人发的不算我发过");
  assert.equal(postedOnDay(list, "", day), false, "未登录不判");

  const yesterday = [{ ...post(3, Date.parse("2026-03-05T10:00:00Z")), cloud: true, userId: "u1" }];
  assert.equal(postedOnDay(yesterday, "u1", day), false, "昨天的帖不算今天");
  assert.equal(postedOnDay(null, "u1", day), false, "空列表安全");
});

t("T21 canPostToday：云上已发 / 本机今天发过 → 都不给发；换一天恢复", () => {
  const day = "2026-03-06";
  const mine = [{ ...post(1, Date.parse("2026-03-06T10:00:00Z")), cloud: true, userId: "u1" }];
  assert.equal(canPostToday({ list: mine, userId: "u1", day }), false);
  assert.equal(canPostToday({ list: [], userId: "u1", day, localDay: day }), false, "本机记录也算");
  assert.equal(canPostToday({ list: [], userId: "u1", day }), true, "云端没发过、本机没记录");
  assert.equal(canPostToday({ list: mine, userId: "u1", day: "2026-03-07" }), true, "换一天可以发");
  assert.equal(canPostToday({}), true, "默认不拦（本地模式首次进入）");
});

/* ════════ 云错误归类 ══════════ */

t("T22 errorKind：每日限额 / 未跑迁移 / 其它失败分得开", () => {
  assert.equal(errorKind("wall_daily_limit"), "daily-limit");
  assert.equal(errorKind('new row violates check ... "wall_daily_limit"'), "daily-limit");
  assert.equal(errorKind("column wall_posts.views does not exist"), "not-migrated");
  assert.equal(errorKind("column wall_posts.removed does not exist"), "not-migrated");
  assert.equal(errorKind("PGRST202"), "not-migrated");
  assert.equal(errorKind("network timeout"), "");
  assert.equal(errorKind(""), "");
  assert.equal(errorKind(null), "");
});

/* ═════════ 组合：新规矩串起来跑一遍 ═════════ */

t("T23 端到端纯逻辑：记浏览 → 攒到 100 → 1 个厌恶即到 1% → 下架并从列表消失", () => {
  const day = "2026-03-06";
  const list = [post(1, 100, { hug: 0, dislike: 0 }, { views: 0 })];

  /* 100 台不同设备各看一次（各自的本地记录独立；同一设备重复看不再算，见 T11/T12） */
  for (let i = 1; i <= 100; i++) {
    const s = collectViews({}, list, "device-" + i, day);
    if (s.pending.length) list[0].views += 1;   /* 服务端 +1 */
  }
  assert.equal(list[0].views, 100);
  assert.equal(ratioPct(list[0].views, 0), "0.0%");

  assert.equal(shouldRemove(list[0].views, 1), true, "1/100 = 1% 触发下架");
  list[0].removed = true;                      /* 服务端置 removed（假删除） */
  assert.equal(visibleOnly(list).length, 0, "下架后前台不再展示");
});

t("T24 关键存档键名稳定（改名会让老用户的记录读不到）", () => {
  assert.equal(VIEW_KEY, "warm-paws-views-v1");
  assert.equal(ANON_KEY, "warm-paws-anon-v1");
  assert.equal(POST_DAY_KEY, "warm-paws-posted-day-v1");
});

console.log(out.join("\n"));
console.log(`\nTOTAL ${pass + fail}  PASS ${pass}  FAIL ${fail}`);
process.exit(fail ? 1 : 0);
