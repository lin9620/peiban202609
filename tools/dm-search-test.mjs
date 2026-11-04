/* 轮 337 · 左列搜索（昵称/预览 + 本机聊天记录）—— 纯函数 + 接线锁
 *   node tools/dm-search-test.mjs
 *
 * 用户报障「搜索功能没有用」：搜聊天里出现过的话（如「给漂流瓶加一个时间限制」）
 * 永远是空，而且空结果还显示成「还没有会话」，看起来像会话丢了。
 * 这里锁两件事：
 *   ① 纯函数：searchRows / hitSnippet 的命中条数、片段、撤回不算、大小写、上限；
 *   ② 接线：页面真的读了 IndexedDB、防抖/序号防串词、空态分清「没有会话」和「没搜到」。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { searchRows, hitSnippet } from "../src/utils/dmRules.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const MV = fs.readFileSync(path.join(root, "src/views/MessagesView.vue"), "utf8");
const RULES = fs.readFileSync(path.join(root, "src/utils/dmRules.js"), "utf8");
const I18N = fs.readFileSync(path.join(root, "src/i18n.js"), "utf8");
let pass = 0, fail = 0; const out = [];
const t = (name, fn) => {
  try { fn(); pass++; out.push("ok   " + name); }
  catch (e) { fail++; out.push("FAIL " + name + " :: " + e.message); }
};
const has = (src, re, msg) => { if (!re.test(src)) throw new Error(msg); };
const hasNot = (src, re, msg) => { if (re.test(src)) throw new Error(msg); };
const msg = (id, body, extra = {}) => ({ id, body, created_at: extra.created_at || `2026-01-0${(id % 9) + 1}T00:00:00Z`, deleted_at: null, ...extra });

/* ───────── 纯函数 ───────── */
t("S1 hitSnippet：中间命中 → 两侧省略号；开头命中 → 左边不加", () => {
  assert.equal(hitSnippet("给漂流瓶加一个时间限制", "漂流瓶", 2), "给漂流瓶加一…");
  assert.equal(hitSnippet("给漂流瓶加一个时间限制", "给", 2), "给漂流…");
  assert.equal(hitSnippet("abc", "Z"), "");
  assert.equal(hitSnippet("", "x"), "");
});

t("S2 hitSnippet：不区分大小写，换行压成空格", () => {
  assert.equal(hitSnippet("Hello WORLD", "world", 0), "…WORLD");
  assert.equal(hitSnippet("第一行\n第二行", "第二", 2), "…行 第二行");
});

t("S3 searchRows：计数 + 取最新一条的片段 + lastAt", () => {
  const rows = [
    msg(1, "给漂流瓶加个时间限制", { created_at: "2026-01-01T00:00:00Z" }),
    msg(2, "别的内容"),
    msg(3, "给漂流瓶的时间限制再改改", { created_at: "2026-01-03T00:00:00Z" }),
  ];
  const hit = searchRows(rows, "漂流瓶");
  assert.ok(hit, "应该命中");
  assert.equal(hit.count, 2);
  assert.equal(hit.lastAt, "2026-01-03T00:00:00Z");
  assert.ok(hit.snippet.includes("再改改"), "片段要取最新那条");
});

t("S4 searchRows：撤回 / 空正文不算命中；没命中返回 null", () => {
  const rows = [
    msg(1, "这条撤回前有漂流瓶", { deleted_at: "2026-01-02T00:00:00Z" }),
    msg(2, ""),
    msg(3, null),
  ];
  assert.equal(searchRows(rows, "漂流瓶"), null);
  assert.equal(searchRows(rows, "  "), null);
  assert.equal(searchRows([], "x"), null);
});

t("S5 searchRows：大小写不敏感；limit 只扫最近 N 条", () => {
  const rows = [msg(1, "OLD Needle"), msg(2, "x"), msg(3, "x")];
  assert.equal(searchRows(rows, "needle").count, 1);
  assert.equal(searchRows(rows, "needle", { limit: 2 }), null, "limit=2 应该扫不到第 1 条");
});

t("S6 搜索函数仍是纯的（dmRules 不碰 DOM/IndexedDB）", () => {
  const src = RULES.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/document\.|window\.|localStorage|indexedDB/.test(src), "dmRules 不许有环境依赖");
});

/* ───────── 接线 ───────── */
t("S7 页面：读本地全量库搜正文（防抖 + 序号防串词）", () => {
  has(MV, /import \{[\s\S]{0,200}searchRows[\s\S]{0,400}\} from "\.\.\/utils\/dmRules\.js"/, "没 import searchRows");
  has(MV, /const msgHits = ref\(\{\}\)/, "缺少命中表 msgHits");
  has(MV, /watch\(q, \(val\) => \{[\s\S]{0,900}setTimeout\(async \(\) =>/, "搜索没走防抖");
  has(MV, /setTimeout\(async \(\) => \{[\s\S]{0,600}\}, 260\)/, "防抖窗口不是 260ms");
  has(MV, /const my = \+\+hitSeq/, "没有请求序号");
  has(MV, /if \(my === hitSeq\) msgHits\.value = map/, "慢响应没被丢弃（会把旧词结果写回来）");
  has(MV, /await idbLoad\(cid\)/, "没读 IndexedDB，搜不到聊天记录");
  has(MV, /searchRows\(rec && rec\.msgs, key\)/, "没把本地消息交给 searchRows");
  has(MV, /if \(!key\) \{ msgHits\.value = \{\}; return; \}/, "清空搜索时没清命中表");
});

t("S8 页面：命中行要并回列表，并显示命中片段 / 条数", () => {
  has(MV, /const withHits = \(list\) => \{[\s\S]{0,700}filterConvs\(list, key\)/, "withHits 没先用昵称/预览过滤");
  has(MV, /\? list\.filter\(\(c\) => !seen\.has\(String\(c\.conv_id\)\) && hitOf\(c\)\)/, "没把「只有聊天记录命中」的会话并回来");
  has(MV, /sortConvs\(base\.concat\(extra\)\)\.map\(\(c\) => \(\{ \.\.\.rowView\(c\), hit: hitOf\(c\) \}\)\)/, "命中信息没挂到行上");
  has(MV, /computed\(\(\) => withHits\(convs\.value\.filter/, "normal/requests 没走 withHits");
  has(MV, /<p v-if="c\.hit" class="sub dm-hit">\{\{ c\.hit\.snippet \}\}/, "命中行没显示片段");
  has(MV, /c\.hit\.count > 1[\s\S]{0,120}t\("dm\.searchHit", \{ n: c\.hit\.count \}\)/, "多条命中没显示条数");
  has(MV, /<p v-else class="sub dm-preview">/, "命中时预览行没让位（两行都显示会挤成一团）");
});

t("S9 页面：空态分清「没有会话」/「没搜到」（带关键词）", () => {
  has(MV, /q\.trim\(\) \? t\("dm\.searchEmpty", \{ q: q\.trim\(\) \}\) : t\("dm\.empty"\)/, "空态没按搜索词切换");
  has(I18N, /searchEmpty: "Nothing matched “\{q\}”/, "英文缺 searchEmpty");
  has(I18N, /searchEmpty: "没有找到与「\{q\}」相关的会话/, "中文缺 searchEmpty");
  has(I18N, /searchHit: "\{n\} total"/, "英文缺 searchHit");
  has(I18N, /searchHit: "共 \{n\} 条"/, "中文缺 searchHit");
});

console.log(out.join("\n"));
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
