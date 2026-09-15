/* ═══════════ UI 主题套件 ═══════════
   每套主题：CSS 变量（style.css 中按 data-theme 覆盖）+ Naive UI 主色。 */

export const THEMES = [
  {
    key: "cream", dark: false,
    name: { en: "Creamy Orange", zh: "奶油橘" },
    swatch: "#FF9F5A",
    naive: { primary: "#FF9F5A", hover: "#FFB273", pressed: "#F0842F" },
  },
  {
    key: "sakura", dark: false,
    name: { en: "Sakura Pink", zh: "樱花粉" },
    swatch: "#F78FB3",
    naive: { primary: "#F78FB3", hover: "#FBA7C5", pressed: "#E76A9A" },
  },
  {
    key: "mint", dark: false,
    name: { en: "Mint Forest", zh: "薄荷森林" },
    swatch: "#5FBFA5",
    naive: { primary: "#5FBFA5", hover: "#7DD1BA", pressed: "#46A78E" },
  },
  {
    key: "lavender", dark: false,
    name: { en: "Lavender", zh: "薰衣草紫" },
    swatch: "#A78BDB",
    naive: { primary: "#A78BDB", hover: "#BCA5E8", pressed: "#8F6FC4" },
  },
  {
    key: "night", dark: true,
    name: { en: "Starry Night", zh: "星夜蓝" },
    swatch: "#8B9CE8",
    naive: { primary: "#8B9CE8", hover: "#A3B2F0", pressed: "#6E80D0" },
  },
];

export const themeByKey = (key) => THEMES.find((t) => t.key === key) || THEMES[0];