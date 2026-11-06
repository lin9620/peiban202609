/**
 * 暖心墙「离场存档」的落盘体（轮 433，纯函数，Node 单测覆盖：tools/feed-archive-test.mjs）
 *
 * 背景：返回暖心墙要回到原位置，靠的是离场时把 rows / heights / cmtTotal 一起塞进
 *   localStorage。旧实现是「全量 JSON.stringify，超过 1.5MB 就整份放弃」——
 *   帖量一大存档就静默失效，用户回来只能从头拉第一页（体感：怎么又回到顶了）。
 *
 * 现在按预算逐级瘦身，能存一点就存一点，**绝不因为「太大」而一条都不存**：
 *   ① 整份；
 *   ② 去高度表（只影响占位块估高，落位后第一帧就重测回来）；
 *   ③ 只留窗口（前 ARCHIVE_ROWS 条）+ 游标退到窗口末尾（后续翻页无缝接上，不漏帖）；
 *   ④ 窗口再砍半、再砍到 ARCHIVE_MIN_ROWS；
 *   ⑤ 仍放不下才返回 ""（调用方不写盘）。
 *
 * 键口径：heights / cmtTotal 都以 String(post.id) 为键（见 idOf / postKey）。
 */

/** 字符数预算；localStorage 配额约 5MB，留足余量给别的键 */
export const ARCHIVE_BUDGET = 1200000;
/** 窗口条数上限（一轮截断后保留的帖子数） */
export const ARCHIVE_ROWS = 400;
/** 最低保留条数：再小就没有「回到原位置」的意义了 */
export const ARCHIVE_MIN_ROWS = 120;

function fit(pos, rows, heights, cmtTotal, budget) {
  try {
    const blob = JSON.stringify({ ...pos, rows, heights, cmtTotal });
    return blob.length <= budget ? blob : "";
  } catch (e) {
    return "";
  }
}

/** 按 rows 里出现的 id 裁掉 map 里的无关键 */
function trimKeyed(map, rows) {
  const keep = new Set(rows.map((r) => String(r && r.id)));
  const out = {};
  for (const k of Object.keys(map || {})) if (keep.has(k)) out[k] = map[k];
  return out;
}

/** 截出前 n 条，并把游标/到底标记/已亮条数一起改到与窗口自洽 */
function cut(pos, rows, n) {
  const keep = rows.slice(0, n);
  const last = keep[keep.length - 1];
  const truncated = n < rows.length;
  return {
    ...pos,
    rows: keep,
    heights: trimKeyed(pos.heights, keep),
    cmtTotal: trimKeyed(pos.cmtTotal, keep),
    /* 游标退到窗口末尾：恢复后触底翻页从这条往下取，中间不跳帖；done 必须放开 */
    cursor: truncated && last && last.dbId != null ? last.dbId : pos.cursor,
    done: truncated ? false : pos.done,
    reveal: Math.min(Number(pos.reveal) || 0, keep.length),
  };
}

/**
 * 生成可落盘的字符串（"" = 放不下，调用方别写）
 * @param {object} pos  离场存档对象（y/pane/reveal/cursor/done/newestTs/rows/heights/cmtTotal）
 * @param {object} [opt] { budget, rows }
 */
export function buildFeedArchive(pos, opt = {}) {
  const rows = Array.isArray(pos && pos.rows) ? pos.rows : [];
  if (!rows.length) return "";
  const budget = Number(opt.budget) > 0 ? Number(opt.budget) : ARCHIVE_BUDGET;
  const top = Number(opt.rows) > 0 ? Number(opt.rows) : ARCHIVE_ROWS;

  let blob = fit(pos, rows, pos.heights || {}, pos.cmtTotal || {}, budget);
  if (blob) return blob;
  blob = fit(pos, rows, {}, pos.cmtTotal || {}, budget);
  if (blob) return blob;

  for (const n of new Set([top, Math.floor(top / 2), Math.min(ARCHIVE_MIN_ROWS, top)])) {
    if (!(n > 0) || n >= rows.length) continue;
    const p = cut(pos, rows, n);
    blob = fit(p, p.rows, p.heights, p.cmtTotal, budget);
    if (blob) return blob;
  }
  return "";
}
