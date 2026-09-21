/* 首页三联容器（App 轨道 T6）：联顺序与手势判定（纯函数，Node 单测 tools/home-panes-test.mjs）
 * ------------------------------------------------------------
 * 顺序（轮 19 改）：宠物 → 今日 → 漂流瓶；默认停「今日」（用户反馈：开局是
 * 漂流瓶要等云端、延迟重；今日纯本地秒开。TabBar ＋ 钮「投漂流瓶」跳
 * /?tab=bottle，由 HomeView 消费成初始联，照常直达）。
 * 宠物联禁滑动穿透（画板/零食雨手势优先）——拦截在 HomeView 的 onTouchStart，这里只给判定。
 */
export const HOME_PANES = [
  { k: "pet", tk: "home.panePet" },
  { k: "today", tk: "home.paneToday" },
  { k: "bottle", tk: "home.paneBottle" },
];

export const DEFAULT_PANE = "today";

/** 查询参数 /?tab=xxx → 合法联名；未知 / 缺省一律回默认（今日） */
export function paneFromQuery(q) {
  const k = q == null ? "" : String(q);
  return HOME_PANES.some((p) => p.k === k) ? k : DEFAULT_PANE;
}

/** 联名 → 下标（未知联名回默认联下标） */
export function paneIndex(k) {
  const i = HOME_PANES.findIndex((p) => p.k === k);
  return i < 0 ? paneIndex(DEFAULT_PANE) : i;
}

/** 横滑判定：|dx| 达到阈值且横向占优才算滑；返回 1=左滑(下一联) / -1=右滑(上一联) / 0=无效 */
export function swipeDir(dx, dy, threshold = 48) {
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (ax < threshold || ax <= ay) return 0;
  return dx < 0 ? 1 : -1;
}