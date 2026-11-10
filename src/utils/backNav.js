/* ═══ 轮 493 · 把 backPlan 的决策接到真实的 router / 原生 App 上 ═══
 *
 * 纯决策在 utils/backPlan.js（Node 可直接单测，不碰 router 也不碰 Capacitor）；
 * 这里只负责三件事：读当前路由状态、执行决策、把「再按一次退出」的轻提示交回调用方。
 *
 * 为什么不用 window.history.length 判断「还有没有上一页」：
 *   WebView 里这个值从来不准（Chrome 有时恒为 1、有时把 replace 也算进去），
 *   而且它算的是整个 WebView 历史，不是"本次打开 App 里我走过哪儿"。
 *   vue-router 4 自己在 history.state 里维护 back/current/position，才是权威。
 */
import { App as CapApp } from "@capacitor/app";
import { planBack, normPath, EXIT_HINT_WINDOW } from "./backPlan.js";

/* history.state.back 是"上一页的 URL"。只有站内路径才认 —— App 内正常不会有外链，
 * 但谷歌登录那一套用了系统浏览器/自定义 scheme，保险起见挡一层。 */
function internalBack(router) {
  const st = (router.options && router.options.history && router.options.history.state) || null;
  const back = st && st.back;
  if (typeof back !== "string" || back.charAt(0) !== "/") return null;
  return back;
}

export function createBackNav(router, { onHint } = {}) {
  let lastHintAt = 0;

  /* run({ allowExit }): 执行一次返回。返回决策对象，方便上层打点/单测断言。
   *   allowExit=true  系统返回键（到首页后可以退到桌面，双击才退）
   *   allowExit=false 页面内的 ← 钮（到首页就停住，绝不退出 App） */
  function run({ allowExit = true } = {}) {
    const cur = router.currentRoute.value || {};
    const plan = planBack({
      path: cur.path || "/",
      back: internalBack(router),
      backTo: (cur.meta && cur.meta.backTo) || "",
      backMode: (cur.meta && cur.meta.backMode) || "history",
      allowExit,
      now: Date.now(),
      lastHintAt,
      hintWindow: EXIT_HINT_WINDOW,
    });

    switch (plan.action) {
      case "history":
        router.back();
        break;
      case "replace":
        router.replace(plan.to).catch(() => {});
        break;
      case "hint":
        lastHintAt = Date.now();
        if (onHint) onHint();
        break;
      case "minimize":
        lastHintAt = 0;
        try {
          const p = CapApp.minimizeApp();
          if (p && typeof p.catch === "function") p.catch(() => {});
        } catch (e) { /* 网页调试没有该插件 */ }
        break;
      default:
        break;   /* "none"：什么都不做 */
    }
    return plan;
  }

  return { run, reset: () => { lastHintAt = 0; } };
}

/* 页面内「←」按钮用的简易口径（轮 495）：
 *   有上一页 → 回上一页（从哪进来就回哪，位置也留着）；没有 → replace 到 fallback。
 *
 * 为什么不用 createBackNav().run()：那条路带「再按一次退出 / 回首页」等系统键语义，
 * 页面内的 ← 不该退到桌面、也不该把 Tab 根拉回首页。这里只要「上一页」一件事。
 * 判断和 backPlan 同源（normPath 归一），避免 /zh 别名或 ?tab= 造成的键对不上。 */
export function backOr(router, fallback = "/") {
  const cur = normPath((router.currentRoute.value && router.currentRoute.value.path) || "/");
  const back = internalBack(router);
  if (back && normPath(back) !== cur) {
    router.back();
    return true;
  }
  router.replace(fallback).catch(() => {});
  return false;
}
