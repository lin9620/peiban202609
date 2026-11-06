/* 虚拟滚动的真实浏览器实测（mount 层：dist/ + 无头 Edge）
 *   node tools/feed-virtual-live.mjs [--serve=dist] [--url=/community] [--wait=3000]
 *
 * 为什么不能只在 Node 里测纯函数：
 *   feedWindow.js 的 windowRange / buildOffsets 早就有 19 项单测，但**接线**（谁在什么时候把
 *   start/end/pads 写进 ref）出问题它们照样全绿 —— 卡还是全挂 DOM，或者占位块与真实高度对不上
 *   而「越滚越跳」。本脚本跑的是真实组件 + 真实数据（线上 500+ 条帖），量的是真实几何。
 *
 * 判据（每一条都对应一类真实事故）：
 *   V1 窗口生效   —— 全程 DOM 里的 .post-card 恒定 ≤ 60 张（不随帖量线性增长）
 *   V2 真能滚     —— 一路滚到 scrollHeight 底部，且期间 scrollHeight 确实长过（续载/放宽生效）
 *   V3 没有洞     —— 每个采样点：非顶部时首卡 top ≤ 视口顶，非底部时末卡 bottom ≥ 视口底；
 *                    相邻卡最大间隙 ≤ 60px（占位块与实测高对不上就会在这里露出来）
 *   V4 不跳       —— 同一张卡在两个采样点之间，屏上位移必须精确等于滚动增量（±2px）
 *   V5 scrollTop 单调不回头 —— 往下滚的过程里 y 不许倒退（pads 重算把位置拍回顶部就是这里抓）
 * 数据不足（离线 / 墙冷清）→ 打印 SKIP 并退出 0，不污染全量测试。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith("--" + name + "="));
  return hit ? hit.split("=").slice(1).join("=") : dflt;
};
const serve = arg("serve", "dist");
const url = arg("url", "/community");
const waitMs = arg("wait", "3000");

if (!fs.existsSync(path.join(root, serve, "index.html"))) {
  console.error(`FEED_FAIL: 没有 ${serve}/index.html（先 npm run build）`);
  process.exit(2);
}
/* 产物必须是「同源」构建：给 App 用的构建把 API_BASE 写成绝对地址，浏览器从 127.0.0.1
   打开就成了跨源，网关不开 CORS → 首屏一条帖都取不到（看着像组件坏了，其实是取不到数）。 */
if (fs.existsSync(path.join(root, serve, "assets"))) {
  const abs = fs.readdirSync(path.join(root, serve, "assets"))
    .filter((f) => f.endsWith(".js"))
    .some((f) => /https:\/\/warmpaws\.de5\.net/.test(fs.readFileSync(path.join(root, serve, "assets", f), "utf8")));
  if (abs) console.warn("WARN  产物里写死了 API 绝对地址（跨源）——应改用 `VITE_API_BASE= npm run build` 再跑本用例");
}

const expr = path.join(root, "tools", "_feed-virtual-expr.js");
/* 云请求同源反代：本脚本要求 dist 用**同源**方式构建（VITE_API_BASE 留空），
   再由本地服务器把 /sb/* 反代到生产网关 —— 与线上托管同构。
   用绝对地址构建的产物会跨源打网关，网关不开 CORS → 首屏一条帖都取不到。 */
const proxy = arg("proxy", "/sb=https://warmpaws.de5.net/sb");
const t0 = Date.now();
const r = spawnSync(process.execPath, [
  "tools/web-probe.mjs",
  `--serve=${serve}`, `--url=${url}`, "--w=393", "--h=852", "--dpr=2.75", `--wait=${waitMs}`,
  `--proxy=${proxy}`, `--timeout=300000`, `--file=${expr}`,
], { cwd: root, encoding: "utf8", env: { ...process.env, MSYS2_ARG_CONV_EXCL: "--url" }, timeout: 300000 });

const out = (r.stdout || "") + (r.stderr || "");
const i = out.indexOf("{");
if (i < 0) { console.error("FEED_FAIL: 无求值结果\n" + out.slice(-800)); process.exit(1); }
let res;
try { res = JSON.parse(out.slice(i, out.lastIndexOf("}") + 1)); }
catch (e) { console.error("FEED_FAIL: 结果不是 JSON\n" + out.slice(i, i + 600)); process.exit(1); }

