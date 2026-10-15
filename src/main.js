import { createApp } from "vue";
import Vant from "vant";
import "vant/lib/index.css";
import { Capacitor } from "@capacitor/core";
import App from "./App.vue";
import UpdateDialog from "./components/UpdateDialog.vue";   /* 轮 297 */
import { router } from "./router.js";
import { initPet, tickPet, savePet, tickAdventure } from "./stores/petStore.js";
import { initUserScope } from "./utils/userScope.js";
import { installErrorBeacon } from "./utils/beacon.js";
import { isApp, checkForUpdate, takePromptOnce } from "./utils/appVersion.js";   /* 轮 297 */
import "./style.css";

/* 轮 38：启动页显示的权威判据。
 * index.html 的 head 脚本只能靠 UA / 注入对象猜（轮 30 就是只看 UA 里的 "capacitor"，
 * 而 Android 的 WebView UA 根本没这个串 → App 端启动页消失）。这里用 Capacitor 自己的
 * isNativePlatform()（与 stores/uiStore.js 的 isApp 同源）兜住：是原生壳就确保
 * html.cap-app 在挂载前加上（此时才可能显示启动页；底色同为米色，视觉无缝）。 */
try {
  if (Capacitor.isNativePlatform()) {
    document.documentElement.classList.add("cap-app");
  }
} catch (e) { /* 非 Capacitor 环境忽略 */ }

/* 轮 256：无声错误信标——未捕获异常/未处理拒绝 POST 给 Worker /api/client-log，
 * 否则错误边界把崩溃盖成「小状况」提示，开发者这边一无所知（轮 42/80 两次事故的盲区）。 */
installErrorBeacon();

/* 轮 32：先把「升级前的无域老存档」搬进 guest 域（各模块已在本文件 import 时注册好
 * 个人键与 reload 钩子，搬完会就地重读），再读档 —— 顺序不能反，否则首次升级加载丢档 */
initUserScope();

/* 读档 + 离线结算（必须在挂载前执行，否则宠物栏为空） */
try {
  initPet();
} catch (e) {
  console.error("[Warm Paws] 初始化宠物数据失败：", e);
}

const app = createApp(App);
app.use(Vant);   /* 轮 191：App 端组件全量 Vant */   /* 轮 189：App 端组件全量换 Vant（移动端标准件） */

/* 兜底错误处理：记录日志，避免未捕获异常导致整页白屏 */
app.config.errorHandler = (err, instance, info) => {
  console.error("[Warm Paws] 渲染出错 (" + info + ")：", err);
};

/* ═════════ 轮 297 · 启动后静默检查 App 更新 ═════════
 * · 只在 App 壳里弹：网页端刷新即最新，提示更新毫无意义（appVersion 铁律 2）。
 * · 挂在首屏渲染之后的空闲期：检查更新是锦上添花，绝不抢启动带宽与主线程。
 * · 弹窗用一个独立的小 Vue app 挂到 body 上 —— App.vue 属于另一个 AI 的地面，
 *   这里连一行都不碰（UpdateDialog 只依赖 naive-ui 局部导入 + i18n 纯函数，
 *   不需要 router / 全局状态，独立 app 实例完全够用）。
 * · 任何失败都静默：checkForUpdate 内部绝不抛错，外层再兜一层 try。 */
async function checkAppUpdate() {
  try {
    if (!isApp()) return;                                /* 网页端不弹更新窗 */
    const r = await checkForUpdate();
    if (!r || !r.hasUpdate || !r.latest) return;
    if (!takePromptOnce(r.latest.code)) return;          /* 同版本同会话只提示一次 */
    const host = document.createElement("div");
    document.body.appendChild(host);
    let vm = null;
    const unmount = () => {
      try { if (vm) vm.unmount(); } catch (e) { /* 已卸载 */ }
      try { host.remove(); } catch (e) { /* 已移除 */ }
      vm = null;
    };
    vm = createApp(UpdateDialog, {
      show: true,
      current: r.current,
      latest: r.latest,
      "onUpdate:show": (v) => { if (!v) unmount(); },
      onLater: unmount,
    });
    vm.mount(host);
  } catch (e) { /* 检查更新绝不打扰用户 */ }
}
function scheduleUpdateCheck() {
  const run = () => { checkAppUpdate(); };
  try {
    /* 与 App.vue 的 chunk 预热同款节奏：空闲才跑，4 秒兜底 */
    if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 4000 });
    else setTimeout(run, 3000);
  } catch (e) { setTimeout(run, 3000); }
}

app.use(router).mount("#app");
scheduleUpdateCheck();

/* 轮 219：关掉浏览器的历史滚动接管——新导航条目的内容延迟变高时，Chrome 会把滚动
 * 重置回该条目的初始位置（0）= 用户实测「切页签回来总在顶部」。滚动完全由应用管理
 * （utils/scrollMem.js：离开 rememberScroll，onActivated restoreScroll）。 */
if (typeof history !== "undefined" && "scrollRestoration" in history) {
  history.scrollRestoration = "manual";
}

/* 挂载成功：通知启动看门狗（index.html）清除英文 SEO 占位兜底，并放行后续自动重载 */
try {
  window.__WP_MOUNTED__ = true;
  sessionStorage.removeItem("wp-boot-reload");
} catch (e) { /* 无 sessionStorage 环境忽略 */ }

/* 全局心跳：每秒结算状态，每 30 秒自动存档，关闭页面前再存一次 */
setInterval(() => {
  try { tickPet(); } catch (e) { console.error("[Warm Paws] tickPet 出错：", e); }
  try { tickAdventure(); } catch (e) { console.error("[Warm Paws] tickAdventure 出错：", e); }
}, 1000);

setInterval(() => {
  try { savePet(); } catch (e) { console.error("[Warm Paws] savePet 出错：", e); }
}, 30000);

window.addEventListener("beforeunload", () => {
  try { savePet(); } catch (e) { /* 忽略 */ }
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    try { savePet(); } catch (e) { /* 忽略 */ }
  }
});
