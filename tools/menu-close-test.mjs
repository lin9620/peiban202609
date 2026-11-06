/* ═══ ⋯ 菜单「关闭」· 回归测试（轮453）═══
 *
 * 用户对着会话菜单 / 帖子菜单的截图说「下面加一个关闭功能」：
 * 这些菜单原来只能点菜单外的空白收起，靠屏幕底部弹出时外面可点的区域很窄，
 * 看着像「出不去了」。改动很薄，但正因为薄，以后调菜单顺序/项数时最容易把它挤掉，
 * 所以这里按「每个菜单都要有、且必须是最后一项」钉死：
 *   · 会话行菜单、聊天头菜单（手机/桌面两处）→ .dm-menu-close
 *   · 暖心墙帖子/评论/回复、详情页帖子/评论/回复 → .more-close
 *   · 关闭项必须排在最后（放在中间会被当成普通动作误点）
 *   · 分隔线存在（视觉上把「退出」与「动作」分开）
 *   · 五语的 common.close 都在（缺一条就显示 key）
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

const msg = read("src/views/MessagesView.vue");
const community = read("src/views/CommunityView.vue");
const detail = read("src/views/PostDetailView.vue");
const css = read("src/style.css");

/* 取每个菜单块（从开标签到第一个 ) 结束不好切，按「关闭按钮紧跟在最后一个动作之后」判断） */
const count = (s, re) => (s.match(re) || []).length;

/* 1. 会话行菜单：关闭项 5 个在 MessagesView 里（1 行菜单 + 2 头菜单 = 3 处） */
ok("M1 会话行菜单有「关闭」项", /class="dm-menu-item dm-menu-close"[^>]*menuFor = ''/.test(msg));
ok("M2 会话行菜单有分隔线", /<div class="dm-menu-sep" role="separator"><\/div>/.test(msg));
ok("M3 三处 dm-menu 都挂了关闭项", count(msg, /dm-menu-item dm-menu-close/g) === 3,
  "实际 " + count(msg, /dm-menu-item dm-menu-close/g));
ok("M4 三处 dm-menu 都有分隔线", count(msg, /class="dm-menu-sep" role="separator"/g) === 3,
  "实际 " + count(msg, /class="dm-menu-sep" role="separator"/g));

/* 2. 关闭项必须在菜单块的最后一项 —— 用「关闭按钮后紧跟 </div>」判断 */
ok("M5 会话菜单的关闭项在最后（后面紧跟收口 </div>）",
  /dm-menu-item dm-menu-close"[^>]*>\{\{ t\("common\.close"\) \}\}<\/button>\s*<\/div>/.test(msg));

/* 3. 暖心墙 / 详情页：帖子 + 评论 + 回复 = 各 3 处 */
ok("W1 暖心墙三处菜单都有「关闭」", count(community, /class="more-item more-close"/g) === 3,
  "实际 " + count(community, /class="more-item more-close"/g));
ok("W2 暖心墙三处都有分隔线", count(community, /class="more-sep" role="separator"/g) === 3,
  "实际 " + count(community, /class="more-sep" role="separator"/g));
ok("D1 详情页三处菜单都有「关闭」", count(detail, /class="more-item more-close"/g) === 3,
  "实际 " + count(detail, /class="more-item more-close"/g));
ok("D2 详情页三处都有分隔线", count(detail, /class="more-sep" role="separator"/g) === 3,
  "实际 " + count(detail, /class="more-sep" role="separator"/g));

/* 4. 关闭项点的是关闭函数，不是别的动作 */
ok("C1 帖子菜单的关闭项调 closeMore", /more-item more-close" @click="closeMore"/.test(community + detail));
ok("C2 会话行菜单的关闭项只清 menuFor", /dm-menu-close" @click.stop="menuFor = ''"/.test(msg));
ok("C3 聊天头菜单的关闭项清 headMenu", count(msg, /dm-menu-close" @click="headMenu = false"/g) === 2,
  "实际 " + count(msg, /dm-menu-close" @click="headMenu = false"/g));

/* 5. 样式：弱化色 + 居中，且夜间分隔线有单独一档（否则白底菜单里白线看不见） */
ok("S1 关闭项样式存在", /\.dm-menu-item\.dm-menu-close\s*\{/.test(css) && /\.more-item\.more-close\s*\{/.test(css));
ok("S2 关闭项居中", /\.more-item\.more-close\s*\{[^}]*text-align: center/.test(css));
ok("S3 夜间分隔线单独一档", /html\[data-theme="night"\]\s*\.dm-menu-sep/.test(css) && /html\[data-theme="night"\]\s*\.more-sep/.test(css));

/* 6. 空间不足翻转：靠底行的菜单不能把自己顶出屏幕（桌面端 .dm-list 还是 overflow:auto，会被裁） */
ok("U1 打开时量高度并决定是否翻转", /function toggleRowMenu\(/.test(msg) && /menuUp\.value = true/.test(msg));
ok("U2 翻转用 .dm-menu.up 落地", /\.dm-menu\.up\s*\{\s*top: auto; bottom: 34px;/.test(css));

/* 7. 五语都有 common.close —— 少一个就是界面上直接显示 key */
for (const f of ["src/i18n.js", "src/i18n.es.js", "src/i18n.fr.js", "src/i18n.pt.js"]) {
  const src = read(f);
  ok(`I ${path.basename(f)} 有 common.close`, /close:\s*"/.test(src) || /"close":\s*"/.test(src));
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log("  ✗ " + f);
  process.exit(1);
}
