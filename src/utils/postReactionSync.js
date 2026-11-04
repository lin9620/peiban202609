/* 帖级回应的跨页同步（纯逻辑 + 进程内事件）
 * ------------------------------------------------------------
 * 病根（用户实测）：
 *   ① 在帖子详情点「同感」→ 返回暖心墙，墙里的帖子对象还是旧的 `mine`，
 *      因为墙被 KeepAlive 保活，不会重新挂载；详情只改了自己的 post.value。
 *   ② 在暖心墙点「同感」→ 马上点进详情，详情只认 `wall:post:<id>` 缓存；
 *      墙的点击没写这份缓存，于是详情只能等 cloudFetchPost 网络回来，
 *      弱网下就是「等很久才显示」。
 *
 * 这里只做两件小事：
 *   - `applyPostReactionPatch`：把 {reacts:{kind:n}, mine:{kind:bool}} 合进一篇视图帖；
 *     只动 patch 里出现的 kind，绝不整包覆盖（同轮 354 的多 kind 并行口径）。
 *   - `publishPostReaction` / `onPostReaction`：详情页改完回应后，进程内通知仍存活的
 *     暖心墙实例，把同一篇帖的行内状态改掉；墙被 KeepAlive 时也能立即看到。
 *
 * 不碰网络、不写数据库；详情页仍负责把帖子写回 `wall:post:<id>` 缓存，
 * 保证从墙进入详情时能 0ms 先渲染。
 */

/** 把一次回应补丁合进视图帖；没有实际变化时返回原对象（避免无意义重渲染）。 */
export function applyPostReactionPatch(post, patch) {
  if (!post || !patch || typeof patch !== "object") return post;
  const reacts = { ...(post.reacts || {}) };
  const mine = { ...(post.mine || {}) };
  let changed = false;

  const nextReacts = patch.reacts && typeof patch.reacts === "object" ? patch.reacts : {};
  for (const kind of Object.keys(nextReacts)) {
    const raw = nextReacts[kind];
    if (raw === undefined || raw === null) continue;
    const n = Math.max(0, Number(raw) || 0);
    if (reacts[kind] !== n) { reacts[kind] = n; changed = true; }
  }

  const nextMine = patch.mine && typeof patch.mine === "object" ? patch.mine : {};
  for (const kind of Object.keys(nextMine)) {
    const on = !!nextMine[kind];
    if (mine[kind] !== on) { mine[kind] = on; changed = true; }
  }

  return changed ? { ...post, reacts, mine } : post;
}

/** 把补丁合进一份帖子列表；只替换命中的那篇，没命中返回原数组（避免无意义重渲染）。 */
export function patchPostList(list, dbId, patch) {
  if (!Array.isArray(list) || dbId == null || !patch) return list;
  const id = String(dbId);
  let changed = false;
  const next = list.map((p) => {
    if (!p || p.dbId == null || String(p.dbId) !== id) return p;
    const q = applyPostReactionPatch(p, patch);
    if (q !== p) changed = true;
    return q;
  });
  return changed ? next : list;
}

const listeners = new Set();

/** 订阅跨页回应变化；返回取消订阅函数。 */
export function onPostReaction(fn) {
  if (typeof fn !== "function") return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 通知仍在内存里的其它视图：某篇帖的某个 kind 变了。 */
export function publishPostReaction(dbId, patch) {
  if (dbId == null || !patch || typeof patch !== "object") return;
  const id = String(dbId);
  for (const fn of [...listeners]) {
    try { fn(id, patch); } catch (e) { /* 单个订阅者异常不影响其它视图 */ }
  }
}
