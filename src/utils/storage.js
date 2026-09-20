/* 安全的本地存储封装
 * 浏览器隐私模式 / Tracking Prevention 拦截存储时，localStorage 访问会抛异常，
 * 导致模块初始化或组件渲染失败（表现为整页白屏）。这里统一降级为内存存储。 */

const memory = new Map();

function probe() {
  try {
    const k = "__wp_probe__";
    window.localStorage.setItem(k, "1");
    window.localStorage.removeItem(k);
    return true;
  } catch (e) {
    return false;
  }
}

const usable = typeof window !== "undefined" && probe();

export const storageAvailable = usable;

export function getItem(key) {
  if (usable) {
    try { return window.localStorage.getItem(key); } catch (e) { /* 降级 */ }
  }
  return memory.has(key) ? memory.get(key) : null;
}

export function setItem(key, value) {
  memory.set(key, String(value));
  if (usable) {
    try { window.localStorage.setItem(key, String(value)); } catch (e) { /* 降级 */ }
  }
}

export function removeItem(key) {
  memory.delete(key);
  if (usable) {
    try { window.localStorage.removeItem(key); } catch (e) { /* 降级 */ }
  }
}

export function getJSON(key, fallback) {
  const raw = getItem(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch (e) { return fallback; }
}

export function setJSON(key, value) {
  try { setItem(key, JSON.stringify(value)); } catch (e) { /* 忽略 */ }
}

/* 按前缀枚举 key（本地缓存清理用）。存储不可用时只看内存镜像。 */
export function keys(prefix = "") {
  const out = [];
  if (usable) {
    try {
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (k && k.startsWith(prefix)) out.push(k);
      }
      return out;
    } catch (e) { /* 降级走内存 */ }
  }
  for (const k of memory.keys()) if (k.startsWith(prefix)) out.push(k);
  return out;
}
