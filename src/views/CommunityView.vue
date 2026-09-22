<script setup>
import { ref, computed, onMounted, watch, nextTick } from "vue";
import { useRouter, useRoute } from "vue-router";
import { NButton, NInput, NAvatar, NTag } from "naive-ui";
import { t, i18n } from "../i18n.js";
import { getItem, setItem } from "../utils/storage.js";
/* 轮 32：个人数据键按账号分域（游客账/各登录账号互不串），读写走 scopeGet/scopeSet */
import { scopeGet, scopeSet, scopeGetRaw, scopeSetRaw } from "../utils/userScope.js";
import { cacheKey, swr } from "../utils/cache.js";
import {
  CMT_KEY, seedComments, addComment, removeComment, displayCount,
  canDelete, normalizeText, postKey, MAX_LEN,
  topComments, repliesOf, replyCount,
} from "../utils/comments.js";
import { cloud } from "../utils/supabase.js";
/* 回应写入收敛器（纯逻辑，Node 单测覆盖）：连点串行落库 + 过期响应不回写 */
import { createWriteQueue } from "../utils/reactQueue.js";
import {
  cloudFetchPosts, cloudInsertPost, cloudFetchComments, cloudInsertComment,
  cloudDeleteComment, cloudSetReaction, cloudFetchCommentCounts, canUseWall, canReadWall,
  cloudAddView, cloudToggleDislike,
} from "../utils/wall.js";
/* 进阶规则（纯函数，Node 单测覆盖）：排序 / 浏览去重 / 厌恶比例下架 / 每日一条 */
import {
  SORTS, sortPosts, collectViews, visibleOnly, utcDay, ratioPct,
  canPostToday, postsLeftToday, dayCountFromStorage, WALL_POST_DAILY_LIMIT,
  errorKind, VIEW_KEY, ANON_KEY, POST_DAY_KEY, POSTS_KEY, REACTS_KEY,
  RANGES, inRange, usesRange, rangeFor, fmtWhen,
  recommendPosts, RECOMMEND_DAYS,
} from "../utils/wallRules.js";
import { isMobileNav } from "../stores/uiStore.js";
/* 轮 33：举报弹窗 + 全站拉黑过滤（我拉黑的人，TA 的帖子/评论在我这里渲染前剔除） */
import ReportDialog from "../components/ReportDialog.vue";
import { filterBlocked, refreshBlocks } from "../utils/userBlocks.js";
import {
  validateImageFile, isSaneShape, isUsableDataUrl, shrinkToDataUrl,
} from "../utils/imaging.js";

/* POSTS_KEY/REACTS_KEY 已上移 wallRules.js 并按账号分域（轮 32）；
 * SORT_KEY 是设备级偏好（换号保留同一台机器的使用习惯），故意不进账号域。 */
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
  posts.value = scopeGet(POSTS_KEY, []) || [];
  myReacts.value = scopeGet(REACTS_KEY, {}) || {};
  if (cloud.ready) loadCloud();
  refreshBlocks();   /* 轮 33：拉黑名单就绪（快照先撑着，云端校准） */
});
/* 云端就绪晚于挂载（异步探测）→ 就绪后补拉一次；未登录也拉（RLS 匿名只读） */
watch(() => cloud.ready, (v) => {
  if (v && !cloudPosts.value.length) loadCloud();
});
/* 会话从无到有（登录完成）→ 用本人身份重拉一次：帖子的 mine（我点过谁）才准确，
   否则「我点过的抱抱」显示成没点，再点一次会把旧的取消掉（用户实测「取消不了」的根因）。 */
watch(() => cloud.user && cloud.user.id, (uid) => {
  if (cloud.ready && uid) {
    refreshBlocks();   /* 轮 33：登录后同步我的拉黑名单（过滤靠它） */
    if (cloudPosts.value.length) loadCloud();
  }
});

