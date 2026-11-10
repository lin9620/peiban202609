/* 轮 324/325 · 键盘让位的纯计算（无副作用、无 DOM、可在 Node 里直接跑）。
 *
 * 用户追问「别的型号的机子呢」——这条算式刻意不写任何机型常量：
 *
 *   pageInset（输入法在「WebView 视口内」实际压住的高度）
 *     = imeInset   ← insets.ime 的高度，从**窗口（屏幕）底**往上量（Keyboard 插件报的就是它）
 *     − sysBottom  ← MainActivity 给 decorView 加的 padding-bottom（= WebView 底部让给系统栏的高度）
 *
 * 两个数的参照物是同一个「窗口底」，所以：
 *   · 导航栏多高（0 / 24dp 手势 / 32dp / 48dp 三键 / 65dp 大屏）→ 加减里互相抵消，结果一样；
 *   · 手势导航还是三键导航 → 三键时 imeInset 含导航栏、sysBottom 也含，同样抵消；
 *   · 输入法品牌（搜狗 / 百度 / Gboard / 讯飞 / 系统自带）→ 都只是「窗口里从底往上占多高」，
 *     与导航栏的耦合方式完全相同，与品牌无关。
 * 唯一会变的是「同一块键盘在页面里压住多少」——那正是我们要求的量。
 *
 * 兜底顺序（宁留一点缝，也绝不把输入框压到键盘底下）：
 *   ① 非正数 / NaN / 字符串 → 0（退回「不让位」，与轮 322 一致）；
 *   ② 算出来是负数 → 0；
 *   ③ 大得离谱（> 视口 − 120）→ 夹到视口 − 120，绝不把页面压成一条；
 *   ④ 一律取整（CSS px），避免小数在半像素屏上抖。
 */
export function kbPageInset(rawIme, sysBottom, viewportH) {
  const ime = Number(rawIme) || 0;
  if (!(ime > 0)) return 0;
  const sys = Number(sysBottom) > 0 ? Number(sysBottom) : 0;
  let v = Math.max(0, Math.round(ime - sys));
  const vh = Number(viewportH) || 0;
  if (vh > 0 && v > vh - 120) v = Math.max(0, Math.round(vh - 120));
  return v;
}

/* 轮 462 · 网页端（非 App 壳）的键盘让位高度 —— 用可视视口反推，不依赖任何机型常量。
 *
 *   kb = 布局视口高 − 可视视口高 − 可视视口上移量
 *      = layoutH     − visualH        − visualTop
 *
 * 为什么要这么算（用户两张真机截图：iOS Safari 输入条下多一条空白 / 小米浏览器输入条
 * 被手势条压住）：
 *   ① index.html 的视口声明是 interactive-widget=resizes-visual —— 键盘弹起时
 *      **布局视口不动，只有可视视口缩小**（iOS Safari 与 Chromium 的默认行为）。
 *      于是 100dvh 不变、position:fixed 的底条仍钉在布局视口底部 = 键盘底下；
 *   ② iOS Safari 还会为了露出光标把可视视口整体**上移**（visualViewport.offsetTop），
 *      这段也要算进 kb，否则底条会有一截压进键盘；
 *   ③ 反过来说，如果某个浏览器是「缩布局视口」型（resizes-content / 部分国产内核），
 *      innerHeight 会同步变小，差值自然为 0 → 本函数返回 0，交回浏览器自己缩，
 *      绝不会出现「浏览器缩一次 + 我们再让一次」的双重让位。
 *
 * 兜底与 kbPageInset 同口径：非数/非正 → 0；负数 → 0；大得离谱（> 视口 − 120）→ 夹住；
 * 一律取整（CSS px）。任何异常都退回「不让位」，表现与改之前一致，不会更糟。 */
export function kbWebInset(layoutH, visualH, visualTop) {
  const layout = Number(layoutH) || 0;
  const visual = Number(visualH) || 0;
  if (!(layout > 0) || !(visual > 0)) return 0;
  const top = Number(visualTop) > 0 ? Number(visualTop) : 0;
  let v = Math.max(0, Math.round(layout - visual - top));
  if (v > layout - 120) v = Math.max(0, Math.round(layout - 120));
  return v;
}

/* 轮 496 · 「缩布局视口」型内核的键盘本体高度
 *   kb = 键盘弹起前的 innerHeight − 当前 innerHeight
 *
 * 为什么要单独算（用户：「手机浏览器输入的时候，表情跟文字输入高度不一致」）：
 *   网页端一直用 kbWebInset（布局视口 − 可视视口）当键盘高度，再把它写进 --kb-last
 *   给表情面板当尺子。可这条式子只在「布局视口不动、只缩可视视口」的内核里成立；
 *   另一批内核（部分国产浏览器 / 老 Chromium）弹键盘时**直接把 innerHeight 缩掉**，
 *   于是差值为 0 → --kb-h 恒为 0（不用我们让位，浏览器自己缩，底条确实是对的），
 *   但 --kb-last 也跟着永远写不进去 → 表情面板只能退回 46vh/320px 的死值，
 *   和真键盘差一截。表现就是「表情面板高度跟键盘高度不一致」，输入条跟着跳。
 *
 * 闸门 120px：地址栏伸缩最多 60 上下，键盘最低也 ≥200，两边都不误判。
 * 兜底与 kbWebInset 同口径：非数/非正 → 0，大得离谱 → 夹到 rest − 120。 */
export function kbShrinkInset(restH, innerH) {
  const rest = Number(restH) || 0;
  const now = Number(innerH) || 0;
  if (!(rest > 0) || !(now > 0)) return 0;
  let v = Math.round(rest - now);
  if (!(v >= 120)) return 0;
  if (v > rest - 120) v = Math.max(0, Math.round(rest - 120));
  return v;
}
