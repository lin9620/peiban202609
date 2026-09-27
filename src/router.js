import { createRouter, createWebHistory } from "vue-router";
import HomeView from "./views/HomeView.vue";

/* 其余页面按需加载：首屏更快，重依赖不阻塞首页 */
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    /* 轮 86：/zh/* 别名 —— 中文预渲染着陆页（dist/zh/**，构建期生成）与 en 页共用同一组件；
     * 语言由 i18n.js 按 location.pathname 强制 zh（只影响本次视图，不覆盖用户语言存档） */
    { path: "/", alias: "/zh", name: "home", component: HomeView },
    { path: "/pet", alias: "/zh/pet", name: "pet", component: () => import("./views/PetView.vue") },
    { path: "/community", alias: "/zh/community", name: "community", component: () => import("./views/CommunityView.vue") },
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
    /* 私信：列表与具体会话同页（/messages/:id 可直链，通知点击跳这里） */
    { path: "/messages", name: "messagesList", component: () => import("./views/MessagesView.vue") },
    { path: "/messages/:id", name: "messages", component: () => import("./views/MessagesView.vue") },
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
