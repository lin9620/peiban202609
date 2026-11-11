/* 轮 322 · 键盘让位：把「输入法压住的高度」写成 CSS 变量 --kb-h，
 * 让「整屏聊天页高度 / 吸底输入条 bottom」用等时长的过渡跟着输入法一起上移。
 *
 * 两条来源（轮 462 拆成 App 壳 / 网页端两支，写的是同一个变量）：
 *   App 壳：Keyboard 插件（window 不缩，插件报输入法真实高度，见下面 initNative）
 *   网页端：visualViewport（布局视口不缩，只有可视视口缩，见 initWeb）
 *
 * 为什么 App 壳非这么做不可（真机实测，见 jiaojie 轮 322）：键盘弹起的瞬间，如果页面靠系统去缩，
 *   布局视口会一步从 843 跳到 539，而输入法还要 ~200ms 才从屏底滑上来 —— 中间那条空区
 *   在布局视口之外，网页层画不到（红块实验证实），所以只能把「让位」搬到自己手里：
 *     · AndroidManifest 已经是 adjustNothing（窗口不缩）；
 *     · SystemBars 插件已改成 insetsHandling="disable"，MainActivity 只给系统栏让位、
 *       不把输入法高度算进 padding（否则 WebView 布局视口又被压）。
 *
 * 时机（插件 8.0.6 Android 侧 Keyboard.java onStart）：keyboardWillShow 在输入法动画
 *   **开始**时触发，且带的是**最终高度**（imeHeight / density ≈ CSS px）→ CSS 过渡与
 *   输入法同起点同终点，全程不留缝。
 *
 * 为什么网页端也要自己让（轮 462 用户两张截图）：index.html 的视口策略是
 *   interactive-widget=resizes-visual —— 键盘弹起时**布局视口不动**，100dvh 不变，
 *   position:fixed 的底条仍钉在布局视口底部（= 键盘底下）；iOS Safari 还会把整个可视
 *   视口上推，聊天页那层固定高度因此被顶上去、底下露一条空白。算式与各浏览器分支见
 *   keyboardMath.js 的 kbWebInset。
 *
 * 兜底原则：任何异常一律往「--kb-h 归零」走。宁可让输入栏贴底被键盘盖住一瞬，
 *   也绝不能留一条永久空白（那正是用户报的问题）。
 */
import { Capacitor } from "@capacitor/core";
import { Keyboard } from "@capacitor/keyboard";
import { kbPageInset, kbWebInset, kbShrinkInset, kbPanelFallback, kbScreenH } from "./keyboardMath.js";
import { kbInsetValue } from "./chatHeight.js";

const VAR = "--kb-h";
const SYS_BOTTOM_VAR = "--sys-bottom";
/* 轮 498：表情面板的「兜底高度 / 上限」也由 JS 用 px 写，别让 CSS 的 vh 算。
 * 起因（用户第四次报同一件事）：有的内核会把 vh 算成「键盘剩下那点高度」，
 * 46vh 于是只有一百多像素 —— 面板矮成一条，输入条从上面掉下来，看着就是
 * 「表情和文字输入高度不一致」。改成由 JS 按**页面坐标系**算成 px 写进来（轮 499）。
 * CSS 侧写法：--kb-panel-h: min(var(--kb-last, var(--kb-fallback, min(46vh,320px))), var(--kb-cap, 62vh)) */
const FALLBACK_VAR = "--kb-fallback";
const CAP_VAR = "--kb-cap";
/* 轮 503：本会话见过的最大键盘本体高度。--kb-last 只增不减，面板高度才不会
   随地址栏伸缩来回变（用户：「随便点几下就出现这么多问题」里那几种高度）。 */
let panelMax = 0;
/* 轮 503：表情面板是否开着。面板一开，页面必须回到整屏（否则面板铺不满、输入条
   被顶到半空）。以前是 DmVacChat 直接写 --kb-h=0，绕过下面「值没变就不重写」的判据，
   结果下一次同样的键盘高度被当成「没变化」吞掉 —— 页面不缩，输入条钻到键盘底下。 */
let panelOpen = false;
/* 网页端打这个类，style.css 里三条 .kb-web 规则才生效（与 cap-app 三条一一对应）。
   默认 --kb-h: 0px ⇒ 老内核 / 读不到可视视口时表现与改之前完全一致。 */
const WEB_CLASS = "kb-web";