async function loadCloud() {
  loadingCloud.value = true;
  /* 本地优先（SWR）：缓存「帖 + 每帖评论数」整包 → 二次进页不闪「载入中」，评论数也是真的 */
  const consume = (box) => {
    /* 轮 33：全站拉黑 —— 我拉黑的人的帖子在渲染前剔除（对方不知情） */
    cloudPosts.value = filterBlocked(box.rows);
    /* 传响应式数组（cloudPosts.value）而不是 rows：浏览数要靠「写代理」才会即时刷新到界面，
       直接改原始对象（raw）不会触发 Vue 的更新 */
    countViews(cloudPosts.value);
    if (box.counts) {
      const next = { ...cloudCmtTotal.value };
      for (const p of cloudPosts.value) {
        if (p.dbId != null) next[cmtKey(p)] = box.counts[p.dbId] || 0;
      }
      cloudCmtTotal.value = next;
    }
  };
  await swr(
    cacheKey("wall:posts", (cloud.user && cloud.user.id) || ""),
    { cached: consume, fresh: consume },
    async () => {
      const rows = await cloudFetchPosts();
      if (!rows) return null;   /* 拉取失败（原有语义）→ 不覆盖、不回写缓存 */
      const counts = await cloudFetchCommentCounts(rows.map((r) => r.dbId)).catch(() => null);
      return { rows, counts: counts || {} };
    },
  );
  loadingCloud.value = false;
}

/* ═════════ 排序（推荐 / 同感 / 抱抱 / 暖暖 最多） ═════════
 * 用户反馈：把「最新」从按钮排里去掉（推荐流本身按新鲜度混排，看最新内容点推荐即可）。
 * 存档里存了老值 "new" → 静默迁回默认「推荐」，不让一个已消失的按钮悬空高亮。 */
const SORT_BTNS = SORTS.filter((s) => s.key !== "new");
const sortMode = ref(SORT_BTNS.some((s) => s.key === getItem(SORT_KEY)) ? getItem(SORT_KEY) : SORT_BTNS[0].key);
if (getItem(SORT_KEY) === "new") setItem(SORT_KEY, SORT_BTNS[0].key);
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
/* 未登录访客用本机匿名 id 当身份（服务器按这个去重，刷新页面不会刷高浏览量）；
 * 匿名 id 也按账号域存（轮 32）——只在游客态读写，实际恒落 guest 域，升级时老 id 会迁移过去 */
function anonKey() {
  let v = scopeGetRaw(ANON_KEY);
  if (!v) {
    v = "a-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    scopeSetRaw(ANON_KEY, v);
  }
  return v;
}
const viewerKey = computed(() => (cloud.user && cloud.user.id) || anonKey());
let viewStamps = {};
viewStamps = scopeGet(VIEW_KEY, {}) || {};
/* 把「今天还没看过的帖」告诉服务端 +1（服务端 wall_post_views 再兜一层去重） */
async function countViews(list) {
  const { stamps, pending } = collectViews(viewStamps, list, viewerKey.value);
  viewStamps = stamps;
  scopeSetRaw(VIEW_KEY, JSON.stringify(stamps));
  for (const p of pending) {
    const r = await cloudAddView(p.dbId, viewerKey.value);
    if (!r) continue;
    p.views = r.views;
    p.reacts = { ...p.reacts, dislike: r.dislikes };
    if (r.removed) p.removed = true;   /* 已被下架：前台不再展示 */
  }
}

/* ═════════ 举报（轮 33）：帖子/评论入口 → ReportDialog（防刷/去重/评论阈值在服务端） ═════════ */
const reportShow = ref(false);
const reportTarget = ref(null);
function openReportPost(p) {
  if (!p || p.dbId == null) return;
  reportTarget.value = { type: "post", id: p.dbId, label: p.text || p.en || "" };
  reportShow.value = true;
}
function openReportCmt(cm) {
  /* 云端评论的数字主键在 dbId（id 是带 c 前缀的本地渲染键） */
  if (!cm || !cm.cloud || cm.dbId == null) return;
  reportTarget.value = { type: "comment", id: cm.dbId, label: cm.text || "" };
  reportShow.value = true;
}
/* 自己的东西不需要举报；游客不能举报（弹窗里也会再提示登录） */
const canReportPost = (p) => !!(p && p.cloud && p.dbId != null && signedIn.value && p.userId && p.userId !== myUid.value);
const canReportCmt = (cm) => !!(cm && cm.cloud && cm.dbId != null && signedIn.value && cm.userId && cm.userId !== myUid.value);

