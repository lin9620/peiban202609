<!-- 帖子详情（轮 19 ②）：/post/:id 独立页 —— 完整帖子 + 与暖心墙同款的评论（两级展开）。
     「我的帖子」列表点进来，不再只是跳回暖心墙；数据链：wall.js cloudFetchPost（单帖）+
     cloudFetchComments / cloudInsertComment / cloudDeleteComment / cloudToggleReaction /
     cloudAddView / cloudToggleDislike，全部复用暖心墙现有云端 API（零新迁移、零新 i18n 键）。 -->
<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from "vue";
import { useRoute, useRouter } from "vue-router";
import { NAvatar, NButton, NInput } from "naive-ui";
import { t, i18n } from "../i18n.js";
import { cloud } from "../utils/supabase.js";
/* 轮 84：评论回应（mine 拉取 + 切换）—— import 大括号内不写注释（undef-check 解析器会粘连） */
import {
  cloudFetchPost, cloudFetchProfile, cloudFetchComments, cloudInsertComment,
  cloudDeleteComment, cloudToggleReaction, cloudAddView, cloudToggleDislike,
  cloudFetchMyCommentReactions, cloudToggleCommentReaction,
  cloudFavIds, cloudFavAdd, cloudFavRemove, favCacheInsert, favCacheRemove,
  cmtCacheKey, cmtCacheSet,
} from "../utils/wall.js";
/* 轮 84：评论排序 / 回应 / 拷贝文本 */
/* 轮 285：软删口径 —— 渲染/计数按「已删的父条留占位、它的回复照常显示」走（import 大括号内不写注释） */
import {
  normalizeText, MAX_LEN,
  SORT_MODES, sortComments, reactCount, toggleReact, hasReacted as cmtHasReacted,
  postCopyText, commentCopyText,
  renderTops, renderReplies, liveComments, markDeleted,
} from "../utils/comments.js";
import { fmtWhen } from "../utils/wallRules.js";
import { cacheKey, swr, cacheSet, cacheGet } from "../utils/cache.js";   /* 轮 158：帖子主体 SWR */
import { isApp, isMobileNav, tabbarSuppressed } from "../stores/uiStore.js";
/* 轮 279：左右滑看上一条/下一条 —— 方向判定复用 panes 的 swipeDir（已有单测），上下文来自 postNav */
import { swipeDir } from "../utils/panes.js";
import { navIdsFor, navTarget } from "../utils/postNav.js";
/* 轮 84：…菜单的「拷贝」（WebView 里 navigator.clipboard 缺失时 execCommand 兜底） */
import { copyText } from "../utils/clipboard.js";
/* 轮 33：举报弹窗 + 全站拉黑过滤（我拉黑的人，TA 的帖子/评论在我这里不显示） */
import ReportDialog from "../components/ReportDialog.vue";
import { filterBlocked, isBlocked } from "../utils/userBlocks.js";
import { avatarUrlFor } from "../utils/avatar.js";   /* 轮 238:萌宠头像池 */

const route = useRoute();
const router = useRouter();
const uid = computed(() => (route.params.id ? String(route.params.id) : ""));
const signedIn = computed(() => !!(cloud.ready && cloud.user));
const myId = computed(() => (cloud.user && cloud.user.id) || "");

const post = ref(null);
const loading = ref(true);
const failed = ref(false);
const gone = ref(false);          /* 操作后帖子被下架（厌恶达线）→ 明示，不再白屏 */
const myProfile = ref(null);
const wallName = computed(() => (myProfile.value && myProfile.value.nickname) || "Guest");

const when = (ts) => fmtWhen(ts, i18n.locale);

async function load() {
  if (!uid.value) { failed.value = true; loading.value = false; return; }
  loading.value = true;
  failed.value = false;
  gone.value = false;
  /* 轮 282：评论先行并行——路由 param 就是帖子 dbId，评论请求不必等帖子主体；
   * 缓存命中 0ms 上屏，网络与帖子主体并行回来覆盖（旧链路两个 RTT 串行 = 2~6s 空白)。
   * 必须先让出同步栈：watch(uid, load, {immediate:true}) 在 setup 中途就同步调 load()，
   * 而 comments/cmtLoading 等 const 声明在 watch 之后 —— 同步调 loadComments 会撞 TDZ
   * （线上报 Cannot access '$' before initialization）。一个微任务后 setup 已跑完，安全。 */
  await Promise.resolve();
  loadComments(uid.value);
  /* 轮 158：帖子主体 SWR——从墙/我的/主页点进来，本地先出上次的帖子立刻能读，
   * 后台拉新数据纠正（回应数/浏览数以 fresh 为准）。null = 查无此帖/网络挂 → 原failed口径 */
  await swr(
    cacheKey("wall:post", uid.value),
    {
      cached: (p) => { if (p) { post.value = p; loading.value = false; } },
      fresh: (p) => { if (p) { post.value = p; loading.value = false; } },
    },
    () => cloudFetchPost(uid.value),
  );
  if (!post.value) { failed.value = true; loading.value = false; return; }
  loading.value = false;
  /* 浏览计数（浏览 RPC 幂等：同一人同一天只 +1），随后本地 +1 即时反馈
   * 轮 172 修：轮 158 改 swr 后旧变量 p 已不存在（p.dbId → ReferenceError 炸整页），
   * 统一从 post.value 取——与 freshOk 同类的「改写后遗留旧引用」雷 */
  if (post.value.dbId) {
    try {
      await cloudAddView(post.value.dbId, myId.value);
      post.value = { ...post.value, views: (post.value.views || 0) + 1 };
    } catch (e) { /* 计数失败不影响阅读 */ }
  }
  if (myId.value) {
    cloudFetchProfile(myId.value).then((pf) => { if (pf) myProfile.value = pf; });
  }
  /* 轮 282：loadComments 已并行提前到 load() 开头（与帖子主体同时发），此处不再串行等待 */
}

/* 登录态就绪/变化 → 重拉（拿到 mine 回应标记与本人署名） */
/* 轮 128 · 收藏（#13）：详情页单帖收藏态；登录/换帖时刷新 */
const favOn = ref(false);
watch([myId, () => post.value && post.value.dbId], async ([uid, dbId]) => {
  favOn.value = false;
  if (!uid || dbId == null) return;
  const ids = await cloudFavIds([dbId]);
  favOn.value = ids.includes(dbId);
}, { immediate: true });
async function moreFav() {
  const p0 = post.value;
  if (!p0 || p0.dbId == null) return;
  if (!signedIn.value) { hint.value = t("fav.signIn"); return; }
  const want = !favOn.value;
  closeMore();   /* 轮 273：点了立刻收菜单（与暖心墙 moreFav 同款）——旧写法菜单一直开着，
   * 菜单文案读的是打开瞬间 moreTarget.faved 快照，点完文案不变，用户以为「没点上」= 不跟手 */
  favOn.value = want;
  /* 轮 254：收藏/取消同步写穿收藏页缓存（进 /favorites 0ms 可见/可除），失败一并回滚 */
  if (want) favCacheInsert(p0); else favCacheRemove(p0.dbId);
  hint.value = want ? t("fav.done") : t("fav.removed");   /* 轮 273：反馈先行，不等网络 */
  const ok = want ? await cloudFavAdd(p0.dbId) : await cloudFavRemove(p0.dbId);
  if (!ok) {
    favOn.value = !want;
    if (want) favCacheRemove(p0.dbId); else favCacheInsert(p0);
    hint.value = t("fav.fail");
    return;
  }
}
watch(myId, () => {
  if (!post.value) return;
  cloudFetchPost(uid.value).then((p) => { if (p) post.value = p; });
});

watch(uid, load, { immediate: true });

function goBack() {
  const back = typeof history !== "undefined" && history.state && history.state.back;
  if (back != null) router.back();
  else router.push("/community");
}

