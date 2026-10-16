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
  TITLE_MAX, BODY_MAX, BODY_MIN, TAGS_MAX, TAG_MAX, READ_CHARS_PER_MIN,
  SORT_MODES, DEFAULT_MODE, RANK_TABS,
  countChars, readMinutes, normalizeTags, validatePublish,
  periodKey, periodKeyWeek, renderLiteMd, storyErrKey,
} from "../src/utils/storyRules.js";
import { setStorySeed, takeStorySeed, peekStorySeed } from "../src/utils/storySeed.js";

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
const mineView = read("src/views/StoryMineView.vue");   /* 轮 148：从页签壳拆出的独立页 */
const rankView = read("src/views/StoryRankView.vue");
const shellVue = read("src/components/story/StoryShell.vue");  /* 轮 148：频道条+横滑共享壳 */
const tabBar = read("src/components/TabBar.vue");       /* 轮 148：＋ 第三瓣 = 写故事 */
const homeVue = read("src/views/HomeView.vue");
const routerJs = read("src/router.js");
const backJs = read("src/utils/storyBack.js");   /* 轮 150：故事系页面共用返回逻辑 */
const viteCfg = read("vite.config.js");
const sideNav = read("src/components/SideNav.vue");
const i18nSrc = read("src/i18n.js");   /* 文案成对/插入位置检查用原始源码 */

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
// 这两条的 body 需 ≥BODY_MIN(100)，否则会被「正文下限」先拦掉，测不到标签/正常稿的原意
ok("无标签拦下", validatePublish({ title: "t", body: "x".repeat(100), tags: [] }) === "bad-tags");
ok("刚好 3 万字放行", validatePublish({ title: "t", body: "x".repeat(30000), tags: ["a"] }) === null);
ok("正常稿放行", validatePublish({ title: "潮汐书店", body: "那年夏天…".repeat(25), tags: ["治愈"] }) === null);

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
// 轮 148：.story-wrap 双栏壳已退役，改锚 .story-main / .st-rank-row（.story-side 也一并退役）
ok("故事样式单一来源在 style.css", css.includes(".story-main") && css.includes(".st-rank-row"));
ok("组件内不重复写样式（防双源压制）", !editor.includes("<style") && !rankVue.includes("<style")
  && !mineVue.includes("<style") && !feedVue.includes("<style") && !viewVue.includes("<style")
  && !detailVue.includes("<style") && !writeVue.includes("<style"));
ok("编辑器用常量而非硬编码 3 万", editor.includes("BODY_MAX") && !editor.includes("30000"));
ok("编辑器有停机自动存草稿", has(editor, "setTimeout(autosave, 3000)", "saveLocalDraft"));
ok("编辑器有写/预览双页签", has(editor, "story.modeWrite", "story.modePreview", "renderLiteMd"));
ok("榜页签四种模式齐", has(rankVue, "RANK_TABS", "story.rankShuffle", "periodKey"));
// 标签下钻必须走 latest 档：monthly 档在 SQL 里 inner join 当月 story_likes，
// 没被赞过的故事会整条消失 → 点标签必然空列表（这正是线上反馈的现象）。
ok("榜标签下钻走 latest 档（非 monthly，避免无赞即空）",
  rankVue.includes('mode: "latest", tag: activeTag.value')
  && !rankVue.includes('mode: "monthly", tag: activeTag.value'));
ok("标签云显示篇数而非赞数（view_count 装的是 count(*)）",
  rankVue.includes("<em>{{ r.view_count }}</em>") && !rankVue.includes("<em>{{ r.like_count }}</em>"));
ok("我的页签：草稿/已发布 + 数据面板", has(mineVue, 'storyMine("draft")', 'storyMine("published")', "storyMyStats")
  && mineVue.includes("total_likes") && mineVue.includes("bookmark_count"));
ok("发现页签：搜索 + 载入更多", has(feedVue, "story.searchPh", "loadMore"));
// 轮 148 追加：/story 已废除页签壳，改成纯阅读发现页；投稿/我的/排行榜 拆成独立路由。
ok("发现页：纯阅读，无页签壳", viewVue.includes("StoryFeed")
  && !viewVue.includes("st-tabs") && !viewVue.includes("onlyMobile") && !viewVue.includes("story-wrap"));
