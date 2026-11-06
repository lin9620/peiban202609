/* ══════════ 内容语言偏好（轮 439）══════════
 *
 * 用户要的是「我优先看我这种语言的内容」，不是「只看我这种语言」。
 * 这个区别是数据决定的：库里 99% 是中文，西语用户一旦硬过滤就只剩白屏 ——
 * 所以这里实现的是**排序**（本语言排前面，其余接在后面），不是过滤。
 * 排序天然就是「不足补位」：本语言的内容看完了，往下自然是非本语言的。
 *
 * 偏好只存本地（wp-content-lang）。它是设备级的内容偏好，跨设备同步没意义，
 * 存数据库反而多一层读写和冲突处理。
 *
 * 三条线的差异（由调用方决定，不在这里统一）：
 *   · 暖心墙 / 故事：客户端排序（数据本来就在内存里）
 *   · 漂流瓶：服务端两轮捞取（随机场景没法排序），池空必须退回全语言
 *   · 评论 / 搜索 / 我的：**不参与**。过滤只会碍事 —— 找东西和看自己的内容时，
 *     用户要的是「全部」，不是「我这种语言的全部」。
 * ══════════════════════════════════════════════════════════════════════ */
import { reactive } from "vue";
import { i18n, normLocale, t } from "../i18n.js";
import { getItem, setItem } from "./storage.js";
import { detectLang, SUPPORTED } from "./langDetect.js";

const KEY = "wp-content-lang";

/* mode: "all" = 不区分语言；"prefer" = 本语言优先 */
export const contentPref = reactive({
  mode: getItem(KEY) === "prefer" ? "prefer" : "all",
});

export function setPrefMode(mode) {
  contentPref.mode = mode === "prefer" ? "prefer" : "all";
  setItem(KEY, contentPref.mode);
}

/** 当前界面语言（= 用户「我这种语言」的定义） */
export function uiLang() {
  return normLocale(i18n.locale);
}

/** "prefer" 时返回要优先的语言码，否则 null（表示不排序） */
export function preferredLang() {
  if (contentPref.mode !== "prefer") return null;
  const l = uiLang();
  /* 界面语言没有对应的内容语言（比如以后上 de 界面、内容库里永远没有 de）时
     不排序也不打角标 —— 否则满屏都是「EN」「ZH」角标，反而更乱。 */
  return SUPPORTED.includes(l) ? l : null;
}

/**
 * 排序权重：本语言 0，未知语言 2，其他语言 1。
 * 用权重而不是过滤，是这个功能最关键的设计 —— 见文件头。
 */
export function langRank(lang) {
  const want = preferredLang();
  if (!want) return 0;
  if (!lang || lang === "und") return 2;
  return lang === want ? 0 : 1;
}

/**
 * 稳定地按「本语言优先」重排一份列表。不改变同权重元素的相对顺序
 * （V8 的 sort 自 ES2019 起是稳定排序，这里显式用下标兜底一层，
 * 免得以后换运行时踩坑）。
 */
export function sortByLang(list, langOf) {
  if (!preferredLang()) return list;
  return list
    .map((item, i) => ({ item, i, r: langRank(langOf(item)) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.item);
}

/** 卡片角标：只有「在优先模式下、且不是本语言、且语言已知」时才显示 */
export function langBadge(lang) {
  const want = preferredLang();
  if (!want || !lang || lang === "und" || lang === want) return "";
  return String(lang).toUpperCase();
}

/**
 * 语言名的本地化写法（"英语" / "anglais" / "inglês"）。
 * 用在「这封信是 X 写的」这类句子里 —— 直接甩语言代码（EN）是很糙的做法。
 * 词典里没有该语言（比如以后检测器认出冰岛语）就退回大写代码，不让界面出空。
 */
export function langName(lang) {
  const code = String(lang || "").toLowerCase();
  if (!code || code === "und") return "";
  const name = t(`lang.${code}`);
  return name === `lang.${code}` ? code.toUpperCase() : name;
}

/** 内容语言：发布时统一走这里，免得三处各写一遍 */
export function detectContentLang(text) {
  return detectLang(text).lang;
}