/* ───────── 回应（抱抱/暖暖/同感）与厌恶：与暖心墙同一套云端 API ───────── */
const REACTIONS = [
  { key: "hug", tk: "community.reactHug" },
  { key: "warm", tk: "community.reactWarm" },
  { key: "relate", tk: "community.reactRelate" },
];
const hasReacted = (k) => !!(post.value && post.value.mine && post.value.mine[k]);
const reactBusy = ref(false);
const hint = ref("");
async function refetch() {
  const p = await cloudFetchPost(uid.value);
  if (!p) { gone.value = true; post.value = null; return; }
  post.value = p;
  cacheSet(cacheKey("wall:post", uid.value), p);   /* 轮 158：操作后的最新态回写缓存 */
}
async function react(k) {
  const p = post.value;
  if (!p || reactBusy.value) return;
  if (!signedIn.value) { hint.value = t("community.reactSignIn"); return; }
  reactBusy.value = true;
  hint.value = "";
  try {
    await cloudToggleReaction(p.dbId, k);
    await refetch();
  } catch (e) { hint.value = t("community.reactFail"); }
  reactBusy.value = false;
}
async function dislike() {
  const p = post.value;
  if (!p || reactBusy.value) return;
  if (!signedIn.value) { hint.value = t("community.dislikeSignIn"); return; }
  reactBusy.value = true;
  hint.value = "";
  try {
    await cloudToggleDislike(p.dbId);
    await refetch();
  } catch (e) { hint.value = t("community.dislikeFail"); }
  reactBusy.value = false;
}

/* ───────── 评论（两级：一级评论 + 挂在一级下的回复，与暖心墙同款交互） ───────── */
const comments = ref([]);        /* 扁平视图评论（cloudFetchComments → rowsToComments 输出） */
const cmtLoading = ref(false);
const openCmt = ref(true);   /* 轮 87：进详情页评论默认展开（load() 已自动拉取评论） */
const cmtDraft = ref("");
const repDraft = ref({});        /* 每个一级评论线程一个草稿（与墙一致） */
const repOpen = ref({});         /* 某一级评论的回复列表展开 */
const repActive = ref("");       /* 就地回复框挂在哪个目标：一级 id 或 一级id:回复id */
const atName = ref("");
const cmtErr = ref("");

/* ═════════ 轮 84 · 评论排序 + 评论回应 + …菜单 ═════════ */

/* 排序只作用于一级评论："new" = 发布时间倒序；"hot" = 心最多（同数看碎心，再按时间倒序） */
const cmtSort = ref("default");
/* 轮 87：一级评论先展示 15 条，下滑接近底部续展 15 条（与暖心墙信息流同手感）；
 * 「查看更多评论」按钮也能续。二级回复仍默认前两条（轮 50 口径不变）。 */
const CMT_PAGE = 15;
const cmtReveal = ref(CMT_PAGE);
watch(cmtSort, () => { cmtReveal.value = CMT_PAGE; });

/* —— 评论回应（与暖心墙同口径：乐观翻转 → RPC 权威计数覆盖 → 失败回滚） —— */
const cmtReactBusy = ref({});
function cmtReacted(cm, kind) { return cmtHasReacted(cm, kind); }
/* 轮 123 · like-button 粒子迸发（transitions/like-button.md）：点亮成功后 700ms 窗口 */
const reactBursts = ref(new Set());
function reactBurst(cm, kind) { return reactBursts.value.has(cm.id + ":" + kind); }
function fireReactBurst(cm, kind) {
  const k = cm.id + ":" + kind;
  reactBursts.value = new Set([...reactBursts.value, k]);
  setTimeout(() => {
    const n = new Set(reactBursts.value);
    n.delete(k);
    reactBursts.value = n;
  }, 700);
}
async function cmtReact(cm, kind) {
  if (!cm || cm.dbId == null || cmtReactBusy.value[cm.id]) return;
  if (!signedIn.value) { hint.value = t("community.reactSignIn"); return; }
  cmtReactBusy.value = { ...cmtReactBusy.value, [cm.id]: true };
  const prevReacts = { ...(cm.reacts || {}) };
  const prevMine = [...(cm.myReacts || [])];
  const wasOn = prevMine.includes(kind);
  const opt = toggleReact(cm, kind, !wasOn);
  cm.reacts = opt.reacts;
  cm.myReacts = opt.myReacts;
  const res = await cloudToggleCommentReaction(cm.dbId, kind);
  if (res && res.ok) {
    /* 服务端权威计数覆盖乐观值；on 只描述本次点击的 kind（两种可同时点亮，与帖子回应同口径） */
    cm.reacts = { heart: res.hearts, broken: res.brokens };
    cm.myReacts = res.on ? [...new Set([...prevMine, kind])] : prevMine.filter((x) => x !== kind);
    if (res.on && kind === "heart") fireReactBurst(cm, kind);   /* 轮 125：粒子仅 ❤️；💔=抖动，无粒子 */
  } else {
    cm.reacts = prevReacts;
    cm.myReacts = prevMine;
    hint.value = t("community.reactFail");
  }
  const next = { ...cmtReactBusy.value };
  delete next[cm.id];
  cmtReactBusy.value = next;
}
/* 评论加载后补拉「我点过的」；失败静默（只少高亮，不影响计数展示）
 * 轮 275：cloudFetchComments 已内置后台补高亮（mineReady），这里保留给「发评论/
 * 删除等操作后」的即时刷新用 —— 操作后行数组已变，mineReady 的闭包是旧数组。 */
async function loadCmtMine(rows) {
  const ids = (Array.isArray(rows) ? rows : []).filter((r) => r.dbId != null).map((r) => r.dbId);
  if (!ids.length || !myId.value) return;
  const mine = await cloudFetchMyCommentReactions(ids, myId.value);
  if (!mine) return;
  const map = {};
  for (const r of mine) { (map[r.comment_id] = map[r.comment_id] || []).push(r.kind); }
  for (const cm of comments.value) { if (map[cm.dbId]) cm.myReacts = map[cm.dbId]; }
}

/* 轮 274：点帖子头部头像/名字进对方主页（/u/:id）——与暖心墙点头像/昵称同款（#15）。
 * cloudFetchPost 返回的视图帖带 userId；作者本人点自己也进得去（WallerView 有 isSelf 口径）。 */
function goUser() {
  const id = post.value && post.value.userId;
  if (id) router.push({ name: "waller", params: { id: String(id) } });
}

/* —— …菜单（帖子右上角 / 每条评论右上角：举报迁入 + 拷贝；同一时刻最多开一个） —— */
const moreKey = ref("");
const moreTarget = ref(null);   /* { type, reportable, dbId, label, copy } */
function togglePostMore() {
  moreKey.value = moreKey.value === "post" ? "" : "post";
  moreTarget.value = {
    type: "post", reportable: !!post.value && canReportPost(), dbId: post.value && post.value.dbId,
    faved: !!(post.value && post.value.dbId != null && favOn.value),
    label: post.value ? post.value.text || "" : "", copy: postCopyText(post.value),
  };
}
function toggleCmtMore(cm) {
  const k = "cmt:" + cm.id;
  moreKey.value = moreKey.value === k ? "" : k;
  moreTarget.value = { type: "comment", reportable: canReportCmt(cm), dbId: cm.dbId, label: cm.text || "", copy: commentCopyText(cm) };
}
function closeMore() { moreKey.value = ""; }
/* 轮 87：去掉全屏遮罩（.card 的 backdrop-filter 造出堆叠上下文，遮罩盖住菜单 →
 * 举报/拷贝点击全被吞掉）。改 document 级点击收起，动作不受影响。 */
watch(moreKey, (v) => {
  if (typeof document === "undefined") return;
  if (v) document.addEventListener("click", closeMore);
  else document.removeEventListener("click", closeMore);
});
function moreReport() {
  const t0 = moreTarget.value;
  closeMore();
  if (!t0 || !t0.reportable || t0.dbId == null) return;
  reportTarget.value = { type: t0.type, id: t0.dbId, label: t0.label };
  reportShow.value = true;
}
async function moreCopy() {
  const t0 = moreTarget.value;
  closeMore();
  const ok = await copyText(t0 ? t0.copy : "");
  hint.value = ok ? t("common.copied") : t("common.copyFail");
  setTimeout(() => { hint.value = ""; }, 2500);
}