/* ════════ 厌恶：#26 双档下架线由服务端假删除（浏览<100 时 >3 个；≥100 时 >0.5%） ═════════ */
async function dislike(p) {
  /* #28 未登录：不静默，给一句温柔的登录提示 */
  if (p.cloud && !signedIn.value) return showWallMsg("community.dislikeSignIn");
  if (!(p.cloud && signedIn.value)) return;
  /* #29 乐观翻转：先改 UI（跟手），网络回来用权威计数校正；失败回滚 */
  const wasOn = !!(p.mine && p.mine.dislike);
  p.mine = { ...(p.mine || {}), dislike: !wasOn };
  p.reacts = { ...p.reacts, dislike: Math.max(0, (p.reacts.dislike || 0) + (wasOn ? -1 : 1)) };
  const r = await cloudToggleDislike(p.dbId);
  if (!r) {
    p.mine = { ...(p.mine || {}), dislike: wasOn };
    p.reacts = { ...p.reacts, dislike: Math.max(0, (p.reacts.dislike || 0) + (wasOn ? 1 : -1)) };
    showWallMsg(errorKind(cloud.error) === "not-migrated" ? "community.needSetup" : "community.dislikeFail");
    return;
  }
  p.views = r.views;
  p.reacts = { ...p.reacts, dislike: r.dislikes };
  p.mine = { ...p.mine, dislike: r.on };
  /* 我点了厌恶 → 这条帖立即从我的流里消失（服务端双档下架线仍管全局可见性） */
  if (r.on || r.removed) {
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

/* ════════ 原生下拉刷新（轮 18 补做：用户点名「完全没做」）════════
 * touchstart 在页面顶部下拉 → 松手重拉云端。走 SWR（loadCloud）：
 * 先渲染缓存再后台刷新，不闪白屏；60px 阈值，指示条跟手。 */
let pullStart = 0, pulling = false;
const pullDist = ref(0);
function ts(e) { if (window.scrollY <= 0) { pullStart = e.touches[0].clientY; pulling = true; } }
function tm(e) {
  if (!pulling) return;
  const d = e.touches[0].clientY - pullStart;
  if (d > 0 && window.scrollY <= 0) pullDist.value = Math.min(90, d);
  else pulling = false;
}
async function te() {
  if (!pulling) return;
  pulling = false;
  if (pullDist.value >= 62) await loadCloud();
  pullDist.value = 0;
}

/* ════════ 每日限额：每个用户每天最多 7 条（WALL_POST_DAILY_LIMIT，库触发器同口径） ═════════ */
const postedCount = ref(dayCountFromStorage(scopeGetRaw(POST_DAY_KEY)));   /* 本机今天已发几条（旧格式日期串兼容） */
const myUid = computed(() => (cloud.user && cloud.user.id) || "");
/* 本地模式也守同样的规矩（云端帖数「今天我发了几条」；本机模式看本机记账）。
 * 两者不叠加：云端已登录时刚发的帖既被 unshift 进列表又记了本机账，会少算一倍余量
 * —— 所以登录态以云端列表为准，纯本地模式才用本机记账。 */
const postedToday = computed(() => !canPostToday({
  list: cloudPosts.value,
  userId: myUid.value,
  day: utcDay(),
  localCount: cloud.ready && myUid.value ? 0 : postedCount.value,
}));
const postsLeft = computed(() => postsLeftToday({
  list: cloudPosts.value,
  userId: myUid.value,
  day: utcDay(),
  localCount: cloud.ready && myUid.value ? 0 : postedCount.value,
}));

/* 发帖成功后本机记账 +1（{ day, n } 格式；旧日期串/跨天由 dayCountFromStorage 兜住）。
 * 记账按账号域分键（轮 32）：A 发满 7 条不会把 B 也锁在墙外。 */
function bumpPostedCount() {
  const day = utcDay();
  postedCount.value = dayCountFromStorage(scopeGetRaw(POST_DAY_KEY), day) + 1;
  scopeSetRaw(POST_DAY_KEY, JSON.stringify({ day, n: postedCount.value }));
}

function persist() {
  scopeSet(POSTS_KEY, posts.value.slice(0, 30));
  scopeSet(REACTS_KEY, myReacts.value);
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

  /* 云模式：写入 Supabase，成功后把返回的视图帖子插到最前（余量以这份列表为准，无需本机记账） */
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
    /* 本地模式：行为与第一批完全一致；余量只有本机记账兜着 */
    posts.value.unshift({
      id: Date.now(),
      name: nickname.value,
      text,
      img: imgData.value,
      ts: Date.now(),
      reacts: { hug: 0, warm: 0, relate: 0 },
    });
    persist();
    bumpPostedCount();
  }
  draft.value = "";
  imgData.value = "";
  posted.value = true;
  setTimeout(() => { posted.value = false; }, 2500);
}

/* —— 回应：点击即变（乐观更新），再点一次 = 取消（#29 跟手）——
   登录用户走 DB（服务端权威计数按幂等「设置」写）；示例/本地帖沿用本机表态 ——
   连点两下必须当场生效，两道保险都在 src/utils/reactQueue.js（纯逻辑 + Node 单测）：
     ① 同帖同回应串行落库（杜绝「查-插」并发撞唯一键）
     ② 每次点击领序号，过期响应不回写（慢响应不许覆盖后来的意图） */
const reactQ = createWriteQueue();
const reactSaved = new WeakMap();    /* post → 服务端已确认的 {reacts, mine}（失败回滚用） */
async function reactSync(post, kind, k, seq) {
  const on = hasReacted(post, kind);            /* 执行时再取意图：连点时以最新一次为准 */
  const fresh = await cloudSetReaction(post.dbId, kind, on);
  /* 期间又点过（序号变了）：这次响应过期，什么都别改，后面的任务会把最终状态写对 */
  if (!reactQ.isLatest(k, seq)) return;
  if (fresh) {
    post.reacts = { hug: fresh.hug, warm: fresh.warm, relate: fresh.relate };
    post.mine = fresh.mine;
    reactSaved.set(post, { reacts: { ...post.reacts }, mine: { ...fresh.mine } });
    return;
  }
  /* 失败：回滚到服务端最后确认的状态（不是「再翻一次」，避免连点后状态错乱） */
  const back = reactSaved.get(post);
  if (back) { post.reacts = { ...back.reacts }; post.mine = { ...back.mine }; }
  showWallMsg(errorKind(cloud.error) === "not-migrated" ? "community.needSetup" : "community.reactFail");
}
function react(post, kind) {
  if (post.cloud && signedIn.value) {
    if (!reactSaved.has(post)) {
      reactSaved.set(post, { reacts: { ...post.reacts }, mine: { ...(post.mine || {}) } });
    }
    const wasOn = !!(post.mine && post.mine[kind]);
    post.mine = { ...(post.mine || {}), [kind]: !wasOn };
    post.reacts = { ...post.reacts, [kind]: Math.max(0, (post.reacts[kind] || 0) + (wasOn ? -1 : 1)) };
    const k = `${post.dbId}:${kind}`;
    const seq = reactQ.claim(k);
    reactQ.push(k, () => reactSync(post, kind, k, seq));
    return;
  }
  /* #28 未登录不能参与云端帖的回应（别人看不到的假 +1 只会误导）；示例帖保持本地演示 */
  if (post.cloud && !signedIn.value) return showWallMsg("community.reactSignIn");
  const key = post.sample ? post.id : String(post.id);
  const mine = myReacts.value[key] || [];
  if (mine.includes(kind)) {
    post.reacts[kind] = Math.max(0, (post.reacts[kind] || 0) - 1);   /* 再点一次 = 取消 */
    myReacts.value[key] = mine.filter((x) => x !== kind);
  } else {
    post.reacts[kind] = (post.reacts[kind] || 0) + 1;
    myReacts.value[key] = [...mine, kind];
  }
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
  const raw = scopeGet(CMT_KEY, {}) || {};
  const seeded = seedComments(raw, i18n.locale);
  // 首次注入示范评论后立刻落盘：否则用户删掉它、刷新后又会冒出来
  if (seeded.__seeded && !raw.__seeded) scopeSetRaw(CMT_KEY, JSON.stringify(seeded));
  return seeded;
}

const comments = ref(loadComments());
const openCmt = ref({});
const cmtDraft = ref({});

function persistCmt() {
  scopeSetRaw(CMT_KEY, JSON.stringify(comments.value));
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
/* ─── 回复某条二级评论（用户反馈：点二级「回复」像没反应）───
 * 老实现把输入框固定画在「一级评论最底部」：二级评论一多，框就出现在离手指很远的地方
 * （甚至需要滚动才看得见）→ 用户以为点了没用。
 * 现在改成就地出现：`replyRp[repKey(p, cm)] = 被回复的那条二级评论 id`，
 * 输入框渲染在该条二级评论正下方；发送时依旧挂到同一条一级评论下 + @ 这位回复者。 */
const replyRp = ref({});
function replyRpOf(p, cm) { return replyRp.value[repKey(p, cm)] || null; }
/* 回复一级评论：挂到它下面，不 @（视觉上已经挨着作者） */
function openReply(p, cm) {
  /* #28 未登录不能回复云端帖 */
  if (p.cloud && !signedIn.value) return showWallMsg("community.commentSignIn");
  const k = cmtKey(p);
  replyTo.value = { ...replyTo.value, [k]: cm.id };
  atName.value = { ...atName.value, [k]: "" };
  /* 同级只有一个框：开一级回复框就先收掉这条评论下的二级回复框 */
  clearReplyToRp(p, cm);
  if (p.cloud && canReadWall()) loadThread(p); /* 顺手刷新，边看边回 */
  focusSelector(repInputSel(p, cm));
}
/* 收掉某条一级评论下的「就地二级回复框」 */
function clearReplyToRp(p, cm) {
  const rk = repKey(p, cm);
  if (replyRp.value[rk]) {
    const next = { ...replyRp.value };
    delete next[rk];
    replyRp.value = next;
  }
}
/* 回复某条回复：输入框就地出现在「这条二级评论」下方（仍挂在同一个一级评论下，两级封顶），并 @ 这位回复者 */
function openReplyTo(p, cm, rp) {
  /* #28 未登录不能回复云端帖 */
  if (p.cloud && !signedIn.value) return showWallMsg("community.commentSignIn");
  const k = cmtKey(p);
  /* 一级回复框让位（否则一上一下两个框） */
  const nextTo = { ...replyTo.value };
  delete nextTo[k];
  replyTo.value = nextTo;
  replyRp.value = { ...replyRp.value, [repKey(p, cm)]: rp.id };
  atName.value = { ...atName.value, [k]: rp.name || "" };
  openRep.value = { ...openRep.value, [repOpenKey(p, cm)]: true };
  focusSelector(repInputSel(p, cm, rp));
}
function cancelReply(p) {
  const k = cmtKey(p);
  const nextTo = { ...replyTo.value };
  const nextAt = { ...atName.value };
  delete nextTo[k];
  delete nextAt[k];
  replyTo.value = nextTo;
  atName.value = nextAt;
  /* 二级「就地」回复框也一起收掉（key 形如 <帖key>:<一级评论id>） */
  const nextRp = { ...replyRp.value };
  for (const key of Object.keys(nextRp)) if (key.startsWith(k + ":")) delete nextRp[key];
  replyRp.value = nextRp;
}
/* 只在该评论正是当前回复目标时才收起回复框（删别的评论不影响正在写的回复） */
function cancelReplyIfTarget(p, cm) {
  if (replyTo.value[cmtKey(p)] === cm.id) cancelReply(p);
  /* 删掉的是「正在被回复的那条二级评论」→ 就地把框也收起来（cm 可能是它，也可能是它挂的一级评论） */
  clearReplyToRp(p, cm);
  if (Object.values(replyRp.value).includes(cm.id)) {
    const next = { ...replyRp.value };
    for (const key of Object.keys(next)) if (next[key] === cm.id) delete next[key];
    replyRp.value = next;
  }
}
/* 回复框占位文案：「回复 xxx…」（xxx 优先取 @ 的对象；二级就地框用被回复那条的名字） */
function repPlaceholder(p, cm, rp = null) {
  const n = atName.value[cmtKey(p)] || (rp && rp.name) || cm.name;
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
/* —— 点「回复」/点评论内容 → 输入框就地出现并聚焦（一次点击直接开打，不用再点输入框） —— */
async function focusSelector(sel) {
  await nextTick();
  const el = document.querySelector(sel);
  if (!el) return;
  /* 就地出框还要看得见：滚到视野中央（二级回复的框挂在整层线程末尾，不滚会被当成「没反应」） */
  if (el.scrollIntoView) el.scrollIntoView({ block: "center", behavior: "smooth" });
  if (el.focus) el.focus();
}
function cmtInputSel(p) {
  const k = CSS.escape(String(cmtKey(p)));
  return `#cmtbox-${k} input, #cmtbox-${k} textarea`;
}
function repInputSel(p, cm, rp = null) {
  /* 一级回复框 id = repbox-<帖>:<一级评论>；二级「就地」框 = repbox-<帖>:<一级评论>:<二级评论> */
  const id = repKey(p, cm) + (rp ? ":" + rp.id : "");
  const k = CSS.escape(String(id));
  return `#repbox-${k} input, #repbox-${k} textarea`;
}
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
    comments.value = { ...comments.value, [k]: filterBlocked(rows) };
    cloudCmtTotal.value = { ...cloudCmtTotal.value, [k]: rows.length };
  });
}
function toggleCmt(p) {
  const k = cmtKey(p);
  openCmt.value = { ...openCmt.value, [k]: !openCmt.value[k] };
  if (openCmt.value[k]) {
    loadThread(p);
    /* 手机端反馈：点「N 条评论」多半只是想看评论，不该自动弹键盘 → 只有桌面保持聚焦 */
    if (!isMobileNav.value) focusSelector(cmtInputSel(p));
  }
}

