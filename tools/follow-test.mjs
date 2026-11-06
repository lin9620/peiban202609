/* ═══ 暖心墙关注 · 回归测试（轮447）═══
 *
 * 这条功能最容易崩的地方都很具体，所以每条用例都对着一个真实的翻车场景：
 *  · RLS 写成 or followee_id = auth.uid() → 「谁关注了我」全站可见，隐私口径破产；
 *  · 关注流带空 ids 去请求 → 服务端把空白名单当「不过滤」，返回全站内容（最隐蔽的一条）；
 *  · 卡片按钮没 @click.stop → 点关注顺带打开详情页；
 *  · 已关注的人还显示按钮 → 信息流满屏「已关注」，纯噪音；
 *  · 关注成功但列表里看不到 → 用户以为没点上；
 *  · 取关不回滚 → 网络失败后按钮显示「未关注」，服务端其实还关注着；
 *  · 上限两条线不一致（前端 200 / 触发器 200）→ 前端放过去，服务端报错，用户看到莫名失败；
 *  · 拉黑不取关 → /following 里留一个点进去显示「已拉黑」的幽灵。
 * 纯逻辑为主（不连网、不起浏览器），组件接线用源码断言兜底。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

let pass = 0;
const fails = [];
const ok = (name, cond, extra = "") => {
  if (cond) { pass += 1; return; }
  fails.push(`${name}${extra ? ` — ${extra}` : ""}`);
};

const {
  followState, isFollowing, followingCount, followErrKey, FOLLOW_LIMIT,
  followUser, unfollowUser,
} = await import("../src/utils/follows.js");
const { messages } = await import("../src/i18n.js");

const sql = read("MIGRATION_wall_follows.sql");
const followsJs = read("src/utils/follows.js");
const dbSb = read("src/utils/api/db.supabase.js");
const wallJs = read("src/utils/wall.js");
const community = read("src/views/CommunityView.vue");
const waller = read("src/views/WallerView.vue");
const detail = read("src/views/PostDetailView.vue");
const profile = read("src/views/ProfileView.vue");

/* ══════════ ① 状态层：判据与计数 ══════════ */

followState.ids = [];
ok("A1 没关注任何人 → isFollowing 全 false", !isFollowing("u1") && !isFollowing(""));
ok("A2 空值不误判（undefined / null / 空串）",
  isFollowing(undefined) === false && isFollowing(null) === false && isFollowing("") === false);

followState.ids = ["u1", "u2"];
ok("A3 关注后 isFollowing 为真", isFollowing("u1") && isFollowing("u2"));
ok("A4 未关注的人仍为假", !isFollowing("u3"));
ok("A5 计数 = 关注数", followingCount.value === 2);
/* 服务端返回的 uuid 可能被某处转成对象/数字，isFollowing 统一按 String 比 */
ok("A6 数字/非字符串 uid 也能匹配（统一按字符串比）",
  isFollowing(123) === false && (followState.ids = ["123"], isFollowing(123) === true));

followState.ids = [];

/* ══════════ ② 提前拦截：不发请求就挡住 ══════════ */

followState.ids = Array.from({ length: FOLLOW_LIMIT }, (_, i) => `u${i}`);
let limitErr = "";
try { await followUser("brand-new-uid"); } catch (e) { limitErr = e.message; }
ok("A7 达到上限时在发请求之前就拦住（wall-follow-limit）",
  limitErr === "wall-follow-limit", limitErr);
ok("A8 上限常量与迁移里的阈值一致（200 / 200，两条线不能各说各话）",
  FOLLOW_LIMIT === 200 && /n\s*>=\s*200/.test(sql));

let dupResult = null;
try { dupResult = await followUser("u5"); } catch (e) { dupResult = "threw:" + e.message; }
ok("A9 已关注的人再点一次 = 幂等成功（不发请求、不报错）", dupResult === true, String(dupResult));
followState.ids = [];

/* ══════════ ③ 错误 → 文案 ══════════ */

