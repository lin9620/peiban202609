/* 隐私政策页（/privacy）
 * ------------------------------------------------------------
 * 为什么有这个页面：
 *  1. Google Cloud Console 从「测试」切到「正式发布」要求填一个可公开访问的
 *     Privacy policy URL —— 本页就是那个地址（https://dale.de5.net/privacy）。
 *  2. Google 的 OAuth 验证要求政策里必须逐条说明 Google 用户数据怎么用，
 *     并写明 Limited Use 承诺（见第 4、5 节）。
 *
 * 写作与结构约定（与站内其他页面一致）：
 *  - 全部文案走 i18n 词条（privacy.* 子树），en/zh 两份键一一对应（tools/i18n-test.mjs 会校验对称）；
 *  - 章节用 SECTIONS 数组驱动，模板里不堆文案，改文案只动 i18n.js；
 *  - 只使用站内已有的 .card / .sub / .notice 视觉语言，另加 .legal-* 少量样式。
 */
<script setup>
import { computed } from "vue";
import { NButton } from "naive-ui";
import { useRouter } from "vue-router";
import { t } from "../i18n.js";

const router = useRouter();

/* 联系邮箱：与 MIGRATION_add_admin.sql 里登记的管理员邮箱保持同一个 */
const CONTACT_MAIL = "linyi0123456@outlook.com";

/* 章节表：tk = 标题键，ps = 段落键，ls = 列表键，note = 页脚小注（可选） */
const SECTIONS = [
  { tk: "privacy.s1t", ps: ["privacy.s1p1"] },
  { tk: "privacy.s2t", ps: ["privacy.s2p1"], ls: "privacy.s2l" },
  { tk: "privacy.s3t", ls: "privacy.s3l" },
  { tk: "privacy.s4t", ps: ["privacy.s4p1"], ls: "privacy.s4l" },
  { tk: "privacy.s5t", ps: ["privacy.s5p1"] },
  { tk: "privacy.s6t", ps: ["privacy.s6p1"] },
  { tk: "privacy.s7t", ps: ["privacy.s7p1"], note: "privacy.s7note" },
  { tk: "privacy.s8t", ps: ["privacy.s8p1"] },
  { tk: "privacy.s9t", ls: "privacy.s9l" },
  { tk: "privacy.s10t", ps: ["privacy.s10p1"] },
  { tk: "privacy.s11t", ps: ["privacy.s11p1"] },
  { tk: "privacy.s12t", ps: ["privacy.s12p1"] },
  /* 第 13 节（联系方式）不放在这里：它要往正文里塞真实的 {mail}，
     单独写在模板末尾，免得同一个标题被渲染两遍 */
];

/* t() 返回数组时（i18n 词条是 list）直接用；不是数组就当成空列表，避免模板里出错 */
function items(key) {
  const v = t(key);
  return Array.isArray(v) ? v : [];
}

/* 章节内容统一在这里取，模板保持干净 */
const sections = computed(() =>
  SECTIONS.map((s) => ({
    tk: s.tk,
    ps: (s.ps || []).map((k) => t(k)),
    ls: s.ls ? items(s.ls) : [],
    note: s.note ? t(s.note) : "",
  }))
);

function back() { router.push({ name: "home" }); }
</script>

<template>
  <div class="legal-page">
    <!-- 页头：标题 + 更新时间（不写「生效日期」这类无法核实的措辞） -->
    <section class="card legal-head">
      <h1 class="legal-title">🔒 {{ t("privacy.title") }}</h1>
      <p class="sub">{{ t("privacy.intro") }}</p>
      <p class="notice legal-updated">{{ t("privacy.updated") }}</p>
    </section>

    <!-- 章节：内容全部来自 i18n，模板只负责排版 -->
    <section v-for="s in sections" :key="s.tk" class="card legal-sec">
      <h2>{{ t(s.tk) }}</h2>
      <p v-for="p in s.ps" :key="p" class="legal-p">{{ p }}</p>
      <ul v-if="s.ls.length" class="legal-list">
        <li v-for="(it, i) in s.ls" :key="i">{{ it }}</li>
      </ul>
      <p v-if="s.note" class="notice">{{ s.note }}</p>
    </section>

    <!-- 联系邮箱：第 13 节正文里的 {mail} 由这里兜底展示成可复制文本 -->
    <section class="card legal-sec">
      <h2>{{ t("privacy.s13t") }}</h2>
      <p class="legal-p">{{ t("privacy.s13p1", { mail: CONTACT_MAIL }) }}</p>
      <p class="legal-mail">{{ CONTACT_MAIL }}</p>
    </section>

    <div class="legal-foot">
      <n-button quaternary round @click="back">{{ t("privacy.back") }}</n-button>
    </div>
  </div>
</template>
