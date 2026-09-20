/* 回应写入收敛器单测（Node 直跑，无浏览器/网络）
 *   node tools/react-queue-test.mjs
 * 锁的口径 = 用户反馈「连点两下没反应」的两个真因：
 *   ① 同键写入必须串行（并发「查-插」会撞唯一键 → 界面回滚）
 *   ② 过期响应不许回写状态（慢响应覆盖后来的意图）
 * 另外顺手锁住：前一个任务抛错不卡住后面的、不同 key 互不阻塞、序号单调递增。
 */
import { createWriteQueue } from "../src/utils/reactQueue.js";

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log("PASS ", name); }
  else { fail++; console.log("FAIL ", name); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ─── ① 串行：后一个任务必须等前一个结束才开始 ─── */
{
  const q = createWriteQueue();
  const log = [];
  const t1 = q.push("p1:hug", async () => { log.push("a-start"); await sleep(30); log.push("a-end"); });
  const t2 = q.push("p1:hug", async () => { log.push("b-start"); await sleep(1); log.push("b-end"); });
  await Promise.all([t1, t2]);
  ok("T1 同键写入严格串行（a 结束后才开始 b）",
    log.join(",") === "a-start,a-end,b-start,b-end");
}

/* ─── ② 前一个任务抛错，后面的照常执行（否则界面会「卡死在点了没反应」） ─── */
{
  const q = createWriteQueue();
  let ran = false;
  const t1 = q.push("p1:warm", () => { throw new Error("boom"); });
  const t2 = q.push("p1:warm", () => { ran = true; });
  await Promise.all([t1.catch(() => {}), t2]);
  ok("T2 前一个任务抛错不卡住后续写入", ran === true);
}

/* ─── ③ 不同 key 之间互不阻塞（两个帖子/两种回应可并行） ─── */
{
  const q = createWriteQueue();
  const start = Date.now();
  await Promise.all([
    q.push("p1:hug", async () => { await sleep(40); }),
    q.push("p2:hug", async () => { await sleep(40); }),
  ]);
  ok("T3 不同 key 并行（不互相等待）", Date.now() - start < 75);
}

/* ─── ④ 序号：claim 单调递增；isLatest 只认最后一次 ─── */
{
  const q = createWriteQueue();
  const s1 = q.claim("p1:relate");
  ok("T4 首次序号为 1", s1 === 1);
  const s2 = q.claim("p1:relate");
  ok("T5 每次点击序号递增", s2 === 2 && q.claim("p1:relate") === 3);
  ok("T6 isLatest：旧序号为假、新序号为真",
    q.isLatest("p1:relate", 3) === true && q.isLatest("p1:relate", 2) === false);
  ok("T7 isLatest：不同 key 独立计数",
    q.isLatest("p9:hug", 0) === true && q.isLatest("p1:relate", 0) === false);
}

/* ─── ⑤ 过期响应不回写：连点两下的真实时序 ─── */
{
  const q = createWriteQueue();
  /* 模拟界面状态：counter 就像界面上的「已点」标记 */
  const ui = { on: false };
  const applied = [];
  /** 模拟一次点击：先本地翻，再排队落库（响应慢的第一次会晚于第二次点击返回） */
  function click(delay) {
    const k = "p1:hug";
    const seq = q.claim(k);
    ui.on = !ui.on;                       /* 乐观更新：点完立刻变 */
    q.push(k, async () => {
      const target = ui.on;               /* 落库时以最新意图为准 */
      await sleep(delay);                 /* 服务器往返 */
      if (!q.isLatest(k, seq)) { applied.push("stale-skip"); return; }
      ui.on = target;                     /* 回写权威值 */
      applied.push("apply:" + target);
    });
  }
  click(40);                              /* 第一次：慢 */
  await sleep(5);
  click(1);                               /* 第二次：快 —— 用户就是这么快 */
  await sleep(120);
  ok("T8 连点两下 = 回到未点状态（第二次的意图说了算）", ui.on === false);
  ok("T9 过期响应被丢弃（第二次的回写先于/独立于第一次）",
    applied.includes("stale-skip") && applied.filter((x) => x.startsWith("apply")).length === 1);
}

/* ─── ⑥ 连点三下 = 点上（奇数），且只回写一次权威值 ─── */
{
  const q = createWriteQueue();
  const ui = { on: false };
  let applied = 0;
  function click(delay) {
    const k = "p2:warm";
    const seq = q.claim(k);
    ui.on = !ui.on;
    q.push(k, async () => {
      const target = ui.on;
      await sleep(delay);
      if (!q.isLatest(k, seq)) return;
      ui.on = target;
      applied++;
    });
  }
  click(30); click(2); click(1);
  await sleep(120);
  ok("T10 连点三下 = 点上（奇偶正确）", ui.on === true);
  ok("T11 只由最后一次点击回写权威值", applied === 1);
}

/* ─── ⑦ 单次点击也不受影响（正常路径回归） ─── */
{
  const q = createWriteQueue();
  const ui = { on: false };
  let applied = 0;
  const k = "p3:relate";
  const seq = q.claim(k);
  ui.on = true;
  q.push(k, async () => { await sleep(5); if (!q.isLatest(k, seq)) return; applied++; });
  await sleep(40);
  ok("T12 单次点击照常回写（没有把正常路径也挡掉）", ui.on === true && applied === 1);
}

console.log("");
console.log(`TOTAL ${pass + fail}  PASS ${pass}  FAIL ${fail}`);
process.exit(fail ? 1 : 0);
