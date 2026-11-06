<!-- 轮 444 · 维护/升级提示（全局）
 * 设计目标：**对用户干扰最小**。所以：
 *  · 不弹窗、不遮罩、不锁交互 —— 就是一条 34px 的细横幅，粘在内容顶部；
 *  · 可以收起 —— 点 × 变成右下角一个小圆点，不占任何位置；下次进来还记得收起了；
 *  · 只读档不禁用按钮 —— 按钮照常亮，点了才提示，避免「满屏灰色」的挫败感；
 *  · 维护结束横幅自己淡出，不弹「维护完成」打扰人；
 *  · full 档才整页占位（要给数据库动结构时读也会报错，那时只能停），
 *    但占位也是柔和的一张卡 + 预计时间 + 自动重试，不用「系统错误」那套吓人措辞。
 -->
<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { t } from "../i18n.js";
import { db } from "../utils/api/db.js";
import { cloud } from "../utils/supabase.js";
import {
  maint, activeMode, isFullStop, refreshMaintenance, setPreview, selfExempt,
} from "../utils/maintenance.js";

const COLLAPSE_KEY = "wp-maint-collapsed-v1";

/* 收起状态跨会话记住：维护可能持续很久，每次都要手动关一遍很烦 */
const collapsed = ref(false);
try { collapsed.value = localStorage.getItem(COLLAPSE_KEY) === "1"; } catch (e) { /* 无痕模式 */ }

const now = ref(Date.now());
let tick = 0;
onMounted(() => { tick = setInterval(() => { now.value = Date.now(); }, 30000); });
onBeforeUnmount(() => clearInterval(tick));

const mode = computed(() => activeMode());
/* 管理员也要看见横幅（否则自己都不记得开了维护），但会额外标注「你不受影响」 */
const visible = computed(() => mode.value !== "off");
const stopAll = computed(() => isFullStop());

/* 剩余时间：只做「大概还剩多久」，不显示秒 —— 秒级倒计时只会让人焦虑 */
const leftMs = computed(() => {
  if (!maint.until) return -1;
  const t0 = Date.parse(maint.until);
  return Number.isFinite(t0) ? Math.max(0, t0 - now.value) : -1;
});
const leftText = computed(() => {
  if (leftMs.value < 0) return "";
  if (leftMs.value <= 0) return t("maint.almostDone");
  const m = Math.ceil(leftMs.value / 60000);
  if (m <= 1) return t("maint.lessThanMin");
  return t("maint.leftMin", { m });
});

/* 有人试图写入被拦 → 横幅轻抖一下，把「就是这儿不让写」指向自己 */
const shake = ref(false);
watch(() => maint.hint, () => {
  shake.value = true;
  setTimeout(() => { shake.value = false; }, 700);
});

/* 管理员身份：只有管理员才看到「以用户视角预览」和「你不受限」的标注。
 * 登录态变化才查一次（rpc is_admin 很轻，但没必要每次渲染都问）。 */
watch(() => (cloud.user && cloud.user.id) || "", async (uid) => {
  if (!uid) { maint.admin = false; maint.preview = false; return; }
  try { maint.admin = !!(await db.amAdmin()); } catch (e) { maint.admin = false; }
}, { immediate: true });

function collapse(v) {
  collapsed.value = v;
  try { localStorage.setItem(COLLAPSE_KEY, v ? "1" : "0"); } catch (e) { /* 忽略 */ }
}

/* 用户视角预览（只在管理员点了之后出现） */
const asUser = computed({
  get: () => maint.preview,
  set: (v) => setPreview(v),
});

async function retry() {
  await refreshMaintenance(db);
}
</script>

<template>
  <!-- full 档：柔和的整页占位（只对真正受限的人显示；管理员默认豁免，仍能进后台关掉） -->
  <Teleport to="body">
    <div v-if="stopAll" class="maint-stop" role="alertdialog" aria-live="polite">
      <div class="maint-stop-card">
        <div class="maint-stop-emoji">🐾</div>
        <h2 class="maint-stop-title">{{ t("maint.fullTitle") }}</h2>
        <p class="maint-stop-body">{{ maint.note || t("maint.fullBody") }}</p>
        <p v-if="leftText" class="maint-stop-left">{{ leftText }}</p>
        <button class="maint-stop-btn" type="button" @click="retry">{{ t("maint.retry") }}</button>
        <p class="maint-stop-foot">{{ t("maint.fullFoot") }}</p>
      </div>
    </div>
  </Teleport>

  <!-- 收起的形态：右下角一个小圆点，点开回到横幅 -->
  <button
    v-if="visible && collapsed" class="maint-dot" type="button"
    :title="t('maint.expand')" :aria-label="t('maint.expand')" @click="collapse(false)">
    <span class="maint-dot-in"></span>
  </button>

  <!-- 只读档的细横幅：不遮挡内容，不阻断任何交互 -->
  <div
    v-else-if="visible" class="maint-bar" :class="{ 'maint-bar--shake': shake }" role="status" aria-live="polite">
    <span class="maint-dot-in"></span>
    <span class="maint-bar-text">
      <strong>{{ mode === "full" ? t("maint.bannerFull") : t("maint.bannerRead") }}</strong>
      <em v-if="maint.note" class="maint-bar-note">{{ maint.note }}</em>
      <em v-else class="maint-bar-note">{{ mode === "full" ? t("maint.fullBody") : t("maint.readBody") }}</em>
      <span v-if="leftText" class="maint-bar-left">· {{ leftText }}</span>
      <span v-if="selfExempt()" class="maint-bar-admin">· {{ t("maint.adminFree") }}</span>
    </span>
    <label v-if="maint.admin" class="maint-bar-preview" :title="t('maint.asUser')">
      <input v-model="asUser" type="checkbox" />
      <span>{{ t("maint.asUser") }}</span>
    </label>
    <button class="maint-bar-x" type="button" :title="t('maint.collapse')" :aria-label="t('maint.collapse')"
      @click="collapse(true)">×</button>
  </div>
</template>
