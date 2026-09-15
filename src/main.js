import { createApp } from "vue";
import App from "./App.vue";
import { router } from "./router.js";
import { initPet, tickPet, savePet, tickAdventure, tickMailbox } from "./stores/petStore.js";
import "./style.css";

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

/* 全局心跳：每秒结算状态，每 30 秒自动存档，关闭页面前再存一次 */
setInterval(() => {
  try { tickPet(); } catch (e) { console.error("[Warm Paws] tickPet 出错：", e); }
  try { tickAdventure(); } catch (e) { console.error("[Warm Paws] tickAdventure 出错：", e); }
  try { tickMailbox(); } catch (e) { console.error("[Warm Paws] tickMailbox 出错：", e); }
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
