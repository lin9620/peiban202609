/* ═══ 作者删除自己的内容 · 回归测试（轮446）═══
 *
 * 这两条功能的失败模式都很具体，所以每条用例都对着一个真实的翻车场景：
 *  · 暖心墙：菜单对别人也显示删除 → 别人点了「删除」没反应（或者更糟，删了）；
 *  · 暖心墙：删了却没过滤干净 → 帖子在别处还活着，等于「假删除」；
 *  · 漂流瓶：海里的信被撤回后还能被捞到 → 白撤回；
 *  · 漂流瓶：被捞走的信还能撤回 → 对方手里的信凭空消失；
 *  · 漂流瓶：待我决定的信被隐藏 → 红点亮了却找不到那封信；
 *  · 漂流瓶：隐藏后收到回信还藏着 → 用户错过最重要的一条提醒。
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

const { canDeletePost } = await import("../src/utils/wallRules.js");
const {
  canWithdrawLetter, canHideLetter, bottleErrKey,
} = await import("../src/utils/bottle.js");
const { messages } = await import("../src/i18n.js");

const ME = "uid-me";
const OTHER = "uid-other";

/* ══════════ ① 暖心墙：删除判据 ══════════ */

const post = (over = {}) => ({
  id: "vm-1", dbId: 12, userId: ME, text: "hi", cloud: true, ...over,
});

ok("P1 作者本人能删自己的云端帖", canDeletePost(post(), ME) === true);
ok("P2 别人的帖子不给删", canDeletePost(post(), OTHER) === false);
ok("P3 未登录不给删（连带防住「游客点删除」）", canDeletePost(post(), "") === false);
ok("P4 没 dbId 的本地帖不给删", canDeletePost(post({ dbId: null }), ME) === false);
ok("P5 非云端帖不给删", canDeletePost(post({ cloud: false }), ME) === false);
ok("P6 空对象不炸", canDeletePost(null, ME) === false && canDeletePost({}, ME) === false);
/* 与举报互斥：举报要求 userId !== 我。同一帖不可能两个菜单项同时出现 */
ok("P7 与举报互斥（同一帖不会同时出现举报和删除）",
  [post(), post({ userId: OTHER })].every((p) => !(canDeletePost(p, ME) && p.userId !== ME)));

/* ══════════ ② 漂流瓶：撤回判据 ══════════ */

const letter = (over = {}) => ({ id: "L1", user_id: ME, status: "sea", ...over });

ok("W1 还在海里 → 可撤回", canWithdrawLetter(letter()) === true);
ok("W2 被捞走 → 不可撤回", canWithdrawLetter(letter({ status: "held" })) === false);
ok("W3 已回信 → 不可撤回", canWithdrawLetter(letter({ status: "answered" })) === false);
ok("W4 已撤回过的 → 不再撤（幂等，按钮也不该出现）", canWithdrawLetter(letter({ deleted_at: "2026-11-07" })) === false);
ok("W5 空值不炸", canWithdrawLetter(null) === false);

/* ══════════ ③ 漂流瓶：隐藏判据（与 SQL where 条件逐条对应）══════════ */

ok("H1 被捞起没回信 → 可隐藏", canHideLetter(letter({ status: "held" }), ME) === true);
ok("H2 已回信且我婉拒了 → 可隐藏",
  canHideLetter(letter({ status: "answered", chat_decision: "declined" }), ME) === true);
ok("H3 还在海里 → 不给隐藏（该用撤回）", canHideLetter(letter(), ME) === false);
ok("H4 收到回信待我决定 → 不给隐藏（藏了就漏掉回信）",
  canHideLetter(letter({ status: "answered", chat_decision: "pending" }), ME) === false);
ok("H5 已同意聊天 → 不给隐藏（那是聊天入口）",
  canHideLetter(letter({ status: "answered", chat_decision: "accepted", conv_id: 9 }), ME) === false);
ok("H6 老数据 chat_decision 缺失时按 pending 保守处理",
  canHideLetter(letter({ status: "answered" }), ME) === false);
