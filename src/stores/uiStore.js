/* 全站 UI 状态（#13）：主题皮肤 + 语言 —— App 头部与「设置」页共用同一份，
 * 设置页改这里，App 的 ConfigProvider 立即跟着变（同一 ref，无需事件）。 */
import { ref, computed } from "vue";
import { i18n, setLocale, languages } from "../i18n.js";
import { naiveThemeFor } from "../theme.js";
import { THEMES } from "../data/themes.js";
import { darkTheme } from "naive-ui";

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
document.documentElement.dataset.theme = themeKey.value;

export const langOptions = languages.map((l) => ({ label: l.label, key: l.code }));
export const currentLang = computed(
  () => (languages.find((l) => l.code === i18n.locale) || languages[0]).label
);
export function onLangPick(code) { setLocale(code); }
