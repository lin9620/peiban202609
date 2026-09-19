/* 通知规则层单测（纯函数 + i18n 键 + 聚合语义）
 * ------------------------------------------------------------
 * 重点：
 *  1. 分栏 → kinds 白名单必须与 SQL 的 notif_kind 白名单对得上（漏一类就查不到东西）；
 *  2. 聚合语义：「小A 和另外 3 人…」只在同帖同类（反应再分种类）内合并，
 *     私信/系统永不合并 —— 这类判断放纯函数里才测得动；
 *  3. 点击落点：私信跳会话、其余跳原帖，不能跳错地方；
 *  4. 未读数兜底：缺字段/负数/非对象一律给 0，角标不能显示 "undefined"。
 * 运行：node tools/notify-test.mjs
 */
import { readFileSync } from "node:fs";
import {
  KINDS, kindsFor, isKind, normUnread, aggKey, aggregate, itemView, targetOf, normPrefs,
} from "../src/utils/notifyRules.js";
import { messages } from "../src/i18n.js";

let pass = 0;
const fails = [];
function ok(name, cond, extra = "") {
  if (cond) pass++;
  else fails.push(name + (extra ? ` —— ${extra}` : ""));
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ───────── 分栏映射 ───────── */
ok("6 类通知与 SQL 白名单同源（数据库层仍收 dm；前端已不消费）", eq(KINDS, ["comment", "reply", "reaction", "pet", "dm", "system"]));
/* #23：私信退出通知中心——「全部」不再用 null（防老库残留 dm 冒出来），而是显式非 dm 白名单 */
ok("全部 → 显式非 dm 白名单", kindsFor("all") === "comment,reply,reaction,pet,system");
ok("全部 → 永不含 dm", !String(kindsFor("all") || "").split(",").includes("dm"));
ok("评论栏 = comment,reply", kindsFor("comments") === "comment,reply");
ok("回应栏 = reaction,pet", kindsFor("reactions") === "reaction,pet");
ok("宠物栏 = pet", kindsFor("pets") === "pet");
ok("私信分栏已移除（kindsFor 不再认识 dms → 落到 all 兜底）", kindsFor("dms") === "comment,reply,reaction,pet,system");
ok("系统栏 = system", kindsFor("system") === "system");
ok("未知分栏 → all 兜底（不炸、不漏 dm）", kindsFor("nope") === "comment,reply,reaction,pet,system");
ok("isKind 校验", isKind("reply") === true && isKind("pokes") === false);

/* 与迁移文件里的 check 约束逐字对齐 */
const mig = readFileSync("MIGRATION_dm_notifications.sql", "utf8");
const kindLine = (mig.match(/constraint notif_kind check \(kind in \(([^)]*)\)\)/) || [])[1] || "";
const sqlKinds = kindLine.split(",").map((s) => s.trim().replace(/'/g, "")).filter(Boolean);
ok("前端 KINDS 与 SQL 完全一致（含顺序）", eq(KINDS, sqlKinds), `${KINDS} vs ${sqlKinds}`);

/* ───────── 未读兜底 ───────── */
ok("未读：正常值", eq(normUnread({ total: 3, comments: 1, reactions: 2, pets: 1, dms: 4, system: 5 }),
  { total: 3, comments: 1, reactions: 2, pets: 1, dms: 4, system: 5 }));
ok("未读：缺字段补 0", eq(normUnread({ total: 2 }),
  { total: 2, comments: 0, reactions: 0, pets: 0, dms: 0, system: 0 }));
ok("未读：负数/小数/非数字一律归 0",
  eq(normUnread({ total: -5, comments: 1.7, reactions: "x", pets: null, dms: NaN, system: undefined }),
    { total: 0, comments: 1, reactions: 0, pets: 0, dms: 0, system: 0 }));
ok("未读：null → 全 0", eq(normUnread(null),
  { total: 0, comments: 0, reactions: 0, pets: 0, dms: 0, system: 0 }));

/* ──────── 聚合键 ──────── */
ok("聚合键：同帖同类同反应 → 同键",
  aggKey({ kind: "reaction", post_id: 7, id: 1, meta: { reaction: "hug" } }) ===
  aggKey({ kind: "reaction", post_id: 7, id: 2, meta: { reaction: "hug" } }));
ok("聚合键：反应种类不同 → 不同键",
  aggKey({ kind: "reaction", post_id: 7, id: 1, meta: { reaction: "hug" } }) !==
  aggKey({ kind: "reaction", post_id: 7, id: 2, meta: { reaction: "warm" } }));
ok("聚合键：不同帖 → 不同键",
  aggKey({ kind: "comment", post_id: 7, id: 1 }) !== aggKey({ kind: "comment", post_id: 8, id: 2 }));
ok("聚合键：私信永不合并", aggKey({ kind: "dm", conv_id: 3, id: 1 }) === "solo:1");
ok("聚合键：系统永不合并", aggKey({ kind: "system", id: 9 }) === "solo:9");
ok("聚合键：无帖子不合并", aggKey({ kind: "pet", id: 5 }) === "solo:5");
ok("聚合键：空值给空串", aggKey(null) === "");

/* ──────── 聚合语义 ───────── */
const list = [
  { id: 5, kind: "reaction", post_id: 7, actor_id: "u1", actor_name: "小A", meta: { reaction: "hug" }, read_at: null },
  { id: 4, kind: "reaction", post_id: 7, actor_id: "u2", actor_name: "小B", meta: { reaction: "hug" }, read_at: "2026-09-16" },
  { id: 3, kind: "reaction", post_id: 7, actor_id: "u3", actor_name: "小C", meta: { reaction: "hug" }, read_at: "2026-09-16" },
  { id: 2, kind: "dm", conv_id: 9, actor_id: "u4", actor_name: "小D", read_at: null },
  { id: 1, kind: "dm", conv_id: 9, actor_id: "u4", actor_name: "小D", read_at: null },
];
const agg = aggregate(list);
ok("聚合：3 个抱抱合成 1 条（另有 2 条私信）", agg.length === 3, `got ${agg.length}`);
ok("聚合：计数正确", agg[0].count === 3);
ok("聚合：保留最新一条的 id（点击跳它的落点）", agg[0].id === 5);
ok("聚合：收集到全部人名", eq(agg[0].actors, ["小A", "小B", "小C"]));
ok("聚合：任一条未读则整组未读", agg[0].read_at === null);
ok("聚合：私信不合并", agg.filter((x) => x.kind === "dm").length === 2);
ok("聚合：空数组不炸", eq(aggregate(null), []));
ok("聚合：单条也带 count=1", aggregate([list[3]])[0].count === 1);
ok("聚合：全已读 → 组保持已读",
  aggregate([
    { id: 2, kind: "comment", post_id: 1, actor_name: "A", read_at: "2026-09-16" },
    { id: 1, kind: "comment", post_id: 1, actor_name: "B", read_at: "2026-09-16" },
  ])[0].read_at === "2026-09-16");
ok("聚合：不因重复人名而重复计数人名",
  aggregate([
    { id: 2, kind: "comment", post_id: 1, actor_name: "A" },
    { id: 1, kind: "comment", post_id: 1, actor_name: "A" },
  ])[0].actors.length === 1);

/* ───────── 文案装配 ───────── */
const view = itemView({ id: 1, kind: "comment", actor_name: "小A", post_body: "今天有点累", count: 1 });
ok("文案键：评论", view.key === "notif.comment" && view.who === "小A" && view.post === "今天有点累");
ok("文案键：回复", itemView({ id: 1, kind: "reply" }).key === "notif.reply");
ok("文案键：回应带种类",
  itemView({ id: 1, kind: "reaction", meta: { reaction: "hug" } }).reaction === "hug");
ok("文案键：宠物带动作",
  itemView({ id: 1, kind: "pet", meta: { pet_kind: "feed" } }).petKind === "feed");
ok("文案键：私信带预览",
  itemView({ id: 1, kind: "dm", meta: { preview: "在吗" } }).preview === "在吗");
ok("文案键：系统带公告正文",
  itemView({ id: 1, kind: "system", meta: { body: "今晚维护" } }).systemBody === "今晚维护");
ok("文案键：未知类型有兜底", itemView({ id: 1, kind: "wat" }).key === "notif.fallback");
ok("文案：另外几人 = count-1", itemView({ id: 1, kind: "reaction", count: 4 }).others === 3);
ok("文案：空通知不炸", itemView(null) === null);
ok("未读标记：read_at 为空即未读", itemView({ id: 1, kind: "dm", read_at: null }).unread === true);
ok("未读标记：已读为 false", itemView({ id: 1, kind: "dm", read_at: "2026-09-16" }).unread === false);
ok("文案：meta 缺失不炸", itemView({ id: 1, kind: "reaction" }).reaction === "");

/* ───────── 点击落点 ──────── */
ok("落点：私信 → 会话", eq(targetOf({ kind: "dm", conv_id: 3 }), { type: "dm", convId: 3 }));
ok("落点：评论 → 原帖", eq(targetOf({ kind: "comment", post_id: 12 }), { type: "post", postId: 12 }));
ok("落点：无目标 → null", targetOf({ kind: "system" }) === null);
ok("落点：空值 → null", targetOf(null) === null);
ok("落点：私信缺 conv_id 时退到原帖",
  eq(targetOf({ kind: "dm", post_id: 5 }), { type: "post", postId: 5 }));

/* ───────── 偏好兜底 ───────── */
ok("偏好：缺行 = 全开", eq(normPrefs(null), { comments: true, reactions: true, pets: true, dms: true }));
ok("偏好：显式 false 才关", eq(normPrefs({ comments: false, reactions: true, pets: true, dms: false }),
  { comments: false, reactions: true, pets: true, dms: false }));
/* 只有严格 false 才算关（0 / "false" / null 都视为开）——与 SQL 的 boolean 语义一致 */
ok("偏好：非布尔假值仍视为开", eq(normPrefs({ comments: 0, reactions: "false", pets: null, dms: undefined }),
  { comments: true, reactions: true, pets: true, dms: true }));
ok("偏好：非对象不炸", eq(normPrefs("x"), { comments: true, reactions: true, pets: true, dms: true }));

/* ──────── i18n：通知文案键 en/zh 对称 + 插值占位符在位 ───────── */
function flat(obj, prefix = "") {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) Object.assign(out, flat(v, key));
    else out[key] = v;
  }
  return out;
}
const EN = flat(messages.en);
const ZH = flat(messages.zh);
const NEED = [
  "notif.title", "notif.intro", "notif.needSignIn", "notif.loadFail", "notif.tabAll",
  "notif.tabComments", "notif.tabReactions", "notif.tabPets", "notif.tabDms", "notif.tabSystem",
  "notif.unreadOnly", "notif.unreadOnlyOn", "notif.markAll", "notif.clear", "notif.empty",
  "notif.more", "notif.noMore", "notif.unread", "notif.prefs", "notif.prefsHint",
  "notif.prefComments", "notif.prefReactions", "notif.prefPets", "notif.prefDms",
  "notif.prefsSaved", "notif.someone", "notif.comment", "notif.reply", "notif.reaction",
  "notif.pet", "notif.dm", "notif.system", "notif.fallback",
];
for (const k of NEED) {
  ok(`通知文案键 en:${k}`, typeof EN[k] === "string" && EN[k].length > 0);
  ok(`通知文案键 zh:${k}`, typeof ZH[k] === "string" && ZH[k].length > 0);
}
/* itemView 返回的每个键都必须在两份语言里存在（加了新类型忘了写文案就会红） */
for (const k of [...KINDS, "wat"]) {
  const key = itemView({ id: 1, kind: k, meta: {} }).key;
  ok(`itemView(${k}) 的键存在 en`, typeof EN[key] === "string", key);
  ok(`itemView(${k}) 的键存在 zh`, typeof ZH[key] === "string", key);
}
/* 插值占位符 {who} 必须在两份语言里都出现（否则文案会变成半截话） */
for (const k of ["notif.comment", "notif.reply", "notif.reaction", "notif.pet", "notif.dm", "notif.fallback"]) {
  ok(`${k} 含 {who}（en）`, EN[k].includes("{who}"), EN[k]);
  ok(`${k} 含 {who}（zh）`, ZH[k].includes("{who}"), ZH[k]);
}
ok("反应名三种都齐（en）", ["hug", "warm", "relate"].every((r) => typeof EN[`notif.react.${r}`] === "string"));
ok("反应名三种都齐（zh）", ["hug", "warm", "relate"].every((r) => typeof ZH[`notif.react.${r}`] === "string"));
ok("宠物动作两种都齐（en）", ["pat", "feed"].every((p) => typeof EN[`notif.petKind.${p}`] === "string"));
ok("宠物动作两种都齐（zh）", ["pat", "feed"].every((p) => typeof ZH[`notif.petKind.${p}`] === "string"));

console.log(`notify-test: ${pass} pass, ${fails.length} fail`);
for (const f of fails) console.log("FAIL  " + f);
if (fails.length) process.exit(1);