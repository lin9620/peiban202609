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
 * 闸门 150px（轮 500 从 120 提到 150）：Chrome/国产浏览器的地址栏 + 底部工具栏
 *   伸缩实测能到 110~130，而真键盘最低也 ≥200。原来卡 120，工具栏正好压进去时
 *   会被当成键盘 —— 探针里一改 iframe 高度就复现了：面板尺子被写成 120 并存进
 *   localStorage，之后再也回不去（用户看到的「面板矮成一条」的另一种成因）。
 * 兜底与 kbWebInset 同口径：非数/非正 → 0，大得离谱 → 夹到 rest − 120。 */
export function kbShrinkInset(restH, innerH) {
  const rest = Number(restH) || 0;
  const now = Number(innerH) || 0;
  if (!(rest > 0) || !(now > 0)) return 0;
  let v = Math.round(rest - now);
  if (!(v >= 150)) return 0;
  if (v > rest - 120) v = Math.max(0, Math.round(rest - 120));
  return v;
}

/* 轮 500 · 把 window.screen.height 归一到「与 innerHeight 同一个坐标系（CSS px）」。
 *
 * 为什么要这一步：个别 WebView 会把 screen.height 报成**物理像素**（2340），
 * 拿它去减一个 CSS px 的 innerHeight 会算出负数 → 面板矮成一条。
 * 判据只看屏幕尺寸是否落在一个「像手机/平板的 CSS px 屏高」区间（280~1500）：
 *   · 直接在区间内 → 就是 CSS px，原样用（含横屏 393、平板 1024、老小屏 320）；
 *   · 不在、但除以 devicePixelRatio 后落在区间内 → 是物理像素，折回来；
 *   · 都不在 → 认不出来，当拿不到（0），调用方走比例兜底。
 * 注意这里**不看**它跟 base 的差距：分屏 / 横屏时 screenH 本来就远大于可视区高度，
 * 那是真信息（说明键盘整个落在窗口里），不能因为「差太多」就丢掉。 */
export function kbScreenH(raw, dpr) {
  const s = Number(raw) || 0;
  if (!(s > 0)) return 0;
  if (s >= 280 && s <= 1500) return s;
  const d = Number(dpr) || 0;
  if (d > 1) {
    const v = s / d;
    if (v >= 280 && v <= 1500) return v;
  }
  return 0;
}

/* 轮 499/500 · 表情面板的兜底高度（**页面坐标系**，与面板/底条的锚点同一量纲）
 *
 * 为什么不能按整屏 46% 算（旧写法 min(46vh,320px) 的等价物）：
 *   面板 .wp-composer-picker 是 position:fixed;bottom:0 ⇒ 锚在布局视口底；
 *   键盘是从**屏幕底**往上顶的。浏览器带底部工具栏时，工具栏那一条落在页面之外：
 *   852 的屏 innerHeight 只有 732，真键盘屏幕高 305，落到页面里只剩 185。
 *   按整屏算的 320 比页面里的真值高 130+ ⇒ 面板一开底条被顶上去一大截。
 *
 * 轮 499 先改成 base − screenH × 0.64（= 键盘占屏高 36%），用户机器上准到 2px。
 * 但用户紧接着问「别的手机呢」——这条**比例**假设只在 852 高的屏上成立：
 *   小屏 640（真键盘 250 = 39%）→ 按 36% 算 230，矮 20；
 *   大屏 915（真键盘 300 = 33%）→ 算 329，高 29；
 *   平板 1024（真键盘 310 = 30%）→ 算 369，高 59；
 *   手机横屏 393（真键盘 210 = 53%）→ 算 141，矮 69。
 * 真正稳定的是键盘的**绝对高度**（各家输入法都在 240~330，与屏高不成比例），
 * 所以改成先夹取绝对值再反推：kb = clamp(screenH × 0.36, 240, 330)。
 * 852 屏上算出来仍是 307（用户真机 303），老机器一格没动。
 *
 * 三种参照系分开处理（这是「换台手机就崩」的第二处根源）：
 *   ① 屏高与页面同一参照系（差 ≤200，就是浏览器工具栏）→ 键盘上沿 = 屏高 − kb，
 *      页面内占高 = base − (屏高 − kb)；
 *   ② 差得更多（分屏 / 桌面窗口 / 平板浮窗）：屏幕比页面高一大截，键盘整个落在
 *      窗口里 → 页面内占高就是 kb 本身；
 *   ③ 什么都不知道 → 按可视区 34% 估，夹在 [14%, min(80%, 380)] 内。
 *
 * 真值优先：seen = { abs, screen } 是本机真测过的**键盘本体绝对高度**（含工具栏），
 * 由 keyboardInset.js 在键盘弹起 / 面板打开时反推并持久化。存绝对值而不是存
 * (base, panel) 对，是为了浏览器底部工具栏一收一放（innerHeight 差 120）时仍能复用。
 * 只在屏幕尺寸对得上（±40，挡横竖屏互串）时才用。 */
const KB_ABS_MIN = 240;      /* 键盘本体绝对高度下限：小屏机 / 精简输入法 */
const KB_ABS_MAX = 330;      /* 上限：大屏机 / 带候选栏与工具栏的输入法 */
export function kbPanelFallback(base, screenH, seen) {
  const b = Number(base) || 0;
  if (!(b > 0)) return 0;
  const lo = Math.round(b * 0.14);
  /* 上限按「键盘可能的最大高度」而不是按键盘比例：分屏时窗口只有 400 高、
     键盘却有 305（占 76%），按 45% 夹会把面板压矮 120，输入条当场跳。 */
  const hi = Math.min(Math.round(b * 0.8), 380);
  const s = Number(screenH) || 0;
  /* ① 屏高与页面同一参照系：屏幕底到页面底那段就是浏览器工具栏（≤200） */
  const sameFrame = s > 0 && s >= b * 0.98 && s - b <= 200;

  const abs = Number(seen && seen.abs) || 0;
  if (abs > 0) {
    const ss = Number(seen && seen.screen) || 0;
    if (!(s > 0) || !(ss > 0) || Math.abs(ss - s) <= 40) {
      const p = sameFrame ? Math.round(b - (s - abs)) : Math.round(abs);
      if (p > 0) return Math.min(Math.max(p, lo), hi);
    }
  }

  let kb = 0;
  if (s > 0) kb = Math.min(Math.max(Math.round(s * 0.36), KB_ABS_MIN), KB_ABS_MAX);
  let px = 0;
  if (sameFrame) px = Math.round(b - (s - kb));      /* ① 扣掉工具栏那一段 */
  else if (kb > 0 && b > kb + 80) px = kb;           /* ② 窗口/分屏：键盘整个在窗口里 */
  if (!(px > 0)) px = Math.round(b * 0.34);          /* ③ 什么都不知道 */
  return Math.min(Math.max(px, lo), hi);
}
