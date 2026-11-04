/* 轮 319 锁：暖心墙/详情页的评论输入框 = 消息-会话输入框同款样式。
 *
 * 用户点单原话：「把暖心墙下面评论输入框的样式换成消息-会话里面输入框的样式」。
 * 改动口径（真浏览器 A/B 取证：_scratch/shots-319/before-* ↔ after-*）：
 *   旧：.cmt-input-row 是「白洗底胶囊壳」（background: var(--wash-strong) + 1px 描边 +
 *       border-radius: 999px + padding: 5px 6px 5px 14px），输入框本体是半透明 var(--wash)，
 *       无描边无阴影 —— 与 .dm-input-row 明显两套皮肤。
 *   新：胶囊壳退役（只剩裸 flex 行），输入框本体并入 .dm-input-row 那条
 *       「白底 + 暖色发丝描边 + 轻阴影 + 圆角 14」规则，底条 gap 10px→8px、
 *       发送键 8px 抬高与末行对齐（同 .dm-send-btn 口径）。
 *
 * 三个选择器必须**同一条规则块**共用：改回两套皮肤、把 cmt 侧拆出去、或把胶囊壳加回来，本测试即红。
 * 反向验证：cmd /c "git show HEAD:src/style.css > _scratch\head-style.css" 后
 *   node tools/cmt-style-test.mjs _scratch/head-style.css
 *   → 前 6 条新锁全红；第 7 条「回归护栏」仍绿属预期（它保的是本轮**不动**的两处：
 *     .dm-input-row 与卡内占位条 .cmt-entry）。
 */
import { readFileSync } from "node:fs";

const ok = [];
const bad = [];
const t = (name, fn) => {
  try { fn(); ok.push(name); }
  catch (e) { bad.push(name + " :: " + e.message); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const file = process.argv[2] || "src/style.css";
const css = readFileSync(file, "utf8");

/* 极简 CSS 规则扫描：只取顶层规则块（@media 整块当一条，够本测试用）。
   跳过注释，按大括号深度切块，返回 { sel, body }。 */
function rules(src) {
  const out = [];
  let depth = 0, buf = "", sel = "", openAt = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? src.length : e + 1; continue; }
    if (c === "{") {
      if (depth === 0) { sel = buf.trim(); openAt = i + 1; buf = ""; }
      else buf += c;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) { out.push({ sel, body: src.slice(openAt, i) }); buf = ""; }
      else if (depth > 0) buf += c;
    } else {
      buf += c;
    }
  }
  return out;
}
const RULES = rules(css);
const sels = (r) => r.sel.split(",").map((s) => s.trim());
const has = (r, sel) => sels(r).includes(sel);
const norm = (b) => b.replace(/\s+/g, " ");
/* 声明级解析：按属性名判定，避免 box-sizing: border-box 被当成 border */
function decls(body) {
  const d = {};
  for (const part of body.split(";")) {
    const i = part.indexOf(":");
    if (i < 0) continue;
    const k = part.slice(0, i).trim().toLowerCase();
    if (k) d[k] = part.slice(i + 1).trim();
  }
  return d;
}
const one = () => {
  assert(shared.length === 1, `期望恰好 1 条「会话输入框本体」规则，实际 ${shared.length} 条`);
  return shared[0];
};

const CMT_FIELD = ".cmt-input-row .van-field__control";
const BAR_FIELD = ".cmt-main-bar .van-field__control";
const DM_FIELD = ".dm-input-row .van-field__control";

/* —— 1. 与会话共用同一条「输入框本体」规则块 —— */
const shared = RULES.filter((r) => has(r, CMT_FIELD) && norm(r.body).includes("border: 1px solid #e3cfc0"));
t("输入框本体：cmt 卡内 / cmt 底条 / 会话 三者同一条规则块", () => {
  assert(shared.length === 1, `期望恰好 1 条「会话输入框本体」规则命中 ${CMT_FIELD}，实际 ${shared.length} 条`);
  const r = shared[0];
  for (const s of [DM_FIELD, BAR_FIELD]) assert(has(r, s), `同一条规则块缺少 ${s}（说明又被拆成两套皮肤）`);
});
t("输入框本体：白底 + 暖色发丝描边 + 轻阴影 + 圆角 14（与会话逐字一致）", () => {
  const d = decls(one().body);
  assert(d["background"] === "#fff", "background 不是 #fff，实际 " + d["background"]);
  assert(d["border"] === "1px solid #e3cfc0", "border 不是 1px solid #e3cfc0，实际 " + d["border"]);
  assert(/^0 1px 2px rgba\(90, 60, 40, 0?\.05\)$/.test(d["box-shadow"] || ""),
    "缺少会话同款轻阴影 0 1px 2px rgba(90,60,40,.05)，实际 " + d["box-shadow"]);
  assert(d["border-radius"] === "14px", "border-radius 不是 14px，实际 " + d["border-radius"]);
});
t("输入框本体：该规则排在新洗底规则之后（顺序反过来会被 wash 盖掉）", () => {
  const washAt = RULES.findIndex((r) => has(r, CMT_FIELD) && norm(r.body).includes("background: var(--wash)"));
  const sharedAt = RULES.indexOf(one());
  assert(washAt >= 0, "没找到原有 wash 圆角规则（.cmt-input-row .van-field__control … background: var(--wash)）");
  assert(sharedAt > washAt, `顺序不对：wash 规则第 ${washAt} 条，本体规则第 ${sharedAt} 条`);
});

