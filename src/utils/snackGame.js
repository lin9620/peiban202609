/* 零食雨小游戏：纯游戏逻辑（不依赖 Vue / DOM，Node 可单测）
 * ------------------------------------------------------------
 * 坐标系用 0~1 比例（x 相对宽度，y 相对高度），组件层负责换算像素，
 * 这样逻辑与屏幕尺寸无关，单测稳定。
 * 随机数通过参数注入（rng 函数），测试时传固定值即可复现。
 */

export const GAME_SECONDS = 45;   // 一局时长（秒）
export const MAX_MISSED = 8;      // 漏掉多少个结束
export const DISH_VALUE = 2;      // 手绘食物的分数（越用心画的越值钱）
export const SNACK_VALUE = 1;     // 兜底小零食分数

/* 兜底小零食（emoji 源码里用 Unicode 转义，避免编码损坏） */
export const SNACK_EMOJIS = [
  "\u{1F356}", "\u{1F41F}", "\u{1F96F}", "\u{1F36E}",
  "\u{1F36A}", "\u{1F353}", "\u{1F95B}", "\u{1F9C1}",
];

/* 生成间隔（秒）：随时间从 0.9s 渐进压到 0.32s */
export function difficulty(elapsed) {
  return Math.max(0.32, 0.9 - elapsed * 0.013);
}

/**
 * 生成一个掉落物
 * @param {() => number} rng  返回 [0,1)
 * @param {number} elapsed  已进行秒数（决定下落速度）
 * @param {number} dishCount  可用手绘食物数量（0 = 只掉兜底零食）
 * @returns {{ id, x, y, vy, kind, emoji, dishId, img, value }}
 */
export function spawnItem(rng, elapsed, dishCount, dishes = []) {
  const r1 = rng(), r2 = rng();
  const wantDish = dishCount > 0 && r2 < 0.45;
  const vy = 0.26 + elapsed * 0.009 + r1 * 0.05;   // 屏高比例/秒，随时间加快
  const base = {
    id: "i" + Math.floor(rng() * 1e9).toString(36) + Math.floor(elapsed * 1000),
    x: 0.06 + r1 * 0.88,            // 留出边距，避免贴边
    y: -0.06,
    vy,
  };
  if (wantDish) {
    const d = dishes[Math.floor(r2 * 1000) % dishCount] || {};
    return { ...base, kind: "dish", emoji: "", dishId: d.id || "", img: d.img || "", value: DISH_VALUE };
  }
  const e = SNACK_EMOJIS[Math.floor(r2 * 100) % SNACK_EMOJIS.length];
  return { ...base, kind: "snack", emoji: e, dishId: "", img: "", value: SNACK_VALUE };
}

/** 推进一帧：返回新的 y（不修改入参） */
export function advanceY(item, dt) {
  return item.y + item.vy * dt;
}

/**
 * 是否被接住：掉落物进入以宠物为中心的接住带（竖直 ± 带宽），且 x 距离在宠物半宽内。
 * #3 宠物可以全屏移动（x/y 都自由），所以判定从「贴底高度带」改成「宠物自身的 2D 邻域」。
 * @param {{x:number,y:number}} item  掉落物
 * @param {number} petX  宠物 x（0~1）
 * @param {number} petHalfW  宠物半宽（比例）
 * @param {number} [petY=0.86]  宠物 y（0~1；缺省按贴底兼容旧签名）
 */
export function isCaught(item, petX, petHalfW, petY = 0.86) {
  const inBand = item.y >= petY - 0.09 && item.y <= petY + 0.13;
  return inBand && Math.abs(item.x - petX) <= petHalfW;
}

/** 是否已落地漏掉 */
export function isMissed(item) {
  return item.y > 1.06;
}

/** 宠物游戏内可移动的 y 范围（0~1 比例）：顶部留出计分条，底部贴地 */ 
export const PET_Y_MIN = 0.2;
export const PET_Y_MAX = 0.92;
export const PET_Y_SPEED = 0.7;   // 键盘上下移动速度（比例/秒）

/**
 * 结算奖励：分数 → 四维/经验（有上限，防止刷爆）。
 * 金币不在纯函数里发 —— 由 petStore 按 RAIN_REWARD_COINS 固定 2 金币/局、每日 3 次上限发放。
 * @param {number} score 接到的总分数
 */
export function finalReward(score) {
  const s = Math.max(0, Math.floor(score) || 0);
  return {
    hunger: Math.min(45, s * 3),
    mood: Math.min(30, s * 2),
    exp: s * 2,
  };
}