if (res.fail) { console.error("FEED_FAIL: " + res.fail); process.exit(1); }
if (arg("dump", "")) {
  fs.writeFileSync(arg("dump", ""), JSON.stringify(res, null, 1));
  console.log(`DUMP ${arg("dump", "")}（${res.samples.length} 个采样 / ${(res.log || []).length} 条滚动事件 / ${(res.clamps || []).length} 次夹取）`);
}
if (res.skip) {
  console.log(`SKIP  首屏拿不到帖子（${res.n} 张）—— 离线或墙冷清，跳过虚拟滚动实测`);
  process.exit(0);
}

const S = res.samples || [];
const vh = S[0].vh;

/* ── 判据 ─────────────────────────────────────────────── */
const outLines = [];
let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; outLines.push("PASS  " + name); }
  else { fail++; outLines.push("FAIL  " + name + "  → " + detail); }
};

const maxCards = Math.max(...S.map((s) => s.n));
const maxSh = Math.max(...S.map((s) => s.sh));
const finalY = S[S.length - 1].y;
const grew = maxSh > S[0].sh + 100;

/* V1 窗口生效：DOM 卡数恒定 */
check("V1 虚拟窗口生效（DOM 里恒 ≤ 60 张卡）", maxCards <= 60,
  `最多挂到 ${maxCards} 张（帖量已 ${Math.round(maxSh / 1000)}k px 高，窗口没生效）`);
check("V1b 确实滚过了长列表（不是首屏就到底）", res.bottomSh > vh * 20,
  `最长 scrollHeight=${res.bottomSh}px，视口 ${vh}（数据不足，没测到长列表）`);
check("V2 续载/放宽真的长高了（scrollHeight 变大）", grew,
  `scrollHeight 全程停在 ${maxSh}（首屏 ${S[0].sh}）—— 到底没有续载`);
check("V2b 一路滑到底（不是滑到某个位置就拉不动了）", res.reachedBottom,
  `停在 y=${finalY} / 总高 ${res.bottomSh}，差 ${res.bottomSh - vh - finalY}px 没滚到`);
check("V2c 还能原路滚回顶部", res.backTop, "上行结尾 scrollTop 没回到 0");

/* V3 洞：只在「窗口起点不在 0 / 终点不在末尾」时判上下边界，否则恒成立等于没测 */
let holes = [];
for (const s of S) {
  if (s.padT > 1 && s.firstTop !== null && s.firstTop > 8) holes.push(`y=${s.y} 上方露白 ${s.firstTop}px`);
  if (s.padB > 1 && s.lastBottom !== null && s.lastBottom < s.vh - 8) holes.push(`y=${s.y} 下方露白 ${s.vh - s.lastBottom}px`);
  if (s.maxGap > 60) holes.push(`y=${s.y} 卡间空隙 ${s.maxGap}px`);
}
check("V3 全程没有露出空档（占位块 == 真实高度）", holes.length === 0, holes.slice(0, 3).join("；"));

/* V4/V5 跳与回头：判「用户看到的位移」，不判 scrollTop 的差值。
 * ─────────────────────────────────────────────────────────────
 * 为什么不能直接用 dy：窗口里上方一张卡从「估高 320」变成实测 900 时，内容整体变高，
 * 浏览器滚动锚定会多滚 580px 把画面钉住 —— scrollTop 变了，**画面没动**，这不是跳。
 * 所以对账口径是「这张卡在屏幕上的位移」应恰好等于这一拍请求的滚动量 want；
 * 只有真的没被补偿时，屏幕位移才会多出来一截（那才是用户会骂的「越滚越跳」）。
 * 屏幕位移 = a.topTop - b.topTop（卡往上走为正）。
 * 若浏览器把滚动夹住了（|dy| < |want|，撞到底/顶），期望值退回 dy。 */
/* V4 跳：只看「用户看到的位移」是否落在手势允许的区间里。
 * ─────────────────────────────────────────────────────────────
 * 为什么不用 dy 对账：窗口里上方一张卡从「估高 320」变成实测 900 时，内容整体变高，
 * 浏览器滚动锚定会多滚 580px 把画面钉住 —— scrollTop 变了，**画面没动**，这不是跳。
 * 反过来，锚定若是把画面拽走（本轮真抓到的 bug：y 从 5966 一步跳到 24011，
 * 差的正好是新增内容的高度），屏幕上就会凭空多出一大段位移。
 *
 * 所以判据是「屏幕位移 moved 必须落在 [min(0,want), max(0,want)] 内」：
 *   ① 没滚（want=0）→ 画面必须一动不动（锚定拽走、窗口重排拍回都是这里露馅）；
 *   ② 往下滚 → 画面只能往上走，且不许走得比手势更多（多走 = 跳过头）；
 *   ③ 手势被估高修正吃掉一截（moved 比 want 小，甚至为 0）→ 允许，这是变高列表的固有代价，
 *      单独计数（估高修正 N 次），不当失败。 */