/* —— 2. 胶囊壳退役（裸 flex 行仍在、壳不在）—— */
const row = RULES.find((r) => has(r, ".cmt-input-row"));
t(".cmt-input-row：裸 flex 行仍在、胶囊壳不在", () => {
  assert(!!row, "缺少 .cmt-input-row 规则");
  const d = decls(row.body);
  assert(d["display"] === "flex", "缺少 display: flex");
  assert(d["align-items"] === "flex-end", "缺少 align-items: flex-end（发送键要对末行）");
  assert(d["gap"] === "8px", "缺少 gap: 8px（与会话行同口径），实际 " + d["gap"]);
  const bg = Object.keys(d).filter((k) => k === "background" || k === "background-color");
  const bd = Object.keys(d).filter((k) => k === "border" || k.startsWith("border-"));
  assert(!bg.length, "又出现了 " + bg.join("/") + "=" + d[bg[0]] + "（胶囊壳回来了）");
  assert(!bd.length, "又出现了 " + bd.join("/") + "=" + d[bd[0]] + "（胶囊壳回来了）");
  assert(!("padding" in d), "又出现了 padding=" + d["padding"] + "（旧的 5px 6px 5px 14px 胶囊内衬）");
  assert(!RULES.some((r) => has(r, ".cmt-input-row") && /999px/.test(r.body)), "又冒出了 999px 胶囊圆角");
});

/* —— 3. 手机底条与会话同口径 —— */
const bar = RULES.find((r) => has(r, ".cmt-main-bar"));
t(".cmt-main-bar 仍是吸底条，gap 8px + 末行对齐", () => {
  assert(!!bar, "缺少 .cmt-main-bar 规则");
  const b = norm(bar.body);
  assert(/position:\s*fixed/.test(b), "缺少 position: fixed（手机底条要贴底）");
  assert(/bottom:\s*0/.test(b), "缺少 bottom: 0");
  assert(/align-items:\s*flex-end/.test(b), "缺少 align-items: flex-end");
  assert(/gap:\s*8px/.test(b), "gap 不是 8px（旧版是 10px，与会话行不一致）");
});
t("发送键与末行对齐：cmt 两处的 8px 抬高规则在", () => {
  const r = RULES.find((x) => has(x, ".cmt-main-bar .n-button") && has(x, ".cmt-input-row .cmt-send"));
  assert(!!r, "缺少「.cmt-input-row .cmt-send, .cmt-main-bar .n-button」这条组合规则");
  const b = norm(r.body);
  assert(/position:\s*relative/.test(b), "缺少 position: relative");
  assert(/margin-bottom:\s*8px/.test(b), "缺少 margin-bottom: 8px（会话 .dm-send-btn 同口径）");
});

/* —— 4. 本轮不碰的东西 —— */
t("回归护栏：会话输入框本体与卡内占位条 .cmt-entry 未被顺手改坏", () => {
  const dmRow = RULES.find((r) => has(r, ".dm-input-row"));
  assert(!!dmRow && /display:\s*flex/.test(norm(dmRow.body)), ".dm-input-row 的 flex 行没了");
  const entry = RULES.find((r) => has(r, ".cmt-entry"));
  assert(!!entry, "缺少 .cmt-entry 规则");
  const eb = norm(entry.body);
  assert(/border-radius:\s*12px/.test(eb), ".cmt-entry 圆角变了（本轮不动卡内占位条）");
  assert(/background:\s*rgba\(243, 245, 248, \.92\)/.test(eb), ".cmt-entry 底色变了（本轮不动卡内占位条）");
});

console.log(`\n${file} :: ${ok.length}/${ok.length + bad.length}`);
for (const n of ok) console.log("  ok   " + n);
for (const n of bad) console.log("  FAIL " + n);
process.exit(bad.length ? 1 : 0);