/* —— 评论输入框的出现时机（手机端反馈：点评论数不该直接出现输入框）——
 * 手机形态：展开评论先只读；点「写评论」按钮才出现输入框（各条「回复」不受影响）。
 * 桌面形态：保持原样（输入框常驻，展开即聚焦）。 */
const cmtCompose = ref({});
function cmtComposeOpen(p) {
  return !isMobileNav.value || !!cmtCompose.value[cmtKey(p)];
}
function openComposer(p) {
  cmtCompose.value = { ...cmtCompose.value, [cmtKey(p)]: true };
  focusSelector(cmtInputSel(p));
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
  /* #28 未登录不能评论云端帖（评论只存本机、别人看不到，会误导）；示例帖保持本地演示 */
  if (p.cloud && !signedIn.value) return;
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
/* 展示用：推荐 = 最近 7 天按天随机（默认）；其余 = 按时间范围筛 + 排序 */
const shown = computed(() => {
  const visible = visibleOnly(all.value);
  if (sortMode.value === "recommend") return recommendPosts(visible, { days: RECOMMEND_DAYS });
  return sortPosts(
    visible.filter((p) => inRange(p, rangeFor(sortMode.value, rangeMode.value))),
    sortMode.value
  );
});
/* 下架线提示用：厌恶 ÷ 浏览（#26 双档；只给数据层/管理侧用，用户界面不再显示比例） */
function disPct(p) { return ratioPct(p.views, (p.reacts && p.reacts.dislike) || 0); }

/* —— 分页展示：默认 10 条，滑到底部自动续 10 条（手机常用惯性；桌面同样生效） —— */
const PAGE_SIZE = 10;
const reveal = ref(PAGE_SIZE);
watch([sortMode, rangeMode], () => { reveal.value = PAGE_SIZE; });
const shownPage = computed(() => shown.value.slice(0, reveal.value));
const hasMore = computed(() => shown.value.length > reveal.value);
const sentEl = ref(null);
let feedIO = null;
onMounted(() => {
  if (typeof IntersectionObserver === "undefined") return;
  feedIO = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting && hasMore.value) reveal.value += PAGE_SIZE;
    }
  }, { rootMargin: "420px 0px" });
  if (sentEl.value) feedIO.observe(sentEl.value);
});
watch(hasMore, async () => {
  await nextTick();
  if (feedIO && sentEl.value) { feedIO.unobserve(sentEl.value); feedIO.observe(sentEl.value); }
});

