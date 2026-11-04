/* 故事栏 · 纯函数层（轮 145 批 1）
 * ------------------------------------------------------------
 * 只放不碰 IO 的规则：字数/标签/周期/排序/轻 Markdown 渲染 —— 便于 story-test 直测。
 * 字数口径与 DB 同步：char_length = Unicode 码点 → [...s].length（扩展字符对不重复计数）。
 */
export const TITLE_MAX = 100;
export const BODY_MIN = 100;        /* 正文下限：发布 ≥100 字（SQL 同口径，RPC 层生效） */
export const BODY_MAX = 30000;
export const TAGS_MAX = 3;          /* 标签 1~3 个 */
export const TAG_MAX = 20;          /* 单标签 ≤20 字（SQL 同口径） */
export const READ_CHARS_PER_MIN = 400;   /* 阅读时长：400 字/分钟（SQL 同口径） */

export const SORT_MODES = ["random", "latest", "monthly", "tag"];
export const DEFAULT_MODE = "random";    /* 默认 = 随机推荐 */

/* ── 预设热门标签（投稿区一键填充，省去「不知道打什么」的冷启动）
   纯展示用：normalizeTags 会小写化 + 去 #，所以这里不要带 # 号。
   全部 ≤TAG_MAX 字，与服务端 tag 校验口径一致。 ── */
export const PRESET_TAGS = [
  "日常", "陪伴", "故事", "心情", "碎碎念",
  "求助", "经验", "萌宠", "新手",
];

/* ── 字数 ─────────────────────────────────────────── */
export function countChars(s) {
  return [...String(s ?? "")].length;
}
export function readMinutes(chars) {
  return Math.max(1, Math.ceil(countChars(chars) / READ_CHARS_PER_MIN));
}

