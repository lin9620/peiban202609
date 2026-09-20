<!-- 手机端独立发布页（底部 ＋ → 发暖心墙帖）：大输入框、自动聚焦，一次写完一段心情。
     与暖心墙页顶发布框共用同一套数据层（cloudInsertPost / 每日一条 / 图片预检），只是形态不同。 -->
<script setup>
import { ref, computed } from "vue";
import { useRouter } from "vue-router";
import { NButton } from "naive-ui";
import { t } from "../i18n.js";
import { cloud } from "../utils/supabase.js";
import { cloudInsertPost, canUseWall } from "../utils/wall.js";
import { errorKind, utcDay, POST_DAY_KEY } from "../utils/wallRules.js";
import { getItem, setItem } from "../utils/storage.js";
import {
  validateImageFile, isSaneShape, isUsableDataUrl, shrinkToDataUrl,
} from "../utils/imaging.js";

const router = useRouter();
const draft = ref("");
const imgData = ref("");
const imgErr = ref("");
const wallMsg = ref("");
const posted = ref(false);
const busy = ref(false);
const needText = ref(false);

const wallName = computed(() => cloud.nickname || getItem("wp-nickname") || "Guest");
const signedIn = computed(() => !!(cloud.ready && cloud.user));
/* 本地也守每日一条：本机记的「今天已发」优先（云端还有触发器兜一层） */
const postedToday = computed(() => getItem(POST_DAY_KEY) === utcDay());

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
  setItem(POST_DAY_KEY, utcDay());
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

    <!-- 未登录：先去登录（发帖要身份） -->
    <section v-if="cloud.ready && !signedIn" class="card compose-card">
      <p class="sub">{{ t("community.commentSignIn") }}</p>
      <n-button type="primary" round @click="router.push('/profile')">{{ t("nav.profile") }}</n-button>
    </section>

    <section v-else class="card compose-card">
      <textarea
        v-model="draft"
        class="compose-area"
        rows="8"
        autofocus
        :placeholder="t('community.placeholder')"></textarea>

      <img v-if="imgData" :src="imgData" class="preview" alt="preview" />
      <p v-if="imgErr" class="notice" style="color: var(--low); font-weight: 700">{{ imgErr }}</p>

      <div class="composer-row">
        <label class="tool">
          🖼️ {{ t("community.addImage") }}
          <input type="file" accept="image/*" style="display: none" @change="pickImage" />
        </label>
        <n-button v-if="imgData" quaternary size="small" @click="imgData = ''">
          {{ t("community.removeImage") }}
        </n-button>
        <n-button
          type="primary" round class="compose-send"
          :loading="busy" :disabled="postedToday" @click="submit">
          {{ t("community.post") }}
        </n-button>
      </div>

      <p v-if="postedToday" class="notice">{{ t("community.dailyLimit") }}</p>
      <p v-else-if="posted" class="streak-note" style="color: var(--good); font-weight: 700">
        {{ t("community.postedThanks") }}
      </p>
      <p v-if="wallMsg" class="streak-note" style="color: var(--low); font-weight: 700">{{ t(wallMsg) }}</p>
      <p v-else-if="needText" class="streak-note" style="color: var(--low); font-weight: 700">
        {{ t("community.needText") }}
      </p>
    </section>
  </div>
</template>
