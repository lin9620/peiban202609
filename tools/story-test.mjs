/* 故事栏（轮 145）单测：纯函数规则 + i18n 成对 + 三通道契约 + 迁移覆盖 + 视图接线
 * ------------------------------------------------------------
 * 重点（漂一处用户就会被挡或被放水的地方）：
 *  1. 3 万字 / 标题 100 / 标签 1~3 且每个 ≤20 —— 前端常量、SQL check、Worker 体检三处同口径；
 *  2. 字数按「码点」计（[...s].length / char_length）：emoji 不能算两下，否则作者被提前截断；
 *  3. 四种排序模式的名字在 storyRules.SORT_MODES、SQL 的 story_rank 白名单、Worker 入参体检三处一致；
 *  4. 周期键 'YYYY-MM' 现在用月榜，以后改周榜只换 periodKey 口径（表结构不动）—— 两条都钉住；
 *  5. 轻 Markdown 必须先转义再拼标签（否则正文里的 <script> 直通 v-html，是 XSS）；
 *  6. i18n 中英成对：story.* 少一条就会在页面上露出裸 key；
 *  7. 新增路由必须同步 vite seoRoutes（轮 134 红线：没预渲染文件的路径线上是真 404）。
 * 运行：node tools/story-test.mjs
 */
import fs from "node:fs";
import { messages } from "../src/i18n.js";
import {
  TITLE_MAX, BODY_MAX, TAGS_MAX, TAG_MAX, READ_CHARS_PER_MIN,
  SORT_MODES, DEFAULT_MODE, RANK_TABS,
  countChars, readMinutes, normalizeTags, validatePublish,
  periodKey, periodKeyWeek, renderLiteMd, storyErrKey,
} from "../src/utils/storyRules.js";

let pass = 0;
const fails = [];
function ok(name, cond, extra = "") {
  if (cond) pass++;
  else fails.push(name + (extra ? ` —— ${extra}` : ""));
}
const read = (p) => fs.readFileSync(p, "utf8");
const has = (src, ...parts) => parts.every((p) => src.includes(p));

const sql = read("MIGRATION_story.sql");
const worker = read("worker/api.js");
const sb = read("src/utils/api/db.supabase.js");
const gw = read("src/utils/api/db.gateway.js");
const storyJs = read("src/utils/story.js");
const rules = read("src/utils/storyRules.js");
const router = read("src/router.js");
const vite = read("vite.config.js");
const wrangler = read("wrangler.jsonc");
const css = read("src/style.css");
const editor = read("src/components/story/StoryEditor.vue");
const rankVue = read("src/components/story/StoryRank.vue");
const mineVue = read("src/components/story/StoryMine.vue");
const feedVue = read("src/components/story/StoryFeed.vue");
const viewVue = read("src/views/StoryView.vue");
const detailVue = read("src/views/StoryDetailView.vue");
const writeVue = read("src/views/StoryWriteView.vue");
const sideNav = read("src/components/SideNav.vue");

/* ───────── 常量口径（三处必须一致） ───────── */
ok("正文上限 3 万字", BODY_MAX === 30000, String(BODY_MAX));
ok("标题上限 100", TITLE_MAX === 100);
ok("标签 1~3 个", TAGS_MAX === 3);
ok("单标签 ≤20 字", TAG_MAX === 20);
ok("阅读 400 字/分钟", READ_CHARS_PER_MIN === 400);
ok("四种排序模式", SORT_MODES.join(",") === "random,latest,monthly,tag", SORT_MODES.join(","));
ok("默认 = 随机推荐", DEFAULT_MODE === "random");
ok("榜页签 4 个且顺序 = random 开头", RANK_TABS.length === 4 && RANK_TABS[0].mode === "random");

/* ───────── 字数：按码点算（emoji 不吃两次） ───────── */
ok("countChars 中文按字", countChars("你好世界") === 4);
ok("countChars emoji 算 1（非 2）", countChars("🌊") === 1, String(countChars("🌊")));
ok("countChars 空值安全", countChars(null) === 0 && countChars(undefined) === 0);
ok("readMinutes 30000 字 = 75 分钟", readMinutes("x".repeat(30000)) === 75, String(readMinutes("x".repeat(30000))));
ok("readMinutes 最短 1 分钟", readMinutes("") === 1);

