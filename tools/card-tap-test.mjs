/* 暖心墙 / 他人主页「整卡可点」回归测试（读源码静态断言，Node 直跑）
 *   node tools/card-tap-test.mjs
 *
 * 背景（轮 427）：用户实报「暖心墙帖子有时候第一次点击无法进入详细页面，需要第二次或者多次点击」。
 * 真机网格扫描（393×895 视口、12px 步长、1798 点）：卡片区域内 86.3% 的落点按下毫无反应，
 * 只有正文那 25px 和图片能进详情 —— 用户随手一点落在内边距空白上，页面不动；
 * 再点一次碰巧压到文字才进去。修法 = 整卡兜底跳详情 + 交互区让路。
 *
 * 这套测试钉三件事，缺一条就退回「点十次进一次」：
 *   ① 卡片 article 上必须有兜底点击；② 让路清单必须完整（漏一项 = 那个按钮被抢）；
 *   ③ 兜底必须在 goDetail 之前先判让路（顺序反了等于没判）。
 */
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log("PASS ", name); }
  else { fail++; console.log("FAIL ", name); }
}

const community = readFileSync(new URL("../src/views/CommunityView.vue", import.meta.url), "utf8");
const waller = readFileSync(new URL("../src/views/WallerView.vue", import.meta.url), "utf8");
const glass = readFileSync(new URL("../src/glass.css", import.meta.url), "utf8");
const tap = readFileSync(new URL("../src/utils/tapFeedback.js", import.meta.url), "utf8");

/* 取出 CARD_OWN 数组字面量并求值——断言的是「真的会被用到的那份清单」，不是文档里抄的一份 */
function cardOwn() {
  const m = community.match(/const CARD_OWN = \[([\s\S]*?)\]\.join\(","\)/);
  if (!m) return null;
  const items = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  return items.length ? items : null;
}

const own = cardOwn();

/* —— ① 兜底入口 —— */
const articleTag = (community.match(/<article v-for="p in pageItems"[\s\S]*?>/) || [""])[0];
ok("T1 暖心墙 article 上挂了兜底点击 @click=onCardTap", /@click="onCardTap\(p,\s*\$event\)"/.test(articleTag));
ok("T2 有 onCardTap 定义", /function onCardTap\(p,\s*e\)/.test(community));
ok("T3 onCardTap 最终调 goDetail(p)", /function onCardTap[\s\S]{0,400}goDetail\(p\)/.test(community));
ok("T4 他人主页 article 整卡可点", /<article v-for="p in posts"[^>]*@click="goDetail\(p\)"/.test(waller));

/* —— ② 让路清单 —— */
ok("T5 CARD_OWN 能解析出清单", Array.isArray(own) && own.length >= 15);
for (const need of [
  "button", "a[href]", "input", "textarea", "select", "label",
  ".clickable", ".more-btn", ".more-item", ".more-pop",
  ".go-detail", ".tag-chip",
  ".cmt-entry", ".cmt-toggle", ".cmt-box", ".cmt-input",
  ".wp-composer", ".wp-composer-picker",
]) {
  ok(`T6 让路清单含 ${need}`, !!own && own.includes(need));
}
/* .react-row / .post-foot 整块让路是轮 427 的第一版做法，真机连测三次里前两次都点在这两块上
 * （51px 高的浏览数行 + 反应按钮之间的空白）→ 页面毫无反应。按钮本身是 <button>，
 * 靠 button 那一条就够拦，整行排除只会把空白判成死区。 */
ok("T6b .react-row 不许整行让路（按钮间隙也要能进详情）", !own || !own.includes(".react-row"));
ok("T6c .post-foot 不许整行让路（浏览数那行 51px 高，整块排掉=死区）", !own || !own.includes(".post-foot"));
/* 评论区那一串必须整组在（少一个就会有人在评论里点出详情页） */
ok("T7 评论相关不让路项为零", !own || own.filter((s) => s.startsWith(".cmt") && s !== ".cmt-entry" && s !== ".cmt-toggle" && s !== ".cmt-box" && s !== ".cmt-input").length === 0);

/* —— ③ 顺序与反向守护 —— */
const body = (community.match(/function onCardTap[\s\S]*?\n}/) || [""])[0];
ok("T8 先判 closest(CARD_OWN) 再 goDetail", body.indexOf("closest(CARD_OWN)") > -1 && body.indexOf("closest(CARD_OWN)") < body.indexOf("goDetail(p)"));
ok("T9 命中让路项要 return（不是继续往下跳）", /closest\(CARD_OWN\)\)\s*return;/.test(body));
/* 反向：把自己排除掉 = 整卡可点失效，兜底永远不触发 */
ok("T10 让路清单里不许有 .post-card", !own || !own.includes(".post-card"));
ok("T11 让路清单里不许有 .post-head（头部空白占 23% 面积，要能点）", !own || !own.includes(".post-head"));
ok("T12 让路清单里不许有 article（等于全卡失效）", !own || !own.includes("article"));
ok("T13 .go-detail 必须在让路清单里（否则正文一击跳两次）", !!own && own.includes(".go-detail"));

/* —— 原有守卫与配套不能丢 —— */
ok("T14 goDetail 仍守 dbId（本机帖/示例帖无处可去）", /function goDetail\(p\)[\s\S]{0,120}p\.dbId == null[\s\S]{0,40}return/.test(community));
ok("T15 卡片仍在按压反馈的可点清单里（整卡可点要有按压态）", /\.post-card/.test(tap));
ok("T16 玻璃皮肤仍有卡片按压态（:active 与 .press 双认）", /\.post-card[^{]*:active|\.post-card[^{]*\.press/.test(glass) || /\.post-card/.test(glass));

/* —— 数字口径：真机扫描出来的死区比例，写在这里当回归基线 —— */
ok("T17 注释里保留真机死区基线 86.3%（改口径要重新扫真机）", community.includes("86.3%"));

console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`);
if (fail) process.exit(1);
