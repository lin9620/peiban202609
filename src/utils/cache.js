/* 本地优先缓存（stale-while-revalidate，SWR）
 * ------------------------------------------------------------
 * 痛点：每个页面 / 每次点击都要等云端 RPC 回来才渲染，「载入中」闪个不停，App 里尤其明显。
 * 做法：读结果的快照按「用户域 + 数据域」存进 localStorage（走 utils/storage.js，
 *       隐私模式自动降级内存）；下次进入页面**先渲染缓存**（不闪载入），后台照常拉取，
 *       回来后无缝覆盖并回写缓存 —— 用户永远先看到内容，网络只在后台工作。
 * 规则：
 *  - CACHE_VERSION 变更 → 旧缓存整体作废（缓存结构升级时改这里）；
 *  - key 一律带用户域（uid）：换账号不串数据；登出时 App.vue 按前缀清理个人域；
 *  - maxAge 只是安全网（防陈年数据），命中过期缓存照样先渲染，后台必刷；
 *  - 容量护栏：最多 MAX_ENTRIES 条，超出按「写入时间」淘汰最旧，localStorage 不会被撑爆。
 */
import { getItem, setItem, removeItem, keys } from "./storage.js";

const NS = "wp-cache:";
const VERSION = "v1";
export const CACHE_MAX_ENTRIES = 200;   /* 轮 206：120 → 200——大体积条目（墙/聊天）仍会挤兑，profile 等小快照不该被驱逐 */
const DEFAULT_MAX_AGE = 7 * 24 * 3600 * 1000;   /* 7 天安全网 */
let seq = 0;                                     /* 会话内写入序号：同一毫秒也能比出先后 */

export function cacheKey(...parts) {
  return parts.map((p) => (p == null ? "" : String(p))).join("|");
}

function fullKey(key) { return NS + VERSION + ":" + key; }

function readBox(key) {
  const raw = getItem(fullKey(key));
  if (!raw) return null;
  try {
    const box = JSON.parse(raw);
    if (!box || typeof box !== "object" || typeof box.t !== "number" || !("d" in box)) return null;
    return box;
  } catch (e) { return null; }
}

/** 只取数据，不看新鲜度 —— SWR「先渲染陈旧数据」用 */
export function cachePeek(key) {
  const box = readBox(key);
  return box ? box.d : null;
}

/** TTL 内命中返回数据，超龄/缺失返回 null */
export function cacheGet(key, { maxAge = DEFAULT_MAX_AGE } = {}) {
  const box = readBox(key);
  if (!box) return null;
  if (Date.now() - box.t > maxAge) return null;
  return box.d;
}

export function cacheSet(key, data) {
  if (!key || data == null) return;
  try { setItem(fullKey(key), JSON.stringify({ t: Date.now(), s: ++seq, d: data })); }
  catch (e) { return; /* 序列化失败就放弃这一条 */ }
  prune();
}

/** 按业务前缀清理（如 "dm:"、"notif:"）；不传 = 清空整个缓存命名空间 */
export function cacheDrop(prefix) {
  const head = NS + VERSION + ":" + (prefix || "");
  for (const k of keys(head)) removeItem(k);
}

/**
 * 就地补丁一份缓存（数组）。
 * 用途：本地已经知道「某条记录变了」（如刚发出一条消息 → 该会话的预览/时间变了），
 * 但服务端整包还没回来。此时把变化**直接写回缓存快照**，下次读缓存即命中新值，
 * 不必等一次完整网络刷新（否则用户返回列表时看到的是旧预览）。
 * @param {string} key 缓存键
 * @param {(arr:any[])=>any[]} patch 纯函数：接收旧数组，返回新数组
 */
export function cachePatch(key, patch, { createIfMissing = false } = {}) {
  if (!key || typeof patch !== "function") return;
  const cur = cachePeek(key);
  const base = Array.isArray(cur) ? cur.slice() : null;
  if (!base && !createIfMissing) return;
  let next;
  try { next = patch(base || []); } catch (e) { return; }
  if (!Array.isArray(next)) return;
  cacheSet(key, next);
}

/**
 * 就地合并一份**对象**缓存（对象合并版 cachePatch）。
 * 用途：详情页点赞/收藏是「开关型」局部变更（liked / marked / like_count），
 * 整篇重拉不划算（跨境慢），也不该只改内存（下次进来又变回旧样）。
 * 这里把变更直接写回快照，下一次读缓存即命中新值。
 * @param {string} key 缓存键
 * @param {Object} patch 要合并的字段（浅合并；值为 undefined 的字段忽略）
 */
export function cacheMerge(key, patch) {
  if (!key || !patch || typeof patch !== "object" || Array.isArray(patch)) return;
  const cur = cachePeek(key);
  const base = cur && typeof cur === "object" && !Array.isArray(cur) ? { ...cur } : {};
  let changed = false;
  for (const k of Object.keys(patch)) {
    if (patch[k] === undefined) continue;
    if (base[k] !== patch[k]) changed = true;
    base[k] = patch[k];
  }
  if (!changed && cur) return;   /* 无变化就别白写一次（省掉一次序列化 + 淘汰记账） */
  cacheSet(key, base);
}

/* 容量护栏：超出上限按写入时间淘汰最旧（顺手清掉解析失败的残骸） */
function prune() {
  const head = NS + VERSION + ":";
  const all = [];
  for (const k of keys(head)) {
    const raw = getItem(k);
    if (!raw) { removeItem(k); continue; }
    try {
      const box = JSON.parse(raw);
      if (!box || typeof box.t !== "number") { removeItem(k); continue; }
      all.push({ k, t: box.t, s: typeof box.s === "number" ? box.s : 0 });
    } catch (e) { removeItem(k); }
  }
  if (all.length <= CACHE_MAX_ENTRIES) return;
  all.sort((a, b) => (a.t - b.t) || (a.s - b.s));
  for (const x of all.slice(0, all.length - CACHE_MAX_ENTRIES)) removeItem(x.k);
}

/**
 * 本地优先读取（stale-while-revalidate）：
 *  - 有缓存 → 立刻 hooks.cached(cached)（页面先渲染，调用方把「载入中」关掉），随后后台拉取；
 *  - 后台成功且与缓存不同 → hooks.fresh(fresh) + 回写缓存；相同 → 不触发（避免无谓重渲染）；
 *  - 后台失败 → 有缓存就静默保留（陈旧好过白屏）；无缓存才走 hooks.onError（与原行为一致）；
 *  - fetcher 返回 null（如 cloudFetchPosts 的失败语义）→ 不覆盖、不回写。
 * @returns {Promise<boolean>} 是否命中缓存（调用方可用来决定首屏要不要显示骨架）
 */
export async function swr(key, hooks, fetcher, { maxAge = DEFAULT_MAX_AGE } = {}) {
  const hit = key ? cachePeek(key) : null;
  const has = hit != null;
  if (has && hooks && hooks.cached) {
    try { hooks.cached(hit); } catch (e) { /* 缓存渲染失败按无缓存走 */ }
  }
  let fresh = null;
  try { fresh = await fetcher(); }
  catch (e) {
    if (!has && hooks && hooks.onError) hooks.onError(e);
    return has;
  }
  if (fresh == null) return has;
  if (key) cacheSet(key, fresh);
  const same = has && JSON.stringify(fresh) === JSON.stringify(hit);
  if (!same && hooks && hooks.fresh) {
    try { hooks.fresh(fresh); } catch (e) { /* 渲染失败下次轮询再纠正 */ }
  }
  return has;
}