/* ═══ 单飞合并（进行中的同 key 请求共享同一个 Promise）═══
 * 预热（App.vue）与界面（视图）会对同一接口各发一次请求——不合并就是双份流量 +
 * 竞态覆盖。这里把**正在进行**的同 key 请求合并：预热发的那次就是界面等到的那次。
 * 只合并在途请求：不缓存、不写存储、不复用**已完成**的结果（一切以服务端此刻返回为准）。
 * 轮 338：补 dropFlight —— 上层给请求加了超时，超时后必须把这趟飞行扔掉，
 * 否则用户点「重试」拿到的还是同一个卡住的 Promise（等于没重试）。
 * 清理时比对身份：老请求晚到的 finally 不许删掉同 key 的新飞行。 */
const flights = new Map();
export function singleFlight(key, fn) {
  const hit = flights.get(key);
  if (hit) return hit;
  const p = Promise.resolve().then(fn).finally(() => {
    if (flights.get(key) === p) flights.delete(key);
  });
  flights.set(key, p);
  return p;
}
/** 丢弃一趟在途飞行（超时后用）：下一次同 key 调用会真的重新发请求 */
export function dropFlight(key) {
  flights.delete(key);
}
