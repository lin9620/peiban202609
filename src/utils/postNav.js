/* 帖子详情「上一条 / 下一条」的列表上下文（轮 279）
 * ────────────────────────────────────────────────────────────────
 * 三个入口各自带各自的表，跳转前把「这次点开的是哪张列表」存下来，详情页据此算上下条：
 *   ① 暖心墙 shown     ② 我的帖子 rows / myPosts     ③ 他人帖子 posts
 *
 * 为什么存快照（id 数组）而不是函数引用：MyPostsView / WallerView 不在 keep-alive
 * 白名单里，从详情返回时组件已经卸载，跨组件回调会指向死实例 —— 只存 id 没有这个问题。
 *
 * 为什么还要落 sessionStorage：详情页刷新 / 同设备分享链接打开时内存已空，存下来还能接着滑；
 * 存不下（隐私模式、存储满）就退回内存那一份，仍然能滑，再不行就自然降为「不可滑」，不报错。
 *
 * 启用判据 = 当前详情的 id 在表里（navIdsFor 返回空数组即不启用）：从收藏/通知/举报页
 * 进详情时，那条帖子若恰好也在上次的表里，滑出来的仍是同列表相邻项，语义自洽；不在表里
 * 则完全不响应，不会「滑到莫名其妙的地方」。因此入口侧只需要 setPostNav，不需要清空点。 */
const KEY = "warm-paws:postNav";
const MAX_IDS = 600;   /* 单表上限：一条 id ≈ 36 字节，600 条 ≈ 22KB，远低于 sessionStorage 的 5MB */

let mem = null;

function safeRead() {
  try { return typeof sessionStorage !== "undefined" ? sessionStorage.getItem(KEY) : null; }
  catch (e) { return null; }                 /* 隐私模式 / 禁用存储：当没有 */
}
function safeWrite(v) {
  try { if (typeof sessionStorage !== "undefined") sessionStorage.setItem(KEY, v); }
  catch (e) { /* 写不进就只留内存那份，照样能滑 */ }
}
function safeDrop() {
  try { if (typeof sessionStorage !== "undefined") sessionStorage.removeItem(KEY); }
  catch (e) { /* 忽略 */ }
}

/** 表项既接受「行对象」也接受裸 id 字符串/数字；去空、去重、去 null，封顶 MAX_IDS */
function normalize(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    let id = null;
    if (typeof item === "string" || typeof item === "number") id = String(item);
    else if (item && typeof item === "object") {
      if (item.dbId != null) id = String(item.dbId);
      else if (item.id != null && typeof item.id !== "object") id = String(item.id);
    }
    if (!id || id === "null" || id === "undefined" || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_IDS) break;
  }
  return out;
}

/** 跳转前调用。少于 2 条 = 没有上下一条，存了也是空转 → 清掉，别留脏表 */
export function setPostNav(list) {
  const ids = normalize(list);
  if (ids.length < 2) { clearPostNav(); return ids; }
  mem = { ids, ts: Date.now() };
  safeWrite(JSON.stringify(mem));
  return ids;
}

export function getPostNav() {
  if (mem && Array.isArray(mem.ids)) return mem;
  const raw = safeRead();
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (v && Array.isArray(v.ids) && v.ids.length >= 2) { mem = v; return mem; }
  } catch (e) { /* 脏数据当没有 */ }
  return null;
}

export function clearPostNav() { mem = null; safeDrop(); }

/** 当前详情 id 在表里 → 返回整张表；不在 → 空数组（= 这个详情页不启用左右滑） */
export function navIdsFor(id) {
  const ctx = getPostNav();
  if (!ctx || id == null) return [];
  const s = String(id);
  return ctx.ids.includes(s) ? ctx.ids : [];
}

/** dir = 1 下一条（左滑）/ dir = -1 上一条（右滑）；到头或无上下文返回 null */
export function navTarget(id, dir) {
  const ids = navIdsFor(id);
  if (!ids.length) return null;
  const j = ids.indexOf(String(id)) + (dir > 0 ? 1 : -1);
  return j >= 0 && j < ids.length ? ids[j] : null;
}