/* ───────── 标签规范化 ───────── */
ok("标签去 # / 小写 / 去空", normalizeTags(["#治愈", "  Deep  ", "", "治愈"]).join(",") === "治愈,deep",
  normalizeTags(["#治愈", "  Deep  ", "", "治愈"]).join(","));
ok("标签封顶 3 个", normalizeTags(["a", "b", "c", "d"]).length === 3);
ok("标签非数组安全", normalizeTags(null).length === 0);

/* ───────── 发布校验 ───────── */
ok("空标题拦下", validatePublish({ title: " ", body: "x", tags: ["a"] }) === "bad-title");
ok("超长标题拦下", validatePublish({ title: "t".repeat(101), body: "x", tags: ["a"] }) === "bad-title");
ok("空正文拦下", validatePublish({ title: "t", body: "", tags: ["a"] }) === "empty-body");
ok("超 3 万字拦下", validatePublish({ title: "t", body: "x".repeat(30001), tags: ["a"] }) === "too-long");
ok("无标签拦下", validatePublish({ title: "t", body: "x", tags: [] }) === "bad-tags");
ok("刚好 3 万字放行", validatePublish({ title: "t", body: "x".repeat(30000), tags: ["a"] }) === null);
ok("正常稿放行", validatePublish({ title: "潮汐书店", body: "那年夏天…", tags: ["治愈"] }) === null);

/* ───────── 周期键：现在月榜，以后周榜 ───────── */
ok("periodKey 形状 YYYY-MM", /^\d{4}-\d{2}$/.test(periodKey(new Date(2026, 9, 1))), periodKey(new Date(2026, 9, 1)));
ok("periodKey 月份补零", periodKey(new Date(2026, 0, 5)) === "2026-01", periodKey(new Date(2026, 0, 5)));
ok("periodKey 非法日期回落当前月", /^\d{4}-\d{2}$/.test(periodKey(new Date("bad"))));
ok("periodKeyWeek 形状 YYYY-Www", /^\d{4}-W\d{2}$/.test(periodKeyWeek(new Date(2026, 9, 1))), periodKeyWeek(new Date(2026, 9, 1)));

/* ───────── 轻 Markdown：先转义再拼标签（XSS 防线） ───────── */
ok("正文 HTML 被转义", renderLiteMd("<script>alert(1)</script>").includes("&lt;script&gt;"));
ok("不产生可执行 script 标签", !renderLiteMd("<script>alert(1)</script>").includes("<script>"));
ok("## 变 h2", renderLiteMd("## 小标题").includes("<h2>小标题</h2>"));
ok("> 变 blockquote", renderLiteMd("> 引用一句").includes("<blockquote>引用一句</blockquote>"));
ok("--- 变 hr", renderLiteMd("---").includes("<hr>"));
ok("**粗体** 变 strong", renderLiteMd("**暖**").includes("<strong>暖</strong>"));
ok("普通段落包 p", renderLiteMd("一句话").startsWith("<p>"));
ok("属性注入被转义", renderLiteMd('" onmouseover="x').includes("&quot;"));

/* ───────── 错误码归类 ───────── */
ok("story-bad-title → errTitle", storyErrKey(new Error("story-bad-title")) === "story.errTitle");
ok("story-too-long → errLong", storyErrKey(new Error("story-too-long")) === "story.errLong");
ok("story-bad-tags → errTags", storyErrKey(new Error("story-bad-tags")) === "story.errTags");
ok("story-auth → errAuth", storyErrKey(new Error("story-auth")) === "story.errAuth");
ok("story-not-found → errNotFound", storyErrKey(new Error("story-not-found")) === "story.errNotFound");
ok("story-bad-mode → errMode", storyErrKey(new Error("story-bad-mode")) === "story.errMode");
ok("429 → errRate", storyErrKey(new Error("HTTP 429")) === "story.errRate");