// 轮 148：发布条件从「只报第一条」改为「清单全报」+ 达标确认。
ok("发布条件列出全部未满足项（blockers 清单）",
  editor.includes("const blockers = computed") && editor.includes("list.push")
  && editor.includes("v-for=\"(b, i) in blockers\""));
ok("达标时给出确认提示（readyToPublish）",
  editor.includes("readyToPublish") && editor.includes("st-why--ok"));
ok("未动过编辑器不甩提示（touched 门控）", editor.includes("const showWhy = computed"));
ok("whyDisabled 取 blockers 首条（按钮 title 仍用第一条）",
  editor.includes("return blockers.value[0] || \"\""));
ok("清单文案中英成对", !!(messages.en.story.whyTitle && messages.zh.story.whyTitle
  && messages.en.story.readyToPublish && messages.zh.story.readyToPublish));
ok("清单卡片有样式", css.includes(".st-why-list") && css.includes(".st-why--ok"));
// 投稿入口统一到底部 ＋ 第三瓣；纯阅读页里不再放发布按钮。
ok("底部 ＋ 有第三瓣「写故事」→ /story/write",
  tabBar.includes("composeStory") && tabBar.includes('router.push("/story/write")')
  && tabBar.includes('t("tab.composeStory")'));
ok("投稿词条中英成对", !!(messages.en.tab.composeStory && messages.zh.tab.composeStory
  && messages.en.tab.composeStorySub && messages.zh.tab.composeStorySub));
// 只查模板区（<template> 之后），注释里提到 /story/write 不算
const tpl = (s) => s.slice(s.indexOf("<template>"));
ok("故事页不再直接给「写故事」按钮（纯阅读）",
  !tpl(viewVue).includes("/story/write") && !tpl(viewVue).includes("story.writeStory"));
ok("我的页也不给「写故事」按钮",
  !tpl(mineView).includes("/story/write") && !tpl(mineView).includes("story.writeStory"));
ok("首页故事联尾不再重复给「写故事」", !homeVue.includes('t("story.writeStory")'));
ok("发现页不再直接嵌编辑器（投稿已独立成页）", !viewVue.includes("StoryEditor"));
ok("新增路由 /story/mine 与 /story/rank", routerJs.includes('"/story/mine"') && routerJs.includes('"/story/rank"'));
ok("子路由排在 /story/:id(\\d+) 之前（否则 mine 被当 id 吞掉）",
  routerJs.indexOf('"/story/mine"') < routerJs.indexOf('"/story/:id(\\\\d+)"')
  && routerJs.indexOf('"/story/rank"') < routerJs.indexOf('"/story/:id(\\\\d+)"'));
// 轮 134 红线：新增路由没进 seoRoutes 就会线上真 404
ok("seoRoutes 覆盖 story/mine 与 story/rank（中英各一份）",
  (viteCfg.match(/dir: "story\/mine"/g) || []).length === 2
  && (viteCfg.match(/dir: "story\/rank"/g) || []).length === 2);
// 轮 148：三个故事页必须套 StoryShell —— 独立路由不经过 HomeView 的 home3 容器，
// 不套壳就会「顶层四个频道按钮消失」+「不能左滑」。
ok("三页均套 StoryShell（补频道条与横滑）",
  viewVue.includes("StoryShell") && mineView.includes("StoryShell") && rankView.includes("StoryShell"));
ok("StoryShell 渲染四联频道条并复用 panes.js 手势判定",
  shellVue.includes("HOME_PANES") && shellVue.includes("home-chips")
  && shellVue.includes("swipeDir") && shellVue.includes('query: { tab: k }'));
ok("StoryShell 子页(mine/rank)归到故事联高亮，不是第五联",
  shellVue.includes('"mine"') && shellVue.includes('"rank"') && shellVue.includes('"story"'));
