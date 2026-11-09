/* 分享面板护栏（Node 直跑：node tools/share-page-test.mjs）
 * ------------------------------------------------------------
 * 轮 485。用户：「怎么我点击分享没有用呢，显示是已复制」
 *
 * 根因是**静默降级**：手机自带浏览器（小米 / 华为 / OPPO / vivo / 微信内置）普遍没有
 * navigator.share，旧代码于是默默走「复制链接」——用户点完只看到一句「链接已复制」，
 * 既没弹出任何分享入口，也看不出发生了什么，自然当成按钮坏了。
 *
 * 这里钉住四件事：
 *   1. 没有系统分享时必须**开面板**，不许静默复制了事；
 *   2. 复制必须走 utils/clipboard（带 execCommand 兜底），不许直连 navigator.clipboard；
 *   3. 微信内置浏览器要额外给「点右上角 ···」这条路（微特里没有别的分享方式）；
 *   4. 文案键必须五语种齐全（少一个就退英文，面板里中英混排）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

let pass = 0;
let fail = 0;
const out = [];
function t(name, fn) {
  try {
    fn();
    pass++;
    out.push("ok   " + name);
  } catch (e) {
    fail++;
    out.push("FAIL " + name + " :: " + e.message);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const pv = read("src/views/ProfileView.vue");
const i18n = read("src/i18n.js");
const es = read("src/i18n.es.js");
const fr = read("src/i18n.fr.js");
const pt = read("src/i18n.pt.js");
const clip = read("src/utils/clipboard.js");
const css = read("src/style.css");

/* 抠出 sharePage 函数体，避免整文件正则误伤 */
const shareFn = (() => {
  const i = pv.indexOf("async function sharePage");
  assert(i > 0, "ProfileView 里找不到 sharePage —— 函数被改名或删了");
  const j = pv.indexOf("\nfunction ", i + 10);
  return pv.slice(i, j > 0 ? j : i + 1500);
})();

/* ─── ① 没有系统分享 = 开面板，不许静默复制 ─── */
t("S1 无 navigator.share 时开面板（不许静默复制了事）", () => {
  assert(/navigator\.share/.test(shareFn), "sharePage 没检测 navigator.share");
  assert(/shareOpen\.value\s*=\s*true/.test(shareFn), "sharePage 没有开面板 —— 又会变成「只闪一句已复制」");
  assert(!/copyText/.test(shareFn), "sharePage 里直接调了 copyText —— 那是静默降级的旧行为");
});

t("S2 系统分享被拒（非用户取消）也要落到面板", () => {
  assert(/AbortError/.test(shareFn), "没有单独处理 AbortError（用户点取消不该弹面板）");
  /* catch 之后仍要有开面板的动作 */
  const catchPart = shareFn.slice(shareFn.indexOf("catch"));
  assert(/shareOpen\.value\s*=\s*true/.test(catchPart), "catch 之后没开面板（分享失败会变成什么都不发生）");
});

/* ─── ② 面板结构 ─── */
t("S3 面板模板：遮罩可点关闭 + 复制按钮 + 关闭按钮", () => {
  assert(/v-if="shareOpen"/.test(pv), "模板里没有 v-if=\"shareOpen\"");
  assert(/class="share-mask"[^>]*@click\.self="closeShare"/.test(pv), "遮罩没有 @click.self 关闭（点空白关不掉）");
  assert(/class="share-copy"/.test(pv) && /copyShareLink/.test(pv), "复制按钮缺失或没接 copyShareLink");
  assert(/class="share-close"/.test(pv), "没有关闭按钮（手机手势不规范时只能靠它）");
});

t("S4 面板里显示真实地址（用户要知道复制的是什么）", () => {
  assert(/class="share-url"/.test(pv), "面板里没有地址那一行");
  assert(/pageUrl/.test(pv), "没有 pageUrl 状态");
});

/* ─── ③ 复制实现 ─── */
t("S5 复制走 utils/clipboard 的 copyText（带 execCommand 兜底）", () => {
  assert(/import\s*\{[^}]*copyText[^}]*\}\s*from\s*"\.\.\/utils\/clipboard\.js"/.test(pv),
    "ProfileView 没引入 copyText");
  assert(/execCommand\("copy"\)/.test(clip), "clipboard.js 的 execCommand 兜底没了");
  assert(!/navigator\.clipboard\.writeText/.test(pv), "ProfileView 又直连 navigator.clipboard（老内核/非安全上下文会失败）");
});