ok("H7 已经隐藏过 → 不再给按钮", canHideLetter(letter({ status: "held", hidden_at: "2026-11-07" }), ME) === false);
ok("H8 已撤回的 → 不给隐藏", canHideLetter(letter({ status: "held", deleted_at: "2026-11-07" }), ME) === false);
ok("H9 别人的信不给隐藏", canHideLetter(letter({ status: "held" }), OTHER) === false);
ok("H10 未登录不给隐藏", canHideLetter(letter({ status: "held" }), "") === false);
/* 撤回/隐藏两个按钮永远不会同时出现 —— 否则用户要面对「删还是藏」的无效选择 */
ok("H11 撤回与隐藏互斥",
  ["sea", "held", "answered"].every((st) => {
    const l = letter({ status: st, chat_decision: st === "answered" ? "declined" : "pending" });
    return !(canWithdrawLetter(l) && canHideLetter(l, ME));
  }));

/* ══════════ ④ 错误归类 ══════════ */

ok("E1 撤回撞上「刚被捞走」有专门文案",
  bottleErrKey(new Error("bottle-already-picked")) === "bottle.alreadyPicked");
ok("E2 维护期优先于「没跑迁移」（PT503 不能被当技术故障）",
  bottleErrKey(new Error("maintenance-mode")) === "bottle.errMaintenance");
ok("E3 未知错误仍落到通用文案", bottleErrKey(new Error("boom")) === "bottle.errGeneric");

/* ══════════ ⑤ 五语文案齐备 ══════════ */

const pick = (o, k) => k.split(".").reduce((a, p) => (a == null ? a : a[p]), o);
const NEED = [
  "post.delete", "post.deleteTitle", "post.deleteDesc", "post.deleted", "post.deleteFail",
  "bottle.withdraw", "bottle.withdrawTitle", "bottle.withdrawDesc", "bottle.withdrawn",
  "bottle.hide", "bottle.hideTitle", "bottle.hideDesc", "bottle.hidden",
  "bottle.hiddenN", "bottle.hideCollapse", "bottle.unhide", "bottle.unhidden",
  "bottle.alreadyPicked", "common.confirm",
];
for (const l of ["en", "zh", "es", "pt", "fr"]) {
  const miss = NEED.filter((k) => !pick(messages[l], k));
  ok(`I1 ${l} 删除/撤回文案齐备`, miss.length === 0, miss.join(","));
}
ok("I2 hiddenN 的 {n} 在五语一致",
  ["en", "zh", "es", "pt", "fr"].every((l) => String(pick(messages[l], "bottle.hiddenN")).includes("{n}")));

/* ══════════ ⑥ 组件接线（源码断言：改漏一处就红） ══════════ */

const community = read("src/views/CommunityView.vue");
const detail = read("src/views/PostDetailView.vue");
const mine = read("src/views/MyPostsView.vue");
const bottleView = read("src/components/BottleView.vue");
const wallJs = read("src/utils/wall.js");
const bottleJs = read("src/utils/bottle.js");

