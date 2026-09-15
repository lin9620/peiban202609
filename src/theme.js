/* Naive UI 主题工厂：按 UI 主题套件生成组件库配色 */
import { themeByKey } from "./data/themes.js";

export function naiveThemeFor(key) {
  const t = themeByKey(key);
  const p = t.naive;
  const dark = !!t.dark;

  const ink = dark ? "#E8EAF6" : "#4A3B2F";
  const ink2 = dark ? "#C0C6E8" : "#6B5949";
  const ink3 = dark ? "#9AA3CC" : "#96826F";
  const line = dark ? "rgba(139, 156, 232, .25)" : "rgba(160, 110, 60, .16)";
  const cardBg = dark ? "rgba(38, 44, 78, .72)" : "rgba(255, 255, 255, .72)";
  const popBg = dark ? "#262C52" : "rgba(255, 255, 255, .96)";

  return {
    common: {
      primaryColor: p.primary,
      primaryColorHover: p.hover,
      primaryColorPressed: p.pressed,
      primaryColorSuppl: p.primary,
      infoColor: "#9ED0F5",
      successColor: "#7FC86E",
      warningColor: "#F2B24A",
      errorColor: "#EF7D6A",
      textColorBase: ink,
      textColor1: ink,
      textColor2: ink2,
      textColor3: ink3,
      borderColor: line,
      dividerColor: dark ? "rgba(139, 156, 232, .18)" : "rgba(160, 110, 60, .12)",
      borderRadius: "14px",
      borderRadiusSmall: "10px",
      fontFamily:
        "'Quicksand', 'LXGW WenKai', 'PingFang SC', 'Microsoft YaHei', sans-serif",
      fontSize: "15px",
      hoverColor: dark ? "rgba(139, 156, 232, .14)" : "rgba(255, 159, 90, .10)",
      boxShadow1: dark ? "0 2px 10px rgba(0, 0, 0, .35)" : "0 2px 10px rgba(160, 110, 60, .08)",
      boxShadow2: dark ? "0 8px 28px rgba(0, 0, 0, .45)" : "0 8px 28px rgba(160, 110, 60, .13)",
    },
    Button: {
      borderRadiusMedium: "999px",
      borderRadiusLarge: "999px",
      borderRadiusSmall: "999px",
      fontWeightStrong: "700",
      textColorGhost: ink2,
      colorQuaternary: "transparent",
      colorQuaternaryHover: dark ? "rgba(139, 156, 232, .16)" : "rgba(255, 159, 90, .12)",
    },
    Card: {
      borderRadius: "24px",
      color: cardBg,
    },
    Input: {
      borderRadius: "999px",
      color: dark ? "rgba(38, 44, 78, .6)" : "rgba(255, 255, 255, .85)",
      colorFocus: dark ? "#2A3060" : "#FFFFFF",
      border: dark ? "1px solid rgba(139, 156, 232, .3)" : "1px solid rgba(160, 110, 60, .18)",
      borderHover: `1px solid ${p.hover}`,
      borderFocus: `1px solid ${p.primary}`,
      boxShadowFocus: dark ? "0 0 0 3px rgba(139, 156, 232, .2)" : "0 0 0 3px rgba(255, 159, 90, .18)",
    },
    Tag: { borderRadius: "999px", fontWeightStrong: "700" },
    Avatar: { borderRadius: "50%" },
    Dropdown: {
      borderRadius: "16px",
      color: popBg,
      optionTextColor: ink,
      optionTextColorActive: p.pressed,
      optionColorHover: dark ? "rgba(139, 156, 232, .16)" : "rgba(255, 159, 90, .14)",
    },
    Message: { borderRadius: "16px", color: popBg },
    Dialog: { borderRadius: "24px", color: popBg },
    Progress: {
      railColor: dark ? "rgba(139, 156, 232, .18)" : "rgba(160, 110, 60, .12)",
    },
  };
}