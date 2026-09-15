<script setup>
import { ref, computed, onMounted, watch } from "vue";
import { NButton, NInput, NAvatar, NTag } from "naive-ui";
import { t, i18n } from "../i18n.js";
import { getItem, setItem } from "../utils/storage.js";
import {
  CMT_KEY, seedComments, addComment, removeComment, listComments,
  canDelete, normalizeText, countComments, postKey, MAX_LEN,
} from "../utils/comments.js";
import { cloud } from "../utils/supabase.js";
import {
  cloudFetchPosts, cloudInsertPost, cloudFetchComments, cloudInsertComment,
  cloudDeleteComment, cloudToggleReaction, canUseWall, canReadWall,
} from "../utils/wall.js";
import {
  validateImageFile, isSaneShape, isUsableDataUrl, shrinkToDataUrl,
} from "../utils/imaging.js";

const POSTS_KEY = "warm-paws-posts-v1";
const REACTS_KEY = "warm-paws-reacts-v1";

const REACTIONS = [
  { key: "hug", tk: "community.reactHug" },
  { key: "warm", tk: "community.reactWarm" },
  { key: "relate", tk: "community.reactRelate" },
];

/* 示例帖（双语） */
const SAMPLES = [
  {
    id: "s1", sample: true, name: "Mochi 🍡", ts: Date.now() - 86400000 * 2,
    en: "First day here. It already feels softer than the rest of the internet 🐾",
    zh: "第一天来，感觉这里比互联网其他地方都柔软 🐾",
    reacts: { hug: 12, warm: 20, relate: 5 },
  },
  {
    id: "s2", sample: true, name: "Juno ☕", ts: Date.now() - 86400000,
    en: "Failed an exam today. Sending a hug to everyone else having a rough week 🫂",
    zh: "今天考试挂了。给同样难熬的这一周里所有人一个抱抱 🫂",
    reacts: { hug: 34, warm: 18, relate: 27 },
  },
  {
    id: "s3", sample: true, name: "Bean 🫘", ts: Date.now() - 3600000 * 5,
    en: "Made soup, way too salty. My cat still sat with me the whole time. 10/10 day.",
    zh: "炖的汤咸到不行，但我的猫还是全程陪着我。满分的一天。",
    reacts: { hug: 6, warm: 15, relate: 9 },
  },
];

const posts = ref([]);
const myReacts = ref({});
const draft = ref("");
const imgData = ref("");
const posted = ref(false);
const needText = ref(false);

/* —— 云端模式状态 —— */
const cloudPosts = ref([]);
const loadingCloud = ref(false);

const nickname = computed(() => getItem("wp-nickname") || t("common.guest"));
/* 云模式下的发帖者署名：登录昵称 > 本地昵称 */
const wallName = computed(() => cloud.nickname || getItem("wp-nickname") || "Guest");
const signedIn = computed(() => !!(cloud.ready && cloud.user));

onMounted(() => {
  try { posts.value = JSON.parse(getItem(POSTS_KEY)) || []; } catch (e) {}
  try { myReacts.value = JSON.parse(getItem(REACTS_KEY)) || {}; } catch (e) {}
  if (cloud.ready) loadCloud();
});
/* 云端就绪晚于挂载（异步探测）→ 就绪后补拉一次；未登录也拉（RLS 匿名只读） */
watch(() => cloud.ready, (v) => {
  if (v && !cloudPosts.value.length) loadCloud();
});

async function loadCloud() {
  loadingCloud.value = true;
  const rows = await cloudFetchPosts();
  if (rows) cloudPosts.value = rows;
  loadingCloud.value = false;
}

function persist() {
  setItem(POSTS_KEY, JSON.stringify(posts.value.slice(0, 30)));
  setItem(REACTS_KEY, JSON.stringify(myReacts.value));
}

/* —— 图片选择：预检(类型/体积) → 解码 → 体检(比例/像素) → 压缩 → 可用性校验 —— */
const imgErr = ref("");
function showImgErr(tk) {
  imgErr.value = tk;
  setTimeout(() => { imgErr.value = ""; }, 3200);
}
function pickImage(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const pre = validateImageFile(file);
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
      } catch (err) {
        showImgErr("community.imgFail");
      }
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

async function submit() {
  const text = draft.value.trim();
  if (!text && !imgData.value) {
    needText.value = true;
    setTimeout(() => { needText.value = false; }, 2500);
    return;
  }
  /* 云模式：写入 Supabase，成功后把返回的视图帖子插到最前 */
  if (canUseWall()) {
    const created = await cloudInsertPost({ text, imageDataUrl: imgData.value, name: wallName.value });
    if (created) {
      cloudPosts.value.unshift(created);
    } else {
      needText.value = true; /* cloud.error 已记录，用同一提示位（本地也存的住） */
      setTimeout(() => { needText.value = false; }, 2500);
      return;
    }
  } else {
    /* 本地模式：行为与第一批完全一致 */
    posts.value.unshift({
      id: Date.now(),
      name: nickname.value,
      text,
      img: imgData.value,
      ts: Date.now(),
      reacts: { hug: 0, warm: 0, relate: 0 },
    });
    persist();
  }
  draft.value = "";
  imgData.value = "";
  posted.value = true;
  setTimeout(() => { posted.value = false; }, 2500);
}