// 投稿入口只在底部 ＋ 第三瓣，故事页与首页联内都不得再放。
// 注意：只查「代码」不查注释 —— 两个文件的注释里都写了「投稿入口搬到底部 ＋ 第三瓣」这句话，
// 直接 includes 会把注释当命中，断言永远绿/永远红都没意义。
const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/)
  .filter((l) => !/^\s*(\/\/|\*|<!--)/.test(l)).join("\n");
ok("投稿入口只在底部 ＋ 第三瓣",
  tabBar.includes("composeStory") && tabBar.includes("composeStorySub")
  && !codeOnly(viewVue).includes("/story/write")
  && !codeOnly(homeVue).includes("/story/write"));
ok("首页故事联尾不再挂按钮（避免第三处重复入口）", !homeVue.includes("home-pane-foot"));
// 回退不再用 router.push('/story')：mine/rank 的顶部操作条改走 storyBack（与物理返回键同一入口），
// 见 utils/storyBack.js —— 否则 App.vue 对非 ROOT_VIEWS 一律 router.back()，会退到首页今日/漂流瓶联。
ok("我的页 = 独立视图，回退用 storyBack", mineView.includes("StoryMine")
  && mineView.includes("useStoryBack") && mineView.includes("/story/write?id="));
ok("排行榜页 = 独立视图，回退用 storyBack",
  rankView.includes("StoryRank") && rankView.includes("useStoryBack"));
// 注意：详情页注释里出现过「router.back()」字样（说明为什么不用它），
// 所以只能断言「没有实际调用」——即 router.back 后不接 .catch/() 的调用形态。
ok("故事详情页返回不再 router.back()（会退到首页联）",
  detailVue.includes("useStoryBack") && !/router\.back\(\)\s*[.)]/.test(detailVue));
ok("storyBack 用 replace 而非 push（连按返回不堆历史）",
  backJs.includes("router.replace(to)"));
// 轮 150：/story、/story/mine、/story/rank 是独立路由，不走 HomeView 的 .home3 容器，
// 频道条与手势必须由共享壳补上，否则「点进子页顶栏没了 / 不能左滑」。
ok("共享壳 StoryShell：手机端渲染四联频道条，桌面直出内容",
  shellVue.includes('v-if="isMobileNav"') && shellVue.includes("HOME_PANES")
  && shellVue.includes("<slot v-else />"));
ok("共享壳：横滑手势复用 panes.swipeDir，且到头不动",
  shellVue.includes("swipeDir") && shellVue.includes("if (target) go(target.k)"));
ok("共享壳：点某联跳首页对应 tab（独立页与首页联是两份 DOM，只能跳转）",
  shellVue.includes("query: { tab: k }"));
ok("三个故事页都套了共享壳", viewVue.includes("<StoryShell")
  && mineView.includes("<StoryShell") && rankView.includes("<StoryShell"));
/* ───────── 轮 153：App/窄屏去掉「发现」按钮（桌面保留） ─────────
 * 用户要求：app 端「排行榜」「我的」两页不要那枚「发现」按钮，网页端不动。
 * 判据：两页的顶部操作条整条挂 v-if="!isMobileNav"（条里只有这一枚钮，挂条即可不留空框），
 * 且确实从 uiStore 引了该开关（漏 import 会让 v-if 恒为 undefined → 按钮照样显示）。
 * 反面断言同样是重点：若操作条回到无条件渲染，手机端就会多出一枚与频道条「故事」重复的返回钮。
 * 注意 codeOnly 去注释 —— 两个文件的解释注释里也写着 v-if="!isMobileNav" 字样，
 * 直接 includes 会永远绿，等于没测。 */
const actsMobileOnly = (s) => /<nav\s+v-if="!isMobileNav"\s+class="story-acts"/.test(codeOnly(s));
ok("App/窄屏：排行榜页去掉「发现」按钮（桌面保留）",
  actsMobileOnly(rankView) && rankView.includes('import { isMobileNav } from "../stores/uiStore.js"'));
ok("App/窄屏：我的页去掉「发现」按钮（桌面保留）",
  actsMobileOnly(mineView) && mineView.includes('import { isMobileNav } from "../stores/uiStore.js"'));
