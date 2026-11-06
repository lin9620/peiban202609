/* 暖心墙「推荐流滚到底就滑不动」回归测试（Node 直跑：node tools/wall-end-test.mjs）
 * ---------------------------------------------------------------------------
 * 背景（轮 432，用户截图实报）：
 *   「点了几下同感最多/抱抱最多，然后回到暖心墙推荐页面下滑，然后就到底了不能滑动了」
 *   —— 截图底部是「就到这里啦——晚点再来看看新的吧」，最后两张卡是 10 月 12 日的巡检帖。
 *
 * 线上实测（2026-11-06，536 条可见帖的日期分布）：
 *   近 2 天 0 条 · 近 7 天 0 条 · 近 30 天 11 条（10-22 的 1 条 + 10-12 的 10 条）
 *   其余 503 条全在 09-24（压测批），再往前 22 条。
 *
 * 病根：feedTick 里「推荐窗放宽」被 `!cloudDone` 挡住了 ——
 *   `if (sortMode === "recommend" && !hasMore && !cloudDone) widenRec();`
 *   而放宽是**纯本地动作**（数据已在内存里）。于是**全库都拉进内存（cloudDone=true）**
 *   反而成了放宽的拦路虎：推荐窗死钉在「近 30 天」那一档 = 11 条，亮完就报「到底」，
 *   另外 503 条永远放宽不出来。cloudDone 之所以是 true，是因为点「同感最多 + 近两天」时
 *   列表被筛成 0 条、触底自愈一路往后翻页，把全库拉完了。
 *
 * 本文件钉四件事：
 *   ① 推荐窗的三档数字（7 天不够 → 30 天 11 条 → 全部 536 条）与线上实测一致；
 *   ② feedTick 的放宽判断**不许**再看 cloudDone（!hasMore 才是唯一条件）；
 *   ③ 「就到这里啦」只在推荐窗开到最后一档时出现（否则 11 条就报到底 = 用户看到的假到底）；
 *   ④ 时间档把内容全挡空时不再往服务端翻页（旧行为：白翻十几次、把全库拉进内存）。
 */
import { readFileSync } from "node:fs";
import { recommendPosts } from "../src/utils/wallRules.js";

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log("PASS ", name); }
  else { fail++; console.log("FAIL ", name); }
}

const community = readFileSync(new URL("../src/views/CommunityView.vue", import.meta.url), "utf8");
const tpl = community.slice(community.indexOf("<template>"));
/* feedTick 整段（放宽判断与续载都在这段里） */
const tick = community.slice(community.indexOf("function feedTick"),
  community.indexOf("function scheduleFeedIdle"));

/* ══════════ ① 推荐窗三档：拿线上真实日期分布跑纯函数 ══════════ */
const DAY = 86400000;
const NOW = Date.UTC(2026, 10, 6, 1, 0, 0);   /* 2026-11-06 */
function batch(n, daysAgo, tag) {
  return Array.from({ length: n }, (_, i) => ({
    id: `${tag}-${i}`, dbId: i + 1, ts: NOW - daysAgo * DAY + i * 1000, text: tag, reacts: {},
  }));
}
/* 与线上同形：15 天前 1 条、25 天前 10 条、43 天前 503 条、60 天前 22 条 */
const WALL = [...batch(1, 15, "d15"), ...batch(10, 25, "d25"), ...batch(503, 43, "d43"), ...batch(22, 60, "d60")];
ok("T1 造出来的墙与线上同规模（536 条）", WALL.length === 536);

const at = (days) => recommendPosts(WALL, { days, now: NOW, salt: "test" }).length;
ok("T2 近 7 天窗内确实 0 条（线上实测）", at(7) === 11 && recommendPosts(WALL, { days: 7, minPool: 0, now: NOW }).length === 0);
ok("T3 近 30 天窗 = 11 条（用户截图里那 11 张卡）", at(30) === 11);
ok("T4 窗口开到「全部」= 536 条（那 503 条压测帖必须能放宽出来）", at(Infinity) === 536);
ok("T5 默认档（7 天，池子不够自动降级到 30 天）也是 11 条 —— 与线上表现一致", at(7) === 11);

/* ══════════ ② 放宽不许再看 cloudDone ══════════ */
/* 轮447：关注流没有推荐窗，放宽前面多了 !followOnly 守卫 —— 断言允许这个前缀，
   但「推荐 + 已亮完」这个核心条件一个都不能少（少一个就退回轮 432 的老病）。 */
const REC_GUARD = /if \((?:!followOnly\.value && )?sortMode\.value === "recommend" && !hasMore\.value\) widenRec\(\);/;
ok("T6 feedTick 的放宽条件只剩「推荐 + 已亮完」", REC_GUARD.test(tick));
ok("T7 放宽条件里没有 cloudDone 闸门（有它就是「全库拉完反而放宽不了」的老病）",
  !/widenRec\(\);/.test(tick.replace(REC_GUARD, "")));
ok("T8 放宽仍必须排在 reveal 补齐之后（否则一进页就一路升到全部）",
  tick.indexOf("if (hasMore.value) reveal.value") < tick.indexOf("widenRec();"));

/* ══════════ ③ 「就到这里啦」只在最后一档 ══════════ */
ok("T9 有 recMaxed（推荐窗是否已到最后一档）", /const recMaxed = computed\(/.test(community));
ok("T10 recMaxed 认的是 REC_LEVELS 的最后一档（不写死 Infinity 比较）",
  /recDays\.value === REC_LEVELS\[REC_LEVELS\.length - 1\]/.test(community));
ok("T11 有 feedEnd，且把 recMaxed 算进「到底」",
  /const feedEnd = computed\(/.test(community) && /cloudDone\.value && recMaxed\.value/.test(community));
ok("T12 模板用 feedEnd（不再是裸的 !hasMore && cloudDone）",
  /<p v-if="feedEnd"/.test(tpl) && !/v-if="shownPage\.length && !hasMore && cloudDone"/.test(tpl));
ok("T13 搜索态不借用信息流的「到底」（搜索有自己的 searchDone）",
  /!searchActive\.value && shownPage\.value\.length > 0/.test(community));

/* ══════════ ④ 空筛选不再狂翻页 ══════════ */
ok("T14 有时间档全挡空时的翻页闸门 rangeStarved",
  /const rangeStarved = (?:!followOnly\.value && )?usesRange\(sortMode\.value\) && !shown\.value\.length && !!all\.value\.length/.test(community));
ok("T15 rangeStarved 真的挡住了 loadMoreCloud",
  /if \(!cloudDone\.value && !rangeStarved && notShown < REVEAL_STEP \/ 2\) loadMoreCloud\(\);/.test(tick));

console.log(`\nTOTAL ${pass + fail}  PASS ${pass}  FAIL ${fail}`);
process.exit(fail ? 1 : 0);
