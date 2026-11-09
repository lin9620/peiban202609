/* ═══ 会话列表「全部已读」护栏（轮490）═══
 *
 * 用户要求：「消息页在会话那个文字那一行的最右边做个全部已读」。
 *
 * 这颗按钮容易做错的四个地方，每一处都写成断言：
 *   ① 位置 —— 必须挂在「会话」那一行的 dm-sec 里（不是消息请求那一行、不是另起一行）；
 *   ② 触发条件 —— 有未读才出现，没未读就消失（点了没反应的按钮比没有更糟）；
 *   ③ 范围 —— 只清「会话」段（normal），不许顺手清消息请求（那走 badge.requests，
 *      还没接受时不算会话，清了会让请求莫名其妙消失）；
 *   ④ 失败处置 —— 逐条并发抬水位，失败的把红点**按行还原**，不许整表 reload 糊过去，
 *      也不许留在「假的干净列表」上等下一轮轮询。
 *
 * 服务端只有单会话 dm_mark_read，没有全读 RPC；本轮不加迁移，只在前端编排。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { convUnread, unreadToClear } from "../src/utils/dmRules.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

let pass = 0;
const fails = [];
const ok = (name, cond, extra = "") => {
  if (cond) { pass += 1; console.log("PASS  " + name); return; }
  fails.push(`${name}${extra ? ` — ${extra}` : ""}`);
  console.log("FAIL  " + name + (extra ? `\n      → ${extra}` : ""));
};

const view = read("src/views/MessagesView.vue");
const css = read("src/style.css");

/* 会话段那一段模板（从 conversations 所在的 dm-sec 开头，到 v-for 行开始） */
const secAt = view.indexOf('t("dm.conversations")');
const secBox = secAt > 0 ? view.lastIndexOf('<div class="dm-sec">', secAt) : -1;
const secSeg = secBox >= 0 ? view.slice(secBox, secAt + 900) : "";
/* markAllRead 函数体 */
const fnAt = view.indexOf("async function markAllRead");
const fn = fnAt > 0 ? view.slice(fnAt, fnAt + 2600) : "";

/* ═════════ ① 位置与触发 ═════════ */
ok("M1 按钮在「会话」那一行的 dm-sec 里（跟 sec-label 同一行）",
  secAt > 0 && /<div class="dm-sec">[\s\S]{0,120}sec-label[\s\S]{0,600}class="dm-sec-act"/.test(secSeg),
  "会话标题行里找不到 .dm-sec-act");

ok("M2 不允许挂到「消息请求」那一行（那里只有计数）",
  !/t\("dm\.requests"\)[\s\S]{0,200}dm-sec-act/.test(view),
  "dm-sec-act 出现在消息请求那一行");

ok("M3 有未读才出现（没未读时隐藏，不留一颗点了没反应的按钮）",
  /v-if="pendingUnread\.length \|\| allReadNote"/.test(secSeg),
  "缺少 v-if 门控");

ok("M4 点击走 markAllRead，且 @click.stop（行本身是整行可点进会话）",
  /@click\.stop="markAllRead"/.test(secSeg),
  "缺 @click.stop 或没接 markAllRead");

ok("M5 处理中 disabled（防连点把同一批水位抬两遍）",
  /:disabled="allReadBusy \|\| !pendingUnread\.length"/.test(secSeg),
  "缺 disabled 守卫");