/* ───────── i18n：中英成对（少一条就露裸 key） ───────── */
{
  const en = messages.en.story || {};
  const zh = messages.zh.story || {};
  const missZh = Object.keys(en).filter((k) => !(k in zh));
  const missEn = Object.keys(zh).filter((k) => !(k in en));
  ok("story.* 英文不缺中文", missZh.length === 0, missZh.join(","));
  ok("story.* 中文不缺英文", missEn.length === 0, missEn.join(","));
  ok("story.* 词条够用（≥35 条）", Object.keys(en).length >= 35, String(Object.keys(en).length));
  ok("侧栏 nav.story 中英成对", !!messages.en.nav.story && !!messages.zh.nav.story);
  ok("四榜页签词条齐", ["rankRandom", "rankLatest", "rankMonthly", "rankTag"].every((k) => en[k] && zh[k]));
  /* 占位符成对：{n}/{max}/{min}/{name}/{likes}/{views}/{t} 两边都得在，否则中文缺参渲染成原文 */
  const phMissing = [];
  for (const k of Object.keys(en)) {
    if (typeof en[k] !== "string" || typeof zh[k] !== "string") continue;
    const a = (en[k].match(/\{(\w+)\}/g) || []).sort().join(",");
    const b = (zh[k].match(/\{(\w+)\}/g) || []).sort().join(",");
    if (a !== b) phMissing.push(k);
  }
  ok("story.* 占位符中英一致", phMissing.length === 0, phMissing.join(","));
}

/* ───────── 迁移：表 / 约束 / RPC / 权限 ───────── */
ok("建 4 张表", has(sql, "public.stories", "public.story_likes", "public.story_comments", "public.story_views"));
ok("正文 check ≤30000 与前端同口径", sql.includes("char_length(body) between 1 and 30000"));
ok("标题 check ≤100", sql.includes("char_length(title) between 1 and 100"));
ok("标签数 check 1~3", sql.includes("array_length(tags, 1) between 1 and 3"));
ok("status 三态", has(sql, "'draft'", "'published'", "'removed'"));
ok("点赞主键防重（一赞一次）", sql.includes("primary key (story_id, user_id)"));
ok("浏览按天去重", sql.includes("primary key (story_id, user_id, day)"));
ok("RLS：published 或本人可读", sql.includes("status = 'published' or user_id = auth.uid()"));
ok("7 个 RPC 都在", ["story_publish", "story_save_draft", "story_toggle_like", "story_add_view",
  "story_rank", "story_get", "story_mine"].every((n) => sql.includes(`function public.${n}(`)));
ok("写 RPC 不给 anon", has(sql, "revoke all on function public.story_publish", "from public, anon"));
ok("读榜给 anon（未登录也能看）", sql.includes("grant execute on function public.story_rank(text, text, text, integer, integer) to authenticated, anon"));
ok("详情给 anon（深链分享可读）", sql.includes("grant execute on function public.story_get(bigint) to authenticated, anon"));
ok("随机榜有 5 分钟种子", sql.includes("extract(epoch from now()) / 300"));
ok("月榜按当期点赞（不是总赞）", sql.includes("to_char(l.created_at, 'YYYY-MM') = v_period"));
ok("榜四条分支齐", has(sql, "p_mode = 'random'", "p_mode = 'latest'", "p_mode = 'monthly'", "else -- tag"));
ok("榜返回作者昵称", sql.includes("nickname text"));
ok("榜带非空/上限兜底", sql.includes("limit greatest(p_limit, 1)"));

/* ───────── 三通道（业务层 / 直连 / 网关 / Worker） ───────── */
ok("story.js 业务层导出 7 个动作", has(storyJs, "storySaveDraft", "storyPublish", "storyToggleLike",
  "storyAddView", "storyRank", "storyGet", "storyMine"));
ok("story.js 发布前先本地校验", storyJs.includes("validatePublish({ title, body, tags })"));
ok("story.js 草稿 >3 万字先挡（不白跑一趟）", storyJs.includes("story-too-long"));
ok("直连：7 个方法都在", has(sb, "storySaveDraft(", "storyPublish(", "storyToggleLike(", "storyAddView(",
  "storyRank(", "storyGet(", "storyMine("));
ok("直连：全部走 RPC", sb.includes('rpc("story_rank"') && sb.includes('rpc("story_publish"'));
ok("直连：详情返回行或 null", sb.includes("(data && data[0]) || null"));
ok("网关：7 个方法都在", has(gw, "storySaveDraft(", "storyPublish(", "storyToggleLike(", "storyAddView(",
  "storyRank(", "storyGet(", "storyMine("));
ok("网关：走 /story/* 收口", has(gw, '"/story/draft"', '"/story/publish"', '"/story/like"',
  '"/story/view"', "/story/rank?", '`/story/${enc(id)}`', "/story/mine?"));