/* —— 回应：云端帖走 DB（点过可再点取消），本地/示例帖沿用「每样一次」 —— */
async function react(post, kind) {
  if (post.cloud && signedIn.value) {
    const fresh = await cloudToggleReaction(post.dbId, kind);
    if (fresh) { post.reacts = { hug: fresh.hug, warm: fresh.warm, relate: fresh.relate }; post.mine = fresh.mine; }
    return;
  }
  const key = post.sample ? post.id : String(post.id);
  if ((myReacts.value[key] || []).includes(kind)) return;
  post.reacts[kind]++;
  myReacts.value[key] = [...(myReacts.value[key] || []), kind];
  persist();
}

function hasReacted(post, kind) {
  /* 登录用户：云端帖以 DB 为准；游客/示例帖：看本机表态记录 */
  if (post.cloud && signedIn.value) return !!(post.mine && post.mine[kind]);
  const key = post.sample ? post.id : String(post.id);
  return (myReacts.value[key] || []).includes(kind);
}

/* —— 评论系统 ——
   逻辑全部在 src/utils/comments.js（纯函数，已通过 15 项 Node 单元测试） */
function loadComments() {
  let raw = {};
  try { raw = JSON.parse(getItem(CMT_KEY)) || {}; } catch (e) { raw = {}; }
  const seeded = seedComments(raw, i18n.locale);
  // 首次注入示范评论后立刻落盘：否则用户删掉它、刷新后又会冒出来
  if (seeded.__seeded && !raw.__seeded) setItem(CMT_KEY, JSON.stringify(seeded));
  return seeded;
}

const comments = ref(loadComments());
const openCmt = ref({});
const cmtDraft = ref({});

function persistCmt() {
  setItem(CMT_KEY, JSON.stringify(comments.value));
}
function cmtKey(p) { return postKey(p); }
function listFor(p) { return listComments(comments.value, p); }
function countFor(p) { return countComments(comments.value, p); }
/* 评论字数：输入框已用 :maxlength 硬限制在 MAX_LEN，这里只做展示（0 = 已达上限） */
function cmtLeft(p) {
  return MAX_LEN - String(cmtDraft.value[cmtKey(p)] || "").length;
}
function canDel(cm) {
  return canDelete(cm, nickname.value, cloud.user ? cloud.user.id : "");
}
function isOpen(p) { return !!openCmt.value[cmtKey(p)]; }
/* 云端帖评论拉取 TTL：展开时缓存超过 30s 就重拉，新评论不再需要刷新页面（P2 修复） */
const CMT_TTL = 30000;
const cmtFetchedAt = ref({});
function toggleCmt(p) {
  const k = cmtKey(p);
  openCmt.value[k] = !openCmt.value[k];
  if (openCmt.value[k] && p.cloud && canReadWall()
      && Date.now() - (cmtFetchedAt.value[k] || 0) > CMT_TTL) {
    cmtFetchedAt.value = { ...cmtFetchedAt.value, [k]: Date.now() };
    cloudFetchComments(p.dbId).then((rows) => {
      if (rows) comments.value = { ...comments.value, [k]: rows };
    });
  }
}
async function sendCmt(p) {
  const k = cmtKey(p);
  /* 云端帖：写库成功后把返回的视图评论追加到本地 store */
  if (p.cloud && canUseWall()) {
    const created = await cloudInsertComment(p.dbId, cmtDraft.value[k], wallName.value);
    if (!created) return;
    const arr = Array.isArray(comments.value[k]) ? comments.value[k].slice() : [];
    arr.push(created);
    comments.value = { ...comments.value, [k]: arr };
    cmtDraft.value[k] = "";
    return;
  }
  /* 本地/示例帖：纯函数逻辑（15 项单测覆盖的那套） */
  const r = addComment(comments.value, p, {
    name: nickname.value,
    text: cmtDraft.value[k],
  });
  if (!r.ok) return;
  comments.value = r.store;
  cmtDraft.value[k] = "";
  persistCmt();
}
async function delCmt(p, cm) {
  if (!canDel(cm)) return;
  /* 云端评论：先删库，成功再动本地镜像 */
  if (cm.cloud) {
    const done = await cloudDeleteComment(cm.dbId);
    if (!done) return;
  }
  comments.value = removeComment(comments.value, p, cm.id);
  persistCmt();
}

