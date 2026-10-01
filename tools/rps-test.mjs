/* 轮 131 · 石头剪刀布纯逻辑单测（rpsRules）——rng 注入可复现，无网络无存储 */
import {
  PET_MOVE_WEIGHTS, petMove, judge, coinFor, canPlay, RPS_MOVES, RPS_DAILY_MAX, RPS_WIN_COIN,
} from "../src/utils/rpsRules.js";

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) pass++;
  else { fail++; console.log("FAIL  " + name); }
}

/* ── petMove：合法性 + 权重分布 ── */
ok("T1 出拳必为三选一（4 种性格 × 200 次全合法）",
  ["gentle", "energetic", "cool", "clingy"].every((p) =>
    Array.from({ length: 200 }, () => petMove(p)).every((m) => RPS_MOVES.includes(m))));
ok("T2 未知性格回落均匀分布（合法）",
  Array.from({ length: 60 }, () => petMove("alien")).every((m) => RPS_MOVES.includes(m)));
ok("T3 高冷爱出石头（500 次石头占比 > 45%）",
  (() => {
    const n = 500;
    const rock = Array.from({ length: n }, () => petMove("cool")).filter((m) => m === "rock").length;
    return rock / n > 0.45;
  })());
ok("T4 温柔偏布（500 次布占比高于石头）",
  (() => {
    const n = 600;
    const pick = Array.from({ length: n }, () => petMove("gentle"));
    return pick.filter((m) => m === "paper").length > pick.filter((m) => m === "rock").length;
  })());
ok("T5 权重表各自合计 100", Object.values(PET_MOVE_WEIGHTS).every(
  (w) => w.rock + w.scissors + w.paper === 100));
ok("T6 rng 注入可复现（同种子序列同结果）",
  (() => {
    let s = 42;
    const rand = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
    const a = Array.from({ length: 20 }, () => petMove("cool", rand));
    s = 42;
    const b = Array.from({ length: 20 }, () => petMove("cool", rand));
    return JSON.stringify(a) === JSON.stringify(b);
  })());

/* ── judge：九宫格全判 ── */
ok("T7 三种平局", judge("rock", "rock") === "draw" && judge("paper", "paper") === "draw" && judge("scissors", "scissors") === "draw");
ok("T8 玩家赢三种", judge("rock", "scissors") === "win" && judge("scissors", "paper") === "win" && judge("paper", "rock") === "win");
ok("T9 玩家输三种", judge("scissors", "rock") === "lose" && judge("paper", "scissors") === "lose" && judge("rock", "paper") === "lose");

/* ── coinFor：与「陪它玩」同档经济 ── */
ok("T10 赢 2 / 平 1 / 输 0", coinFor("win") === 2 && coinFor("draw") === 1 && coinFor("lose") === 0);

/* ── canPlay：每日彩头上限 ── */
ok("T11 未达上限可玩", canPlay(0) && canPlay(9));
ok("T12 达上限不可玩", !canPlay(RPS_DAILY_MAX) && !canPlay(RPS_DAILY_MAX + 5));
ok("T13 上限常量为 10", RPS_DAILY_MAX === 10);
ok("T14 三种结果金币封顶（10 局全赢 = 20，与陪它玩 10 次 = 20 同档）",
  RPS_DAILY_MAX * RPS_WIN_COIN === 20);

console.log(`rps-test: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
