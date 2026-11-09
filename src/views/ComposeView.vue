<!-- 手机端独立发布页（底部 ＋ → 发暖心墙帖）：大输入框、自动聚焦，一次写完一段心情。
     与暖心墙页顶发布框共用同一套数据层（cloudInsertPost / 每日一条 / 图片预检），只是形态不同。 -->
<script setup>
import { ref, computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { NAvatar } from "naive-ui";
import { t } from "../i18n.js";
import { cloud } from "../utils/supabase.js";
import { avatarUrlFor } from "../utils/avatar.js";
import { cloudInsertPost, canUseWall } from "../utils/wall.js";
import { errorKind, utcDay, POST_DAY_KEY, dayCountFromStorage, canPostToday, postsLeftToday, extractTags, TAG_MAX } from "../utils/wallRules.js";
import { getItem, setItem } from "../utils/storage.js";
import {
  validateImageFile, isSaneShape, isUsableDataUrl, shrinkToDataUrl,
} from "../utils/imaging.js";

const router = useRouter();
const route = useRoute();
const draft = ref("");
const imgData = ref("");
/* 轮 252：选图时记下原始宽高（naturalWidth/Height）—— 发帖时随帖入库，
   渲染端用 aspect-ratio 预留高度，图片到达前布局不跳。0 = 未知。 */
const imgW = ref(0);
const imgH = ref(0);
/* 轮 252：草稿里解析出的 #xxx# 标签（实时预览，最多 TAG_MAX 个） */
const draftTags = computed(() => extractTags(draft.value));
const imgErr = ref("");
const wallMsg = ref("");
const posted = ref(false);
const busy = ref(false);
const needText = ref(false);

const wallName = computed(() => cloud.nickname || getItem("wp-nickname") || t("common.guest"));
const signedIn = computed(() => !!(cloud.ready && cloud.user));
/* 发帖页头像 / 首字母兜底：头像池与暖心墙帖子卡同一套 uid 映射 */
const avatarSrc = computed(() => avatarUrlFor(cloud.user && cloud.user.id));
const avatarInitial = computed(() => (wallName.value || "?").trim().slice(0, 1).toUpperCase());
/* 工具条只放图标，文案去掉 i18n 里的旧 emoji（各语言都从 🖼️ 开头） */
const addImageText = computed(() => t("community.addImage").replace(/^🖼️\s*/, ""));
/* 帖子上限 1000 字：与数据层同口径（wall.js cloudInsertPost 内部 slice(0, 1000)），
   输入框硬限制 + 右下角字数，避免写超了被静默截断 */
const POST_MAX = 1000;
/* 本地也守每天 7 条（WALL_POST_DAILY_LIMIT，库触发器兜底）：本机记账 { day, n }，
 * 旧格式（日期串）兼容 —— 旧记账视为当天已发 1 条 */
const localCount = computed(() => dayCountFromStorage(getItem(POST_DAY_KEY), utcDay()));
const postedToday = computed(() => !canPostToday({ localCount: localCount.value }));
const postsLeft = computed(() => postsLeftToday({ localCount: localCount.value }));

function showMsg(tk) {
  wallMsg.value = tk;
  setTimeout(() => { wallMsg.value = ""; }, 3600);
}
function showImgErr(tk) {
  imgErr.value = t(tk);
  setTimeout(() => { imgErr.value = ""; }, 3600);
}
function pickImage(e) {
  const f = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!f) return;
  const pre = validateImageFile(f);
  if (!pre.ok) return showImgErr(pre.reason === "too-large" ? "community.imgTooLarge" : "community.imgFail");
  const reader = new FileReader();
  reader.onerror = () => showImgErr("community.imgFail");
  reader.onload = () => {
    if (!isUsableDataUrl(reader.result)) return showImgErr("community.imgFail");
    const img = new Image();
    img.onerror = () => showImgErr("community.imgFail");
    img.onload = () => {
      if (!isSaneShape(img.naturalWidth, img.naturalHeight)) return showImgErr("community.imgBadShape");
      try {
        imgData.value = shrinkToDataUrl(img);
        /* 轮 252：记原始宽高（shrink 后的 dataURL 尺寸不同，但比例一致，预留用比例即可） */
        imgW.value = img.naturalWidth;
        imgH.value = img.naturalHeight;
      }
      catch (err) { showImgErr("community.imgFail"); }
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(f);
}

function clearImage() {
  imgData.value = "";
  imgW.value = 0;
  imgH.value = 0;
}

/* 返回：从暖心墙点进来 → 回墙；深链进来 → replace 到墙（不污染历史） */
function goBack() {
  const st = router.options && router.options.history && router.options.history.state;
  if (st && st.back === "/community") router.back();
  else router.replace("/community");
}

/* 未登录 → 登录页（轮 17 统一口径）：登录成功按 ?redirect= 回到本页继续写，
 * 不再绕道「我的」页（旧路径只给账号卡，登录完还得手动走回来） */
function goSignIn() {
  router.push({ path: "/login", query: { redirect: route.fullPath || "/compose" } });
}

async function submit() {
  const text = draft.value.trim();
  if (!text && !imgData.value) {
    needText.value = true;
    setTimeout(() => { needText.value = false; }, 2500);
    return;
  }
  if (busy.value) return;
  if (postedToday.value) return showMsg("community.dailyLimit");
  busy.value = true;
  /* 轮 252：图片尺寸随帖入库（没图/未知 = 0；老库无列时 cloudInsertPost 内部会兜底） */
  const created = await cloudInsertPost({ text, imageDataUrl: imgData.value, name: wallName.value,
    imgW: imgW.value, imgH: imgH.value });
  busy.value = false;
  if (!created) {
    const kind = errorKind(cloud.error);
    return showMsg(kind === "daily-limit" ? "community.dailyLimit"
      : kind === "not-migrated" ? "community.needSetup"
        : kind === "maintenance" ? "community.maintenance" : "community.postFail");
  }
  setItem(POST_DAY_KEY, JSON.stringify({ day: utcDay(), n: localCount.value + 1 }));
  draft.value = "";
  imgData.value = "";
  imgW.value = 0;
  imgH.value = 0;
  posted.value = true;
  /* 发完自动回墙：帖子在列表顶部（回墙会重拉，能看到自己刚发的） */
  setTimeout(() => { goBack(); }, 800);
}
</script>

<template>
  <div class="compose-page">
    <header class="compose-head">
      <button class="compose-back" :aria-label="t('community.composeBack')" @click="goBack">←</button>
      <div class="compose-heading">
        <span class="compose-kicker">{{ t("community.title") }}</span>
        <h1 class="compose-title">{{ t("community.composeTitle") }}</h1>
      </div>
      <button
        v-if="!cloud.ready || signedIn"
        type="button"
        class="compose-send"
        :disabled="postedToday || busy"
        :aria-busy="busy ? 'true' : 'false'"
        @click="submit">
        <span v-if="busy" class="compose-spin" aria-hidden="true"></span>
        <span>{{ t("community.post") }}</span>
      </button>
    </header>

    <!-- 未登录：先去登录（发帖要身份）；登录后按 ?redirect= 回到本页继续写 -->
    <section v-if="cloud.ready && !signedIn" class="compose-card compose-card--signin">
      <p class="compose-sub">{{ t("community.commentSignIn") }}</p>
      <button type="button" class="compose-send compose-send--signin" @click="goSignIn">
        {{ t("profile.goSignIn") }}
      </button>
    </section>

    <!-- 写帖：作者行 + 大输入框 + 图片 / 标签 + 底部工具条；发布键放顶栏，拇指够得到 -->
    <section v-else class="compose-card">
      <div class="compose-author">
        <n-avatar round :size="42" class="compose-avatar" :src="avatarSrc || undefined">
          <template #default>{{ avatarInitial }}</template>
          <template #fallback>{{ avatarInitial }}</template>
        </n-avatar>
        <div class="compose-author-meta">
          <b>{{ wallName }}</b>
          <span :class="{ 'is-warn': postedToday }">
            {{ postedToday ? t("community.dailyLimit") : t("community.postLeft", { n: postsLeft }) }}
          </span>
        </div>
      </div>

      <div class="compose-writing">
        <textarea
          v-model="draft"
          class="compose-area"
          rows="8"
          :maxlength="POST_MAX"
          autofocus
          :aria-label="t('community.placeholder')"></textarea>
        <!-- 空信纸的居中提示：开始写字 / 选图后自动让位，避免一大片纯白看起来像没加载 -->
        <div v-if="!draft && !imgData" class="compose-empty" aria-hidden="true">
          <span class="compose-empty-paw">🐾</span>
          <span class="compose-empty-text">{{ t("community.placeholder") }}</span>
        </div>
      </div>

      <!-- 轮 252：#xxx# 标签实时预览（发帖后可被搜索 / 点击筛选） -->
      <div v-if="draftTags.length" class="compose-tags">
        <span v-for="tg in draftTags" :key="tg" class="compose-tag">#{{ tg }}#</span>
      </div>

      <div v-if="imgData" class="compose-pic-wrap">
        <img :src="imgData" class="compose-pic" alt="preview"
            :style="imgW > 0 && imgH > 0 ? { aspectRatio: imgW + ' / ' + imgH } : {}" />
        <button type="button" class="compose-pic-x" :aria-label="t('community.removeImage')"
          @click="clearImage">×</button>
      </div>

      <p v-if="imgErr" class="compose-hint bad">{{ imgErr }}</p>

      <div class="compose-bar">
        <label class="compose-tool">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3.2" y="5.2" width="17.6" height="13.6" rx="3" fill="none" stroke="currentColor" stroke-width="1.7" />
            <circle cx="8.4" cy="10" r="1.4" fill="currentColor" />
            <path d="M4.8 17.2l4.6-4.3 3.4 3.1 2.1-2 4.3 4.2" fill="none" stroke="currentColor"
              stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span>{{ addImageText }}</span>
          <input type="file" accept="image/*" style="display: none" @change="pickImage" />
        </label>
        <span class="compose-count" :class="{ 'is-near': draft.length >= POST_MAX * 0.9 }">
          {{ draft.length }}/{{ POST_MAX }}
        </span>
      </div>

      <div v-if="posted || wallMsg || needText" class="compose-foot">
        <p v-if="posted" class="compose-hint good">{{ t("community.postedThanks") }}</p>
        <p v-if="wallMsg" class="compose-hint bad">{{ t(wallMsg) }}</p>
        <p v-else-if="needText" class="compose-hint bad">{{ t("community.needText") }}</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* ═══════════ 手机端独立发帖页（/compose）═══════════
 * App 里从底部 ＋ 进来，是一整屏编辑器；顶栏只留返回 / 标题 / 发布，
 * 正文是「作者行 + 信纸大输入框」，图片和字数收进底部工具条。
 * App.vue 把 /compose 归到 shell--chat 形态，TabBar 与页脚一并让位，
 * 这页自己吃满 100dvh，底部留 safe-area。 */
.compose-page {
  display: flex; flex-direction: column; gap: 12px;
  /* 轮 480：dvh 一律关进下面的 @supports，外层只留 vh 兜底。
   * 这是轮 474 的同一个坑——不认 dvh 的内核不是「回退到前一条声明」，
   * 而是把整条属性判成无效（退 auto），所以两条声明必须分在不同规则里。 */
  min-height: 100vh;
  max-width: 720px; margin: 0 auto;
  padding: 12px 14px calc(16px + env(safe-area-inset-bottom, 0px));
}
@supports (height: 100dvh) {
  .compose-page { min-height: 100dvh; }
}
/* 轮 137 口径：桌面流式壳下页面容器铺满，不再收窄居中（App / 窄屏不受影响） */
@media (min-width: 900px) { .compose-page { max-width: none; } }

/* 顶栏：返回 / 标题 / 发布。sticky 但不用 backdrop-filter（跟手机端性能口径） */
.compose-head {
  position: sticky; top: 0; z-index: 6;
  display: grid; grid-template-columns: 40px minmax(0, 1fr) auto;
  align-items: center; gap: 10px;
  padding: 4px 0 10px;
  background: linear-gradient(180deg, var(--glass-strong) 72%, rgba(255, 255, 255, 0));
}
.compose-back {
  flex: 0 0 auto;
  width: 40px; height: 40px; border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, .95);
  background: var(--glass-strong); color: var(--ink);
  font-size: 18px; font-weight: 500; line-height: 1;
  display: flex; align-items: center; justify-content: center;
  box-shadow: var(--shadow-sm); cursor: pointer;
  transition: transform .15s ease;
}
.compose-back:active { transform: scale(.94); }
.compose-heading { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.compose-kicker {
  font-size: 10.5px; font-weight: 600; letter-spacing: .12em;
  text-transform: uppercase; color: var(--accent-deep); opacity: .72;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.compose-title {
  margin: 0; font-size: 18px; font-weight: 600; letter-spacing: .2px;
  line-height: 1.3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.compose-send {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  flex: 0 0 auto; min-width: 78px; height: 38px; padding: 0 16px;
  border: 0; border-radius: 999px;
  background: var(--accent); color: #fff;
  font: inherit; font-size: 13.5px; font-weight: 600; letter-spacing: .2px;
  box-shadow: 0 6px 16px rgba(204, 120, 92, .22);
  cursor: pointer; transition: transform .15s ease, opacity .15s ease;
}
.compose-send:active { transform: scale(.96); }
.compose-send:disabled { opacity: .45; cursor: default; box-shadow: none; }
.compose-spin {
  width: 13px; height: 13px; border: 2px solid rgba(255, 255, 255, .45);
  border-top-color: #fff; border-radius: 50%;
  animation: compose-spin .7s linear infinite;
}
@keyframes compose-spin { to { transform: rotate(360deg); } }

/* 信纸卡片：输入框吃掉剩余高度，工具条自然吸底 */
.compose-card {
  position: relative; overflow: hidden;
  flex: 1 1 auto;
  display: flex; flex-direction: column; gap: 12px;
  background:
    radial-gradient(110% 80% at 100% 0%, rgba(255, 211, 184, .32), transparent 60%),
    var(--glass-strong, #fff);
  border: 1px solid rgba(160, 110, 60, .14);
  border-radius: 26px; padding: 18px 18px 14px;
  box-shadow: 0 18px 44px rgba(160, 110, 60, .10);
}
.compose-card::before {
  content: ""; position: absolute; right: -34px; bottom: -42px;
  width: 150px; height: 150px; border-radius: 50%;
  background: radial-gradient(circle, rgba(245, 140, 80, .13), transparent 68%);
  pointer-events: none;
}
.compose-card--signin {
  align-items: center; justify-content: center; text-align: center;
  gap: 18px; min-height: 46vh;
}
.compose-sub {
  max-width: 280px; margin: 0;
  font-size: 13.5px; font-weight: 500; color: var(--ink-soft); line-height: 1.75;
}
.compose-card--signin .compose-send { min-width: 112px; height: 42px; padding: 0 20px; font-size: 14px; }

/* 作者行：头像 + 昵称 + 今日额度，给空白信纸一个视觉锚点 */
.compose-author {
  display: flex; align-items: center; gap: 11px;
  padding-bottom: 12px;
  border-bottom: 1px solid rgba(204, 120, 92, .12);
}
.compose-avatar {
  flex: 0 0 auto;
  background: linear-gradient(135deg, #ffe0c2, #ffd0df);
}
.compose-author-meta { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.compose-author-meta b {
  font-size: 14px; font-weight: 600; line-height: 1.35;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.compose-author-meta span {
  font-size: 11.5px; font-weight: 500; color: var(--ink-faint); line-height: 1.4;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.compose-author-meta span.is-warn { color: var(--low); }

/* 大输入框：去掉原生边框 / 把手，只靠字号与行高排字 */
.compose-writing { position: relative; flex: 1 1 auto; display: flex; min-height: 0; }
.compose-area {
  flex: 1 1 auto;
  width: 100%; min-height: 34vh;
  border: none; outline: none; resize: none; background: transparent;
  font: inherit; font-size: 17px; line-height: 1.85; letter-spacing: .15px;
  color: var(--ink); padding: 2px 0;
  caret-color: var(--accent-deep);
}
.compose-area::placeholder { color: var(--ink-faint); font-weight: 500; opacity: .85; }
.compose-empty {
  position: absolute; inset: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 10px; text-align: center; color: var(--ink-faint);
  pointer-events: none;
}
.compose-empty-paw { font-size: 30px; line-height: 1; opacity: .16; filter: saturate(.7); }
.compose-empty-text { font-size: 12.5px; font-weight: 500; letter-spacing: .3px; opacity: .75; }

.compose-tags { display: flex; gap: 6px; flex-wrap: wrap; margin-top: -2px; }
.compose-tag {
  padding: 3px 9px; border-radius: 999px;
  background: var(--accent-soft); color: var(--accent-deep);
  font-size: 11.5px; font-weight: 600;
}

.compose-pic-wrap {
  position: relative; display: flex;
  border-radius: 18px; overflow: hidden;
  border: 1px solid rgba(160, 110, 60, .12);
  background: rgba(255, 246, 236, .85);
}
.compose-pic { width: 100%; max-height: 300px; object-fit: contain; display: block; }
.compose-pic-x {
  position: absolute; top: 8px; right: 8px;
  width: 30px; height: 30px; border: 0; border-radius: 50%;
  background: rgba(30, 24, 20, .55); color: #fff;
  font-size: 18px; line-height: 1; display: flex; align-items: center; justify-content: center;
  cursor: pointer; backdrop-filter: blur(6px);
  transition: transform .15s ease, background .15s ease;
}
.compose-pic-x:active { transform: scale(.92); background: rgba(30, 24, 20, .72); }

/* 底部工具条：图片 / 字数。发布键已上移顶栏，底部不再压一整行大按钮 */
.compose-bar {
  display: flex; align-items: center; gap: 10px; flex-wrap: nowrap;
  padding-top: 12px;
  border-top: 1px solid rgba(204, 120, 92, .12);
}
.compose-tool {
  display: inline-flex; align-items: center; gap: 7px;
  padding: 8px 12px; border-radius: 12px;
  background: var(--accent-soft);
  font-size: 12.5px; font-weight: 600; color: var(--accent-deep);
  cursor: pointer; user-select: none;
  transition: transform .15s ease, background .15s ease;
}
.compose-tool svg { width: 18px; height: 18px; display: block; flex: 0 0 auto; }
.compose-tool:active { transform: scale(.96); }
.compose-count {
  margin-left: auto;
  font-size: 12px; font-weight: 500; color: var(--ink-faint);
  font-variant-numeric: tabular-nums;
}
.compose-count.is-near { color: var(--low); }

.compose-foot { display: flex; flex-direction: column; gap: 4px; }
.compose-hint { margin: 0; font-size: 12px; font-weight: 500; color: var(--ink-soft); line-height: 1.7; }
.compose-hint.bad { color: var(--low); }
.compose-hint.good { color: var(--good); }

/* 夜间皮肤 */
html[data-theme="night"] .compose-head {
  background: linear-gradient(180deg, rgba(23, 26, 51, .92) 72%, rgba(23, 26, 51, 0));
}
html[data-theme="night"] .compose-back { border-color: rgba(255, 255, 255, .14); }
html[data-theme="night"] .compose-card {
  background:
    radial-gradient(110% 80% at 100% 0%, rgba(255, 180, 140, .10), transparent 60%),
    var(--glass-strong);
  border-color: rgba(255, 255, 255, .12);
}
html[data-theme="night"] .compose-author { border-bottom-color: rgba(255, 255, 255, .10); }
html[data-theme="night"] .compose-pic-wrap {
  background: rgba(30, 35, 64, .6); border-color: rgba(255, 255, 255, .12);
}
html[data-theme="night"] .compose-bar { border-top-color: rgba(255, 255, 255, .10); }
html[data-theme="night"] .compose-tool { background: rgba(255, 255, 255, .08); }

/* 窄屏（手机）：输入框再高一点，顶栏收窄 */
@media (max-width: 560px) {
  .compose-page { padding: 8px 12px calc(14px + env(safe-area-inset-bottom, 0px)); }
  .compose-head { grid-template-columns: 38px minmax(0, 1fr) auto; gap: 8px; }
  .compose-back { width: 38px; height: 38px; }
  .compose-title { font-size: 17px; }
  .compose-card { border-radius: 22px; padding: 16px 15px 12px; }
  .compose-area { min-height: 40vh; font-size: 16.5px; }
}
</style>
