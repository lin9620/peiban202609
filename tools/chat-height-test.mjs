/* 「换个手机换个浏览器」矩阵测试（Node 直跑：node tools/chat-height-test.mjs）
 * ------------------------------------------------------------
 * 轮 468。用户原话：「你不要只改我这个浏览器上面的，要考虑不同的浏览器啊，
 * 不要换个手机换个浏览器又出现不同的空白距离问题」。
 *
 * 所以这里不测「一台机器上算对没」，而是把**同一块物理屏幕**喂给不同内核对
 * innerHeight / visualViewport.height 的不同上报组合，断言聊天容器高度都落在
 * 真实可见高上（±1）。
 *
 * 已知内核样本（真机/文档）：
 *   Chrome / Chromium      无键盘 inner == vv == 可见高；键盘时两者同时缩
 *   小米自带浏览器          无键盘 inner 对、vv 少 31px；键盘时两者同时缩
 *   iOS Safari             无键盘 inner == vv；键盘时 inner 不变、只有 vv 缩
 *   国产 overlay 键盘内核   无键盘 inner == 可见高；键盘时 inner 不变、只有 vv 缩
 * 纯 Node，无 DOM、无网络。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pickChatHeight, pickChatTop, pickChatRect, kbInsetValue, fixedBarTop, KB_GAP, TOOLBAR_GAP, kbbValue, shouldAdoptBase, kbHeightNow, kbIsUp, pickKbKind } from "../src/utils/chatHeight.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

let pass = 0, fail = 0;
const out = [];
function t(name, fn) {
  try { fn(); pass++; out.push("ok   " + name); }
  catch (e) { fail++; out.push("FAIL " + name + " :: " + e.message); }
}

/* ══════════ ① 无键盘：换内核不许变出空白 ══════════ */

/* 同一块屏（真实可见高 VIS=768），不同内核上报什么。
 * vvDelta：可视视口比真实可见高少多少（负值=少算，正值=多算）。 */
const ENGINES_NO_KB = [
  { name: "Chrome 120 / Android 14",        inner: 768, vv: 768, delta: 0 },
  { name: "小米浏览器 / MIUI 14（用户这台）", inner: 768, vv: 737, delta: -31 },
  { name: "iOS Safari 17（无键盘）",          inner: 768, vv: 768, delta: 0 },
  { name: "三星 Internet",                    inner: 768, vv: 768, delta: 0 },
  { name: "QQ / UC 等 overlay 内核",          inner: 768, vv: 742, delta: -26 },
  { name: "某些内核对 vv 取整偏小 1px",        inner: 768, vv: 767, delta: -1 },
];

t("T1 无键盘：6 种内核对同一块屏，容器高度都必须 = 真实可见高 768（±1）", () => {
  for (const e of ENGINES_NO_KB) {
    const { h, kbOpen } = pickChatHeight(e.inner, e.vv, 0);
    assert.equal(h, 768, `${e.name}：得到 ${h}，应为 768（真实可见高）`);
    assert.equal(kbOpen, false, `${e.name}：无键盘被判成键盘态`);
  }
});

t("T2 无键盘：绝不取 vv（取 vv 就是那 31px 空白的来源）", () => {
  const xiaomi = pickChatHeight(768, 737, 0);
  assert.notEqual(xiaomi.h, 737, "又取 vv 了 —— 小米浏览器会重新留出 31px 空白");
  assert.equal(xiaomi.h - 737, 31, "差额应正好是那 31px");
});

t("T3 无键盘：vv 比 inner 还大（脏内核）时也不许超过 inner —— 溢出会把输入条顶到浏览器工具栏下面", () => {
  const r = pickChatHeight(768, 900, 0);
  assert.equal(r.h, 768, "vv 脏大时取了 vv");
  assert.equal(r.kbOpen, false);
});

/* ══════════ ② 有键盘：换内核不许被键盘盖住 ══════════ */

t("T4 有键盘：iOS Safari（inner 不缩、--kb-h 已写）→ 取 vv", () => {
  const r = pickChatHeight(844, 508, 336);
  assert.equal(r.kbOpen, true, "没识别出键盘");
  assert.equal(r.h, 508, "应为键盘上方可见高 508");
});

t("T5 有键盘：安卓 overlay 内核（inner 不缩、--kb-h 为 0）→ 靠差值兜底取 vv", () => {
  const r = pickChatHeight(844, 508, 0);
  assert.equal(r.kbOpen, true, `inner−vv=336 超过 ${KB_GAP} 却仍判无键盘 → 输入条会被盖住`);
  assert.equal(r.h, 508);
});

t("T6 有键盘：resizes-content 内核（inner 与 vv 同时缩、--kb-h 为 0）→ 取 inner，结果相同", () => {
  /* 用户这台小米浏览器实测：键盘弹起 innerH=vvH=484 */
  const { h, kbOpen } = pickChatHeight(484, 484, 0);
  assert.equal(h, 484, "取值不是 484");
  assert.equal(kbOpen, false, "两者相等时不该判成键盘（本来就没有可让位的空间差）");
});

t("T7 有键盘：--kb-h 与 vv 同时正常（App 壳口径）→ 仍以 vv 为准", () => {
  const r = pickChatHeight(800, 500, 300);
  assert.equal(r.h, 500);
  assert.equal(r.kbOpen, true);
});

/* ══════════ ③ 误判保护：工具栏量级的差不算键盘 ══════════ */

t(`T8 工具栏量级的差（≤${KB_GAP}）一律不算键盘 —— 否则每台机的工具栏都会让页面平白矮一截`, () => {
  for (let d = 1; d <= KB_GAP; d += 7) {
    const r = pickChatHeight(900, 900 - d, 0);
    assert.equal(r.kbOpen, false, `差 ${d}px 被误判成键盘`);
    assert.equal(r.h, 900, `差 ${d}px 时没取 inner`);
  }
});