/* 轮 108 续5：手机端回复统一走底部输入条（轮 98 的 reply-bar 退役）——与暖心墙同款：
 * 占位「回复 xxx…」、草稿按回复目标隔离存取（repDraft，与桌面内联框同 store）、
 * 点空白/再点同目标收起、tabbar 收起。桌面保持就地内联框（repActive）原路不变。 */
const detailBarReply = ref(null);   /* 底部条回复目标 { cm, rp }；null = 主评论模式 */
function closeDetailBar() {
  detailBar.value = false;
  detailBarReply.value = null;
}
const detailBarDraft = computed({
  get() {
    const r = detailBarReply.value;
    return r ? (repDraft.value[r.cm.id] || "") : (cmtDraft.value || "");
  },
  set(v) {
    const r = detailBarReply.value;
    if (r) repDraft.value = { ...repDraft.value, [r.cm.id]: v };
    else cmtDraft.value = v;
  },
});
const detailBarPh = computed(() => {
  const r = detailBarReply.value;
  return r ? repPlaceholder(r.cm, r.rp) : t("comment.placeholder");
});

const tops = computed(() => {
  /* 轮 285：renderTops 决定「哪些一级评论要画」——已删的只有下面还挂着活回复时才留
   * （留成「该评论已删除」占位），否则整条不渲染；软删行本身仍留在 comments 里。 */
  const list = renderTops(comments.value);
  /* 轮 90：默认 = 自然顺序（与暖心墙评论一致：旧→新，不滤不限——评论不是帖子，不用 7 天推荐池）；
     最新 = 时间倒序 */
  return cmtSort.value === "new" ? sortComments(list, "new") : list;
});
const shownTops = computed(() => tops.value.slice(0, cmtReveal.value));
/* 轮 87：下滑接近底部续展一级评论（与暖心墙信息流同手感；查看更多评论按钮同效） */
function onWallScroll() {
  if (cmtReveal.value >= tops.value.length) return;
  if (window.innerHeight + window.scrollY >= document.documentElement.offsetHeight - 700) {
    cmtReveal.value = Math.min(cmtReveal.value + CMT_PAGE, tops.value.length);
  }
}
onMounted(() => window.addEventListener("scroll", onWallScroll, { passive: true }));
/* 轮 126 · tabs-sliding：排序胶囊指示条（量 active 按钮 → 平移+定宽） */
const sortWrap = ref(null);
const sortBtns = {};
const sortPillStyle = ref({ transform: "translateX(0px)", width: "0px", opacity: 0 });
function setSortBtn(el, sm) { if (el) sortBtns[sm] = el; }
function syncSortPill() {
  const el = sortBtns[cmtSort.value];
  if (!el || !sortWrap.value) return;
  sortPillStyle.value = { transform: `translateX(${el.offsetLeft - 3}px)`, width: `${el.offsetWidth}px`, opacity: 1 };
}
watch(cmtSort, () => nextTick(syncSortPill));
onMounted(() => { syncSortPill(); window.addEventListener("resize", syncSortPill); });
onUnmounted(() => window.removeEventListener("resize", syncSortPill));
onUnmounted(() => window.removeEventListener("scroll", onWallScroll));
/* 轮 285：软删的二级回复直接不渲染（两级封顶，回复下面不会再有下级，不留墓碑） */
const repsOf = (cm) => renderReplies(comments.value, cm.id);
/* 轮 50：与暖心墙同口径——二级回复默认显示前两条，>2 条点「N 条回复」展开全部 */
const visibleReps = (cm) => (repOpen.value[cm.id] ? repsOf(cm) : repsOf(cm).slice(0, 2));
/* 轮 285：软删行不算「N 条评论」（与 renderTops/renderReplies 的渲染口径一致） */
const countN = computed(() => liveComments(comments.value).length);
/* 轮 254：乐观临时行（pending）还没落库，删除按钮先藏起来；轮 285：已删过的墓碑也不给再删一次 */
const canDel = (cm) => !!(cm && !cm.deleted && !cm.pending && cm.cloud && myId.value && cm.userId === myId.value);

function loadComments(idOverride = null) {
  /* 轮 282：并行化——路由 param（uid）就是帖子 dbId，评论不必等帖子主体拉完；
   * idOverride 供 load() 在 post 落位前就发出评论请求（两个 RTT 串行 → 并行）。 */
  const dbId = idOverride != null ? idOverride : (post.value && post.value.dbId);
  if (dbId == null) return;
  cmtLoading.value = true;
  /* 轮 282：SWR 缓存——缓存评论先 0ms 上屏（实测网络 RTT 800~2500ms 是主要慢源），
   * 网络回来覆盖；mineReady 高亮仍后台补。 */
  swr(
    cmtCacheKey(dbId),
    {
      cached: (rows) => {
        if (Array.isArray(rows)) {
          comments.value = filterBlocked(rows);
          cmtLoading.value = false;
        }
      },
      fresh: (rows) => {
        cmtLoading.value = false;
        if (!Array.isArray(rows)) return;
        comments.value = filterBlocked(rows);
        /* mineReady 闭包写的是原数组行对象：无拉黑时 filterBlocked 同引用（无感合并）；
         * 有拉黑时行对象仍是同一批引用，高亮写入行对象本身，触发一次响应式即可。 */
        if (rows.mineReady) rows.mineReady.then(() => { comments.value = comments.value.slice(); }).catch(() => {});
        focusTargetComment();   /* 轮 89：带 cid 进入 → 展开目标线程并滚动定位 */
      },
      onError: () => { cmtLoading.value = false; },
    },
    /* 复位塞进 fetcher：cloudFetchComments 失败返回 null（不抛异常），swr 对 null
     * 既不调 fresh 也不调 onError —— 若只在 hooks 里复位，失败会卡 cmtLoading=true。 */
    () => cloudFetchComments(dbId).then((r) => { cmtLoading.value = false; return r; }),
  );
}

/* 轮 89：墙内「查看全部回复」带 cid 跳转进来 → 展开目标线程 + 滚动定位。
 * 目标一级评论可能在推荐池（7 天）之外 → 先切「最新」保证可见，并把 reveal 撑到它的位置。 */
