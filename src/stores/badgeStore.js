/* 全局未读状态（阶段 4：私信 + 通知中心的导航角标）
 * ------------------------------------------------------------
 * 智能轮询策略（与 main.js 的可见性感知惯例一致）：
 *   - 登录后启动；未登录 / 云端不可用 → 全 0 且不轮询；
 *   - 页面可见时：未读 30s 一次；切到后台暂停；回到前台立即刷一次；
 *   - 每次失败退避 ×2（上限 5 分钟），成功后恢复 30s；
 *   - store 只存数字，去重 / 兜底在 notifyRules.normUnread 与 dm 侧 RPC。
 * 视图层（App.vue 角标、MessagesView、NotificationsView）都读这一个 store。
 */
import { reactive } from "vue";
import { getItem, setItem, removeItem } from "../utils/storage.js";
import { cloud } from "../utils/supabase.js";
import { unreadTotalSafe } from "../utils/dm.js";
import { unreadSafe } from "../utils/notify.js";

export const badge = reactive({
  dm: 0,        // 私信未读（不含消息请求）
  requests: 0,  // 待处理的消息请求
  notif: 0,     // 通知未读（total）
  comments: 0,
  reactions: 0,
  pets: 0,
  system: 0,
  loading: false,
});

/* 角标本地缓存（修「通知那里太慢了」）：上次拉到的未读数先上屏，
 * 网络回来再校正 —— 打开 App 那一刻就有正确的角标，不用等第一轮 RPC。
 * 缓存键按用户域（uid）分开（修「换账号登录还是上个人的角标」）：A 的未读数
 * 只存在 wp-badge-v1:<A 的 uid> 下，B 登录读的是 B 自己的那份。 */
const BADGE_CACHE_KEY = "wp-badge-v1";
let cacheUid = "";        /* 当前缓存归属的 uid（未登录为空 → 不缓存不读取） */

function badgeCacheKey(uid) {
  return uid ? `${BADGE_CACHE_KEY}:${uid}` : "";
}

/** 登录（或换账号）时把该用户上次的角标先上屏；没有缓存就清零 */
function hydrateBadge(uid) {
  cacheUid = uid || "";
  const key = badgeCacheKey(cacheUid);
  const zero = { dm: 0, requests: 0, notif: 0, comments: 0, reactions: 0, pets: 0, system: 0 };
  let raw = null;
  try { raw = key ? JSON.parse(getItem(key)) : null; } catch (e) { raw = null; }
  const src = raw && typeof raw === "object" ? raw : zero;
  badge.dm = Math.max(0, src.dm || 0);
  badge.requests = Math.max(0, src.requests || 0);
  badge.notif = Math.max(0, src.notif || 0);
  badge.comments = Math.max(0, src.comments || 0);
  badge.reactions = Math.max(0, src.reactions || 0);
  badge.pets = Math.max(0, src.pets || 0);
  badge.system = Math.max(0, src.system || 0);
}

let timer = null;
let backoff = 1;        // 失败退避倍数
const BASE_MS = 30000;
const MAX_MS = 300000;

function apply(dm, notif) {
  badge.dm = Math.max(0, (dm && dm.total) || 0);
  badge.requests = Math.max(0, (dm && dm.requests) || 0);
  badge.notif = Math.max(0, (notif && notif.total) || 0);
  badge.comments = Math.max(0, (notif && notif.comments) || 0);
  badge.reactions = Math.max(0, (notif && notif.reactions) || 0);
  badge.pets = Math.max(0, (notif && notif.pets) || 0);
  badge.system = Math.max(0, (notif && notif.system) || 0);
  /* 写入缓存：只是几个数字（无隐私内容），下次冷启动当首屏兜底；
   * 按 uid 分开存，换账号不会把上一个人的角标带出来；登出时 stopBadge 会清掉。 */
  const key = badgeCacheKey(cacheUid);
  if (!key) return;
  try {
    setItem(key, JSON.stringify({
      dm: badge.dm, requests: badge.requests, notif: badge.notif,
      comments: badge.comments, reactions: badge.reactions,
      pets: badge.pets, system: badge.system,
    }));
  } catch (e) { /* 写不进就算了 */ }
}

/** 刷一次（页面回前台 / 发消息后 / 读通知后都可手动触发）。返回是否成功（供退避用） */
export async function refreshBadge() {
  if (badge.loading) return true;
  badge.loading = true;
  let ok = true;
  try {
    const [dm, notif] = await Promise.all([
      unreadTotalSafe(), unreadSafe(),
    ]);
    apply(dm, notif);
    /* 云端不可用时两个 safe 包装都给 0 —— 那时不算失败，别退避（未登录是常态） */
    ok = !!(dm && notif);
  } catch (e) {
    ok = false; // 静默：角标轮询绝不让页面报错
  } finally {
    badge.loading = false;
  }
  return ok;
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    if (typeof document !== "undefined" && document.hidden) {
      schedule(); // 后台：不发请求，但保持节拍
      return;
    }
    const ok = await refreshBadge();
    backoff = ok ? 1 : Math.min(backoff * 2, MAX_MS / BASE_MS);
    schedule();
  }, BASE_MS * backoff);
}

/** 登录后调用一次即可；登出时 stopBadge() */
export function startBadge() {
  /* 进 App 的第一件事：把「这个 uid 上次的角标」先上屏（本地缓存，0ms 就有数字），
   * 再让 refreshBadge() 去云端校正。换账号后 uid 变了 → 读的是新账号自己那份。 */
  const uid = (cloud.user && cloud.user.id) || "";
  if (uid !== cacheUid) hydrateBadge(uid);
  if (timer) return;
  refreshBadge();
  schedule();
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisible);
  }
}

export function stopBadge() {
  clearTimeout(timer);
  timer = null;
  if (typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", onVisible);
  }
  badge.dm = 0; badge.requests = 0; badge.notif = 0;
  badge.comments = 0; badge.reactions = 0; badge.pets = 0; badge.system = 0;
  /* 登出：只清掉这位用户的角标缓存 —— 换账号登录时，新 uid 读的是它自己的那份，
   * 不会把上一个人的未读数带出来，同时也不会误删同设备其它账号的缓存。 */
  const key = badgeCacheKey(cacheUid);
  cacheUid = "";
  if (key) { try { removeItem(key); } catch (e) { /* 忽略 */ } }
}

function onVisible() {
  if (typeof document !== "undefined" && !document.hidden) refreshBadge();
}