t(`T9 超过 ${KB_GAP} 的差才算键盘（边界值左右）`, () => {
  assert.equal(pickChatHeight(900, 900 - KB_GAP, 0).kbOpen, false, "等于阈值时不该判键盘");
  assert.equal(pickChatHeight(900, 900 - KB_GAP - 1, 0).kbOpen, true, "刚过阈值就该判键盘");
});

/* ══════════ ④ 不变量：任何组合下都不许比真实可见高更矮（那才会留白） ══════════ */

t("T10 不变量：无键盘时 h 恒 ≥ 真实可见高（inner），穷举 600~1000 × 600~1000", () => {
  let check = 0;
  for (let inner = 600; inner <= 1000; inner += 50) {
    for (let vv = 600; vv <= 1000; vv += 50) {
      if (inner - vv > KB_GAP) continue;   /* 这类按键盘处理，见下一条 */
      const { h } = pickChatHeight(inner, vv, 0);
      assert.ok(h >= inner, `inner=${inner} vv=${vv} → h=${h}，比可见高还矮（会留白）`);
      check++;
    }
  }
  assert.ok(check > 20, "覆盖面太小：" + check);
});

t("T11 不变量：判为键盘时 h 必须等于 vv（正好落在键盘上沿，不许多让）", () => {
  for (const [inner, vv, kb] of [[844, 508, 336], [800, 500, 0], [700, 400, 0], [900, 300, 600]]) {
    const r = pickChatHeight(inner, vv, kb);
    if (r.kbOpen) assert.equal(r.h, Math.round(vv), `inner=${inner} vv=${vv} → ${r.h}`);
  }
});

t("T12 结果恒为正整数（写进 style.height 前不许出 NaN / 小数）", () => {
  for (let inner = 300; inner <= 1200; inner += 37) {
    for (let vv = 200; vv <= 1200; vv += 41) {
      const { h } = pickChatHeight(inner + 0.4, vv + 0.6, 0);
      assert.ok(Number.isInteger(h) && h > 0, `inner=${inner} vv=${vv} → ${h}`);
    }
  }
});

/* ══════════ ⑤ 脏数据兜底 ══════════ */

t("T13 脏数据：两个都不可用 → h=0（调用方放弃接管），绝不返回 NaN", () => {
  for (const [a, b] of [[0, 0], [null, null], [NaN, NaN], ["x", "y"], [-5, -5]]) {
    const r = pickChatHeight(a, b, 0);
    assert.equal(r.h, 0, `pickChatHeight(${a},${b}) 应为 0，实得 ${r.h}`);
  }
});

t("T14 只有一个可用：用能用的那个，不许塌成 0", () => {
  assert.equal(pickChatHeight(768, 0, 0).h, 768);
  assert.equal(pickChatHeight(0, 737, 0).h, 737);
  assert.equal(pickChatHeight("768", "737", "0").h, 768, "字符串数字没转换");
});

/* ══════════ ⑥ top：只在键盘把可视视口顶开时位移 ══════════ */

t("T15 top：无键盘恒为 0（哪怕内核报了个脏 offsetTop）", () => {
  assert.equal(pickChatTop(768, 0, 768), 0);
  assert.equal(pickChatTop(768, 300, 768), 0, "高度=视口时没有可推的空间，必须夹回 0");
});

t("T16 top：iOS 上推 40（可见高 508、布局 844）→ 最多推到 844−508=336", () => {
  assert.equal(pickChatTop(844, 40, 508), 40, "正常上推量应原样保留");
  assert.equal(pickChatTop(844, 500, 508), 336, "离谱上推量必须夹住，否则整页会被推出屏幕");
});

t("T17 top 恒为非负、且不超过 inner−h", () => {
  for (let top = -50; top <= 600; top += 25) {
    const g = pickChatTop(844, top, 508);
    assert.ok(g >= 0 && g <= 844 - 508, `top=${top} → ${g} 越界`);
  }
});

/* ══════════ ⑦ 运行时确实走这套判据（防回退） ══════════ */

t("T18 chatViewport.js 的高度裁决必须走纯函数（pickChatRect 包住 height/top），不许内联三元", () => {
  const js = read("src/utils/chatViewport.js");
  assert(/import \{[^}]*pickChatRect[^}]*\} from "\.\/chatHeight\.js"/.test(js),
    "没 import 纯函数（轮 503 起高度+偏移一起由 pickChatRect 裁决）");
  assert(/pickChatRect\(window\.innerHeight/.test(js), "没把 innerHeight 喂给 pickChatRect");
  assert(/pickChatHeight/.test(read("src/utils/chatHeight.js")), "pickChatHeight 不见了");
  assert(!/kbRaw > 0 \? \(vv \? vv\.height/.test(js), "还留着内联三元（两份口径迟早漂）");
});

t("T19 纯函数模块不含 DOM / 浏览器依赖（Node 能直跑，别的机型才能靠矩阵回归）", () => {
  const src = read("src/utils/chatHeight.js");
  assert(!/document\.|window\.|getComputedStyle|@capacitor/.test(src), "纯函数里混进了环境依赖");
});

t("T20 宽度取 clientWidth（含缩放/滚动条的内核也不跑偏）", () => {
  const js = read("src/utils/chatViewport.js");
  assert(/documentElement\.clientWidth/.test(js), "宽度没取 clientWidth");
  assert(!/vv \? vv\.width/.test(js), "宽度还在用 visualViewport.width（缩放手势下会变小）");
});

/* ══════════ ⑧ 评论条 / 回复栏的 --kb-h 也不能把工具栏当成键盘 ══════════ */

t("T21 --kb-h：小米浏览器「聚焦但无键盘」的 31px 差 → 必须归零，否则评论条抬 31px 留白", () => {
  assert.equal(kbInsetValue(31, true), 0, "焦点路径没挡住工具栏量级的差值");
  assert.equal(kbInsetValue(26, true), 0);
  assert.equal(kbInsetValue(1, true), 0);
});