ok("桌面端按钮未被连带删掉（反向守点）+ 频道条「故事」联仍能回发现页 + 我的页物理返回键接管仍在",
  codeOnly(rankView).includes('@click="router.push(\'/story\')"')
  && shellVue.includes('k === "story"') && shellVue.includes('router.push("/story")')
  && mineView.includes("useStoryBack(router)"));
// 轮 150：已发布的故事要能改。服务端 story_publish 的 else 分支本来就允许改已发布的
// （status <> 'removed'，published_at 用 coalesce 保住原发布时间），这里只补 UI 入口。
ok("已发布行有「修改」按钮（走 /story/write?id= 复用续写通路）",
  codeOnly(mineVue).includes("tab === 'published'") && codeOnly(mineVue).includes("emit('edit', r)")
  && mineView.includes("/story/write?id="));
ok("草稿行不挂修改按钮（点整行本就进编辑器，重复入口）",
  !codeOnly(mineVue).includes('v-if="tab !== \'shelf\'"'));
ok("编辑器按 story.status 记住 published（改动走更新而非新建）",
  codeOnly(editor).includes('props.story.status === "published"')
  && codeOnly(editor).includes("draftId.value = props.story.id"));
ok("已发布稿不被自动存偷偷改（autosave 只在草稿阶段上云）",
  codeOnly(editor).includes('draftStatus.value !== "draft") return'));
// 已退役样式不得复活（双栏右栏 + 页签）
ok("页签/右栏样式已退役", !css.includes(".st-tabs") && !css.includes(".story-side")
  && !css.includes(".story-wrap"));
// 点赞/收藏是「开关型」按钮：必须默认 ghost（透明底），只靠 --on 上色。
// 踩过的坑：直接用 st-btn（实心橙）→ 未点赞也是亮色，与已点赞只差一个色阶，等于没有状态区分。
ok("详情页点赞/收藏为 ghost 开关按钮（未操作不亮）",
  detailVue.includes('class="st-btn st-btn--ghost" :class="{ \'st-btn--on\': row.liked }"')
  && detailVue.includes("st-btn--ghost st-btn--mark")
  && css.includes(".st-btn--on:hover")
  /* 轮 148 实测 bug：ghost 是「深棕字 + 透明底」，--on 只把底色换成深棕 → 深底深字糊成
     一块色斑，按钮看着比正常宽、文字消失。--on 必须同时翻白字（hover 态同理）。 */
  && css.includes(".st-btn--on { background: var(--accent-deep); border-color: var(--accent-deep); color: #fff; }")
  && css.includes(".st-btn--on:hover { background: var(--accent-deep); color: #fff; }"));
// 操作条要有间距，否则糊成色斑时两个按钮视觉上粘成一块
ok("阅读页操作条有间距（点赞/收藏不粘连）", /\.st-read-foot\s*\{[^}]*gap:\s*1\dpx/.test(css));
ok("阅读页：点赞 + 相关推荐 + 浏览计数", has(detailVue, "storyToggleLike", "storyAddView", "story.related"));
ok("全屏写作可续写草稿", has(writeVue, "route.query.id", "storyGet", "full"));

/* ───────── 批 2：错误码归类 ───────── */
ok("network → errNetwork", storyErrKey(new Error("Failed to fetch")) === "story.errNetwork");
ok("其它 → errGeneric", storyErrKey(new Error("???")) === "story.errGeneric");
ok("story-comment-empty → errCommentEmpty", storyErrKey(new Error("story-comment-empty")) === "story.errCommentEmpty");
ok("story-comment-long → errCommentLong", storyErrKey(new Error("story-comment-long")) === "story.errCommentLong");
ok("story-too-short → errShort（须先于 too-long 命中，否则被长文分支吞掉）",
  storyErrKey(new Error("story-too-short")) === "story.errShort");
ok("story-too-long → errLong（未被 too-short 规则误捕）",
  storyErrKey(new Error("story-too-long")) === "story.errLong");