/* 轮 324（用户：「太宽了」）—— 键盘高度要扣掉「WebView 底部让给系统栏的那一条」。
 *   Keyboard 插件的 keyboardHeight 是从**窗口底**量的（Keyboard.java：
 *     int imeHeight = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom;
 *     Math.round(imeHeight / density)），不是从 WebView 底量的。
 *   轮 322 的旧布局里 MainActivity 给 decorView 加了 padding-bottom = 导航栏高度 →
 *   WebView 的底比窗口底高出一条导航栏，所以要扣；不扣输入栏会悬在键盘上沿上面
 *   ≈42 CSS px（真机实测，用户红框那条「太宽」）。
 *   轮 347 改成真·全屏（edge-to-edge）后 WebView 底 = 窗口底，MainActivity 把
 *   --sys-bottom 固定写成 0 → 这里的减法自然变成 no-op；保留它是为了老 APK
 *   （仍带导航栏 padding）升级网页层时不至于把输入栏顶到键盘上沿上方。
 *   读不到就按 0 处理（老 APK / 网页端），行为退回轮 322 的样子，不会更糟。
 *   算式在 keyboardMath.js（纯函数，Node 里直接测过各机型组合，见 tools/kb-math-test.mjs）。 */
function sysBottom() {
  try {
    const n = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(SYS_BOTTOM_VAR));
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch (e) { return 0; }
}

function writeVar(px, info, panelPx) {
  try {
    document.documentElement.style.setProperty(VAR, px + "px");
    /* 轮 482：「上一次真实键盘高度」单独记一份，键盘收起（px=0）时**不清零**。
     * 用途：表情面板高度（--kb-panel-h）要跟键盘一致 —— 可面板弹出时键盘必然已经收起，
     * 那时 --kb-h 已经是 0，只能靠这份残留值还原。见 style.css 的 :root。
     * 轮 496：键盘本体高度与「页面让位高度」在网页端不是同一个量（缩布局视口型内核
     * 不需要我们让位，--kb-h 恒为 0，但键盘实际压住了屏底一大截）——面板要跟的是
     * **键盘本体**，所以单独传 panelPx 进来，别再拿 --kb-h 顶替。 */
    const panel = Number(panelPx);
    /* 轮 503：改成**只增不减**（本会话最大值）。旧写法每次都覆写，同一个面板在
     * 「地址栏收起 / 展开」两种状态下高度会差一截 —— 用户四张截图里面板一会儿 5 排、
     * 一会儿 4 排，输入条跟着上下跳，就是这个。真键盘高度是设备常量，见过一次就该定住；
     * 偶尔测大的由 --kb-cap 兜住（min(80%, 380)）。
     * 轮 506：网页端的 --kb-last 交给 utils/viewportVars.js 独家写（它用
     * innerHeight − visualViewport.height，**不扣 offsetTop**）。这里再写一份会互相压低：
     * iOS 上推可视视口时 kbWebInset 算出来是 0，一写就把面板高度打回估计值。
     * App 壳不跑 viewportVars（那边没有可视视口语义），仍由这里写。 */
    if (Capacitor.isNativePlatform()) {
      if (panel > 0) {
        panelMax = Math.max(panelMax, Math.round(panel));
        document.documentElement.style.setProperty("--kb-last", panelMax + "px");
      } else if (px > 0) {
        panelMax = Math.max(panelMax, Math.round(px));
        document.documentElement.style.setProperty("--kb-last", panelMax + "px");
      }
    }
  } catch (e) { /* 极端环境忽略：样式变量设不上也不能抛错 */ }
  /* 现场诊断（只写全局、不改行为）：别的机型若报「还是有缝/被压住」，一句
     JSON.stringify(window.__kbInfo) 就能看清是哪个输入没对，不用连 logcat。 */
  try { window.__kbInfo = info; } catch (e) { /* 忽略 */ }
}