t("T22 --kb-h：真键盘（≥200）无论有没有焦点都让位；无焦点的小差值仍归零", () => {
  assert.equal(kbInsetValue(336, true), 336);
  assert.equal(kbInsetValue(336, false), 336);
  assert.equal(kbInsetValue(200, true), 200);
  assert.equal(kbInsetValue(0, true), 0);
  assert.equal(kbInsetValue(0, false), 0);
});

t("T23 --kb-h：闸门边界（80 不算、81 且无焦点算 0、81 且有焦点算 81）", () => {
  assert.equal(kbInsetValue(TOOLBAR_GAP, true), 0, "等于闸门时不该让位");
  assert.equal(kbInsetValue(TOOLBAR_GAP + 1, true), TOOLBAR_GAP + 1);
  assert.equal(kbInsetValue(TOOLBAR_GAP + 1, false), 0, "无焦点且未过 100 时不该让位");
  assert.equal(kbInsetValue(KB_GAP + 1, false), KB_GAP + 1, "过了 100 就该让位");
});

t("T24 工具栏不许被当成键盘（80px 闸门放过 81px 的真机 Safari）", () => {
  const js = read("src/utils/keyboardInset.js");
  /* 轮 510 重写。原来这条锁的是「必须调 kbInsetValue」，而 kbInsetValue 的闸门是
     TOOLBAR_GAP = 80 —— 真机 Safari 工具栏实测 81px，大 1px 就漏过去：
     --kb-h 被写成 81（页面平白缩 81px、吸底条抬 81px），随后这个 81 又被当成
     「键盘本体高度」存进 localStorage，--kb-fallback 掉到 119px（面板只剩两排）。
     现在锁的是新口径：先量「无键盘时的 UI 遮挡基线」，减掉它才叫键盘。 */
  assert(/import \{[^}]*KB_MIN[^}]*\} from "\.\/viewportMath\.js"/.test(js), "没从 viewportMath 引入 KB_MIN");
  assert(/barsSeen = Math\.max\(barsSeen, rawGap\)/.test(js), "没有记录「无键盘时的 UI 遮挡基线」");
  assert(/const kbNet = rawGap > barsSeen \? rawGap - barsSeen : 0;/.test(js), "键盘高没减掉 UI 基线");
  assert(/const realKb = kbNet >= KB_MIN;/.test(js), "没按 KB_MIN 判「这是不是真键盘」");
  assert(/const h = panelOpen \|\| !realKb \? 0 : raw;/.test(js), "让位没先过「是不是真键盘」这道闸");
  assert(/editableFocused\(\)/.test(js), "没有焦点判据（面板高反推还要用）");
});

/* ══════════ ⑨ 评论条 / 回复栏：必须贴在「可见区底 − 条高」 ══════════ */

const BAR = 51;   /* .cmt-main-bar 实测高（真机 t433~b484） */

t("T25 吸底条 5 种内核：算出来的 top 都必须让条底正好落在可见区底", () => {
  const cases = [
    /* 名称, innerH, vvH, vvTop, kbH, 期望 top */
    ["小米浏览器无键盘（vv 少 31）", 768, 737, 0, 0, 768 - BAR],
    ["resizes-content 键盘弹起（用户这台真机实测 433~484）", 484, 484, 0, 0, 433],
    ["iOS Safari 键盘（inner 不变）", 844, 508, 0, 336, 508 - BAR],
    ["iOS 上推 40px", 844, 508, 40, 296, 40 + 508 - BAR],
    ["overlay 内核且 --kb-h 失联（靠差值兜底）", 800, 460, 0, 0, 460 - BAR],
    ["Chrome 桌面窄窗（无键盘）", 700, 700, 0, 0, 700 - BAR],
  ];
  for (const [name, inner, vv, vvTop, kb, want] of cases) {
    const got = fixedBarTop(inner, vv, vvTop, kb, BAR);
    assert.equal(got, want, `${name}：得到 ${got}，应为 ${want}`);
  }
});

t("T26 吸底条：无键盘一律 = innerH − 条高（不受 vv 偏小影响）", () => {
  for (const vv of [768, 737, 742, 700, 767]) {
    assert.equal(fixedBarTop(768, vv, 0, 0, 60), 708, `vv=${vv} 时跑偏了`);
  }
});

t("T27 吸底条：条变高（换行）后 top 必须同步上移，底边不许跑出屏幕", () => {
  for (const barH of [51, 60, 90, 120]) {
    const top = fixedBarTop(800, 500, 0, 300, barH);
    assert.equal(top + barH, 500, `条高 ${barH} 时底边不在可见区底`);
  }
});

t("T28 吸底条：脏数据 / 条高为 0 → 返回 0，调用方放弃定位（交回 CSS）", () => {
  assert.equal(fixedBarTop(0, 0, 0, 0, BAR), 0);
  assert.equal(fixedBarTop(800, 0, 0, 0, 0), 0, "条高 0 时不该算出负 top");
  assert.equal(fixedBarTop(NaN, NaN, NaN, NaN, BAR), 0);
  /* top 永不为负 */
  assert.equal(fixedBarTop(40, 40, 0, 0, 200), 0);
});

t("T29 fixedBar.js：App 壳早退、不碰 bottom 残留、表情面板同一套定位（轮504）", () => {
  const js = read("src/utils/fixedBar.js");
  assert(/if \(isNativeShell\(\)\) return;/.test(js), "没有 App 壳守卫（会与原生 --kb-h 打架）");
  assert(/el\.style\.bottom = "auto"/.test(js), "没清掉 CSS 的 bottom（两个都生效会互相顶）");
  /* 轮 504：面板原来是 fixed 锚布局视口底，键盘/工具栏一压就整块跑到屏幕外
     （393×852 实测：可视底 522，面板 522~852）。交给同一个函数钉 top。 */
  assert(/\.wp-composer-picker/.test(js), "表情面板没进 SELECTOR（仍锚布局视口底，会被键盘切）");
  assert(/getComputedStyle\(el\)\.position/.test(js), "没按 computed position 排除桌面的 absolute 浮窗");
  assert(!/PANEL_CLASSES/.test(js), "还留着「面板打开就交回 CSS」的分支（条会退回布局视口参照系）");
  assert(!/\.offsetParent/.test(js), "又用 offsetParent 判可见（fixed 元素恒为 null，会全部跳过）");
});