/* ── 标签：trim + 小写 + 去空 + 去重，封顶 TAGS_MAX ── */
export function normalizeTags(tags) {
  const list = Array.isArray(tags) ? tags : [];
  const out = [];
  for (const raw of list) {
    const s = String(raw ?? "").trim().replace(/^#+/, "").toLowerCase();
    if (!s || out.includes(s)) continue;
    out.push(s);
    if (out.length >= TAGS_MAX) break;
  }
  return out;
}

/* ── 发布校验：返回 i18n key（story.err* 前缀省略，返回短码）或 null ── */
export function validatePublish({ title, body, tags } = {}) {
  const t = String(title ?? "").trim();
  if (!t) return "bad-title";
  if (countChars(t) > TITLE_MAX) return "bad-title";
  const b = String(body ?? "");
  const bc = countChars(b);
  if (!bc) return "empty-body";
  if (bc < BODY_MIN) return "too-short";   /* <100 字：服务端也拦，双保险 */
  if (bc > BODY_MAX) return "too-long";
  if (!normalizeTags(tags).length) return "bad-tags";
  return null;
}

/* ── 点赞/收藏的乐观状态切换（轮 321：详情页「点了没反应」的纯逻辑层）──
 * 背景：旧写法是「等服务端 RPC 回来才改 UI」——跨境弱网 0.5~3s 期间按钮被 :disabled 锁住、
 * 外观一点不变，用户看到的就是「点了没动静」；连点还会被 disabled 吞掉。
 * 这里把「开关型字段（liked/marked）+ 可选计数」的状态切换抽成纯函数：
 *   - applyStoryToggle(cur, key, countKey, target)：幂等地「设成目标态」，
 *     目标与当前一致时原样返回（不发多余请求）；不一致才翻转并同步计数。
 *   - flipStoryToggle(cur, key, countKey)：乐观翻转（点一下立刻变色 +1/-1）。
 * 计数下限 0：连点后计数不会变负。 */

/** 幂等设置开关态（target=true 点赞/收藏，false 取消） */
export function applyStoryToggle(cur, key, countKey, target) {
  const base = cur && typeof cur === "object" ? cur : {};
  const want = !!target;
  if (!!base[key] === want) return { ...base };
  const out = { ...base };
  out[key] = want;
  if (countKey) {
    const n = Number(base[countKey]) || 0;
    out[countKey] = Math.max(0, n + (want ? 1 : -1));
  }
  return out;
}

/** 乐观翻转：点一下立刻生效（不等网络） */
export function flipStoryToggle(cur, key, countKey) {
  const base = cur && typeof cur === "object" ? cur : {};
  return applyStoryToggle(base, key, countKey, !base[key]);
}

/* ── 周期键：月 'YYYY-MM'（现用）；周 'YYYY-Www'（以后改周榜只换这个口径） ── */
export function periodKey(d = new Date()) {
  const dt = d instanceof Date && !Number.isNaN(d.getTime()) ? d : new Date();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  return `${dt.getFullYear()}-${m}`;
}
export function periodKeyWeek(d = new Date()) {
  const dt = d instanceof Date && !Number.isNaN(d.getTime()) ? d : new Date();
  const date = new Date(Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/* ── 轻 Markdown 渲染（批 1 口径）：转义先行，只认 4 种结构，其余按纯文本。
 *   ## 二级标题 / > 引用 / --- 分割线 / **粗体**；段落 = 单行。返回 HTML 字符串。 */
function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function inline(s) {
  return esc(s).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}
/* 首行缩进判定：CJK（中文/日文/韩文字符）开头的正文段落自动 data-indent。
 * 英文段落按西文排版惯例不缩进。导出供单测。 */
export function paraIndent(line) {
  return /^[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(line.trim()) ? "1" : "";
}
export function renderLiteMd(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const out = [];
  let quote = [];
  const flushQuote = () => {
    if (quote.length) { out.push(`<blockquote>${quote.join("<br>")}</blockquote>`); quote = []; }
  };
  for (const line of lines) {
    const l = line.trim();
    if (/^>{1,2}\s?/.test(l)) { quote.push(inline(l.replace(/^>{1,2}\s?/, ""))); continue; }
    flushQuote();
    if (/^##\s+/.test(l)) { out.push(`<h2>${inline(l.replace(/^##\s+/, ""))}</h2>`); continue; }
    if (/^(-{3,}|—{3,})$/.test(l)) { out.push("<hr>"); continue; }
    if (!l) { out.push(""); continue; }
    const ind = paraIndent(l) ? ' data-indent="1"' : "";
    out.push(`<p${ind}>${inline(l)}</p>`);
  }
  flushQuote();
  return out.join("\n");
}

/* ── 四榜页签口径（顺序即 UI 顺序；默认 = random 随机推荐） ── */
export const RANK_TABS = [
  { mode: "random", tk: "story.rankRandom" },
  { mode: "latest", tk: "story.rankLatest" },
  { mode: "monthly", tk: "story.rankMonthly" },
  { mode: "tag", tk: "story.rankTag" },
];

/* ── 服务端错误归类：RPC/HTTP 报文 → i18n key（story.err* 家族） ── */
export function storyErrKey(e) {
  const raw = String(e?.message ?? e ?? "");
  if (/story-bad-title|bad-title/.test(raw)) return "story.errTitle";
  if (/story-too-short|too-short/.test(raw)) return "story.errShort";
  if (/story-too-long|too-long|30000/.test(raw)) return "story.errLong";
  if (/story-bad-tags/.test(raw)) return "story.errTags";
  if (/story-comment-empty/.test(raw)) return "story.errCommentEmpty";
  if (/story-comment-long/.test(raw)) return "story.errCommentLong";
  if (/story-not-found/.test(raw)) return "story.errNotFound";
  if (/story-auth|JWT|401|not authenticated/i.test(raw)) return "story.errAuth";
  if (/story-bad-mode/.test(raw)) return "story.errMode";
  if (/429|rate|quota/.test(raw)) return "story.errRate";
  if (/network|fetch|Failed to fetch|timeout|502/i.test(raw)) return "story.errNetwork";
  return "story.errGeneric";
}
