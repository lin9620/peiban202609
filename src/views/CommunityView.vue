<script setup>
import { ref, computed, onMounted, watch, nextTick } from "vue";
import { useRouter, useRoute } from "vue-router";
import { NButton, NInput, NAvatar, NTag } from "naive-ui";
import { t, i18n } from "../i18n.js";
import { getItem, setItem } from "../utils/storage.js";
import {
  CMT_KEY, seedComments, addComment, removeComment, displayCount,
  canDelete, normalizeText, postKey, MAX_LEN,
  topComments, repliesOf, replyCount,
} from "../utils/comments.js";
import { cloud } from "../utils/supabase.js";
import {
  cloudFetchPosts, cloudInsertPost, cloudFetchComments, cloudInsertComment,
  cloudDeleteComment, cloudToggleReaction, cloudFetchCommentCounts, canUseWall, canReadWall,
  cloudAddView, cloudToggleDislike,
} from "../utils/wall.js";
/* 进阶规则（纯函数，Node 单测覆盖）：排序 / 浏览去重 / 厌恶比例下架 / 每日一条 */
import {
  SORTS, sortPosts, collectViews, visibleOnly, utcDay, ratioPct,
  canPostToday, errorKind, VIEW_KEY, ANON_KEY, POST_DAY_KEY,
  RANGES, inRange, usesRange, rangeFor,
} from "../utils/wallRules.js";
import {
  validateImageFile, isSaneShape, isUsableDataUrl, shrinkToDataUrl,
} from "../utils/imaging.js";

const POSTS_KEY = "warm-paws-posts-v1";
const REACTS_KEY = "warm-paws-reacts-v1";
const SORT_KEY = "warm-paws-sort-v1";   /* 记住用户选的排序方式 */

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
/* 云端帖评论数：进页面就一次性拉回来，不必等点赞开评论区（修复「有 2 条评论却显示 0」） */
const cloudCmtTotal = ref({});

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
  if (rows) {
    cloudPosts.value = rows;
    /* 传响应式数组（cloudPosts.value）而不是 rows：浏览数要靠「写代理」才会即时刷新到界面，
       直接改原始对象（raw）不会触发 Vue 的更新 */
    countViews(cloudPosts.value);
    /* 帖子到手就顺带拉一次「每帖评论数」：评论区标题马上有真实数字（含回复） */
    cloudFetchCommentCounts(rows.map((r) => r.dbId)).then((counts) => {
      if (!counts) return;
      const next = { ...cloudCmtTotal.value };
      for (const p of cloudPosts.value) {
        if (p.dbId != null) next[cmtKey(p)] = counts[p.dbId] || 0;
      }
      cloudCmtTotal.value = next;
    });
  }
  loadingCloud.value = false;
}

/* ═════════ 排序（默认最新；另有 同感/抱抱/暖暖 最多） ═════════ */
const sortMode = ref(SORTS.some((s) => s.key === getItem(SORT_KEY)) ? getItem(SORT_KEY) : SORTS[0].key);
function pickSort(key) {
  sortMode.value = key;
  setItem(SORT_KEY, key);
}

/* ═════════ 时间范围（只属于「最新」之外的排序） ═════════
 * 「最新」= 按时间看全部，本来就没有时间窗口 → 那一排按钮不显示，也不筛时间；
 * 同感/抱抱/暖暖最多 = 在选定的时间窗口里挑最多的 → 才显示按钮并筛。 */
const RANGE_KEY = "warm-paws-range-v1";   /* 记住用户选的时间范围（切回「最新」也不丢） */
const rangeMode = ref(RANGES.some((r) => r.key === getItem(RANGE_KEY)) ? getItem(RANGE_KEY) : RANGES[0].key);
function pickRange(key) {
  rangeMode.value = key;
  setItem(RANGE_KEY, key);
}

