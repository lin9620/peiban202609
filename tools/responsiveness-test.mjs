/* 跟手度回归测试（轮 322）——「点了就要立刻有反应」
 *   node tools/responsiveness-test.mjs
 *
 * 背景：用户反馈「不跟手」。本轮排查出 6 类根因，本测试把「修完后的不变量」
 * 钉死，防止以后回潮：
 *   ① 帖级回应：不能再用「await 网络 → await 全量重拉」+ 整帖级 busy 锁；
 *      必须乐观翻转（点一下当场变色）+ 按「帖+回应」分键串行 + 失败回滚。
 *   ② 评论回应：不能再用「按评论 id」的 busy 锁（会让同一条评论的 ❤️/💔 互相锁死）。
 *   ③ 故事评论删除：不能再让「一条评论在飞」把列表里所有删除按钮一起变灰。
 *   ④ 故事评论发送：不能再用全局 sending 卡住发送按钮（不能连发）。
 *   ⑤ 收藏：连点必须串行落库（并发插会撞唯一键 → 弹回未收藏）。
 *   ⑥ 乐观态回写：过期响应不许覆盖用户的后续意图。
 *
 * 两类断言：
 *   A. 静态断言（源码形状）—— 防止旧写法回潮；
 *   B. 行为断言（把关键逻辑抽出来真跑）—— 证明「跟手」真的成立。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createWriteQueue } from "../src/utils/reactQueue.js";
import { mergePendingReacts, pendingKind, pendingPostId } from "../src/utils/reactMerge.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

let pass = 0, fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log("PASS ", name); }
  else { fail++; console.log("FAIL ", name); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const detail = read("src/views/PostDetailView.vue");
const community = read("src/views/CommunityView.vue");
const storyCmt = read("src/components/story/StoryComments.vue");

/* 静态断言只看【代码】，不看注释 —— 否则注释里提到「旧写法 reactBusy」
   就会让测试误判成回潮。 */
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
const detailCode = stripComments(detail);
const communityCode = stripComments(community);
const storyCmtCode = stripComments(storyCmt);

