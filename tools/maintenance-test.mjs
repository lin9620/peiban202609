/* ═══ 维护/升级模式回归测试（轮 444）═══
 *
 * 这个功能的失败模式不在「功能不生效」，而在「生效得太用力」：
 *  · 管理员自己被锁在外面，连后台都进不去关掉 → 站点永久维护；
 *  · 到期不自动恢复 → 忘了关就一直挂着；
 *  · 写入口漏了一处 → 维护期还是能写进去，等于没维护；
 *  · 私信被一起拦掉 → 用户正聊到一半被掐断，是感受最差的一种。
 * 所以下面每一条都对着一个具体的翻车场景，不是为了凑数。
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
  maint, applyState, activeMode, isBlocked, isReadOnly, isFullStop,
  selfExempt, guardWrite, isMaintenanceError, setPreview,
} = await import("../src/utils/maintenance.js");

/* 每个用例前复位，避免串味 */
const reset = () => {
  applyState({ maintenance_mode: "off", maintenance_note: null, maintenance_until: null, maintenance_started_at: null });
  maint.admin = false;
  maint.preview = false;
};

/* ── ① 正常态 ── */
reset();
ok("M1 默认 off 且不拦", activeMode() === "off" && isBlocked() === false && guardWrite() === true);

/* ── ② 只读档：拦写、放读 ── */
applyState({ maintenance_mode: "read", maintenance_until: null });
ok("M2 read 档 → 栏写", isBlocked() === true && isReadOnly() === true && isFullStop() === false);
ok("M3 read 档 guardWrite 返回 false", guardWrite() === false);
const hintBefore = maint.hint;
guardWrite();
ok("M4 每次被拦 hint 递增（横幅据此抖动）", maint.hint === hintBefore + 1);

/* ── ③ 管理员豁免：这是最危险的翻车点 ── */
maint.admin = true;
ok("M5 管理员在 read 档不受限", isBlocked() === false && guardWrite() === true);
applyState({ maintenance_mode: "full", maintenance_until: null });
ok("M6 管理员在 full 档也不受限（否则关不掉维护）", isBlocked() === false && isFullStop() === false);
setPreview(true);
ok("M7 管理员开「用户视角」后自己也被拦", isBlocked() === true && isFullStop() === true);
setPreview(false);
maint.admin = false;

/* ── ④ 到期自动恢复：忘了关也不能永久停机 ── */
applyState({ maintenance_mode: "full", maintenance_until: new Date(Date.now() - 1000).toISOString() });
ok("M8 until 已过 → 视为 off", activeMode() === "off" && isBlocked() === false && isFullStop() === false);
applyState({ maintenance_mode: "read", maintenance_until: new Date(Date.now() + 60000).toISOString() });
ok("M9 until 未到 → 保持 read", activeMode() === "read" && isBlocked() === true);
applyState({ maintenance_mode: "read", maintenance_until: "不是时间" });
ok("M10 until 脏值 → 不误判成已到期（宁可继续维护）", activeMode() === "read");

/* ── ⑤ 脏服务端值不能把整站锁死 ── */
applyState({ maintenance_mode: "bogus" });
ok("M11 未知档位 → 当作 off", activeMode() === "off" && isBlocked() === false);
applyState(null);
ok("M12 空行不炸", activeMode() === "off");

/* ── ⑥ 服务端兜底错误的识别 ── */
ok("M13 认 message 'maintenance-mode'", isMaintenanceError(new Error("maintenance-mode")));
ok("M14 认 errcode PT503", isMaintenanceError({ message: "error", code: "PT503" }));
ok("M15 普通错误不误认", isMaintenanceError(new Error("Failed to fetch")) === false);

/* ── ⑦ 写入口必须都接了守卫（漏一处 = 维护期还能写进去）── */
const wallSrc = read("src/utils/wall.js");
const bottleSrc = read("src/utils/bottle.js");
const storySrc = read("src/utils/story.js");
ok("M16 发帖接守卫", /cloudInsertPost[\s\S]{0,400}guardWrite\(\)/.test(wallSrc));
ok("M17 评论接守卫", /cloudInsertComment[\s\S]{0,400}guardWrite\(\)/.test(wallSrc));
ok("M18 投瓶接守卫", /function bottleSend[\s\S]{0,300}guardWrite\(\)/.test(bottleSrc));
ok("M19 捞信接守卫（会写 bottle_fishes）", /function bottleFish[\s\S]{0,300}guardWrite\(\)/.test(bottleSrc));
ok("M20 回信接守卫", /function bottleReply[\s\S]{0,300}guardWrite\(\)/.test(bottleSrc));
ok("M21 存草稿接守卫", /function storySaveDraft[\s\S]{0,300}guardWrite\(\)/.test(storySrc));
ok("M22 发布接守卫", /function storyPublish[\s\S]{0,300}guardWrite\(\)/.test(storySrc));
ok("M23 点赞接守卫", /function storySetLike[\s\S]{0,200}guardWrite\(\)/.test(storySrc));
ok("M24 收藏接守卫", /function storySetBookmark[\s\S]{0,200}guardWrite\(\)/.test(storySrc));