/* ═════════ 浏览数：同一访客对同一条帖，一天只 +1 ═════════ */
/* 未登录访客用本机匿名 id 当身份（服务器按这个去重，刷新页面不会刷高浏览量） */
function anonKey() {
  let v = getItem(ANON_KEY);
  if (!v) {
    v = "a-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    setItem(ANON_KEY, v);
  }
  return v;
}
const viewerKey = computed(() => (cloud.user && cloud.user.id) || anonKey());
let viewStamps = {};
try { viewStamps = JSON.parse(getItem(VIEW_KEY)) || {}; } catch (e) { viewStamps = {}; }
/* 把「今天还没看过的帖」告诉服务端 +1（服务端 wall_post_views 再兜一层去重） */
async function countViews(list) {
  const { stamps, pending } = collectViews(viewStamps, list, viewerKey.value);
  viewStamps = stamps;
  setItem(VIEW_KEY, JSON.stringify(stamps));
  for (const p of pending) {
    const r = await cloudAddView(p.dbId, viewerKey.value);
    if (!r) continue;
    p.views = r.views;
    p.reacts = { ...p.reacts, dislike: r.dislikes };
    if (r.removed) p.removed = true;   /* 已被下架：前台不再展示 */
  }
}

/* ════════ 厌恶：达到「厌恶 ÷ 浏览 ≥ 1%」由服务端下架（假删除） ═════════ */
async function dislike(p) {
  if (!(p.cloud && signedIn.value)) return;
  const r = await cloudToggleDislike(p.dbId);
  if (!r) {
    /* 失败给出可见提示，不静默：未迁移 → 告诉用户功能还没开；其它 → 让他重试 */
    showWallMsg(errorKind(cloud.error) === "not-migrated" ? "community.needSetup" : "community.dislikeFail");
    return;
  }
  p.views = r.views;
  p.reacts = { ...p.reacts, dislike: r.dislikes };
  p.mine = { ...p.mine, dislike: r.on };
  if (r.removed) {
    p.removed = true;
    showWallMsg("community.removed");
  }
}
/* 帖子里的轻提示（下架 / 今天发过了），几秒后自动消失 */
const wallMsg = ref("");
function showWallMsg(tk) {
  wallMsg.value = tk;
  setTimeout(() => { wallMsg.value = ""; }, 3600);
}

