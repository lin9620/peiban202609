/* 今日页「故事 + 语录」的纯逻辑（轮 458）
 * ------------------------------------------------------------
 * 管理中心可以按日期发布一篇故事，正文按 5 种界面语言各存一份：
 *   { zh: {title, body, quote}, en: {...}, es: {...}, pt: {...}, fr: {...} }
 *
 * 这里只做「形状归一 / 语言回退 / 日期字符串」三件事，不碰网络、不依赖 Vue，
 * 方便 Node 单测和 TodayPane / AdminView 共用同一份口径。
 *
 * 回退顺序：读者语言 → 英文 → 中文 → 其余语言。
 * 某语言只有 quote 没有 title/body 时不算「有内容」，避免标题空白。
 */

export const DAILY_STORY_LANGS = ["zh", "en", "es", "pt", "fr"];
export const DAILY_STORY_FIELDS = ["title", "body", "quote"];
export const DAILY_STORY_LIMITS = { title: 100, body: 2000, quote: 240 };

const LANG_SET = new Set(DAILY_STORY_LANGS);

function baseLang(locale) {
  const s = String(locale || "en").toLowerCase().replace("_", "-");
  if (s.startsWith("zh")) return "zh";
  return s.split("-")[0] || "en";
}

/** 空内容：5 种语言 × 3 个字段，全部为空串 */
export function emptyDailyContent() {
  const out = {};
  for (const lang of DAILY_STORY_LANGS) {
    out[lang] = { title: "", body: "", quote: "" };
  }
  return out;
}

/** 截断到最多 n 个字符（按 Unicode 码点，避免把 emoji 劈成两半） */
function clipText(v, n) {
  const s = typeof v === "string" ? v : "";
  const chars = [...s];
  return chars.length > n ? chars.slice(0, n).join("") : s;
}

/** 把任意来源（数据库 jsonb / 旧缓存 / 表单）归一成固定 5×3 形状 */
export function normalizeDailyContent(raw) {
  const out = emptyDailyContent();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const lang of DAILY_STORY_LANGS) {
    const src = raw[lang];
    if (!src || typeof src !== "object" || Array.isArray(src)) continue;
    for (const field of DAILY_STORY_FIELDS) {
      if (typeof src[field] === "string") {
        out[lang][field] = clipText(src[field].trim(), DAILY_STORY_LIMITS[field]);
      }
    }
  }
  return out;
}

/** 某语言是否有可展示的标题或正文（quote 单独存在不算） */
export function dailyLangHasStory(content, lang) {
  const c = content && content[lang];
  return !!(c && (String(c.title || "").trim() || String(c.body || "").trim()));
}

/** 内容里是否有任何可展示的故事（用于判断要不要覆盖静态轮换） */
export function hasDailyStory(raw) {
  const c = normalizeDailyContent(raw);
  return DAILY_STORY_LANGS.some((lang) => dailyLangHasStory(c, lang));
}

/**
 * 按读者语言挑一份故事；当前语言缺失时回退 en → zh → 其余语言。
 * @returns {{title:string, body:string, quote:string, lang:string, fallback:boolean}|null}
 */
export function pickDailyContent(raw, locale) {
  const c = normalizeDailyContent(raw);
  const want = baseLang(locale);
  const order = [];
  if (LANG_SET.has(want)) order.push(want);
  for (const lang of ["en", "zh", ...DAILY_STORY_LANGS]) {
    if (!order.includes(lang)) order.push(lang);
  }
  for (const lang of order) {
    if (!dailyLangHasStory(c, lang)) continue;
    return { ...c[lang], lang, fallback: lang !== want };
  }
  return null;
}

/** 列表/预览用的一行标题：没有 title 就截正文开头 */
export function dailyStoryTitle(raw, locale, max = 60) {
  const p = pickDailyContent(raw, locale);
  if (!p) return "";
  return clipText(p.title || p.body, max);
}

/** 保存前校验；返回空串 = 通过，否则返回错误键（交给 i18n 翻） */
export function validateDailyContent(raw) {
  const c = normalizeDailyContent(raw);
  /* 允许管理员只填一种语言（例如只填英文），今日页会按读者语言回退；
   * 但完全空白的内容不能发布，否则那一天会变成空白故事。 */
  if (!DAILY_STORY_LANGS.some((lang) => dailyLangHasStory(c, lang))) return "need-content";
  /* 长度检查看原始值：normalize 会截断，先截再查就永远查不出超长。 */
  if (raw && typeof raw === "object") {
    for (const lang of DAILY_STORY_LANGS) {
      const src = raw[lang];
      if (!src || typeof src !== "object") continue;
      for (const field of DAILY_STORY_FIELDS) {
        if (typeof src[field] === "string"
          && [...src[field].trim()].length > DAILY_STORY_LIMITS[field]) {
          return `too-long:${lang}:${field}`;
        }
      }
    }
  }
  return "";
}

/* ──────── 日期字符串（本地时区，避免 toISOString 把晚上 8 点算成第二天） ──────── */

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** Date → YYYY-MM-DD（本地时区） */
export function isoDate(d = new Date()) {
  const x = d instanceof Date ? d : new Date(d);
  if (!(x instanceof Date) || Number.isNaN(x.getTime())) return "";
  return `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}`;
}

/** 是否是真实存在的 YYYY-MM-DD（拒绝 2026-02-31） */
export function isIsoDate(s) {
  const v = String(s || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  const x = new Date(y, m - 1, d);
  return x.getFullYear() === y && x.getMonth() === m - 1 && x.getDate() === d;
}

/** 在 YYYY-MM-DD 上加减天数（本地时区） */
export function shiftIsoDate(s, days = 0) {
  if (!isIsoDate(s)) return "";
  const [y, m, d] = s.split("-").map(Number);
  const x = new Date(y, m - 1, d + Number(days || 0));
  return isoDate(x);
}

/** 表单里某语言是否有内容（语言页签上的小圆点） */
export function dailyFormFilled(form) {
  const out = {};
  for (const lang of DAILY_STORY_LANGS) out[lang] = dailyLangHasStory(form, lang);
  return out;
}

