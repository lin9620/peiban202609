/* 按日期轮换取内容：一年内第几天 % 内容长度 */

export function dayOfYear() {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 0);
  return Math.floor((now - start) / 86400000);
}

export function dayIndex(len) {
  return dayOfYear() % Math.max(1, len);
}

export function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
