/* 连点闸门（纯逻辑，Node 单测直跑）
 * ------------------------------------------------------------------
 * 用户实报：同一个「暖暖」连点两下，第一下取消了，过几秒又自己回来。
 * 根因不是单次请求失败，而是两次点击都被当成两次意图：
 *   ① 第二下把第一下的取消又翻回去；
 *   ② 同 key 写队列让第二下要等第一下的网络往返，才出现「过几秒又有了」。
 *
 * 口径（用户拍板 A）：
 *   同一颗按钮 350ms 内的第二下 = 误触，直接丢弃 —— 不改 UI、不进队列、不发请求。
 *   不同 key（抱抱/暖暖/同感、❤️/💔、点赞/收藏……）互不影响。
 *
 * 为什么是时间闸门而不是 disabled：
 *   disabled 会让按钮变灰/卡住，弱网下体感更差；这里按钮外观完全不变，
 *   只在逻辑层丢弃重复点击。第一次点击仍然当场乐观生效。
 */
export function createTapGuard(windowMs = 350) {
  const last = new Map();   /* key → 上次被接受的点击时间 */

  /** 接受这次点击？true = 放行并记时间；false = 350ms 内的重复点击，调用方直接 return */
  function accept(key, now = Date.now()) {
    const prev = last.get(key);
    if (prev != null) {
      const dt = now - prev;
      /* dt < 0 视为时钟回拨：不要因此把用户永久锁住 */
      if (dt >= 0 && dt < windowMs) return false;
    }
    last.set(key, now);
    return true;
  }

  /** 手动释放某个 key（测试/失败重试用；正常点击不需要） */
  function reset(key) {
    last.delete(key);
  }

  function clear() {
    last.clear();
  }

  return { accept, reset, clear };
}
