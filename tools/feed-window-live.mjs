/* 动态流虚拟窗口 · 真机几何取证（轮 82）
 * 用法：① `npm run dev` ② `msedge --remote-debugging-port=9222`（或任何 Chromium）
 *      ③ `node tools/feed-window-live.mjs`（可选 WP_URL=… 换地址）
 *
 * 为什么必须单独跑这一套：feed-window-test / feed-perf-test 只能证明「纯函数对」和
 * 「组件接上了」——「滚动时白屏 / 串位 / 越滚越慢 / 续载卡死」全是**浏览器几何**问题，
 * 静态断言抓不到。这里在真引擎里灌 300 条长短不一的本地帖（挡掉 supabase，避免云端帖顶掉），
 * 一路下滚量几何：
 *   ① 回收：DOM 卡片数必须与列表长度无关（300 条列表下只该有十几张卡）
 *   ② 无空档：视口内相邻段（占位块/卡片）之间的间距只能等于卡片正常间距，
 *      更大的缝 = 高度表/DOM 串位（用户看到的就是一截白）
 *   ③ 回滚：同一个 y 上内容必须还是那批（位置↔内容映射稳定），回顶必须真的回到 0
 *   ④ 深链上滚：钉窗口跳帖后连续上滚，锚点卡在文档坐标里不该漂
 *   ⑤ 控制台无异常（Vue 警告 / ReferenceError 都算）
 *
 * 环境雷（踩过，别当缺陷）：无头/被遮挡的 Chromium 会**把 rAF 节流到 ~1Hz**，
 * 于是「跳转后的下一帧」要等一整秒 —— 空档/延迟在这类环境下会被放大成假信号。
 * 所以脚本开头先量 rAF 频率，<20fps 就在结论里标注「时序相关信号不可信」。
 */
import WebSocket from "ws";

const PORT = 9222;
const URL = process.env.WP_URL || "http://localhost:5173/community";
const HOSTRE = /(localhost|127\.0\.0\.1):5173/;
const STEPS = 60;              /* 下滚分段数 */
const STEP_PX = 800;
const SEED = 300;              /* 灌多少条本地帖 */
const WINDOW_MAX = 60;         /* DOM 卡片数上限（超出即回收失效） */

/* 相邻段之间超过「正常卡距 + 这个余量」才算真空档（正常卡距本身不是空档） */
const HOLE_SLACK = 20;

const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
/* 必须挑「已经是我们那个 dev 页面」的 target：headless 会多留一个 about:blank，
   连上它去读写 localStorage 会被拒（opaque origin） */
