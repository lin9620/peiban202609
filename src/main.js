import { createApp } from "vue";
import App from "./App.vue";
import { router } from "./router.js";
import { initPet, tickPet, savePet, tickAdventure } from "./stores/petStore.js";
import { initUserScope } from "./utils/userScope.js";
import "./style.css";

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

/* 兜底错误处理：记录日志，避免未捕获异常导致整页白屏 */
app.config.errorHandler = (err, instance, info) => {
  console.error("[Warm Paws] 渲染出错 (" + info + ")：", err);
};

app.use(router).mount("#app");

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