/* 动态流：云端就绪且拉到帖子 → 真实帖子；否则回退本机帖子（不再凭空消失）；示例帖永远在 */
const all = computed(() => [
  ...(cloud.ready && cloudPosts.value.length ? cloudPosts.value : posts.value),
  ...SAMPLES,
]);
const when = (ts) =>
  new Date(ts).toLocaleDateString(i18n.locale === "zh" ? "zh-CN" : "en-US",
    { month: "short", day: "numeric" });
</script>

<template>
  <div>
    <!-- 头部 + 发布框 -->
    <section class="card">
      <span class="sec-label">{{ t("nav.community") }}</span>
      <h2 style="margin-bottom: 4px">{{ t("community.title") }}</h2>
      <p class="sub">{{ t("community.subtitle") }}</p>

      <div class="composer">
        <n-input
          v-model:value="draft"
          type="textarea"
          :rows="3"
          :placeholder="t('community.placeholder')" />
        <img v-if="imgData" :src="imgData" class="preview" alt="preview" />
        <p v-if="imgErr" class="notice" style="color: var(--low); font-weight: 700">{{ t(imgErr) }}</p>
        <div class="composer-row">
          <label class="tool">
            🖼️ {{ t("community.addImage") }}
            <input type="file" accept="image/*" style="display: none" @change="pickImage" />
          </label>
          <n-button v-if="imgData" quaternary size="small" @click="imgData = ''">
            {{ t("community.removeImage") }}
          </n-button>
          <n-button type="primary" round style="margin-left: auto"
            :disabled="cloud.ready && !signedIn" @click="submit">
            {{ t("community.post") }}
          </n-button>
        </div>
        <p v-if="loadingCloud" class="notice">{{ t("community.loading") }}</p>
        <p v-if="posted" class="streak-note" style="color: var(--good); font-weight: 700">
          {{ t("home.dailyQ.thanks") }}
        </p>
        <p v-else-if="needText" class="streak-note" style="color: var(--low); font-weight: 700">
          {{ t("community.needText") }}
        </p>
        <p class="notice">
          {{ cloud.ready
            ? (signedIn ? t("community.cloudOn") : t("community.cloudNeedLogin"))
            : t("community.signInToPost") }}
        </p>
      </div>
    </section>

    <!-- 动态流 -->
    <article v-for="p in all" :key="p.id" class="post-card card">
      <div class="post-head">
        <n-avatar round :size="42" class="post-avatar">
          {{ p.sample ? "🌼" : "🙂" }}
        </n-avatar>
        <div class="post-meta">
          <div class="post-name">{{ p.name }}</div>
          <div class="post-time">{{ when(p.ts) }}</div>
        </div>
        <n-tag v-if="p.sample" round size="tiny" :bordered="false" class="soft-tag">
          {{ i18n.locale === "zh" ? "示例" : "sample" }}
        </n-tag>
      </div>

      <p class="post-text">{{ i18n.locale === "zh" && p.zh ? p.zh : p.text || p.en }}</p>
      <img v-if="p.img" :src="p.img" class="pic" alt="" />

      <div class="react-row">
        <n-button
          v-for="r in REACTIONS" :key="r.key"
          round size="small"
          :type="hasReacted(p, r.key) ? 'primary' : 'default'"
          :quaternary="!hasReacted(p, r.key)"
          @click="react(p, r.key)">
          {{ t(r.tk) }} · {{ p.reacts[r.key] }}
        </n-button>
      </div>

      <div class="cmt-toggle" @click="toggleCmt(p)">
        <span class="cmt-ico">&#128172;</span> {{ t("comment.count", { n: countFor(p) }) }}
      </div>
      <div v-if="isOpen(p)" class="cmt-box">
        <div v-for="cm in listFor(p)" :key="cm.id" class="cmt-item">
          <div class="cmt-head">
            <b>{{ cm.name }}</b><span>{{ when(cm.ts) }}</span>
            <button
              v-if="canDel(cm)"
              class="cmt-del" :title="t('common.delete')"
              @click="delCmt(p, cm)">×</button>
          </div>
          <p class="cmt-text">{{ cm.text }}</p>
        </div>
        <p v-if="!listFor(p).length" class="cmt-empty">{{ t("comment.empty") }}</p>
        <div class="cmt-input">
          <n-input
            v-model:value="cmtDraft[cmtKey(p)]"
            round size="small"
            :placeholder="t('comment.placeholder')"
            :maxlength="MAX_LEN"
            @keyup.enter="sendCmt(p)" />
          <n-button type="primary" size="small" round @click="sendCmt(p)">
            {{ t("common.send") }}
          </n-button>
          <p class="cmt-left" :class="{ full: cmtLeft(p) <= 0 }">
            {{ cmtLeft(p) <= 0 ? t("comment.full", { n: MAX_LEN }) : t("comment.left", { n: cmtLeft(p) }) }}
          </p>
        </div>
      </div>
    </article>

    <p class="notice" style="text-align: center">{{ t("community.sampleNotice") }}</p>
  </div>
</template>