/* 心情日历跨设备同步规则（纯函数，Node 单测直跑）
 * ------------------------------------------------------------
 * 心情打卡存在 petStore 的 moodLog 里，键是 dateKey()（如 2026-11-2），值是 0~4。
 * 云端 pets.state 里带一份 moods；两台设备各自打过卡后，不能简单「整包后写胜」：
 * 同一天通常只有一条，但不同日期必须取并集，否则会把另一台设备的记录冲掉。
 *
 * 冲突口径：同一天两台设备都有记录 → 默认保留本地（用户正在看的这台），
 * 云档更新时间更晚时由调用方传 preferCloud=true 让云端胜。
 */

const DAY_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;

/** 只保留合法日期键 + 0~4 的整数；脏数据/数组/字符串一律丢弃，绝不抛错。 */
export function normMoodLog(input) {
  const src = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const out = {};
  for (const key of Object.keys(src)) {
    const m = DAY_RE.exec(key);
    if (!m) continue;
    /* 正则只能保证「数字形状」，还要挡 2026-13-1 / 2026-2-31 这类越界日期 */
    const y = Number(m[1]), mo = Number(m[2]), day = Number(m[3]);
    const d = new Date(y, mo - 1, day);
    if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== day) continue;
    const n = Number(src[key]);
    if (!Number.isInteger(n) || n < 0 || n > 4) continue;
    out[key] = n;
  }
  return out;
}

/**
 * 合并本机与云端心情记录（并集）。
 * @param {object} local 本机 moodLog
 * @param {object} cloud 云端 state.moods
 * @param {boolean} preferCloud 同一天冲突时是否云端优先（云档更新时间更晚）
 * @returns {object} 新对象，不修改入参
 */
export function mergeMoodLogs(local, cloud, preferCloud = false) {
  const l = normMoodLog(local);
  const c = normMoodLog(cloud);
  const out = { ...l };
  for (const key of Object.keys(c)) {
    if (out[key] === undefined || preferCloud) out[key] = c[key];
  }
  return out;
}

/** 两份 moodLog 是否等价（忽略键顺序；脏值先归一化）。 */
export function sameMoodLog(a, b) {
  const l = normMoodLog(a);
  const c = normMoodLog(b);
  const lk = Object.keys(l);
  const ck = Object.keys(c);
  if (lk.length !== ck.length) return false;
  return lk.every((key) => l[key] === c[key]);
}
