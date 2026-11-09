/* ═══ 轮 493 · App 返回键的单一决策表（纯函数，不 import 任何运行时）═══
 *
 * 用户原话：「app端为什么所有的返回都是返回桌面了，而不是前一页或者返回首页呢，
 *            你设计一下正常app的返回逻辑」。
 *
 * 旧口径（轮 T9，见 App.vue 老代码）只有一句话：
 *     if (inChat || !ROOT_VIEWS.includes(route.name)) router.back();
 *     else minimizeApp();
 * 它有两个洞，正好对应用户看到的两个现象：
 *
 *  ① **四个 Tab 根视图按返回 = 直接 minimizeApp**。用户站在暖心墙/消息/我的上按一下，
 *     整个 App 缩到桌面了 —— 而 Android 主流 App（微信、淘宝、小红书）在根页按返回
 *     要么回首页、要么「再按一次退出」，绝不会一按就走。这就是「所有的返回都返回桌面」。
 *
 *  ② **非根视图一律 router.back()**。冷启动深链（通知点进来、分享链接、谷歌登录回跳）
 *     时 WebView 历史里根本没上一页，back() 要么无操作（「点了没反应」），要么把
 *     历史退到底 → 白屏/掉出应用。缺少「退无可退时回我所属的那一页」这一层。
 *
 * 新口径按优先级从上到下，命中即返回（`action` 由调用方执行）：
 *
 *  ① 页面内浮层 —— **不在本表**。调用方先问 uiStore 的 runBack() 拦截栈
 *     （输入条 / ＋弹层 / 消息页段位切换），关掉浮层再谈页面。
 *  ② `meta.backMode === "replace"` 且声明了 backTo —— 替换式返回。故事系专用：
 *     /story/12 一律回 /story 发现页，哪怕上一页是首页今日联（轮 148 实报
 *     「返回跑到了今日或漂流瓶」就是让 back() 抢了先）。
 *  ③ 应用内还有上一页（history.state.back）→ 正常回退。这是用户最常说的「前一页」。
 *  ④ 没有上一页但有 backTo → replace 到父页。深链兜底，绝不留在原地也绝不退出。
 *  ⑤ 在非首页的 Tab 根 → replace 回首页。用户要的「返回首页」。
 *  ⑥ 已经在首页 → 第一次只给提示（「再按一次退出」），窗口内再按才最小化。
 *     minimizeApp 而非 exitApp：任务留在后台，用户切回来还是原样。
 *
 * 为什么不用 `ROOT_VIEWS.includes(route.name)` 判断：名字是"页面身份"，而返回键
 * 真正关心的是"我还能不能往回走 / 我该回到哪个上级"。名字白名单一旦漏掉新页面
 * （/compose、/following、/settings/blocked…）就会掉进 router.back() 的历史黑洞。
 * 现在改成两条正交信息：**历史里有没有上一页** + **路由自己声明的父页**。
 */

/* Tab 根路径（底部四个页签）。注意是 **path** 不是 name —— /messages/:id 的 name 是
 * messages，path 却不在这个集合里，用 path 才不会把聊天页误当成消息页根。 */
export const TAB_ROOTS = ["/", "/community", "/messages", "/profile"];

/* 双击退出窗口（毫秒）。微信/抖音都是 2s 左右，太短用户来不及按第二次。 */
export const EXIT_HINT_WINDOW = 2000;

/* 路径归一：去 query/hash、去 /zh 别名前缀、去尾斜杠。
 * 只用于比较，不用于导航（导航用路由给的原始 to）。 */
export function normPath(p) {
  let s = String(p == null ? "/" : p);
  const q = s.indexOf("?");
  if (q >= 0) s = s.slice(0, q);
  const h = s.indexOf("#");
  if (h >= 0) s = s.slice(0, h);
  if (s === "/zh") s = "/";
  else if (s.indexOf("/zh/") === 0) s = s.slice(3);
  if (s.length > 1 && s.charAt(s.length - 1) === "/") s = s.slice(0, -1);
  return s || "/";
}

/**
 * 决定一次「系统返回键」该干什么。
 *
 * @param {object} o
 * @param {string} o.path      当前路由 path
 * @param {string|null} o.back history.state.back —— vue-router 维护的"应用内上一页"
 * @param {string} o.backTo    当前路由 meta.backTo（父页，可为空）
 * @param {string} o.backMode  当前路由 meta.backMode（"replace" = 忽略 back 一律回父页）
 * @param {string[]} o.tabRoots
 * @param {boolean} o.allowExit 是否允许「退到桌面」。页面内的 ← 按钮传 false，
 *                             系统返回键传 true（否则在首页点 ← 会退出 App）。
 * @param {number} o.now        注入时钟，便于单测
 * @param {number} o.lastHintAt 上一次「再按一次退出」提示的时间戳
 * @param {number} o.hintWindow
 * @returns {{action:"history"|"replace"|"hint"|"minimize"|"none", to?:string, reason:string}}
 */
export function planBack({
  path = "/",
  back = null,
  backTo = "",
  backMode = "history",
  tabRoots = TAB_ROOTS,
  allowExit = true,
  now = 0,
  lastHintAt = 0,
  hintWindow = EXIT_HINT_WINDOW,
} = {}) {
  const cur = normPath(path);
  const parent = backTo ? normPath(backTo) : "";
  const prev = back ? normPath(back) : "";

  /* ② 替换式返回（故事系）：目标就是父页，不看历史。 */
  if (backMode === "replace" && parent && parent !== cur) {
    return { action: "replace", to: parent, reason: "replace-page" };
  }

  /* ③ 应用内还有上一页 —— 用户口中的「前一页」。 */
  if (prev && prev !== cur) {
    return { action: "history", reason: "history" };
  }

  /* ④ 深链兜底：没有上一页，回路由自己声明的父页。 */
  if (parent && parent !== cur) {
    return { action: "replace", to: parent, reason: "parent" };
  }

  /* ⑤ 非首页的 Tab 根 → 回首页（用户要的「返回首页」）。 */
  if (cur !== "/" && tabRoots.indexOf(cur) >= 0) {
    return { action: "replace", to: "/", reason: "tab-root" };
  }

  /* ⑥ 已经在首页：先提示，窗口内再按才走。 */
  if (!allowExit) return { action: "none", reason: "no-exit" };
  if (lastHintAt && now - lastHintAt < hintWindow) {
    return { action: "minimize", reason: "exit" };
  }
  return { action: "hint", reason: "hint" };
}
