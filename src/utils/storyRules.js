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

/* ── 排行榜「换一批」的下一步（轮 443 重写） ─────────────────────
 * 为什么要抽成纯函数：边界（池子刚好等于一页）在界面上极难复现，只能钉进单测。
 *
 * 轮 443 改了产品口径 —— **不再本地重排顺序**，翻到底就明确说「没有新内容了」。
 * 理由：本地重排只是把同一批内容打乱，用户以为换了新的，点开还是那几篇，是欺骗。
 * 配套地服务端 random 模式改成「30 天优先 + 90 天 / 一年 / 更早逐级补位」，
 * 所以这里的 exhausted 是可信的：真到底了就是整库都看完了。
 *
 *   · 榜单为空 → 回第一批重拉（上一次可能只是网络失败，值得再试）；
 *   · 不足一页 → 池子就这么大，往后翻必定是空 → exhausted，界面弹提示、列表不动；
 *   · 满页 → 正常往后翻一页。
 * 返回 { offset, exhausted }：exhausted=true 表示别发请求、也别改 offset，
 * 保持当前列表原样（再点还是这个提示，直到 5 分钟窗口换了种子或真有新故事发布）。 */
export function shuffleStep({ loaded = 0, page = 12, offset = 0 } = {}) {
  const n = Math.max(0, Number(loaded) || 0);
  const p = Math.max(1, Number(page) || 1);
  const off = Math.max(0, Number(offset) || 0);
  if (n === 0) return { offset: 0, exhausted: false };
  if (n < p) return { offset: off, exhausted: true };
  return { offset: off + p, exhausted: false };
}

/* ── 翻页合并：新一页只在**页内**排序，整页接在已有列表末尾 ──
 *
 * 轮 458（用户：「故事页面，加载更多，排序出现问题了，不是直接出现在最下面」）：
 * 原来把「本语言优先」的排序放在 computed 里对**累加后的整表**重排，于是每点一次
 * 「加载更多」，新一页里属于本语言的那几条就被提到前面几页的异语言内容之上 ——
 * 用户看到的是新内容「插进中间」，而不是接在最下面。
 *
 * 口径改成：排序只发生在「这一页进来的时候」，页与页之间只追加、不回流。
 * 代价是本语言优先只保证页内优先（跨页会交错），换来的是翻页顺序稳定 ——
 * 列表里已经看过的位置永远不动，这正是翻页该有的手感。
 *
 * 抽成纯函数是为了能直测：把 12 + 2 的混合语言分页喂进来，断言旧位置逐条不变。
 */
export function appendPage(prev, page, sortFn) {
  const list = Array.isArray(page) ? page.slice() : [];
  const ordered = typeof sortFn === "function" ? sortFn(list) : list;
  const base = Array.isArray(prev) ? prev : [];
  return base.concat(ordered);
}

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
  /* 轮 444：维护期写入被触发器拦下。必须排在通用分支之前，
   * 否则用户看到「出了点问题」，会以为是自己写的内容有问题。 */
  if (/maintenance-mode|PT503/i.test(raw)) return "story.errMaintenance";
  if (/429|rate|quota/.test(raw)) return "story.errRate";
  if (/network|fetch|Failed to fetch|timeout|502/i.test(raw)) return "story.errNetwork";
  return "story.errGeneric";
}
