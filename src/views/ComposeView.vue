<!-- 手机端独立发布页（底部 ＋ → 发暖心墙帖）：大输入框、自动聚焦，一次写完一段心情。
     与暖心墙页顶发布框共用同一套数据层（cloudInsertPost / 每日一条 / 图片预检），只是形态不同。 -->
<script setup>
import { ref, computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { NButton } from "naive-ui";
import { t } from "../i18n.js";
import { cloud } from "../utils/supabase.js";
import { cloudInsertPost, canUseWall } from "../utils/wall.js";
import { errorKind, utcDay, POST_DAY_KEY, dayCountFromStorage, canPostToday, postsLeftToday } from "../utils/wallRules.js";
import { getItem, setItem } from "../utils/storage.js";
import {
  validateImageFile, isSaneShape, isUsableDataUrl, shrinkToDataUrl,
} from "../utils/imaging.js";

const router = useRouter();
const route = useRoute();
const draft = ref("");
const imgData = ref("");
const imgErr = ref("");
const wallMsg = ref("");
const posted = ref(false);
const busy = ref(false);
const needText = ref(false);

const wallName = computed(() => cloud.nickname || getItem("wp-nickname") || "Guest");
const signedIn = computed(() => !!(cloud.ready && cloud.user));
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
      try { imgData.value = shrinkToDataUrl(img); }
      catch (err) { showImgErr("community.imgFail"); }
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(f);
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
  const created = await cloudInsertPost({ text, imageDataUrl: imgData.value, name: wallName.value });
  busy.value = false;
  if (!created) {
    const kind = errorKind(cloud.error);
    return showMsg(kind === "daily-limit" ? "community.dailyLimit"
      : kind === "not-migrated" ? "community.needSetup" : "community.postFail");
  }
  setItem(POST_DAY_KEY, JSON.stringify({ day: utcDay(), n: localCount.value + 1 }));
  draft.value = "";
  imgData.value = "";
  posted.value = true;
  /* 发完自动回墙：帖子在列表顶部（回墙会重拉，能看到自己刚发的） */
  setTimeout(() => { goBack(); }, 800);
}
</script>

<template>
  <div class="compose-page">
    <header class="compose-head">
      <button class="compose-back" :aria-label="t('community.composeBack')" @click="goBack">←</button>
      <h1 class="compose-title">🧱 {{ t("community.composeTitle") }}</h1>
    </header>

    <!-- 未登录：先去登录（发帖要身份）；登录后按 ?redirect= 回到本页继续写 -->
    <section v-if="cloud.ready && !signedIn" class="compose-card compose-card--signin">
      <p class="compose-sub">{{ t("community.commentSignIn") }}</p>
      <n-button type="primary" round class="compose-send" @click="goSignIn">
        {{ t("profile.goSignIn") }}
      </n-button>
    </section>

    <!-- 写帖：整屏大输入框 + 图片预览 + 底部动作条（图片 / 字数 / 发布） -->
    <section v-else class="compose-card">
      <textarea
        v-model="draft"
        class="compose-area"
        rows="8"
        :maxlength="POST_MAX"
        autofocus
        :placeholder="t('community.placeholder')"></textarea>

      <img v-if="imgData" :src="imgData" class="compose-pic" alt="preview" />

      <p v-if="imgErr" class="compose-hint bad">{{ imgErr }}</p>

      <!-- 工具行：图片 / 移除 / 字数（窄屏优先放一行，字数始终贴右） -->
      <div class="compose-bar">
        <label class="compose-tool">
          🖼️ {{ t("community.addImage") }}
          <input type="file" accept="image/*" style="display: none" @change="pickImage" />
        </label>
        <n-button v-if="imgData" quaternary size="small" @click="imgData = ''">
          {{ t("community.removeImage") }}
        </n-button>
        <span class="compose-count">{{ draft.length }}/{{ POST_MAX }}</span>
      </div>

      <!-- 发布：整行大按钮（拇指友好；窄屏不再挤在工具行里换行成半截） -->
      <n-button
        type="primary" round block class="compose-send"
        :loading="busy" :disabled="postedToday" @click="submit">
        {{ t("community.post") }}
      </n-button>

      <p v-if="postedToday" class="compose-hint">{{ t("community.dailyLimit") }}</p>
      <p v-else-if="posted" class="compose-hint good">{{ t("community.postedThanks") }}</p>
      <p v-else class="compose-hint">{{ t("community.postLeft", { n: postsLeft }) }}</p>
      <p v-if="wallMsg" class="compose-hint bad">{{ t(wallMsg) }}</p>
      <p v-else-if="needText" class="compose-hint bad">{{ t("community.needText") }}</p>
    </section>
  </div>
</template>

<style scoped>
/* ═══════════ 手机端独立发帖页（/compose）═══════════
 * 用户反馈「点了 ＋ 发帖之后那页丑得没法看」：以前这页只有类名、一条样式都没有
 *   （.compose-page/.compose-head/.compose-area 全是空的，textarea 还是浏览器默认款）。
 * 现在按「整屏编辑器」排：sticky 顶栏（← 回墙）+ 中间一张大卡片（输入框撑满）
 *   + 底部动作条（图片 / 字数 / 发布）。App.vue 把 /compose 归到 shell--chat 形态，
 *   TabBar 与页脚一并让位 → 这页自己吃满 100dvh，底部留 safe-area。
 * 桌面形态也走同一页（窄屏居中 max-width 720），不会因为手机优先而崩。 */