function setInset(px) {
  const raw = Number(px) || 0;
  const sys = raw > 0 ? sysBottom() : 0;
  const vh = (typeof window !== "undefined" && window.innerHeight) || 0;
  const h = kbPageInset(raw, sys, vh);
  /* App 壳里「让位高度」与「键盘本体高度」是同一个量（插件报的就是输入法真实高度），
     第三参显式传同一个值，别让两条口径在将来分叉。 */
  writeVar(h, { src: "native", raw, sysBottom: sys, kbH: h, innerHeight: vh, at: Date.now() }, h);
  /* 轮 499：App 的真键盘高度也记一份比例，网页端/冷启动共用同一个兜底值 */
  if (h > 0) { panelSeen = Math.max(panelSeen, h); savePanel(panelSeen, vh); }
  if (h <= 0) return;
  /* 长页面里的输入框可能被键盘盖住（窗口不再缩 ⇒ 系统不会替我们滚）：
     等让位生效后再把焦点元素滚进可视区。 */
  requestAnimationFrame(() => {
    const el = document.activeElement;
    if (!el || el === document.body || typeof el.scrollIntoView !== "function") return;
    try { el.scrollIntoView({ block: "center" }); } catch (e) { /* 忽略 */ }
  });
}

/* ═══════════════════════════════════════════════════════════════════
 * 网页端（浏览器 / 小米浏览器 / iOS Safari）：用 visualViewport 量键盘
 * ═══════════════════════════════════════════════════════════════════ */
const EDITABLE_TAGS = { INPUT: 1, TEXTAREA: 1, SELECT: 1 };

/* 只在「真的在输入」时才让位。不这么判会有两个误伤：
 *   ① iOS 的地址栏伸缩会改 innerHeight，滚动时会被当成键盘，页面自己抽一下；
 *   ② 桌面浏览器把窗口缩小时同理。
 * 注意必须钻进 shadow DOM：会话输入框在 vue-advanced-chat 的自定义元素里，
 *   document.activeElement 只会停在宿主标签上（tagName = VUE-ADVANCED-CHAT），
 *   直接判 tagName 会永远「没在输入」—— 这条在真机上表现为「聊天页一点动静都没有」。 */