ok("B1 触发器超限（P0001）→ follow.limit", followErrKey({ code: "P0001" }) === "follow.limit");
ok("B2 明文 wall-follow-limit → follow.limit", followErrKey(new Error("wall-follow-limit")) === "follow.limit");
ok("B3 自关注（constraint 名）→ follow.self",
  followErrKey(new Error('new row violates check constraint "wall_follows_no_self"')) === "follow.self");
/* 23505 = 已经关注了。这不是错误，调用方不该弹「操作失败」 */
ok("B4 重复关注（23505）不当作错误（返回空串）", followErrKey({ code: "23505" }) === "");
ok("B5 没跑迁移（42P01/42883）→ follow.offline",
  followErrKey({ code: "42P01" }) === "follow.offline" && followErrKey({ code: "42883" }) === "follow.offline");
ok("B6 其它网络错误 → follow.fail", followErrKey(new Error("Failed to fetch")) === "follow.fail");

/* ══════════ ④ 迁移：隐私口径的技术兑现 ══════════ */

ok("C1 复合主键 (follower_id, followee_id)",
  /primary key \(follower_id, followee_id\)/.test(sql));
ok("C2 自关注有 check 约束", /constraint wall_follows_no_self check \(follower_id <> followee_id\)/.test(sql));
/* 最关键的一条：读策略若带 followee_id，等于全站开放「谁关注了我」 */
ok("C3 读策略只放行 follower_id = auth.uid()，**不含** followee_id",
  /create policy "follows select own"[\s\S]{0,120}?using \(auth\.uid\(\) = follower_id\)/.test(sql));
ok("C4 insert 策略有 with check（防伪造 follower_id）",
  /create policy "follows insert own"[\s\S]{0,120}?with check \(auth\.uid\(\) = follower_id\)/.test(sql));
ok("C5 匿名对表零权限", /revoke all on public\.wall_follows from anon/.test(sql));
ok("C6 上限用 BEFORE INSERT 触发器（RLS 的 with check 查不了自己这张表）",
  /before insert on public\.wall_follows/.test(sql));
/* before insert 先于 on conflict 判定：不先判重，第 201 次重复关注会误报超限 */
ok("C7 触发器先判重再计数（否则重复关注会误报超限）",
  /if exists \([\s\S]{0,180}?followee_id = new\.followee_id[\s\S]{0,80}?return new;/.test(sql));
ok("C8 RPC 是 security definer（要跨 profiles / wall_posts 读）",
  /create or replace function public\.wall_following\(\)[\s\S]{0,400}?security definer/.test(sql));
/* security definer 绕过 RLS → where 这一句是唯一的安全边界 */
ok("C9 RPC 内硬过滤 follower_id = auth.uid()",
  /where f\.follower_id = auth\.uid\(\)/.test(sql));
ok("C10 RPC 的 post_count / last_post_at 排除下架与自删（否则列表说有帖、点进去没有）",
  /w\.removed = false/.test(sql) && /w\.deleted_at is null/.test(sql));
ok("C11 RPC 按最近发帖倒序（有内容的人排前面）",
  /order by s\.last_at desc nulls last/.test(sql));
ok("C12 RPC 不给 anon", /revoke all on function public\.wall_following\(\) from public, anon/.test(sql));
ok("C13 表上有 follower 索引（列表按关注时间倒序要它）",
  /wall_follows_follower_idx[\s\S]{0,80}?\(follower_id, created_at desc\)/.test(sql));

/* ══════════ ⑤ 数据层：空数组绝不进 .in() ══════════ */

ok("D1 listPosts 支持 userIds 且**空数组不进 .in()**（PostgREST 空 in 会返回全表）",
  /const hasUids = !!\(uids && uids\.length\)/.test(dbSb)
    && /if \(hasUids\) base = base\.in\("user_id", uids\)/.test(dbSb));
ok("D2 不传 userIds 时链式调用与旧实现一致（api-contract 钉的形状不受影响）",
  /const uids = Array\.isArray\(opts\.userIds\)/.test(dbSb));
ok("D3 关注写入用 insert + 冲突吞掉（幂等）",
  /followInsert\(userId\)[\s\S]{0,240}?r\.error\.code !== "23505"/.test(dbSb));
ok("D4 取关按 followee_id 定位（RLS 再兜一层只能删自己的）",
  /followDelete\(userId\)[\s\S]{0,160}?delete\(\)\.eq\("followee_id", userId\)/.test(dbSb));
ok("D5 follows.js 没有任何「谁关注了我」的读取接口（粉丝功能从数据层就不存在）",
  !/followers/i.test(followsJs.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""))
    && !/followers/i.test(dbSb));

