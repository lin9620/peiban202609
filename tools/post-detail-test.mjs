/* 帖子详情页（轮 19 ②）：/post/:id 独立页 + 单帖数据链守护
 * 跑法：node tools/post-detail-test.mjs */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { applyPostReactionPatch, patchPostList, onPostReaction, publishPostReaction } from "../src/utils/postReactionSync.js";

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
const community = read("src/views/CommunityView.vue");
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
const profileView = read("src/views/ProfileView.vue");
/* 轮 460：卡片从 router-link 改成 article + router.push（卡内要放评论输入框/按钮），
 * 目标仍是 /post/<dbId> —— 这条断言的意图是「进的是详情页、不是暖心墙」，形态换了要跟着换。 */
ok("ProfileView：「我的」页帖子卡同样进 /post/<dbId>（轮 20 修复跳暖心墙的漏改）",
  has(profileView, "router.push({ path: `/post/${p.dbId}` })") && !profileView.includes("query: { post: p.dbId }")
    && !profileView.includes("path: \"/community\""));
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
ok("PostDetailView：评论点击展开（cmt-toggle ↔ comment.count），两级回复可展开（轮88 底部展开钮 comment.expandOthers）",
  has(detail, 'class="cmt-toggle"', "comment.count", "comment.expandOthers", "toggleReplies"));
/* 轮 383：二级回复一次不挂满，每批 30 条 + 底部继续展开（用户拍板） */
ok("PostDetailView 轮383：二级回复每批 30 条，未展示完时给「继续展开」钮",
  has(detail, "REPLY_PAGE", "pageReplies", "function moreReplies", "repsHidden", "comment.moreReplies")
    && detail.indexOf("repsHidden(cm) > 0") < detail.indexOf('v-if="repsOf(cm).length > 2"'));
ok("PostDetailView：就地回复（回复「回复」仍挂一级下并 @ 对方；轮108续5 起手机端走底部输入条，桌面就地框）",
  has(detail, "function startReply(cm, rp = null, e = null)") && has(detail, "cm.id + \":\" + rp.id")
    && has(detail, "comment.replyPh"));
ok("PostDetailView：未登录拦截（不能评论：卡内输入位给登录入口 barSignIn；回应/厌恶给登录提示）",
  has(detail, "comment.barSignIn", "community.reactSignIn", "community.dislikeSignIn")
    && has(detail, "if (!signedIn.value) return;"));
/* ─── 轮 111 · 详情页桌面主评论输入框位置（用户：「放在评论按钮跟浏览次数按钮中间。跟上面的
         网页端1条一样。app端不改」）─── */
ok("PostDetailView 轮111：桌面主评论输入框在「浏览次数」与「评论按钮」之间（卡内常驻、App 端不渲染；悬浮底栏 cmt-bar-fixed 退役）",
  has(detail, 'id="detail-cmtmain"', 'class="cmt-input cmt-input-top"', "sendTopCmt", "comment.barSignIn")
    && detail.indexOf('class="post-foot"') < detail.indexOf("cmt-input-top")
    && detail.indexOf("cmt-input-top") < detail.indexOf('class="cmt-bar"')
    && detail.indexOf('class="cmt-bar"') < detail.indexOf('class="cmt-toggle"')
    && !detail.includes('class="cmt-bar-fixed"'));   /* 悬浮底栏真退役（注释里提到名字不算） */
/* ─── 轮 112 · 详情页一级评论回复框位置（用户：「一级评论回复框点击后出现在一级评论下面，二级评论上面，
         你现在是一级评论最下面。二级评论输入框不改。app端不改」）─── */