const focusCid = computed(() => (route.query.cid ? String(route.query.cid) : ""));
async function focusTargetComment() {
  if (!focusCid.value) return;
  cmtSort.value = "new";
  const key = "c" + focusCid.value;
  repOpen.value = { ...repOpen.value, [key]: true };
  await nextTick();
  const idx = tops.value.findIndex((c) => c.id === key);
  if (idx >= 0 && idx >= cmtReveal.value) cmtReveal.value = idx + 1;
  await nextTick();
  if (typeof document !== "undefined") {
    const el = document.getElementById("cmt-" + focusCid.value);
    if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}
function toggleCmt() {
  openCmt.value = !openCmt.value;
  /* 轮 282：load() 已并行首发过一次（cmtLoading 门控），在途时不重复发 */
  if (openCmt.value && !comments.value.length && !cmtLoading.value) loadComments();
}
function toggleReplies(cm) {
  repOpen.value = { ...repOpen.value, [cm.id]: !repOpen.value[cm.id] };
}
function startReply(cm, rp = null, e = null) {
  if (!signedIn.value) return;
  if (cm && cm.deleted) return;   /* 轮 285：已删除的评论不留回复入口（它下面的既有回复仍可看） */
  /* 轮 108 续5：手机端 = 底部输入条回复模式（再点同目标 = 收起）；桌面 = 就地内联框原路。
   * 回复「回复」仍是两级封顶：挂同一级下，@那位回复者（与墙规则一致） */
  if (isMobileNav.value) {
    if (e) e.stopPropagation();   /* 不让同一击冒泡去触发「点空白收起」 */
    const r0 = detailBarReply.value;
    if (detailBar.value && r0 && r0.cm.id === cm.id
      && (r0.rp ? r0.rp.id : null) === (rp ? rp.id : null)) {
      closeDetailBar();
      return;
    }
    detailBarReply.value = { cm, rp: rp || null };
    atName.value = rp ? rp.name : "";
    if (rp) repOpen.value = { ...repOpen.value, [cm.id]: true };
    detailBar.value = true;
    nextTick().then(() => { try { detailBarInput.value?.focus(); } catch (e2) { /* 无焦点环境忽略 */ } });
    return;
  }
  const key = rp ? cm.id + ":" + rp.id : cm.id;
  if (repActive.value === key) { repActive.value = ""; atName.value = ""; return; }
  atName.value = rp ? rp.name : "";
  repActive.value = key;
}
function cancelReply() {
  repActive.value = "";
  atName.value = "";
}
const repPlaceholder = (cm, rp = null) =>
  t("comment.replyPh", { n: rp ? rp.name : cm.name });
const leftOf = (s) => Math.max(0, MAX_LEN - normalizeText(s).length);
const cmtLeft = computed(() => leftOf(cmtDraft.value));
const repLeft = computed(() => {
  const k = repActive.value.split(":")[0];
  return leftOf(repDraft.value[k] || "");
});

/* ═══ 轮 108 续4 · 手机端主评论两段式（与暖心墙同款：占位条 → 底部输入条）═══
 * 占位条在 cmt-box 首部（帖子下、所有评论上）；桌面主评论框自轮 111 起在卡内
 * 「浏览次数 ↔ N 条评论」之间（轮 93 的 cmt-bar-fixed 悬浮底栏已退役）。
 * 未登录点占位条 → 去登录页（详情页评论区常开，没有墙内那种「展开看登录提示」的路径）。 */
const detailBar = ref(false);
const detailBarInput = ref(null);
const detailBarEl = ref(null);
/* 轮 184：与暖心墙 mainBarDocClose 同款真因——「面板开着就不关条」不能靠现查 DOM
 *（面板由 Vue 微任务渲染，click 冒泡那一刻还查不到 → 误判成点外 → 收起评论条）。
 * 这里原本连这道保险都没有，点表情必定把条关掉；现统一走静态标记 isEmojiHit()。 */
function detailBarDocClose(e) {
  const tgt = e.target;
  if (detailBarEl.value && detailBarEl.value.contains(tgt)) return;   /* 条内（输入/发送）不关 */
  if (tgt && tgt.closest && tgt.closest(".cmt-entry")) return;        /* 占位条点击归 toggle 管 */
  detailBar.value = false;
}
watch(detailBar, (v) => {
  tabbarSuppressed.value = v;   /* 条开着 = tabbar 收起（贴键盘，图2），与暖心墙同口径 */
  if (typeof document === "undefined") return;
  if (v) document.addEventListener("click", detailBarDocClose);
  else document.removeEventListener("click", detailBarDocClose);
});
onUnmounted(() => {
  tabbarSuppressed.value = false;
  if (typeof document !== "undefined") document.removeEventListener("click", detailBarDocClose);
});
async function toggleDetailBar() {
  if (!signedIn.value) { router.push("/profile"); return; }
  if (repActive.value) cancelReply();   /* 桌面残留回复态让位 */
  if (detailBar.value && !detailBarReply.value) { closeDetailBar(); return; }  /* 再点占位条=收起（主评论模式） */
  detailBarReply.value = null;          /* 回复模式点占位条 = 切回主评论 */
  detailBar.value = true;
  await nextTick();
  try { detailBarInput.value?.focus(); } catch (e) { /* 无焦点环境忽略 */ }
}
async function sendDetailBar() {
  const r = detailBarReply.value;
  await (r ? sendCmt(r.cm, r.rp) : sendCmt());
  /* 草稿被清空 = 发送成功 → 收起；失败草稿留着（sendCmt 语义），cmtErr 已在评论区可见 */
  const left = r ? repDraft.value[r.cm.id] : cmtDraft.value;
  if (!String(left || "").trim()) closeDetailBar();
}

async function sendCmt(cm = null, rp = null) {
  const text = cm ? (repDraft.value[cm.id] || "") : cmtDraft.value;
  if (!normalizeText(text) || !post.value) return;
  if (cm && cm.deleted) return;   /* 轮 285：不给已删除的评论继续挂新回复 */
  if (!signedIn.value) return;   /* #28：云端帖未登录不评论（只存本机会误导） */
  cmtErr.value = "";
  const at = cm ? (rp ? rp.name : atName.value) : "";
  const parentId = cm ? cm.dbId : null;
  /* 轮 254 · 乐观上屏（与暖心墙同款）：草稿立即清空、临时行立即可见；
     成功换正式行，失败摘行 + 还草稿 + cmtErr。 */
  const tmp = {
    id: "t" + Date.now(), dbId: null, name: wallName.value, text,
    ts: Date.now(), cloud: true, userId: myId.value,
    parentId: cm ? cm.id : null, replyTo: at,
    reacts: { heart: 0, broken: 0 }, myReacts: [], pending: true,
  };
  comments.value = [...comments.value, tmp];
  if (cm) {
    repDraft.value = { ...repDraft.value, [cm.id]: "" };
    repOpen.value = { ...repOpen.value, [cm.id]: true };
  } else {
    cmtDraft.value = "";
  }
  const created = await cloudInsertComment(post.value.dbId, text, wallName.value, {
    parentId,
    replyToName: at,
  });
  if (!created) {
    comments.value = comments.value.filter((c) => c.id !== tmp.id);
    if (cm) {
      repDraft.value = { ...repDraft.value, [cm.id]: text };
      if (!rp) atName.value = at;   /* 还 @ 目标（经 rp 直接点名的本就没动） */
    }
    else cmtDraft.value = text;
    cmtErr.value = t("comment.fail");
    return;
  }
  comments.value = comments.value.map((c) => (c.id === tmp.id ? created : c));
  /* 轮 282：发成功回写评论缓存（滤掉可能残留的 pending 临时行），下次打开不闪旧数据 */
  cmtCacheSet(post.value.dbId, comments.value.filter((c) => !c.pending));
  if (cm) {
    repActive.value = "";
    atName.value = "";
  }
}
/* 轮 111：桌面卡内主评论输入框（在「浏览次数 ↔ N 条评论」之间）的发送——
 * 沿用 sendCmt() 全套逻辑（失败提示 cmtErr / 草稿保留由 sendCmt 决定）；空草稿不发
 * （免得误触发布键给评论区顶出错误提示）。手机端不渲染该框，走底部的 sendDetailBar。 */
async function sendTopCmt() {
  if (!String(cmtDraft.value || "").trim()) return;
  await sendCmt();
}

async function delCmt(cm) {
  if (!canDel(cm)) return;
  if (cm.pending) return;   /* 轮 254：乐观临时行还没落库，不给删 */
  /* 轮 285 · 乐观软删：行不摘，只标 deleted —— 这样它下面的二级回复原位不动，
   * 云端失败再整体回滚。原实现按「id 自身 + parentId 指向它」两批一起 filter 掉行，
   * 连带把回复摘光，正是用户反馈的「b 删一级评论，c/d/e 的回复全丢」。 */
  const before = comments.value;
  comments.value = markDeleted(comments.value, cm.id);
  if (cm.cloud) {
    const done = await cloudDeleteComment(cm.dbId);
    if (!done) { comments.value = before; return; }
  }
  /* 轮 282：删成功回写评论缓存，下次打开不闪回已删评论（缓存里带 deleted 标记，口径一致） */
  cmtCacheSet(post.value && post.value.dbId, comments.value.filter((c) => !c.pending));
  if (repActive.value.split(":")[0] === cm.id) cancelReply();
  if (moreKey.value === "cmt:" + cm.id) closeMore();   /* 墓碑上不该再挂着 … 菜单 */
}

/* ═════════ 举报（轮 33）+ 拉黑隐藏 ═════════ */
const reportShow = ref(false);
const reportTarget = ref(null);
function openReportPost() {
  const p = post.value;
  if (!p || p.dbId == null) return;
  reportTarget.value = { type: "post", id: p.dbId, label: p.text || "" };
  reportShow.value = true;
}
function openReportCmt(cm) {
  /* 云端评论的数字主键在 dbId（id 是带 c 前缀的本地渲染键） */
  if (!cm || !cm.cloud || cm.dbId == null) return;
  reportTarget.value = { type: "comment", id: cm.dbId, label: cm.text || "" };
  reportShow.value = true;
}
/* 自己的内容不显示举报（不能举报自己）；游客也显示入口——点了弹窗里会提示先登录。 */
const canReportPost = () => !!(post.value && post.value.dbId != null
  && post.value.userId && post.value.userId !== myId.value);
const canReportCmt = (cm) => !!(cm && cm.cloud && cm.dbId != null
  && cm.userId && cm.userId !== myId.value);
/* 帖子作者被我拉黑：正文以「已隐藏」呈现（数据还在，取消拉黑即恢复） */
const authorBlocked = computed(() => !!(post.value && isBlocked(post.value.userId)));

/* ═════════ 轮 279 · 左右滑看上一条 / 下一条 ═════════
 * 上下文 = 跳转前由入口存下的列表快照（utils/postNav.js）：①暖心墙 ②我的帖子 ③他人帖子。
 * 启用判据：当前 id 在那张表里，且没有更优先的浮层（⋯菜单 / 举报弹窗 / 已下架）挡着——
 * 从收藏、通知这类没有列表的入口进来时，不在表里就完全不响应。
 *
 * 两端差异（用户要求「app 端跟网页端不一样的实现方式」的全部落点）：
 *   App 端 —— 只挂触摸：WebView 里没有真实鼠标与物理键盘，挂了也收不到事件；
 *   网页端 —— 触摸之外再挂桌面鼠标拖拽与 ←/→ 键。
 * 方向判定、跟手位移、边界阻尼、切换时序两端是同一套代码。
 *
 * 手法（用户拍板）：跟手 + 过半才切 + 边界回弹。 */
const navIds = ref([]);
const dragX = ref(0);
const dragPhase = ref("");                       /* ""=静止 | drag=跟手 | out=滑出动画 */
const swipeStyle = computed(() => ({ transform: `translateX(${dragX.value}px)` }));

const SWAP_MS = 220;                             /* 滑出时长，与 .pd-swipe.out 的 transition 对齐 */
const EDGE_DAMP = 0.32;                          /* 到头只跟 32%：手感是「顶住了」而不是「滑穿了」 */
const TURN_RATIO = 0.5;                          /* 过半才切 */
const AXIS_LOCK = 10;                            /* 位移满 10px 才定轴，免得手抖误判 */
let swapTimer = 0, edgeTimer = 0, preTimer = 0;

const viewW = () => Math.max((typeof window !== "undefined" && window.innerWidth) || 0, 320);

/* uid 变（含切换后的下一条）→ 重算上下文 + 给新帖预热相邻两条（滑过去时秒开，不用等网络） */
watch(uid, () => {
  navIds.value = navIdsFor(uid.value);
  clearTimeout(preTimer);
  preTimer = setTimeout(prefetchAround, 700);
}, { immediate: true });

const canSwipe = computed(() => navIds.value.length > 1
  && dragPhase.value === ""
  && !reportShow.value && !moreKey.value && !gone.value);

function prefetch(id) {
  if (!id) return;
  try {
    const k = cacheKey("wall:post", id);
    if (cacheGet(k)) return;                     /* 已经缓存过就不重复拉 */
    cloudFetchPost(id).then((p) => { if (p) cacheSet(k, p); }).catch(() => {});
  } catch (e) { /* 预取失败不影响正片 */ }
}
function prefetchAround() {
  const i = navIds.value.indexOf(uid.value);
  if (i < 0) return;
  prefetch(navIds.value[i - 1]);
  prefetch(navIds.value[i + 1]);
}

/* 到头了再拖：只跟 EDGE_DAMP，所以位移永远够不到 TURN_RATIO → 一定回弹，与 tryStep 双保险 */
function dampX(x) {
  const i = navIds.value.indexOf(uid.value);
  const blocked = (x > 0 && i <= 0) || (x < 0 && i >= navIds.value.length - 1);
  return blocked ? x * EDGE_DAMP : x;
}

function edgeHint(dir) {
  const msg = dir > 0 ? t("nav.nextEnd") : t("nav.prevEnd");
  hint.value = msg;
  clearTimeout(edgeTimer);
  edgeTimer = setTimeout(() => { if (hint.value === msg) hint.value = ""; }, 2400);
}

/* dir = 1 左滑（下一条）/ -1 右滑（上一条） */
function tryStep(dir) {
  const next = navTarget(uid.value, dir);
  if (!next) { edgeHint(dir); return false; }
  dragPhase.value = "out";
  dragX.value = dir > 0 ? -viewW() : viewW();    /* 朝滑出去的方向推满屏 */
  clearTimeout(swapTimer);
  swapTimer = setTimeout(() => swapTo(next), SWAP_MS);
  return true;
}

async function swapTo(next) {
  /* 必须先等路由换完再把位移归零：否则归零那一帧旧内容会「闪回」中央（自测抓到过）。
   * await 之后在 nextTick 里归零 → 新内容渲染在屏幕外一帧随即落位，那一帧用户看不见。 */
  try { await router.replace({ name: "postDetail", params: { id: next } }); }
  catch (e) { /* 路由被更早的操作打断：无所谓，位移照样复位 */ }
  nextTick(() => {
    dragX.value = 0;
    dragPhase.value = "";                        /* 同时摘掉 .out → 无过渡，瞬间落位 */
    if (typeof window !== "undefined") window.scrollTo(0, 0);
  });
}

/* —— 手势：window 级监听（同 StoryShell 口径），可交互元素让路 —— */
const GUARD = 'input, textarea, select, button, a, [contenteditable="true"], .more-pop, .van-popup, .n-dialog';
let sx = 0, sy = 0, axis = "", tracking = false;

function gStart(x, y, target) {
  tracking = false; axis = "";
  if (!canSwipe.value) return;
  if (target && target.closest && target.closest(GUARD)) return;  /* 手按在按钮/输入框上：不抢 */
  sx = x; sy = y; tracking = true;
}
function gMove(x, y) {
  if (!tracking) return;
  const dx = x - sx, dy = y - sy;
  if (!axis) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) < AXIS_LOCK) return;
    if (Math.abs(dx) <= Math.abs(dy)) { tracking = false; return; }  /* 纵向：让位给页面滚动 */
    axis = "x";
    try { if (typeof window !== "undefined" && window.getSelection) window.getSelection().removeAllRanges(); }
    catch (e) { /* 拖动前已选中的文字：清不掉也不影响功能 */ }
  }
  dragPhase.value = "drag";
  dragX.value = dampX(dx);
}
function gEnd(x) {
  if (!tracking) return;
  const onX = axis === "x";
  tracking = false; axis = "";
  if (!onX) { dragPhase.value = ""; dragX.value = 0; return; }
  const dir = swipeDir(x - sx, 0);               /* 1=左滑 → 下一条；0 = 没到 48px 阈值 */
  if (!dir) { dragPhase.value = ""; dragX.value = 0; return; }
  const dist = dragX.value;                      /* 实际位移，已含边界阻尼 */
  const has = navTarget(uid.value, dir);
  if (has && Math.abs(dist) >= viewW() * TURN_RATIO) { tryStep(dir); return; }
  dragPhase.value = ""; dragX.value = 0;         /* 没过半 / 到头 → 回弹 */
  if (!has && Math.abs(dist) >= 24) edgeHint(dir);
}