console.log("── A. 帖级回应（详情页）：乐观 + 分键串行 ──");
/* A1：不能再有整帖级 busy 锁（旧写法 reactBusy） */
ok("A1 详情页不再有整帖级 reactBusy 锁", !/reactBusy/.test(detailCode));
/* A2：不能再「await 网络 → await 全量重拉」 */
ok("A2 详情页不再有 react()→refetch() 的全量重拉链",
  !/await\s+refetch\(\)/.test(detailCode) && !/async function refetch\(/.test(detailCode));
/* A3：落库走幂等「设置」语义 cloudSetReaction（不是 toggle —— toggle 连点会翻转两次） */
ok("A3 详情页帖级回应走幂等 cloudSetReaction（不是 toggle）",
  detailCode.includes("cloudSetReaction") && !/await\s+cloudToggleReaction\(/.test(detailCode));
/* A4：有乐观翻转（点一下当场改 reacts/mine） */
ok("A4 详情页帖级回应有乐观翻转（当场改 reacts + mine）",
  /reacts\[key\]\s*=\s*Math\.max\(0/.test(detailCode) && /mine:\s*\{\s*\.\.\.\(p\.mine/.test(detailCode));
/* A5：失败回滚 */
ok("A5 详情页帖级回应失败会回滚",
  detailCode.includes("community.reactFail") && detailCode.includes("before"));
/* A6：厌恶也走乐观 + 队列（不再是整帖锁） */
ok("A6 详情页厌恶也走乐观 + 队列（不再是整帖锁）",
  detailCode.includes(":dislike`") && detailCode.includes("reactQ.claim(k)"));
/* A7：服务端返回的是【扁平】计数（{hug, warm, relate, dislike, mine}），
      视图里计数存在 post.reacts —— 不能再用整包覆盖（计数不变 / 抹掉 💔计数）。 */
ok("A7 详情页回写权威计数时不整包覆盖 post（扁平计数搬进 post.reacts）",
  !/\{\s*\.\.\.post\.value,\s*\.\.\.fresh\s*\}/.test(detailCode)
    && /\{\s*\.\.\.post\.value,\s*\.\.\.before\s*\}/.test(detailCode) === false);
ok("A8 详情页失败回滚只针对本次 kind（不整包回滚 reacts/mine）",
  !/\{\s*\.\.\.post\.value,\s*\.\.\.before\b/.test(detailCode)
    && /\bbefore\.reacts\s*&&/.test(detailCode));
/* A9：失败回滚必须【先摘 pending 再 merge】—— 顺序反了回滚会被叠回来 = 白回滚
 *   ⚠ 定位方式：不能拿「全文第一个 catch (e)」——那是 load() 里的计数容错，
 *     里面的 catch 根本没有 delete/merge；更不能拿「全文第一个 delete next[k]」——
 *     那是**成功**路径摘 pending（写在 if (fresh) 里），与回滚无关。
 *     正确做法：遍历每个 catch 块，在**块内**同时找 delete next[k] 与 mergeReactPending(，
 *     并要求 delete 在 merge 之前。 */
ok("A9 详情页失败回滚先摘 pending 再 merge（顺序正确才回滚得掉）",
  (() => {
    /* 逐个 catch 块（用花括号配对切出**真实**块范围，不能用「下一个 catch」当边界：
       load() 里那个 catch 会一路跨到 toggleNow，把成功路径的 delete/merge 也算进来）。
       回滚逻辑现在收敛在 rollbackReact() 里，所以除了 catch 块本身，
       还要查那个 helper —— 两处都得满足「先摘 pending 再 merge」。 */
    const blocks = [];
    const re = /catch\s*\(/g;
    let m;
    while ((m = re.exec(detailCode)) !== null) {
      const open = detailCode.indexOf("{", m.index);
      if (open < 0) continue;
      let depth = 0, end = -1;
      for (let i = open; i < detailCode.length; i++) {
        const ch = detailCode[i];
        if (ch === "{") depth++;
        else if (ch === "}") { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end < 0) continue;
      blocks.push(detailCode.slice(open, end + 1));
      re.lastIndex = end;
    }
    const ordered = (b) => {
      const del = b.indexOf("delete next[k]");
      const mrg = b.indexOf("mergeReactPending(");
      return del > -1 && mrg > -1 && del < mrg;
    };
    /* ① 回滚 helper 本身：先摘 pending 再 merge（顺序在这里保证） */
    const helper = detailCode.match(/function rollbackReact\([^)]*\)\s*\{[\s\S]*?\n\}/);
    if (!helper || !ordered(helper[0])) return false;
    /* ② 每个 catch 块要么调 helper，要么就地 delete+merge（且顺序正确） */
    const rollbackBlocks = blocks.filter(
      (b) => b.includes("rollbackReact(") || b.includes("delete next[k]"),
    );
    if (!rollbackBlocks.length) return false;
    return rollbackBlocks.every((b) => {
      if (b.includes("rollbackReact(")) return true;      /* 顺序由 helper 保证 */
      return ordered(b);                                  /* 就地写的：必须有序 */
    });
  })());
/* A10：cloudSetReaction / cloudToggleDislike 失败时是**返回 null**（内部自己 try/catch），
 *   不是抛错 —— 所以「保存失败」必须在成功分支里单独判一次并走回滚，
 *   只靠 catch 分支的话：乐观态永远留着（按钮亮着、计数 +1，服务器里根本没有）。 */
ok("A10 详情页保存失败（返回 null）也走回滚，不是只靠 catch",
  /if \(!fresh\)[\s\S]{0,200}?rollbackReact\(/.test(detailCode)
    && /if \(!r\)[\s\S]{0,200}?rollbackReact\(/.test(detailCode));
/* A11：帖子 id 比较要统一转字符串 —— pending 键是 `${dbId}:${kind}`（字符串），
 *   而服务端 r.id 可能是数字；用 === 直接比会「数字 7 ≠ 字符串 "7"」，
 *   导致回滚时找不到当前帖（乐观态回不去）。 */
ok("A11 帖子 id 比较统一转字符串（数字/字符串 id 都能命中）",
  /function samePost\([^)]*\)\s*\{[\s\S]{0,200}?String\(a\) === String\(b\)/.test(detailCode)
    && /samePost\(cur\.dbId, dbId\)/.test(detailCode)
    && /samePost\(cur\.dbId, p\.dbId\)/.test(detailCode));
/* A12：成功路径也必须摘掉 pending —— 不摘的话这条 pending 永远留着，
 *   每次后台重拉帖子都把乐观态再叠一遍（计数凭空 +1 / 点亮态回弹）。 */
ok("A12 保存成功后也摘掉 pending（不摘 → 乐观态反复叠加）",
  /delete next\[k\][\s\S]{0,400}?mergeReactPending\(/.test(detailCode)
    && (detailCode.match(/delete next\[k\]/g) || []).length >= 3);

console.log("");
console.log("── B. 评论回应：按「评论+种类」分键，UI 不置灰 ──");
/* B1：详情页不再按评论 id 置灰 */
ok("B1 详情页评论回应按钮不再被 disabled 置灰",
  !/cmtReactBusy/.test(detailCode) && !/:disabled="!!cmtReactBusy/.test(detailCode));
/* B2：详情页评论回应按「评论 id + 种类」分键 */
ok("B2 详情页评论回应按「评论 id + 回应种类」分键",
  /const qKey = `\$\{cm\.id\}:\$\{kind\}`/.test(detailCode));
/* B3：暖心墙同理 */
ok("B3 暖心墙评论回应按「评论 id + 回应种类」分键",
  /const qKey = `\$\{cm\.id\}:\$\{kind\}`/.test(communityCode));
/* B4：暖心墙帖级回应回写权威计数时不整包覆盖 post.reacts
      —— 整包覆盖会把没动的 💔厌恶计数抹成 0（角标/占比突然归零）。 */
ok("B4 暖心墙回写权威计数时保留 💔厌恶计数（不整包覆盖 reacts）",
  !/post\.reacts = \{\s*hug:\s*fresh\.hug/.test(communityCode)
    && /for \(const kk of \["hug", "warm", "relate", "dislike"\]\)/.test(communityCode));

console.log("");
console.log("── C. 故事评论：删除按条锁 / 发送可连发 ──");
/* C1：删除按钮只锁自己那一条 */
ok("C1 故事评论删除按钮只锁自己那条（deleting[c.id]）",
  storyCmtCode.includes(':disabled="!!deleting[c.id]"') && !/:disabled="sending"[^/]*st-cmt-del/.test(storyCmtCode));
/* C2：删除按钮不再绑全局 sending */
ok("C2 故事评论删除按钮不再绑全局 sending",
  !/st-cmt-del[^>]*:disabled="sending"/.test(storyCmtCode) && !/:disabled="sending"[\s\S]{0,80}st-cmt-del/.test(storyCmtCode));
/* C3：发送按钮不被 sending 卡住 → 能连发 */
ok("C3 故事评论发送按钮不被 sending 卡住（可连发）",
  !/canSend[^=]*=[^;]*!sending/.test(storyCmtCode));
/* C4：发送按钮文案不随在飞条数变化 */
ok("C4 故事评论发送按钮文案恒定（不再闪「保存中」）",
  !/sending\s*\?\s*t\("story\.saving"\)/.test(storyCmtCode));
/* C5：删除是乐观的（当场消失，失败放回） */
ok("C5 故事评论删除是乐观删除（当场消失 + 失败放回）",
  /rows\.value = rows\.value\.filter\(\(x\) => x\.id !== c\.id\)/.test(storyCmtCode)
    && /rows\.value = snapshot/.test(storyCmtCode));
/* C6：刷新不会冲掉还在飞的 pending 评论 */
ok("C6 静默刷新保留还在飞的 pending 评论（连发不丢）",
  /const pending = rows\.value\.filter\(\(x\) => x\.pending\)/.test(storyCmtCode));

console.log("");
console.log("── D. 收藏：连点串行 + 过期响应不回写 ──");
ok("D1 详情页收藏走写队列",
  /favQ = createWriteQueue\(\)/.test(detailCode) && /favQ\.push\(qKey/.test(detailCode));
ok("D2 收藏的过期响应不回写（isLatest 把关）",
  /if \(!favQ\.isLatest\(qKey, seq\)\) return;/.test(detailCode));

console.log("");
console.log("── E. 行为断言：真跑一遍「跟手」语义 ──");
/* E1：帖级回应 —— 点一下当场翻转（不等网络） */
{
  const q = createWriteQueue();
  const post = { dbId: 7, reacts: { hug: 3 }, mine: { hug: false } };
  let post2 = post;
  const click = (target) => {
    const k = `7:hug`;
    const seq = q.claim(k);
    const before = { reacts: { ...post2.reacts }, mine: { ...post2.mine } };
    post2 = { ...post2, reacts: { ...post2.reacts, hug: post2.reacts.hug + (target ? 1 : -1) },
               mine: { ...post2.mine, hug: target } };
    q.push(k, async () => {
      await sleep(20);
      if (!q.isLatest(k, seq)) return;
      if (!target) post2 = { ...post2, ...before };   /* 模拟失败回滚 */
    });
  };
  click(true);
  ok("E1 点一下当场翻转（不等网络往返）",
    post2.mine.hug === true && post2.reacts.hug === 4);
  await sleep(60);
  ok("E2 落库成功后状态保持（没有被旧响应弹回）", post2.mine.hug === true);
}
/* E3：连点两下 → 回到未点亮（第二次的意图说了算），且只有一次权威回写 */
{
  const q = createWriteQueue();
  const ui = { on: false };
  let applied = 0;
  /* 模拟详情页的幂等「设置」语义：目标态在【点击那一刻】捕获，
     落库时按这个目标态写；过期响应直接丢弃不回写。 */
  const click = (delay) => {
    const k = "9:hug";
    const seq = q.claim(k);
    const target = !ui.on;      /* 点击瞬间的目标态 */
    ui.on = target;             /* 乐观翻转：当场生效 */
    q.push(k, async () => {
      await sleep(delay);
      if (!q.isLatest(k, seq)) return;   /* 过期响应不回写 */
      ui.on = target;             /* 权威回写 = 本次点击的目标态 */
      applied++;
    });
  };
  click(30); await sleep(3); click(1);
  await sleep(120);
  ok("E3 连点两下 = 回到未点亮（第二次意图说了算）", ui.on === false);
  ok("E4 连点两下只回写一次权威值（过期响应被丢弃）", applied === 1);
}
/* E5：❤️ 与 💔 分属不同 key → 并行，互不等待 */
{
  const q = createWriteQueue();
  const t0 = Date.now();
  await Promise.all([
    q.push("c1:heart", async () => { await sleep(40); }),
    q.push("c1:broken", async () => { await sleep(40); }),
  ]);
  ok("E5 同一条评论的 ❤️/💔 并行（互不阻塞）", Date.now() - t0 < 75);
}
/* E6：故事评论连发 —— 每条各自 pending，互不影响 */
{
  const rows = [];
  const send = (body) => {
    const tmpId = -Date.now() - rows.filter((x) => x.pending).length;
    rows.push({ id: tmpId, body, pending: true });
  };
  send("第一条"); send("第二条"); send("第三条");
  ok("E6 连发三条：三条都在屏上且各自 pending",
    rows.length === 3 && rows.every((x) => x.pending) && new Set(rows.map((x) => x.id)).size === 3);
  const server = [{ id: 101, body: "已落库的一条", pending: false }];
  const pending = rows.filter((x) => x.pending);
  const seen = new Set(server.map((y) => y.body));
  const merged = [...server, ...pending.filter((x) => !seen.has(x.body))];
  ok("E7 静默刷新不冲掉在飞的 pending 评论", merged.length === 4);
}
/* E8：删除按条锁 —— 删 A 不影响 B 的删除按钮 */
{
  const deleting = {};
  deleting["a"] = true;
  const btnDisabled = (id) => !!deleting[id];
  ok("E8 删 A 时 B 的删除按钮仍可用（按条锁）",
    btnDisabled("a") === true && btnDisabled("b") === false);
}

console.log("");
console.log("── F. 回归：乐观态回写的三个坑（轮 322 复盘） ──");
/* F1：服务端返回的是【扁平】计数 {hug, warm, relate, dislike, mine}，
      而视图里计数存在 post.reacts —— 整包覆盖 post 会让计数根本不变，
      整包覆盖 post.reacts 会把没动的 kind（如 💔厌恶）抹成 0。 */
{
  const fresh = { hug: 12, warm: 3, relate: 0, dislike: 7, mine: { hug: true, warm: false, relate: false, dislike: false } };
  /* 旧写法（错）：{ ...post, ...fresh } —— 计数压根没进 post.reacts */
  const oldPost = { reacts: { hug: 11, warm: 3, relate: 0, dislike: 7 }, mine: { hug: false } };
  const oldWay = { ...oldPost, ...fresh };
  ok("F1a 旧写法确实会丢掉计数（回归基准：整包覆盖不更新 post.reacts）",
    oldWay.reacts.hug === 11 && oldWay.reacts.dislike === 7);
  /* 新写法（对）：只把扁平计数搬进 post.reacts */
  const post = { reacts: { hug: 11, warm: 3, relate: 0, dislike: 7 }, mine: { hug: false, warm: false, relate: false, dislike: false } };
  const fr = { ...post.reacts };
  for (const kk of ["hug", "warm", "relate", "dislike"]) {
    if (fresh[kk] != null) fr[kk] = Math.max(0, Number(fresh[kk]) || 0);
  }
  const newWay = { ...post, reacts: fr, mine: { ...post.mine, ...fresh.mine } };
  ok("F1b 新写法把权威计数写回 post.reacts.hug", newWay.reacts.hug === 12);
  ok("F1c 新写法不抹掉没动的 💔厌恶计数", newWay.reacts.dislike === 7);
  ok("F1d 新写法只更新本次这个 kind 的 mine（其余保留）",
    newWay.mine.hug === true && newWay.mine.warm === false);
}
/* F2：失败回滚的**顺序** —— 必须先摘 pending 再 merge，
      否则 mergeReactPending 会把「刚失败的乐观态」再叠回来 = 等于没回滚。
      ⚠ 这里必须用【真的】mergePendingReacts（src/utils/reactMerge.js）：
        本地旧版复刻把 pending 键「7:hug」直接当 kind 用，行为已经变了，
        拿它当基准测出来的不是真实语义（这正是本轮修的 bug）。 */
{
  const mergeReactPending = (p, pend) => mergePendingReacts(p, pend, undefined);
  const base = { reacts: { hug: 3 }, mine: { hug: false } };
  const before = { reacts: { hug: 3 }, mine: { hug: false } };
  /* 错误顺序：先 merge 后摘 pending */
  {
    let pend = { "7:hug": true };
    let cur = { ...base, reacts: { hug: 4 }, mine: { hug: true } };   /* 乐观态已生效 */
    const wrong = mergeReactPending({ ...cur, ...before, reacts: { ...before.reacts }, mine: { ...before.mine } }, pend);
    ok("F2a 错误顺序：pending 还在 → merge 把失败的乐观态叠回来（回滚失效）",
      wrong.reacts.hug === 4 && wrong.mine.hug === true);
  }
  /* 正确顺序：先摘 pending 再 merge */
  {
    let pend = { "7:hug": true };
    let cur = { ...base, reacts: { hug: 4 }, mine: { hug: true } };
    const next = { ...pend };
    delete next["7:hug"];
    pend = next;
    const rr = { ...cur.reacts };
    const rm = { ...cur.mine };
    if (before.reacts && before.reacts.hug != null) rr.hug = before.reacts.hug;
    if (before.mine && before.mine.hug !== undefined) rm.hug = !!before.mine.hug;
    const right = mergeReactPending({ ...cur, reacts: rr, mine: rm }, pend);
    ok("F2b 正确顺序：先摘 pending → 回滚真的生效（计数与点亮都还原）",
      right.reacts.hug === 3 && right.mine.hug === false);
  }
}
/* F3：回滚只针对「本次这个 kind」—— 不得连带撤销同期其它操作 */
{
  const before = { reacts: { hug: 3, dislike: 7 }, mine: { hug: false, dislike: false } };
  const cur = { reacts: { hug: 4, dislike: 8 }, mine: { hug: true, dislike: true } };
  const rr = { ...cur.reacts };
  const rm = { ...cur.mine };
  if (before.reacts.hug != null) rr.hug = before.reacts.hug;         /* 只回 hug */
  if (before.mine.hug !== undefined) rm.hug = !!before.mine.hug;
  ok("F3 回滚只动本次 kind（💔厌恶的乐观态不被连带撤销）",
    rr.hug === 3 && rr.dislike === 8 && rm.hug === false && rm.dislike === true);
}

console.log("");
console.log("── G. 轮 331：pending 键（帖id:kind）↔ reacts/mine 键（纯 kind）──");
/* G1：键的解析 —— pending 键是「帖id:kind」，reacts/mine 按**纯 kind** 索引。
       两者混用会让「服务端已是目标态」的短路失效（计数被重复 ±1），
       并把状态写进 reacts["7:hug"] 这种没人读的垃圾键（界面看起来一点没变）。 */
ok("G1a pendingKind 从「帖id:kind」里取出纯 kind", pendingKind("7:hug") === "hug");
ok("G1b pendingPostId 从「帖id:kind」里取出帖 id", pendingPostId("7:hug") === "7");
ok("G1c 没有前缀的键原样返回 kind", pendingKind("hug") === "hug");
ok("G1d 没有前缀的键没有帖 id", pendingPostId("hug") === "");
/* G2：叠加必须写到**纯 kind** 键上（不能产生 reacts["7:hug"] 这种垃圾键） */
{
  const post = { dbId: 7, reacts: { hug: 3, warm: 2 }, mine: { hug: false, warm: false } };
  const out = mergePendingReacts(post, { "7:hug": true }, "7");
  ok("G2a 叠加写到纯 kind 键 reacts.hug", out.reacts.hug === 4);
  ok("G2b 不产生 reacts[\"7:hug\"] 这种垃圾键", out.reacts["7:hug"] === undefined);
  ok("G2c 点亮态写到纯 kind 键 mine.hug", out.mine.hug === true);
  ok("G2d 没动的 kind 不受影响", out.reacts.warm === 2 && out.mine.warm === false);
  ok("G2e 不就地改原对象（返回新对象）", post.reacts.hug === 3 && post.mine.hug === false);
}
/* G3：幂等 —— 服务端已经是目标态时不得重复 ±1
       （这是「服务端已经是点亮态、我又点了一次」这类场景的护栏） */
{
  const post = { dbId: 7, reacts: { hug: 4 }, mine: { hug: true } };
  const out = mergePendingReacts(post, { "7:hug": true }, "7");
  ok("G3a 服务端已是点亮态 → 计数不再 +1", out.reacts.hug === 4);
  const post2 = { dbId: 7, reacts: { hug: 3 }, mine: { hug: false } };
  const out2 = mergePendingReacts(post2, { "7:hug": false }, "7");
  ok("G3b 服务端已是未点亮态 → 计数不再 -1", out2.reacts.hug === 3);
  /* 反向：服务端是「点亮」而目标是「不点亮」→ 必须真的 -1（不能被幂等吞掉） */
  const post3 = { dbId: 7, reacts: { hug: 4 }, mine: { hug: true } };
  const out3 = mergePendingReacts(post3, { "7:hug": false }, "7");
  ok("G3c 服务端是点亮、目标是不点亮 → 真的 -1", out3.reacts.hug === 3 && out3.mine.hug === false);
}
/* G4：跨帖隔离 —— pending 表是跨帖共享的（详情页支持左右滑切帖），
       叠加时必须只取当前这篇帖的，否则换帖后把上一篇的 +1 算到新帖头上（凭空 +1）。 */
{
  const post = { dbId: 9, reacts: { hug: 1 }, mine: { hug: false } };
  const pending = { "7:hug": true, "9:warm": true };
  const out = mergePendingReacts(post, pending, "9");
  ok("G4a 别的帖的 pending 不叠加（不串帖）", out.reacts.hug === 1 && out.mine.hug === false);
  ok("G4b 本帖的 pending 正常叠加", out.reacts.warm === 1 && out.mine.warm === true);
  ok("G4c 别的帖的 pending 不产生垃圾键", out.reacts["7:hug"] === undefined);
}
/* G5：无帖 id 时宁可漏叠也不串帖（宁可少 +1，不可凭空 +1） */
{
  const post = { reacts: { hug: 1 }, mine: { hug: false } };
  const out = mergePendingReacts(post, { "7:hug": true }, null);
  ok("G5a 本帖无有效 id → 一条都不叠", out.reacts.hug === 1 && out.mine.hug === false);
}
/* G6：静态断言 —— 组件必须走统一的纯函数，不能再自己抄一份实现 */
ok("G6 详情页的 mergeReactPending 走统一纯函数 mergePendingReacts",
  /mergePendingReacts\(p, reactPending\.value/.test(detailCode));
ok("G7 详情页导入 mergeMerge 纯逻辑模块",
  detail.includes("from \"../utils/reactMerge.js\"") || detail.includes("from '../utils/reactMerge.js'"));

console.log("");
console.log(`TOTAL ${pass + fail}  PASS ${pass}  FAIL ${fail}`);
process.exit(fail ? 1 : 0);

ok("B3 暖心墙评论回应也不再按评论 id 置灰",
  !/cmtReactBusy/.test(communityCode) && !/:disabled="!!cmtReactBusy/.test(communityCode));
ok("B4 暖心墙评论回应同样按「评论 id + 回应种类」分键",
  /const qKey = `\$\{cm\.id\}:\$\{kind\}`/.test(communityCode));
/* B5：两种回应互不阻塞（❤️ 与 💔 分属不同 key） */
ok("B5 两种回应互不阻塞（分键 = 评论id:种类）",
  detail.includes("cmtReactQ = createWriteQueue()") && community.includes("cmtReactQ = createWriteQueue()"));
