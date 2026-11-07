/* 「我的帖子 / 我的页」帖子卡评论区回归（轮 460）
 * ---------------------------------------------------------------------------
 * 用户：「我的页面，点击我的帖子，没有评论啊，需要跟暖心墙那一样啊，现在什么都没有」
 *
 * 事实核查：暖心墙每张卡都有「说点温柔的话…」+「💬 N 条评论 ▾」+ 展开的评论列表；
 * 而 /my-posts 与「我的」页的帖子卡当时只有「浏览数 / 删除」，一个评论元素都没有。
 *
 * 钉住的契约（静态结构 + 复用口径）：
 *   C1  组件存在，且排序/软删/两级/计数全部走 utils/comments.js 的同一批纯函数
 *   C2  读 / 写 / 回应 / 删除走 wall.js 同一个云端接口，不自己拼 db 调用
 *   C3  没展开也要显示正确的「N 条评论」（云端聚合数，不先摆 0）
 *   C4  删除走软删（markDeleted + 云端 deleteComment），失败回滚
 *   C5  评论缓存键与详情页同一份（cmtCacheKey），展开时先吃缓存再拉网络
 *   C6  手机 = 卡内占位条 + 底部输入条；桌面 = 卡内常驻输入框（与暖心墙同形态）
 *   C7  卡片里只露前 3 条一级评论，更多进详情（wallTopComments / hasMoreComments）
 *   C8  两个入口页（我的帖子 / 我的）都挂上了，且评论区不触发整卡跳详情
 *   C9  计数文案复用 comment.count（不新造词条，五语自动同步）
 *   C10 认帖子走 dbId（云端主键），不是本地 id
 * 跑法：node tools/mypost-comments-test.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

let pass = 0;
const fails = [];
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("PASS  " + name); return; }
  fails.push(name);
  console.log("FAIL  " + name + (extra ? "\n      → " + extra : ""));
};
const has = (src, ...needles) => needles.every((n) => src.includes(n));

const comp = existsSync(join(root, "src/components/PostComments.vue"))
  ? read("src/components/PostComments.vue") : "";
const myPosts = read("src/views/MyPostsView.vue");
const profile = read("src/views/ProfileView.vue");
const commentsJs = read("src/utils/comments.js");
const wallJs = read("src/utils/wall.js");

ok("C1 组件存在，且判定/渲染/计数全用 utils/comments.js 的纯函数（不另写一套）",
  comp.length > 0
    && has(comp, "from \"../utils/comments.js\"", "renderTops", "renderReplies", "pageReplies",
      "displayCount", "markDeleted", "canDelete", "wallTopComments", "hasMoreComments"));

ok("C1b 两级封顶 + 每批 30 条的展开口径与暖心墙同一批函数",
  has(comp, "pageReplies(repliesOf(cm)", "renderReplies(rows.value, cm.id)"),
  "回复列表若自己写 slice，会与暖心墙的「默认 2 条 / 每批 30」两套口径漂移");

ok("C2 读/写/回应/删除全部走 wall.js 同一个云端接口",
  has(comp, "cloudFetchComments", "cloudInsertComment", "cloudToggleCommentReaction",
    "cloudDeleteComment")
    && !comp.includes("from \"../utils/api/db"),
  "自己拼 db.select/insert 会绕开 wall.js 的 canUseWall / 维护模式 / 软删兜底");

ok("C3 没展开也先显示云端聚合数（不能先摆 0，等点开才冒出来）",
  comp.includes("displayCount(loaded.value ? rows.value : undefined, cloudTotal.value)")
    && has(comp, "requestCommentCount(id)", "peekCommentCount(id)"),
  "compute 里若直接 liveComments(rows) 或 displayCount(rows, 0)，首屏一律显示 0 条");

ok("C3b 一屏多卡只发一次批量计数请求（不各拉各的）",
  has(comp, 'from "../utils/commentCountQueue.js"')
    && !comp.includes("cloudFetchCommentCounts([id])")
    && read("src/utils/commentCountQueue.js").includes("cloudFetchCommentCounts(ids)"),
  "每张卡单独 cloudFetchCommentCounts([id]) → 十几张卡十几个并发请求");

ok("C4 删除 = 软删（墓碑留给它的回复）+ 失败回滚",
  has(comp, "markDeleted(rows.value, cm.id)", "const before = rows.value", "if (!done) { rows.value = before; return; }"));

ok("C5 评论缓存与详情页同一份键（展开先吃缓存，网络回来覆盖）",
  has(comp, "cmtCacheKey(id)", "swr(", "cached:", "fresh:"));

ok("C6 手机走卡内占位条 + 底部输入条，桌面走卡内常驻输入框",
  has(comp, "v-if=\"isMobileNav\" class=\"cmt-entry\"", "cmt-main-bar", "Teleport to=\"body\"",
    "v-if=\"!isMobileNav\" class=\"cmt-input cmt-input-top\""),
  "两端形态必须与暖心墙一致：手机点占位条弹底条，桌面卡内输入框常驻");

ok("C7 卡片里只画前 3 条一级评论，超出给「查看更多评论」进详情",
  has(comp, "wallTopComments(renderTops(rows.value))", "hasMoreComments(renderTops(rows.value))", "router.push({ path: `/post/${dbId.value}` })", "goDetail"));

ok("C8 两个入口页都挂了评论区，且点击不触发整卡跳详情",
  has(myPosts, "import PostComments from \"../components/PostComments.vue\"", "<PostComments :post=\"p\" />")
    && has(profile, "import PostComments from \"../components/PostComments.vue\"", "<PostComments :post=\"p\" />")
    && (myPosts.match(/@click\.stop/g) || []).length > 0
    && (profile.match(/@click\.stop/g) || []).length > 0);

ok("C8b 我的页帖子卡改成 article + router.push（<a> 里嵌输入框会误跳详情）",
  has(profile, "class=\"post-card card my-post\"", "router.push({ path: `/post/${p.dbId}` })")
    && !profile.includes(`:to="'/post/' + p.dbId"`));

ok("C9 计数/空态/回复等文案复用 comment.*（不新造词条）",
  has(comp, "t(\"comment.count\"", "t(\"comment.empty\"", "t(\"comment.reply\"", "t(\"comment.placeholder\"")
    && !comp.includes("mycmt."),
  "新造词条要同步五语，容易漏；comment.* 已全语齐备");

ok("C10 认帖子用 dbId（云端主键），不是本地 id",
  comp.includes("props.post && props.post.dbId != null ? props.post.dbId : null")
    && comp.includes("cloudFetchComments(id)"),
  "用 p.id 会拉到 undefined：本地 id 与云端主键不是一回事");

ok("C11 空评论也照常显示「0 条评论」（不是整块消失）",
  comp.includes("t(\"comment.count\", { n: count })") && !comp.includes("v-if=\"count\""),
  "用户报的是「什么都没有」，藏掉计数就退回原样了");

/* ── 纯函数口径自检：计数两种来源（与组件里同一批函数） ── */
const { displayCount } = await import("../src/utils/comments.js");
ok("C12 displayCount：没拉过 → 用云端聚合数；拉过（哪怕空）→ 以本地为准",
  displayCount(undefined, 4) === 4 && displayCount([], 4) === 0
    && displayCount([{ id: "a" }, { id: "b", deleted: true }], 9) === 1,
  `得到 ${displayCount(undefined, 4)} / ${displayCount([], 4)} / ${displayCount([{ id: "a" }, { id: "b", deleted: true }], 9)}`);

ok("C13 wall.js 的评论接口都自带登录/维护模式守卫（组件不用重复判）",
  wallJs.includes("export async function cloudInsertComment") && wallJs.includes("canUseWall()")
    && wallJs.includes("guardWrite()"));

ok("C14 一级评论渲染函数认软删（墓碑只在有活回复时留）",
  commentsJs.includes("export function renderTops") && commentsJs.includes("return arr.some((r) =>"));

if (fails.length) {
  console.log(`\n${pass} passed, ${fails.length} failed`);
  process.exit(1);
}
console.log(`\n全部通过：${pass} 项`);
