/* 故事系页面的「返回」落点。
 *
 * 轮 148 的实报：App 里详情页返回跑到了首页今日/漂流瓶联。当时的做法是故事系页面
 * **自己再挂一个 backButton 监听**、一律 replace 回 /story。
 *
 * 轮 495 起这条路废弃了，两个原因：
 *  ① 双监听：App.vue 已经统一接管系统返回键，这里再挂一个 = 同一次按键被处理两遍，
 *     后到的那个 replace 会把先到的决策覆盖掉，排查时完全看不出是谁干的；
 *  ② 落点错了：用户原话「点击具体页面，来回切，位置不变，页面不变」——从哪进去就回哪，
 *     而不是不管从哪进都甩到发现页。强制 replace 到 /story 会把「从首页故事联点进来」
 *     的人送到一个他没去过的页面，位置自然也没了。
 *
 * 现在只剩一个函数：**有上一页就回上一页，没有才回 fallback**。
 * 系统返回键由 App.vue → backNav.js 统一处理，这里的返回值只给页面内的 ← 按钮用
 * （手机端详情页不渲染它，桌面端没有物理返回键才需要）。
 */
import { useRouter } from "vue-router";
import { backOr } from "./backNav.js";

export function useStoryBack(routerArg, to = "/story") {
  /* 组件里可能传 router，也可能不传（那就在 setup 里取） */
  const router = routerArg || useRouter();
  const storyBack = () => { backOr(router, to); };
  return { storyBack };
}