ok("Worker：7 个 RPC 端点接上", has(worker, '"story_save_draft"', '"story_publish"', '"story_toggle_like"',
  '"story_add_view"', '"story_rank"', '"story_get"', '"story_mine"'));
ok("Worker：正文 3 万字体检（码点）", worker.includes("[...text].length > 30000"));
ok("Worker：发布三项体检", has(worker, "story-bad-title", "story-empty-body", "story-bad-tags"));
ok("Worker：榜单模式白名单", worker.includes('if (mode !== "random" && mode !== "latest" && mode !== "monthly" && mode !== "tag")'));
ok("Worker：详情查无 → 200 null（与直连同契约）", worker.includes("Array.isArray(arr) ? (arr[0] || null)"));
ok("Worker：深链存在性回退在（软 404 红线）", has(worker, 'path.startsWith("/story/")', "getStoryRow", "storyShellHtml"));
ok("wrangler：/story/* 先进 Worker", wrangler.includes('"/story/*"'));

/* ───────── 路由 / SEO / 侧栏 / 样式单一来源 ───────── */
ok("路由三条：/story、/story/write、/story/:id", has(router, 'path: "/story"', 'path: "/story/write"', 'path: "/story/:id'));
ok("全屏写作排在 :id 之前（否则 write 被当 id）",
  router.indexOf('path: "/story/write"') < router.indexOf('path: "/story/:id'));
ok("详情 id 限数字", router.includes('story/:id(\\\\d+)'));
ok("seoRoutes 有 story 页（轮134 红线）", vite.includes('dir: "story"') && vite.includes('dir: "story/write"'));
ok("侧栏有故事栏入口", sideNav.includes('{ to: "/story", ico: "📖", key: "nav.story" }'));
ok("故事样式单一来源在 style.css", css.includes(".story-wrap") && css.includes(".st-rank-row"));
ok("组件内不重复写样式（防双源压制）", !editor.includes("<style") && !rankVue.includes("<style")
  && !mineVue.includes("<style") && !feedVue.includes("<style") && !viewVue.includes("<style")
  && !detailVue.includes("<style") && !writeVue.includes("<style"));
ok("编辑器用常量而非硬编码 3 万", editor.includes("BODY_MAX") && !editor.includes("30000"));
ok("编辑器有停机自动存草稿", has(editor, "setTimeout(autosave, 3000)", "saveLocalDraft"));
ok("编辑器有写/预览双页签", has(editor, "story.modeWrite", "story.modePreview", "renderLiteMd"));
ok("榜页签四种模式齐", has(rankVue, "RANK_TABS", "story.rankShuffle", "periodKey"));
ok("榜标签模式 → 该标签月赞排行", rankVue.includes('mode: "monthly", tag: activeTag.value'));
ok("我的页签：草稿/已发布 + 数据面板", has(mineVue, 'storyMine("draft")', 'storyMine("published")', "storyMyStats")
  && mineVue.includes("total_likes") && mineVue.includes("bookmark_count"));
ok("发现页签：搜索 + 载入更多", has(feedVue, "story.searchPh", "loadMore"));
ok("主页三页签（投稿|发现|我的）", has(viewVue, "story.tabWrite", "story.tabDiscover", "story.tabMine", "StoryRank"));
ok("阅读页：点赞 + 相关推荐 + 浏览计数", has(detailVue, "storyToggleLike", "storyAddView", "story.related"));
ok("全屏写作可续写草稿", has(writeVue, "route.query.id", "storyGet", "full"));

/* ───────── 批 2：错误码归类 ───────── */
ok("network → errNetwork", storyErrKey(new Error("Failed to fetch")) === "story.errNetwork");
ok("其它 → errGeneric", storyErrKey(new Error("???")) === "story.errGeneric");
ok("story-comment-empty → errCommentEmpty", storyErrKey(new Error("story-comment-empty")) === "story.errCommentEmpty");
ok("story-comment-long → errCommentLong", storyErrKey(new Error("story-comment-long")) === "story.errCommentLong");

/* ───────── 结果 ───────── */
if (fails.length) {
  console.log(`story-test: ${pass} pass, ${fails.length} FAIL`);
  for (const f of fails) console.log("  ✗ " + f);
  process.exit(1);
}
console.log(`story-test: ${pass} pass, 0 fail`);

