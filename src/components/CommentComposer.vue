<!-- 轮 103：统一评论/回复输入弹窗（用户指定：四处输入位全部改成这一个弹窗样式）
 * ------------------------------------------------------------
 * 点「评论 / 回复」→ 底部滑出本面板：☺ @ 图标 + 输入框 + 发送键，发完即走。
 * 全 app 唯一评论输入形态（墙主评/墙回复/详情主评/详情回复共用，样式天然完全一致）。
 * props: show / placeholder / maxlength；emits: send(text) / close。
 * 发送逻辑由父组件接（弹窗只管收集文字），父组件把文字塞进既有 sendCmt 草稿位即可
 * 完整复用云端/本地双路径，零逻辑重复。 -->
<script setup>
import { ref, watch, nextTick } from "vue";
import { NButton, NInput } from "naive-ui";
import { t } from "../i18n.js";

const props = defineProps({
  show: Boolean,
  placeholder: { type: String, default: "" },
  maxlength: { type: Number, default: 200 },
});
const emit = defineEmits(["send", "close"]);

const draft = ref("");
const inputRef = ref(null);

watch(() => props.show, async (v) => {
  if (!v) return;
  draft.value = "";
  await nextTick();
  try { inputRef.value?.focus(); } catch (e) { /* 无焦点环境忽略 */ }
});

function send() {
  const text = draft.value.trim();
  if (!text) return;
  emit("send", text);
  draft.value = "";
  emit("close");
}
</script>

<template>
  <Teleport to="body">
    <transition name="composer-up">
      <div v-if="show" class="composer-mask" @click="close" @touchend.prevent="close">
        <div class="composer-panel" @click.stop @touchend.stop>
          <button class="composer-x" @click.stop="close" aria-label="✕">✕</button>
          <div class="composer-icons" aria-hidden="true">
            <span class="ci-emoji">☺</span><span class="ci-at">@</span>
          </div>
          <div class="composer-row">
            <n-input ref="inputRef" v-model:value="draft" type="textarea"
              :autosize="{ minRows: 1, maxRows: 4 }" :bordered="false"
              :placeholder="placeholder" :maxlength="maxlength"
              @keyup.enter="send" />
            <n-button type="primary" size="small" round @click="send">{{ t("common.send") }}</n-button>
          </div>
        </div>
      </div>
    </transition>
  </Teleport>
</template>

<style>
/* 轮 103：统一评论输入弹窗（全局样式：两个视图共用同一套类名）
 * z-index 必须高于 .tabbar（z-index 未显式设，但 naive-ui 弹层 ~2000+，
 * 底栏 tabbar 是 fixed 元素）—— 用 2000 保险 */
.composer-mask { position: fixed; inset: 0; z-index: 9998; background: rgba(38, 30, 22, .45); }
.composer-panel {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 9999;
  padding: 14px 16px calc(16px + env(safe-area-inset-bottom, 0px));
  background: #fff; border-radius: 18px 18px 0 0;
  box-shadow: 0 -8px 30px rgba(90, 60, 30, .18);
}
.composer-x {
  position: absolute; top: 10px; right: 12px;
  border: none; background: none; font-size: 18px;
  color: var(--ink-faint); cursor: pointer; padding: 4px 8px;
}
.composer-icons { display: flex; gap: 14px; margin-bottom: 8px; }
.composer-icons .ci-emoji, .composer-icons .ci-at {
  font-size: 18px; color: var(--ink-faint); line-height: 1;
}
.composer-row { display: flex; align-items: flex-end; gap: 10px; }
.composer-row .n-input { flex: 1; font-size: 14.5px; }
.composer-row .n-input .n-input__border, .composer-row .n-input .n-input__state-border { display: none; }
.composer-up-enter-active, .composer-up-leave-active { transition: transform .22s ease, opacity .22s ease; }
.composer-up-enter-from, .composer-up-leave-to { transform: translateY(100%); opacity: 0; }
</style>