t("T30 main.js 必须调用 initFixedBar（否则整段白写）", () => {
  const js = read("src/main.js");
  assert(/initFixedBar\(\)/.test(js), "main.js 没调用 initFixedBar");
  assert(/from "\.\/utils\/fixedBar\.js"/.test(js), "没 import fixedBar");
});

t("T31 chatViewport.js：键盘占位就必须写内联高度（不能只看 --kb-h）", () => {
  const js = read("src/utils/chatViewport.js");
  /* 轮 470 多内核矩阵抓到的真 bug：某些国产内核键盘弹起时不派发 visualViewport 事件，
     --kb-h 一直是 0；而 overlay 键盘下 100dvh 根本不变（布局视口没动）→ 容器仍全屏高，
     底边落到键盘底下，输入条被整个盖住（用户「打字看不见」）。
     判据必须是「可视视口缩了」(kbOpen)，不能是「--kb-h 有值」(那只是某条链路的结果)。
     轮 503 起 kbOpen 由 pickChatRect 一并给出（它内部就是 pickChatHeight）。 */
  assert(/const kbOpen = rect\.kbOpen/.test(js) || /const \{ h, kbOpen \} = pickChatHeight/.test(js),
    "没接 pickChatRect / pickChatHeight 的 kbOpen");
  /* 轮 507：判据从「键盘态才写」扩成「永远写」—— iOS 的 100dvh 在大视口状态下
     比能看见的那块高（用户视频里面板只剩 2 排，其余沉到屏幕外）。
     高度只能听视觉视口的，不能再让 CSS 猜一次。 */
  assert(/const useInlineH = true;/.test(js),
    "又把高度交回 CSS 100dvh 了（iOS 上 dvh 可能大于可视区，整页会沉到屏幕外）");
  assert(/el\.style\.height = useInlineH \? h \+ "px"/.test(js), "没把 h 写进内联高度");});

