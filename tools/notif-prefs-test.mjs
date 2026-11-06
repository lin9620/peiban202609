/* 通知偏好（设置页三类开关）口径测试
 * ------------------------------------------------------------
 * 用户报障：「设置里把评论/回应/宠物通知关掉，实际上也没有效果」。
 * 实测拆成两半，结论是**一半好一半坏**：
 *   生成侧 OK —— 关掉后不再往 notifications 落新行（触发器一直读 prefs）；
 *   清理侧坏 —— 关掉的那一刻，已经堆着的未读一条不动，角标/列表/铃铛全照旧。
 * 修法 = MIGRATION_notif_prefs_clear.sql：某类由「开」变「关」时把该类未读标记已读，
 *        再让设置页保存后立刻 refreshBadge（不然要等 30s 轮询）。
 * 本测试把口径钉在 SQL / 前端两处，并守住三条反面条件：
 *   · 只在「真的从开变关」时清（反复保存关状态不能抹掉之后新来的未读）；
 *   · 只清未读（read_at is null），历史行不删；
 *   · 三类 kind 的边界不能串（评论含 reply，回应只算 reaction，宠物只算 pet）。
 * 运行：node tools/notif-prefs-test.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

let pass = 0;
const fails = [];
const ok = (n, c, extra = "") => {
  if (c) pass++;
  else fails.push(n + (extra ? ` —— ${extra}` : ""));
};

const mig = read("MIGRATION_notif_prefs_clear.sql");

/* ───────── SQL 结构 ───────── */
ok("迁移重定义了 notif_prefs_set",
  /create or replace function public\.notif_prefs_set\(/.test(mig));
ok("迁移不再只是写偏好（要带清理）",
  /update public\.notifications set read_at = now\(\)/.test(mig));

const clears = (mig.match(/update public\.notifications set read_at = now\(\)/g) || []).length;
ok("函数内三类各清一次（3 处）", clears === 3, `实际 ${clears} 处`);
ok("另有一次历史校准（带表别名，单独一句）",
  /update public\.notifications n\s+set read_at = now\(\)/.test(mig));

/* 每条清理都必须挂在「由开→关」的判断里，不能无条件执行 */
for (const [label, flag] of [["评论", "comments"], ["回应", "reactions"], ["宠物", "pets"]]) {
  const re = new RegExp(
    `if coalesce\\(v_old_${flag}, true\\) and not coalesce\\(p_${flag}, true\\) then\\s*` +
    `update public\\.notifications set read_at = now\\(\\)\\s*` +
    `where user_id = me and read_at is null and kind`,
  );
  ok(`${label}：只在「开→关」时清理`, re.test(mig));
}

/* kind 边界 */
ok("评论类含 reply（回帖也要一起清）",
  /kind in \('comment', 'reply'\)/.test(mig));
ok("回应类只算 reaction（不误伤 pet）",
  /kind = 'reaction'/.test(mig));
ok("宠物类只算 pet", /kind = 'pet'/.test(mig));

/* 只清未读，不删行 */
ok("清理只针对未读（read_at is null）",
  !/delete from public\.notifications/i.test(mig));
ok("迁移头部说明了「历史行保留为已读」",
  /历史行保留为已读|历史记录仍留在通知列表/.test(mig));

/* 历史遗留校准：关掉偏好但还挂着的旧未读要被收拾 */
ok("带一次性历史校准（exists 关掉偏好 + 未读）",
  /update public\.notifications n[\s\S]{0,400}exists \([\s\S]{0,300}p\.comments = false/.test(mig));

/* ───────── SETUP 同步 ───────── */
const setup = read("SUPABASE_SETUP.sql");
ok("SUPABASE_SETUP 的 notif_prefs_set 也带清理",
  /create or replace function public\.notif_prefs_set\([\s\S]{0,2600}update public\.notifications set read_at = now\(\)/.test(setup));
ok("SETUP 里同样只有「开→关」才清",
  /if coalesce\(v_old_comments, true\) and not coalesce\(p_comments, true\) then/.test(setup));

/* ───────── 生成侧护栏：三个触发器仍然读 prefs ───────── */
ok("评论触发器仍读 prefs.comments",
  /notify_on_comment[\s\S]{0,1200}coalesce\(p\.comments, true\)/.test(setup));
ok("回应触发器仍读 prefs.reactions",
  /notify_on_reaction[\s\S]{0,1200}coalesce\(p\.reactions, true\)/.test(setup));
ok("宠物触发器仍读 prefs.pets",
  /notify_on_pet[\s\S]{0,1200}coalesce\(p\.pets, true\)/.test(setup));

/* ───────── 前端：保存后角标立刻重拉 ───────── */
const settings = read("src/views/SettingsView.vue");
ok("设置页引入 refreshBadge", /import \{ refreshBadge \} from "\.\.\/stores\/badgeStore\.js"/.test(settings));
ok("保存偏好成功后调 refreshBadge",
  /await notifyApi\.prefsSet\(clean\);[\s\S]{0,400}refreshBadge\(\);/.test(settings));
ok("refreshBadge 是在 try 内（失败不误刷）",
  /try \{[\s\S]{0,120}await notifyApi\.prefsSet\(clean\)[\s\S]{0,500}refreshBadge\(\);[\s\S]{0,400}\} catch/.test(settings));

/* 通知中心页不该自己算一套偏好过滤（服务端已保证口径） */
const notifyRules = read("src/utils/notifyRules.js");
ok("前端配置栏仍与 SQL 的 kind 白名单一致",
  /case "comments":\s*return "comment,reply"/.test(notifyRules));
ok("回应栏口径未被动过（reaction,pet）",
  /case "reactions":\s*return "reaction,pet"/.test(notifyRules));

console.log(`\n${pass} / ${pass + fails.length} 通过`);
if (fails.length) {
  console.log("\n失败项：");
  for (const f of fails) console.log("  ✗ " + f);
  process.exitCode = 1;
} else {
  console.log("全部通过");
}
