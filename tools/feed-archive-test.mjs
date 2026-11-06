/* 两处「防帖量长大」加固的回归测试（Node 直跑：node tools/feed-archive-test.mjs）
 * ---------------------------------------------------------------------------
 * 轮 433，用户问：「536 条全部拉进内存，那以后用户刷的帖子很多之后，不会很卡顿或者有其他影响吗」
 * 结论是 536 条撑得住，但有两处会随帖量线性恶化，先廉价填掉：
 *
 *  ① 收藏态查询：旧写法每次追加一页就把**全部已加载 id** 重发一次 in(...)。
 *     536 条时 URL 已经很长，几千条会撑爆/变慢。改成只问「没问过的」那批（FAV_BATCH 分批）。
 *  ② 离场存档：旧写法全量 JSON.stringify，超 1.5MB **整份放弃** → 存档静默失效、
 *     回来从头拉第一页。改成预算阶梯：整份 → 去高度表 → 只留窗口（游标跟着退）→ 再砍。
 *
 * 本文件钉：存档四档行为（真跑纯函数）+ 收藏增量查询的接线（源码断言）。
 */
import { readFileSync } from "node:fs";
import {
  buildFeedArchive, ARCHIVE_BUDGET, ARCHIVE_ROWS, ARCHIVE_MIN_ROWS,
} from "../src/utils/feedArchive.js";

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log("PASS ", name); }
  else { fail++; console.log("FAIL ", name); }
}

const community = readFileSync(new URL("../src/views/CommunityView.vue", import.meta.url), "utf8");

/* ══════════ ① 离场存档：预算阶梯 ══════════ */
/* 造一堵墙：每条约 190 字符，id 形如 "c1000"，dbId 递减（与线上同形：新→旧） */
function wall(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: "c" + (100000 - i),
    dbId: 100000 - i,
    name: "毛孩子家长" + (i % 7),
    text: "今天的猫又拆家了，第 " + i + " 次 " + "喵".repeat(60),
    ts: 1762000000000 - i * 60000,
  }));
}
function posOf(n, extra = {}) {
  const rows = wall(n);
  const heights = {};
  const cmtTotal = {};
  for (const r of rows) { heights[r.id] = 268; cmtTotal[r.id] = 3; }
  return {
    y: 0, pane: 48000, reveal: n, cursor: rows[rows.length - 1].dbId,
    done: true, newestTs: rows[0].ts, rows, heights, cmtTotal, ...extra,
  };
}
/* 某个「保留 n 条」的存档有多大（用于反推预算，避免测试依赖魔法数字） */
function sizeOf(n, keepHeights = true) {
  const p = posOf(n);
  return JSON.stringify({
    ...p, rows: p.rows, heights: keepHeights ? p.heights : {}, cmtTotal: p.cmtTotal,
  }).length;
}

/* A1 预算充足 → 原样存（rows / heights / cursor / done 一个不动） */
{
  const p = posOf(200);
  const blob = buildFeedArchive(p);
  const back = JSON.parse(blob);
  ok("A1 预算充足时整份落盘（rows/heights 全在）",
    back.rows.length === 200 && Object.keys(back.heights).length === 200
    && back.cursor === p.cursor && back.done === true && back.reveal === 200);
}

/* A2 只差一点 → 扔掉高度表，rows 仍然一条不少（不能因为高度表就截断） */
{
  const p = posOf(200);
  const full = sizeOf(200, true);
  const noH = sizeOf(200, false);
  const budget = noH + Math.floor((full - noH) / 2);
  const back = JSON.parse(buildFeedArchive(p, { budget }));
  ok("A2 超预算先扔高度表，rows 仍是全量",
    back.rows.length === 200 && Object.keys(back.heights).length === 0
    && back.cursor === p.cursor && back.done === true);
}

/* A3 去高度表也放不下 → 只留窗口，游标退到窗口末尾、done 放开、reveal 收敛 */
{
  const p = posOf(1000);
  const budget = sizeOf(200, true) + 2000;    /* 装得下 200 条（含高度表），装不下 400 条 */
  const back = JSON.parse(buildFeedArchive(p, { budget }));
  ok("A3 截成窗口：条数 ≤ ARCHIVE_ROWS 且确实截短了",
    back.rows.length > 0 && back.rows.length < 1000 && back.rows.length <= ARCHIVE_ROWS);
  ok("A3 游标退到窗口末尾（翻页无缝接上，不跳帖）",
    back.cursor === back.rows[back.rows.length - 1].dbId);
  ok("A3 done 放开为 false（后面还有货，别报「就到这里」）", back.done === false);
  ok("A3 reveal 收敛到窗口长度",
    back.reveal === back.rows.length && back.reveal > 0);
  ok("A3 heights / cmtTotal 只留窗口内的键",
    Object.keys(back.heights).length === back.rows.length
    && Object.keys(back.cmtTotal).length === back.rows.length);
}

