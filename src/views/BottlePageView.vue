<!-- 轮 133 · 漂流瓶独立页（/bottle，清单 #26）——桌面左侧导航直达
 * 复用 BottleView 全量功能；记录里点已建立会话的信 → 跳 /messages/:id 进聊天。
 * 未登录显示引导卡（与其它页的降级口径一致）。 -->
<script setup>
import { computed } from "vue";
import { useRouter } from "vue-router";
import { NButton } from "naive-ui";
import { t } from "../i18n.js";
import { cloud } from "../utils/supabase.js";
import BottleView from "../components/BottleView.vue";

const router = useRouter();
const signedIn = computed(() => !!(cloud.ready && cloud.user));

function openBottleChat(id) {
  router.push("/messages/" + id);
}
</script>

<template>
  <div class="bottle-page">
    <section v-if="!signedIn" class="card bottle-guest">
      <p class="sub">{{ t("bottle.needSignIn") }}</p>
      <n-button type="primary" round @click="router.push('/login')">{{ t("profile.goSignIn") }}</n-button>
    </section>
    <BottleView v-else @open="openBottleChat" />
  </div>
</template>

<style>
/* 轮 137（用户截图：内容盒窄、两侧大空洞）：桌面壳自轮 133 起是流式，
 * 页面容器不该再自行收窄居中——铺满左导航(92)与右栏(240)之间整块宽度。
 * 窄屏/App 形态不受影响（视口 <900px 时 900 的 max-width 本就触不到）。 */
.bottle-page { max-width: 900px; margin: 0 auto; }
@media (min-width: 900px) { .bottle-page { max-width: none; } }
.bottle-guest { text-align: center; display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 34px 20px; }
</style>
