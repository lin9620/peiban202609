/* 暖心墙进阶规则单测（纯 Node，无需浏览器/服务器/网络）
 *   node tools/wall-rules-test.mjs
 * 覆盖：排序（最新 / 同感 / 抱抱 / 暖暖）· 浏览去重 · 厌恶 1% 下架 · 每人每天一条
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SORTS, SORT_MODES, DEFAULT_SORT, sortPosts, reactCount,
  RANGES, RANGE_KEYS, DEFAULT_RANGE, RANGE_ALL, RANGE_SORTS, usesRange, rangeFor,
  rangeStartTs, inRange,
  VIEW_KEY, ANON_KEY, POST_DAY_KEY, postRef, utcDay, pruneStamps, collectViews,
  DISLIKE_RATIO, REMOVAL_MIN_VIEWS, DISLIKE_MIN_COUNT, dislikeRatio, ratioPct, shouldRemove,
  isVisible, visibleOnly, postedOnDay, canPostToday, errorKind, fmtWhen,
} from "../src/utils/wallRules.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const out = [];
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; out.push("PASS  " + name); }
  catch (e) { fail++; out.push("FAIL  " + name + "  → " + e.message); }
}

const post = (id, ts, reacts = {}, extra = {}) => ({ id: "c" + id, dbId: id, ts, reacts, ...extra });

/* ══════════ 帖子时间：显示到分钟（#25） ══════════ */
/* 注：绝对文案随运行环境时区变，这里只锁「结构」——必须带 时:分，且跨年补年份 */
t("#25 当年时间 → 含 时:分（不再只有月日）", () => {
  const now = new Date(); now.setMonth(8, 19); now.setHours(14, 32, 0, 0);
  const s = fmtWhen(now.getTime(), "zh", now.getTime());
  assert.ok(/\d{1,2}:\d{2}/.test(s), `输出=${s}`);
});
t("#25 跨年 → 补年份（当年则不带）", () => {
  const now = new Date();
  const past = new Date(now); past.setFullYear(now.getFullYear() - 1);
  const a = fmtWhen(past.getTime(), "zh", now.getTime());
  const b = fmtWhen(now.getTime(), "zh", now.getTime());
  assert.ok(a.includes(String(past.getFullYear())), `跨年应带年份，输出=${a}`);
  assert.ok(!b.includes(String(now.getFullYear())), `当年不应再带年份，输出=${b}`);
});
t("#25 非法时间 → 空串（不抛错）", () => {
  assert.equal(fmtWhen("不是时间", "zh"), "");
  assert.equal(fmtWhen(null, "zh"), "");
});
t("#25 英文口径 → 也含 时:分", () => {
  const now = new Date();
  const s = fmtWhen(now.getTime(), "en", now.getTime());
  assert.ok(/\d{1,2}:\d{2}/.test(s), `输出=${s}`);
});

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

t("T14 下架线 = 至少 5 个厌恶 且 1% 比例，阈值常量与需求一致", () => {
  assert.equal(DISLIKE_RATIO, 0.01);
  assert.equal(REMOVAL_MIN_VIEWS, 1);
  assert.equal(DISLIKE_MIN_COUNT, 5);
});

t("T15 dislikeRatio：比例计算 + 没有浏览时为 0（不凭空下架）", () => {
  assert.equal(dislikeRatio(100, 1), 0.01);
  assert.equal(dislikeRatio(200, 3), 0.015);
  assert.equal(dislikeRatio(0, 5), 0);
  assert.equal(dislikeRatio("x", "y"), 0);
  assert.equal(dislikeRatio(10, 99), 1, "比例封顶 1，不会 >100%");
});

t("T16 shouldRemove：≥5 个厌恶 且 ≥1% 才下架（#21 单人点不掉）", () => {
  assert.equal(shouldRemove(100, 1), false, "1 个厌恶就算 1% 也不下架：没到 5 个");
  assert.equal(shouldRemove(100, 4), false, "4 个还差一个");
  assert.equal(shouldRemove(100, 5), true, "5 个厌恶 + 5% 比例 → 下架");
  assert.equal(shouldRemove(1000, 10), true, "1000 浏览 10 厌恶 = 1% 且 ≥5 → 下架");
  assert.equal(shouldRemove(1000, 9), false, "0.9% 还不到线");
  assert.equal(shouldRemove(1000, 4), false, "0.4% 且不足 5 个");
  assert.equal(shouldRemove(999, 5), false, "够了 5 个但只有 0.5% → 不下架");
  assert.equal(shouldRemove(0, 5), false, "没有浏览数不判比例");
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
  /* 真实响应：码在 error.code，消息里没有 PGRST202（只匹配消息会漏判 → 用户看到英文报错） */
  assert.equal(errorKind("Could not find the function public.wall_toggle_dislike(p_post bigint) in the schema cache", "PGRST202"), "not-migrated");
  assert.equal(errorKind("Could not find the function public.wall_toggle_dislike(p_post bigint) in the schema cache"), "not-migrated");
  assert.equal(errorKind("", "PGRST202"), "not-migrated");
  assert.equal(errorKind("network timeout"), "");
  assert.equal(errorKind(""), "");
  assert.equal(errorKind(null), "");
});