const onTouchStart = (e) => { const a = e.touches[0]; if (a) gStart(a.clientX, a.clientY, e.target); };
const onTouchMove = (e) => { const a = e.touches[0]; if (a) gMove(a.clientX, a.clientY); };
const onTouchEnd = (e) => { const a = e.changedTouches[0]; if (a) gEnd(a.clientX); };
const onMouseDown = (e) => { if (e.button) return; gStart(e.clientX, e.clientY, e.target); };
const onMouseMove = (e) => { if (tracking) gMove(e.clientX, e.clientY); };
const onMouseUp = (e) => { if (tracking) gEnd(e.clientX); };

function onKey(e) {
  if (!canSwipe.value) return;
  const el = e.target;
  if (el && el.closest && el.closest('input, textarea, [contenteditable="true"]')) return;  /* 光标移动归输入框 */
  const dir = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
  if (!dir) return;
  e.preventDefault();                            /* 免得方向键在翻页同时还滚页面 */
  tryStep(dir);
}

onMounted(() => {
  window.addEventListener("touchstart", onTouchStart, { passive: true });
  window.addEventListener("touchmove", onTouchMove, { passive: true });
  window.addEventListener("touchend", onTouchEnd, { passive: true });
  if (!isApp) {                                  /* 网页端才有鼠标与物理键盘 */
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("keydown", onKey);
  }
});
onUnmounted(() => {
  window.removeEventListener("touchstart", onTouchStart);
  window.removeEventListener("touchmove", onTouchMove);
  window.removeEventListener("touchend", onTouchEnd);
  window.removeEventListener("mousedown", onMouseDown);
  window.removeEventListener("mousemove", onMouseMove);
  window.removeEventListener("mouseup", onMouseUp);
  window.removeEventListener("keydown", onKey);
  clearTimeout(swapTimer); clearTimeout(edgeTimer); clearTimeout(preTimer);
});
</script>