.compose-page {
  display: flex; flex-direction: column; gap: 12px;
  min-height: 100dvh;
  max-width: 720px; margin: 0 auto;
  padding: 12px 14px calc(18px + env(safe-area-inset-bottom, 0px));
}

/* 顶栏 */
.compose-head {
  position: sticky; top: 0; z-index: 6;
  display: flex; align-items: center; gap: 10px;
  padding: 4px 0 12px;
  /* 底边淡出：滚动时正文不会和标题糊在一起，又不用画一条硬线。
     不做 backdrop-filter —— 跟着手机端 5 的「毛玻璃退场」走（性能） */
  background: linear-gradient(180deg, var(--glass-strong) 68%, rgba(255, 255, 255, 0));
}
.compose-back {
  flex: 0 0 auto;
  width: 38px; height: 38px; border-radius: 14px;
  border: 1.5px solid rgba(255, 255, 255, .95);
  background: var(--glass-strong); color: var(--ink);
  font-size: 17px; font-weight: 800; line-height: 1;
  display: flex; align-items: center; justify-content: center;
  box-shadow: var(--shadow-sm); cursor: pointer;
  transition: transform .15s ease;
}
.compose-back:active { transform: scale(.94); }
.compose-title { font-size: 17px; font-weight: 800; letter-spacing: .3px; }

/* 卡片：输入框吃掉剩余高度，动作条自然吸底 */
.compose-card {
  flex: 1 1 auto;
  display: flex; flex-direction: column; gap: 12px;
  /* 底色走皮肤变量（浅色近白 / 夜间深蓝），不破夜间主题；不做毛玻璃（手机端 5） */
  background: var(--glass-strong, #fff);
  border: 1.5px solid rgba(255, 255, 255, .95);
  border-radius: 22px; padding: 16px;
  box-shadow: var(--shadow);
}
.compose-card--signin { align-items: center; justify-content: center; text-align: center; gap: 16px; }
.compose-sub { font-size: 13.5px; font-weight: 700; color: var(--ink-soft); line-height: 1.75; }

/* 大输入框：把原生 textarea 的边框/把手全去掉，只用字号与行高排字 */
.compose-area {
  flex: 1 1 auto;
  width: 100%; min-height: 42vh;
  border: none; outline: none; resize: none; background: transparent;
  font: inherit; font-size: 15.5px; line-height: 1.85; letter-spacing: .2px;
  color: var(--ink); padding: 0;
}
.compose-area::placeholder { color: var(--ink-faint); font-weight: 600; opacity: .9; }

.compose-pic {
  width: 100%; max-height: 260px; object-fit: contain;
  border-radius: 16px; border: 2px solid rgba(255, 255, 255, .95);
  background: rgba(255, 246, 236, .85);
}

/* 工具行：图片 / 移除 / 字数（字数贴右；发布按钮独立成整行，见下） */
.compose-bar {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding-top: 12px;
  border-top: 1px dashed rgba(255, 159, 90, .28);
}
.compose-tool {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 7px 14px; border-radius: 999px;
  background: var(--accent-soft);
  border: 1.5px solid rgba(255, 255, 255, .9);
  font-size: 12.5px; font-weight: 800; color: var(--accent-deep);
  cursor: pointer; user-select: none;
  transition: transform .15s ease;
}
.compose-tool:active { transform: scale(.96); }
.compose-count {
  margin-left: auto;
  font-size: 12px; font-weight: 700; color: var(--ink-faint);
  font-variant-numeric: tabular-nums;
}
/* 竖屏手机：发布键独占一整行（拇指好按，也和主流编辑器一致 —— 实测三个元素挤一行会换行成左对齐） */
.compose-send { flex: 0 0 auto; width: 100%; height: 46px; font-weight: 800; font-size: 15px; }
.compose-card--signin .compose-send { width: auto; min-width: 104px; height: 40px; font-size: 14px; }
.compose-hint { font-size: 12.5px; font-weight: 700; color: var(--ink-soft); line-height: 1.7; }
.compose-hint.bad { color: var(--low); }
.compose-hint.good { color: var(--good); }

/* 夜间皮肤 */
html[data-theme="night"] .compose-head {
  background: linear-gradient(180deg, rgba(23, 26, 51, .92) 68%, rgba(23, 26, 51, 0));
}
html[data-theme="night"] .compose-back { border-color: rgba(255, 255, 255, .14); }
/* 夜间：卡片底色已由 --glass-strong 跟着皮肤走，这里只补描边 */
html[data-theme="night"] .compose-card { border-color: rgba(255, 255, 255, .12); }
html[data-theme="night"] .compose-pic {
  background: rgba(30, 35, 64, .6); border-color: rgba(255, 255, 255, .12);
}
html[data-theme="night"] .compose-tool { border-color: rgba(255, 255, 255, .14); }

/* 窄屏（手机）：输入框再高一点，标题小一点 */
@media (max-width: 560px) {
  .compose-area { min-height: 46vh; }
  .compose-title { font-size: 16px; }
  .compose-card { border-radius: 20px; padding: 14px; }
}
/* 宽屏（桌面 / 横屏 iPad）：动作条回到一行 —— 图片 + 字数 + 发布（发布键靠右） */
@media (min-width: 561px) {
  .compose-bar { flex-wrap: nowrap; }
  .compose-send { flex: 0 0 auto; min-width: 128px; height: 40px; font-size: 14px; }
}
</style>