ok("C1 暖心墙菜单里有删除项", /canDeletePost\(p\)[\s\S]{0,120}deletePost\(p\)/.test(community));
ok("C2 详情页菜单里有删除项", /canDeletePost\(\)[\s\S]{0,120}deleteCurrentPost/.test(detail));
ok("C3 我的帖子页有删除按钮", /delPost\(p\)/.test(mine));
ok("C4 三处都走同一个云端动作", [community, detail, mine].every((s) => /cloudDeletePost\(/.test(s)));
ok("C5 暖心墙删除后清详情缓存（否则返回时闪回）", /cacheDrop\(cacheKey\("wall:post", id\)\)/.test(community));
ok("C6 我的帖子删除后同时清本页缓存", /cacheKey\("myposts"/.test(mine) && /cacheDrop\(/.test(mine));
ok("C7 漂流瓶记录卡有撤回 / 隐藏按钮",
  /withdrawLetter\(l\)/.test(bottleView) && /hideLetter\(l\)/.test(bottleView));
ok("C8 已隐藏区有恢复入口（隐藏 ≠ 删除，必须能找回）",
  /restoreLetter\(h\)/.test(bottleView) && /hiddenRows/.test(bottleView));
ok("C9 漂流瓶视图用的是纯函数判据（不是自己写一套 if）",
  /canWithdrawLetter\(l\)/.test(bottleView) && /canHideLetter\(l, myId\)/.test(bottleView));
ok("C10 删帖写入口接了维护守卫", /guardWrite\(\)/.test(wallJs) && /maintenance-mode/.test(wallJs));
ok("C11 撤回/隐藏也接了维护守卫",
  (bottleJs.match(/guardWrite\(\)/g) || []).length >= 3);

/* 轮448：用户报障「消息 → 漂流瓶」没有撤回按钮 —— 轮446 只做了 /bottle 页，
 * 而手机端消息页的漂流瓶段是 BottleRecords、桌面左列是 BottleChatList。 */
const bottleRecords = read("src/components/BottleRecords.vue");
const bottleChatList = read("src/components/BottleChatList.vue");
const letterOps = read("src/utils/letterOps.js");
ok("C12 手机端「消息→漂流瓶」记录卡也有撤回 / 隐藏",
  /withdrawRow\(row\)/.test(bottleRecords) && /hideRow\(row\)/.test(bottleRecords));
ok("C13 桌面端「消息→漂流瓶」左列也有撤回 / 隐藏",
  /withdrawRow\(row\)/.test(bottleChatList) && /hideRow\(row\)/.test(bottleChatList));
ok("C14 三处列表共用同一动作层（确认框/错误口径只此一份）",
  [bottleRecords, bottleChatList].every((s) => /useLetterOps\(/.test(s))
    && /bottleWithdraw/.test(letterOps) && /bottleHide/.test(letterOps));
ok("C15 列表里的撤回/隐藏仍走纯函数判据（不自己写一套 if）",
  [bottleRecords, bottleChatList].every((s) =>
    /canWithdrawLetter\(row\)/.test(s) && /canHideLetter\(row, userId\.value\)/.test(s)));
ok("C16 桌面左列撤回当前选中的信 → 通知父级清选中（中列不能停在已删的信上）",
  /emit\("removed"/.test(bottleChatList)
    && /@removed="onBottleRemoved"/.test(read("src/views/MessagesView.vue")));
ok("C17 左列的行点击区不会吞掉按钮（撤回/隐藏必须 @click.stop）",
  /class="bottle-op bottle-op-danger"[\s\S]{0,200}?@click\.stop="withdrawRow\(row\)"/.test(bottleChatList));

/* ══════════ ⑦ 迁移脚本自检（不连库，只钉关键语句）══════════ */

const sql = read("MIGRATION_owner_delete.sql");
ok("S1 删帖同时写 deleted_at 与 removed（借过滤面）",
  /set deleted_at = now\(\),\s*removed\s*=\s*true/.test(sql));
ok("S2 删帖只允许作者本人", /and user_id = auth\.uid\(\)/.test(sql));
ok("S3 读策略要求 removed 与 deleted_at 双条件（只判 removed 会在恢复时复活）",
  /removed = false and deleted_at is null/.test(sql));
ok("S4 捞信排除已撤回", /status = 'sea'[\s\S]{0,80}deleted_at is null/.test(sql));
ok("S5 「我发布的」列表过滤隐藏与撤回", /p_mine is true[\s\S]{0,120}hidden_at is null/.test(sql));
ok("S6 回信自动取消隐藏（否则红点亮了却找不到信）", /hidden_at = null/.test(sql));
ok("S7 撤回只允许 sea（被捞走的不可撤回）", /and status = 'sea'/.test(sql));
ok("S8 去重排除已撤回（撤回后可以重写同样内容）", /body_hash = v_hash[\s\S]{0,80}deleted_at is null/.test(sql));
ok("S9 撤回 RPC 没授给匿名（Supabase default privileges 会偷偷授 anon）",
  /revoke all on function public\.wall_post_delete\(bigint\) from public, anon/.test(sql));
/* 6.4 的坑：作者自删的帖子 removed 与 deleted_at 都非空，只把 removed 改回来列表照样看不到 */
ok("S10 管理员恢复帖子时一并清 deleted_at",
  /deleted_at: null/.test(read("src/utils/api/db.supabase.js"))
    && /removed \? \{ removed \} : \{ removed, deleted_at: null \}/.test(read("src/utils/api/db.supabase.js")));

if (fails.length) {
  console.log(`\nFAIL ${fails.length} 条：`);
  for (const f of fails) console.log("  ✗", f);
}
console.log(`\nowner-delete-test: ${pass} pass, ${fails.length} fail`);
process.exit(fails.length ? 1 : 0);
