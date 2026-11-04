/* 帖级回应的乐观态叠加（纯逻辑：无 Vue、无网络，Node 单测可直跑）
 * ------------------------------------------------------------------
 * 背景（轮 322 改「点回应按钮立刻有反应」时埋下的雷）：
 *   落库队列的 key 是「帖id:kind」（同帖同回应串行，见 src/utils/reactQueue.js），
 *   而帖子上的计数/点亮存在 post.reacts / post.mine 里，是按**纯 kind**
 *   （hug / warm / relate / dislike）索引的 —— 两套键不是一回事。
 *   混用会出事：拿 "7:hug" 去读 post.mine["7:hug"] 永远是 undefined →
 *     ① 「服务端已经是目标态」的短路失效 → 计数被重复 ±1；
 *     ② 计数/点亮被写进 reacts["7:hug"] 这种没人读的垃圾键 → 界面看起来一点没变。
 *   另外 pending 是一张**跨帖共享**的表（详情页支持左右滑切帖），叠加时必须
 *   只取当前这篇帖的乐观态，否则换帖后会把上一篇的 +1 算到新帖头上（凭空 +1）。
 */

/** 从「帖id:kind」复合键里取出 kind（没有前缀就原样返回） */
export function pendingKind(key) {
  const s = String(key == null ? "" : key);
  const i = s.lastIndexOf(":");
  return i > -1 ? s.slice(i + 1) : s;
}

/** 从「帖id:kind」复合键里取出帖 id（没有前缀返回空串） */
export function pendingPostId(key) {
  const s = String(key == null ? "" : key);
  const i = s.lastIndexOf(":");
  return i > -1 ? s.slice(0, i) : "";
}

/**
 * 把「还没落库确认的乐观态」叠到服务端帖子上。
 * 幂等：服务端已经是目标态时不会重复加计数。
 * @param {object} post       服务端帖子（reacts / mine 按纯 kind 索引）
 * @param {object} pending    乐观态表（key → 目标态），key 形如 "7:hug"
 * @param {string} [onlyPostId] 只叠这一篇帖的乐观态；
 *        undefined = 不按帖过滤；null/"" = 本帖无有效 id → 一条都不叠
 */
export function mergePendingReacts(post, pending, onlyPostId) {
  if (!post || !pending) return post;
  const keys = Object.keys(pending);
  if (!keys.length) return post;
  /* onlyPostId 三态：
   *   undefined → 不按帖过滤（叠全部 pending；调用方确定表里只有这一篇帖时用）
   *   null/""  → 这篇帖没有有效 id → 无法归属任何帖 → 一条都不叠（宁可漏叠，不可串帖）
   *   "7"      → 只叠这一篇帖的 */
  const scope = onlyPostId === undefined ? null : String(onlyPostId);
  const filtered = scope !== null;      /* 是否按帖过滤 */
  const skipAll = filtered && scope === "";
  if (skipAll) return post;
  let out = post;
  for (const k of keys) {
    const kind = pendingKind(k);
    if (!kind) continue;
    /* 只叠当前这篇帖的（pending 跨帖共享；无前缀的键按"不属于任何帖"跳过） */
    if (filtered && pendingPostId(k) !== scope) continue;
    const want = !!pending[k];
    const wasOn = !!(out.mine && out.mine[kind]);
    if (wasOn === want) continue;          /* 服务端已是目标态 → 不用再 ±1 */
    const reacts = { ...(out.reacts || {}) };
    reacts[kind] = Math.max(0, (Number(reacts[kind]) || 0) + (want ? 1 : -1));
    out = { ...out, reacts, mine: { ...(out.mine || {}), [kind]: want } };
  }
  return out;
}
