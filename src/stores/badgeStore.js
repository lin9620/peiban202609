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
}

function onVisible() {
  if (typeof document !== "undefined" && !document.hidden) refreshBadge();
}
