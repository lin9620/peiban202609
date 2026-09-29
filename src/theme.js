/* Naive UI 主题工厂：按 UI 主题套件生成组件库配色 */
import { themeByKey } from "./data/themes.js";

export function naiveThemeFor(key) {
  const t = themeByKey(key);
  const p = t.naive;
  const dark = !!t.dark;

  const ink = dark ? "#E8EAF6" : "#141413";
  const ink2 = dark ? "#C0C6E8" : "#6C6A64";
  const ink3 = dark ? "#9AA3CC" : "#8E8B82";
  const line = dark ? "rgba(139, 156, 232, .25)" : "#E6DFD8";
  const cardBg = dark ? "rgba(38, 44, 78, .72)" : "#EFE9DE";
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
      dividerColor: dark ? "rgba(139, 156, 232, .18)" : "#EBE6DF",
      borderRadius: "8px",
      borderRadiusSmall: "6px",
      fontFamily:
        "'Inter', 'LXGW WenKai', 'PingFang SC', 'Microsoft YaHei', sans-serif",
      fontSize: "15px",
      hoverColor: dark ? "rgba(139, 156, 232, .14)" : "rgba(204, 120, 92, .10)",
      boxShadow1: dark ? "0 2px 10px rgba(0, 0, 0, .35)" : "0 2px 10px rgba(160, 110, 60, .08)",
      boxShadow2: dark ? "0 8px 28px rgba(0, 0, 0, .45)" : "0 8px 28px rgba(160, 110, 60, .13)",
    },
    Button: {
      borderRadiusMedium: "8px",
      borderRadiusLarge: "8px",
      borderRadiusSmall: "8px",
      fontWeightStrong: "500",
      textColorGhost: ink2,
      colorQuaternary: "transparent",
      colorQuaternaryHover: dark ? "rgba(139, 156, 232, .16)" : "rgba(204, 120, 92, .12)",
    },
    Card: {
      borderRadius: "12px",
      color: cardBg,
    },
    Input: {
      borderRadius: "8px",
      color: dark ? "rgba(38, 44, 78, .6)" : "rgba(255, 255, 255, .85)",
      colorFocus: dark ? "#2A3060" : "#FFFFFF",
      border: dark ? "1px solid rgba(139, 156, 232, .3)" : "1px solid #E6DFD8",
      borderHover: `1px solid ${p.hover}`,
      borderFocus: `1px solid ${p.primary}`,
      boxShadowFocus: dark ? "0 0 0 3px rgba(139, 156, 232, .2)" : "0 0 0 3px rgba(204, 120, 92, .15)",
    },
    Tag: { borderRadius: "999px", fontWeightStrong: "500" },
    Avatar: { borderRadius: "50%" },
    Dropdown: {
      borderRadius: "16px",
      color: popBg,
      optionTextColor: ink,
      optionTextColorActive: p.pressed,
      optionColorHover: dark ? "rgba(139, 156, 232, .16)" : "rgba(255, 159, 90, .14)",
    },
    Message: { borderRadius: "12px", color: popBg },
    Dialog: { borderRadius: "16px", color: popBg },
    Progress: {
      railColor: dark ? "rgba(139, 156, 232, .18)" : "#E6DFD8",
    },
  };
}