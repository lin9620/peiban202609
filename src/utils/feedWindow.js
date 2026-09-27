/* 动态流虚拟窗口（纯函数，Node 单测：tools/feed-window-test.mjs）
 * ------------------------------------------------------------
 * 背景（轮 81/82 用户报「暖心墙滚到几百条就卡」）：
 *   原生列表（Android RecyclerView / iOS UICollectionView）靠「回收复用」做到**节点恒定**
 *   —— 屏幕上永远只有十几个 item 视图，滚出去的立刻回收重置再复用，
 *   所以滚 1 万条和滚 10 条的渲染成本一样。
 *   我们的动态流是 `v-for` + 只增不减的切片：滚到 300 条 = 300 张卡同时挂在文档流里。
 *   轮 81（A 档）先用 content-visibility 让屏外卡片不参与 style/layout/paint；
 *   轮 82（B1）再补上「只挂视口附近的卡片 + 上下占位块撑高度」这一步。
 *
 * 契约（先锁测试再接线，本文件不碰 DOM）：
 *   buildOffsets → 前缀高度表（每条 = 实测高或估值 + 卡片间距 gap），供二分定位
 *   indexAt      → 二分：高度 y 落在第几条；越界夹到两端（绝不返回 -1/NaN）
 *   windowRange  → 由 scrollTop / viewportH 算出 { start, end, padTop, padBottom }
 *                  start 闭、end 开；padTop/padBottom 让窗口外条目仍然占位
 *   nearEnd      → 视口底是否已接近**数据**末尾（触底续载改用算的，不靠哨兵在 DOM 里的位置
 *                  —— 一旦加了底部占位块，哨兵会被推到几万像素以外，永远不触发）
 *   revealTarget → 深链跳帖：把第 index 条包含进「已亮」所需的最小条数（按页取整）
 *
 * 不变量：高度只认「有限正数」，脏值一律回落估值 —— 算错只会让滚动条长度略偏，
 * 绝不能让 NaN/负数污染 offsets（那会让整列塌成 0 高、滚动条乱跳）。
 */

/** 未实测条目的默认估高（px）。必须**等于** .post-card 的 contain-intrinsic-size ——
 *  这就是「卡片还没渲染时浏览器给它的高度」，估高与它不一致时，窗口尾部那十几张未实测卡片
 *  的占位块会整体偏（20px × 15 张 = 300px 的空档），T17/T23 把 CSS ↔ 本常量锁成相等。 */
export const DEFAULT_EST = 320;
/** 视口上下各多挂几条（滚动缓冲；太小会白屏，太大就白挂）。
 * 轮 92：6 → 14 —— 用户真机反馈「下滑连续几屏没有内容」：App 快速甩动一次就能冲出
 * 6 张卡（约 2000px）的渲染区，落进几千像素的空白占位里（真机 CDP 实测底部占位一度
 * 13k px）。14 张 ≈ 上下各 4 屏出头的缓冲，甩动后大概率落在已渲染内容上；
 * DOM 卡片上限仍在 60 断言内（视口 ~9 张 + 上下各 14 ≈ 37 张）。 */
export const DEFAULT_OVERSCAN = 14;
/** 已亮条数超过这个数才启用窗口；以下与旧版渲染逐字节一致（短列表零风险，也可作紧急回退阀） */
export const WINDOW_ON_THRESHOLD = 40;
/** 视口底距数据末尾多近算「快到底」（触发续载；取值与旧哨兵 rootMargin 420px 同量级） */
export const NEAR_END_PX = 600;

/** 帖子 → 稳定字符串 id（云端帖 id 形如 "c7"，本机帖是时间戳数字；统一成字符串当键） */
export function idOf(p) {
  if (p == null) return "";
  const id = typeof p === "object" ? p.id : p;
  return id == null ? "" : String(id);
}

/** 取某条的高度：实测优先，脏值回落估值 */
export function heightOf(heights, id, est = DEFAULT_EST) {
  const n = Number(heights ? heights[id] : undefined);
  if (Number.isFinite(n) && n > 0) return n;
  const e = Number(est);
  return Number.isFinite(e) && e > 0 ? e : DEFAULT_EST;
}

/**
 * 前缀高度表。
 * @param {Array} list 顺序列表
 * @param {Object} heights { id: px } 实测高度
 * @param {Object} [opts] { est 估高, gap 每条之间的间距 }
 * @returns {{ offsets: number[], total: number }} offsets[i] = 前 i 条总高（offsets[0]=0）
 */
