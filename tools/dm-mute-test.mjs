/* 免打扰（dm_states.muted）静音口径测试
 * ------------------------------------------------------------
 * 用户报障原话：「设置成免打扰了，为什么还有提示」。
 * 排查后确认：muted 以前只写不读 —— dm_unread_total / dm_list_convs 都不看它，
 * 唯一读它的 dm_send 通知分支又被 notifications_drop_dm 触发器整条丢弃，
 * 于是「免打扰」唯一可见变化是多一个静音小图标，红点/角标一个不少。
 *
 * 现在的口径（MIGRATION_dm_mute_silence.sql + dmRules.convUnread/unreadToClear）：
 *   免打扰 = 不进导航角标、不报数字；消息还在，会话行只留无数字灰点。
 * 本测试把这条口径钉在三处：
 *   ① 纯函数（前端渲染与角标递减）
 *   ② SQL（服务端 total / requests 必须排除静音会话，且 SETUP 同步）
 *   ③ 视图与样式、五语文案（灰点真的画得出来、说明真的说清楚）
 * 运行：node tools/dm-mute-test.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { convUnread, unreadToClear } from "../src/utils/dmRules.js";
import { messages } from "../src/i18n.js";
import es from "../src/i18n.es.js";
import pt from "../src/i18n.pt.js";
import fr from "../src/i18n.fr.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

let pass = 0;
const fails = [];
function ok(name, cond, extra = "") {
  if (cond) pass++;
  else fails.push(name + (extra ? ` —— ${extra}` : ""));
}

/* ───────── ① 纯函数：会话行红数字 ───────── */
const row = (o = {}) => ({ conv_id: 7, unread: 0, muted: false, ...o });

ok("普通会话：显示未读数", convUnread(row({ unread: 3 }), {}) === 3);
ok("普通会话：行值与映射取较大者", convUnread(row({ unread: 2 }), { 7: 5 }) === 5);
ok("普通会话：映射更小不会把数字降下去", convUnread(row({ unread: 4 }), { 7: 1 }) === 4);
ok("普通会话：conv_id 为字符串也能对上映射", convUnread(row({ conv_id: "7", unread: 1 }), { 7: 6 }) === 6);

ok("免打扰：行值再大也不报数字", convUnread(row({ unread: 9, muted: true }), {}) === 0);
ok("免打扰：映射里有残留也不报数字", convUnread(row({ unread: 9, muted: true }), { 7: 4 }) === 0);
ok("免打扰：未读为 0 时同样是 0", convUnread(row({ unread: 0, muted: true }), {}) === 0);

ok("空行不炸（0）", convUnread(null, {}) === 0);
ok("row 缺失、映射有值也不猜（0）", convUnread(undefined, { 7: 3 }) === 0);
ok("坏值当 0（字符串）", convUnread(row({ unread: "abc" }), {}) === 0);
ok("坏值当 0（NaN）", convUnread(row({ unread: NaN }), {}) === 0);
ok("map 传 null 不炸", convUnread(row({ unread: 2 }), null) === 2);

/* ───────── ① 纯函数：进会话要减掉多少（角标递减） ───────── */
ok("普通会话：减掉行值", unreadToClear(row({ unread: 3 }), {}) === 3);
ok("普通会话：行值与映射取较大者", unreadToClear(row({ unread: 2 }), { 7: 5 }) === 5);
ok("免打扰：行值不算（本来就没进角标）", unreadToClear(row({ unread: 9, muted: true }), {}) === 0);
ok("免打扰：只减映射里的历史残留", unreadToClear(row({ unread: 9, muted: true }), { 7: 2 }) === 2);
ok("免打扰：减掉的永远不超过映射", unreadToClear(row({ unread: 99, muted: true }), { 7: 1 }) === 1);
ok("空行不减（0）", unreadToClear(null, { 7: 3 }) === 0);
ok("坏值不减（0）", unreadToClear(row({ unread: "x" }), {}) === 0);

/* 两条规则必须互补：免打扰行的「显示数字」与「角标递减」同时归零，
 * 否则会出现「红点没了，但点进去角标反而掉一截」的鬼故事。 */
const mutedRow = row({ unread: 4, muted: true });
ok("口径自洽：静音行显示 0 且不扣角标",
  convUnread(mutedRow, {}) === 0 && unreadToClear(mutedRow, {}) === 0);

