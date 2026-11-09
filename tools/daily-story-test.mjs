/* 轮 458 · 今日页故事（按日期 + 5 语言）纯逻辑回归
 * ------------------------------------------------------------
 * 不连网络：只测 src/utils/dailyStory.js 的日期 / 语言回退 / 校验，
 * 再静态确认 TodayPane、AdminView、Worker、迁移文件都接上了这条链路。
 *
 * 运行：node tools/daily-story-test.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DAILY_STORY_LANGS, DAILY_STORY_LIMITS,
  emptyDailyContent, normalizeDailyContent, pickDailyContent, dailyStoryTitle,
  dailyLangHasStory, hasDailyStory, validateDailyContent,
  isoDate, isIsoDate, shiftIsoDate, dailyFormFilled,
} from "../src/utils/dailyStory.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
const fails = [];
function ok(name, cond, extra = "") {
  if (cond) pass++;
  else fails.push(name + (extra ? ` — ${extra}` : ""));
}
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

/* ── 形状 ── */
{
  const c = emptyDailyContent();
  ok("空内容：5 种语言", DAILY_STORY_LANGS.every((l) => c[l]));
  ok("空内容：3 个字段都为空",
    DAILY_STORY_LANGS.every((l) => c[l].title === "" && c[l].body === "" && c[l].quote === ""));
}
{
  const c = normalizeDailyContent({
    zh: { title: "  标题  ", body: " 第一行\n第二行 ", quote: "  语录 " },
    en: { title: 123, body: "ok" },
    de: { title: "ignored" },
  });
  ok("归一化：trim + 保留换行", c.zh.title === "标题" && c.zh.body === "第一行\n第二行" && c.zh.quote === "语录");
  ok("归一化：非字符串忽略", c.en.title === "" && c.en.body === "ok");
  ok("归一化：只保留 5 种语言", !("de" in c));
}
{
  const long = "x".repeat(DAILY_STORY_LIMITS.body + 20);
  const c = normalizeDailyContent({ zh: { body: long } });
  ok("归一化：正文按上限截断", c.zh.body.length === DAILY_STORY_LIMITS.body);
}
{
  ok("坏输入：null → 空内容", normalizeDailyContent(null).zh.title === "");
  ok("坏输入：数组 → 空内容", normalizeDailyContent([]).en.body === "");
}

/* ── 语言回退 ── */
{
  const c = {
    zh: { title: "中文标题", body: "中文正文", quote: "中文语录" },
    en: { title: "English title", body: "English body", quote: "English quote" },
  };
  const zh = pickDailyContent(c, "zh-CN");
  const en = pickDailyContent(c, "en-US");
  const es = pickDailyContent(c, "es");
  ok("回退：中文读者拿中文", zh && zh.lang === "zh" && zh.title === "中文标题" && zh.fallback === false);
  ok("回退：英文读者拿英文", en && en.lang === "en" && en.title === "English title");
  ok("回退：西语缺内容 → 英文", es && es.lang === "en" && es.fallback === true);
}
{
  const c = { zh: { title: "只有中文", body: "正文" } };
  const es = pickDailyContent(c, "es");
  ok("回退：只有中文时西语读者拿中文", es && es.lang === "zh" && es.fallback === true);
}
{
  const c = { es: { quote: "solo una frase" } };
  ok("只有 quote 不算有故事", !dailyLangHasStory(c, "es") && !hasDailyStory(c) && pickDailyContent(c, "es") === null);
}
{
  const c = { zh: { title: "标题", body: "正文" } };
  ok("标题：没有 title 时截正文", dailyStoryTitle(c, "en", 2) === "标题");
  const bodyOnly = { zh: { body: "一二三四五" } };
  ok("标题：正文截断", dailyStoryTitle(bodyOnly, "zh", 2) === "一二");
}