/* A4 窗口还得再砍 → 落到 ARCHIVE_MIN_ROWS 一档，仍然可用 */
{
  const p = posOf(1000);
  const budget = sizeOf(ARCHIVE_MIN_ROWS, true) + 500;   /* 只装得下最小窗口 */
  const back = JSON.parse(buildFeedArchive(p, { budget }));
  ok("A4 预算很紧时退到最小窗口（≥1 条且 < ARCHIVE_ROWS）",
    back.rows.length > 0 && back.rows.length < ARCHIVE_ROWS);
  ok("A4 最小窗口仍保持游标自洽", back.cursor === back.rows[back.rows.length - 1].dbId);
}

/* A5 怎么都放不下 → 返回 ""（调用方不写盘，而不是写半个坏存档） */
{
  ok("A5 预算小于单条也放不下时返回空串", buildFeedArchive(posOf(500), { budget: 300 }) === "");
  ok("A6 没帖子时返回空串", buildFeedArchive({ ...posOf(1), rows: [] }) === "");
}

/* A7 未截断就不许动原来的 cursor / done（否则会把「已到底」改回「还有货」） */
{
  const p = posOf(300, { done: true, cursor: 424242 });
  const back = JSON.parse(buildFeedArchive(p, { budget: ARCHIVE_BUDGET }));
  ok("A7 未截断时 cursor / done 原样保留", back.cursor === 424242 && back.done === true);
}

/* A8 常量合理性：400 条的窗口在预算内绰绰有余 */
{
  ok("A8 窗口上限条数与预算同量级（400 条 ≈ 预算的 1/5）",
    ARCHIVE_ROWS === 400 && ARCHIVE_MIN_ROWS === 120
    && sizeOf(ARCHIVE_ROWS, true) < ARCHIVE_BUDGET);
}

/* ══════════ ② 收藏态：增量查询 ══════════ */
const favStart = community.indexOf("async function refreshFav(");
const favEnd = community.indexOf("watch(() => cloudPosts.value", favStart);
const fav = community.slice(favStart, favEnd > 0 ? favEnd : favStart + 2000);

ok("B1 有「已问过」账本与分批上限",
  /const favKnown = new Set\(\)/.test(community) && /const FAV_BATCH = 200/.test(community));
ok("B2 只问没问过的（fresh），不再重发全量 id",
  /const fresh = all\.filter\(\(id\) => !favKnown\.has\(id\)\)/.test(fav)
  && !/cloudFavIds\(ids\)/.test(fav));
ok("B3 查询按 FAV_BATCH 分批（不撑 URL 长度）",
  /cloudFavIds\(fresh\.slice\(i, i \+ FAV_BATCH\)\)/.test(fav));
ok("B4 结果并集写入（不会把刚点的收藏抹掉）",
  /const next = new Set\(favSet\.value\)/.test(fav) && /next\.add\(id\)/.test(fav)
  && !/favSet\.value = new Set\(await/.test(fav));
ok("B5 没新 id 就一个请求都不发",
  /if \(!fresh\.length\) return;/.test(fav));
ok("B6 只有换人（登录态变化）才清账重问",
  /watch\(signedIn, \(\) => \{ refreshFav\(true\); \}\)/.test(community)
  && /watch\(\(\) => cloudPosts\.value, \(\) => \{ refreshFav\(\); \}\)/.test(community));

/* ══════════ ③ 接线 ══════════ */
ok("C1 CommunityView 用纯函数存档（不再内联 stringify + 1.5MB 硬阈值）",
  /import \{ buildFeedArchive \} from "\.\.\/utils\/feedArchive\.js"/.test(community)
  && !/1500000/.test(community));
ok("C2 存档失败不写盘（不写半个坏存档）",
  /const blob = buildFeedArchive\(savedFeedPos\);\s*\n\s*if \(blob\) setItem\(FEED_ARCHIVE_KEY, blob\);/.test(community));

console.log(`\nTOTAL ${pass + fail}  PASS ${pass}  FAIL ${fail}`);
process.exit(fail ? 1 : 0);