function activeInput() {
  let el = typeof document !== "undefined" ? document.activeElement : null;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

function editableFocused() {
  const el = activeInput();
  if (!el) return false;
  if (el.isContentEditable) return true;
  return !!EDITABLE_TAGS[el.tagName || ""];
}

function readWebKb() {
  const vv = typeof window !== "undefined" && window.visualViewport;
  if (!vv) return 0;                              /* 老内核：不动作，退回浏览器自己平移 */
  if (vv.scale > 1.05) return 0;                  /* 双指放大也会缩可视视口，但这不是键盘 */
  return kbWebInset(window.innerHeight, vv.height, vv.offsetTop);
}

let lastWebKb = -1;
let lastPanelKb = -1;
/* 轮 496：本会话内见过的最大的「可视视口让位高度」。
 * 只在 >0 时更新 —— 它同时是「这台设备/这个浏览器走的是 visualViewport 让位路线」的标记，
 * 表情面板 → 键盘交接要不要先钉住让位，就看它（见 webSwapNeeded）。 */
let webKbSeen = 0;
/* 键盘弹起前的 innerHeight 基线：缩布局视口型内核靠它反推键盘本体高度。
 * 轮 498：只往上记（取见过的最大值）—— 有些内核弹完键盘会把布局视口留在矮的那一档，
 * 旧写法（每次没键盘就覆盖）会把这个矮值记成基线，之后反推出的键盘高度全是错的。 */
let restH = 0;

/* 轮 499/500：面板兜底高度要按**页面坐标系**算（见 keyboardMath.js 的 kbPanelFallback）。
 *
 * 轮 500 改了两处「只对某台机器成立」的假设 —— 用户追问「别的手机呢」：
 *   ① 不再按「键盘占屏高 36%」这一个比例推，改成先夹取键盘**绝对高度** 240~330
 *      （各家输入法都在这个区间，与屏高不成比例：平板 1024 上真键盘只有 310 = 30%，
 *      横屏 393 上却有 210 = 53%）。852 屏算出来仍是 307，用户那台一格没动。
 *   ② 实测值改存**键盘本体绝对高度** { abs, screen }，不再存 (base, panel) 对。
 *      浏览器底部工具栏一收一放 innerHeight 会差 120，旧格式一换坐标系就作废；
 *      存绝对值之后，732 测到的 185 换成 852 也能正确折成 307。
 * 只有屏幕尺寸对得上（±40，挡横竖屏互串）才复用实测值；从没测到过的机器走估计。 */
const PAIR_KEY = "wp-kb-panel-px";
let lastSaved = "";
function screenNow() {
  const win = typeof window !== "undefined" ? window : null;
  if (!win || !win.screen) return 0;
  return kbScreenH(win.screen.height, win.devicePixelRatio);
}
function readStored() {
  try {
    const o = JSON.parse(localStorage.getItem(PAIR_KEY) || "null");
    if (o && o.abs > 0) return { abs: o.abs, screen: o.screen || 0 };
  } catch (e) { /* 隐私模式 / 禁用存储：当没存过 */ }
  return null;                      /* 老格式 { base, panel } 直接丢弃：换坐标系后已不成立 */
}
/* panel = 键盘在**当前页面**里占的高度；base = 当前页面高度。
 * 键盘本体绝对高度 = panel + （屏幕底到页面底那段距离，即浏览器工具栏）。
 * 工具栏只在「屏高 − 页面高 ∈ (0, 200]」时才算；分屏 / 桌面窗口差得更多，
 * 那是窗口不占满屏幕，键盘整个落在窗口里，绝对高度就是 panel 本身。 */
function savePanel(panel, base) {
  if (!(panel > 0) || !(base > 0)) return;
  const s = screenNow();
  const d = s - base;
  const toolbar = s > 0 && d > 0 && d <= 200 ? Math.round(d) : 0;
  const pair = { abs: Math.round(panel + toolbar), screen: Math.round(s) };
  const key = pair.abs + ":" + pair.screen;
  if (key === lastSaved) return;
  lastSaved = key;
  try { localStorage.setItem(PAIR_KEY, JSON.stringify(pair)); } catch (e) { /* 忽略 */ }
}
/* 本会话真测到的最大面板高（键盘动画是分几步走的，取最大才不会把中间帧记成真值） */
let panelSeen = 0;
function panelFallback(base) {
  return kbPanelFallback(base, screenNow(), readStored());
}

let lastFb = -1;
let lastCap = -1;
/* noKb = 当前确实没有键盘在屏上。
 * 有键盘时布局视口可能被键盘缩掉（缩布局视口型内核），innerHeight 不是真实页面高度，
 * 只能用「见过的最大 innerHeight」当基准；**没有键盘时就用当前 innerHeight** ——
 * 否则浏览器底部工具栏一收一放（innerHeight 差 120），基准还停在旧值上，
 * 面板会按更高的页面算，一开就把输入条顶上去一截。 */
function writePanelRuler(noKb) {
  const win = typeof window !== "undefined" ? window : null;
  if (!win) return;
  const inner = win.innerHeight || 0;
  const vis = (win.visualViewport && win.visualViewport.height) || inner;
  const base = noKb && inner > 0 ? inner : (restH > 0 ? restH : inner);
  if (!(base > 0) || !(vis > 0)) return;
  const fb = panelFallback(base);
  /* 上限与 kbPanelFallback 里的 hi 同口径（min 80%, 380）：
     分屏时窗口只有 400 高、键盘却占 305，按 62% 夹会把面板压矮一大截。 */
  const cap = Math.min(Math.round(Math.min(base, vis) * 0.8), 380);
  if (fb === lastFb && cap === lastCap) return;
  lastFb = fb;
  lastCap = cap;
  try {
    const el = document.documentElement;
    el.style.setProperty(FALLBACK_VAR, fb + "px");
    el.style.setProperty(CAP_VAR, cap + "px");
  } catch (e) { /* 极端环境忽略 */ }
}

function applyWeb() {
  const raw = readWebKb();
  /* 焦点判据只能当「加速」，不能当「门槛」—— 轮 463 真机反馈：iOS Safari 上输入法已经
     起来了，--kb-h 还是 0。activeElement 在深层层级（vue-advanced-chat / 自定义元素 /
     部分国产内核的 IME 代理）里不一定停在我们认得的 input 上，一条判死 = 整段失效。
     所以只要可视视口比布局视口矮出 100px 以上，就直接认定是键盘：
       · 地址栏伸缩 → innerHeight 与 vv.height 同增同减，差值为 0，不会误触；
       · 双指放大 → readWebKb 已在 scale > 1.05 时返回 0；
       · 页面被 iOS 上推 → offsetTop 已经计进算式，差值同步变小。 */
  /* 轮 468：焦点那条捷径也必须过「工具栏量级」闸门（80px）。小米浏览器无键盘时
     vv 比 inner 矮 31px（浏览器工具栏），一聚焦输入框，这 31px 就被当成键盘 → 评论条 /
     回复栏整体抬 31px，下方平白多一条空白。而真键盘最低也 ≥ 200px，80 这道闸门
     两边都不误伤。判据抽到 chatHeight.js，与聊天容器高度共用同一份口径。 */
  const focused = editableFocused();
  /* 轮 503：面板开着就必须整屏 —— 键盘收起动画还没走完的那一两帧里，
     可视视口仍是矮的，不拦住的话页面会先缩一下再弹回整屏（输入条抖一记）。 */
  const h = panelOpen ? 0 : kbInsetValue(raw, focused);
  const inner = (typeof window !== "undefined" && window.innerHeight) || 0;

  /* 轮 496/500：表情面板要跟的是「键盘本体占多高」，它跟「页面需要让多高」不是同一个量。
   * 缩可视视口型内核：让位就是键盘高，两者相等；
   * 缩布局视口型内核：让位恒为 0（浏览器自己缩），键盘高只能从 innerHeight 缩掉的量反推。
   * 不补这一段，--kb-last 在后者上永远拿不到值，面板就退回 46vh/320px 的死值 ——
   * 用户看到的「表情跟文字输入高度不一致」。
   * 轮 500：反推必须要求「输入框真的有焦点」。地址栏 / 底部工具栏伸缩同样会改
   * innerHeight，没有焦点时把那 120px 当成键盘，还会被 savePanel 存进 localStorage，
   * 之后面板永远矮一截（探针里改一次 iframe 高度就复现）。 */
  let panelH = h;
  if (!(panelH > 0)) panelH = focused ? kbShrinkInset(restH, inner) : 0;

  /* 轮 498/500：可视高度变了（键盘起落 / 地址栏伸缩 / 旋屏）就重算面板尺子，
     面板高度才不会被一个「已经不成立」的视口尺寸钉死。内部有变化判据，不会每帧写样式。
     第二参告诉它「现在没有键盘」——有键盘时页面高度不可信，得退回历史最大值。 */
  writePanelRuler(!(panelH > 0));
  /* 轮 499：真测到就记比例，下次冷启动（面板先于键盘打开）也能用真值。
     取本会话最大值 —— 键盘起落动画是分几步走的，中间帧不是真高度。 */
  if (panelH > 0) {
    panelSeen = Math.max(panelSeen, panelH);
    savePanel(panelSeen, restH > 0 ? restH : inner);
  }
  if (h > 0) webKbSeen = Math.max(webKbSeen, h);
  /* 基线只在「确实没有键盘」时往上记：不然键盘弹起后的 innerHeight 会被记成基线，
   * 下一次就再也算不出差值；而弹完键盘布局视口没复原的机型，矮值也不能盖掉真基线
   * （旧写法每次覆盖 → 面板高度从头就错，用户看到的「矮成一条」）。 */
  if (!(panelH > 0) && !focused && inner > 0 && inner > restH) {
    restH = inner;
    writePanelRuler(true);
  }

  /* iOS 为了让光标可见会把**整个文档**往上滚（window.scrollY > 0）。整屏聊天页本来
     就没有文档级滚动，这一滚会在页尾露出一条「视口之外」的空白（用户截图①那块）。
     只在整屏聊天壳里归零 —— 别的页面（首页搜索框等）本来就靠文档滚动把输入框带进可视区，
     在那里强行归零会把光标送回键盘底下。每帧都判：Safari 会在键盘动画期间反复滚。 */
  if (h > 0 && document.querySelector(".shell--chat, .dm-page--chat")) {
    try {
      const se = document.scrollingElement || document.documentElement;
      if (se && se.scrollTop > 0) se.scrollTop = 0;
    } catch (e) { /* 忽略 */ }
  }
  if (h === lastWebKb && panelH === lastPanelKb) return;   /* 逐帧采样时别反复写样式（会触发重排） */
  lastWebKb = h;
  lastPanelKb = panelH;
  const vv = window.visualViewport || {};
  writeVar(h, {
    src: "web", kbH: h, panelH, innerHeight: inner, restH,
    vvHeight: vv.height, vvTop: vv.offsetTop, scale: vv.scale, at: Date.now(),
  }, panelH);
}

/* 轮 496：表情面板「收起 → 键盘接上」这段空档，底条要不要先钉在面板高度上。
 * 只有走 visualViewport 让位路线的设备会掉（--kb-h 归零 ⇒ fixed 底条落回屏底，
 * 键盘几百毫秒后才把它顶回来）；缩布局视口型内核本来就跟着视口走，钉住反而悬空。
 * 判据 = 本会话见过 --kb-h > 0。 */
export function webSwapNeeded() {
  return !Capacitor.isNativePlatform() && webKbSeen > 0;
}

/* 轮 503 · 表情面板开关的唯一入口（见 DmVacChat 的 setEmojiOpen）。
 * 面板开着时不让位（页面整屏铺开，面板才铺得满）；一关立刻按可视视口重算。
 * 关键是 lastWebKb = -1：把「上次写过的值」作废，否则同一高度第二次出现会被
 * 「值没变就不重写」的判据吞掉，--kb-h 停在 0。 */
export function setPanelOpen(open) {
  const v = !!open;
  if (v === panelOpen) return;
  panelOpen = v;
  lastWebKb = -1;
  lastPanelKb = -1;
  if (v) {
    try { document.documentElement.style.setProperty(VAR, "0px"); } catch (e) { /* 忽略 */ }
  }
  /* App 壳：让位由 Keyboard 插件的回调驱动，别拿 WebView 的 visualViewport 去算
     （两套语义不一样，混用会把输入条顶穿，轮 322 踩过）。开面板时归零照旧，
     关面板后等键盘事件回来接管。 */
  if (Capacitor.isNativePlatform()) return;
  applyWeb();
}

let sampleRaf = 0;
/* 输入法弹起后连采 ~0.9s：有些国产内核（实测小米浏览器）在键盘起来时
 * **不派发 visualViewport resize**，只靠事件会整段漏掉；逐帧读两个只读属性很便宜
 * （都命中缓存值，不触发强制同步布局）。 */
function sampleFrames(ms) {
  if (typeof requestAnimationFrame !== "function") return;
  const now = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
  const until = now() + ms;
  cancelAnimationFrame(sampleRaf);
  const tick = () => {
    applyWeb();
    if (now() < until) sampleRaf = requestAnimationFrame(tick);
  };
  sampleRaf = requestAnimationFrame(tick);
}

function initWeb() {
  try { document.documentElement.classList.add(WEB_CLASS); } catch (e) { /* 忽略 */ }
  /* 轮 496：键盘前基线。缩布局视口型内核（innerHeight 直接变小的那批）就是靠
     「基线 − 当前 innerHeight」反推键盘本体高度的，没有基线就永远是 0。
     轮 498：同时把面板兜底高度算成 px 写进 CSS（vh 在部分内核上不可信）。 */
  restH = (typeof window !== "undefined" && window.innerHeight) || 0;
  writePanelRuler(true);
  const vv = window.visualViewport;
  if (vv && typeof vv.addEventListener === "function") {
    vv.addEventListener("resize", applyWeb);
    vv.addEventListener("scroll", applyWeb);       /* iOS 上推可视视口只派发 scroll */
  }
  window.addEventListener("resize", applyWeb);      /* 兼容「缩布局视口」型内核 / 旋屏 */
  window.addEventListener("orientationchange", () => {
    /* 旋屏后视口是真的换了：基线必须重取，否则「基线 − 当前」会算出个假键盘高度 */
    restH = window.innerHeight || 0;
    writePanelRuler(true);
    sampleFrames(600);
  });
  document.addEventListener("focusin", () => sampleFrames(900), true);
  document.addEventListener("focusout", () => { setTimeout(applyWeb, 60); }, true);
  document.addEventListener("visibilitychange", () => {
    /* 切后台可能吞掉收起事件：直接归零，绝不带着一条空白回前台 */
    if (document.hidden) { lastWebKb = -1; applyWeb(); }
  });
  applyWeb();
}

export function initKeyboardInset() {
  if (!Capacitor.isNativePlatform()) { initWeb(); return; }   /* 网页端走可视视口那套 */
  /* 轮 498：App 壳也把面板兜底高度算成 px（与网页端同一把尺子，别一边一个数） */
  restH = (typeof window !== "undefined" && window.innerHeight) || 0;
  writePanelRuler(true);
  try {
    Keyboard.addListener("keyboardWillShow", (i) => setInset(i && i.keyboardHeight));
    Keyboard.addListener("keyboardDidShow", (i) => setInset(i && i.keyboardHeight));
    Keyboard.addListener("keyboardWillHide", () => setInset(0));
    Keyboard.addListener("keyboardDidHide", () => setInset(0));
  } catch (e) {
    setInset(0);
    return;
  }
  /* 切后台时系统可能吞掉某次 hide 事件：一并归零，绝不带着一条空白回到前台 */
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) setInset(0);
  });
}