/* 头像/昵称 → TA 的墙上的主页（/u/:id）；示例帖与本地帖没有云身份，不响应点击 */
const router = useRouter();
function canOpen(p) { return !!(p && p.cloud && p.userId); }
function goProfile(p) { if (canOpen(p)) router.push({ name: "waller", params: { id: p.userId } }); }

const when = (ts) => fmtWhen(ts, i18n.locale);   /* #25 帖子/评论时间显示到分钟 */

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
  <!-- 轮 18：原生下拉刷新（顶部下拉 → 松手重拉；此前函数未绑定，用户看到「完全没做」） -->
  <div @touchstart.passive="ts" @touchmove.passive="tm" @touchend.passive="te">
    <div class="wall-pull" :style="{ height: pullDist + 'px', opacity: pullDist / 62 }">↓</div>
    <!-- 头部 + 发布框（手机端收起：发布统一走底部 ＋ → 独立发布页，页顶不再占一屏） -->
    <section class="card">
      <span class="sec-label">{{ t("nav.community") }}</span>
      <h2 style="margin-bottom: 4px">{{ t("community.title") }}</h2>
      <p class="sub">{{ t("community.subtitle") }}</p>

      <div v-if="!isMobileNav" class="composer">
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
        <p v-if="signedIn" class="sub" style="margin: 4px 0 0">
          {{ t("community.postLeft", { n: postsLeft }) }}
        </p>
        <p v-if="loadingCloud" class="notice">{{ t("community.loading") }}</p>
        <p v-if="posted" class="streak-note" style="color: var(--good); font-weight: 700">
          {{ t("community.postedThanks") }}
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
        v-for="s in SORT_BTNS" :key="s.key"
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

    <!-- 动态流（默认 10 条，滑到底自动续 10 条） -->
    <article v-for="p in shownPage" :key="p.id" class="post-card card"
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
          round size="small" :focusable="false"
          :type="hasReacted(p, r.key) ? 'primary' : 'default'"
          :quaternary="!hasReacted(p, r.key)"
          @click="react(p, r.key)">
          {{ t(r.tk) }} · {{ p.reacts[r.key] }}
        </n-button>
      </div>

      <!-- 浏览数 + 厌恶：#26 双档下架线（浏览<100 超 3 个 / ≥100 超 0.5%）达线自动下架（假删除，数据仍在库里） -->
      <!-- p.stats：只有库跑过迁移、真拿到统计字段才显示，避免未迁移时出现假的「0 次浏览」 -->
      <div v-if="p.cloud && p.stats" class="post-foot">
        <span class="post-views">{{ t("community.views", { n: p.views || 0 }) }}</span>
        <button
          class="post-dis" :class="{ on: p.mine && p.mine.dislike }"
          :disabled="!signedIn"
          :title="signedIn ? t('community.dislikeHint') : t('community.dislikeSignIn')"
          @click="dislike(p)">
          &#128078; {{ p.reacts.dislike || 0 }}
        </button>
        <span class="post-ratio-hint">{{ t("community.dislikeRule") }}</span>
        <button
          v-if="canReportPost(p)" class="cmt-act post-report"
          @click="openReportPost(p)">{{ t("report.act") }}</button>
      </div>

      <div class="cmt-toggle" @click="toggleCmt(p)">
        <span class="cmt-ico">&#128172;</span> {{ t("comment.count", { n: countFor(p) }) }}
        <span class="cmt-caret" :class="{ open: isOpen(p) }">&#9662;</span>
      </div>
      <div :id="'cmtbox-' + cmtKey(p)" v-if="isOpen(p)" class="cmt-box">
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
          <p class="cmt-text cmt-text-open" :title="t('comment.reply')" @click="openReply(p, cm)">{{ cm.text }}</p>

          <div class="cmt-acts">
            <button class="cmt-act" @click="openReply(p, cm)">{{ t("comment.reply") }}</button>
            <button
              v-if="canReportCmt(cm)" class="cmt-act"
              @click="openReportCmt(cm)">{{ t("report.act") }}</button>
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
              <p class="cmt-text cmt-text-open" :title="t('comment.reply')" @click="openReplyTo(p, cm, rp)">{{ rp.text }}</p>
              <div class="cmt-acts">
                <button class="cmt-act" @click="openReplyTo(p, cm, rp)">
                  {{ t("comment.reply") }}
                </button>
                <button
                  v-if="canReportCmt(rp)" class="cmt-act"
                  @click="openReportCmt(rp)">{{ t("report.act") }}</button>
              </div>

              <!-- 二级评论的回复框就地在它下面出现（用户反馈：以前甩到整块评论底部，像点了没反应） -->
              <div
                :id="'repbox-' + repKey(p, cm) + ':' + rp.id"
                v-if="replyRpOf(p, cm) === rp.id && !(p.cloud && !signedIn)"
                class="cmt-input cmt-input-rep-in">
                <n-input
                  v-model:value="repDraft[repKey(p, cm)]"
                  round size="small"
                  :placeholder="repPlaceholder(p, cm, rp)"
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
          </div>

          <!-- 一级：就地回复框（云端帖未登录不给开，openReply 已拦截；这里再守一道） -->
          <div
            :id="'repbox-' + repKey(p, cm)"
            v-if="isReplyOpen(p, cm) && !(p.cloud && !signedIn)" class="cmt-input cmt-input-rep">
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

        <!-- 新评论（一级）：云端帖未登录 → 登录提示（#28：只存本机的评论别人看不到，不误导） -->
        <div v-if="p.cloud && !signedIn" class="cmt-input">
          <p class="cmt-empty">
            {{ t("community.commentSignIn") }}
            <router-link class="cmt-login" to="/profile">{{ t("common.signIn") }}</router-link>
          </p>
        </div>
        <!-- 手机端：默认只读；点「写评论」才出现输入框（桌面端输入框常驻，走 v-else） -->
        <div v-else-if="!cmtComposeOpen(p)" class="cmt-input">
          <button class="cmt-toggle" @click="openComposer(p)">
            <span class="cmt-ico">&#9998;</span> {{ t("comment.write") }}
          </button>
        </div>
        <div v-else class="cmt-input">
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
    <!-- 触底续载哨兵：滚近底部自动再放 10 条（IntersectionObserver，手机/桌面同款） -->
    <div ref="sentEl" class="feed-sentinel" aria-hidden="true"></div>
    <p v-if="shownPage.length && !hasMore" class="notice" style="text-align: center">
      {{ t("community.noMore") }}
    </p>

    <!-- 举报弹窗（帖子/评论共用一个实例） -->
    <ReportDialog v-model:show="reportShow" :target="reportTarget" />
  </div>
</template>

<style scoped>
/* 下拉刷新指示条（轮 18）：跟手拉伸，松手回弹 */
.wall-pull { display: flex; align-items: center; justify-content: center; overflow: hidden; color: var(--ink-soft); transition: height .15s ease; }
</style>