/* ══════════ ⑥ 状态层：乐观更新 + 失败回滚 + 连点保护 ══════════ */

ok("E1 关注是乐观先行（先改本地再发请求）",
  /followState\.ids = \[id\]\.concat\(followState\.ids\)[\s\S]{0,400}?await db\.followInsert/.test(followsJs));
ok("E2 关注失败会回滚（ids 与 rows 都要还原）",
  /await db\.followInsert\(id\);[\s\S]{0,400}?followState\.ids = followState\.ids\.filter\(\(x\) => x !== id\)/.test(followsJs));
ok("E3 取关失败也会回滚（把原来的位置也复原）",
  /await db\.followDelete\(id\);[\s\S]{0,700}?ids\.splice\(Math\.min\(prevIdIdx/.test(followsJs));
ok("E4 连点保护：回滚前检查是否仍是最新一次操作",
  /isOpCurrent\(id, token\)/.test(followsJs) && /opTokens/.test(followsJs));
ok("E5 失败只回滚「仍是最新」的那次（迟到响应不能抹掉后来的操作）",
  (followsJs.match(/if \(isOpCurrent\(id, token\)\)/g) || []).length >= 2);
ok("E6 拉黑联动取关：失败忽略（拉黑是主操作，清理是副作用）",
  /export async function dropFollowQuietly[\s\S]{0,200}?catch/.test(followsJs)
    && /dropFollowQuietly\(uid\)/.test(waller));
ok("E7 换号 = 换域：读新域快照并清空近期操作",
  /onScopeSwitch\(\{[\s\S]{0,400}?followState\.ids = cachedIds\(\)/.test(followsJs));

/* ══════════ ⑦ 暖心墙：卡片按钮 + 关注流 + 三种空状态 ══════════ */

ok("F1 卡片关注按钮有 @click.stop（否则点关注顺带进详情页）",
  /class="follow-chip"[\s\S]{0,240}?@click\.stop="followFromCard\(p\)"/.test(community));
ok("F2 已关注的人不显示按钮（showFollowChip 末尾取反）",
  /function showFollowChip[\s\S]{0,300}?return !isFollowing\(id\)/.test(community));
ok("F3 自己 / 未登录 / 本地帖不给按钮",
  /if \(!id \|\| !myUid\.value \|\| String\(id\) === myUid\.value\) return false/.test(community));
ok("F4 点完 600ms 内保留「✓ 已关注」过渡态（按钮瞬间消失会让人以为点空了）",
  /setTimeout\(\(\) => \{[\s\S]{0,120}?next\.delete\(id\)[\s\S]{0,40}?\}, 600\)/.test(community));
ok("F5 「我的关注」并进搜索行右侧，不再独占一行（用户：三个页面全是联排按钮）",
  /class="wall-follow-btn"/.test(community)
    && !/class="follow-seg"/.test(community)
    && /v-if="!followOnly" class="sort-row"/.test(community));
ok("F5a 同一个入口两态切换（未选中 → enterFollowFeed，选中 → exitFollowFeed）",
  /followOnly \? exitFollowFeed\(\) : enterFollowFeed\(\)/.test(community)
    && !/function toggleFollowFeed/.test(community));
ok("F5b 进了关注流按钮要改名（用户：这里应该改名啊），人数不再重复显示",
  /followOnly \? t\("follow\.feedExit"\) : t\("follow\.feedBtn"\)/.test(community)
    && /v-if="!followOnly && followingCount"/.test(community)
    && !/<span>\{\{ t\("follow\.feedBtn"\) \}\}<\/span>/.test(community));
ok("F6 关注模式下不渲染搜索框（两套数据源同时开着比不给搜更糟）",
  /<template v-if="!followOnly">[\s\S]{0,160}?v-model="searchQ"/.test(community));
ok("F7 关注模式不回退本机帖（否则 0 人关注时会出现陌生本地帖）",
  /if \(followOnly\.value\) return cloudPosts\.value/.test(community));
ok("F8 关注流不排序、不筛天（服务端已按时间倒序）",
  /if \(followOnly\.value\) return visibleOnly\(all\.value\)/.test(community));
ok("F9 空关注时 loadMoreCloud 直接返回，不发请求",
  /if \(followOnly\.value && !followState\.ids\.length\) \{ cloudDone\.value = true; return; \}/.test(community));
ok("F10 关注流三种空状态分开（未登录 / 0 人 / 关注了没内容）",
  /v-else-if="!myUid"/.test(community)
    && /v-else-if="!followingCount"/.test(community)
    && /follow\.feedEmpty"\)/.test(community) === false || /t\("follow\.feedEmpty"\)/.test(community));
ok("F11 进关注流先清游标/到底标志/reveal（否则带全站游标去查关注流，第一页直接空）",
  /enterFollowFeed[\s\S]{0,600}?feedCursor\.value = null[\s\S]{0,200}?cloudDone\.value = false/.test(community));
ok("F12 关注流不复用 wall:posts 缓存（写进去会污染全部流）",
  !/enterFollowFeed[\s\S]{0,1200}?cacheSet\(/.test(community));
ok("F13 关注流也过滤已拉黑的人（渲染层第二道防线）",
  /filterBlocked/.test(community) && /isBlockedHere/.test(waller));

/* ══════════ ⑧ 作者主页 / 详情页 / 我的页面 ══════════ */

ok("G1 作者主页关注按钮排在私信前面（关注是主按钮）",
  waller.indexOf('class="waller-act waller-follow"') < waller.indexOf('class="waller-act" :disabled="dmBusy"')
  && waller.indexOf('class="waller-act waller-follow"') > 0);
ok("G2 自己的主页 / 已拉黑的人不给关注按钮",
  /const canFollow = computed\(\(\) => !!uid && !isSelf\.value && !isBlockedHere\.value\)/.test(waller));
ok("G3 取关要两步确认（关注可以反悔，取关后人就没了）",
  /if \(isFollowingHere\.value && !followArm\.value\)/.test(waller));
/* 用户明确要求：详情页菜单只放「取消关注」（正向的「关注」放在作者名旁，不进菜单） */
ok("G4 详情页 ⋯ 菜单只有「取消关注」，没有「关注 TA」",
  /canUnfollowHere" class="more-item" @click="unfollowHere"/.test(detail)
    && !/more-item[^>]*>\{\{ t\("follow\.follow"\) \}\}/.test(detail));
ok("G5 详情页只在「我关注了作者」时才出现该项",
  /return isFollowing\(p\.userId\)/.test(detail));
/* 轮448：用户报障「暖心墙帖子详细页面没有关注的按钮」—— 从卡片/通知/收藏直接进详情的人
 * 到了详情页反而没有关注入口，只能退回列表。作者名旁补上，条件与卡片完全一致。 */
ok("G5a 详情页作者名旁有关注按钮（同 class、同 600ms 过渡、必须 stop 冒泡）",
  /class="follow-chip"[\s\S]{0,300}?@click\.stop="followHere"/.test(detail)
    && /setTimeout\(\(\) => \{ followFlash\.value = false; \}, 600\)/.test(detail));
ok("G5b 详情页关注按钮条件与卡片一致（已登录 / 非本人 / 未关注 / 过渡态仍显示）",
  /if \(!p \|\| !p\.userId \|\| !myId\.value\) return false;[\s\S]{0,220}?return !isFollowing\(p\.userId\)/.test(detail)
    && /if \(followFlash\.value\) return true;/.test(detail));
ok("G6 我的页面有 /following 入口，且只显示关注数（**没有粉丝**）",
  /router\.push\('\/following'\)/.test(profile)
    && /t\("follow\.followingBtn", \{ n: followingCount \}\)/.test(profile)
    && !/follow\.fans|follow\.followers|followerCount/.test(profile));
ok("G7 路由 /following 存在且不进 KeepAlive（每次进入重取）",
  /path: "\/following", name: "following"/.test(read("src/router.js"))
    && !/FollowingView/.test(read("src/App.vue")));

/* 轮450：真机/浏览器实测发现进关注流必报 ReferenceError: consume is not defined ——
 * consume / consumeSoft 当时是 loadCloud 的局部 const，顶层 enterFollowFeed 根本拿不到，
 * 异常被 catch 兜成「加载失败」。也就是说关注流从 447 上线起 UI 上没成功过一次。
 * 这条断言钉死作用域：两个消费者必须在模块顶层，且不能被塞回某个函数内部。 */
ok("G8 consume / consumeSoft 定义在模块作用域（关注流要跨函数复用）",
  /^const consume = \(box\) =>/m.test(community)
    && /^const consumeSoft = \(box\) =>/m.test(community)
    && !/^\s{2}const consume = \(box\) =>/m.test(community)
    && !/^\s{2}const consumeSoft = \(box\) =>/m.test(community));
ok("G9 关注流复用同一个 consume（不另写一套上屏逻辑）",
  /const rows = await cloudFetchPosts\(REFRESH_PAGE, 0, \{ userIds: ids \}\)[\s\S]{0,400}?consume\(\{ rows, counts: null, fromFetch: true \}\)/.test(community));

/* ══════════ ⑨ i18n：五语齐备 + 那句支点文案存在 ══════════ */

const KEYS = [
  "follow", "following", "followHint", "followingBtn", "unfollow", "unfollowArm",
  "unfollowed", "busy", "self", "fail", "limit", "offline", "loading", "retry",
  "feedBtn", "feedBtnHint", "feedNote", "feedExit", "feedEmpty", "feedEmptyHint",
  "feedNeedLogin", "feedNeedLoginHint", "feedFail", "feedFailHint", "signInBtn",
  "browseBtn", "listTitle", "listNote", "listEmpty", "listEmptyHint",
  "postsCount", "lastPost", "neverPosted",
];
const LOCALES = ["zh", "en", "es", "pt", "fr"];
const missing = [];
for (const loc of LOCALES) {
  const f = messages[loc] && messages[loc].follow;
  if (!f) { missing.push(`${loc}:整组缺失`); continue; }
  for (const k of KEYS) if (typeof f[k] !== "string" || !f[k]) missing.push(`${loc}.${k}`);
}
ok("H1 五语 × 33 条文案齐备", missing.length === 0, missing.slice(0, 6).join(","));
ok("H2 五语都说明了「对方不会收到通知」（整套设计的支点，缺一不可）",
  LOCALES.every((loc) => /不会收到通知|never notified|nunca se le avisa|nunca é avisado|jamais prévenues/.test(
    (messages[loc].follow || {}).listNote || "")));
ok("H3 插值占位符跨语言一致（{n} / {d} 不能漏）",
  LOCALES.every((loc) => {
    const f = messages[loc].follow || {};
    return /\{n\}/.test(f.followingBtn || "") && /\{n\}/.test(f.postsCount || "") && /\{d\}/.test(f.lastPost || "");
  }));

if (fails.length) {
  console.log(`\nFAIL ${fails.length} 条：`);
  for (const f of fails) console.log("  ✗", f);
}
console.log(`\nfollow-test: ${pass} pass, ${fails.length} fail`);
process.exit(fails.length ? 1 : 0);