const page = list.find((t) => t.type === "page" && HOSTRE.test(t.url));
if (!page) { console.log("no-page-target", JSON.stringify(list.map((t) => t.url))); process.exit(1); }
console.log("target:", page.url);
const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
let id = 0;
const pending = new Map();
const logs = [];
ws.on("message", (raw) => {
  const m = JSON.parse(raw);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === "Runtime.consoleAPICalled") {
    logs.push(m.params.type + ": " + (m.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 180));
  }
  if (m.method === "Runtime.exceptionThrown") {
    logs.push("EXCEPTION: " + (m.params.exceptionDetails?.exception?.description || "").slice(0, 240));
  }
});
const send = (method, params) => new Promise((res) => { const mid = ++id; pending.set(mid, (m) => res(m.result)); ws.send(JSON.stringify({ id: mid, method, params })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval-error");
  return r.result?.value;
};

await send("Runtime.enable", {});
await send("Page.enable", {});
await send("Network.enable", {});
/* 挡掉云端：dev 下前端直连 Supabase，但 `src/utils/supabase.js` 会把 URL 重写到
   `VITE_API_BASE + "/sb"`（**自有域名反代**，不是 *.supabase.co！）—— 实测真机请求：
   `https://dale.de5.net/sb/rest/v1/wall_posts?select=*&…`。
   只挡 supabase.co 一轮白跑（列表里全是云端「压测 #500」，本地灌的 300 条被 `all`
   的二选一挤掉 → 帖号解析全空、深链找不到目标）。所以这两类都要挡：
   ① 自有域名的 /sb 反代；② 直连 supabase.co（万一哪天不经反代）。
   ⚠ 通配符千万别写成 `*\/api\/*`：它会连**模块路径** `/src/utils/api/db.js` 一起挡掉
   → 整张模块图加载失败 → 应用根本不挂载（页面只剩看门狗的中文兜底）。 */
await send("Network.setBlockedURLs", {
  urls: ["*supabase.co*", "*dale.de5.net/sb/*", "*de5.net/sb/*",
    "http://localhost:5173/api/*", "http://127.0.0.1:5173/api/*"],
});
await send("Page.navigate", { url: URL });
/* 等真文档（不是 about:blank）落地：opaque origin 下 localStorage 会直接抛 SecurityError */
let href = "";
for (let i = 0; i < 25; i++) {
  href = String(await ev("location.href").catch(() => "") || "");
  if (HOSTRE.test(href)) break;
  await sleep(400);
}
console.log("href:", href);
/* 尽量让页面「前台可见」：rAF 被节流时，窗口重算会晚到一整秒（见文件头「环境雷」） */
await send("Page.bringToFront", {}).catch(() => {});
await send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
await sleep(2000);
const raf = await ev(`new Promise((res) => {
  let f = 0; const t0 = performance.now();
  const tick = () => { f++; if (performance.now() - t0 < 500) requestAnimationFrame(tick); else res({ frames: f, fps: Math.round(f * 2) }); };
  requestAnimationFrame(tick);
})`);
console.log("raf:", JSON.stringify(raf), raf.fps < 20 ? "→ rAF 被节流：本轮的时序敏感结论不可全信" : "");

const seeded = await ev(`(() => {
  /* ⚠ 必须清掉 SWR 云端缓存：wall:posts 命中缓存时 all 会取云端那批（哪怕这次拉取被挡），
     本地灌的 300 条根本不进列表 —— 那样量出来的几何全是云端的（第一轮就踩了：
     卡片是「压测 #500」，帖号解析全空）。 */
  const dropped = [];
  for (const k of Object.keys(localStorage)) if (k.includes("wp-cache")) { localStorage.removeItem(k); dropped.push(k); }
  const key = Object.keys(localStorage).find((k) => k.startsWith("warm-paws-posts-v1")) || "warm-paws-posts-v1:guest";
  const now = Date.now(), arr = [];
  for (let i = 0; i < ${SEED}; i++) {
    const long = i % 4 === 0;
    arr.push({ id: "L" + i, ts: now - i * 60000,
      text: "压力测试第 " + (i + 1) + " 条。" + (long
        ? "这条故意写长，用来把卡片高度拉开差距，检验高度表在「同屏卡片高度不一」时会不会串位。再补一句凑高度。还有一句。"
        : "短的。"),
      reacts: { hug: i % 7, warm: i % 5, relate: i % 3 }, views: 20 + i,
      /* dbId 必须给：卡片 id="post-<dbId>" 与深链 focusPost 都按它找（本地帖只有 id 的话
         深链永远找不到目标，这个用例就白测了） */
      dbId: 9000 + i });
  }
  localStorage.setItem(key, JSON.stringify(arr));
  return key + " x" + arr.length + " / 清缓存 " + dropped.length + " 条";
})()`);
console.log("seed:", seeded);
await send("Page.reload", {});
await sleep(3600);
/* 等首屏真的挂上卡片（灌完数据后首帧要走一遍推荐洗牌 + 窗口计算） */
for (let i = 0; i < 20; i++) {
  if (await ev('document.querySelectorAll(".post-card").length') > 3) break;
  await sleep(400);
}
/* 播种校验：列表必须真的是灌进去的那 300 条（否则后面量的是别人的几何——
   第一轮就踩过：SWR 云端缓存命中，卡片全是「压测 #500」）。 */
const check = await ev(`(() => {
  const cards = [...document.querySelectorAll(".post-card")];
  const t = cards.map((el) => el.textContent.replace(/\\s+/g, " "));
  return { cards: cards.length, matched: t.filter((s) => /第 \\d+ 条/.test(s)).length,
    sample: (t[0] || "").slice(0, 50), cacheKeys: Object.keys(localStorage).filter((k) => k.includes("wp-cache")) };
})()`);
console.log("seed-check:", JSON.stringify(check));

/* ── 量几何 ─────────────────────────────────────────────────────────────
   把「上下占位块 + 所有卡片」按 top 排序成一条竖线，相邻两段之间的缝 = 真实布局缝隙；
   正常卡距本身就是那条缝（.card 的 margin-bottom），比它大出一截就是真空档。 */
const GEOM = `(() => {
  const vh = innerHeight;
  const cards = [...document.querySelectorAll(".post-card")];
  const pads = [...document.querySelectorAll(".feed-pad")];
  const segs = [
    ...pads.map((el, i) => ({ kind: i ? "padBottom" : "padTop", r: el.getBoundingClientRect(), n: null })),
    ...cards.map((el) => ({ kind: "card", r: el.getBoundingClientRect(),
      n: Number((el.textContent.match(/第 (\\d+) 条/) || [])[1]) || null })),
  ].sort((a, b) => a.r.top - b.r.top);
  const gaps = [];
  for (let i = 1; i < segs.length; i++) gaps.push(Math.round(segs[i].r.top - segs[i - 1].r.bottom));
  const holes = [];
  for (let i = 1; i < segs.length; i++) {
    const g = segs[i].r.top - segs[i - 1].r.bottom;
    if (g > 60 && segs[i].r.bottom > 0 && segs[i - 1].r.top < vh) {
      holes.push({ at: Math.round(segs[i - 1].r.bottom), gap: Math.round(g),
        from: segs[i - 1].kind, to: segs[i].kind });
    }
  }
  const vis = segs.filter((s) => s.r.bottom > 0 && s.r.top < vh);
  return { y: Math.round(scrollY), vh, docH: document.documentElement.scrollHeight,
    nCards: cards.length,
    padTop: Math.round(pads[0] ? pads[0].getBoundingClientRect().height : 0),
    padBottom: Math.round(pads[1] ? pads[1].getBoundingClientRect().height : 0),
    nums: segs.map((s) => s.n).filter((x) => x),
    visNums: vis.map((s) => s.n).filter((x) => x),
    cvs: cards.length ? getComputedStyle(cards[0]).contentVisibility : "(无卡)",
    cardHs: segs.filter((s) => s.kind === "card").slice(0, 3).map((s) => Math.round(s.r.height)),
    gaps: [...new Set(gaps.filter((g) => g >= -2))].sort((a, b) => a - b).slice(0, 8),
    holes };
})()`;

const jump = async (y, waitMs) => {
  await ev(`window.scrollTo({ top: ${Math.round(y)}, behavior: "instant" })`);
  await sleep(waitMs);
  return ev(GEOM);
};

/* 首屏基线**必须在 y=0 处取**：down[0] 是「已经滚过 800px」后的画面，
   拿它当参考会让 L5 的「回顶内容重合」只剩边界那一张（第一版就是这么假失败的）。 */
const firstScreen = await jump(0, 400);
console.log("firstScreen:", JSON.stringify({ y: firstScreen.y, visNums: firstScreen.visNums }));

/* 下滚：每步 800px；y 与「当时可见的帖子号集合」都记下来，回滚时逐点比对 */
const down = [];
let cardsMax = 0, holeWorst = 0, holesSample = [];
for (let i = 0; i < STEPS; i++) {
  const a = await jump(await ev("window.scrollY") + STEP_PX, 260);
  down.push(a);
  cardsMax = Math.max(cardsMax, a.nCards);
  for (const h of a.holes) { holeWorst = Math.max(holeWorst, h.gap); if (holesSample.length < 3) holesSample.push(h); }
}
const last = down[down.length - 1];

/* 回滚：同样的 y，内容必须还是那批（位置↔内容映射稳定 = 没串位、没白屏）
   ⚠ 但**下滚那一趟正是「估高 → 实测」的转换过程**：同一 y 上的文档高度会缩水
   （本机实测 55214 → 51668），所以「同 y 映到不同内容」在那一段是**应该的**（补偿的目标就是它）。
   判据因此分两桶：docH 相等（两个坐标系一样）→ 必须对上；docH 不同 → 只记录不断言。
   另外「不白屏」这半边必须真断言：视口里一张带帖号的卡都没有 = 用户看到一片空白。 */
let upMismatch = 0, upHoleWorst = 0, upBlank = 0, upValid = 0, upSettled = 0, upSettledBad = 0;
for (let i = down.length - 1; i >= 0; i--) {
  const g = await jump(down[i].y, 260);
  if (Math.abs(g.y - down[i].y) > 4) upMismatch++;
  const a = new Set(down[i].visNums), b = new Set(g.visNums);
  for (const h of g.holes) upHoleWorst = Math.max(upHoleWorst, h.gap);
  /* 视口里一张带帖号的卡都没有 = 这一趟比了个寂寞（帖号解析失效 / 列表不是本地的），
     计数单独记：否则「空集合比空集合」会永远相等 → 这条用例白过（第一轮就这么假过了） */
  if (!b.size) { upBlank++; continue; }
  upValid++;
  const inter = [...b].filter((x) => a.has(x)).length;
  /* 同一 y 上「至少有一半可见帖号重合」才算同一批内容（±1 张卡的边界差异允许） */
  if (g.docH === down[i].docH) {
    upSettled++;                                     /* 高度已定住：两次量的是同一坐标系 */
    if (inter / b.size < 0.5) upSettledBad++;
  } else if (inter / b.size < 0.5) {
    upMismatch++;                                    /* 高度还在变的那一段：应有变化，不断言 */
  }
}

/* ── L4 的真判据：预热后「回到同一个位置，看到的还是同一批内容」 ──────────
   为什么不是「下滚那趟 vs 上滚那趟」：下滚那趟同时在做两件事——reveal 逐批亮出更多条
   （本机实测 docH 15557 → 51668）、沿途把估高换成实测。同一 y 上的内容**本来就该变**，
   拿它当判据等于让测试保证「补偿不该生效」。用户真正在意的是：**列表稳定之后**，
   从别处回到某个位置，看到的是同一批内容（不是换了一批、也不是一片空白）。
   做法：先预热（把 reveal 拉满 + 沿途量热），再 A 趟（低→高）记一遍、B 趟（高→低）记一遍，
   同一 y 两次比对 —— 这也是用户「往下翻再翻回来」的真实路径。 */
const probeStep = Math.max(1, Math.floor(STEPS / 5));
const probeYs = [];
for (let i = 0; i < down.length; i += probeStep) probeYs.push(down[i].y);
for (const y of probeYs) await jump(y, 260);                    /* 预热：沿途量热高度表 */
await jump(await ev("document.documentElement.scrollHeight"), 400);   /* 拉到底：让 reveal 满 */
await jump(0, 400);
const visitA = [];
for (const y of probeYs) visitA.push(await jump(y, 300));
const visitB = [];
for (let i = probeYs.length - 1; i >= 0; i--) visitB[i] = await jump(probeYs[i], 300);
let revisitBad = 0, revisitBlank = 0, revisitDocHBad = 0;
const revisitDetail = [];
probeYs.forEach((y, i) => {
  const a = new Set(visitA[i].visNums), b = new Set(visitB[i].visNums);
  if (!b.size || !a.size) { revisitBlank++; return; }
  const inter = [...b].filter((x) => a.has(x)).length;
  if (visitA[i].docH !== visitB[i].docH) revisitDocHBad++;
  if (inter / b.size < 0.5) {
    revisitBad++;
    revisitDetail.push({ y, docH: [visitA[i].docH, visitB[i].docH],
      a: [...a].slice(0, 6), b: [...b].slice(0, 6), same: inter });
  }
});

/* 回顶：占位块必须归零、首屏内容必须还是最初那批（浏览器自带锚定被交出后才做得到） */
const top = await jump(0, 600);
const firstNums = new Set(firstScreen.visNums);
const topOverlap = top.visNums.filter((x) => firstNums.has(x)).length;

const seenAll = new Set(down.flatMap((d) => d.nums));

/* ── 结论 ────────────────────────────────────────────────────────────── */
const results = [];
const fails = [];
const t = (name, ok, info) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  ← " + info}`);
  if (!ok) fails.push(name + "（" + info + "）");
};
t("L0 量的确实是本地灌的那 300 条（帖子号解析得出来）", down[0].visNums.length > 0 && seenAll.size >= 40,
  `首屏可见帖号 ${JSON.stringify(down[0].visNums)} / 全程见过 ${seenAll.size} 条`);
t("L1 回收生效：300 条列表下 DOM 卡片数始终很小", cardsMax <= WINDOW_MAX,
  `最多 ${cardsMax} 张（上限 ${WINDOW_MAX}）`);
t("L2 占位块撑住了滚动高度（列表没有塌成十几条）", last.docH > SEED * 150,
  `docH=${last.docH}，期望 >${SEED * 150}`);
t("L3 下滚全程视口内无空档（相邻段缝隙只等于卡距）", holeWorst <= (last.gaps[0] || 18) + HOLE_SLACK,
  `最大缝 ${holeWorst}px，卡距 ${JSON.stringify(last.gaps)}`);
t("L4 列表稳定后「回到同一位置内容不变」、全程不白屏", revisitBlank === 0 && revisitBad === 0 && visitA.length >= 4,
  `白屏 ${revisitBlank} 处（须 0）；复访对不上 ${revisitBad}/${visitA.length} 处（须 0）` +
  `；两次 docH 不同 ${revisitDocHBad} 处（高度表仍在长就说明没定住）` +
  (revisitDetail.length ? "；样本 " + JSON.stringify(revisitDetail.slice(0, 2)) : ""));
t("L5 回顶真的回到 0 且占位归零、内容还是首屏那批", top.y === 0 && top.padTop === 0 && topOverlap >= 3,
  `y=${top.y} padTop=${top.padTop} 重合=${topOverlap}/${top.visNums.length}`);
t("L6 窗口确实在跟着滚走（全程见过几十条不同帖子）", seenAll.size >= 40,
  `全程见过 ${seenAll.size} 条`);

console.log(`\n读数：卡片数 均${Math.round(down.reduce((a, d) => a + d.nCards, 0) / down.length)} 峰${cardsMax}` +
  ` · docH ${down[0].docH}→${last.docH}（估高转实测的收缩，正常）` +
  ` · padTop末 ${last.padTop} padBottom末 ${last.padBottom}` +
  ` · 卡距样本 ${JSON.stringify(last.gaps)} · content-visibility ${JSON.stringify(last.cvs)}` +
  ` · 回滚有效比对 ${upValid}/${down.length} 步（空比对 ${upBlank}，已定住段 ${upSettled}）` +
  ` · 上滚最大缝 ${upHoleWorst}px`);
if (holesSample.length) console.log("空档样本:", JSON.stringify(holesSample));

/* 给「取证」用：把关键几步的完整几何打出来（人工核对用） */
console.log("lastGeom:", JSON.stringify(last));
console.log("topGeom:", JSON.stringify(top));

/* ── 深链跳帖（通知点「评论/回应」跳回来）→ 再一路往上滚 ──
   这是「占位块用估高、真卡片用实测」两条链最容易打架的地方：
   深链把窗口钉到第 150 条时，它**上方**那一百多条的占位还是估高（一条 320+gap），
   用户往上滚时这些条目逐条变成真卡片（实测常只有 100~200px）→ 上方总高缩水 →
   下边的内容会被整体顶上去。若此刻补偿又没生效，用户手上就是「往下拉、内容却往上滑」。
   这里量两件事：① 深链能否正确定位到目标帖（DOM 里真有它、且在视口里）
             ② 连续上滚时，锚点卡片在**文档坐标**里漂了多少（漂 = 内容在动 = 用户看得见）。 */
const POST_ID = 9150;                                  /* 播种时给的 dbId = 9000 + i */
await send("Page.navigate", { url: URL + "?post=" + POST_ID });
/* 采样而不是「等 4.2 秒再看一眼」：定位是「reveal 撑到目标 → 钉住窗口 → scrollIntoView(smooth)
   → 窗口重新量高」四拍串起来的，只量末态分不清「从没落进视口」与「落进去又被顶开」。 */
const dlProbe = `(() => {
  const el = document.getElementById("post-${POST_ID}");
  const r = el ? el.getBoundingClientRect() : null;
  const pads = [...document.querySelectorAll(".feed-pad")].map((x) => Math.round(x.getBoundingClientRect().height));
  return { y: Math.round(scrollY), docH: document.documentElement.scrollHeight,
    found: !!el, top: r ? Math.round(r.top) : null, vh: innerHeight,
    cards: document.querySelectorAll(".post-card").length,
    padTop: pads[0] || 0, padBottom: pads[1] || 0 };
})()`;
const dlTrail = [];
for (let i = 0; i < 17; i++) { await sleep(250); dlTrail.push(await ev(dlProbe)); }
const dl = dlTrail[dlTrail.length - 1];
const dlInView = dlTrail.filter((s) => s.found && s.top > -40 && s.top < s.vh - 40).length;
console.log("deep-link trail:", JSON.stringify(dlTrail.map((s) => [s.y, s.top, s.padTop])));
console.log("deep-link:", JSON.stringify(dl), `· 中途曾落进视口 ${dlInView}/${dlTrail.length} 拍`);

/* 连续上滚：每一步 scrollBy(-60)（instant，等价于一次滚轮/拖拽），
   全程 80ms 一次 → 每次都有 scroll 事件（正是「正在滚」的状态）。
   漂移 = 卡片在文档坐标（rect.top + scrollY）上的变化量。 */
const driftProbe = `(() => {
  const cards = [...document.querySelectorAll(".post-card")];
  const vis = cards.filter((el) => { const r = el.getBoundingClientRect(); return r.bottom > 40 && r.top < innerHeight - 40; });
  const a = vis[0];
  if (!a) return null;
  return { id: a.id, doc: a.getBoundingClientRect().top + scrollY, y: scrollY };
})()`;
let probe = await ev(driftProbe);
const drifts = [];
for (let i = 0; i < 20 && probe; i++) {
  await ev('window.scrollBy({ top: -60, left: 0, behavior: "instant" })');
  await sleep(80);
  const now = await ev(driftProbe);
  if (!now) break;
  if (now.id === probe.id) drifts.push({ step: i, drift: Math.round(now.doc - probe.doc) });
  else probe = now;                     /* 锚点卡被回收了 → 换一张重新起算（不把回收算成漂移） */
}
const worstDrift = drifts.reduce((a, d) => (Math.abs(d.drift) > Math.abs(a) ? d.drift : a), 0);
console.log("up-scroll drift:", JSON.stringify(drifts), "worst:", worstDrift);

/* L7 深链定位：目标帖必须在 DOM 里而且真的进了视口（钉窗口那条路要能把元素造出来） */
t("L7 深链跳帖能定位到目标帖（通知点「评论」跳回来不会落空）",
  dl.found && dl.top > -40 && dl.top < dl.vh - 40,
  dl.found ? `目标 top=${dl.top}（视口 ${dl.vh}），没落在视口里` : `DOM 里没有 post-${POST_ID}（窗口没为它让位）`);
/* L8 上滚漂移：锚点卡片在文档坐标上不该动（动 = 上方占位查表比真实矮/高，内容被顶着走） */
t("L8 上滚不漂（占位估高与实测的差被补偿掉，看不到内容自己滑）", Math.abs(worstDrift) <= 40,
  `漂移 ${worstDrift}px（>40）→ 会看到「往下拉、内容往上滑」；样本 ${JSON.stringify(drifts)}`);
/* L9 控制台：Vue 警告与异常都算（含 ReferenceError —— 缺声明那类事故就在这儿现形）。
   放在最后：三个阶段（下滚 / 回滚 / 深链+上滚）的异常都要收进来。
   例外：本轮**故意**把云端接口挡掉了（不挡的话云端帖会顶掉本地 300 条，量的就不是长列表了），
   所以「[cloud] fetchPosts」这种「请求失败」警告是本环境自己造的，不算缺陷；
   其余（Vue 警告 / ReferenceError / TypeError）一条都不放过。 */
const badLogs = logs.filter((l) => /error|EXCEPTION|warn|Warn/i.test(l) && !/\[cloud\] fetchPosts/.test(l));
t("L9 三个阶段全程控制台无异常、无 Vue 警告", badLogs.length === 0,
  `${badLogs.length} 条：${JSON.stringify(badLogs.slice(0, 3))}`);

const pass = results.filter(Boolean).length;
console.log(`\nTOTAL ${results.length}  PASS ${pass}  FAIL ${results.length - pass}`);
for (const f of fails) console.log("FAIL  " + f);
if (raf.fps < 20) console.log("NOTE  rAF 被节流（fps=" + raf.fps + "）：空档/漂移类信号可能被放大，需前台复跑");
process.exit(fails.length ? 1 : 0);
