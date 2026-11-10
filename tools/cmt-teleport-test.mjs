/* ═══ 轮 471 · 吸底输入条必须挂在 body 下（静态护栏）═══
 *
 * 真机事故（小米浏览器 393×744，2026-11-07）：暖心墙帖子详情页点开评论条，
 * 键盘弹起、人却看不见自己打的字。查下来不是算式问题 ——
 *
 *   · `.cmt-main-bar` 那一刻 rect 报 433~484、elementsFromPoint 也能命中 textarea；
 *   · 把它的背景刷成 #00ff00，物理屏幕只在容器底边露出几像素；
 *   · 同一时刻 appendChild 挪到 <body> 下，整条立刻完整显形。
 *
 * 原因：它当时是 `.wall-scroller` 的最后一个子元素，而那个容器在手机形态是
 * `position: fixed; overflow-y: auto`。固定定位后代套进滚动容器就画不出来，
 * 算得再准也没用 —— 所以表现成「换个浏览器/换台手机还是这样」。
 * 详情页也是同一形态（`.pd` 在 `.shell` 里，`.shell` 带 overflow-x: clip）。
 *
 * PostComments 里那一处早就 Teleport 到 body 了（注释写着「免受卡片/路由过渡的
 * transform 影响」），另外两处漏了。这个测试盯的就是「别再漏」：
 * 任何 `class="cmt-main-bar"` 的模板节点都必须被 `<Teleport to="body">` 包着。
 *
 * 只做源码静态检查（没有 DOM 依赖），毫秒级，进 fast 组。
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const FILES = [
  "src/views/CommunityView.vue",
  "src/views/PostDetailView.vue",
  "src/components/PostComments.vue",
];

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (detail ? "  ←  " + detail : "")); }
}

console.log("cmt-teleport-test :: 吸底输入条必须在 Teleport to=body 内");

/* 用「最近一个未闭合的 <Teleport to="body">」判断：找到节点前文里最后一个
 * <Teleport to="body"> 与最后一个 </Teleport>，前者在后者之后就说明它被包着。 */
function insideBodyTeleport(src, idx) {
  const before = src.slice(0, idx);
  const open = before.lastIndexOf('<Teleport to="body">');
  const close = before.lastIndexOf("</Teleport>");
  return open >= 0 && open > close;
}

let found = 0;
for (const rel of FILES) {
  const file = path.join(ROOT, rel);
  const src = fs.readFileSync(file, "utf8");
  const re = /class="cmt-main-bar"/g;
  let m;
  let n = 0;
  while ((m = re.exec(src)) !== null) {
    n++;
    found++;
    /* 取行号方便报错 */
    const line = src.slice(0, m.index).split("\n").length;
    ok(
      rel + ":" + line + " 的 .cmt-main-bar 在 <Teleport to=\"body\"> 内（不能被滚动容器套住）",
      insideBodyTeleport(src, m.index),
      "挪回容器里会在真机上完全不绘制"
    );
  }
  ok(rel + " 仍存在 .cmt-main-bar 模板节点（改动后本测试需同步更新）", n > 0);
}

ok("三处吸底条都找到了（≤3 处应为 3）", found >= 3, "实际 " + found);

/* 反向护栏：Teleport 包裹层里不许再套滚动容器（overflow / transform 都会重新劫持） */
const tpRe = /<Teleport to="body">([\s\S]*?)<\/Teleport>/g;
let tpm;
let wrappedBars = 0;
for (const rel of FILES) {
  const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
  while ((tpm = tpRe.exec(src)) !== null) {
    if (tpm[1].indexOf('class="cmt-main-bar"') < 0) continue;
    wrappedBars++;
    ok(
      rel + " 的 Teleport 包裹层内没有 overflow / transform 样式",
      !/style="[^"]*(overflow|transform)/.test(tpm[1])
    );
  }
}
ok("Teleport 包裹的吸底条计数 ≥ 3", wrappedBars >= 3, "实际 " + wrappedBars);

