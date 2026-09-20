/* 写入收敛器：同一把 key 上的「快速连点」写入排队 + 旧响应作废
 * ------------------------------------------------------------------
 * 背景（用户反馈「回应按钮连点两下没反应」）：
 *   云端帖的表态是「先查再写（insert/delete）」，两次点击几乎同时发出时
 *   会并发跑两次查询 → 第二次查到「还没点过」→ 再插一次 → 撞唯一键报错 →
 *   界面回滚成原状，用户看到的就是「点了但什么都没发生」。
 * 另外「先发的请求后返回」也很常见：第一次的响应回来时把用户第二次的意图
 *   覆盖掉，同样表现为「点了没用」。
 *
 * 这个模块把两件事收成纯逻辑（无 Vue、无网络，Node 单测可直跑）：
 *   ① claim(key)      每次点击领一个递增序号（表示「最新意图是谁」）
 *   ② push(key, task) 同 key 串行执行（前一个无论成败都不卡住后一个）
 *   ③ isLatest(key,seq) 响应回来时判断自己是否还是最新一次点击 ——
 *      不是就什么都别改，交给后来的任务收尾。
 * 业务侧只需：claim → 本地乐观更新 → push(落库) → 响应里 isLatest 才回写权威值。
 */
export function createWriteQueue() {
  const tails = new Map();  /* key → 串行链尾 Promise（永远是可继续 then 的已解决态） */
  const seqs = new Map();   /* key → 最新序号 */

  /** 领取序号：每次点击算一次意图 */
  function claim(key) {
    const s = (seqs.get(key) || 0) + 1;
    seqs.set(key, s);
    return s;
  }

  /** 这次响应是否仍属于最新一次点击（否 = 过期，不要回写状态） */
  function isLatest(key, seq) {
    return (seqs.get(key) || 0) === seq;
  }

  /** 串行排队：同 key 一定按调用顺序执行，前一个抛错也不会中断后一个 */
  function push(key, task) {
    const prev = tails.get(key) || Promise.resolve();
    const next = prev.then(() => task(), () => task());
    tails.set(key, next.then(() => {}, () => {}));
    return next;
  }

  return { claim, isLatest, push };
}
