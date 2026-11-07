/* 评论数批量调度（轮 460）
 * ---------------------------------------------------------------------------
 * 「我的帖子」/「我的」页一屏十几张帖子卡，如果每张卡各自 cloudFetchCommentCounts([id])，
 * 进页就是十几个并发请求（跨境 RTT 高的场景下还会互相抢连接）。
 * 这里把同一轮事件循环里所有卡要的 id 合并成**一次**批量请求，回来再逐个分发；
 * 结果带 60s 缓存，「展开→收起→再展开」不会重复打网络。
 *
 * 与暖心墙的关系：暖心墙是拿到整页帖子后一次性批量拉（wall.js 的同一支函数），
 * 口径完全相同 —— 这里只是把「一屏多个独立组件」也收敛成一次请求。
 */
import { cloudFetchCommentCounts } from "./wall.js";

const TTL = 60_000;
const cache = new Map();      /* dbId -> { n, at } */
const waiters = new Map();    /* dbId -> [resolve] */
let scheduled = false;

export function peekCommentCount(id) {
  if (id == null) return undefined;
  const hit = cache.get(id);
  return hit && Date.now() - hit.at < TTL ? hit.n : undefined;
}

export function setCommentCount(id, n) {
  if (id == null) return;
  cache.set(id, { n: Number(n) || 0, at: Date.now() });
}

/** 要某帖的评论数：命中缓存同步给，否则排队等这一轮合并请求 */
export function requestCommentCount(id) {
  return new Promise((resolve) => {
    if (id == null) { resolve(undefined); return; }
    const hit = peekCommentCount(id);
    if (hit !== undefined) { resolve(hit); return; }
    const arr = waiters.get(id) || [];
    arr.push(resolve);
    waiters.set(id, arr);
    if (!scheduled) {
      scheduled = true;
      Promise.resolve().then(flush);
    }
  });
}

async function flush() {
  scheduled = false;
  const ids = [...waiters.keys()];
  const batch = new Map(waiters);
  waiters.clear();
  if (!ids.length) return;
  let counts = null;
  try { counts = await cloudFetchCommentCounts(ids); } catch (e) { counts = null; }
  for (const id of ids) {
    const raw = counts ? counts[id] : undefined;
    /* 拿不到（断网 / 未登录）就传 undefined：组件保留自己的本地口径，不硬写 0 */
    const n = raw == null ? undefined : Number(raw) || 0;
    if (n !== undefined) setCommentCount(id, n);
    for (const fn of batch.get(id) || []) fn(n);
  }
}