/* ───────── ② SQL：服务端必须排除静音会话 ───────── */
const mig = read("MIGRATION_dm_mute_silence.sql");
ok("迁移文件建了 dm_unread_total", /create or replace function public\.dm_unread_total\s*\(\s*\)/.test(mig));
const mutedFilters = (mig.match(/not coalesce\(s\.muted,\s*false\)/g) || []).length;
ok("迁移里两处排查静音会话（未读 + 请求）", mutedFilters === 2, `实际 ${mutedFilters} 处`);
ok("迁移：未读分支排除静音", /m\.id > coalesce\(s\.last_read_id, 0\)[\s\S]{0,220}not coalesce\(s\.muted,\s*false\)/.test(mig));
ok("迁移：请求分支排除静音", /coalesce\(s\.accepted, true\) = false[\s\S]{0,160}not coalesce\(s\.muted,\s*false\)/.test(mig));
ok("迁移：仍保留拉黑/隐藏过滤（没顺手删）",
  /coalesce\(s\.hidden_until/.test(mig) && /dm_is_blocked/.test(mig));
ok("迁移：仍返回 convs 行级明细", /'convs', v_rows/.test(mig));

const setup = read("SUPABASE_SETUP.sql");
const setupFilters = (setup.match(/not coalesce\(s\.muted,\s*false\)/g) || []).length;
ok("SUPABASE_SETUP 同步了静音过滤（两处）", setupFilters === 2, `实际 ${setupFilters} 处`);

/* 免打扰不能变成「隐藏」：dm_list_convs 的 unread 仍是事实值，灰点靠它 */
ok("dm_list_convs 的 unread 没被改动（灰点要用事实值）",
  /'unread', \(select count\(\*\) from public\.dm_messages m/.test(setup));

/* ───────── ③ 视图：灰点 + 递减口径 + 立刻刷角标 ───────── */
const view = read("src/views/MessagesView.vue");
ok("视图：rowUnread 走 convUnread（口径唯一）",
  /function rowUnread\(c\)\s*\{[\s\S]{0,320}return convUnread\(c, badge\.dmConvs\);/.test(view));
ok("视图：模板画了无数字灰点", /class="dm-quiet-dot"/.test(view));
ok("视图：灰点只在免打扰且有未读时出现",
  /v-else-if="c\.muted && Number\(c\.unread\) > 0"\s+class="dm-quiet-dot"/.test(view));
ok("视图：灰点带说明文案（桌面 hover）", /dm-quiet-dot"\s+:title="t\('dm\.mutedPending'/.test(view));
ok("视图：openConv 用 unreadToClear 递减", /const lost = unreadToClear\(row, badge\.dmConvs\)/.test(view));
ok("视图：markConversationRead 用 unreadToClear 递减", /const clost = unreadToClear\(crow, badge\.dmConvs\)/.test(view));
ok("视图：静音后立刻刷角标（不必等 30s 轮询）",
  /try \{ await dmApi\.mute\(c\.conv_id, on\); refreshBadge\(\); \}/.test(view));
ok("视图：静音失败回滚时也刷回权威值",
  /if \(on && pending\) refreshBadge\(\);/.test(view));
ok("视图：资料卡里的免打扰同样刷新角标",
  /try \{ await dmApi\.mute\(id, on\); refreshBadge\(\); \}/.test(view));

const css = read("src/style.css");
ok("样式：.dm-quiet-dot 有定义", /\.dm-quiet-dot \{/.test(css));
ok("样式：灰点比红角标小（不抢眼）", /\.dm-quiet-dot \{[^}]*width: 8px/.test(css));

/* ───────── ③ 设置页：不再用文字解释「私信不在这里」─────────
 * 轮 476：用户要求把设置页通知下面那两段介绍文字整块删掉（「介绍文字太多了」）。
 * 原来这里钉的是「必须有这段说明」，现在翻成「必须没有」——反向钉住，
 * 免得以后谁觉得「少了个解释」又给加回去。 */
const settings = read("src/views/SettingsView.vue");
ok("设置页已不再引用 notif.dmNotHere（轮 476 用户要求删除）", !/t\("notif\.dmNotHere"\)/.test(settings));
ok("设置页已不再引用 notif.prefsHint（轮 476 用户要求删除）", !/t\("notif\.prefsHint"\)/.test(settings));
ok("样式：.set-hint-soft 随文案一起退役", !/\.set-hint-soft \{/.test(settings));

/* ───────── 五语文案：缺一条就会露 key 名 ───────── */
const flat = (obj, prefix = "") => {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) Object.assign(out, flat(v, key));
    else out[key] = v;
  }
  return out;
};
const langs = { en: flat(messages.en), zh: flat(messages.zh), es: flat(es), pt: flat(pt), fr: flat(fr) };
for (const [name, m] of Object.entries(langs)) {
  ok(`${name}：dm.mutedPending 存在`, typeof m["dm.mutedPending"] === "string", m["dm.mutedPending"]);
  ok(`${name}：dm.mutedPending 带 {n}`,
    typeof m["dm.mutedPending"] === "string" && m["dm.mutedPending"].includes("{n}"));
  ok(`${name}：notif.dmNotHere 已移除（轮 476 删文案，别加回来）`, m["notif.dmNotHere"] === undefined);
  ok(`${name}：notif.prefsHint 已移除（轮 476 删文案，别加回来）`, m["notif.prefsHint"] === undefined);
}

/* ───────── 回归护栏：别把「私信退出通知中心」的结论改回去 ───────── */
const drop = read("MIGRATION_notifications_drop_dm.sql");
ok("私信通知仍被丢弃（说明免打扰无法靠通知生效，只能靠角标）",
  /return null;/.test(drop) && /new\.kind = 'dm'/.test(drop));

console.log(`\n${pass} / ${pass + fails.length} 通过`);
if (fails.length) {
  console.log("\n失败项：");
  for (const f of fails) console.log("  ✗ " + f);
  process.exitCode = 1;
} else {
  console.log("全部通过");
}
