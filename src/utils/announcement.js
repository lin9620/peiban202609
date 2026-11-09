/* 管理员公告正文的多语言解析（纯函数，可单测）
 * ------------------------------------------------------------
 * 公告正文由管理员用一种语言写入（通常是中文），通知中心按读者当前界面语言
 * 自动翻译。这里只做「原文是什么语言 / 需不需要翻 / 缓存键」这类可离线判断，
 * 真正的翻译请求在 utils/translate.js（Worker + Workers AI）。
 *
 * 注意：翻译是「显示层补位」，数据库里的原文永远保留 —— 翻译失败、模型没开、
 * 网络抖动时都能退回原文，不会让公告变成空白。
 */
import { detectLang } from "./langDetect.js";

export const ANNOUNCE_LANGS = ["zh", "en", "es", "pt", "fr"];

/** 归一化界面语言：与 i18n.normLocale 同口径，但只关心公告支持的 5 种 */
export function announceLocale(locale) {
  const s = String(locale || "").toLowerCase().replace("_", "-");
  if (s.startsWith("zh")) return "zh";
  if (s.startsWith("en")) return "en";
  if (s.startsWith("es")) return "es";
  if (s.startsWith("pt")) return "pt";
  if (s.startsWith("fr")) return "fr";
  return "en";
}

/** 通知 meta.body 取出公告正文（去首尾空白；非字符串一律空串） */
export function announcementBody(meta) {
  if (!meta || typeof meta !== "object") return "";
  return typeof meta.body === "string" ? meta.body.trim() : "";
}

/** 判断原文语言：检测器拿不准时，含汉字按中文、否则按英文。
 *  公告是管理员手写的短文本，宁可给一个可翻译的源语言，也不要因为 und 卡住。 */
export function sourceLangOf(text) {
  const s = String(text || "");
  const d = detectLang(s);
  if (ANNOUNCE_LANGS.includes(d.lang)) return d.lang;
  return /[\u4E00-\u9FFF\u3400-\u4DBF]/.test(s) ? "zh" : "en";
}

/** 当前语言是否需要翻译（原文语言 = 界面语言就不翻，省一次 AI 调用） */
export function needsTranslation(text, locale) {
  const body = String(text || "").trim();
  if (!body) return false;
  return sourceLangOf(body) !== announceLocale(locale);
}

/** 稳定的缓存键：同一段原文 + 同一目标语言永远命中同一条本机缓存。
 *  FNV-1a 32 位足够（公告正文 ≤1000 字，碰撞概率可忽略），比把正文塞进
 *  localStorage 键名干净得多。 */
export function hashText(text) {
  const s = String(text || "");
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** 本机翻译缓存键（按目标语言隔离；换语言不会串） */
export function translationCacheKey(text, locale) {
  return `${announceLocale(locale)}:${hashText(text)}`;
}
