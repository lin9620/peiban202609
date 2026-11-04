/* 记录卡长文本折叠 —— 纯判定层（轮 319 · 漂流瓶记录信文/回信两级折叠）
 * ------------------------------------------------------------
 * 设计（用户拍板的方案）：卡内信文与回信各自独立钳 4 行（line-clamp），
 * **真溢出**才显示「展开全文 / 收起」——不猜字数（猜阈值两头不讨好：窄屏 70 字
 * 就溢出、宽屏 120 字还没溢出），渲染后测 scrollHeight > clientHeight 才算数。
 * 本文件只放可 Node 单测的判定；DOM 测量在组件里（bench：收起态 clamp 生效时
 * clientHeight 被钳、scrollHeight 是内容全高 → 直接可比）。
 */

/** ≤40 字在任何常见宽度都不可能超 4 行（40 字 ≈ 2 行）——直接跳过测量，短内容零打扰 */
export const FOLD_MIN_CHARS = 40;

/** 这段文本值不值得进入溢出测量（短内容连测量都省，按钮永不出现） */
export function needsFold(text) {
  return String(text || "").replace(/\s+/g, " ").trim().length > FOLD_MIN_CHARS;
}

/** 折叠状态键：同一行的信文与回信各自独立（一长一短互不拖累） */
export function foldKey(id, field) {
  return `${id}|${field}`;
}

/** 收起态溢出判定：clamp 生效时 clientHeight 是被钳的高度、scrollHeight 是内容全高 */
export function isOverflowing(el) {
  return !!el && el.scrollHeight > el.clientHeight + 2;
}
