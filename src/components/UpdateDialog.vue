<!-- 轮 297 · App 更新提示弹窗 ------------------------------------------------
     只在 App 壳里自动弹（网页端刷新即最新，提示更新毫无意义 —— 见 utils/appVersion.js 铁律 2）。
     force=true 时**不可关**：没有取消按钮、遮罩点不掉、右上角没有 ×，这是「必须升级才能继续用」的语义。
     宽度必须显式给：n-modal 不给 width 会被容器撑满（轮 40 在 BottleView 踩过）。 -->
<script setup>
import { computed, ref, watch, onBeforeUnmount } from "vue";
import { NButton, NModal } from "naive-ui";
import { t } from "../i18n.js";
import { isApp } from "../utils/appVersion.js";
import { pushBack, popBack } from "../stores/uiStore.js";   /* 轮297c：吞系统返回键 */

const props = defineProps({
  show: Boolean,
  /* 当前版本 { code, name } */
  current: { type: Object, default: null },
  /* 服务端最新版本 { code, name, notes, force, apkUrl } —— 见 utils/appVersion.js */
  latest: { type: Object, default: null },
});
const emit = defineEmits(["update:show", "later"]);

const force = computed(() => !!(props.latest && props.latest.force));
const busy = ref(false);

/* 轮297c · 强制更新时把系统返回键也吞掉。
 * 不吞的话：App.vue:165 的 backButton 监听先问拦截栈，没拦住就 router.back() 或
 * minimizeApp() —— 弹窗底下那页会跟着变，看着像「按返回就能绕过更新」。
 * 走 uiStore 现成的 pushBack/popBack 栈，与消息页通知段同一套机制。 */
let swallow = null;
watch(() => props.show, (v) => {
  if (v && force.value) {
    if (!swallow) { swallow = () => true; pushBack(swallow); }
  } else if (swallow) {
    popBack(swallow); swallow = null;
  }
}, { immediate: true });
/* force 是 computed：登记在 show 变化之后才拿到也得补一次；卸载必弹栈 */
watch(force, (f) => {
  if (!props.show) return;
  if (f && !swallow) { swallow = () => true; pushBack(swallow); }
  else if (!f && swallow) { popBack(swallow); swallow = null; }
});
onBeforeUnmount(() => { if (swallow) { popBack(swallow); swallow = null; } });

function close() {
  if (force.value) return;   /* 强制更新不给关 */
  emit("update:show", false);
  emit("later");
}

/* 去更新：App 壳用 @capacitor/browser 打开下载地址（WebView 里直接改 location
 * 往往不触发系统下载）；插件不可用或网页端就退回普通跳转。 */
async function goUpdate() {
  const url = props.latest && props.latest.apkUrl;
  if (!url || busy.value) return;
  busy.value = true;
  try {
    if (isApp()) {
      const { Browser } = await import("@capacitor/browser");
      await Browser.open({ url });
      return;
    }
  } catch (e) { /* 插件缺失/失败 → 落回下面的普通跳转 */ }
  try { window.location.href = url; } catch (e) { /* 极端环境忽略 */ }
}
</script>

<template>
  <n-modal
    :show="show" preset="card" style="width: min(480px, calc(100vw - 32px))"
    :title="t('appUpdate.title')" :closable="!force" :mask-closable="!force"
    @update:show="(v) => { if (!force) emit('update:show', v); }">

    <p class="upd-ver">
      {{ t("appUpdate.versionLine", {
        from: (current && current.name) || "?",
        to: (latest && latest.name) || "?",
      }) }}
    </p>

    <p v-if="force" class="upd-force">{{ t("appUpdate.forceHint") }}</p>

    <div v-if="latest && latest.notes" class="upd-notes">
      <p class="upd-notes-cap">{{ t("appUpdate.notes") }}</p>
      <p class="upd-notes-body">{{ latest.notes }}</p>
    </div>

    <div class="upd-acts">
      <n-button v-if="!force" quaternary size="small" @click="close">{{ t("appUpdate.later") }}</n-button>
      <n-button type="primary" size="small" :loading="busy" @click="goUpdate">{{ t("appUpdate.go") }}</n-button>
    </div>
  </n-modal>
</template>

<style scoped>
.upd-ver { margin: 0 0 10px; font-size: 15px; font-weight: 600; }
.upd-force { margin: 0 0 10px; font-size: 13px; color: var(--accent, #e58a3a); }
.upd-notes {
  margin: 0 0 4px; padding: 8px 12px; border-radius: 10px;
  background: var(--glass, rgba(255, 240, 226, 0.6));
  color: var(--low, #8a7a6a); font-size: 13px;
}
.upd-notes-cap { margin: 0 0 4px; font-weight: 600; }
.upd-notes-body { margin: 0; white-space: pre-wrap; word-break: break-word; }
.upd-acts { display: flex; justify-content: center; gap: 8px; margin-top: 14px; }
</style>
