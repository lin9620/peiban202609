/* 轮 131 · 石头剪刀布 vs 宠物——纯逻辑（Node 可单测 → tools/rps-test.mjs）
 * 出拳按性格加权（用户定案：高冷爱出石头）；金币口径与「陪它玩」同档（赢 +2）。 */

export const RPS_MOVES = ["rock", "scissors", "paper"];
export const RPS_WIN_COIN = 2;    /* 与 petStore 的陪它玩（fxDoPlay += 2）同档 */
export const RPS_DRAW_COIN = 1;
export const RPS_DAILY_MAX = 10;  /* 每日有彩头的局数上限（防刷金币） */

/* 性格出拳权重（键与 pets.js PERSONALITIES 对齐；和为 100 便于阅读） */
export const PET_MOVE_WEIGHTS = {
  gentle:    { rock: 30, scissors: 30, paper: 40 },  /* 温柔：偏布（手下留情） */
  energetic: { rock: 40, scissors: 40, paper: 20 },  /* 元气：好斗 */
  cool:      { rock: 55, scissors: 25, paper: 20 },  /* 高冷：爱出石头 */
  clingy:    { rock: 25, scissors: 35, paper: 40 },  /* 粘人：随和 */
};

/* 按性格加权出拳（rng 可注入 → 单测可复现） */
export function petMove(personality, rng = Math.random) {
  const w = PET_MOVE_WEIGHTS[personality] || { rock: 33, scissors: 33, paper: 34 };
  const total = w.rock + w.scissors + w.paper;
  let r = rng() * total;
  for (const m of RPS_MOVES) {
    r -= w[m];
    if (r < 0) return m;
  }
  return RPS_MOVES[RPS_MOVES.length - 1];
}

/* 裁定：win = 玩家赢 */
export function judge(player, pet) {
  if (player === pet) return "draw";
  const beats = { rock: "scissors", scissors: "paper", paper: "rock" };
  return beats[player] === pet ? "win" : "lose";
}

export function coinFor(outcome) {
  return outcome === "win" ? RPS_WIN_COIN : outcome === "draw" ? RPS_DRAW_COIN : 0;
}

/* 每日彩头局数上限（playsToday = 当天已玩局数，localStorage 计数） */
export function canPlay(playsToday) {
  return playsToday < RPS_DAILY_MAX;
}
