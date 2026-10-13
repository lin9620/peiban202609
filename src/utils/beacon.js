/* 轮 256 · 无声错误信标（error beacon）
 * ------------------------------------------------------------
 * 为什么要有它：App.vue 的错误边界会把未捕获异常盖成「这里好像有点小状况」——
 * 用户看得见一行提示，开发者这边什么都看不见（轮 42 TDZ 白屏、轮 80 陈旧 dist
 * 两次线上事故都是用户报障才发现的）。这里把 window 的未捕获错误 / 未处理
 * Promise 拒绝，静默 POST 给 Worker 的 /api/client-log；Worker 只落一行 JSON
 * 日志（Workers Logs / wrangler tail 可见），不入库、不回显。
 *
 * 隐私口径：只带 消息 / 路由 / 类型 / 截断堆栈 / UA，不带任何用户数据与 cookie；
 * 客户端限流：每次页面加载最多 5 条，防死循环刷爆。
 * 任何一步失败都吞掉——信标自己绝不能成为新的报错源。
 */

const MAX_PER_PAGE = 5;
let sent = 0;

function report(kind, msg, stack) {
  try {
    if (sent >= MAX_PER_PAGE) return;
    sent++;
    const payload = {
      kind, /* err | rej */
      msg: String(msg || "").slice(0, 300),
      route: String(location.pathname || "").slice(0, 120),
      stack: String(stack || "").slice(0, 1200),
      ua: String(navigator.userAgent || "").slice(0, 160),
      ts: Date.now(),
    };
    /* sendBeacon 兜底：页面卸载过程中也能送达；不行再 fetch keepalive */
    const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
    if (navigator.sendBeacon && navigator.sendBeacon("/api/client-log", blob)) return;
    fetch("/api/client-log", {
      method: "POST",
      body: JSON.stringify(payload),
      keepalive: true,
      headers: { "content-type": "application/json" },
    }).catch(() => {});
  } catch (e) { /* 信标自身异常绝不外抛 */ }
}

export function installErrorBeacon() {
  try {
    window.addEventListener("error", (e) => {
      report("err", (e && e.message) || "error", e && e.error && e.error.stack);
    });
    window.addEventListener("unhandledrejection", (e) => {
      const r = e && e.reason;
      report("rej", (r && (r.message || r.reason || r.error)) || "rejection", r && r.stack);
    });
  } catch (e) { /* 非浏览器环境忽略 */ }
}
