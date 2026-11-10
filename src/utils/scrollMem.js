/* ═══ 轮 219 · 页签滚动记忆（KeepAlive 配套）═══
 * 页签保活后 DOM 原样回来，但 window.scrollY 是全局共享的——切页签时被别的页面改掉。
 * 每页 onActivated 时调 restoreScroll(route.path) 回位（DOM 已在位，零闪零跳）。 */
/* 轮 219 实测：本模块太轻，打包器会把它**内联进多个 chunk**（index 与 CommunityView
 * 各一份）——模块级 Map 就是两个独立实例，App 存的视图读不到（y0=undefined 实锤）。
 * 挂到 window 上做跨 chunk 单例。 */
const mem = (typeof window !== "undefined"
  ? (window.__wpScrollMem = window.__wpScrollMem || new Map())
  : new Map());

/* ═══ 轮488 · 键统一成「路径」，不带 query / hash ═══
 * 真机取证（无头 Edge，首页故事联，390×844）：
 *   mem 里写进去的是 **"/?tab=story": 698**（App.vue 用 route.fullPath 记），
 *   而回位读的是 **"/"**（各页 onActivated 用 route.path、router.scrollBehavior 也是 to.path）
 *   → 键对不上，读到的是更早那份 "/": 0 → 从故事阅读页返回直接落在顶部。
 * 首页在手机端每个联都会 replace 出一个 ?tab=xxx，"路径"自然是同一页，位置也该按同一页记。
 * 所以写入/读取两头都过一遍 keyOf：不管调用方给 fullPath 还是 path，落到的都是同一个键。 */
function keyOf(p) {
  const s = String(p == null ? "" : p);
  const i = s.search(/[?#]/);
  const k = i >= 0 ? s.slice(0, i) : s;
  return k || "/";
}

export function rememberScroll(path) {
  try { mem.set(keyOf(path), window.scrollY); } catch (e) { /* 忽略 */ }
}

export function getScroll(path) {
  try { const y = mem.get(keyOf(path)); return y == null ? null : y; } catch (e) { return null; }
}

export function restoreScroll(path) {
  try {
    const y = mem.get(keyOf(path));
    /* 轮 279：behavior:"instant" 必须显式给——style.css 有全局 html{scroll-behavior:smooth}，
     * 不给的话回位会变成「先在顶部、再慢慢滑下来」的可见动画（用户实测「我的」页返回
     * 自动下拉）。即时回位 = 页面出现即在原位，与暖心墙（滚自己的容器，天然不吃 smooth）一致。 */
    if (y != null) window.scrollTo({ top: y, left: 0, behavior: "instant" });
    return y == null ? null : y;
  } catch (e) { return null; }
}

/* ═══ 轮495 · 给「不保活、数据异步」的页面回位（/story 这类）═══
 * App.vue 对每条路由都 rememberScroll 了，但只有四个保活页签会 restore —— 原因是别的
 * 页面每次重新挂载、列表是异步拉的，挂载那一瞬文档还没长够，scrollTo 会被钳到当时
 * 的最大值（等于没回）。
 * 这里一直轮询到「文档能滚到记忆位」为止，最多 timeout 毫秒；到期就落到当时能给的最大值。
 * 用户自己一动就由调用方取消（不跟用户抢滚动）。 */
export function restoreWhenTall(path, { timeout = 900, onAbort } = {}) {
  const y = getScroll(path);
  if (y == null || y <= 0) return null;
  const t0 = Date.now();
  let alive = true;
  const stop = () => { alive = false; };
  const tick = () => {
    if (!alive) return;
    let max = 0;
    try { max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight); } catch (e) {}
    if (max >= y - 1 || Date.now() - t0 >= timeout) {
      try { window.scrollTo({ top: Math.min(y, max), left: 0, behavior: "instant" }); } catch (e) {}
      return;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  if (onAbort) onAbort(stop);
  return stop;
}