/* ───────── 正文下限 100 字（发布口径；草稿不受限） ───────── */
{
  const body100 = "字".repeat(100);
  const okTags = ["日常"];
  const base = { title: "标题", tags: okTags };
  ok("正文 0 字 → empty-body（先判空，再判下限）",
    validatePublish({ ...base, body: "" }) === "empty-body");
  ok("正文 1 字 → too-short", validatePublish({ ...base, body: "字" }) === "too-short");
  ok("正文 99 字 → too-short（差 1 字也拦）",
    validatePublish({ ...base, body: "字".repeat(99) }) === "too-short");
  ok("正文 100 字 → 通过（边界含端点）", validatePublish({ ...base, body: body100 }) === null);
  ok("正文 101 字 → 通过", validatePublish({ ...base, body: "字".repeat(101) }) === null);
  // 码点口径：100 个 emoji 仍算 100 字，不能因 UTF-16 双倍而误判超限
  ok("正文 100 个 emoji → 通过（码点口径，非 UTF-16）",
    validatePublish({ ...base, body: "🙂".repeat(100) }) === null);
  ok("BODY_MIN 导出且为 100", BODY_MIN === 100);
  // 校验顺序：标题 → 正文（空 → 太短 → 太长）→ 标签。逐步引导，一次只报一条。
  ok("短文 + 无标签 → too-short（正文先判，先补字数再说标签）",
    validatePublish({ title: "标题", body: "字".repeat(50), tags: [] }) === "too-short");
  ok("够长 + 无标签 → bad-tags（字数达标后才轮到标签）",
    validatePublish({ title: "标题", body: "字".repeat(100), tags: [] }) === "bad-tags");
  ok("空正文 + 无标签 → empty-body（空判最前）",
    validatePublish({ title: "标题", body: "", tags: [] }) === "empty-body");
}
ok("编辑器：发布门槛用 BODY_MIN 而非 >0",
  editor.includes("chars.value >= BODY_MIN") && !editor.includes("chars.value > 0"));
ok("编辑器：正文不足常驻提示还差多少字",
  editor.includes("shortOf") && editor.includes("story.needMore") && editor.includes("st-minbar"));
ok("SQL：story_publish 加正文下限且抛 story-too-short",
  sql.includes("char_length(p_body) < 100") && sql.includes("story-too-short"));
ok("SQL：表 check 约束不改下限（存量短文不该被约束连累）",
  sql.includes("between 1 and 30000") && !/between 10\d and 30000/.test(sql));
ok("Worker：仅 publish 分支校验下限，草稿不限",
  worker.includes("story-too-short")
  && /seg\[1\] === "publish"[\s\S]{0,400}story-too-short/.test(worker));
ok("story.js 中转层转出 BODY_MIN（漏了只有 vite build 才炸：Rollup 报 not exported）",
  /import\s*\{[^}]*BODY_MIN[^}]*\}\s*from\s*"\.\/storyRules\.js"/.test(storyJs)
  && /export\s*\{[^}]*BODY_MIN[^}]*\}/.test(storyJs));
ok("storyPublish 把 too-short 映射成 story-too-short（漏映射会误报 story-bad-tags）",
  storyJs.includes('v === "too-short" ? "story-too-short"'));
ok("i18n：needMore/errShort/minbar 中英成对",
  i18nSrc.includes("needMore:") && i18nSrc.includes("errShort:") && i18nSrc.includes("minbar:")
  && (i18nSrc.match(/needMore:/g) || []).length === 2
  && (i18nSrc.match(/errShort:/g) || []).length === 2
  && (i18nSrc.match(/minbar:/g) || []).length === 2);