<template>
  <div class="pd">
    <!-- 轮 279：左右滑的位移只作用在这一层。手机端底部输入条 cmt-main-bar 与举报弹窗
         刻意留在本层**之外** —— position:fixed 一旦进了带 transform 的祖先就会被劫持包含块
         （style.css 2392 行记着同一坑，轮 238/175/151 各踩过一次）。 -->
    <div class="pd-swipe" :class="{ drag: dragPhase === 'drag', out: dragPhase === 'out' }" :style="swipeStyle">
    <div class="pd-head">
      <button class="pd-back" @click="goBack">&#8249; {{ t("nav.community") }}</button>
    </div>

    <p v-if="loading" class="sub">{{ t("community.loading") }}</p>

    <p v-else-if="failed && !gone" class="card sub" style="text-align:center">
      {{ t("common.oops") }}<br />
      <button class="pd-retry" @click="load">{{ t("common.reload") }}</button>
    </p>

    <template v-else-if="post">
      <p v-if="gone" class="notice">{{ t("community.removed") }}</p>
      <p v-else-if="authorBlocked" class="notice">{{ t("wall.blockedPost") }}</p>

      <article v-if="!authorBlocked" class="post-card card">
        <div class="post-head">
          <n-avatar round :size="42" class="post-avatar clickable" :title="t('dm.viewHome')" @click="goUser" :src="avatarUrlFor(post.userId) || undefined"><template v-if="!avatarUrlFor(post.userId)" #default>🙂</template><template v-else #fallback>🙂</template></n-avatar>
          <div class="post-meta">
            <div class="post-name clickable" :title="t('dm.viewHome')" @click="goUser">{{ post.name }}</div>
            <div class="post-time">{{ when(post.ts) }}</div>
          </div>
          <!-- 轮 84：帖子右上角 … 菜单（举报迁入 + 拷贝正文）；post-foot 里原举报按钮移除 -->
          <button class="more-btn" :title="t('comment.more')" :aria-label="t('comment.more')"
            @click.stop="togglePostMore">⋯</button>
          <div v-if="moreKey === 'post'" class="more-pop card" @click.stop>
            <button v-if="canReportPost()" class="more-item" @click="moreReport">{{ t("report.act") }}</button>
            <button v-if="moreTarget && moreTarget.dbId != null" class="more-item" @click="moreFav">
              {{ moreTarget.faved ? t("fav.remove") : t("fav.add") }}
            </button>
            <button class="more-item" @click="moreCopy">{{ t("common.copy") }}</button>
          </div>
        </div>

        <p class="post-text">{{ post.text }}</p>
        <img v-if="post.img" :src="post.img" class="pic" alt="" />

        <div class="react-row">
          <n-button v-for="r in REACTIONS" :key="r.key" round size="small" :focusable="false"
            :type="hasReacted(r.key) ? 'primary' : 'default'" :quaternary="!hasReacted(r.key)"
            :title="signedIn ? '' : t('community.reactSignIn')"
            @click="react(r.key)">
            {{ t(r.tk) }} · {{ post.reacts[r.key] }}
          </n-button>
        </div>

        <div v-if="post.stats" class="post-foot">
          <span class="post-views">{{ t("community.views", { n: post.views || 0 }) }}</span>
          <button class="post-dis" :class="{ on: post.mine && post.mine.dislike }"
            :disabled="!signedIn"
            :title="signedIn ? t('community.dislikeHint') : t('community.dislikeSignIn')"
            @click="dislike">
            &#128078; {{ post.reacts.dislike || 0 }}
          </button>
            <!-- 轮 84：举报入口迁入帖子右上角 … 菜单，post-foot 只留浏览数与厌恶 -->
          </div>

        <!-- 轮 111：桌面主评论输入框上移到「浏览次数 ↔ N 条评论」之间（与暖心墙轮 109 同款位置/形态）。
             App 端不渲染——手机端走轮 108 续4 的卡内占位条 + 底部输入条；未登录仍是登录入口（原底栏同款 bar-signin）。 -->
        <div v-if="!isMobileNav" id="detail-cmtmain" class="cmt-input cmt-input-top">
          <div v-if="signedIn" class="cmt-input-row">
            <van-field v-model="cmtDraft" type="textarea" rows="1" autosize
              :placeholder="t('comment.placeholder')" :maxlength="MAX_LEN" />
            <n-button type="primary" size="small" round class="cmt-send" @click="sendTopCmt()">{{ t("community.post") }}</n-button>
          </div>
          <router-link v-else class="bar-signin" to="/profile">{{ t("comment.barSignIn") }}</router-link>
        </div>

        <div class="cmt-bar">
          <div class="cmt-toggle" @click="toggleCmt">
            <span class="cmt-ico">&#128172;</span> {{ t("comment.count", { n: countN }) }}
            <span class="cmt-caret" :class="{ open: openCmt }">&#9662;</span>
          </div>
          <!-- 轮 87：评论排序「默认 / 最新」——默认 = 推荐模式（与暖心墙帖子排序同源） -->
          <div class="cmt-sort t-tabs" ref="sortWrap">
            <span class="sort-pill" :style="sortPillStyle" aria-hidden="true"></span>
            <button v-for="sm in SORT_MODES" :key="sm" class="sort-btn cmt-sort-btn"
              :class="{ on: cmtSort === sm }" :ref="(el) => setSortBtn(el, sm)" @click="cmtSort = sm">
              {{ t(sm === "default" ? "comment.sortDefault" : "comment.sortNew") }}
            </button>
          </div>
        </div>

        <div v-if="openCmt" class="cmt-box">
          <!-- 轮 108 续4：手机端主评论占位条（帖子下、所有评论上，与暖心墙同款；点击弹底部输入条；
               桌面不渲染——桌面主评论框自轮 111 起在卡内「浏览次数 ↔ N 条评论」之间） -->
          <div v-if="isMobileNav" class="cmt-entry" @click="toggleDetailBar">
            {{ t("comment.placeholder") }}
          </div>
          <!-- 轮 111：桌面主评论框已搬到卡内「浏览次数 ↔ N 条评论」之间（见帖子卡 post-foot 之后），
               评论区里从此没有任何输入位（轮 93 的 cmt-bar-fixed 悬浮底栏同步退役） -->

          <p v-if="cmtErr" class="cmt-empty" style="color: var(--low); font-weight: 700">{{ cmtErr }}</p>
          <p v-if="cmtLoading && !comments.length" class="cmt-empty">{{ t("community.loading") }}</p>

          <div v-for="cm in shownTops" :key="cm.id" class="cmt-item"
            :id="cm.dbId != null ? 'cmt-' + cm.dbId : undefined"
            :class="{ 'cmt-focus': focusCid && String(cm.dbId) === focusCid }">
            <!-- 轮 285：软删占位 —— 作者删掉一级评论后，昵称/正文/操作行整块换成一句「已删除」，
                 它下面的二级回复（下方 cmt-reps）原样保留：
                 正是「把 b 的评论替换成已被删除，但是下面二级评论还在」。
                 判据在 renderTops：已删的一级评论只有还挂着活回复才进列表（没回复的整条不画）。 -->
            <template v-if="!cm.deleted">
            <div class="cmt-head">
              <b>{{ cm.name }}</b>
              <button v-if="canDel(cm)" class="cmt-del" :title="t('common.delete')" @click="delCmt(cm)">×</button>
              <!-- 轮 84：评论右上角 … 菜单（举报迁入 + 拷贝） -->
              <button class="cmt-more" :title="t('comment.more')" :aria-label="t('comment.more')"
                @click.stop="toggleCmtMore(cm)">⋯</button>
              <div v-if="moreKey === 'cmt:' + cm.id" class="more-pop card" @click.stop>
                <button v-if="canReportCmt(cm)" class="more-item" @click="moreReport">{{ t("report.act") }}</button>
                <button class="more-item" @click="moreCopy">{{ t("common.copy") }}</button>
              </div>
            </div>
            <p class="cmt-text" :title="signedIn ? t('comment.reply') : ''" @click="startReply(cm, null, $event)">{{ cm.text }}</p>
            <div class="cmt-acts">
              <!-- 轮 84：时间从评论头移到「回复」左侧 -->
              <span class="cmt-time">{{ when(cm.ts) }}</span>
              <button v-if="signedIn" class="cmt-act" @click="startReply(cm, null, $event)">{{ t("comment.reply") }}</button>
              <!-- 轮 87：回应图标改空心灰内联 SVG（emoji 太艳丽；点亮 = 深一档灰） -->
              <button v-if="cm.dbId != null" class="cmt-react t-like" data-kind="heart" :class="{ on: cmtReacted(cm, 'heart'), 'is-bursting': reactBurst(cm, 'heart') }" :data-liked="cmtReacted(cm, 'heart')"
                :disabled="!!cmtReactBusy[cm.id]" :title="t('comment.likeT')" :aria-label="t('comment.likeT')"
                @click="cmtReact(cm, 'heart')"><span class="t-like-icon"><svg class="rc-ico t-like-heart" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21.35 10.55 20.03C5.4 15.36 2 12.27 2 8.5 2 5.41 4.42 3 7.5 3c1.74 0 3.59.94 4.5 2.35C12.91 3.94 14.76 3 16.5 3 19.58 3 22 5.41 22 8.5c0 3.77-3.4 6.86-8.55 11.53L12 21.35z"/></svg></span><span class="t-like-particles" aria-hidden="true"><i v-for="n in 8" :key="n"></i></span><i>{{ reactCount(cm, "heart") }}</i></button>
              <button v-if="cm.dbId != null" class="cmt-react t-like" data-kind="broken" :class="{ on: cmtReacted(cm, 'broken'), 'is-bursting': reactBurst(cm, 'broken') }" :data-liked="cmtReacted(cm, 'broken')"
                :disabled="!!cmtReactBusy[cm.id]" :title="t('comment.brokenT')" :aria-label="t('comment.brokenT')"
                @click="cmtReact(cm, 'broken')"><span class="t-like-icon"><svg class="rc-ico t-like-heart" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21.35 10.55 20.03C5.4 15.36 2 12.27 2 8.5 2 5.41 4.42 3 7.5 3c1.74 0 3.59.94 4.5 2.35C12.91 3.94 14.76 3 16.5 3 19.58 3 22 5.41 22 8.5c0 3.77-3.4 6.86-8.55 11.53L12 21.35z"/><path d="M12 6.8 10.4 9.4l2.4 1.5-1.5 2.4 1.1 1.8"/></svg></span><span class="t-like-particles" aria-hidden="true"><i v-for="n in 8" :key="n"></i></span><i>{{ reactCount(cm, "broken") }}</i></button>
              <!-- 轮 88：「N 条回复」按钮移到回复列表底部（见下方 replies-toggle），操作行只留时间/回复/回应 -->
            </div>
            </template>
            <p v-else class="cmt-text cmt-gone"
              style="color: var(--low); font-style: italic; cursor: default">{{ t("comment.deleted") }}</p>

            <!-- 轮 112：一级评论的回复框紧跟这条一级评论——正文/操作行之下、二级列表之上
                 （用户原话「帖子详细页面的一级评论输入框：把一级评论回复框点击后出现在一级评论下面，
                 二级评论上面，你现在是一级评论最下面。二级评论输入框不改。app端不改」）。
                 二级就地框（本评论内 cmt-input-in 的上一个分支）与手机端底部输入条都不受影响。 -->
            <div v-if="!cm.deleted && !isMobileNav && repActive === cm.id" class="cmt-input cmt-input-in">
              <div class="cmt-input-row">
                <van-field v-model="repDraft[cm.id]" type="textarea" rows="1" autosize
                  :placeholder="repPlaceholder(cm)" :maxlength="MAX_LEN" />
                <n-button type="primary" size="small" round @click="sendCmt(cm)">{{ t("common.send") }}</n-button>
                </div>
            </div>

            <div v-if="repsOf(cm).length" class="cmt-reps">
              <div v-for="rp in visibleReps(cm)" :key="rp.id" class="cmt-item">
                <div class="cmt-head">
                  <b>{{ rp.name }}<span v-if="rp.replyTo" class="cmt-at"> @{{ rp.replyTo }}</span></b>
                  <button v-if="canDel(rp)" class="cmt-del" :title="t('common.delete')" @click="delCmt(rp)">×</button>
                  <!-- 轮 84：回复也有 … 菜单 -->
                  <button class="cmt-more" :title="t('comment.more')" :aria-label="t('comment.more')"
                    @click.stop="toggleCmtMore(rp)">⋯</button>
                  <div v-if="moreKey === 'cmt:' + rp.id" class="more-pop card" @click.stop>
                    <button v-if="canReportCmt(rp)" class="more-item" @click="moreReport">{{ t("report.act") }}</button>
                    <button class="more-item" @click="moreCopy">{{ t("common.copy") }}</button>
                  </div>
                </div>
                <p class="cmt-text" @click="startReply(cm, rp, $event)">{{ rp.text }}</p>
                <div class="cmt-acts">
                  <!-- 轮 84：时间移到「回复」左侧 + 轮 87：回应图标改空心灰 -->
                  <span class="cmt-time">{{ when(rp.ts) }}</span>
                  <button v-if="signedIn" class="cmt-act" @click="startReply(cm, rp, $event)">{{ t("comment.reply") }}</button>
                  <button v-if="rp.dbId != null" class="cmt-react t-like" data-kind="heart" :class="{ on: cmtReacted(rp, 'heart'), 'is-bursting': reactBurst(rp, 'heart') }" :data-liked="cmtReacted(rp, 'heart')"
                    :disabled="!!cmtReactBusy[rp.id]" :title="t('comment.likeT')" :aria-label="t('comment.likeT')"
                    @click="cmtReact(rp, 'heart')"><span class="t-like-icon"><svg class="rc-ico t-like-heart" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21.35 10.55 20.03C5.4 15.36 2 12.27 2 8.5 2 5.41 4.42 3 7.5 3c1.74 0 3.59.94 4.5 2.35C12.91 3.94 14.76 3 16.5 3 19.58 3 22 5.41 22 8.5c0 3.77-3.4 6.86-8.55 11.53L12 21.35z"/></svg></span><span class="t-like-particles" aria-hidden="true"><i v-for="n in 8" :key="n"></i></span><i>{{ reactCount(rp, "heart") }}</i></button>
                  <button v-if="rp.dbId != null" class="cmt-react t-like" data-kind="broken" :class="{ on: cmtReacted(rp, 'broken'), 'is-bursting': reactBurst(rp, 'broken') }" :data-liked="cmtReacted(rp, 'broken')"
                    :disabled="!!cmtReactBusy[rp.id]" :title="t('comment.brokenT')" :aria-label="t('comment.brokenT')"
                    @click="cmtReact(rp, 'broken')"><span class="t-like-icon"><svg class="rc-ico t-like-heart" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21.35 10.55 20.03C5.4 15.36 2 12.27 2 8.5 2 5.41 4.42 3 7.5 3c1.74 0 3.59.94 4.5 2.35C12.91 3.94 14.76 3 16.5 3 19.58 3 22 5.41 22 8.5c0 3.77-3.4 6.86-8.55 11.53L12 21.35z"/><path d="M12 6.8 10.4 9.4l2.4 1.5-1.5 2.4 1.1 1.8"/></svg></span><span class="t-like-particles" aria-hidden="true"><i v-for="n in 8" :key="n"></i></span><i>{{ reactCount(rp, "broken") }}</i></button>
                </div>
                <!-- 轮 97：统一输入条样式（发送在右 + 自动扩行） -->
                <div v-if="!isMobileNav && repActive === cm.id + ':' + rp.id" class="cmt-input cmt-input-in">
                  <div class="cmt-input-row">
                    <van-field v-model="repDraft[cm.id]" type="textarea" rows="1" autosize
                      :placeholder="repPlaceholder(cm, rp)" :maxlength="MAX_LEN" />
                    <n-button type="primary" size="small" round @click="sendCmt(cm, rp)">{{ t("common.send") }}</n-button>
                    </div>
                </div>
              </div>
            </div>

            <!-- 轮 88：展开/收起回复按钮移到回复列表底部（参考主流社区「展开其他 N 条回复 ›」样式） -->
            <button v-if="repsOf(cm).length > 2" class="replies-toggle" @click="toggleReplies(cm)">
              {{ repOpen[cm.id] ? t("comment.collapseReplies") : t("comment.expandOthers", { n: repsOf(cm).length - 2 }) }}
              <i class="rt-arrow">&#8250;</i>
            </button>

          </div>

          <!-- 轮 87：一级评论未展示完 → 「查看更多评论」续 15 条（此后下滑也会自动续展） -->
          <button v-if="tops.length > shownTops.length" class="cmt-act cmt-viewmore" @click="cmtReveal += CMT_PAGE">
            {{ t("comment.viewMoreCmt") }} <i class="vm-arrow">&#8250;</i>
          </button>

          <p v-if="!comments.length && !cmtLoading" class="cmt-empty">{{ t("comment.empty") }}</p>
        </div>
        <transition name="t-swap" mode="out-in">
      <p v-if="hint" :key="hint" class="sub" style="color: var(--low); font-weight: 700">{{ hint }}</p>
    </transition>
      </article>
    </template>
    </div><!-- /.pd-swipe 轮 279：左右滑位移层到此为止 -->

    <!-- 轮 111：桌面评论输入固定底栏（cmt-bar-fixed，轮 93 引入）**已退役**——
         主评论框搬进卡内「浏览次数 ↔ N 条评论」之间（用户要求与暖心墙轮 109 同款），未登录入口同址保留。 -->

    <!-- 轮 108 续5：手机端回复输入条（reply-bar）已退役——回复统一走下方 cmt-main-bar 底部输入条 -->
    <!-- 轮 108 续5：手机端底部输入条（主评论+回复共用，与暖心墙同款：贴键盘、tabbar 收起、点空白收起） -->
    <div v-if="isMobileNav && detailBar" ref="detailBarEl" class="cmt-main-bar">
      <!-- 轮 180：补表情按钮——一级评论与二级回复都走这条底部条，之前只有暖心墙有，帖子详情漏了。
           emo-in 让按钮绝对定位在输入框内右侧（同 style.css 里的 .emo-in 规则，与暖心墙同款）。 -->
      <van-field ref="detailBarInput" v-model="detailBarDraft" type="textarea"
        rows="1" autosize
        :placeholder="detailBarPh" :maxlength="MAX_LEN" />
      <n-button type="primary" size="small" round @click="sendDetailBar">{{ t("common.send") }}</n-button>
    </div>

    <!-- 轮 87：…菜单改 document 点击收起（原全屏遮罩会被卡片堆叠上下文盖住，举报/拷贝点了没反应） -->
    <!-- 举报弹窗（帖子/评论共用一个实例） -->
    <ReportDialog v-model:show="reportShow" :target="reportTarget" />
  </div>