t("T32 输入态暗层 · 轮 472（用户拍板）：条打开时整页压暗，点暗处返回", () => {
  const css = read("src/style.css");
  assert(/\.cmt-bar-mask\s*\{/.test(css), "没有 .cmt-bar-mask 样式");
  const block = css.slice(css.indexOf(".cmt-bar-mask {"), css.indexOf(".cmt-bar-mask {") + 500);
  assert(block.indexOf("position: fixed") >= 0, "暗层不是 fixed（滚动时会跟着跑）");
  assert(block.indexOf("inset: 0") >= 0, "暗层没铺满");
  /* 必须比条低一层，否则把输入框一起蒙住 */
  assert(block.indexOf("z-index: 149") >= 0, "暗层 z-index 不是 149（条是 150，要低一层）");

  for (const f of ["src/views/CommunityView.vue", "src/views/PostDetailView.vue"]) {
    const s = read(f);
    assert(/class="cmt-bar-mask"/.test(s), `${f} 没渲染暗层`);
    assert(/MaskTap/.test(s), `${f} 暗层没绑点击`);
    /* 暗层和条一起在 <Teleport to="body"> 里，否则又被滚动容器裁掉（轮 471 的坑） */
    const tp = s.indexOf('<Teleport to="body">');
    const mask = s.indexOf('class="cmt-bar-mask"');
    assert(tp >= 0 && mask > tp, `${f} 暗层不在 Teleport 内（会被 .wall-scroller 裁掉）`);
  }
});

t("T33 暗层点击必须 stopPropagation（否则一击连走两级，条直接消失）", () => {
  for (const f of ["src/views/CommunityView.vue", "src/views/PostDetailView.vue"]) {
    const s = read(f);
    const i = s.indexOf("MaskTap(");
    const body = s.slice(i, i + 400);
    assert(/stopPropagation\(\)/.test(body), `${f} 的 MaskTap 没拦冒泡（document 上还有 DocClose）`);
    assert(/barTapIsKbBack\(\)/.test(body), `${f} 的 MaskTap 没走两级返回`);
  }
});

t("T34 两级返回：点暗处先落键盘、再收条（用户提案）", () => {
  const br = read("src/utils/barReturn.js");
  assert(/export function barTapIsKbBack/.test(br), "没有分级返回入口");
  assert(/BLUR_GRACE/.test(br), "没给「touch 阶段就 blur」的内核留宽限（会一点就把条关掉）");
  assert(/export function resetBarReturn/.test(br), "没有清账函数（下一击会被上一轮的失焦误判）");
  assert(/barTapIsKbBack\(\)/.test(br), "内部没自校一次（拿 200ms 前的旧判据会跳级）");
  /* 真机坑：键盘收起后焦点常常还在 textarea 里，只看焦点 = tabbar 永远不回来 */
  assert(/baseInner|focusedAt/.test(br), "键盘判据没有视口收缩这一支（只信焦点，真机上会永久为真）");

  for (const f of ["src/views/CommunityView.vue", "src/views/PostDetailView.vue"]) {
    const s = read(f);
    assert(/barTapIsKbBack\(\)/.test(s), `${f} 点外面没走分级返回`);
    assert(/resetBarReturn\(\)/.test(s), `${f} 收条时没清账`);
    assert(/pushBack\(/.test(s), `${f} 没接系统返回键（App 里返回只能一路退到上一页）`);
  }
});

t("T35 被否掉的方案不许回潮：折叠后 tabbar 不回来、条不坐它头顶", () => {
  const app = read("src/App.vue");
  assert(!/kbVisible/.test(app), "App.vue 又接 kbVisible 了（tabbar 会在折叠后回来 —— 用户否掉）");
  assert(/!tabbarSuppressed/.test(app), "TabBar 条件不是 !tabbarSuppressed");
  assert(!/--tabbar-h/.test(read("src/components/TabBar.vue")), "TabBar 又在写 --tabbar-h");
  assert(!/tabbar-h/.test(read("src/utils/fixedBar.js")), "fixedBar 又在让 tabbar 高度");
});

t("T36 100dvh 不允许裸写（扫 src 下全部 .css / .vue，不认 dvh 的内核会把整条声明作废）", () => {
  /* 轮 474 真机病象：Xiaomi 浏览器 CSS.supports("height","100dvh") === false。
   * 只要有一条 `height: calc(100dvh - ...)` 裸写在 @supports 外，整条声明在计算阶段
   * 就被判无效，连带前面 `height: 100vh` 的兜底一起作废 → .dm-page 落回内容高
   * （实测 377.8px / 屏高 744）→ 输入条停在屏幕中间闪一下再跳到底。
   * 所以：dvh 必须被 @supports (height: 100dvh) 圈住，vh 版本留在外层。
   *
   * 轮 480 扩到全量：原先只扫 style.css，ComposeView / LoginView 的 scoped 样式
   * 裸写了两处却一直没被发现（发帖页 min-height:100dvh、登录页 calc(100dvh - 120px)）。
   * 现在 src 下所有 .css / .vue 一起扫。 */
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(css|vue)$/.test(e.name)) files.push(p);
    }
  })(path.join(root, "src"));

  const scan = (raw) => {
    /* 注释里出现 100dvh 是正常的（就是解释这个坑的文字），但位置必须保留、
     * 否则行号会漂。用等长空格顶掉，只改内容不改坐标。 */
    const css = raw.replace(/\/\*[\s\S]*?\*\//g, (s) => s.replace(/[^\n]/g, " "));
    const open = /@supports\s*\([^)]*100dvh[^)]*\)/g;
    const ranges = [];
    const conds = []; // @supports 的条件文本自身也含 100dvh，那是合法的，要排除
    let m;
    while ((m = open.exec(css))) {
      let i = css.indexOf("{", m.index + m[0].length);
      if (i < 0) continue;
      conds.push([m.index, i + 1]);
      let d = 1;
      i++;
      const start = i;
      while (i < css.length && d > 0) {
        if (css[i] === "{") d++;
        else if (css[i] === "}") d--;
        if (d > 0) i++;
      }
      ranges.push([start, i]);
    }
    const naked = [];
    const re = /100dvh/g;
    while ((m = re.exec(css))) {
      const p = m.index;
      const inCond = conds.some(([a, b]) => p >= a && p < b);
      if (!inCond && !ranges.some(([a, b]) => p >= a && p < b)) {
        const line = css.slice(0, p).split("\n").length;
        naked.push(`${line}: ${css.slice(Math.max(0, p - 60), p + 12).replace(/\s+/g, " ").trim()}`);
      }
    }
    return { blocks: ranges.length, naked, hasVh: /100vh/.test(css) };
  };

  let totalBlocks = 0;
  const bad = [];
  const missingVh = [];
  for (const f of files) {
    const rel = path.relative(root, f).replace(/\\/g, "/");
    const r = scan(fs.readFileSync(f, "utf8"));
    totalBlocks += r.blocks;
    for (const n of r.naked) bad.push(`${rel}:${n}`);
    /* 有 dvh 块就必须有 vh 兜底，否则老内核那页直接没高度 */
    if (r.blocks > 0 && !r.hasVh) missingVh.push(rel);
  }

  assert(totalBlocks > 0, "@supports (height: 100dvh) 一条都没有 —— 是不是把兜底整段删了");
  assert(bad.length === 0, `有 ${bad.length} 处 100dvh 裸写在 @supports 外：\n    ${bad.join("\n    ")}`);
  assert(missingVh.length === 0, `这些文件有 dvh 但外层没有 vh 兜底：${missingVh.join(", ")}`);
  /* 反过来也要有：@supports 外必须有 100vh 兜底，否则老内核直接没高度 */
  const styleCss = read("src/style.css").replace(/\/\*[\s\S]*?\*\//g, (s) => s.replace(/[^\n]/g, " "));
  assert(/\.dm-page\s*\{[^}]*height:\s*100vh/.test(styleCss) || /dm-page[^{}]*\{[^}]*height:\s*100vh/.test(styleCss),
    ".dm-page 没有 100vh 兜底");
});

t("T37 iOS 把可视视口上推时（offsetTop>0），页面必须裁进 [top, top+vvH]（用户第 4 张截图）", () => {
  /* 现场：输入条贴在地址栏底下、下面一大片空白、消息一条不见。
     机理：页面仍是整屏高，iOS 为露出光标把可视视口一推，fixed 的页面跟着跑到上方。 */
  /* ① 键盘态 + 上推 300：即使 --kb-h 已经写对，也要跟着 top 走 */
  let r = pickChatRect(852, 516, 300, 336);
  assert.equal(r.h, 516, `页面没缩到可视高（得到 ${r.h}）`);
  assert.equal(r.top, 300, `页面没跟到可视视口位移（得到 ${r.top}）`);
  assert.equal(r.kbOpen, true, "被上推时应当按键盘态处理（内联写高度）");
  /* ② 键盘态但 --kb-h 是 0（链路断掉的那种）：靠差值也要缩 */
  r = pickChatRect(852, 516, 300, 0);
  assert.equal(r.h, 516, "没靠差值识别被上推的键盘态");
  assert.equal(r.top, 300);
  /* ③ 视口几乎满、只上推了一点点（差值不到 KB_GAP，差异判据救不了）——
     这正是 pickChatRect 那条裁剪存在的理由 */
  r = pickChatRect(852, 800, 52, 0);
  assert.equal(r.h, 800, "没裁进可视高（页面会比能看见的那块高 52px）");
  assert.equal(r.top, 52, "没跟可视视口位移");
  assert.equal(r.kbOpen, true, "裁过之后必须走内联高度");
});