/* ── 表单 / 校验 ── */
{
  const f = emptyDailyContent();
  f.zh.title = "有";
  f.en.body = "yes";
  const filled = dailyFormFilled(f);
  ok("表单圆点：中文/英文有内容", filled.zh === true && filled.en === true && filled.fr === false);
}
{
  ok("校验：没有中文内容 → need-content", validateDailyContent(emptyDailyContent()) === "need-content");
  const tooLong = emptyDailyContent();
  tooLong.zh.title = "x".repeat(DAILY_STORY_LIMITS.title + 1);
  ok("校验：标题超长 → too-long", validateDailyContent(tooLong).startsWith("too-long:zh:title"));
  const okContent = emptyDailyContent();
  okContent.zh.body = "正文";
  ok("校验：有中文正文 → 通过", validateDailyContent(okContent) === "");
  const enOnly = emptyDailyContent();
  enOnly.en.body = "English only";
  ok("校验：只填英文也可发布（页面按语言回退）", validateDailyContent(enOnly) === "");
}

/* ── 日期 ── */
{
  ok("日期：本地 Date → YYYY-MM-DD", isoDate(new Date(2026, 10, 8, 23, 30)) === "2026-11-08");
  ok("日期：合法日期", isIsoDate("2026-11-08") && isIsoDate("2024-02-29"));
  ok("日期：拒绝 2026-02-31", !isIsoDate("2026-02-31"));
  ok("日期：拒绝脏字符串", !isIsoDate("2026-11-8") && !isIsoDate(""));
  ok("日期：加减天数", shiftIsoDate("2026-11-08", 1) === "2026-11-09"
    && shiftIsoDate("2026-11-08", -1) === "2026-11-07"
    && shiftIsoDate("2026-12-31", 1) === "2027-01-01");
  ok("日期：坏输入返回空串", shiftIsoDate("bad", 1) === "");
}

/* ── 静态接线：别只写纯函数，页面/网关/迁移也要在 ── */
{
  const today = read("src/components/TodayPane.vue");
  ok("TodayPane：导入 dailyStory", today.includes("utils/dailyStory.js"));
  ok("TodayPane：按日期读云端", today.includes("db.dailyStoryGet(date)"));
  ok("TodayPane：有本地缓存", today.includes("wp-daily-story:"));
  ok("TodayPane：无云端时回退内置轮换", today.includes("todayStory.value.zh"));
  ok("TodayPane：跨天/回页刷新", today.includes("refreshDailyIfNewDay"));
}
{
  const admin = read("src/views/AdminView.vue");
  ok("AdminView：页签含 daily", admin.includes("'daily'"));
  ok("AdminView：日期选择", admin.includes("daily-date") && admin.includes("selectDailyDate"));
  ok("AdminView：5 语言编辑", admin.includes("DAILY_STORY_LANGS") && admin.includes("dailyForm[dailyLang]"));
  ok("AdminView：草稿/发布", admin.includes("saveDaily(false)") && admin.includes("saveDaily(true)"));
  ok("AdminView：自动翻译", admin.includes("autoTranslateDaily") && admin.includes("translateText"));
  ok("AdminView：删除确认", admin.includes("admin.daily.confirmDelete"));
  ok("AdminView：迁移缺失提示", admin.includes("admin.daily.migrateHint"));
}
{
  const worker = read("worker/api.js");
  ok("Worker：公开故事路由", worker.includes('seg[0] === "daily-story"') && worker.includes("daily_story_get"));
  ok("Worker：管理端故事路由", worker.includes('seg[1] === "daily-story"') && worker.includes("daily_story_save"));
  ok("Worker：日期校验", worker.includes("function isIsoDate") && worker.includes("bad-date"));
}
{
  const mig = read("MIGRATION_daily_stories.sql");
  ok("迁移：表 daily_stories", mig.includes("create table if not exists public.daily_stories"));
  ok("迁移：RLS 开启", mig.includes("enable row level security"));
  ok("迁移：公开读只返回 published", mig.includes("d.published = true"));
  ok("迁移：管理函数校验 admin_users", mig.includes("from public.admin_users"));
  ok("迁移：保存/删除函数", mig.includes("daily_story_save") && mig.includes("daily_story_delete"));
}

console.log(`daily-story-test: ${pass} pass, ${fails.length} fail`);
for (const f of fails) console.log("FAIL  " + f);
if (fails.length) process.exit(1);