export function buildOffsets(list, heights, opts = {}) {
  const est = Number(opts.est) > 0 ? Number(opts.est) : DEFAULT_EST;
  /* gap 必须计入：卡片的间距是 margin-bottom，回收一条就会少 18px，几百条之后就明显串位 */
  const gap = Number(opts.gap) > 0 ? Number(opts.gap) : 0;
  const arr = Array.isArray(list) ? list : [];
  const offsets = new Array(arr.length + 1);
  offsets[0] = 0;
  for (let i = 0; i < arr.length; i++) {
    offsets[i + 1] = offsets[i] + heightOf(heights, idOf(arr[i]), est) + gap;
  }
  return { offsets, total: offsets[arr.length] };
}

/**
 * 二分定位：高度 y 落在第几条。
 * y 小于 0 → 第 0 条；y 超过总高 → 最后一条（夹边界，调用方不必自己判越界）。
 * 空列表返回 0（调用方用 offsets.length-1 判断有没有条目）。
 */
export function indexAt(offsets, y) {
  const n = (Array.isArray(offsets) ? offsets.length : 0) - 1;
  if (n <= 0) return 0;
  const raw = Number(y);
  const target = Number.isFinite(raw) && raw > 0 ? raw : 0;
  if (target >= offsets[n]) return n - 1;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= target) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * 算出该挂哪一段。
 * @param {Object} opts
 *   offsets    buildOffsets 的前缀表
 *   total      buildOffsets 的总高（缺省取 offsets 末值）
 *   scrollTop  已滚过列表顶部的高度（负数按 0）
 *   viewportH  视口高
 *   overscan   上下缓冲条数
 *   pinIndex   深链定位下标（>=0 时窗口钉在它身上，忽略 scrollTop）
 * @returns {{ start:number, end:number, padTop:number, padBottom:number }} end 是开区间
 */
export function windowRange(opts = {}) {
  const offsets = Array.isArray(opts.offsets) && opts.offsets.length ? opts.offsets : [0];
  const n = offsets.length - 1;
  const totalRaw = Number(opts.total);
  const total = Number.isFinite(totalRaw) && totalRaw >= 0 ? totalRaw : (offsets[n] || 0);
  if (n <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };

  const osRaw = Number(opts.overscan);
  const overscan = Number.isFinite(osRaw) && osRaw >= 0 ? Math.floor(osRaw) : DEFAULT_OVERSCAN;

  /* 深链定位：窗口直接钉到目标条附近（否则目标没挂 DOM，scrollIntoView 找不到元素） */
  const pinRaw = Number(opts.pinIndex);
  if (Number.isFinite(pinRaw) && pinRaw >= 0 && pinRaw < n) {
    const pin = Math.floor(pinRaw);
    const s = Math.max(0, pin - overscan);
    const e = Math.min(n, pin + overscan + 1);
    return { start: s, end: e, padTop: offsets[s], padBottom: Math.max(0, total - offsets[e]) };
  }

  const topRaw = Number(opts.scrollTop);
  const top = Number.isFinite(topRaw) && topRaw > 0 ? topRaw : 0;
  const vhRaw = Number(opts.viewportH);
  const vh = Number.isFinite(vhRaw) && vhRaw > 0 ? vhRaw : 0;

  const first = indexAt(offsets, top);
  const last = indexAt(offsets, top + vh);
  const start = Math.max(0, first - overscan);
  const end = Math.min(n, last + overscan + 1);
  return { start, end, padTop: offsets[start], padBottom: Math.max(0, total - offsets[end]) };
}

/** 视口底是否已接近数据末尾（触底续载的判断依据，替代「哨兵在 DOM 里的位置」） */
export function nearEnd(opts = {}) {
  const totalRaw = Number(opts.total);
  const total = Number.isFinite(totalRaw) && totalRaw > 0 ? totalRaw : 0;
  const topRaw = Number(opts.scrollTop);
  const top = Number.isFinite(topRaw) && topRaw > 0 ? topRaw : 0;
  const vhRaw = Number(opts.viewportH);
  const vh = Number.isFinite(vhRaw) && vhRaw > 0 ? vhRaw : 0;
  const thRaw = Number(opts.threshold);
  const th = Number.isFinite(thRaw) && thRaw >= 0 ? thRaw : NEAR_END_PX;
  /* 数据还没铺满一屏（total 很小）也算「到底」——正好和旧哨兵行为一致：进来就能续 */
  if (total <= vh) return true;
  return top + vh >= total - th;
}

/** 深链跳帖：把第 index 条包含进「已亮」所需的最小条数（按页取整，别破坏每页 10 条的节奏） */
export function revealTarget(index, pageSize) {
  const iRaw = Number(index);
  const i = Number.isFinite(iRaw) && iRaw > 0 ? Math.floor(iRaw) : 0;
  const pRaw = Number(pageSize);
  const page = Number.isFinite(pRaw) && pRaw >= 1 ? Math.floor(pRaw) : 1;
  return Math.ceil((i + 1) / page) * page;
}
