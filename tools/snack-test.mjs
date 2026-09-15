/* 零食雨纯逻辑单测：node tools/snack-test.mjs */
import {
  difficulty, spawnItem, advanceY, isCaught, isMissed, finalReward,
  GAME_SECONDS, MAX_MISSED, DISH_VALUE, SNACK_VALUE, SNACK_EMOJIS,
} from "../src/utils/snackGame.js";

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("PASS ", n); } else { fail++; console.log("FAIL ", n); } };
const rngFixed = () => 0.5;   // 固定随机源

/* —— 难度曲线 —— */
ok("T1 生成间隔随时间递减", difficulty(0) > difficulty(20) && difficulty(20) > difficulty(45));
ok("T2 间隔有下限 0.32", difficulty(600) === 0.32 && difficulty(0) === 0.9);

/* —— 生成掉落物 —— */
const it0 = spawnItem(rngFixed, 0, 0, []);
ok("T3 无手绘时只掉兜底零食", it0.kind === "snack" && it0.value === SNACK_VALUE);
ok("T4 emoji 来自兜底清单", SNACK_EMOJIS.includes(it0.emoji));
ok("T5 x 在安全区间内", it0.x >= 0.06 && it0.x <= 0.94);
const itFast = spawnItem(rngFixed, 40, 0, []);
ok("T6 下落速度随时间加快", itFast.vy > it0.vy);
const dishes = [{ id: "d1", img: "data:image/png;base64,xx", name: "小鱼干" }];
const itD = spawnItem(() => 0.1, 5, 1, dishes);
ok("T7 有手绘时可能掉手绘食物", itD.kind === "dish" && itD.value === DISH_VALUE && itD.dishId === "d1");
const ids = new Set(Array.from({ length: 20 }, (_, i) => spawnItem(() => i / 20, 3, 0, []).id));
ok("T8 id 不易重复", ids.size >= 15);

/* —— 帧推进 —— */
ok("T9 y 前进 = vy * dt", advanceY({ y: 0.1, vy: 0.3 }, 0.5) === 0.25);
ok("T10 不修改入参", (() => { const a = { y: 0.1, vy: 0.3 }; advanceY(a, 1); return a.y === 0.1; })());

/* —— 碰撞判定 —— */
ok("T11 到达嘴部高度带且 x 足够近 = 接住", isCaught({ x: 0.5, y: 0.9 }, 0.52, 0.09));
ok("T12 x 超出半宽 = 没接住", !isCaught({ x: 0.7, y: 0.9 }, 0.5, 0.09));
ok("T13 还没落到高度带 = 不算接住", !isCaught({ x: 0.5, y: 0.7 }, 0.5, 0.09));
ok("T14 落过底 = 也不算接住（算漏）", !isCaught({ x: 0.5, y: 1.02 }, 0.5, 0.09));
ok("T15 越过底线 = 漏掉", isMissed({ y: 1.07 }) && !isMissed({ y: 1.0 }));

/* —— 结算 —— */
ok("T16 分数→金币 1:2", finalReward(10).coins === 20);
ok("T17 饱食度有 45 上限", finalReward(50).hunger === 45 && finalReward(10).hunger === 30);
ok("T18 心情有 30 上限", finalReward(50).mood === 30);
ok("T19 非法输入安全", finalReward(-5).coins === 0 && finalReward(undefined).coins === 0 && finalReward(3.9).coins === 6);
ok("T20 常量合理", GAME_SECONDS === 45 && MAX_MISSED === 8);

console.log(`\nTOTAL ${pass + fail}  PASS ${pass}  FAIL ${fail}`);
process.exit(fail ? 1 : 0);