/* ═════════ 时间范围（默认近两天；另有 近 7 天 / 这个月） ══════════ */

t("T25 时间范围：共 3 档，默认近两天，key 与 i18n 对齐", () => {
  assert.equal(RANGES.length, 3);
  assert.deepEqual(RANGES.map((r) => r.key), ["2d", "7d", "month"]);
  assert.deepEqual(RANGE_KEYS, ["2d", "7d", "month"]);
  assert.equal(DEFAULT_RANGE, "2d");
  for (const r of RANGES) assert.ok(r.tk.startsWith("community.range"), "i18n key: " + r.tk);
});

t("T26 rangeStartTs：近 2 天 / 近 7 天 / 本月 1 日 0 点（UTC）；未知档回退近两天", () => {
  const now = Date.parse("2026-03-06T12:00:00Z");
  assert.equal(rangeStartTs("2d", now), now - 2 * 86400000);
  assert.equal(rangeStartTs("7d", now), now - 7 * 86400000);
  assert.equal(rangeStartTs("month", now), Date.UTC(2026, 2, 1), "3 月 → 2026-03-01T00:00:00Z");
  assert.equal(rangeStartTs("bogus", now), now - 2 * 86400000);
  assert.equal(rangeStartTs(undefined, now), now - 2 * 86400000);
});

t("T27 inRange：边界内外、跨月归 UTC 月、示例帖永在、无时间戳不显示", () => {
  const now = Date.parse("2026-03-06T12:00:00Z");
  const p = (ts) => ({ id: 1, ts });
  assert.equal(inRange(p(now - 86400000), "2d", now), true, "1 天前 ∈ 近两天");
  assert.equal(inRange(p(now - 3 * 86400000), "2d", now), false, "3 天前 ∉ 近两天");
  assert.equal(inRange(p(now - 6 * 86400000), "7d", now), true, "6 天前 ∈ 近 7 天");
  assert.equal(inRange(p(now - 9 * 86400000), "7d", now), false, "9 天前 ∉ 近 7 天");
  assert.equal(inRange(p(Date.parse("2026-03-01T00:00:00Z")), "month", now), true, "本月 1 日 ∈ 这个月");
  assert.equal(inRange(p(Date.parse("2026-02-28T23:59:59Z")), "month", now), false, "上月末 ∉ 这个月");
  assert.equal(inRange(p(now - 3 * 86400000), "bogus", now), false, "未知档回退近两天 → 3 天前不在");
  assert.equal(inRange(null, "2d", now), false);
  assert.equal(inRange({ id: 2 }, "2d", now), false, "没有时间戳不显示（不瞎猜）");
  assert.equal(inRange({ id: "s1", sample: true, ts: 0 }, "2d", now), true, "示例帖不参与筛选");
});

t("T28 端到端：范围筛掉旧帖后，热度排序仍在剩下的帖里生效", () => {
  const now = Date.parse("2026-03-06T12:00:00Z");
  const list = [
    { id: 1, ts: now - 86400000, reacts: { relate: 1 } },          // 1 天前，同感 1
    { id: 2, ts: now - 3600000, reacts: { relate: 0 } },           // 1 小时前，同感 0
    { id: 3, ts: now - 40 * 86400000, reacts: { relate: 99 } },    // 40 天前，同感再多也被范围筛掉
    { id: 4, ts: now - 7200000, removed: true, reacts: { relate: 5 } }, // 已下架
  ];
  const out = sortPosts(visibleOnly(list).filter((x) => inRange(x, "2d", now)), "relate");
  assert.deepEqual(out.map((x) => x.id), [1, 2], "下架的 4 与超范围的 3 都不见；同感多的 1 排前");
});

/* ═════════ 组合：新规矩串起来跑一遍 ═════════ */

t("T23 端到端纯逻辑：记浏览 → 攒到 100 → 凑够 5 个厌恶达 1% → 下架并从列表消失", () => {
  const day = "2026-03-06";
  const list = [post(1, 100, { hug: 0, dislike: 0 }, { views: 0 })];

  /* 100 台不同设备各看一次（各自的本地记录独立；同一设备重复看不再算，见 T11/T12） */
  for (let i = 1; i <= 100; i++) {
    const s = collectViews({}, list, "device-" + i, day);
    if (s.pending.length) list[0].views += 1;   /* 服务端 +1 */
  }
  assert.equal(list[0].views, 100);
  assert.equal(ratioPct(list[0].views, 0), "0.0%");

  assert.equal(shouldRemove(list[0].views, 4), false, "4 个厌恶：够 4% 但没到 5 个，不下架");
  assert.equal(shouldRemove(list[0].views, 5), true, "5/100 = 5% 且 ≥5 个 → 触发下架");
  list[0].removed = true;                      /* 服务端置 removed（假删除） */
  assert.equal(visibleOnly(list).length, 0, "下架后前台不再展示");
});