/* ════════ 每日限额：每个用户每天最多一条 ═════════ */
const postedDay = ref(getItem(POST_DAY_KEY) || "");
/* 本地模式也守同样的规矩（云端帖看「今天有没有我发的」；本机模式看本机记录） */
const postedToday = computed(() => !canPostToday({
  list: cloudPosts.value,
  userId: (cloud.user && cloud.user.id) || "",
  day: utcDay(),
  localDay: postedDay.value,
}));

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
  /* 每个用户每天最多一条（库里还有触发器兜底，这里是给用户的即时反馈） */
  if (postedToday.value) return showWallMsg("community.dailyLimit");

  /* 云模式：写入 Supabase，成功后把返回的视图帖子插到最前 */
  if (canUseWall()) {
    const created = await cloudInsertPost({ text, imageDataUrl: imgData.value, name: wallName.value });
    if (created) {
      cloudPosts.value.unshift(created);
    } else {
      /* 云端拒绝时区分原因：每日限额 / 未跑迁移 / 其它（cloud.error 已记录） */
      const kind = errorKind(cloud.error);
      showWallMsg(kind === "daily-limit" ? "community.dailyLimit"
        : kind === "not-migrated" ? "community.needSetup" : "community.postFail");
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
  postedDay.value = utcDay();      /* 记下「今天已发」 */
  setItem(POST_DAY_KEY, postedDay.value);
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
/* 该帖评论是否已拉到本地：是数组 → 本地列表为准；undefined → 用云端聚合数（见 displayCount） */
function listed(p) { return comments.value[cmtKey(p)]; }
/* 一级评论（主列表） */
function listFor(p) { return topComments(comments.value, p); }
/* 某条一级评论下的回复（二级） */
function repliesFor(p, cm) { return repliesOf(comments.value, p, cm.id); }
function repliesN(p, cm) { return replyCount(comments.value, p, cm.id); }
/* 评论数：本地有列表就数本地，没有就先用进页面时拉到云端总数（不再显示成 0） */
function countFor(p) {
  return displayCount(listed(p), cloudCmtTotal.value[cmtKey(p)] || 0);
}
/* 云端帖评论总数随本地增删走：写/删一条后同步一下缓存，避免回退显示旧数字 */
function syncTotal(p) {
  const k = cmtKey(p);
  if (p.cloud && Array.isArray(listed(p))) {
    cloudCmtTotal.value = { ...cloudCmtTotal.value, [k]: listed(p).length };
  }
}
/* 评论字数：输入框已用 :maxlength 硬限制在 MAX_LEN，这里只做展示（0 = 已达上限） */
function cmtLeft(p) {
  return MAX_LEN - String(cmtDraft.value[cmtKey(p)] || "").length;
}
function canDel(cm) {
  return canDelete(cm, nickname.value, cloud.user ? cloud.user.id : "");
}
/* 展开/收起二级回复：与话题区同为「N 条回复」点击展开（默认收起，评论多时不刷屏） */
const openRep = ref({});
function repOpenKey(p, cm) { return cmtKey(p) + ":" + cm.id; }
function isRepOpen(p, cm) { return !!openRep.value[repOpenKey(p, cm)]; }
function toggleReplies(p, cm) {
  const k = repOpenKey(p, cm);
  openRep.value = { ...openRep.value, [k]: !openRep.value[k] };
}
/* —— 回复目标（二级评论输入框）：replyTo[k] = 挂在哪条一级评论下；atName[k] = 要 @ 谁（回复别人的回复时） —— */
const replyTo = ref({});
const atName = ref({});
function isReplyOpen(p, cm) { return replyTo.value[cmtKey(p)] === cm.id; }
/* 回复一级评论：挂到它下面，不 @（视觉上已经挨着作者） */
function openReply(p, cm) {
  const k = cmtKey(p);
  replyTo.value = { ...replyTo.value, [k]: cm.id };
  atName.value = { ...atName.value, [k]: "" };
  if (p.cloud && canReadWall()) loadThread(p); /* 顺手刷新，边看边回 */
}
/* 回复某条回复：仍挂在同一个一级评论下（两级封顶），并 @ 这位回复者 */
function openReplyTo(p, cm, rp) {
  const k = cmtKey(p);
  replyTo.value = { ...replyTo.value, [k]: cm.id };
  atName.value = { ...atName.value, [k]: rp.name || "" };
  openRep.value = { ...openRep.value, [repOpenKey(p, cm)]: true };
}
function cancelReply(p) {
  const k = cmtKey(p);
  const nextTo = { ...replyTo.value };
  const nextAt = { ...atName.value };
  delete nextTo[k];
  delete nextAt[k];
  replyTo.value = nextTo;
  atName.value = nextAt;
}
/* 只在该评论正是当前回复目标时才收起回复框（删别的评论不影响正在写的回复） */
function cancelReplyIfTarget(p, cm) {
  if (replyTo.value[cmtKey(p)] === cm.id) cancelReply(p);
}
/* 回复框占位文案：「回复 xxx…」（xxx 优先取 @ 的对象） */
function repPlaceholder(p, cm) {
  const n = atName.value[cmtKey(p)] || cm.name;
  return t("comment.replyPh", { n });
}
/* 二级评论草稿（与一级评论分开，互不干扰） */
const repDraft = ref({});
function repKey(p, cm) { return cmtKey(p) + ":" + cm.id; }
function repLeft(p, cm) { return MAX_LEN - String(repDraft.value[repKey(p, cm)] || "").length; }
/* 发送失败提示（云端未迁移 parent_id / 断网 / RLS 拒绝都别静默失败，草稿保留）
   默认是评论发送失败文案；传 tk 可换成别的（如本地已达每帖上限） */
const cmtErr = ref("");
function showCmtErr(tk = "comment.fail") {
  cmtErr.value = t(tk);
  setTimeout(() => { cmtErr.value = ""; }, 3200);
}
function isOpen(p) { return !!openCmt.value[cmtKey(p)]; }
/* 云端帖评论拉取 TTL：展开时缓存超过 30s 就重拉，新评论不再需要刷新页面（P2 修复） */
const CMT_TTL = 30000;
const cmtFetchedAt = ref({});
/* 拉取（或按 TTL 重拉）某帖评论明细；pending 防重入，失败时按 TTL 重试 */
const cmtLoading = ref({});
function loadThread(p, force = false) {
  if (!p.cloud || !canReadWall()) return;
  const k = cmtKey(p);
  if (cmtLoading.value[k]) return;
  if (!force && Date.now() - (cmtFetchedAt.value[k] || 0) < CMT_TTL) return;
  cmtFetchedAt.value = { ...cmtFetchedAt.value, [k]: Date.now() };
  cmtLoading.value = { ...cmtLoading.value, [k]: true };
  cloudFetchComments(p.dbId).then((rows) => {
    const next = { ...cmtLoading.value };
    delete next[k];
    cmtLoading.value = next;
    if (!rows) {
      /* 拉失败：把时间戳归零，下次展开/重试立刻再来一次，而不是干等 30s */
      cmtFetchedAt.value = { ...cmtFetchedAt.value, [k]: 0 };
      return;
    }
    comments.value = { ...comments.value, [k]: rows };
    cloudCmtTotal.value = { ...cloudCmtTotal.value, [k]: rows.length };
  });
}
function toggleCmt(p) {
  const k = cmtKey(p);
  openCmt.value = { ...openCmt.value, [k]: !openCmt.value[k] };
  if (openCmt.value[k]) loadThread(p);
}
/**
 * 发表评论。
 *  - 传 cm → 作为二级回复挂到该一级评论下（云端写 parent_id，本地写 parentId）
 *  - 不传 → 一级评论
 * 草稿取 `cmtDraft`（一级）或 `repDraft`（二级），两者互不干扰。
 */
async function sendCmt(p, cm = null) {
  const k = cmtKey(p);
  const rk = cm ? repKey(p, cm) : k;
  const draftRef = cm ? repDraft : cmtDraft;
  const text = draftRef.value[rk];
  if (!normalizeText(text)) return;
  /* 回复某条回复时记下的 @ 对象（回复一级评论时为空） */
  const at = cm ? atName.value[k] || "" : "";

  /* 云端帖：写库成功后把返回的视图评论追加到本地 store */
  if (p.cloud && canUseWall()) {
    const parentDbId = cm ? cm.dbId : null;
    const created = await cloudInsertComment(p.dbId, text, wallName.value, {
      parentId: parentDbId,
      replyToName: at,
    });
    if (!created) return showCmtErr(); /* 草稿留着，用户可以直接重试 */
    const arr = Array.isArray(comments.value[k]) ? comments.value[k].slice() : [];
    arr.push(created);
    comments.value = { ...comments.value, [k]: arr };
    draftRef.value = { ...draftRef.value, [rk]: "" };
    if (cm) {
      openRep.value = { ...openRep.value, [repOpenKey(p, cm)]: true }; /* 回复完顺手展开 */
      onReplyDone(p);
    }
    syncTotal(p);
    return;
  }

  /* 本地/示例帖：纯函数逻辑（Node 单测覆盖的那套） */
  const r = addComment(comments.value, p, {
    name: nickname.value,
    text,
    parentId: cm ? cm.id : null,
    replyTo: at,
  });
  if (!r.ok) return showCmtErr(); /* 本地失败（如达每帖上限）也给出提示 */
  comments.value = r.store;
  draftRef.value = { ...draftRef.value, [rk]: "" };
  if (cm) {
    openRep.value = { ...openRep.value, [repOpenKey(p, cm)]: true };
    onReplyDone(p);
  }
  persistCmt();
}
/* 回复成功后：清掉 @ 对象，但保留回复框位置，方便连着回第二条 */
function onReplyDone(p) {
  const k = cmtKey(p);
  if (!atName.value[k]) return;
  atName.value = { ...atName.value, [k]: "" };
}
async function delCmt(p, cm) {
  if (!canDel(cm)) return;
  /* 云端评论：先删库，成功再动本地镜像 */
  if (cm.cloud) {
    const done = await cloudDeleteComment(cm.dbId);
    if (!done) return;
  }
  comments.value = removeComment(comments.value, p, cm.id);
  cancelReplyIfTarget(p, cm); /* 正在回复这条时，删完就收起回复框 */
  persistCmt();
  syncTotal(p);
}

/* 动态流：云端就绪且拉到帖子 → 真实帖子；否则回退本机帖子（不再凭空消失）；示例帖永远在 */
const all = computed(() => [
  ...(cloud.ready && cloudPosts.value.length ? cloudPosts.value : posts.value),
  ...SAMPLES,
]);
/* 展示用：先剔掉已下架（假删除）的帖子，再按当前排序实际生效的时间范围筛
 * （「最新」= 全部，其余按用户选的档位），最后按当前排序方式排 */
const shown = computed(() =>
  sortPosts(
    visibleOnly(all.value).filter((p) => inRange(p, rangeFor(sortMode.value, rangeMode.value))),
    sortMode.value
  ));
/* 下架线提示用：厌恶 ÷ 浏览（达 1% 即下架，看得到比例就知道离下架多远） */
function disPct(p) { return ratioPct(p.views, (p.reacts && p.reacts.dislike) || 0); }

/* 头像/昵称 → TA 的墙上的主页（/u/:id）；示例帖与本地帖没有云身份，不响应点击 */
const router = useRouter();
function canOpen(p) { return !!(p && p.cloud && p.userId); }
function goProfile(p) { if (canOpen(p)) router.push({ name: "waller", params: { id: p.userId } }); }

const when = (ts) =>
  new Date(ts).toLocaleDateString(i18n.locale === "zh" ? "zh-CN" : "en-US",
    { month: "short", day: "numeric" });

/* —— 深链到某帖：/community?post=<dbId>（通知中心点「评论/回应」跳回来时用） ——
 * 云端帖的 dbId 才是数据库里的真实 id；还没加载出来（或不是本页可见帖）就什么都不做。 */
const route = useRoute();
const focusId = ref(String(route.query.post || ""));

function findPostEl(id) {
  if (typeof document === "undefined" || !id) return null;
  return document.getElementById(`post-${id}`);
}

async function focusPost(id) {
  const key = String(id || "");
  focusId.value = key;
  if (!key) return;
  await nextTick();
  const el = findPostEl(key);
  if (el && el.scrollIntoView) {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

/* 首屏（含云端帖异步到达）与地址栏变化都要重新定位一次 */
watch(() => route.query.post, (v) => focusPost(v), { immediate: false });
watch(cloudPosts, () => { if (focusId.value) focusPost(focusId.value); });
onMounted(() => { if (focusId.value) focusPost(focusId.value); });
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
        <p v-if="wallMsg" class="streak-note" style="color: var(--low); font-weight: 700">
          {{ t(wallMsg) }}
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

    <!-- 排序：默认最新；还有 同感最多 / 抱抱最多 / 暖暖最多 -->
    <div class="sort-row">
      <span class="sort-label">{{ t("community.sortLabel") }}</span>
      <button
        v-for="s in SORTS" :key="s.key"
        class="sort-btn" :class="{ on: sortMode === s.key }"
        @click="pickSort(s.key)">
        {{ t(s.tk) }}
      </button>
    </div>

    <!-- 时间范围：只在「最新」之外的排序下出现（「最新」= 看全部最新内容，没有时间窗口） -->
    <div v-if="usesRange(sortMode)" class="sort-row range-row">
      <span class="sort-label">{{ t("community.rangeLabel") }}</span>
      <button
        v-for="r in RANGES" :key="r.key"
        class="sort-btn" :class="{ on: rangeMode === r.key }"
        @click="pickRange(r.key)">
        {{ t(r.tk) }}
      </button>
    </div>

    <!-- 动态流 -->
    <article v-for="p in shown" :key="p.id" class="post-card card"
      :id="p.dbId != null ? 'post-' + p.dbId : undefined"
      :class="{ 'post-focus': focusId && String(p.dbId) === focusId }">
      <div class="post-head">
        <n-avatar round :size="42" class="post-avatar"
          :class="{ clickable: canOpen(p) }"
          :title="canOpen(p) ? t('community.viewHome') : ''"
          @click="goProfile(p)">
          {{ p.sample ? "🌼" : "🙂" }}
        </n-avatar>
        <div class="post-meta">
          <div class="post-name"
            :class="{ clickable: canOpen(p) }"
            :title="canOpen(p) ? t('community.viewHome') : ''"
            @click="goProfile(p)">{{ p.name }}</div>
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

      <!-- 浏览数 + 厌恶：厌恶 ÷ 浏览 达 1% 会被自动下架（假删除，数据仍在库里） -->
      <!-- p.stats：只有库跑过迁移、真拿到统计字段才显示，避免未迁移时出现假的「0 次浏览」 -->
      <div v-if="p.cloud && p.stats" class="post-foot">
        <span class="post-views">&#128065; {{ t("community.views", { n: p.views || 0 }) }}</span>
        <button
          class="post-dis" :class="{ on: p.mine && p.mine.dislike }"
          :disabled="!signedIn"
          :title="signedIn ? t('community.dislikeHint') : t('community.dislikeSignIn')"
          @click="dislike(p)">
          &#128078; {{ p.reacts.dislike || 0 }}
        </button>
        <span v-if="p.reacts.dislike" class="post-ratio">{{ disPct(p) }}</span>
        <span class="post-ratio-hint">{{ t("community.dislikeRule") }}</span>
      </div>

      <div class="cmt-toggle" @click="toggleCmt(p)">
        <span class="cmt-ico">&#128172;</span> {{ t("comment.count", { n: countFor(p) }) }}
        <span class="cmt-caret" :class="{ open: isOpen(p) }">&#9662;</span>
      </div>
      <div v-if="isOpen(p)" class="cmt-box">
        <p v-if="cmtErr" class="cmt-empty" style="color: var(--low); font-weight: 700">{{ cmtErr }}</p>
        <p v-if="cmtLoading[cmtKey(p)] && !listed(p)" class="cmt-empty">
          {{ t("community.loading") }}
        </p>

        <!-- 一级评论 -->
        <div v-for="cm in listFor(p)" :key="cm.id" class="cmt-item">
          <div class="cmt-head">
            <b :class="{ clickable: canOpen(cm) }"
               :title="canOpen(cm) ? t('community.viewHome') : ''"
               @click="goProfile(cm)">{{ cm.name }}</b><span>{{ when(cm.ts) }}</span>
            <button
              v-if="canDel(cm)"
              class="cmt-del" :title="t('common.delete')"
              @click="delCmt(p, cm)">×</button>
          </div>
          <p class="cmt-text">{{ cm.text }}</p>

          <div class="cmt-acts">
            <button class="cmt-act" @click="openReply(p, cm)">{{ t("comment.reply") }}</button>
            <button
              v-if="repliesN(p, cm)"
              class="cmt-act cmt-act-rep"
              @click="toggleReplies(p, cm)">
              {{ t("comment.replies", { n: repliesN(p, cm) }) }}
              <i :class="{ open: isRepOpen(p, cm) }">&#9662;</i>
            </button>
          </div>

          <!-- 二级：回复列表（默认收起，点「N 条回复」展开） -->
          <div v-if="isRepOpen(p, cm) && repliesN(p, cm)" class="cmt-reps">
            <div v-for="rp in repliesFor(p, cm)" :key="rp.id" class="cmt-rep">
              <div class="cmt-head">
                <b><span :class="{ clickable: canOpen(rp) }"
                        :title="canOpen(rp) ? t('community.viewHome') : ''"
                        @click="goProfile(rp)">{{ rp.name }}</span><span class="cmt-at" v-if="rp.replyTo">@{{ rp.replyTo }}</span></b>
                <span>{{ when(rp.ts) }}</span>
                <button
                  v-if="canDel(rp)"
                  class="cmt-del" :title="t('common.delete')"
                  @click="delCmt(p, rp)">×</button>
              </div>
              <p class="cmt-text">{{ rp.text }}</p>
              <div class="cmt-acts">
                <button class="cmt-act" @click="openReplyTo(p, cm, rp)">
                  {{ t("comment.reply") }}
                </button>
              </div>
            </div>
          </div>

          <!-- 二级：就地回复框 -->
          <div v-if="isReplyOpen(p, cm)" class="cmt-input cmt-input-rep">
            <n-input
              v-model:value="repDraft[repKey(p, cm)]"
              round size="small"
              :placeholder="repPlaceholder(p, cm)"
              :maxlength="MAX_LEN"
              @keyup.enter="sendCmt(p, cm)" />
            <n-button type="primary" size="small" round @click="sendCmt(p, cm)">
              {{ t("common.send") }}
            </n-button>
            <n-button quaternary size="small" round @click="cancelReply(p)">
              {{ t("comment.cancel") }}
            </n-button>
            <p class="cmt-left" :class="{ full: repLeft(p, cm) <= 0 }">
              {{ repLeft(p, cm) <= 0 ? t("comment.full", { n: MAX_LEN }) : t("comment.left", { n: repLeft(p, cm) }) }}
            </p>
          </div>
        </div>

        <p v-if="!listFor(p).length && !(cmtLoading[cmtKey(p)] && !listed(p))" class="cmt-empty">
          {{ t("comment.empty") }}
        </p>

        <!-- 新评论（一级） -->
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