t("T38 pickChatRect 的其它形态：面板态 / vv 脏大 / 小米 31px 都不许变", () => {
  /* 无键盘、没上推：整屏，top 0 */
  let r = pickChatRect(852, 852, 0, 0);
  assert.equal(r.h, 852); assert.equal(r.top, 0); assert.equal(r.kbOpen, false);
  /* vv 比 inner 还大（脏内核）且被上推：不许把页面拉高，top 仍为 0 */
  r = pickChatRect(852, 900, 300, 0);
  assert.equal(r.h, 852, "vv 脏大时把页面拉高了");
  assert.equal(r.top, 0, "vv 脏大时不该位移");
  /* 小米浏览器：无键盘 vv 比 inner 少 31（工具栏重复扣），页面仍取 inner */
  r = pickChatRect(768, 737, 0, 0);
  assert.equal(r.h, 768, "小米那 31px 空白回来了");
  /* 上推但 vv 没缩（页面滚动而已）：不许缩页面，也不许位移 */
  r = pickChatRect(852, 852, 120, 0);
  assert.equal(r.h, 852);
  assert.equal(r.top, 0);
});

t("T39 高度裁决不许再散落成 if 分支：chatViewport 只认 pickChatRect 的返回值", () => {
  const js = read("src/utils/chatViewport.js");
  assert(/const rect = pickChatRect\(/.test(js), "chatViewport 没走 pickChatRect");
  assert(!/vvTop > 0 && vvH > 0 && vvH < h/.test(js), "又在内联写「上推就缩」的分支了（应该收进纯函数）");
});

t("T40 真实可视高（availH）比 inner 小时，容器必须取小的那个（轮507）", () => {
  /* 病根：Safari 的底部工具栏是 overlay，innerHeight / visualViewport 都不扣它。
     `.dm-page` 的底边一旦落到工具栏下面，贴着盒底的表情面板最后一排正好被吃掉
     （用户视频：面板只露出 2 排，其余在屏幕外）。
     availH 由 viewportVars 的 svh/dvh 探针量出（取两者与 inner 的最小值）。 */
  const r = pickChatRect(852, 852, 0, 0, 808);   /* 852 的屏被工具栏吃掉 44 */
  assert.equal(r.h, 808, "没把容器裁到工具栏上方（面板会少一排）");
  assert.equal(r.top, 0, "无键盘时 top 必须是 0");
  assert.equal(r.kbOpen, false);

  /* 键盘态：vv 比 availH 更小，必须听 vv（键盘顶才是真的可视底） */
  const k = pickChatRect(852, 522, 330, 330, 808);
  assert.equal(k.h, 522, "键盘态没听 vv（用了工具栏高，页面会多缩一截）");
  assert.equal(k.top, 330);

  /* 不传 availH（老调用）→ 与改动前一致 */
  const old = pickChatRect(852, 852, 0, 0);
  assert.equal(old.h, 852);
  /* 脏值（0 / 负数 / 比 inner 还大）一律忽略 */
  assert.equal(pickChatRect(852, 852, 0, 0, 0).h, 852);
  assert.equal(pickChatRect(852, 852, 0, 0, -20).h, 852);
  assert.equal(pickChatRect(852, 852, 0, 0, 900).h, 852);
});

t("T41 键盘弹起时 resize 类事件必须**当场**对齐，不许只挂 rAF（晚一帧 = 输入条被键盘埋 55px）", () => {
  /* 轮 524 · 真机逐帧量到的：inner 走 744 → 539 → 484，盒子高度在最后一步晚一帧 ——
   * 那一帧里输入条还停在 539、键盘顶已经到 484，条被埋进去 55px。
   * 原因不是算错，是 rAF 的语义：回调在本帧回调队列跑完之后才注册，只能排到下一帧。
   * 这条锁住「resize 走同步、scroll 走 rAF」这个分工，别再退化回只挂 rAF。 */
  const js = read("src/utils/chatViewport.js");
  assert(/function kickNow\(\) \{\s*\n\s*sync\(\);\s*\n\s*kick\(\);/.test(js),
    "kickNow 没有先同步跑 sync（resize 时又只剩 rAF）");
  const init = js.slice(js.indexOf("export function initChatViewport"));
  assert(/visualViewport\.addEventListener\("resize", kickNow\)/.test(init),
    "可视视口 resize 没挂同步对齐（键盘最后一小段会晚一帧）");
  assert(/addEventListener\("resize", kickNow, \{ passive: true \}\)/.test(init),
    "window resize 没挂同步对齐");
  assert(/addEventListener\("orientationchange", kickNow, \{ passive: true \}\)/.test(init),
    "转屏没挂同步对齐");
  /* scroll 那一路每帧都响，继续挂 rAF —— 别在滚动时同步强制重排 */
  assert(/visualViewport\.addEventListener\("scroll", kick\)/.test(init),
    "滚动那一路改成同步了（每帧强制重排）");
  /* rAF 兜底本身要还在（后台标签页 rAF 会被挂起） */
  assert(/requestAnimationFrame\(\(\) => \{ rafPending = false; sync\(\); \}\)/.test(js),
    "kick 里的 rAF 兜底被删了");
});

t("T42 --kbb：resize 型必须恒 0（小米把 vv 报小 31px 是噪声，不是工具栏）", () => {
  /* 轮 524b · 用户两张截图红框里各一条空白，量出来是 --kbb 31 + --kb-over 24 = 55px。
   * 那 31px 不是工具栏，是小米浏览器把 visualViewport.height 常年报小 31px
   * （本文件开头「已知内核样本」第 2 行就写着）。原来无脑套
   * `inner − (offsetTop + vv高度)`，resize 型算出 31px 的假让位。 */
  /* resize 型：无键盘、键盘态、有 31px 噪声、有 100px 噪声 —— 全 0 */
  assert.equal(kbbValue(768, 768, 0, false, 0), 0, "resize 型无键盘算出非 0");
  assert.equal(kbbValue(768, 737, 0, false, 0), 0, "小米 31px 噪声被当成工具栏了（吸底条会浮起 31px）");
  assert.equal(kbbValue(484, 453, 0, false, 0), 0, "resize 型键盘态算出非 0");
  assert.equal(kbbValue(768, 668, 0, false, 0), 0, "100px 的噪声也不许算");
  /* overlay 型（iOS）：工具栏那 81px 必须还在，否则条沉到工具栏底下 */
  assert.equal(kbbValue(852, 771, 0, true, 0), 81, "iOS 无键盘丢了工具栏那 81px");
  assert.equal(kbbValue(852, 522, 330, true, 0), 0, "iOS 键盘态（已上推）不该再抬");
  assert.equal(kbbValue(852, 771, 0, true, 6), 87, "闭环修正量没加上");
  /* 脏值不许出 NaN */
  assert.equal(kbbValue(0, 0, 0, false, 0), 0);
  assert.equal(kbbValue(768, 737, 0, false, NaN), 0, "fix 是 NaN 时不该把 kbb 污染成 NaN");
  /* 源码层：viewportVars 不许再自己写这条式子 */
  const js = read("src/utils/viewportVars.js");
  assert(/const kbb = kbbValue\(inner, vvH, vtop, isOverlay, kbbFix\);/.test(js),
    "viewportVars 没走纯函数（口径又会漂）");
  assert(!/Math\.max\(0, inner - visBottom\)/.test(js), "又留了一份内联推导");
});

t("T43 基线采纳：瞬时过冲不采纳（140ms），稳定保持 500ms 才认新基线", () => {
  /* 轮 524b · 用户机器开机基线 744，之后工具栏收起、inner 稳定 768 →
   * --kb-over 常驻 24px，会话页盒子被钉在 508 而面板贴屏底 532，裂 24px 的缝。
   * 瞬时过冲（滚动一下、工具栏闪一下就回来）必须继续只由 --kb-over 抵掉 ——
   * 采纳了会让面板高变成 315（轮 521 的老病）。 */
  assert.equal(shouldAdoptBase(744, 799, false, 140), false, "140ms 的瞬时过冲被采纳了（面板高会变 315）");
  assert.equal(shouldAdoptBase(744, 799, false, 300), false, "300ms 还不够稳");
  assert.equal(shouldAdoptBase(744, 768, false, 500), true, "稳定 500ms 的新基线没采纳（--kb-over 会常驻）");
  assert.equal(shouldAdoptBase(744, 768, false, 5000), true);
  /* 键盘在屏上时基线绝不可信（那时 inner 被键盘压小） */
  assert.equal(shouldAdoptBase(744, 508, true, 5000), false, "键盘态还在采纳基线");
  /* 比基线小 / 只差几像素 —— 都不动 */
  assert.equal(shouldAdoptBase(744, 700, false, 5000), true, "工具栏重新展开之后的 inner 也要采纳（否则另一边同样裂 24px）");
  assert.equal(shouldAdoptBase(744, 748, false, 5000), false, "只差 4px 就采纳（取整噪声会一直翻）");
  assert.equal(shouldAdoptBase(0, 768, false, 5000), false, "基线还没建立就采纳");
  /* 源码层：sync 里必须真的调用它，且带 kbUp 闸门 */
  const js = read("src/utils/viewportVars.js");
  assert(/shouldAdoptBase\(base, inner, kbUp, Date\.now\(\) - adoptSince\)/.test(js),
    "sync 里没调 shouldAdoptBase");
  assert(/if \(!kbUp && Math\.abs\(inner - base\) > 8\) \{/.test(js), "采纳逻辑没挡键盘态 / 只认了一个方向");
});

/* ─── 轮 525 · 键盘度量矩阵：同一台 744 高屏，八种内核上报 ───
 *
 * 用户：「问题是其他浏览器呢，你有没有做预防性措施」。
 * 之前所有判据都在拿「与开机基线的绝对差」比阈值，噪声也在那个差里，
 * 于是只有 Chromium 原生 / 小米 / X5 三种 resize 型是对的。
 * 下面把真机逐条跑出来的八个样本固化下来（_scratch/probe/kernel.mjs）。
 *
 * 列：无键盘 [inner, vv] → 键盘态 [inner, vv, vvTop]
 */
const KERNELS = [
  { id: "A Chromium 原生", off: [744, 744], on: [484, 484, 0], kind: "resize", kbb: 0, kbH: 260 },
  { id: "B 小米 31px 噪声", off: [744, 713], on: [484, 453, 0], kind: "resize", kbb: 0, kbH: 260 },
  { id: "C X5/XWEB 偏小 24", off: [744, 720], on: [484, 460, 0], kind: "resize", kbb: 0, kbH: 260 },
  { id: "D 大噪声 200", off: [744, 544], on: [484, 284, 0], kind: "resize", kbb: 0, kbH: 260 },
  { id: "E iOS overlay 上推", off: [744, 744], on: [744, 484, 260], kind: "overlay", kbb: 0, kbH: 260 },
  { id: "F 内核不报 vv", off: [744, 0], on: [484, 0, 0], kind: "resize", kbb: 0, kbH: 260 },
  { id: "G overlay 不上推（FF 安卓）", off: [744, 744], on: [744, 484, 0], kind: "overlay", kbb: 260, kbH: 260 },
];

t("T44 键盘占高：八种内核都必须量出 260，且无键盘时量出 0", () => {
  for (const k of KERNELS) {
    const [bi, bv] = k.off;
    const [i, v, t] = k.on;
    assert.equal(kbHeightNow(bi, i, bv, v), k.kbH, `${k.id}：键盘高量成 ${kbHeightNow(bi, i, bv, v)}`);
    assert.equal(kbHeightNow(bi, bi, bv, bv), 0, `${k.id}：无键盘时不是 0`);
    /* kbb 仍按内核类型走：resize 一律 0，overlay 才算可视底差 */
    assert.equal(kbbValue(i, v, t, k.kind === "overlay", 0), k.kbb, `${k.id}：--kbb 算错`);
  }
});

t("T45 键盘在不在：噪声再大也不能在无键盘时判成弹起；不报 vv 的内核也必须判得出", () => {
  /* 旧判据 `vvH > 0 && base − vvH ≥ 150` 的两处塌方 */
  assert.equal(kbIsUp(744, 744, 544, 544), false, "无键盘时 vv 就报小 200 的内核被判成键盘弹起（kbb 会抬 200px）");
  assert.equal(kbIsUp(744, 484, 0, 0), true, "不报 vv 的内核（vvH 恒 0）判不出键盘（面板高永远锁不上）");
  /* 正常三型 */
  assert.equal(kbIsUp(744, 744, 744, 744), false);
  assert.equal(kbIsUp(744, 484, 744, 484), true);
  assert.equal(kbIsUp(744, 744, 744, 484), true, "overlay 型（inner 不缩）没认出来");
  /* 边界：差 149 不算、150 算 */
  assert.equal(kbIsUp(744, 595, 744, 595), false, "149px 的差被当成键盘（工具栏最大 81）");
  assert.equal(kbIsUp(744, 594, 744, 594), true, "150px 的差没认出来");
});

t("T46 内核分流：错帧不许误判；大噪声 + 不报 vv 也要判对", () => {
  /* H：键盘动画错帧 vv 已掉到 550、inner 还停在 620 —— 旧判据 `base−inner≥150` 得 124，
     当场判成 overlay 并锁死；比例判据 124/194 = 68% ≥ 50% → resize */
  assert.equal(pickKbKind(744, 620, 744, 550), "resize", "错帧被误判成 overlay");
  assert.equal(pickKbKind(744, 484, 744, 484), "resize");
  assert.equal(pickKbKind(744, 744, 744, 484), "overlay");
  assert.equal(pickKbKind(744, 484, 0, 0), "resize", "不报 vv 的内核判不出类型");
  assert.equal(pickKbKind(744, 484, 544, 284), "resize", "大噪声内核被判成 overlay");
  /* 两路都没动 = 这一帧还看不出来，调用方应保持原判断 */
  assert.equal(pickKbKind(744, 744, 744, 744), "", "没有证据时不该给结论");
});

t("T47 源码：sync 必须用这三条度量，不许再出现「绝对差 ≥ 150」那套", () => {
  const js = read("src/utils/viewportVars.js");
  assert(/const kbUp = kbIsUp\(base, inner, vvBase, vvH\)/.test(js), "kbUp 没换成 kbIsUp");
  assert(/pickKbKind\(base, inner, vvBase, vvH\)/.test(js), "内核分流没换成 pickKbKind");
  assert(/kbHeightNow\(base, inner, vvBase, vvH\)/.test(js), "--kb-now 没换成 kbHeightNow");
  assert(!/vvH > 0 && base - vvH >= 150/.test(js), "旧判据还在（大噪声内核会整场判错）");
  assert(!/if \(!overlayLocked && kbUp\)/.test(js), "内核分流还在「只判一次」（错一帧就错一场）");
  /* 面板高也必须量同一路，否则 overlay 型永远是 CSS 兜底 */
  /* 轮 526：面板高除了量同一路，还要带上「键盘在屏期间的峰值」——
     iOS 上点表情会立刻收键盘，180ms 后定时器醒来只剩工具栏 81px，被 KB_MIN 挡掉就永远锁不上。 */
  assert(/const kb = Math\.max\(kbHeightNow\(base, inner, vvBase, vvH\), peakKb\)/.test(js),
    "面板高没量同一路 / 没带键盘峰值（overlay 型锁不上，一直吃 CSS 兜底）");
});

t("T48 面板高锁定按内核分叉：安卓等键盘停稳、overlay 靠峰值不等（轮532）", () => {
  /* 两个内核的「读数该怎么看」正好相反 ——
   *   iOS（overlay）：点表情后读数一直变小（330 → 81），重设定时器就永不触发；
   *   安卓（resize）：键盘动画期间读数单调涨（744 → 484），锁早了就是中途值。
   * 2026-11-14 用户「本来安卓端好好的，现在有比较微小的跳动」就是这条规则
   * 被一条道走到黑：从 kbUp 成立起算 180ms，慢动画（400ms 级）在中途锁成 279。 */
  const js = read("src/utils/viewportVars.js");
  assert(/if \(!isOverlay\) \{/.test(js), "resize 型没有单独分支（又统一成一条规则了）");
  assert(/if \(forced \|\| kbNowHere === lockKb\) return/.test(js),
    "resize 型没按「读数还在不在变」等停稳（会锁成动画中途值）");
  assert(/else if \(lockTimer\) \{[^}]*return/.test(js),
    "overlay 型丢了「有定时器就不重设」（iOS 收键盘时读数一直变小，永不触发）");
  assert(/const FORCE_LOCK_MS = \d+/.test(js), "没有强制锁时限（键盘在屏抖 1px 的内核会永不触发）");
  assert(/setTimeout\(applyPanelLock, LOCK_SETTLE_MS\)/.test(js), "定时器回调没抽成 applyPanelLock");
  assert(/if \(kbUp\) \{\s*if \(!kbUpAt\) kbUpAt = Date\.now\(\);/.test(js),
    "kbUp 首次成立没记时刻（强制锁时限无从起算）");
});

console.log(out.join("\n"));
console.log(`\nchat-height-test: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
