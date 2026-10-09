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
 *
 * 轮 154 修正（用户反馈「在排行榜点返回，跑到了漂流瓶」）：
 * 原实现 registerListener 是 async 的，onMounted 里 await 之后才真正挂上。
 * 用户从发现页点「排行榜」进来时，手指/系统返回键的操作时机可能早于监听就绪
 * （页面刚渲染、手势还在收尾），那一次事件就掉进 App.vue 的兜底 → history.back()，
 * 而历史栈上一项正是"首页漂流瓶联" → 表现为"返回跑去了漂流瓶"。
 *
 * 现在改为 sync fire-and-forget + 三条纪律：
 *   1. 桩 handle 立刻赋值，onBeforeUnmount 无论如何都能摘掉（不会泄漏）；
 *   2. ready 标志：挂载完成前的 backButton 事件不处理、交回系统（不 replace、
 *      也不让 App.vue 兜底乱跳）——极端窄窗口下宁可不动，也不跳到陌生页面；
 *   3. 真监听就绪后把 ready 置 true，之后一切照旧 replace 回 /story。
 */
import { onMounted, onBeforeUnmount, ref } from "vue";
import { App as CapApp } from "@capacitor/app";

export function useStoryBack(router, to = "/story") {
  /* 监听是否已经真正挂上（App 端 addListener 是异步的）。桌面/网页端恒 false 也不影响，
     因为那里没有 backButton 事件源。 */
  const ready = ref(false);
  /* 桩 handle：addListener 还没 resolve 时先占位，保证卸载一定能摘掉 */
  const stub = () => { try { stub.removed = true; } catch (e) {} };
  stub.removed = false;
  let handle = stub;
  let alive = true;

  function go() {
    router.replace(to).catch(() => {});
  }
  function detach() {
    const h = handle;
    handle = stub;
    if (h && h !== stub && typeof h.remove === "function") h.remove().catch(() => {});
  }
  onMounted(() => {
    /* 同步发起、不 await：把"挂监听"这一步提前到本轮微任务里，缩小事件丢失窗口 */
    let p = null;
    try {
      p = CapApp.addListener("backButton", () => {
        /* 未就绪 —— 不吞事件：直接返回让系统/App.vue 走默认逻辑，避免"按了没反应"；
           就绪后才由本模块 replace 回 /story。 */
        if (!ready.value) return;
        detach();          /* 先摘监听再跳转：否则 replace 触发卸载时，App.vue 兜底会收到同一次事件 */
        go();
      });
    } catch (e) { /* 网页调试没有该插件 */ return; }
    Promise.resolve(p).then((h) => {
      if (!h) return;
      if (!alive || stub.removed) { h.remove().catch(() => {}); return; }  /* 组件已卸载：立刻摘 */
      handle = h;
      ready.value = true;
    }).catch(() => {});
  });
  onBeforeUnmount(() => {
    alive = false;
    stub.removed = true;   /* 让迟到的 addListener resolve 自己摘掉（见上面的 .then） */
    detach();
  });
  return { storyBack: go, ready, detach };
}