/* 暖心墙进阶规则：纯逻辑层（不依赖 Vue / 浏览器 / 网络，Node 可直接单测）
 * ------------------------------------------------------------
 * 这里放四件事，全部是「输入 → 输出」的纯函数：
 *   1. 排序：默认最新，另有 同感最多 / 抱抱最多 / 暖暖最多
 *   2. 浏览去重：同一个访客对同一条帖，一天只记一次浏览
 *   3. 厌恶比例与自动下架：厌恶 ≥ 5 个 且 厌恶数 ÷ 浏览数 ≥ 1% → 下架（数据库假删除；#21 单人点不掉）
 *   4. 每日限额：每个用户每天最多发一条暖心墙内容
 * 云端同名规则在 MIGRATION_wall_daily_view_dislike.sql 里用 SQL 再实现一遍
 * （前端只是提示，服务端才是权威）；两边的判定口径必须一致，改动时同步。
 */

/* ══════════ 帖子时间：显示到分钟（#25） ══════════ */

/**
 * 暖心墙帖子/评论的时间：月日 + 时分（当年），跨年补年份。
 * 纯函数（now 可注入便于单测）；语言 zh→zh-CN，其余→en-US。
 * @param {string|number|Date} ts
 * @param {string} locale "zh" | 其它
 * @param {number} [now] 当前时间戳（默认 Date.now()）
 * @returns {string} 如 "9月19日 14:32" / "Sep 19, 14:32"；跨年 "2025年9月19日 14:32"；非法 → ""
 */
