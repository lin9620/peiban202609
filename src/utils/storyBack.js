/* 轮 148 · 故事系页面的物理返回键接管。
 *
 * 为什么需要：App.vue 的返回键逻辑是
 *     if (inChat || !ROOT_VIEWS.includes(route.name)) router.back();
 * 而 ROOT_VIEWS = [home, community, messagesList, profile]，不含 story。
 * /story、/story/mine、/story/rank、/story/:id 都是独立路由 → 一律走 router.back()，
 * 回退到浏览历史的上一页 —— 通常是你之前停留的首页今日/漂流瓶联，
 * 表现为「故事详情点返回，跑到今日或漂流瓶去了」。
 *
 * 口径：故事系页面自己拦下 backButton，一律 replace 回 /story 发现页。
 * 用 replace 而非 push：连按多次返回不会在历史里一层层堆叠。
 *
 * 注意：本模块必须在组件里调用（onMounted/onBeforeUnmount 依赖当前实例），
 * 不要提到模块顶层，否则监听会绑到已卸载的实例上。
 */
import { onMounted, onBeforeUnmount } from "vue";
import { App as CapApp } from "@capacitor/app";

export function useStoryBack(router, to = "/story") {
  let handle = null;
  function go() {
    router.replace(to).catch(() => {});
  }
  onMounted(async () => {
    try {
      handle = await CapApp.addListener("backButton", () => {
        /* 先摘监听再跳转：否则 replace 触发卸载时，App.vue 的兜底也会收到同一次事件 */
        if (handle) { handle.remove().catch(() => {}); handle = null; }
        go();
      });
    } catch (e) { /* 网页调试没有该插件 */ }
  });
  onBeforeUnmount(() => {
    if (handle) { handle.remove().catch(() => {}); handle = null; }
  });
  return { storyBack: go };
}