/* ── ⑧ 错误文案必须单独归类，不能落进「通用失败」── */
ok("M25 暖心墙 errorKind 认维护态", /maintenance-mode[\s\S]{0,80}return "maintenance"/.test(read("src/utils/wallRules.js")));
ok("M26 故事 storyErrKey 认维护态", /maintenance-mode[\s\S]{0,80}return "story\.errMaintenance"/.test(read("src/utils/storyRules.js")));
ok("M27 漂流瓶 bottleErrKey 认维护态", /maintenance-mode[\s\S]{0,80}return "bottle\.errMaintenance"/.test(read("src/utils/bottle.js")));

/* ── ⑨ SQL：拦哪些表、不拦哪些 ── */
const sql = read("MIGRATION_maintenance.sql");
const listBlock = sql.slice(sql.indexOf("foreach t in array array["), sql.indexOf("] loop"));
const guarded = [...listBlock.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
ok("M28 内容表都在拦截清单里", ["wall_posts", "stories", "bottle_letters", "wall_comments"].every((t) => guarded.includes(t)), guarded.join(","));
ok("M29 私信**不在**清单里（聊到一半被掐断最恼人）", !guarded.includes("dm_messages"));
ok("M30 只拦 INSERT（拦 UPDATE 会让浏览计数失败刷屏）", /before insert on public\.%I/.test(sql) && !/before update/i.test(sql));
ok("M31 管理员豁免写在 SQL 里", /not coalesce\(public\.is_admin\(\), false\)/.test(sql));
ok("M32 到期自动恢复写在 maintenance_active 里", /maintenance_until <= now\(\)/.test(sql));
ok("M33 关维护时清 until（否则下次一开就「已到期」）", /when p_mode = 'off' then null else p_until/.test(sql));

/* ── ⑩ 五语文案齐备 ── */
const { messages } = await import("../src/i18n.js");
const pick = (o, k) => k.split(".").reduce((a, p) => (a == null ? a : a[p]), o);
const NEED = ["maint.bannerRead", "maint.readBody", "maint.bannerFull", "maint.fullTitle",
  "maint.fullBody", "maint.retry", "maint.leftMin", "maint.almostDone", "maint.collapse"];
for (const l of ["en", "zh", "es", "pt", "fr"]) {
  const miss = NEED.filter((k) => !pick(messages[l], k));
  ok(`M34 ${l} 维护文案齐备`, miss.length === 0, miss.join(","));
  ok(`M35 ${l} 维护期发布失败文案`, !!pick(messages[l], "community.maintenance"));
}
/* 插值占位符：多一个会渲染成字面量 {m}，少一个只是缺数字 */
ok("M36 leftMin 的 {m} 在五语一致",
  ["en", "zh", "es", "pt", "fr"].every((l) => String(pick(messages[l], "maint.leftMin")).includes("{m}")));

/* ── ⑪ 横幅组件不阻断交互 ── */
const bar = read("src/components/MaintenanceBar.vue");
ok("M37 只读档不渲染全屏遮罩（遮罩只在 full 档）", /<div v-if="stopAll" class="maint-stop"/.test(bar));
ok("M38 横幅可收起（收起后是小圆点，不占布局）", /maint-dot/.test(bar) && /collapse\(true\)/.test(bar));
ok("M39 收起状态被记住（维护可能很久，不必每次手动关）", /wp-maint-collapsed-v1/.test(bar));
ok("M40 挂进全局布局（不是某个页面自己弹）", /<MaintenanceBar \/>/.test(read("src/App.vue")));

if (fails.length) {
  console.log(`\nFAIL ${fails.length} 条：`);
  for (const f of fails) console.log("  ✗", f);
}
console.log(`\nmaintenance-test: ${pass} pass, ${fails.length} fail`);
process.exit(fails.length ? 1 : 0);