/* ─── ④ 微信内置浏览器 ─── */
t("S6 微信 UA 单独给「点右上角 ···」的路", () => {
  assert(/MicroMessenger/i.test(pv), "没有识别微信内置浏览器");
  assert(/share-tip-wx/.test(pv), "模板里没有微信专用提示节点");
  assert(/inWeChat/.test(pv), "没有 inWeChat 状态");
});

/* ─── ⑤ 文案 ─── */
t("S7 按钮改名成「分享」（原来是「分享这个页面」，太长）", () => {
  assert(!/分享这个页面/.test(i18n), "中文键还是「分享这个页面」");
  assert(/sharePage:\s*"分享"/.test(i18n), "中文 sharePage 不是「分享」");
  assert(!/Share this page/i.test(i18n), "英文键还是「Share this page」");
});

t("S8 面板文案五语种齐全（缺一条就退英文，面板里中英混排）", () => {
  /* es/fr/pt 是 JSON 形态（键带引号），i18n.js 是对象字面量（键裸写），两种都要认 */
  for (const [name, src] of [["i18n.js", i18n], ["es", es], ["fr", fr], ["pt", pt]]) {
    for (const key of ["shareCopy", "shareHowto", "shareWx", "shareCopied", "shareFail"]) {
      assert(new RegExp(`["']?${key}["']?\\s*:`).test(src), `${name} 缺 ${key}`);
    }
  }
});

/* ─── ⑥ 样式 ─── */
t("S9 面板层级要压过底栏 140 与聊天壳 200", () => {
  const m = pv.match(/\.share-mask\s*\{[^}]*z-index:\s*(\d+)/);
  assert(m, ".share-mask 没有 z-index");
  const z = Number(m[1]);
  assert(z > 200, `.share-mask z-index=${z}，会被底栏(140)/聊天壳(200) 盖住`);
  assert(z < 4000, `.share-mask z-index=${z}，会盖住维护遮罩(4000)`);
});

t("S10 面板表面走主题变量（夜间主题不许一片白）", () => {
  const m = pv.match(/\.share-sheet\s*\{[\s\S]*?\}/);
  assert(m, "找不到 .share-sheet 规则");
  const block = m[0];
  const bg = (block.match(/background(?:-color)?:\s*([^;]+);/) || [])[1];
  assert(bg, ".share-sheet 没设背景");
  assert(/var\(--/.test(bg), `.share-sheet 背景写死了色值（${bg.trim()}），换主题不会跟随`);
  /* glass 主题里 --card 带 alpha（.62），单用它会把被压暗的页面透上来 → 必须有打底层 */
  assert(/background-color:\s*var\(--/.test(block) && /background-image:\s*linear-gradient/.test(block),
    "只有半透明卡色、没有不透明打底（glass 主题下会透出页面）");
});

t("S11 按钮关掉 300ms 点击延迟", () => {
  const copyBlock = pv.match(/\.share-copy\s*\{[^}]*\}/);
  const closeBlock = pv.match(/\.share-close\s*\{[^}]*\}/);
  assert(copyBlock && /touch-action:\s*manipulation/.test(copyBlock[0]), ".share-copy 没设 touch-action: manipulation");
  assert(closeBlock && /touch-action:\s*manipulation/.test(closeBlock[0]), ".share-close 没设 touch-action: manipulation");
});

/* 反向断言：面板不能留在页内 —— `.shell` 自带 z-index:1，页内子元素写多大都压不过
 * 根级底栏(140)。实测第一版没 Teleport，面板下沿被页签切掉一截。 */
t("S12 面板必须 Teleport 到 body（否则被根级底栏盖住）", () => {
  assert(/<Teleport\s+to="body">[\s\S]{0,600}?class="share-mask"/.test(pv),
    "share-mask 没在 <Teleport to=\"body\"> 里 —— 会被底栏(140)盖住");
  /* 反面：不许有「面板在 Teleport 外还有一个」的重复实现 */
  const count = (pv.match(/class="share-mask"/g) || []).length;
  assert(count === 1, `share-mask 出现 ${count} 次（应只有 1 处）`);
});

void css;
console.log(out.join("\n"));
console.log(`\n${pass} pass, ${fail} fail  →  ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
