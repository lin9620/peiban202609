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
