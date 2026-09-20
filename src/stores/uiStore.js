/* 全站 UI 状态（#13）：主题皮肤 + 语言 —— App 头部与「设置」页共用同一份，
 * 设置页改这里，App 的 ConfigProvider 立即跟着变（同一 ref，无需事件）。 */
import { ref, computed } from "vue";
import { i18n, setLocale, languages } from "../i18n.js";
import { naiveThemeFor } from "../theme.js";
import { THEMES } from "../data/themes.js";
import { darkTheme } from "naive-ui";
import { Capacitor } from "@capacitor/core";

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
export const currentLang = computed(
  () => (languages.find((l) => l.code === i18n.locale) || languages[0]).label
);
export function onLangPick(code) { setLocale(code); }
