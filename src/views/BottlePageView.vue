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
.bottle-page { max-width: 640px; margin: 0 auto; }
.bottle-guest { text-align: center; display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 34px 20px; }
</style>
