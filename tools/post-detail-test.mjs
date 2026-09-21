/* 帖子详情页（轮 19 ②）：/post/:id 独立页 + 单帖数据链守护
 * 跑法：node tools/post-detail-test.mjs */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
let pass = 0;
const fails = [];
const ok = (name, cond) => {
  if (cond) { pass++; return; }
  fails.push(name);
  console.log("FAIL  " + name);
};
const has = (src, ...needles) => needles.every((n) => src.includes(n));

const router = read("src/router.js");
const myPosts = read("src/views/MyPostsView.vue");
const detail = read("src/views/PostDetailView.vue");
const wall = read("src/utils/wall.js");
const dbSupa = read("src/utils/api/db.supabase.js");
const dbGate = read("src/utils/api/db.gateway.js");
const worker = read("worker/api.js");
const i18n = read("src/i18n.js");

/* ── 路由与入口 ── */
ok("router：/post/:id → postDetail（懒加载 PostDetailView）",
  has(router, 'path: "/post/:id"') && has(router, 'name: "postDetail"')
    && has(router, './views/PostDetailView.vue'));
ok("MyPostsView：点卡片进 /post/<dbId>（不再跳回暖心墙页面）",
  has(myPosts, "`/post/${p.dbId}`") && !myPosts.includes('query: { post: p.dbId }'));
ok("i18n：详情页复用现有键，未新增缺失键（comment/community/nav/common 均已双语）",
  has(i18n, "postDetail:") === false
    && /comment: \{[\s\S]*?count: "/.test(i18n)
    && /community: \{[\s\S]*?views: "/.test(i18n));

/* ── 详情页本体 ── */
ok("PostDetailView：数据链全部来自暖心墙现有 API（单帖/评论/回应/浏览/厌恶）",
  has(detail, "cloudFetchPost", "cloudFetchComments", "cloudInsertComment",
    "cloudDeleteComment", "cloudToggleReaction", "cloudAddView", "cloudToggleDislike"));
ok("PostDetailView：完整帖子卡（全文不截断 + 头像/署名/时间/配图/回应行/浏览厌恶）",
  has(detail, 'class="post-text"', "white-space: pre-wrap", 'class="pic"',
    'class="react-row"', 'class="post-foot"', "community.views"));
ok("PostDetailView：评论点击展开（cmt-toggle ↔ comment.count），两级回复可展开（comment.replies）",
  has(detail, 'class="cmt-toggle"', "comment.count", "comment.replies", "toggleReplies"));
ok("PostDetailView：就地回复（回复「回复」仍挂一级下并 @ 对方）",
  has(detail, "function startReply(cm, rp = null)") && has(detail, "cm.id + \":\" + rp.id")
    && has(detail, "comment.replyPh"));
ok("PostDetailView：未登录拦截（不能评论：commentSignIn；回应/厌恶给登录提示）",
  has(detail, "community.commentSignIn", "community.reactSignIn", "community.dislikeSignIn")
    && has(detail, "if (!signedIn.value) return;"));
ok("PostDetailView：删自己的评论（云端比对 userId；删一级连回复一起）",
  has(detail, "cm.cloud && myId.value && cm.userId === myId.value")
    && has(detail, "c.id !== cm.id && c.parentId !== cm.id"));
ok("PostDetailView：进页计一次浏览（cloudAddView 幂等）+ 返回上一页",
  has(detail, "await cloudAddView(p.dbId, myId.value)")
    && has(detail, "function goBack()") && has(detail, "router.back()"));

/* ── 单帖数据链（wall → db 两适配器 → worker） ── */
ok("wall.js：cloudFetchPost 单帖读取（不存在/已下架 → null；回应聚合 + rowsToPosts）",
  has(wall, "export async function cloudFetchPost(dbPostId)")
    && has(wall, "db.getPost(dbPostId)")
    && has(wall, "rowsToPosts([post], reactions, publicUrl)[0]"));
ok("db.supabase：getPost 按 id 取行（removed 过滤 + 老库无列降级）",
  has(dbSupa, "async getPost(postId)")
    && has(dbSupa, '.eq("id", postId).eq("removed", false)')
    && has(dbSupa, 'res = await sb().from(T.posts).select("*").eq("id", postId).limit(1);'));
ok("db.gateway：getPost → GET /posts/:id（与 Worker 路由对齐）",
  has(dbGate, "async getPost(postId)") && has(dbGate, "call(`/posts/${enc(postId)}`)"));
ok("worker：GET /posts/:id 单帖路由（objectOrPassthrough 翻译行不存在；removed 400 降级）",
  has(worker, "} else if (seg.length === 2 && m === \"GET\") {")
    && has(worker, "return objectOrPassthrough(res);")
    && has(worker, '"&removed=eq.false" : ""'));

console.log(`post-detail-test: ${pass} pass, ${fails.length} fail`);
for (const f of fails) console.log("FAIL  " + f);
if (fails.length) process.exit(1);
