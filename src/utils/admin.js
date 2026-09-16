/* 管理员看板 —— 纯展示逻辑（阶段 2.5）
 * ------------------------------------------------------------
 * 输入是 admin_overview() 的 jsonb（形状见 MIGRATION_admin.sql），
 * 这里只做「脏数据兜底 + 格式化」，不发请求、不依赖 Supabase —— 可单测。
 * 页面：src/views/AdminView.vue；测试：tools/admin-test.mjs
 */

/** 12345 → "12,345"；脏值一律 0 */
export function fmtNum(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return "0";
  try {
    return v.toLocaleString("en-US");
  } catch (e) {
    return String(Math.floor(v));
  }
}

/** 字节 → 人话；负数/脏值 → "0" */
export function fmtBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "0";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let x = v;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i++;
  }
  return `${i === 0 ? Math.round(x) : x.toFixed(1)} ${units[i]}`;
}

/** 长文本截断（治理列表摘要用）；非字符串 → 空串 */
export function clip(s, n) {
  if (typeof s !== "string") return "";
  if (s.length <= n) return s;
  return `${s.slice(0, Math.max(0, n - 1))}…`;
}

/** 近 N 天趋势：缺行/脏行补零，固定返回 N 项（旧→新），保证图表宽度稳定 */
export function dailySeries(raw, days = 14) {
  const arr = Array.isArray(raw) ? raw : [];
  const out = [];
  for (let i = 0; i < days; i++) {
    const r = arr[i] && typeof arr[i] === "object" ? arr[i] : {};
    const num = (x) => {
      const v = Number(x);
      return Number.isFinite(v) && v >= 0 ? v : 0;
    };
    out.push({
      day: typeof r.day === "string" ? r.day.slice(0, 10) : "",
      posts: num(r.posts),
      users: num(r.users),
      comments: num(r.comments),
    });
  }
  return out;
}

/** 某一字段的柱高（0~100，最大值归一；全 0 时给 3 的可见矮柱） */
export function barHeights(series, key) {
  const vals = series.map((r) => Number(r[key]) || 0);
  const max = Math.max(...vals, 0);
  return vals.map((v) => ({ v, h: max > 0 ? Math.max(3, Math.round((v / max) * 100)) : 3 }));
}

/** 回应分布：{kind:count} → 固定四种 + total；脏值/未知 kind 忽略 */
export function sumReactions(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const num = (x) => {
    const v = Number(x);
    return Number.isFinite(v) && v >= 0 ? v : 0;
  };
  const hug = num(src.hug);
  const warm = num(src.warm);
  const relate = num(src.relate);
  const dislike = num(src.dislike);
  return { hug, warm, relate, dislike, total: hug + warm + relate + dislike };
}

/* 时区口径：全站按北京时间（Asia/Shanghai）——与 admin_overview() 的
 * 「今日 / 近 14 天」切日一致；不再直接截 UTC 字符串（每天 0-8 点会显示成前一天）。 */
const TZ = "Asia/Shanghai";
const FMT_DATE = new Intl.DateTimeFormat("sv", { timeZone: TZ });
const FMT_TIME = new Intl.DateTimeFormat("sv", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
const toDate = (ts) => {
  if (typeof ts !== "string" || !ts) return null;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** 时间戳 → 北京时间 YYYY-MM-DD；脏值 → 空串 */
export function dayOf(ts) {
  const d = toDate(ts);
  return d ? FMT_DATE.format(d) : "";
}

/** 时间戳 → 北京时间 YYYY-MM-DD HH:mm（用户名单的「注册时间」用，消除跨日歧义） */
export function dayTimeOf(ts) {
  const d = toDate(ts);
  return d ? `${FMT_DATE.format(d)} ${FMT_TIME.format(d)}` : "";
}