/* ───────── 轮 313：故事详情秒开（点卡片带种子 + SWR 整篇缓存） ───────── */
/* 痛点：点一篇故事 → 详情页要等 story_get 回来才有 DOM，跨境弱网里整页空白 0.5~3s（用户体感「打开很慢」）。
 * 口径：列表行本来就带标题/作者/标签/字数/赞看数 → 点的一瞬间当种子递过去，首帧就画头部；
 *       正文/操作条等权威整行（ready）——种子没有 body/liked/marked，绝不能拿默认值冒充。 */
{
  const seedSrc = read("src/utils/storySeed.js");
  const appVue = read("src/App.vue");
  /* 真跑三个函数（不是看字符串）：种得上、取回字段对、取走即清、不串篇、空标题不种 */
  const seeded = setStorySeed({ id: 7, title: "夏夜", nickname: "猫", tags: ["日常"], read_minutes: 1, body: "正文正文", liked: true, status: "published" });
  ok("轮313 种子：列表行有 id + 标题 → 种得上", seeded === true && !!peekStorySeed());
  const got = takeStorySeed(7);
  ok("轮313 种子：取回的头部字段与列表行一致",
    !!got && got.title === "夏夜" && got.nickname === "猫" && got.tags[0] === "日常" && got.read_minutes === 1);
  ok("轮313 种子：不带 body/status/liked（列表行没有这些，不许拿默认值冒充）",
    !!got && !("body" in got) && !("status" in got) && !("liked" in got));
  ok("轮313 种子：取走即清（回列表再进同一篇不会吃到旧种子）",
    takeStorySeed(7) === null && peekStorySeed() === null);
  setStorySeed({ id: 8, title: "第二篇" });
  ok("轮313 种子：id 不匹配不串篇", takeStorySeed(9) === null && peekStorySeed() !== null);
  takeStorySeed(8);
  ok("轮313 种子：无标题（书架异常行）不种 —— 宁可走加载态也不显示空标题",
    setStorySeed({ id: 9, title: "   " }) === false && peekStorySeed() === null);

  /* 接线：详情页必须「setup 就吃种子」，否则第一帧仍是空的 = 没提速 */
  ok("轮313 详情页 setup 便吃种子（不能等到 onMounted 的 load）",
    has(detailVue, "takeStorySeed(route.params.id)", "const row = ref(seed0)", "const ready = ref(!seed0)"));
  ok("轮313 详情页正文与操作条在整行到位前不冒充（ready 门控 + 正文占位文案）",
    has(detailVue,
      'v-if="ready" class="st-read-body"',
      '<p v-else class="st-hint">{{ t("story.loadingBody") }}</p>',
      '<footer v-if="ready" class="st-read-foot">'));
  ok("轮313 详情页整篇进 SWR，缓存键带用户域（行里有 liked/marked，换账号不串）",
    has(detailVue, 'cacheKey("story", id, myId.value)'));
  ok("轮313 浏览计数只在权威整行到位后打（种子行/失败不虚增浏览数）",
    /if \(ready\.value && row\.value\) \{[\s\S]{0,160}storyAddView\(id\)/.test(detailVue));
  ok("轮313 四个入口都种种子：发现联 / 四榜 / 我的 / 相关推荐",
    has(feedVue, "setStorySeed(r)") && has(rankVue, "setStorySeed(r)")
    && has(mineVue, "setStorySeed(r)") && has(detailVue, "setStorySeed(r)"));
  ok("轮313 i18n：loadingBody 中英成对（缺一条露裸 key）",
    (i18nSrc.match(/loadingBody:/g) || []).length === 2);
  ok("轮313 warmChunks 预热门故事详情 chunk（首次点开不等下载）",
    /warmChunks[\s\S]{0,1200}StoryDetailView\.vue/.test(appVue));
  /* 反向锁：老写法回来就红 —— ①「await storyGet 再赋值」= 整页空白等网络；②卡片直连 router.push 绕过种子 */
  ok("轮313 反向锁：详情页不得再有「row.value = await storyGet」老写法",
    !/row\.value\s*=\s*await\s+storyGet/.test(detailVue));
  ok("轮313 反向锁：卡片点击不再直连 router.push（必须过 openStory/open 种种子）",
    !/@click="router\.push\(`\/story\//.test(feedVue) && !/@click="open\(r\.id\)"/.test(rankVue));
  ok("轮313 种子工具只挑详情页认识的字段（白名单，不整个对象照搬）",
    /FIELDS\s*=\s*\[/.test(seedSrc) && seedSrc.includes('"view_count"') && !seedSrc.includes('"body"'));
}

/* ───────── 结果 ───────── */
if (fails.length) {
  console.log(`story-test: ${pass} pass, ${fails.length} FAIL`);
  for (const f of fails) console.log("  ✗ " + f);
  process.exit(1);
}
console.log(`story-test: ${pass} pass, 0 fail`);

