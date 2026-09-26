/* 动态流性能（A 档 + B1 虚拟窗口）回归测试（Node 直跑：node tools/feed-perf-test.mjs）
 * ------------------------------------------------------------
 * 背景：暖心墙动态流滚到几百条后卡顿（原生列表「节点恒定」vs 我们「DOM 只增不减」）。
 * A 档（轮 81）低风险渲染优化，锁这 4 项，防止被后续改动悄悄改回去：
 *   A1  卡片「屏外跳过渲染」：.post-card 的 content-visibility:auto + contain-intrinsic-size
 *   A2  列表图懒加载 + 异步解码（loading=lazy / decoding=async）
 *   A3  列表图未解码前的占位底色（减少白闪跳动）
 *   A4  时间文案记忆化 memoWhen（fmtWhen 走 toLocaleString，是重渲染里最贵的一项）
 * 其中 A4 是纯函数，直接跑行为断言；A1～A3 读源码/样式做结构断言。
 *
 * B 档（轮 82）B1 虚拟窗口的接线断言（T20~T28）也在这里：纯逻辑在 feed-window-test.mjs，
 * 但接线断了纯函数测试照样绿 —— 卡还是全挂 DOM，所以两边都要锁。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { memoWhen, fmtWhen } from "../src/utils/wallRules.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

/** 去掉注释（结构断言前先剥 —— 注释里提到 scrollIntoView / overflowAnchor 这类
 *  名字会把「代码里还有没有」判反，本测试就踩过两次）。整块注释换成同长空白保行号。 */
const noComment = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
  .replace(/(^|[^:\w"'`])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));

const out = [];
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; out.push("PASS  " + name); }
  catch (e) { fail++; out.push("FAIL  " + name + "  → " + e.message); }
}

/* ══════════ A4 · 时间文案记忆化（纯函数，行为直测） ══════════ */

/** 造一个记账版格式化器：记调用次数 + 入参，便于断言「有没有真的少算」 */
function spy(fn) {
  const s = { calls: 0, args: [] };
  s.fn = (...a) => { s.calls++; s.args.push(a); return fn(...a); };
  return s;
}

t("T1 memoWhen：同语言同时间戳反复取 → 底层只算一次", () => {
  const s = spy(fmtWhen);
  const when = memoWhen(s.fn);
  const ts = Date.now();
  const a = when(ts, "zh"), b = when(ts, "zh"), c = when(ts, "zh");
  assert.equal(s.calls, 1, `底层被调用 ${s.calls} 次（应为 1）`);
  assert.equal(a, b);
  assert.equal(b, c);
});

t("T2 memoWhen：不同时间戳各自成条（不串值）", () => {
  const s = spy(fmtWhen);
  const when = memoWhen(s.fn);
  const t1 = Date.now(), t2 = t1 - 86400000;
  const a = when(t1, "zh"), b = when(t2, "zh");
  assert.equal(s.calls, 2, `底层被调用 ${s.calls} 次（应为 2）`);
  assert.equal(a, fmtWhen(t1, "zh"));
  assert.equal(b, fmtWhen(t2, "zh"));
  assert.notEqual(a, b);
});

t("T3 memoWhen：语言切换 → 整表失效（中英文案不串）", () => {
  const s = spy(fmtWhen);
  const when = memoWhen(s.fn);
  const ts = Date.now();
  const zh1 = when(ts, "zh");
  const en = when(ts, "en");
  const zh2 = when(ts, "zh");
  assert.equal(zh1, zh2, "切回中文应仍是中文文案");
  assert.equal(en, fmtWhen(ts, "en"));
  assert.equal(s.calls, 3, `切两次语言应各重算一次（实际 ${s.calls}）`);
  assert.notEqual(zh1, en);
});

t("T4 memoWhen：超过容量上限 → 清空重建，不做无界缓存", () => {
  const s = spy(fmtWhen);
  const when = memoWhen(s.fn, 3);
  const base = Date.now();
  for (let i = 0; i < 4; i++) when(base - i * 1000, "zh");   /* 第 4 条触发一次清空 */
  assert.equal(s.calls, 4, `4 个新时间戳各算一次（实际 ${s.calls}）`);
  when(base, "zh");                                          /* 最早的已被清掉 → 需重算 */
  assert.equal(s.calls, 5, `容量满清空后最早的应重算（实际 ${s.calls}）`);
  const again = when(base, "zh");                            /* 这次命中 */
  assert.equal(s.calls, 5, `刚算过的应命中缓存（实际 ${s.calls}）`);
  assert.equal(again, fmtWhen(base, "zh"));
});

t("T5 memoWhen：输出与 fmtWhen 逐字一致（多时间戳 × 双语）", () => {
  const when = memoWhen((ts, locale) => fmtWhen(ts, locale));
  const now = Date.now();
  const y = new Date(now);
  const stamps = [
    now,
    now - 90 * 1000,
    now - 3 * 86400000,
    new Date(y).setFullYear(y.getFullYear() - 1),   /* 跨年 */
    new Date(y).setMonth(0, 2),                     /* 年初 */
  ];
  for (const ts of stamps) {
    for (const loc of ["zh", "en", "zh"]) {   /* 混序切换，逼出 locale 失效路径 */
      assert.equal(when(ts, loc), fmtWhen(ts, loc), `ts=${ts} loc=${loc} 文案不一致`);
    }
  }
});

t("T6 memoWhen：非法时间仍返回空串（与 fmtWhen 同口径，且可缓存）", () => {
  const s = spy(fmtWhen);
  const when = memoWhen(s.fn);
  for (const bad of [null, undefined, "", "不是时间"]) {
    assert.equal(when(bad, "zh"), "");
    assert.equal(when(bad, "zh"), "");
  }
  assert.equal(s.calls, 4, `4 个非法值各算一次（实际 ${s.calls}）`);
});


/* ══════════ A1 · 卡片屏外跳过渲染 ══════════ */
const css = read("src/style.css");
/* 取「行首的 .post-card 规则块」——避免误匹配 .post .pic / .waller .pic 这类后代选择器 */
const POST_CARD = /(?:^|\n)\.post-card\s*\{[^}]*\}/;
t("T9 .post-card 开了 content-visibility:auto（屏外不 style/layout/paint）", () => {
  const m = css.match(POST_CARD);
  assert.ok(m, "style.css 缺少行首 .post-card 规则");
  assert.ok(/content-visibility:\s*auto/.test(m[0]), "未开 content-visibility");
  assert.ok(/contain-intrinsic-size:\s*auto\s+\d+px/.test(m[0]),
    "缺 contain-intrinsic-size（不写会让屏外卡片高度塌成 0，滚动条乱跳）");
});

