/* 暖心墙「筛选筛空 → 空白页」回归测试（Node 直跑）
 *   node tools/wall-empty-test.mjs
 *
 * 背景（轮 428）：用户实报「点击同感最多，近两天，当没有内容直接空白了，连个提示都没有」。
 * 旧空状态的条件是 `cloudPosts.length === 0` —— 只看云端**拉没拉到**，不看**筛完还剩几条**。
 * 「同感最多 + 近两天」（2 天滚动窗）在墙冷清时筛出 0 条：cloudPosts 有货 → 空状态不画；
 * pageItems 空 → 一张卡不画 → 页面只剩两排筛选按钮，下面纯空白。
 *
 * 这套测试钉四件事：
 *   ① 空状态必须分两类（墙真空 / 被筛选挡空），不能又退回只看 cloudPosts；
 *   ② 筛选空态必须**排除搜索态与加载态**（那两种各有自己的提示，混进来会闪一下）；
 *   ③ 出口必须真的能点通（放宽范围 → 回推荐 → 刷新 三级降级，不许渲染死按钮）；
 *   ④ 文案中英都得在（漏英文 = 英文用户又看空白）。
 */
import { readFileSync } from "node:fs";
import { widerRange } from "../src/utils/wallRules.js";

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log("PASS ", name); }
  else { fail++; console.log("FAIL ", name); }
}

const community = readFileSync(new URL("../src/views/CommunityView.vue", import.meta.url), "utf8");
const i18n = readFileSync(new URL("../src/i18n.js", import.meta.url), "utf8");
const rules = readFileSync(new URL("../src/utils/wallRules.js", import.meta.url), "utf8");
const tpl = community.slice(community.indexOf("<template>"));

/* —— ① 纯函数：放宽一档 —— */
ok("T1 近两天 → 近 7 天", widerRange("2d") === "7d");
ok("T2 近 7 天 → 近 30 天", widerRange("7d") === "month");
ok("T3 近 30 天已最宽 → 空串（没有下一档，UI 才能降级成别的出口）", widerRange("month") === "");
ok("T4 脏档位 → 回落到最窄档（不让空态卡在上一个怪值上）", widerRange("bogus") === "2d");
ok("T5 规则来自 RANGE_KEYS 顺序（不另写一份 next 表）",
  /export function widerRange\(range\)[\s\S]{0,200}RANGE_KEYS/.test(rules));
ok("T6 页面 import 了 widerRange", /rangeFor, widerRange,/.test(community));

/* —— ② 两类空状态 —— */
ok("T7 有 feedEmpty（墙真空 → 发帖引导）", /const feedEmpty = computed\(/.test(community));
ok("T8 有 filterEmpty（有内容但被筛选挡空）", /const filterEmpty = computed\(/.test(community));

const fe = (community.match(/const feedEmpty = computed\([\s\S]*?\);/) || [""])[0];
const filt = (community.match(/const filterEmpty = computed\([\s\S]*?\n\);/) || [""])[0];
ok("T9 filterEmpty 看「筛完有没有」（shown），不是「拉到没有」（cloudPosts）",
  /shown\.value\.length/.test(filt) && !/cloudPosts/.test(filt));
ok("T10 filterEmpty 要求 all 非空（墙真空时走发帖引导，不误报「换个范围」）",
  /all\.value\.length/.test(filt));
ok("T11 filterEmpty 排除搜索态（搜索无结果已有自己的「没有找到」）", /!searchActive\.value/.test(filt));
ok("T12 filterEmpty 排除加载态（首屏还在拉的时候不许闪空态）", /!loadingCloud\.value/.test(filt));
ok("T13 两类口径互斥（all 空 / all 非空）",
  /!all\.value\.length/.test(fe) && /!!all\.value\.length/.test(filt));

/* —— ③ 模板：两个分支紧邻 + 出口能点通 —— */
ok("T14 模板 v-if=feedEmpty", /<div v-if="feedEmpty" class="wall-empty">/.test(tpl));
ok("T15 模板 v-else-if=filterEmpty（紧邻，不会两块同时画）",
  /<div v-else-if="filterEmpty" class="wall-empty wall-empty--filter">/.test(tpl));
ok("T16 模板里不再有 cloudPosts.length === 0 的判空（旧病根）",
  !/cloudPosts\.length === 0/.test(tpl));

const act = (community.match(/const emptyAction = computed\([\s\S]*?\n\}\);/) || [""])[0];
ok("T17 出口先问「还能不能放宽」", /widerRange\(rangeMode\.value\)/.test(act));
ok("T18 已最宽时回推荐，不是死按钮", /"sort"/.test(act) && /recommend/.test(act));
ok("T19 推荐模式自身为空 → 刷新", /"refresh"/.test(act));
ok("T20 放宽按钮绑了 pickRange(emptyAction.key)", /@click="pickRange\(emptyAction\.key\)"/.test(community));
ok("T21 回推荐按钮绑了 pickSort('recommend')", /@click="pickSort\('recommend'\)"/.test(community));
ok("T22 刷新按钮绑了 manualRefresh（带 pin，刷新后不留残高）",
  /@click="manualRefresh\(\{ pin: true \}\)"/.test(community));

/* —— ④ 文案：中英齐全 + 带当前筛选口径 —— */
for (const key of ["filterEmptyTitle", "filterEmptyDesc", "filterEmptyWiden", "filterEmptyRec", "filterEmptyRefresh"]) {
  const n = (i18n.match(new RegExp(`${key}:`, "g")) || []).length;
  ok(`T23 文案 ${key} 中英都有（出现 2 次）`, n === 2);
}
ok("T24 说明里带 {scope}（告诉用户现在筛的是哪一档，不然等于没说清为什么空）",
  /filterEmptyDesc: "[^"]*\{scope\}[^"]*"/.test(i18n));
ok("T25 放宽按钮带 {range} 占位（按钮文案跟着下一档走）",
  /filterEmptyWiden: "[^"]*\{range\}[^"]*"/.test(i18n));

/* —— ⑤ emptyScope：范围排序报「排序 · 范围」，推荐只报排序 —— */
const scope = (community.match(/const emptyScope = computed\([\s\S]*?\n\}\);/) || [""])[0];
ok("T26 推荐这类无范围的排序只报排序名", /usesRange\(sortMode\.value\)/.test(scope) && /return name/.test(scope));
ok("T27 有范围的排序拼成「排序 · 范围」", /`\$\{name\} · \$\{t\(r\.tk\)\}`/.test(scope));

console.log(`\n${fail ? "FAILED" : "OK"}  ${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