ok("PostDetailView 轮112：一级回复框在「本评论操作行」之下、「二级回复列表」之上（二级就地框仍在二级列表内、手机端仍是底部输入条）",
  detail.indexOf('class="cmt-acts"') < detail.indexOf('repActive === cm.id"')
    && detail.indexOf('repActive === cm.id"') < detail.indexOf('class="cmt-reps"')
    && detail.indexOf('class="cmt-reps"') < detail.indexOf("repActive === cm.id + ':' + rp.id\"")
    && detail.indexOf("repActive === cm.id + ':' + rp.id\"") < detail.indexOf('class="replies-toggle"')
    && has(detail, 'v-if="!cm.deleted && !isMobileNav && repActive === cm.id"', "repPlaceholder(cm)"));
ok("PostDetailView：删自己的评论（云端比对 userId；轮 285 软删 —— 只标 deleted、不再连带删回复）",
  has(detail, "cm.cloud && myId.value && cm.userId === myId.value")
    && has(detail, "markDeleted(comments.value, cm.id)")
    && !has(detail, "c.id !== cm.id && c.parentId !== cm.id")
    && has(detail, "t(\"comment.deleted\")"));
/* ─── 轮 298 · 墓碑线程内活回复可回（轮 285 守卫连坐的回归锁）───
 * 轮 301：判据收口到 comments.replyBlocked（两视图同源），断言只锁「收口了、裸连坐没回来」。 */
ok("PostDetailView 轮298：守卫按「回复目标被删没」判——直接回墓碑（rp 空）拦、回墓碑下活的 cde 放行",
  has(detail, "replyBlocked(cm, rp)")
    && !/if\s*\(\s*cm\s*&&\s*cm\.deleted\s*\)\s*return/.test(detail)   /* 裸连坐判断不许回来 */
    && has(detail, "if (rp && rp.deleted) return;"));
/* 轮 359：hint 是模板/脚本共用的提示状态。漏声明时，回应按钮的乐观更新已经上屏，
 * 但紧接着 `hint.value = ""` 抛 ReferenceError，落库队列根本不会启动 —— 用户看到
 * 「点完亮了，返回再进又没了」。这条锁住声明本身，避免同类漏声明再次静默。 */