t("T10 .post-card 的占位高度取了合理量级", () => {
  const m = css.match(POST_CARD);
  const px = Number((m[0].match(/contain-intrinsic-size:\s*auto\s+(\d+)px/) || [])[1]);
  assert.ok(px >= 120 && px <= 600, `占位高度 ${px}px 不合常理（应在 120~600 之间）`);
});

/* ══════════ A2 · 列表图懒加载 ══════════ */
const cmt = read("src/views/CommunityView.vue");
t("T11 动态流帖子图：loading=lazy + decoding=async", () => {
  const m = cmt.match(/<img[^>]*class="pic"[^>]*>/);
  assert.ok(m, 'CommunityView 里找不到 class="pic" 的帖子图');
  assert.ok(m[0].includes('loading="lazy"'), '帖子图缺 loading="lazy"');
  assert.ok(m[0].includes('decoding="async"'), '帖子图缺 decoding="async"');
});

t("T12 帖子图仍受 v-if=\"p.img\" 保护（无图帖不渲染空 img）", () => {
  assert.ok(/<img\s+v-if="p\.img"[^>]*class="pic"/.test(cmt), '帖子图丢了 v-if="p.img"');
});

/* ══════════ A3 · 占位底色 ══════════ */
t("T13 .pic 有未解码前的占位底色", () => {
  assert.ok(/(?:^|\n)\.pic\s*\{[^}]*background:\s*rgba?\(/.test(css),
    ".pic 缺占位底色（注意别被 .post .pic / .waller .pic 这类后代规则带偏）");
});

/* ══════════ A4 · 接线检查：组件确实用了记忆化版本 ══════════ */
t("T14 CommunityView 的 when 走 memoWhen（不再每次裸调 fmtWhen）", () => {
  assert.ok(cmt.includes("memoWhen"), "未导入/未使用 memoWhen");
  assert.ok(/memoWhen\(\(ts,\s*locale\)\s*=>\s*fmtWhen\(ts,\s*locale\)\)/.test(cmt),
    "未用 memoWhen 包住 fmtWhen");
  assert.ok(!/const when = \(ts\) => fmtWhen\(/.test(cmt), "when 仍在裸调 fmtWhen");
});

t("T15 模板里的调用点仍存在（记忆化没把用法删掉）", () => {
  assert.ok(cmt.includes("when(p.ts)"), "帖子时间调用点丢失");
  assert.ok(cmt.includes("when(cm.ts)"), "一级评论时间调用点丢失");
  assert.ok(cmt.includes("when(rp.ts)"), "二级回复时间调用点丢失");
});

t("T7 memoWhen：入参原样透传给底层（不改造 ts/locale）", () => {
  const s = spy(() => "x");
  const when = memoWhen(s.fn);
  const ts = Date.now();
  when(ts, "en");
  assert.deepEqual(s.args[0], [ts, "en"]);
});

t("T8 memoWhen：返回的是函数，可安全在每次渲染里调用", () => {
  const when = memoWhen((ts, locale) => fmtWhen(ts, locale));
  assert.equal(typeof when, "function");
  assert.equal(typeof when(Date.now(), "zh"), "string");
});

/* ══════════ B 档（轮 82）· 虚拟窗口接线 ══════════
 * 纯逻辑（前缀高度表 / 二分定位 / 占位 / 触底）在 tools/feed-window-test.mjs；
 * 这里只查「组件真的接上了没有」——接线断了纯函数测试是绿色的，卡还是全挂 DOM。
 */
const B1 = read("src/views/CommunityView.vue");

t("T20 列表只渲染窗口切片（pageItems），不再直接遍历整段已亮数据", () => {
  assert.ok(/v-for="p in pageItems"/.test(B1), "模板没改用窗口切片 pageItems");
  assert.ok(!/v-for="p in shownPage"/.test(B1), "模板仍在直接遍历 shownPage（窗口没生效）");
  assert.ok(/const pageItems = computed\(\(\) => shownPage\.value\.slice\(winStart\.value, winEnd\.value\)\)/.test(B1),
    "pageItems 不是 shownPage 的窗口切片");
});

t("T21 上下占位块存在，且高度绑的是算出来的 padTop / padBottom", () => {
  assert.equal((B1.match(/class="feed-pad"/g) || []).length, 2, "应有上下两个 .feed-pad 占位块");
  assert.ok(/:style="\{ height: padTop \+ 'px' \}"/.test(B1), "上占位块没绑 padTop");
  assert.ok(/:style="\{ height: padBottom \+ 'px' \}"/.test(B1), "下占位块没绑 padBottom");
  assert.ok(/(?:^|\n)\.feed-pad\s*\{/.test(read("src/style.css")), ".feed-pad 缺样式兜底");
});

t("T22 卡片挂了函数 ref（高度表与锚点补偿的数据来源）", () => {
  assert.ok(/:ref="bindCard\(p\)"/.test(B1), "卡片没挂 :ref（量不到高度 → 占位只能是估值，回滚会撞空档）");
  assert.ok(/cardEls\.set\(k, el\)/.test(B1), "setCardEl 没登记元素");
  assert.ok(/cardRO\s*=\s*new ResizeObserver/.test(B1), "没建 ResizeObserver → 卡片自身变高（展开评论）后高度表不更新");
});

t("T23 高度表带上了卡片间距 gap，且间距是从真卡片现读的（不是写死）", () => {
  assert.ok(/buildOffsets\(list, heights, \{ gap: feedGap\(\), est: FEED_EST \}\)/.test(B1),
    "buildOffsets 没传 gap/est（几百条后会串位，估高也会和 CSS 占位打架）");
  /* 真机取证：同一份 style.css 里 .card 桌面 18px、.shell--mobile-nav .card 手机 12px ——
     写死任一个，几百条之后就是上千像素的累计串位，所以必须从卡片 computed style 现读。 */
  assert.ok(/function feedGap\(\)/.test(B1), "缺 feedGap");
  assert.ok(/getComputedStyle\(el\)\.marginBottom/.test(B1), "feedGap 没从真实卡片读 margin-bottom");
  assert.ok(/return POST_GAP/.test(B1), "feedGap 读不到时要回落常量（老引擎/无头环境）");
  const m = read("src/style.css").match(/(?:^|\n)\.card\s*\{[^}]*\}/);
  assert.ok(m, "style.css 缺少 .card 规则");
  const cssGap = Number((m[0].match(/margin-bottom:\s*(\d+)px/) || [])[1]);
  const jsGap = Number((B1.match(/const POST_GAP = (\d+)/) || [])[1]);
  assert.ok(cssGap > 0 && jsGap > 0, "取不到间距值");
  assert.equal(jsGap, cssGap, `兜底 POST_GAP=${jsGap} 与 .card 的 margin-bottom=${cssGap}px 不一致`);
  /* 手机断点确实换过卡距 → 证明「写死常量」这条路本身就不成立（所以才有 feedGap） */
  assert.ok(/\.shell--mobile-nav \.card \{[^}]*margin-bottom:\s*12px/.test(read("src/style.css")),
    "预期手机断点卡距 12px（若 CSS 已改，请同步 feedGap 的验证口径）");
  /* 估高链只能是「一条链」：CSS 占位 == DEFAULT_EST == 组件用的 FEED_EST */
  const est = Number((read("src/utils/feedWindow.js").match(/export const DEFAULT_EST = (\d+)/) || [])[1]);
  const ci = Number((read("src/style.css").match(/contain-intrinsic-size:\s*auto\s+(\d+)px/) || [])[1]);
  assert.ok(est > 0 && ci > 0, "取不到估高/占位高度");
  assert.equal(est, ci, `DEFAULT_EST=${est} 与 contain-intrinsic-size=${ci}px 不一致`);
  assert.ok(/const FEED_EST = DEFAULT_EST;/.test(B1), "FEED_EST 没复用 DEFAULT_EST（又写死了一个数）");
});

t("T24 短列表回退阀：≤ WINDOW_ON_THRESHOLD 条时窗口 = 全部、占位清零", () => {
  assert.ok(/if \(n <= WINDOW_ON_THRESHOLD\)/.test(B1), "缺短列表回退分支");
  assert.ok(/winEnd\.value = n;[\s\S]{0,140}?padTop\.value = 0;[\s\S]{0,80}?padBottom\.value = 0;/.test(B1),
    "回退分支没有把占位清零");
});

t("T25 触底续载改由 nearEnd 算（哨兵会被底部占位块推到视口外，不能再用它）", () => {
  assert.ok(/nearEnd\(\{ total, scrollTop: listScrollTop\(\)/.test(B1), "没接 nearEnd");
  assert.ok(!/\bfeedIO\b/.test(B1), "旧的 IntersectionObserver 续载逻辑还在（会与 nearEnd 双重续载）");
  assert.ok(!/new IntersectionObserver/.test(B1), "组件里还有 IntersectionObserver");
  assert.ok(/if \(hasMore\.value\) reveal\.value \+= PAGE_SIZE;/.test(B1), "续亮批次丢了");
  assert.ok(/else if \(!cloudDone\.value\) loadMoreCloud\(\);/.test(B1), "向服务器取下一页丢了");
});

t("T26 滚动监听装配齐 + 卸载时拆干净（rAF / RO / 元素表）", () => {
  for (const ev of ["scroll", "resize", "wheel", "touchmove", "keydown"]) {
    assert.ok(new RegExp(`addEventListener\\("${ev}"`).test(B1), `没监听 ${ev}`);
    assert.ok(new RegExp(`removeEventListener\\("${ev}"`).test(B1), `${ev} 监听没拆（切页后泄漏）`);
  }
  assert.ok(/onUnmounted\(\(\) => \{/.test(B1), "缺 onUnmounted");
  assert.ok(/cancelAnimationFrame\(feedRaf\)/.test(B1), "卸载时没取消未执行的 rAF");
  assert.ok(/cardRO\.disconnect\(\)/.test(B1), "卸载时没断开 ResizeObserver");
  assert.ok(/cardEls\.clear\(\)/.test(B1), "卸载时没清卡片元素表");
});

t("T27 深链跳帖：先把 reveal 撑到目标条，再把窗口钉到它身上", () => {
  assert.ok(/revealTarget\(idx, PAGE_SIZE\)/.test(B1), "深链没撑 reveal（目标条还在窗口外）");
  assert.ok(/pinnedIdx = idx;/.test(B1), "深链没钉窗口");
  assert.ok(/syncFeedWindow\(idx\)/.test(B1), "钉窗口后没立即重算");
  /* 定位不能再用 scrollIntoView：真机取证（feed-window-live L7）——nextTick 只保证 DOM 挂上，
     布局还是旧 padTop 的，scrollIntoView(smooth) 用旧坐标算终点，动画停稳后目标落在视口上方 690px。
     现在走 centerOn：等一帧布局 → 按真实 rect 自己算偏移 → 700ms 后自查越界就即时补齐。 */
  assert.ok(/centerOn\(el\)/.test(B1), "深链没走 centerOn（等布局再算落点）");
  assert.ok(/behavior: "smooth"/.test(B1), "定位动画丢了");
  assert.ok(/behavior: "instant"/.test(B1), "缺滚完自查的即时补齐（layout 变了会偏一截）");
  /* 口径：**深链这一条路径**不许再用 scrollIntoView（别的用途——比如点回复把输入框滚进视野——照旧）。
     先按原文切出这一段，再剥注释（那段注释里本来就写着「scrollIntoView 无处可去」这几个字，
     直接扫原文会把它当成代码 → 误报）。 */
  const from = B1.indexOf("async function focusPost");
  const to = B1.indexOf("/* 首屏（含云端帖异步到达）");
  assert.ok(from > 0 && to > from, "取不到深链定位那段代码（锚点字符串改了？）");
  assert.ok(!/scrollIntoView/.test(noComment(B1.slice(from, to))),
    "深链路径里还留着 scrollIntoView（旧坐标算终点，真机落点偏 690px）");
});

t("T28 虚拟窗口模块被正确引入（路径与用到的导出）", () => {
  assert.ok(/from "\.\.\/utils\/feedWindow\.js"/.test(B1), "没引入 feedWindow.js");
  for (const f of ["buildOffsets", "windowRange", "nearEnd", "revealTarget", "idOf"]) {
    assert.ok(new RegExp(`\\b${f}\\b`).test(B1), `没用上 ${f}`);
  }
});

t("T29 滚动锚定「按需借用」：只在程序式跳转期间关，跳完 / 离场都还回去", () => {
  /* 这条曾真漏过：只写了赋值却忘了 let 声明 —— ESM 是严格模式，赋值未声明变量会直接
     ReferenceError，onMounted 从这行起整段中断（挂载钩子里的后续接线全不执行，界面看着「能显示」
     却永远只有首屏十几条、也不再续载）。所以「声明」本身也是被锁的一项。 */
  assert.ok(/^let prevAnchor\b/m.test(B1), "prevAnchor 没有声明（赋值会抛 ReferenceError → 挂载钩子中断）");
  assert.ok(/function holdAnchor\(\)/.test(B1) && /function releaseAnchor\(\)/.test(B1), "缺 holdAnchor/releaseAnchor");
  assert.ok(/if \(root\.style\.overflowAnchor !== "none"\) prevAnchor = root\.style\.overflowAnchor;/.test(B1),
    "没记下原值（还回去会还成空串）");
  assert.ok(/root\.style\.overflowAnchor = "none";/.test(B1), "holdAnchor 没关掉锚定");
  assert.ok(/document\.documentElement\.style\.overflowAnchor = prevAnchor;/.test(B1), "releaseAnchor 没把原值还回去");
  /* 关键口径（轮 82 L7/L8 取证）：绝不能**永久**关 —— 用户自己滚时靠它钉住画面。
     判据用「关锚定的语句恰好只剩一处、且在 holdAnchor 里」——比按 onMounted 切字符串稳：
     本文件 onMounted 有多处，indexOf 会抓到前一个（本测试刚踩过这个假警报）。 */
  const n = noComment(B1);
  assert.equal((n.match(/style\.overflowAnchor = "none"/g) || []).length, 1,
    "关锚定的语句不止 holdAnchor 一处（有地方在全局关 → 滚动中的位移没人兜）");
  const hold = n.slice(n.indexOf("function holdAnchor()"), n.indexOf("function releaseAnchor()"));
  assert.ok(hold && /style\.overflowAnchor = "none"/.test(hold), "holdAnchor 里没关锚定");
  /* 切「整个函数体」而不是固定字符数：centerOn 光是注释就 20 行，
     写死 900 会把函数尾部（releaseAnchor 那句）切掉 → 假失败（本测试刚踩过）。 */
  const c0 = n.indexOf("function centerOn(el)");
  const cands = ["\nfunction ", "\nwatch(", "\nonMounted("]
    .map((s) => n.indexOf(s, c0 + 10)).filter((x) => x > 0);
  const on = n.slice(c0, cands.length ? Math.min(...cands) : n.indexOf("</script>", c0));
  assert.ok(/holdAnchor\(\)/.test(on), "跳转没借用锚定（真机：scrollTo 被锚定拽回 39k）");
  assert.ok(/releaseAnchor\(\)/.test(on), "跳转结束没还回去");
  const off = n.slice(n.indexOf("onUnmounted(() => {"));
  assert.ok(/releaseAnchor\(\)/.test(off.slice(0, 700)), "离场没还回锚定");
});

t("T30 让位守卫真的活着：滚动时刻被记录 + 间距缓存随断点失效", () => {
  /* 真缺陷（轮 82 取证）：`lastScrollAt` 只声明、从没被赋值 → `performance.now() - 0 < 200`
     只在本页时间轴头 200ms 内为真，那条「正在滚就别动手」的守卫等于不存在：
     锚点补偿有概率落在平滑滚动动画中间把它掐断。守卫必须有人「上发条」。 */
  assert.ok(/^let lastScrollAt\b/m.test(B1), "lastScrollAt 没有声明");
  assert.ok(/lastScrollAt = performance\.now\(\)/.test(B1), "没有任何地方记录滚动时刻（守卫形同虚设）");
  assert.ok(/addEventListener\("scroll", onScroll/.test(B1), "滚动监听没走记录时刻的那支 handler");
  assert.ok(/removeEventListener\("scroll", onScroll\)/.test(B1), "滚动监听没拆干净");
  /* 间距从真卡片现读，就得有失效口子：断点一变（手机 12px ↔ 桌面 18px）缓存必须重读 */
  assert.ok(/let gapCache = 0/.test(B1), "缺 gapCache");
  assert.ok(/if \(gapCache > 0\) return gapCache/.test(B1), "间距没缓存（每帧 getComputedStyle 强制样式重算）");
  assert.ok(/function onViewport\(\)/.test(B1) && /gapCache = 0;/.test(B1), "resize 时没让间距缓存失效");
  assert.ok(/addEventListener\("resize", onViewport\)/.test(B1), "resize 没接 onViewport");
});

/* ══════════ 自检：用例注册位置 ══════════
 * 本文件初版把 T7/T8 写在了 process.exit 之后 → 两项永远跑不到（而 TOTAL 计数看着还正常，
 * 属于「静默丢测试」。这里锁住：process.exit 之后不许再出现 t(...) 用例。 */
t("T16 本文件所有用例都注册在 process.exit 之前（防新增用例被静默跳过）", () => {
  const self = read("tools/feed-perf-test.mjs");
  const exitAt = self.indexOf("process.exit(");
  assert.ok(exitAt > 0, "缺少 process.exit");
  assert.ok(!/^t\(/m.test(self.slice(exitAt)), "process.exit 之后还有 t(...) 用例 → 永远执行不到");
});

console.log(out.join("\n"));
console.log(`\nTOTAL ${pass + fail}  PASS ${pass}  FAIL ${fail}`);
process.exit(fail ? 1 : 0);