</template>

<style scoped>
/* 轮 137：桌面流式壳（轮 133 起）下不再收窄居中——铺满左导航与右栏之间整块宽度；
 * 窄屏/App 形态不受影响（640 的 max-width 在 <900px 视口本就触不到）。 */
.pd { max-width: 640px; margin: 0 auto; }
@media (min-width: 900px) { .pd { max-width: none; } }
.pd-head { margin: 10px 0; }
.pd-back, .pd-retry {
  -webkit-appearance: none; appearance: none; font: inherit; cursor: pointer;
  border: 0; background: transparent; color: var(--ink-soft); font-weight: 500;
  padding: 8px 10px; border-radius: 10px; min-height: 40px;
}
.pd-back:hover, .pd-retry:hover { background: rgba(160, 110, 60, .08); }
.pd-retry { border: 1px solid var(--line); margin-top: 8px; }
.post-card { padding: 14px 16px; }
.post-head { display: flex; align-items: center; gap: 10px; }
.post-meta { flex: 1; min-width: 0; }
.post-name { font-weight: 500; overflow-wrap: anywhere; }
.post-time { font-size: 12px; color: var(--ink-faint); }
.post-text { white-space: pre-wrap; overflow-wrap: anywhere; margin: 10px 0 4px; line-height: 1.7; }
.pic { display: block; max-width: 100%; border-radius: 12px; margin: 8px 0 4px; }
.react-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.post-foot { display: flex; align-items: center; gap: 10px; margin-top: 8px; color: var(--ink-faint); font-size: 12px; }
.post-dis {
  -webkit-appearance: none; appearance: none; border: 0; background: transparent;
  cursor: pointer; color: var(--ink-faint); font: inherit; font-size: 12px;
  padding: 2px 6px; border-radius: 8px;
}
.post-dis.on { color: var(--low); font-weight: 500; }
.post-dis:disabled { cursor: default; opacity: .6; }
.cmt-toggle { display: inline-flex; align-items: center; gap: 6px; margin-top: 10px; cursor: pointer; color: var(--ink-soft); font-weight: 500; }
.cmt-caret { transition: transform .15s ease; display: inline-block; }
.cmt-caret.open, .cmt-act i.open { transform: rotate(180deg); }
.cmt-box { margin-top: 10px; border-top: 1px dashed var(--line); padding-top: 10px; }
.cmt-empty { color: var(--ink-faint); margin: 6px 0; }
.cmt-item { padding: 8px 0; }
.cmt-head { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.cmt-head span { color: var(--ink-faint); font-size: 12px; }
.cmt-del {
  margin-left: auto; -webkit-appearance: none; appearance: none; border: 0;
  background: transparent; color: var(--ink-faint); cursor: pointer; font-size: 15px; line-height: 1;
}
.cmt-del:hover { color: var(--low); }
.cmt-text { margin: 4px 0; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.6; cursor: pointer; }
.cmt-acts { display: flex; gap: 12px; }
.cmt-act {
  -webkit-appearance: none; appearance: none; border: 0; background: transparent;
  color: var(--ink-faint); cursor: pointer; font: inherit; font-size: 12px; padding: 0;
}
.cmt-act:hover { color: var(--ink-soft); }
.cmt-act i { transition: transform .15s ease; display: inline-block; font-style: normal; }
.cmt-at { color: var(--ink-faint); font-weight: 400; }
.cmt-reps { margin-left: 18px; border-left: 2px solid var(--line); padding-left: 10px; }
.cmt-input { display: flex; align-items: center; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.cmt-input-in { margin: 8px 0 2px; }
.cmt-input > .n-input { flex: 1; min-width: 0; }
.cmt-login { font-weight: 500; }

/* ── 轮 279 · 左右滑位移层 ── */
.pd-swipe {
  /* pan-y = 纵向滚动交给浏览器、横向交给 JS。不写这条，iOS 会把手势当横向滚动
   * 或边缘返回抢走，跟手会断；写了它 touchmove 才能用 passive 监听（不用 preventDefault）。 */
  touch-action: pan-y;
  overscroll-behavior-x: contain;
}
.pd-swipe.drag { transition: none; user-select: none; -webkit-user-select: none; }
.pd-swipe.out { transition: transform .22s cubic-bezier(.22, .72, .28, 1); }
@media (prefers-reduced-motion: reduce) { .pd-swipe.out { transition-duration: .01ms; } }
</style>
