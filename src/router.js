import { createRouter, createWebHistory } from "vue-router";
import { getScroll } from "./utils/scrollMem.js";
import HomeView from "./views/HomeView.vue";

/* 其余页面按需加载：首屏更快，重依赖不阻塞首页 */
export const router = createRouter({
  history: createWebHistory(),
  /* 轮 222 · 知乎式页签回位：组间导航 = 回到记忆位置（vue-router 在 DOM 更新后、绘制前应用，零闪）；
   * 同组原地切换（列表↔会话）= 不动滚动（返回 false）。savedPosition = 系统返回键的前进后退。 */
  scrollBehavior(to, from, savedPosition) {
    if (to.meta && to.meta.grp && from.meta && to.meta.grp === from.meta.grp) return false;
    if (savedPosition) return savedPosition;
    const y = getScroll(to.path);
    return { top: y != null ? y : 0 };
  },
  routes: [
    /* 轮 86：/zh/* 别名 —— 中文预渲染着陆页（dist/zh/**，构建期生成）与 en 页共用同一组件；
     * 语言由 i18n.js 按 location.pathname 强制 zh（只影响本次视图，不覆盖用户语言存档） */
    { path: "/", alias: "/zh", name: "home", component: HomeView },
    { path: "/pet", alias: "/zh/pet", name: "pet", component: () => import("./views/PetView.vue") },
    { path: "/community", alias: "/zh/community", name: "community", component: () => import("./views/CommunityView.vue") },
    /* 轮 133：漂流瓶独立页（桌面左导航直达；手机端仍走首页三联/消息段） */
    { path: "/bottle", name: "bottle", component: () => import("./views/BottlePageView.vue") },
    /* 轮 145 · 故事栏。轮 148 重做：/story = 纯阅读的发现页（取消了原来的投稿|发现|我的 页签壳）。
     * 投稿/我的/排行榜 各拆成独立路由；字面量子路径排在 /story/:id(\d+) 之前，
     * 详情页同时用数字约束（/story/12），双保险避免 "mine" 被当成 id 吞掉。 */
    { path: "/story", name: "story", component: () => import("./views/StoryView.vue") },
    { path: "/story/write", name: "storyWrite", component: () => import("./views/StoryWriteView.vue") },
    { path: "/story/mine", name: "storyMine", component: () => import("./views/StoryMineView.vue") },
    { path: "/story/rank", name: "storyRank", component: () => import("./views/StoryRankView.vue") },
    { path: "/story/:id(\\d+)", name: "storyDetail", component: () => import("./views/StoryDetailView.vue") },
    /* 手机端发帖：底部 ＋ → 独立大输入框页（桌面仍用暖心墙页顶发布框，不进这页） */
    { path: "/compose", name: "compose", component: () => import("./views/ComposeView.vue") },
    /* 我的帖子：暖心墙「我的」区点「更多」进来，10 条一页 + 下拉续载 */
    { path: "/my-posts", name: "myPosts", component: () => import("./views/MyPostsView.vue") },
    /* 帖子详情（轮 19）：/post/:id 独立页 —— 完整帖子 + 评论展开（与暖心墙同款交互）。
     * 我的帖子 / 资料页点卡片进来，不再把用户甩回暖心墙信息流里找帖子。 */
    { path: "/post/:id", name: "postDetail", component: () => import("./views/PostDetailView.vue") },
    { path: "/profile", alias: "/zh/profile", name: "profile", component: () => import("./views/ProfileView.vue") },
    /* 登录页：手机 + 网页共用；?redirect=/x 登录后回跳（Google 往返用 sessionStorage 兜底） */
    { path: "/login", name: "login", component: () => import("./views/LoginView.vue") },
    { path: "/u/:id", name: "waller", component: () => import("./views/WallerView.vue") },
    /* 私信：列表与具体会话同页（/messages/:id 可直链，通知点击跳这里）。
     * 轮 196：meta.grp = 路由过渡 key 分组——同一组件的两条路由必须同 key，
     * 否则 out-in 每次点开会话都整页拆掉重挂（懒加载组件每次导航都是新对象，
     * 按组件身份做 key 救不了：线上逐帧实测 key 序列 c1→c2→c3），= 用户反复报的进会话跳闪。 */
    { path: "/messages", name: "messagesList", meta: { grp: "messages" }, component: () => import("./views/MessagesView.vue") },
    { path: "/messages/:id", name: "messages", meta: { grp: "messages" }, component: () => import("./views/MessagesView.vue") },
    /* 通知中心 */
    { path: "/notifications", name: "notifications", component: () => import("./views/NotificationsView.vue") },
{ path: "/settings", name: "settings", component: () => import("./views/SettingsView.vue") },
    { path: "/admin", name: "admin", component: () => import("./views/AdminView.vue") },
    /* 隐私政策：Google OAuth 发布需要可公开访问的政策链接（外部审核会来抓这页） */
    { path: "/privacy", alias: "/zh/privacy", name: "privacy", component: () => import("./views/PrivacyView.vue") },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});

/* 旧 hash 链接兼容：/#/pet 等一次性 replace 到 /pet（不污染历史记录） */
if (typeof window !== "undefined" && window.location.hash.startsWith("#/")) {
  router.replace(window.location.hash.slice(1)).catch(() => {});
}
