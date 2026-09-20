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
export const CACHE_MAX_ENTRIES = 60;
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