/* 公告正文翻译（显示层）
 * ------------------------------------------------------------
 * 请求同源 Worker 的 /api/translate：Worker 用 Cloudflare Workers AI
 * （@cf/meta/m2m100-1.2b）把管理员写的一种语言翻成读者当前语言。
 *
 * 为什么不在数据库里存译文：
 *  - 公告是低频、短文本，显示时翻 + 本机缓存已经够用；
 *  - 老公告（数据库里只有中文）也能立即获得译文，不需要补数据；
 *  - 不新增表/列/迁移，部署面最小。
 *
 * 失败策略：任何异常都抛给调用方，由通知中心退回原文（绝不显示空白）。
 */
import { getAuthToken } from "./api/authToken.js";
import { getItem, setItem } from "./storage.js";

const CACHE_PREFIX = "wp-announce-tr:v1:";
const env = import.meta.env || {};
const API_BASE = String(env.VITE_API_BASE || "").replace(/\/$/, "");
const URL_TRANSLATE = `${API_BASE}/api/translate`;

/** 读本机译文缓存（没有/损坏/空串都返回空串） */
export function readCachedTranslation(key) {
  try {
    const v = getItem(CACHE_PREFIX + key);
    return typeof v === "string" ? v : "";
  } catch (e) {
    return "";
  }
}

/** 写本机译文缓存（localStorage 满/隐私模式静默失败，不影响本次显示） */
export function writeCachedTranslation(key, text) {
  try {
    setItem(CACHE_PREFIX + key, String(text || ""));
  } catch (e) { /* 忽略 */ }
}

/**
 * 调 Worker 翻译一段文本（公告、今日故事共用）。
 * @param {string} text 原文
 * @param {string} target 目标语言 zh|en|es|pt|fr
 * @param {string} source 原文语言（调用方用 sourceLangOf 判断）
 * @returns {Promise<string>} 译文（失败抛错）
 */
export async function translateText(text, target, source) {
  const body = String(text || "").trim();
  if (!body) return "";
  const token = getAuthToken();
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), 20000) : null;
  try {
    const res = await fetch(URL_TRANSLATE, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ text: body, target, source }),
      ...(ctrl ? { signal: ctrl.signal } : {}),
    });
    if (!res.ok) throw new Error(`translate-${res.status}`);
    const j = await res.json().catch(() => null);
    const out = j && typeof j.text === "string" ? j.text.trim() : "";
    if (!out) throw new Error("translate-empty");
    return out;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* 旧名字保留：通知中心仍在用 translateAnnouncement，避免一次改名牵动公告链路。 */
export const translateAnnouncement = translateText;
