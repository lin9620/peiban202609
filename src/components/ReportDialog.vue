<!-- 举报弹窗（轮 33）：帖子/评论共用；原因单选 + 可选补充说明。
     防刷/去重/评论 ≥3 人自动隐藏都在服务端 report_create RPC 里；
     迁移未执行（PGRST202）时给出「功能还没开启」的温柔提示，不白屏不报英文。 -->
<script setup>
import { ref, watch } from "vue";
import { NButton, NInput, NModal, NRadio, NRadioGroup } from "naive-ui";
import { t } from "../i18n.js";
import { db } from "../utils/api/db.js";
import { cloud } from "../utils/supabase.js";

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
  if (v) { reason.value = "spam"; detail.value = ""; msg.value = ""; }
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
  busy.value = true;
  msg.value = "";
  try {
    await db.reportCreate(props.target.type, props.target.id, reason.value, detail.value.trim());
    emit("done");
    /* 先让用户看到「已收到」再收起弹窗（立刻关掉像没反应） */
    msg.value = t("report.done");
    setTimeout(close, 1400);
  } catch (e) {
    msg.value = t(errKey(e));
  }
  busy.value = false;
}
</script>

<template>
  <n-modal
    :show="show" preset="card" style="max-width: 92vw"
    :title="t('report.title')" @update:show="(v) => emit('update:show', v)">
    <p v-if="target && target.label" class="report-quote">{{ target.label }}</p>

    <n-radio-group v-model:value="reason" class="report-reasons">
      <n-radio v-for="r in REASONS" :key="r.key" :value="r.key">{{ t(r.tk) }}</n-radio>
    </n-radio-group>

    <n-input
      v-model:value="detail" type="textarea" :rows="2" :maxlength="200"
      :placeholder="t('report.detailPh')" style="margin-top: 12px" />

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