ok("PostDetailView 轮359：hint 提示 ref 已声明（漏声明会中断回应/收藏落库）",
  /const\s+hint\s*=\s*ref\(/.test(detail) && detail.includes('v-if="hint"'));
ok("PostDetailView：进页计一次浏览（cloudAddView 幂等）+ 返回上一页",
  has(detail, "await cloudAddView(post.value.dbId, myId.value)")   /* 轮 172：p → post.value */
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

/* 轮 370 · 详情 ↔ 暖心墙回应同步（用户实测：详情点同感，返回墙没亮；墙点同感，进详情等很久） */
const basePost = {
  dbId: 7,
  reacts: { hug: 2, warm: 0, relate: 1 },
  mine: { hug: true, warm: false, relate: false },
};
const merged = applyPostReactionPatch(basePost, {
  reacts: { relate: 2 },
  mine: { relate: true },
});
ok("postReactionSync：只合并本次 kind，其它回应保持原样",
  merged !== basePost && merged.reacts.relate === 2 && merged.mine.relate === true
    && merged.reacts.hug === 2 && merged.mine.hug === true
    && merged.reacts.warm === 0 && merged.mine.warm === false);
ok("postReactionSync：同值补丁返回原对象（避免无意义重渲染）",
  applyPostReactionPatch(basePost, { reacts: { relate: 1 }, mine: { relate: false } }) === basePost);
ok("postReactionSync：负计数钳到 0", applyPostReactionPatch(basePost, { reacts: { relate: -9 } }).reacts.relate === 0);
const otherPost = { dbId: 8, reacts: { relate: 5 }, mine: { relate: true } };
const list = [basePost, otherPost];
const listPatched = patchPostList(list, "7", { reacts: { relate: 2 }, mine: { relate: true } });
ok("postReactionSync：patchPostList 只改命中的那篇，未命中返回原数组",
  listPatched !== list && listPatched[0].reacts.relate === 2
    && listPatched[0].mine.relate === true && listPatched[1] === otherPost
    && patchPostList(list, "999", { reacts: { relate: 0 } }) === list);
let busHit = null;
const stopBus = onPostReaction((id, patch) => { busHit = { id, patch }; });
publishPostReaction(7, { reacts: { relate: 2 }, mine: { relate: true } });
ok("postReactionSync：跨页事件带字符串帖 id 与补丁", busHit && busHit.id === "7" && busHit.patch.mine.relate === true);
stopBus();
const oldHit = busHit;
publishPostReaction(7, { reacts: { relate: 0 } });
ok("postReactionSync：取消订阅后不再收到事件", busHit === oldHit);

const goDetailBody = community.slice(
  community.indexOf("function goDetail(p)"),
  community.indexOf("function goDetailReplies"),
);
ok("CommunityView：进详情前写 wall:post 缓存（弱网先渲染，不再空等）",
  goDetailBody.includes("cachePostView(p)"));
ok("CommunityView：墙内乐观/权威回应都写单帖缓存（详情进来先看到已点状态）",
  community.includes("马上点进详情") && community.includes("详情页进来先读这份缓存"));
ok("CommunityView：订阅详情页的回应事件，KeepAlive 返回墙立即更新",
  has(community, "onPostReaction((id, patch) =>", "applyPostReactionPatch", "stopPostReactionSync")
    && community.includes("nextCloud !== cloudPosts.value"));
ok("PostDetailView：乐观回应立即广播 + 写缓存（返回墙立刻亮）",
  detail.includes("publishPostReaction(p.dbId, { reacts: { [key]: reacts[key] }, mine: { [key]: target } })")
    && detail.includes("cacheSet(cacheKey(\"wall:post\", uid.value), post.value);"));
ok("PostDetailView：权威回包/失败回滚都同步墙（墙不会停在乐观值或失败值）",
  (detail.match(/publishPostReaction\(p\.dbId, patch\)/g) || []).length >= 1
    && detail.includes("publishPostReaction(dbId, patch)"));

/* 轮 372 · 我的页 / 我的帖子 ↔ 详情回应同步（用户实测：我的页 0，详情 2） */
ok("ProfileView：回应数随帖子一起回来再写缓存（不再先写 0 再后台补）",
  profileView.includes("cloudFetchUserPosts(uid, 3)")
    && !profileView.includes("db.listPostsByUser(uid, 3)"));
ok("ProfileView：KeepAlive 下订阅详情回应并回写 profile-myposts 缓存",
  has(profileView, "onPostReaction(syncProfileReaction)", "patchPostList", "cachePatch(cacheKey(\"profile-myposts\", uid)"));
ok("ProfileView：进详情前写 wall:post 缓存（详情先渲染正确计数）",
  has(profileView, "function openMyPost(p)", "cacheSet(cacheKey(\"wall:post\", p.dbId), p)", "@click=\"openMyPost(p)\""));
ok("MyPostsView：订阅详情回应并回写 myposts 缓存 + 进详情写 wall:post",
  has(myPosts, "onPostReaction((id, patch)", "patchPostList", "cachePatch(cacheKey(\"myposts\", u)",
    "cacheSet(cacheKey(\"wall:post\", p.dbId), p)"));
ok("PostDetailView：回应变化补两份列表缓存（/my-posts 不在 KeepAlive 也不漏）",
  has(detail, "function syncReactionListCaches", "cachePatch(cacheKey(name, u)", "patchPostList(list, dbId, patch)"));

/* 轮 201：表情面板功能整体移除（用户定案）——轮 180 的表情覆盖断言一并摘除。
 * 输入框回归纯文字；用户仍可用输入法自带表情。 */

console.log(`post-detail-test: ${pass} pass, ${fails.length} fail`);
for (const f of fails) console.log("FAIL  " + f);
if (fails.length) process.exit(1);