/* ═════════ ② 范围：只清会话段 ═════════ */
ok("M6 pendingUnread 从 convs 起算（不从 normal —— 那是搜索过滤后的视图，会只清搜出来的几条）",
  /const pendingUnread = computed\(\(\) => convs\.value\.filter/.test(view)
    && /accepted !== false && !c\.blocked && !isBlocked\(c\.other_id\)/.test(
      view.slice(view.indexOf("const pendingUnread"), view.indexOf("const pendingUnread") + 400)),
  "pendingUnread 挂在了被搜索词过滤的 normal 上");

ok("M7 静音会话也算未读（convUnread 对静音返回 0，必须连原始 unread 取大，否则灰点清不掉）",
  /Math\.max\(convUnread\(c, badge\.dmConvs\), Number\(c\.unread\) \|\| 0\) > 0/.test(view),
  "静音会话的灰点会被漏掉");

ok("M8 不许出现「服务端全读 RPC」这种不存在的调用",
  !/dmMarkAllRead|dm_mark_all_read|markAllRead\(\s*\)\s*\{[\s\S]{0,200}db\./.test(view),
  "调了不存在的全读接口");

/* ═════════ ③ 网络编排 ═════════ */
ok("M9 逐会话并发抬水位（Promise.all + dmApi.markRead），不是串行 for-await",
  /Promise\.all\(\s*rows\.map\(\(c\) => dmApi\.markRead\(c\.conv_id\)/.test(fn),
  "不是并发调用，或调错了接口");

ok("M10 防重入：进来的第一件事就是看 allReadBusy",
  /if \(allReadBusy\.value\) return;/.test(fn.slice(0, 200)),
  "缺重入守卫");

ok("M11 乐观清零：行 unread 归零 + 行级角标映射清掉 + 导航角标递减",
  /s\.row\.unread = 0/.test(fn) && /badgeDmConvPatch\(s\.id, 0\)/.test(fn)
    && /badgeLocal\(\{ dm: Math\.max\(0, badge\.dm - lost\) \}\)/.test(fn),
  "乐观清零三件事没做全");

ok("M12 失败按行还原：results[i] 为 false 的那条把快照 unread 放回去",
  /if \(results\[i\]\) continue;[\s\S]{0,160}s\.row\.unread = s\.unread/.test(fn),
  "失败没有行级还原（会留在假的干净列表上）");

ok("M13 结束后拉一次服务端权威值校正",
  /refreshBadge\(\)/.test(fn),
  "没有 refreshBadge 校正");

ok("M14 失败时明说（有自己的提示态，不只靠红点回来）",
  /allReadNote\.value = bad \? "fail" : "ok"/.test(fn),
  "失败没有可见反馈");

/* ═════════ ④ 样式：最右边 ═════════ */
const cssSeg = (css.match(/\.dm-sec-act \{[^}]*\}/) || [""])[0];
ok("M15 样式把按钮推到行尾（margin-left:auto），且不吃系统点击高亮",
  /margin-left:\s*auto/.test(cssSeg) && /touch-action:\s*manipulation/.test(cssSeg),
  "样式缺 margin-left:auto 或 touch-action");

ok("M16 移动端点击热区够（padding 横向 ≥ 8px，字号 ≥ 11px）",
  /padding:\s*\d+px\s+(\d+)px/.test(cssSeg)
    && Number((cssSeg.match(/padding:\s*\d+px\s+(\d+)px/) || [])[1]) >= 8
    && Number((cssSeg.match(/font-size:\s*([\d.]+)px/) || [])[1]) >= 11,
  "热区或字号偏小");

/* ═════════ ⑤ 五语种 ═════════ */
for (const [file, tag] of [["src/i18n.js", "en+zh"], ["src/i18n.es.js", "es"],
  ["src/i18n.pt.js", "pt"], ["src/i18n.fr.js", "fr"]]) {
  const src = read(file);
  const keys = ["markAll", "markAllBusy", "markAllDone", "markAllFail"];
  const miss = keys.filter((k) => !new RegExp(`"?'?${k}"?'?\\s*:`).test(src));
  /* i18n.js 里 en 与 zh 两块，每个 key 都要出现两次 */
  const need = file === "src/i18n.js" ? 2 : 1;
  const short = keys.filter((k) => (src.match(new RegExp(`\\b${k}"?\\s*:`, "g")) || []).length < need);
  ok(`M17 ${tag}：四个文案 key 齐全`, miss.length === 0 && short.length === 0,
    `缺 ${miss.concat(short.filter((x) => !miss.includes(x))).join(", ")}`);
}

/* ═════════ ⑥ 纯函数口径：静音会话不进导航角标，但行红点要清 ═════════ */
ok("M18 静音会话：unreadToClear 不计入导航角标（免得减掉别人的数）",
  unreadToClear({ conv_id: 7, muted: true, unread: 5 }, {}) === 0);

ok("M19 静音会话：convUnread 明确返回 0（这就是「必须连原始 unread 取大」的原因）",
  convUnread({ conv_id: 7, muted: true, unread: 5 }, {}) === 0
    && convUnread({ conv_id: 7, unread: 5 }, {}) === 5);

ok("M20 非静音会话：unreadToClear 取 max(行值, 映射值)，不会只清一边",
  unreadToClear({ conv_id: 7, unread: 2 }, { 7: 6 }) === 6
    && unreadToClear({ conv_id: 7, unread: 8 }, { 7: 3 }) === 8);

console.log(`\nmark-all-read-test: ${pass} pass, ${fails.length} failed`);
if (fails.length) {
  console.log("失败清单：\n  - " + fails.join("\n  - "));
  process.exit(1);
}