export function fmtWhen(ts, locale = "zh", now = Date.now()) {
  /* null/undefined/"" 不当有效时间（new Date(null) 会变成 1970-01-01） */
  const d = ts == null || ts === "" ? new Date(NaN) : new Date(ts);
  if (isNaN(d.getTime())) return "";
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleString(locale === "zh" ? "zh-CN" : "en-US", {
    month: "short", day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

/* ══════════ 排序 ══════════ */

/** 排序方式（顺序 = UI 上的按钮顺序），tk 为 i18n key */
export const SORTS = [
  { key: "new", tk: "community.sortNew" },
  { key: "relate", tk: "community.sortRelate" },
  { key: "hug", tk: "community.sortHug" },
  { key: "warm", tk: "community.sortWarm" },
];
export const SORT_MODES = SORTS.map((s) => s.key);
export const DEFAULT_SORT = "new";

/** 帖子某个回应的计数（缺字段/脏数据一律当 0） */
export function reactCount(post, kind) {
  const r = post && post.reacts;
  const n = r ? Number(r[kind]) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 排序（不改动入参数组）。
 *   - new    ：时间倒序（最新在前）
 *   - 其它   ：该种回应多的在前；票数相同按时间倒序（新帖在前，避免「并列」时顺序看着随机）
 * 未知模式一律回退 new —— 存档里存了老值 / 手改 localStorage 也不会让列表乱掉。
 * @param {Array} list
 * @param {string} mode
 * @returns {Array} 新数组
 */
export function sortPosts(list, mode = DEFAULT_SORT) {
  const arr = Array.isArray(list) ? list.slice() : [];
  const m = SORT_MODES.includes(mode) ? mode : DEFAULT_SORT;
  const byTime = (a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0);
  if (m === "new") return arr.sort(byTime);
  return arr.sort((a, b) => {
    const d = reactCount(b, m) - reactCount(a, m);
    return d !== 0 ? d : byTime(a, b);
  });
}

/* ══════════ 浏览 ══════════ */

export const VIEW_KEY = "warm-paws-views-v1";   // 浏览去重记录（按 UTC 日）
export const ANON_KEY = "warm-paws-anon-v1";    // 未登录访客的匿名标识（云端浏览去重用）

/** 帖子的唯一身份：云端帖用 dbId，本地帖用 id */
export function postRef(post) {
  if (!post) return "";
  if (post.dbId != null) return String(post.dbId);
  return post.id != null ? String(post.id) : "";
}

/**
 * UTC 日期串（YYYY-MM-DD）。
 * 与数据库 created_day / 浏览去重日统一用 UTC —— 前端与服务端判「今天」才不会错开。
 */
export function utcDay(ts = Date.now()) {
  const d = new Date(Number(ts) || 0);
  if (Number.isNaN(d.getTime())) return utcDay(0);
  return d.toISOString().slice(0, 10);
}

/** 清理过期的浏览记录，只留今天的（localStorage 不会无限长大） */
export function pruneStamps(stamps, day = utcDay()) {
  const out = {};
  const src = stamps && typeof stamps === "object" ? stamps : {};
  for (const [k, v] of Object.entries(src)) {
    if (v === day) out[k] = v;
  }
  return out;
}

/**
 * 算出「这次需要 +1 浏览」的帖子。
 * 同一个访客（登录用户 = uid；游客 = 本机匿名 id）对同一条帖，一天只算一次 ——
 * 否则用户反复刷新就能把厌恶比例冲淡（下架规则就废了）。
 *
 * 本地记录刻意「只按帖」记（不带 viewer）：同一台设备先游客看、再登录看，
 * 仍然只算一次，不会因为换个身份就把同一个人的浏览量算两遍。
 * 真正的「多访客各算一次」由服务端 wall_post_views(post_id, viewer_key, day) 保证。
 * @param {Object} stamps 现有记录 { [postRef]: "YYYY-MM-DD" }
 * @param {Array} list 帖子
 * @param {string} viewer 访客标识（未登录为空 → 不计数）
 * @param {string} day UTC 日
 * @returns {{stamps: Object, pending: Array}} pending 为需要 +1 的帖子（原对象）
 */
export function collectViews(stamps, list, viewer, day = utcDay()) {
  const next = pruneStamps(stamps, day);
  const pending = [];
  if (!viewer) return { stamps: next, pending };
  for (const p of Array.isArray(list) ? list : []) {
    /* 示例帖是固定内容，不参与浏览统计（也不虚构任何数字） */
    if (!p || p.sample || !postRef(p)) continue;
    const k = postRef(p);
    if (next[k] === day) continue;
    next[k] = day;
    pending.push(p);
  }
  return { stamps: next, pending };
}

/* ══════════ 厌恶比例 → 自动下架（#26 双档规则） ══════════ */

export const REMOVAL_LOW_VIEWS = 100;  // 浏览分界：< 100 走「个数」档，≥ 100 走「比例」档
export const DISLIKE_MIN_COUNT = 3;    // #26 低浏览档：厌恶「超过 3 个」（即 ≥ 4）就下架
export const DISLIKE_RATIO = 0.005;    // #26 高浏览档：厌恶 ÷ 浏览「大于 0.5%」就下架

/**
 * 厌恶比例（展示用）。没有浏览数时返回 0 —— 「0 次浏览」不构成比例。
 */
export function dislikeRatio(views, dislikes) {
  const v = Math.max(0, Number(views) || 0);
  const d = Math.max(0, Number(dislikes) || 0);
  if (v <= 0) return 0;
  return Math.min(1, d / v);
}

/** 比例展示用百分比字符串，如 1.2% / 0.4% */
export function ratioPct(views, dislikes) {
  const r = dislikeRatio(views, dislikes);
  return (Math.round(r * 1000) / 10).toFixed(1) + "%";
}

/** 是否达到下架线（#26 双档；与 SQL wall_toggle_dislike 口径一致）。示例帖不参与下架。
 *  浏览 < 100：厌恶 > 3 个（≥4 人）→ 下架；浏览 ≥ 100：厌恶 ÷ 浏览 > 0.5% → 下架。 */
export function shouldRemove(views, dislikes, post = null) {
  if (post && post.sample) return false;
  const v = Math.max(0, Number(views) || 0);
  const d = Math.max(0, Number(dislikes) || 0);
  if (v < REMOVAL_LOW_VIEWS) return d > DISLIKE_MIN_COUNT;
  return d / v > DISLIKE_RATIO;
}

/** 假删除的帖子不进动态流 */
export function isVisible(post) {
  return !(post && post.removed);
}

/** 过滤掉已下架的帖子 */
export function visibleOnly(list) {
  return (Array.isArray(list) ? list : []).filter(isVisible);
}

/* ══════════ 每日限额（每用户每天最多一条） ══════════ */

export const POST_DAY_KEY = "warm-paws-posted-day-v1";  // 本地模式：今天发过没有

/**
 * 该用户在这一天（UTC）是否已经发过云端帖。
 * 用「列表里找」而不是额外查库：自己刚发的帖必然在最新一批里，
 * 且帖子列表已在手上 —— 少一次网络往返，没跑迁移也能用。
 */
export function postedOnDay(list, userId, day = utcDay()) {
  if (!userId) return false;
  for (const p of Array.isArray(list) ? list : []) {
    if (!p || !p.cloud || p.sample) continue;
    if (p.userId !== userId) continue;
    if (utcDay(p.ts) === day) return true;
  }
  return false;
}

/** 今天还能不能发（云端：看列表；本地：看本机记录） */
export function canPostToday({ list = [], userId = "", day = utcDay(), localDay = "" } = {}) {
  if (localDay === day) return false;
  return !postedOnDay(list, userId, day);
}

/* ══════════ 时间范围（只属于「最新」之外的排序） ══════════
 * 规则：「最新」= 按时间看全部最新内容，本来就没有时间窗口可言 ——
 * 所以那一排范围按钮不显示，也不拿范围去筛（见 usesRange / rangeFor）。
 * 另外三种（同感 / 抱抱 / 暖暖最多）是「在某个时间窗口里挑最多的」，才需要范围。
 */

/** 时间范围档位（顺序 = UI 上的按钮顺序），tk 为 i18n key */
export const RANGES = [
  { key: "2d", tk: "community.range2d" },
  { key: "7d", tk: "community.range7d" },
  { key: "month", tk: "community.rangeMonth" },
];
export const RANGE_KEYS = RANGES.map((r) => r.key);
export const DEFAULT_RANGE = "2d";

/** 「不筛时间」：内部档位，不出现在按钮里（按钮由 RANGES 生成，天然不含它） */
export const RANGE_ALL = "all";

/** 需要时间范围的排序：「最新」之外的三种 */
export const RANGE_SORTS = SORT_MODES.filter((k) => k !== DEFAULT_SORT);

/**
 * 该排序方式下是否显示 / 使用时间范围。
 * @param {string} sort 排序 key（脏值 → false，不会莫名冒出一排按钮）
 * @returns {boolean}
 */
export function usesRange(sort) {
  return RANGE_SORTS.includes(sort);
}

/**
 * 该排序方式实际生效的时间范围。
 * 单一入口：显示那排按钮的地方与筛帖子的地方都从这里取值，
 * 避免「按钮藏了但筛选还在偷偷生效」这种最难排查的错。
 * @param {string} sort 排序 key
 * @param {string} range 用户选的档位（可能是脏值 / 老存档）
 * @returns {string} RANGE_ALL 或 有效的范围 key
 */
export function rangeFor(sort, range) {
  if (!usesRange(sort)) return RANGE_ALL;
  return RANGE_KEYS.includes(range) ? range : DEFAULT_RANGE;
}

const DAY_MS = 86400000;

/**
 * 某个时间范围的起点时间戳。
 * month = 当前 UTC 月的 1 日 0 点 —— 全站判「天/月」都用 UTC，口径才不会和数据库错开。
 * 未知档位回退默认近两天（存档里存了老值也不会让列表变空）。
 */
export function rangeStartTs(range, now = Date.now()) {
  const n = Number(now) || 0;
  if (range === "7d") return n - 7 * DAY_MS;
  if (range === "month") {
    const d = new Date(n);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  }
  return n - 2 * DAY_MS;
}

/**
 * 帖子是否落在时间范围内。
 *   - 示例帖不参与筛选（示范内容永远在，否则新用户一进页面可能空无一物）
 *   - 没有时间戳的帖子不显示（宁可少一条也不瞎猜它多老）
 *   - RANGE_ALL（「最新」排序，见 rangeFor）不按时间筛，但仍要求有时间戳
 */
export function inRange(post, range = DEFAULT_RANGE, now = Date.now()) {
  if (!post) return false;
  if (post.sample) return true;   // 示例帖不参与筛选（要在「无时间戳」判断之前）
  if (!post.ts) return false;
  if (range === RANGE_ALL) return true;
  const r = RANGE_KEYS.includes(range) ? range : DEFAULT_RANGE;
  if (r === "month") return utcDay(post.ts).slice(0, 7) === utcDay(now).slice(0, 7);
  return post.ts >= rangeStartTs(r, now);
}

/* ══════════ 云操作失败原因 ══════════ */

/**
 * 把云端错误信息归类，好给用户一句人话（而不是笼统的「失败」）。
 * 每日限额由数据库触发器抛出 'wall_daily_limit'。
 * @returns {"daily-limit"|"not-migrated"|""}
 */
export function errorKind(message, code) {
  const c = String(code == null ? "" : code).toUpperCase();
  if (c === "PGRST202" || c === "42883" || c === "42703" || c === "42P01") return "not-migrated";
  const m = String(message || "").toLowerCase();
  if (m.includes("wall_daily_limit")) return "daily-limit";
  /* 42703 = 列不存在；PGRST202 = 找不到 RPC（都是「还没跑迁移」的典型信号）。
     注意：真实响应里码在 error.code，消息是「Could not find the function … in the schema cache」，
     所以既认码也认这句真实话术（只写 "PGRST202" 当消息测会假通过）。 */
  if (m.includes("pgrst202") || m.includes("42703") || m.includes("does not exist")
    || m.includes("could not find the function")) return "not-migrated";
  return "";
}