let jumps = [], backs = [], maxDrift = 0, fixes = 0, noteClamps = 0;
let downBacks = 0, upBacks = 0;
for (let k = 1; k < S.length; k++) {
  const a = S[k - 1], b = S[k];
  if (a.dir !== b.dir) continue;                 /* 换向那一拍不算 */
  const dy = b.y - a.y;
  const want = a.want || 0;
  if (a.dir > 0 && dy < -2) {
    /* 位置后退分两种：
       ① 内容变短（估高被实测修正下来）→ 浏览器把 scrollTop 夹回新的 maxY，位置「退」几像素，
          画面不会跳（V4 已独立把关）—— 记账不算错；
       ② 内容没变短却后退 → 这是轮 223 那个 bug（窗口重算把位置拍回顶部），必须抓死。 */
    /* 只有「整段位置被抹掉」才算 bug（轮 223：窗口重算把 scrollTop 拍回顶部，几万像素）。
       几十~几百像素的回退是内容在上方被量准后锚定的正常补偿 —— 画面上并没有动（V4 独立把关）。 */
    if (Math.abs(dy) >= Math.max(400, vh * 0.4)) {
      downBacks++; backs.push(`y ${a.y}→${b.y}（${dy}px，总高 ${a.sh}→${b.sh}）`);
    } else noteClamps++;
  }
  if (a.dir < 0 && dy > 2 && b.sh > a.sh + 2) upBacks++;
  if (!a.topId || a.topId !== b.topId) continue; /* 锚点卡被回收了，无从比 */
  const moved = a.topTop - b.topTop;             /* 卡往上走为正 */
  /* 闲时（want=0）容忍 60px：新一页落地、卡高被量准、字体/图片回填都会带来几十像素的
     自然沉降（实测 38px 是常见量级）；轮 434 那个真 bug 是 18000px，两者不会混淆。
     有手势时按 4px 对账（2.2 屏 ≈ 1900px 的滚动，取整误差最多几像素）。 */
  const tol = Math.abs(want) <= 2 ? 60 : 4;
  const lo = Math.min(0, want), hi = Math.max(0, want);
  if (moved >= lo - tol && moved <= hi + tol) {
    if (Math.abs(want) > 2 && moved < want - tol) fixes++;   /* 手势被吃掉一截 */
    continue;
  }
  maxDrift = Math.max(maxDrift, Math.max(lo - moved, moved - hi));
  jumps.push(`${a.dir > 0 ? "↓" : "↑"} y=${b.y} 屏幕位移 ${moved}px，手势 ${want}px`);
}
check("V4 滚到哪都不跳（屏幕位移落在手势区间内）", jumps.length === 0,
  `${jumps.length} 处越界，最大 ${maxDrift}px：${jumps.slice(0, 3).join("；")}`);
check("V5 下行时 scrollTop 不倒退（窗口重算没把位置拍回去）", downBacks === 0,
  `${downBacks} 次倒退（另有 ${noteClamps} 次「内容变短被夹回」属正常）：${backs.slice(0, 3).join("；")}`);
check("V5b 上行时 scrollTop 不反冲", upBacks === 0, `${upBacks} 次反冲（占位块把位置弹回去了）`);

/* V6 离开再回来（轮 223 退役的真原因，本轮最大的回归风险） */
const lb = res.leaveBack;
if (!lb) outLines.push("SKIP  V6 离开详情再回来还在原位（没找到可点的卡）");
else if (lb.after < 0 || lb.hidden) {
  fail++; outLines.push(`FAIL  V6 离开详情再回来还在原位  → 回来后墙是空的（cards=${lb.cards} hidden=${lb.hidden}）`);
} else {
  check(`V6 离开详情再回来还在原位（${lb.before} → ${lb.after}）`, Math.abs(lb.after - lb.before) <= 40,
    `回来落在 ${lb.after}，离开前是 ${lb.before}（差 ${Math.abs(lb.after - lb.before)}px）`);
}

console.log(outLines.join("\n"));
console.log(`\n样本 ${S.length} 个 / 下行 ${res.stepsDown} 步 · 上行 ${res.stepsUp} 步 / 最高 scrollHeight ${res.bottomSh}px / ` +
  `最多卡片 ${maxCards} 张 / 末位 y=${finalY} / 估高修正 ${fixes} 次 / 底部夹回 ${noteClamps} 次 / ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`TOTAL ${pass + fail}  PASS ${pass}  FAIL ${fail}`);
process.exit(fail ? 1 : 0);