t("T24 关键存档键名稳定（改名会让老用户的记录读不到）", () => {
  assert.equal(VIEW_KEY, "warm-paws-views-v1");
  assert.equal(ANON_KEY, "warm-paws-anon-v1");
  assert.equal(POST_DAY_KEY, "warm-paws-posted-day-v1");
});

t("T29 时间范围只属于「最新」之外的排序：usesRange / rangeFor（含脏值兜底）", () => {
  assert.deepEqual(RANGE_SORTS, ["relate", "hug", "warm"]);
  assert.equal(RANGE_ALL, "all");
  assert.ok(!RANGE_KEYS.includes(RANGE_ALL), "「不筛时间」不能变成一颗按钮");

  assert.equal(usesRange("new"), false, "最新 → 不显示范围按钮");
  for (const s of ["relate", "hug", "warm"]) assert.equal(usesRange(s), true, s);
  assert.equal(usesRange("bogus"), false, "脏排序值不会莫名冒出一排按钮");
  assert.equal(usesRange(undefined), false);

  assert.equal(rangeFor("new", "7d"), RANGE_ALL, "最新 → 不筛时间（不偷偷沿用旧档位）");
  assert.equal(rangeFor("new", undefined), RANGE_ALL);
  assert.equal(rangeFor("relate", "7d"), "7d", "热度排序 → 用用户选的档位");
  assert.equal(rangeFor("hug", "bogus"), DEFAULT_RANGE, "脏档位回退近两天");
  assert.equal(rangeFor("warm", undefined), DEFAULT_RANGE);
});

t("T30 inRange 支持 RANGE_ALL：最新看全部，但仍不显示无时间戳的帖", () => {
  const now = Date.parse("2026-03-06T12:00:00Z");
  const old = { id: 1, ts: now - 40 * 86400000 };
  assert.equal(inRange(old, RANGE_ALL, now), true, "40 天前的帖在「最新」下也看得到");
  assert.equal(inRange({ id: 2 }, RANGE_ALL, now), false, "没有时间戳不显示（不瞎猜）");
  assert.equal(inRange({ id: "s1", sample: true, ts: 0 }, RANGE_ALL, now), true, "示例帖永在");
  assert.equal(inRange(null, RANGE_ALL, now), false);
});

t("T31 端到端：切「最新」看全部并按时间倒序；切「同感最多」按窗口筛后再排序", () => {
  const now = Date.parse("2026-03-06T12:00:00Z");
  const list = [
    { id: 1, ts: now - 86400000, reacts: { relate: 1 } },            // 1 天前，同感 1
    { id: 2, ts: now - 3600000, reacts: { relate: 0 } },             // 1 小时前
    { id: 3, ts: now - 40 * 86400000, reacts: { relate: 99 } },      // 40 天前，同感最多
    { id: 4, ts: now - 7200000, removed: true, reacts: { relate: 5 } }, // 已下架
  ];
  const render = (sort, range) => sortPosts(
    visibleOnly(list).filter((x) => inRange(x, rangeFor(sort, range), now)), sort
  ).map((x) => x.id);

  assert.deepEqual(render("new", "2d"), [2, 1, 3], "最新：不筛时间，全按时间倒序（旧帖也在）");
  assert.deepEqual(render("relate", "2d"), [1, 2], "同感最多 + 近两天：40 天前的 99 个同感被窗口筛掉");
  assert.deepEqual(render("relate", "month"), [1, 2], "本月的也筛掉 40 天前那条");
});

t("T32 页面接线：范围行由 usesRange 显隐，筛选走 rangeFor 单一入口", () => {
  const src = read("src/views/CommunityView.vue");
  assert.ok(src.includes("usesRange, rangeFor"), "未从 wallRules.js 导入这两个规则");
  assert.ok(src.includes('v-if="usesRange(sortMode)"'), "范围行未按排序方式显隐");
  assert.ok(/v-if="!usesRange\(sortMode\)"|v-if="usesRange\(sortMode\)"/.test(src), "缺少范围行的条件");
  assert.ok(src.includes("inRange(p, rangeFor(sortMode.value, rangeMode.value))"),
    "筛选未走 rangeFor（会出现「按钮藏了但筛选还在偷偷生效」）");
  assert.ok(!src.includes("inRange(p, rangeMode.value)"), "仍在直接用未加工的档位筛选");
});

console.log(out.join("\n"));
console.log(`\nTOTAL ${pass + fail}  PASS ${pass}  FAIL ${fail}`);
process.exit(fail ? 1 : 0);
