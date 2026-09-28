/* 轮 117 · 侧栏小卡片纯逻辑（不碰 DOM/存储，Node 可单测 → tools/rail-test.mjs） */

/* —— 今日温柔签：按日期确定性抽签（同一天全天同一签，跨天轮换）——
 * FNV-1a 变体：短键快、分布均匀；len<=0 → -1，调用方判负兜底。 */
export function slipIndexFor(dateKey, len) {
  if (!len || len <= 0) return -1;
  let h = 0x811c9dc5;
  const s = String(dateKey || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0; /* 32 位乘法：普通 * 会在 2^53 外丢精度破坏分布 */
  }
  return h % len;
}

/* 取当日签文：非数组/脏条目（zh、en 全空）先滤掉；无签可抽 → null（卡片整块隐藏） */
export function slipFor(slips, dateKey) {
  const arr = Array.isArray(slips) ? slips.filter((x) => x && (x.zh || x.en)) : [];
  const i = slipIndexFor(dateKey, arr.length);
  return i >= 0 ? arr[i] : null;
}

/* 签文收集连击：dateKey 均为 daily.dateKey 口径（"YYYY-M-D"，不补零）。
 * 今天已记 → 原样；昨天记过 → +1；断档/脏数据 → 重置 1。 */
export function bumpSlipStreak(streak, dateKey) {
  const cur = streak && typeof streak === "object" ? streak : {};
  const last = typeof cur.last === "string" ? cur.last : "";
  const count = Number.isInteger(cur.count) && cur.count > 0 ? cur.count : 0;
  if (last === dateKey) return { count: count || 1, last };
  return { count: last && dayDiff(last, dateKey) === 1 ? count + 1 : 1, last: dateKey };
}

/* 两个 "YYYY-M-D" key 相差几天（不补零不能直接 Date.parse，按段拆本地日期）；
 * 任一段非法 → NaN（调用方判非 1）。 */
export function dayDiff(aKey, bKey) {
  const a = String(aKey || "").split("-");
  const b = String(bKey || "").split("-");
  if (a.length < 3 || b.length < 3) return NaN;
  const ta = Date.UTC(+a[0], +a[1] - 1, +a[2]);
  const tb = Date.UTC(+b[0], +b[1] - 1, +b[2]);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return NaN;
  return Math.round((tb - ta) / 86400000);
}

/* —— 陪伴时长：秒 → {h, m}（负数/非数字归 0；侧栏展示用，不存精度）—— */
export function splitHm(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  return { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60) };
}

/* —— 漂流瓶剩余次数：服务端权威 { sent, fished } 只做减法展示。
 * 未登录/脏数据 → 0（卡片由调用方隐藏，不显示假数字）。 */
export function bottleLeft(quota, sendMax, fishMax) {
  const q = quota && typeof quota === "object" ? quota : {};
  const sub = (used, max) =>
    typeof used === "number" && used >= 0 ? Math.max(0, max - used) : 0;
  return { send: sub(q.sent, sendMax), fish: sub(q.fished, fishMax) };
}
