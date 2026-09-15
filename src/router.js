import { createRouter, createWebHistory } from "vue-router";
import HomeView from "./views/HomeView.vue";

/* 其余页面按需加载：首屏更快，重依赖不阻塞首页 */
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", name: "home", component: HomeView },
    { path: "/pet", name: "pet", component: () => import("./views/PetView.vue") },
    { path: "/community", name: "community", component: () => import("./views/CommunityView.vue") },
    { path: "/profile", name: "profile", component: () => import("./views/ProfileView.vue") },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});

/* 旧 hash 链接兼容：/#/pet 等一次性 replace 到 /pet（不污染历史记录） */
if (typeof window !== "undefined" && window.location.hash.startsWith("#/")) {
  router.replace(window.location.hash.slice(1)).catch(() => {});
}