/* ═══ 轮 475 · 暗层手势分流（用户要求）═══
 * 「有键盘的时候，外面滑动 → 直接显示四个底部、输入部分全消失；点击 → 还是两级返回。」
 * 轮 477：详情页回复栏同步同一套（用户点名补上）。
 *
 * 暗层是 position:fixed; inset:0，滑动手势会被它整片吃掉（底下 .wall-scroller 收不到
 * scroll），不自己听 touch 就等于「滑了没反应」。所以盯四件事：
 *   ① 暗层必须挂 touchstart + touchmove；
 *   ② 滑动回调必须一步收条（不是两级）；
 *   ③ 点击回调必须先看「这一击是不是滑动的尾巴」，否则滑动完补派的 click 会再走一次；
 *   ④ 阈值常量存在（手抖 3~5px 不能算滑动）。
 * 两个页面必须**都**满足 —— 只做一处就等于另一半还是「滑了没反应」。 */
[
  { rel: "src/views/CommunityView.vue", close: "closeMainBar", move: "mainBarMaskMove", tap: "mainBarMaskTap" },
  { rel: "src/views/PostDetailView.vue", close: "closeDetailBar", move: "detailBarMaskMove", tap: "detailBarMaskTap" },
  /* 轮 497：用户点名「我的」页与「我的帖子」页的评论输入 —— 这两页共用 PostComments，
   * 它原来是一套残缺版：没有暗层、没有两级返回、没有返回键接管、不收 tabbar、
   * 点开不聚焦，还多一颗「关闭」按钮。补成同一套之后必须一起盯住，别再掉队。 */
  { rel: "src/components/PostComments.vue", close: "closeBar", move: "maskMove", tap: "maskTap" },
].forEach(({ rel, close, move, tap: tapFn }) => {
  const src = fs.readFileSync(path.join(ROOT, rel), "utf8");

  const maskTag = src.match(/<div[^>]*class="cmt-bar-mask"[^>]*>/);
  ok(rel + " 有 .cmt-bar-mask 节点", !!maskTag);
  if (maskTag) {
    ok(rel + " 暗层监听 touchstart（滑动起点）", /@touchstart/.test(maskTag[0]), maskTag[0].slice(0, 160));
    ok(rel + " 暗层监听 touchmove（滑动判定）", /@touchmove/.test(maskTag[0]), maskTag[0].slice(0, 160));
    ok(rel + " 暗层仍监听 click（点击走两级）", /@click/.test(maskTag[0]));
  }

  ok(rel + ` 有滑动判定函数 ${move}`, new RegExp(`function ${move}\\s*\\(`).test(src));
  ok(rel + " 滑动阈值常量存在（手抖不能算滑动）", /const MASK_SWIPE_PX\s*=\s*\d+/.test(src));
  ok(rel + " 滑动后要吞掉补派的 click（maskSwipe）", /if\s*\(maskSwipe\)\s*\{\s*maskSwipe\s*=\s*false;\s*return;/.test(src));
  ok(rel + ` 收条时清手势状态（否则残留吞掉下一次点击）`, new RegExp(`function ${close}[\\s\\S]{0,300}?maskSwipe\\s*=\\s*false`).test(src));

  /* 滑动回调体内必须**直接**收条，且不许掺 barTapIsKbBack（那就是两级了） */
  /* 精确取函数体：顶格那个 `}` 才是函数结束（体内缩进的 `  }` 不算） */
  const mvStart = src.indexOf("function " + move);
  const mv = src.slice(mvStart, src.indexOf("\n}", mvStart) + 2);
  ok(rel + ` 滑动 = 一步收条（直接 ${close}）`, new RegExp(`${close}\\(\\)`).test(mv));
  ok(rel + " 滑动不走两级返回（不许出现 barTapIsKbBack）", !/barTapIsKbBack/.test(mv), "滑动还分两级 = 用户要的「一步全消失」没做到");
  ok(rel + " 滑动前显式 blur（部分内核移除节点不落键盘）", /blur\(\)/.test(mv));

  /* 点击回调仍必须保留两级返回 */
  const tapStart = src.indexOf("function " + tapFn);
  const tap = src.slice(tapStart, src.indexOf("\n}", tapStart) + 2);
  ok(rel + " 点击仍走两级返回（barTapIsKbBack）", /barTapIsKbBack\(\)/.test(tap));
  ok(rel + " 点击有 stopPropagation（否则一击连走两级）", /stopPropagation\(\)/.test(tap));
});

/* 轮 477：详情页还有一个暖心墙没有的隐患 —— 左右滑翻上一条/下一条的监听挂在 window 上，
 * 而暗层刚好盖满全屏。不把「输入条开着」排除掉，一个横向手势会同时被两处看到：
 * 暗层收条，window 那边把整页滑到下一条帖子。 */
{
  const src = fs.readFileSync(path.join(ROOT, "src/views/PostDetailView.vue"), "utf8");
  const cs = src.slice(src.indexOf("const canSwipe = computed"), src.indexOf("const canSwipe = computed") + 320);
  ok("详情页 canSwipe 排除输入条开着（否则收条同时翻帖）", /detailBar\.value/.test(cs), cs.replace(/\s+/g, " ").slice(0, 160));
}

/* ── 轮 497 · 三处输入条必须同一套「外壳行为」───────────────
 * 用户原话：「我的页面，帖子下面，输入的都没改，改成跟暖心墙保持一致啊，
 * 然后我的帖子查看更多那一页也要改，点击我的页面帖子详细页面的输入也要改。」
 *
 * PostComments 当时只抄了「占位条 + 底部条」的形状，没抄外壳行为：
 *   ① 点开不聚焦（键盘不弹，得再点一次输入框）
 *   ② 没有暗层（不知道点哪儿能退出）
 *   ③ 没有两级返回（键盘在屏上时一点就把条+草稿全收了）
 *   ④ 系统返回键直接退页面，而不是先收条
 *   ⑤ 条开着 tabbar 不收（被条压住一半）
 *   ⑥ 多一颗「关闭」按钮 —— 暖心墙根本没有这颗
 * 这六条逐条锁死，三处都要过。 */
{
  const SHELL = [
    { rel: "src/views/CommunityView.vue", open: "openMainBar", label: "暖心墙" },
    { rel: "src/views/PostDetailView.vue", open: "toggleDetailBar", label: "帖子详情" },
    { rel: "src/components/PostComments.vue", open: "openBar", label: "我的页/我的帖子" },
  ];
  for (const { rel, open, label } of SHELL) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");

    /* ① 点开即聚焦：函数体内必须有聚焦动作，且要等一帧（Teleport 渲染完才有节点）
     * 暖心墙把它抽成了 focusMainBar()（内部 nextTick + focus），两种写法都算数 */
    const openBody = src.slice(src.indexOf(`function ${open}`), src.indexOf("\n}", src.indexOf(`function ${open}`)) + 2);
    const focuses = /focus\(\)/.test(openBody) || /function focusMainBar[\s\S]{0,200}focus\(\)/.test(src);
    ok(`${label}(${rel}) 点开即聚焦输入框`, focuses,
      "不聚焦 = 点了占位条键盘不弹，用户得再点一次输入框");
    ok(`${label}(${rel}) 聚焦前先等一帧（nextTick）`, /nextTick/.test(openBody) || /function focusMainBar[\s\S]{0,120}nextTick/.test(src));

    /* ② 暗层存在 + ③ 点击走两级 */
    ok(`${label}(${rel}) 输入态有暗层 .cmt-bar-mask`, /class="cmt-bar-mask"/.test(src));

    /* ④ 系统返回键先收条 */
    ok(`${label}(${rel}) 条开着时接管系统返回键（pushBack）`, /pushBack\(/.test(src)
      && /popBack\(/.test(src), "不接管 = 返回键直接退页面，草稿跟着没");

    /* ⑤ 条开着时 tabbar 收起 */
    ok(`${label}(${rel}) 条开着 = tabbar 收起`, /tabbarSuppressed\.value\s*=/.test(src));

    /* ⑥ 底部条里不许再有「关闭」按钮：出口统一是暗处 / 滑动 / 返回键 */
    const barBlock = src.match(/class="cmt-main-bar"[\s\S]{0,420}?<\/div>/);
    ok(`${label}(${rel}) 底部条内没有「关闭」按钮`, !!barBlock && !/common\.close/.test(barBlock[0]),
      barBlock ? barBlock[0].replace(/\s+/g, " ").slice(-120) : "找不到 .cmt-main-bar 块");
  }
}

console.log("\nTOTAL " + (pass + fail) + "  PASS " + pass + "  FAIL " + fail);
process.exit(fail ? 1 : 0);
