/* ═══ 轮 219 · 页签滚动记忆（KeepAlive 配套）═══
 * 页签保活后 DOM 原样回来，但 window.scrollY 是全局共享的——切页签时被别的页面改掉。
 * 每页 onActivated 时调 restoreScroll(route.path) 回位（DOM 已在位，零闪零跳）。 */
/* 轮 219 实测：本模块太轻，打包器会把它**内联进多个 chunk**（index 与 CommunityView
 * 各一份）——模块级 Map 就是两个独立实例，App 存的视图读不到（y0=undefined 实锤）。
 * 挂到 window 上做跨 chunk 单例。 */
const mem = (typeof window !== "undefined"
  ? (window.__wpScrollMem = window.__wpScrollMem || new Map())
  : new Map());

export function rememberScroll(path) {
  try { mem.set(path, window.scrollY); } catch (e) { /* 忽略 */ }
}

export function getScroll(path) {
  try { return mem.get(path); } catch (e) { return null; }
}

export function restoreScroll(path) {
  try {
    const y = mem.get(path);
    /* 轮 279：behavior:"instant" 必须显式给——style.css 有全局 html{scroll-behavior:smooth}，
     * 不给的话回位会变成「先在顶部、再慢慢滑下来」的可见动画（用户实测「我的」页返回
     * 自动下拉）。即时回位 = 页面出现即在原位，与暖心墙（滚自己的容器，天然不吃 smooth）一致。 */
    if (y != null) window.scrollTo({ top: y, left: 0, behavior: "instant" });
    return y;
  } catch (e) { return null; }
}
