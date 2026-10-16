/* 全站 UI 状态（#13）：主题皮肤 + 语言 —— App 头部与「设置」页共用同一份，
 * 设置页改这里，App 的 ConfigProvider 立即跟着变（同一 ref，无需事件）。 */
import { ref, computed } from "vue";
import { i18n, setLocale, languages } from "../i18n.js";
import { naiveThemeFor } from "../theme.js";
import { THEMES } from "../data/themes.js";
import { darkTheme } from "naive-ui";
import { Capacitor } from "@capacitor/core";
import { getItem, setItem } from "../utils/storage.js";

/* ═══ 双形态检测（App 轨道 D8）═══
 * isApp：跑在 Capacitor 原生壳里（Android/iOS）→ 用 App 导航（底部 Tab）。
 * isMobileNav：窄视口也走 App 导航 —— 手机浏览器访问网页版提前适配同一套布局，
 *   桌面浏览器（≥900px）保持现有顶栏 + SideRails 完全不变。
 * 断点 900px 与 .shell 现有 max-width: 780px + 侧栏空间对齐。 */
export const isApp = Capacitor.isNativePlatform();
const vw = ref(typeof window !== "undefined" ? window.innerWidth : 1280);
if (typeof window !== "undefined") {
  window.addEventListener("resize", () => { vw.value = window.innerWidth; }, { passive: true });
}
export const isMobileNav = computed(() => isApp || vw.value < 900);

/* 轮 108：底部输入条（暖心墙主评论）打开时收起 tabbar——输入条要直接贴键盘（图2 要求）。
 * 不用 z-index 硬盖：条在 route-wrap 内部、受父级堆叠上下文限制，z-index 压不过根级
 * tabbar（轮 103 弹窗被盖是同一陷阱）；聊天页 inChat 隐藏 tabbar 是同款先例。 */
export const tabbarSuppressed = ref(false);

/* ═══ 轮 138 · 桌面左导航展开态（🐾 开关：64 → 212px，与右栏同宽）═══
 * 用户拍板方案 A：爪印只当开关，「回首页」交给展开后的品牌行。
 * 轮 140：**默认展开**（用户要求）——只有用户显式点过收起（存 "0"）才回到收起态；
 * 模块加载同步读 → 首帧即正确形态，不闪一下。仅桌面形态消费。 */
const NAV_KEY = "wp-nav-open";
export const navOpen = ref(getItem(NAV_KEY) !== "0");
export function setNavOpen(v) {
  navOpen.value = !!v;
  setItem(NAV_KEY, navOpen.value ? "1" : "0");
}
export function toggleNav() { setNavOpen(!navOpen.value); }

const THEME_KEY = "wp-theme";
function loadTheme() {
  try { return localStorage.getItem(THEME_KEY) || "cream"; } catch (e) { return "cream"; }
}
export const themeKey = ref(loadTheme());
export const themeDef = computed(() => THEMES.find((x) => x.key === themeKey.value) || THEMES[0]);
export const naiveOverrides = computed(() => naiveThemeFor(themeKey.value));
export const naiveTheme = computed(() => (themeDef.value.dark ? darkTheme : null));
export const themeOptions = computed(() => THEMES.map((x) => ({
  label: (x.dark ? "\u{1F319} " : "\u{1F3A8} ") + (x.name[i18n.locale] || x.name.en),
  key: x.key,
})));
export function applyTheme(key) {
  themeKey.value = key;
  try { localStorage.setItem(THEME_KEY, key); } catch (e) {}
  document.documentElement.dataset.theme = key;
}
/* 首帧即套用主题（Node 侧单测导入本模块时无 document → 跳过，测试只关心纯逻辑） */
if (typeof document !== "undefined") document.documentElement.dataset.theme = themeKey.value;

/* ═══ T7/T9 · 系统返回键拦截栈 ═══
 * 视图可临时接管系统返回键（例：消息 Tab 的「通知」段 → 先退回「私信」段，
 * 再退页面 —— App 惯例：先退内部层级）。App.vue 的 backButton 监听**先问栈**：
 * 从栈顶往下逐级询问，任一层返回 true = 已处理（不再回退路由 / 最小化 App）；
 * 全部返回 false = 放行。后进先出，卸载时弹栈。
 * 拦截器抛异常视为「不处理」（异常不能吞掉用户按的返回键）。 */
const backStack = [];
export function pushBack(fn) { backStack.push(fn); }
export function popBack(fn) {
  const i = backStack.indexOf(fn);
  if (i >= 0) backStack.splice(i, 1);
}
export function runBack() {
  for (let i = backStack.length - 1; i >= 0; i--) {
    try { if (backStack[i]() === true) return true; } catch (e) { /* 忽略：继续往下问 */ }
  }
  return false;
}

export const langOptions = languages.map((l) => ({ label: l.label, key: l.code }));

/* ═══ 轮 232 · 「再点当前页签」信号（回到顶部 + 刷新）═══
 * 主流做法（微信 / 知乎 / 小红书）：已经待在某个页签里时再点它一次 = 回到顶部 + 刷新内容。
 * 本项目的两个导航（手机 TabBar / 桌面 SideNav）过去都够不着这件事：
 *   · TabBar 走 router.push(同路径) → 被 vue-router 忽略 → **点了毫无反应**；
 *   · SideNav 轮 144 做过（推带时间戳的 refresh query），轮 215 又改成「回原位置、不刷新不回顶」，
 *     实现退化成一句空的 preventDefault → 同样什么都没发生（用户实测反馈）。
 * 这里给一个不含 URL 的信号：页签点自己 → retapTab(path)；需要响应的页面 watch 它。
 * 用信号而不是 query，是为了**不污染地址栏、不污染前进后退历史**。 */
export const retapPath = ref("");   /* 最近一次被「再点」的页签路径 */
export const retapSeq = ref(0);     /* 自增序号：同一条路径连点也要能再次触发 */
export function retapTab(path) {
  retapPath.value = String(path || "");
  retapSeq.value++;
}
/* 轮 308 回炉：下载弹窗跨组件开门信号（「我的」页 pill → App.vue 全局 dl-modal）。
 * 复用 retapSeq 同款「自增序号信号」：ProfileView 只发信号，弹窗本体仍归 App.vue，
 * dlUrl/dlQr 全套复用，不复制下载逻辑。App 内永远不发（pill 只在浏览器渲染）。 */
export const dlOpenSeq = ref(0);
export function openDownload() { dlOpenSeq.value++; }
export const currentLang = computed(
  () => (languages.find((l) => l.code === i18n.locale) || languages[0]).label
);
export function onLangPick(code) { setLocale(code); }
