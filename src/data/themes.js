/* ═══════════ UI 主题套件 ═══════════
   每套主题：CSS 变量（style.css 中按 data-theme 覆盖）+ Naive UI 主色。 */

export const THEMES = [
  {
    key: "cream", dark: false,
    name: { en: "Warm Cream", zh: "暖奶油" },
    swatch: "#CC785C",
    naive: { primary: "#CC785C", hover: "#CC785C", pressed: "#A9583E" },
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
  {
    /* 深夜黑：星夜蓝的纯黑变体。CSS 仍复用 night 的整套深色结构规则，
     * 只通过 data-theme-variant="midnight" 把底色、玻璃和蓝紫表面压到近黑。 */
    key: "midnight", dark: true, base: "night", icon: "🌑",
    name: { en: "Midnight Black", zh: "深夜黑" },
    swatch: "#0B0B10",
    naive: { primary: "#C97A5D", hover: "#D98E72", pressed: "#A9583E" },
  },
];

export const themeByKey = (key) => THEMES.find((t) => t.key === key) || THEMES[0];

/* data-theme 只负责挂“结构基座”（night 的深色规则），变体主题再用
 * data-theme-variant 覆盖颜色。这样 night 里几十条深色适配（含组件 scoped
 * 样式）不需要为每个新深色主题复制一遍。 */
export const themeBaseKey = (key) => {
  const t = themeByKey(key);
  return t.base || t.key;
};
export const themeVariantKey = (key) => {
  const t = themeByKey(key);
  return t.base ? t.key : "";
};