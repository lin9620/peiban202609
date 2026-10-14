/* ═══ 单飞合并（进行中的同 key 请求共享同一个 Promise）═══
 * 预热（App.vue）与界面（视图）会对同一接口各发一次请求——不合并就是双份流量 +
 * 竞态覆盖。这里把**正在进行**的同 key 请求合并：预热发的那次就是界面等到的那次。
 * 只合并在途请求：不缓存、不写存储、不复用**已完成**的结果（一切以服务端此刻返回为准）。 */
const flights = new Map();
export function singleFlight(key, fn) {
  const hit = flights.get(key);
  if (hit) return hit;
  const p = Promise.resolve().then(fn).finally(() => { flights.delete(key); });
  flights.set(key, p);
  return p;
}
