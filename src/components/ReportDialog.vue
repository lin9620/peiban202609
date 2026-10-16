<!-- 举报弹窗（轮 33）：帖子/评论共用；原因单选 + 可选补充说明。
     防刷/去重/评论 ≥3 人自动隐藏都在服务端 report_create RPC 里；
     迁移未执行（PGRST202）时给出「功能还没开启」的温柔提示，不白屏不报英文。 -->
<script setup>
import { ref, watch } from "vue";
import { NButton, NInput, NModal, NRadio, NRadioGroup } from "naive-ui";
import { t } from "../i18n.js";
import { db } from "../utils/api/db.js";
import { cloud } from "../utils/supabase.js";
import TurnstileGate from "../components/TurnstileGate.vue";   /* 轮 311 · P2 */

/* 轮 311 · P2：Turnstile 人机门槛（sitekey 未配置 = 不渲染、token 直通，零打扰）。
 * token 随 body 透传，Worker 侧配了 TURNSTILE_SECRET 才强制 siteverify。 */
const env = import.meta.env || {};
const TS_SITEKEY = String(env.VITE_TURNSTILE_SITEKEY || "").trim();
const tsToken = ref("");
const tsGate = ref(null);

const props = defineProps({
  show: Boolean,
  /* { type: 'post'|'comment', id: 目标数字 id, label: 内容摘录（弹窗里回显给用户看） } */
  target: { type: Object, default: null },
});
const emit = defineEmits(["update:show", "done"]);

const REASONS = [
  { key: "spam", tk: "report.reason.spam" },
  { key: "abuse", tk: "report.reason.abuse" },
  { key: "porn", tk: "report.reason.porn" },
  { key: "illegal", tk: "report.reason.illegal" },
  { key: "false", tk: "report.reason.false" },
  { key: "other", tk: "report.reason.other" },
];

const reason = ref("spam");
const detail = ref("");
const busy = ref(false);
const msg = ref("");

watch(() => props.show, (v) => {
  if (v) { reason.value = "spam"; detail.value = ""; msg.value = ""; tsToken.value = ""; }
});

function close() { emit("update:show", false); }

/* 错误 → i18n key（raise exception 的 message 就是错误码；PGRST202 = 迁移未跑） */
function errKey(e) {
  const m = String((e && e.message) || "");
  const c = String((e && e.code) || "");
  if (c === "PGRST202" || m.includes("Could not find the function")) return "report.errNotOpen";
  if (m.includes("report-limit")) return "report.errLimit";
  if (m.includes("auth-required")) return "report.signIn";
  if (m.includes("target-gone")) return "report.errGone";
  return "report.errFail";
}

async function submit() {
  if (busy.value || !props.target) return;
  if (!(cloud.ready && cloud.user)) { msg.value = t("report.signIn"); return; }
  /* 轮 311 · P2：配了 sitekey 而 token 还没拿到 → 拦一次（widget 多数人无感，秒过） */
  if (TS_SITEKEY && !tsToken.value) { msg.value = t("common.turnstileFirst"); return; }
  busy.value = true;
  msg.value = "";
  try {
    await db.reportCreate(props.target.type, props.target.id, reason.value, detail.value.trim(), tsToken.value);
    emit("done");
    /* 先让用户看到「已收到」再收起弹窗（立刻关掉像没反应） */
    msg.value = t("report.done");
    setTimeout(close, 1400);
  } catch (e) {
    msg.value = t(errKey(e));
    /* 人机验证失败/过期 → 重置 widget 让用户重新过（服务端 403 turnstile-failed） */
    if (TS_SITEKEY && String((e && e.message) || "").includes("turnstile")) {
      try { if (tsGate.value) tsGate.value.reset(); } catch (e2) { /* 已卸载 */ }
    }
  }
  busy.value = false;
}
</script>

<template>
  <n-modal
    :show="show" preset="card" style="width: min(520px, calc(100vw - 32px))"
    :title="t('report.title')" @update:show="(v) => emit('update:show', v)">
    <p v-if="target && target.label" class="report-quote">{{ target.label }}</p>

    <n-radio-group v-model:value="reason" class="report-reasons">
      <n-radio v-for="r in REASONS" :key="r.key" :value="r.key">{{ t(r.tk) }}</n-radio>
    </n-radio-group>

    <van-field
      v-model="detail" type="textarea" :rows="2" :maxlength="200"
      :placeholder="t('report.detailPh')" style="margin-top: 12px" />

    <!-- 轮 311 · P2：人机验证（sitekey 未配置时不渲染） -->
    <turnstile-gate ref="tsGate" v-model="tsToken" :sitekey="TS_SITEKEY" />

    <p v-if="msg" class="report-msg">{{ msg }}</p>

    <div class="report-acts">
      <n-button quaternary size="small" :disabled="busy" @click="close">{{ t("common.cancel") }}</n-button>
      <n-button type="primary" size="small" :loading="busy" @click="submit">{{ t("report.submit") }}</n-button>
    </div>
  </n-modal>
</template>

<style scoped>
.report-quote {
  margin: 0 0 12px;
  padding: 8px 12px;
  border-radius: 10px;
  background: var(--glass, rgba(255, 240, 226, 0.6));
  color: var(--low, #8a7a6a);
  font-size: 13px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.report-reasons { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 4px; }
.report-msg { margin: 10px 0 0; font-size: 13px; color: var(--accent, #e58a3a); }
.report-acts { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
</style>
