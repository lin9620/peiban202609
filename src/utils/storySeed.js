/* 轮 313 · 故事详情「点开即上屏」（零额外请求的秒开）
 * ------------------------------------------------------------
 * 痛点（用户实测）：首页故事联点一篇故事，页面要等 story_get 回来才有东西 —— 跨境弱网 0.5~3s 里
 * **整页全空**（连标题都没有），用户体感就是「打开的很慢」。
 * 做法：列表里那行（发现联 / 四榜 / 我的 / 相关推荐）本来就带着标题、作者、标签、字数、赞/看数，
 * 点卡片的一瞬间把它当「种子」塞给详情页 → 详情页首帧就画真内容，正文等 story_get 回来再补。
 * 口径：
 *  - 零额外请求：种子就是列表已经拿到的对象，不额外调 RPC（免费额度是硬约束）；
 *  - 只种详情页头部认识的字段（列表行没有 body/status/liked/marked，绝不能拿默认值冒充）；
 *  - 用掉即清：详情页取走后立刻清空，返回列表再点别的篇不会串；
 *  - 没有标题的行（异常态）不种 —— 宁可走原来的加载态，也不显示一个空标题。
 * 观感上一秒都不用等：切页第一帧 = 标题+作者+标签就位，正文处显示「正文载入中…」。
 */

const FIELDS = ["id", "title", "nickname", "tags", "published_at", "read_minutes", "word_count", "like_count", "view_count"];

let seed = null;

/** 点卡片时调用（列表行是 story_rank / story_featured / story_mine / story_bookmark_list 的行） */
export function setStorySeed(row) {
  if (!row || row.id == null || !String(row.title || "").trim()) { seed = null; return false; }
  const s = {};
  for (const k of FIELDS) if (row[k] !== undefined) s[k] = row[k];
  seed = s;
  return true;
}

/** 详情页取种子：id 对得上才给（取走即清），对不上返回 null */
export function takeStorySeed(id) {
  if (!seed || Number(seed.id) !== Number(id)) return null;
  const s = seed;
  seed = null;
  return s;
}

/** 仅供测试/调试：看当前有没有挂着种子 */
export function peekStorySeed() { return seed; }
