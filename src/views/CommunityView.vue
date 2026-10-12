<script>
/* 轮 95：模块级存档 —— 离开暖心墙时保存浏览位置（script setup 的变量是每实例一份，
 * 离开组件就没了；这里必须跨实例存活，返回时才恢复得了）。
 * 轮 215：再落盘 localStorage——App 重启/页面刷新也要回到原位置（用户实测「每次过去都要往下拉」）。 */
let savedFeedPos = null;
const FEED_ARCHIVE_KEY = "wp-feed-archive";
/* 轮 217：恢复期间隐藏整面墙——恢复要等布局落地后才回滚位置，裸奔的首帧（顶部态）
 * 就是被用户看到的「下滑」。藏到滚到位再揭示 = 第一帧就在原位置（知乎式页签回位）。 */
const feedRestoring = ref(false);
const wallScrollerEl = ref(null);
let wallScrollTop = 0;   /* 轮 219：容器离场时的滚动位置（重插时浏览器会归零，必须显式恢复） */
</script>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch, nextTick, onActivated, onDeactivated } from "vue";
import { useRouter, useRoute, onBeforeRouteLeave } from "vue-router";
import { NButton, NInput, NAvatar, NTag } from "naive-ui";
import { t, i18n } from "../i18n.js";
import { getItem, setItem, removeItem } from "../utils/storage.js";
import { restoreScroll } from "../utils/scrollMem.js";
/* 轮 32：个人数据键按账号分域（游客账/各登录账号互不串），读写走 scopeGet/scopeSet */
import { scopeGet, scopeSet, scopeGetRaw, scopeSetRaw } from "../utils/userScope.js";
import { cacheKey, cacheSet, swr } from "../utils/cache.js";
/* 轮 84：墙内前 3 条 / 查看更多 / 评论回应 / 拷贝文本。
   注意：import 大括号内不要写注释 —— undef-check 的导入解析器会把注释与下一个名字粘连（踩过）。 */
import {
  CMT_KEY, addComment, removeComment, displayCount,
  canDelete, normalizeText, postKey, MAX_LEN,
  topComments, repliesOf, replyCount,
  wallTopComments, hasMoreComments, reactCount, toggleReact,
  hasReacted as cmtHasReacted, postCopyText, commentCopyText,
} from "../utils/comments.js";
/* 动态流虚拟窗口（纯逻辑，Node 单测覆盖：tools/feed-window-test.mjs）—— 轮 82 · B1 档 */
import {
  buildOffsets, windowRange, nearEnd, revealTarget, idOf,
  DEFAULT_EST, DEFAULT_OVERSCAN, WINDOW_ON_THRESHOLD, NEAR_END_PX,
} from "../utils/feedWindow.js";
import { cloud } from "../utils/supabase.js";
/* 回应写入收敛器（纯逻辑，Node 单测覆盖）：连点串行落库 + 过期响应不回写 */
import { createWriteQueue } from "../utils/reactQueue.js";
/* 轮 84：评论回应（mine 拉取 + 切换）—— 大括号内不写注释，同上 */
import {
  cloudFetchPosts, cloudFetchPostsSample, cloudFetchWallRefresh, cloudInsertPost, cloudFetchComments, cloudInsertComment,
  cloudDeleteComment, cloudSetReaction, cloudFetchCommentCounts, canUseWall, canReadWall,
  cloudAddView, cloudToggleDislike,
  cloudFetchMyCommentReactions, cloudToggleCommentReaction,
  cloudFavIds, cloudFavAdd, cloudFavRemove, cloudSearchPosts,
} from "../utils/wall.js";
/* 进阶规则（纯函数，Node 单测覆盖）：排序 / 浏览去重 / 厌恶比例下架 / 每日一条 */
import {
  SORTS, sortPosts, collectViews, visibleOnly, utcDay, ratioPct,
  canPostToday, postsLeftToday, dayCountFromStorage, WALL_POST_DAILY_LIMIT,
  errorKind, VIEW_KEY, ANON_KEY, POST_DAY_KEY, POSTS_KEY, REACTS_KEY,
  RANGES, inRange, usesRange, rangeFor, fmtWhen, memoWhen,
  recommendPosts, RECOMMEND_DAYS,
} from "../utils/wallRules.js";
import { isMobileNav, tabbarSuppressed, retapSeq, retapPath } from "../stores/uiStore.js";
/* 轮 33：举报弹窗 + 全站拉黑过滤（我拉黑的人，TA 的帖子/评论在我这里渲染前剔除） */
import ReportDialog from "../components/ReportDialog.vue";
import { filterBlocked, refreshBlocks } from "../utils/userBlocks.js";
/* 轮 84：…菜单的「拷贝」（WebView 里 navigator.clipboard 缺失时 execCommand 兜底） */
import { copyText } from "../utils/clipboard.js";
import { avatarUrlFor } from "../utils/avatar.js";   /* 轮 238:萌宠头像池 */
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
  /* 轮 95：有离场存档 → 整份列表原样恢复（含已加载的更深处页），不被第一页覆盖。
   * 轮 215：模块级存档没有（App 重启/刷新）→ 从 localStorage 恢复——浏览位置跨重启保留。 */
  if (savedFeedPos) restoreFeed();
  else {
    try {
      const saved = getItem(FEED_ARCHIVE_KEY);
      if (saved) { savedFeedPos = JSON.parse(saved); }
    } catch (e) { /* 忽略 */ }
    if (savedFeedPos) restoreFeed();
    else if (cloud.ready) loadCloud();
  }
  refreshBlocks();   /* 轮 33：拉黑名单就绪（快照先撑着，云端校准） */
});
/* 云端就绪晚于挂载（异步探测）→ 就绪后补拉一次；未登录也拉（RLS 匿名只读） */
watch(() => cloud.ready, (v) => {
  if (v && !cloudPosts.value.length && !restoreTick) loadCloud();
});
/* 会话从无到有（登录完成）→ 用本人身份重拉一次：帖子的 mine（我点过谁）才准确，
   否则「我点过的抱抱」显示成没点，再点一次会把旧的取消掉（用户实测「取消不了」的根因）。 */
watch(() => cloud.user && cloud.user.id, (uid) => {
  if (cloud.ready && uid && !restoreTick) {
    refreshBlocks();   /* 轮 33：登录后同步我的拉黑名单（过滤靠它） */
    if (cloudPosts.value.length) loadCloud();
  }
});

/* 轮 56：服务端分页（真·无限流）——FEED_PAGE 条/页，触底向服务器取下一页追加；
   下拉刷新 = 重置回第 1 页并强制取新（绕过 SWR 缓存）。
   轮 60（真机实测翻车修复）：**旧格式缓存盒不得当分页游标**——升级首启时缓存还是
   老口径（16 条），consume 把 16 当 offset、16<50 当「服务器已到底」→ 无限流永不动、
   卡死在十几条（用户：「就显示了几条就没了」）。改法：缓存盒只做**展示快照**
   （offset 归 0、done=false、freshLanded=false），游标只认**本轮 fetch 的结果**
   （box.fromFetch）；快照亮完而 fresh 未落地前不翻页（防与第 1 页重复）。 */
const FEED_PAGE = 50;
const REFRESH_PAGE = 20;   /* 轮 162：刷新/首屏批瘦身——视口只露 16 张，拉 50 条+两轮富化纯浪费；触底续载仍 50 */
const feedCursor = ref(null);   /* 轮 62：游标 = 已加载最后一条的 dbId（id 单调=发布序），取代 offset */
const cloudDone = ref(false);
const pageBusy = ref(false);
const refreshNote = ref("");   /* 轮 162：刷新提示状态机 ""|busy|ok|batch|fail */
const refreshText = computed(() => ({
  busy: t("community.refreshing"), ok: t("community.refreshed"),
  batch: t("community.refreshBatch"), fail: t("community.refreshFail"),
}[refreshNote.value] || ""));
/* 轮 227：提示停留时长按状态区分——用户反馈「没刷出来，再试一次」这条停太久
   （原来是统一 2500ms）。失败提示只需告知「这次没成」，看一眼就够，不该杵在那儿；
   成功 / 换批稍长些无妨（要看清刷新出结果了）。 */
const NOTE_FAIL_MS = 1200;
const NOTE_OK_MS = 2200;
const noteMs = (s) => (s === "fail" ? NOTE_FAIL_MS : NOTE_OK_MS);
const newestSeenTs = ref(0);   /* 轮 73：补上缺失声明（真新帖判定用） */
const lastPulledRows = ref([]);   /* 轮 76：本次刷新拉到的批（评论数后台补齐用） */

/* ══════════ 轮 252 · 搜索 + 标签 ══════════
 * 关键词（正文 ilike）+ 标签（tags 交集，服务端筛）都由 cloudSearchPosts 完成；
 * 搜索激活时 shown 直接改道返回搜索结果（不动正常流的游标/缓存，清空搜索即原样回来）。
 * 老库（迁移没跑）时后端隐掉标签条件、tags 恒空 → 标签搜索返回空结果，属预期降级。 */
const searchQ = ref("");          /* 关键词输入（300ms 防抖自动搜） */
const searchTags = ref([]);       /* 选中的标签（点击 chip 增删） */
const searchRows = ref([]);       /* 搜索结果帖（服务端 id desc） */
const searchBusy = ref(false);
const searchDone = ref(false);    /* 结果不满一页 = 服务端到底 */
const searchTouched = ref(false); /* 用户发起过搜索（空结果才显示「没有找到」） */
const searchActive = computed(() => !!(searchQ.value.trim() || searchTags.value.length));

async function runSearch({ append = false } = {}) {
  if (searchBusy.value) return;
  const q = searchQ.value.trim();
  const tags = searchTags.value.slice(0, 5);
  if (!q && !tags.length) {
    searchRows.value = []; searchDone.value = false; searchTouched.value = false;
    return;
  }
  searchBusy.value = true;
  searchTouched.value = true;
  try {
    const before = append && searchRows.value.length ? searchRows.value[searchRows.value.length - 1].dbId : 0;
    const pack = await cloudSearchPosts({ q, tags, limit: FEED_PAGE, before });
    if (!pack || !Array.isArray(pack.rows)) return;   /* 失败：保留现场，再输入/滚动时重试 */
    const rows = filterBlocked(pack.rows);
    if (!append) { searchRows.value = rows; reveal.value = PAGE_SIZE; }
    else {
      const seen = new Set(searchRows.value.map((p) => p.dbId));
      searchRows.value = searchRows.value.concat(rows.filter((p) => !seen.has(p.dbId)));
    }
    countViews(searchRows.value);
    if (pack.counts) {
      const next = { ...cloudCmtTotal.value };
      for (const p of rows) if (p.dbId != null && pack.counts[p.dbId] != null) next[cmtKey(p)] = pack.counts[p.dbId];
      cloudCmtTotal.value = next;
    }
    searchDone.value = rows.length < FEED_PAGE;
  } finally {
    searchBusy.value = false;
  }
}

/* 输入防抖自动搜；标签增删立即重搜；清空两者即退出搜索态 */
let searchTimer = 0;
watch(searchQ, () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(), 320);
});
watch(searchTags, () => runSearch());
function toggleSearchTag(tg) {
  const i = searchTags.value.indexOf(tg);
  searchTags.value = i < 0 ? [...searchTags.value, tg] : searchTags.value.filter((x) => x !== tg);
}
/* 帖子上的标签 chip → 直接按该标签搜（清关键词，单标签） */
function searchByTag(tg) {
  searchQ.value = "";
  searchTags.value = [tg];
  focusFeedTop();
}
function clearSearch() {
  searchQ.value = "";
  searchTags.value = [];
}
/* 回到列表顶部（手机端墙自滚 / 桌面整页滚，两条都判） */
function focusFeedTop() {
  const el = wallScrollerEl && wallScrollerEl.value;
  if (el && typeof el.scrollTo === "function") el.scrollTo({ top: 0, behavior: "smooth" });
  else if (typeof window !== "undefined" && typeof window.scrollTo === "function") window.scrollTo({ top: 0, behavior: "smooth" });
}
/* 热门标签：从已加载帖子里取频次前 12（搜索入口；帖子少时不显示） */
const hotTags = computed(() => {
  const cnt = {};
  for (const p of cloudPosts.value) for (const tg of (p.tags || [])) cnt[tg] = (cnt[tg] || 0) + 1;
  return Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([tg]) => tg);
});

async function loadCloud({ fresh = false, quiet = false } = {}) {
  loadingCloud.value = true;
  let freshOk = true;   /* 轮 165 修：必须声明在函数作用域——上一轮写进了 if(fresh) 块内，
                           而函数尾 return freshOk 在块外 → ReferenceError 直接把整页炸成错误卡 */
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
    if (box.fromFetch) {
      /* 本轮 fetch 的结果：游标=末条 dbId（id<游标 取下一页） */
      feedCursor.value = box.rows.length ? box.rows[box.rows.length - 1].dbId : feedCursor.value;
      /* 轮 230 修「往下拉几轮就到底了」：**这里绝不能判「服务器已到底」**。
         首屏/刷新拉的是 REFRESH_PAGE(20) 条（轮 162 瘦身），而本行原来拿 FEED_PAGE(50)
         去比 —— 20 < 50 恒成立，于是每次首屏/刷新都把 cloudDone 置 true，触底续载被
         feedTick 的 `else if (!cloudDone.value)` 挡死，永远只有首屏那 20 条
         （真机取证：滚到底后 /api/posts 请求数停在 2、再也不发，底部直接显示「就到这里啦」）。
         「到底」只能由**分页请求**判定（loadMoreCloud 拿到空页 / 不满一页 FEED_PAGE 时才为真）。
         这里保守置 false：万一真到底，触底会发一次分页请求拿回空页，随即自愈为 true。 */
      cloudDone.value = false;
      newestSeenTs.value = Math.max(newestSeenTs.value, ...box.rows.map((p) => p.ts || 0));
    } else {
      /* 旧/外来缓存盒：仅展示快照——游标清空、不算到底（loadMoreCloud 的去重+跳页会自愈错位） */
      feedCursor.value = null;
      cloudDone.value = false;
    }
  };
  /* 轮 206：进入路径的静默刷新 = **软合并**——只把没见过的新帖钉顶，其余原顺序不动、
   * 不再整表替换（随机批 reshuffle 只属于下拉/强制刷新那种「用户明确要换一批」的场景）。
   * 旧路径进入也整表替换 = 用户实测「暖心墙帖子每次都要重新加载，非常卡」。 */
  const consumeSoft = (box) => {
    if (!box || !Array.isArray(box.rows) || !box.rows.length) return;
    const cur = cloudPosts.value;
    if (!cur.length) { consume(box); return; }   /* 首次无内容：正常 consume */
    const known = new Set(cur.map((p) => cmtKey(p)));
    const additions = filterBlocked(box.rows)
      .filter((p) => !known.has(cmtKey(p)))
      .sort((a, b) => (b.ts || 0) - (a.ts || 0));
    countViews(additions);
    if (additions.length) cloudPosts.value = [...additions, ...cur];
    if (box.counts) {
      const next = { ...cloudCmtTotal.value };
      for (const p of [...additions, ...cur]) {
        if (p.dbId != null && box.counts[p.dbId] != null) next[p.dbId] = box.counts[p.dbId];
      }
      cloudCmtTotal.value = next;
    }
    newestSeenTs.value = Math.max(newestSeenTs.value, ...box.rows.map((p) => p.ts || 0));
  };
  /* 轮 231 · 静默新鲜化（切回页签专用）：只把**没见过的新帖**软合并进顶部，
     不亮 loading、不碰游标/到底状态、更不整表替换 —— 所以滚动位置分毫不动。
     起因（用户反馈）：「点暖心墙，那个应该是刷新啊，现在怎么没反应」——
     轮 218 的 KeepAlive 保活让切回时一个数据请求都不发，内容停在离开那一刻；
     这里补上「数据新鲜」，同时保住「位置不变」。
     ⚠ 必须放在 consume / consumeSoft 定义**之后**：提前 return 会踩 const 的 TDZ。 */
  if (quiet) {
    loadingCloud.value = false;
    try {
      const pack = await cloudFetchWallRefresh(REFRESH_PAGE);
      if (pack && Array.isArray(pack.rows) && pack.rows.length) {
        consumeSoft({ rows: pack.rows, counts: pack.counts || {} });
      }
    } catch (e) { /* 静默：切回页签的刷新失败不该打扰用户 */ }
    return true;
  }
  /* 轮 66：挂载取数器也走「随机换一批」——不再固定拉最新页（那正是「A 复活」的根源：
     随机批不回写缓存 + 挂载永远拉最新页 → 重开/刷新总回到同一批）。 */
  const fetcher = async () => {
    /* 轮 169：首屏也走合并包（一个请求：最新+随机+回应+评论数），弱网少 4 个来回；
       失败退回旧两段式（最新页）兜底。触底续载照旧按游标拉更早的。 */
    const pack = await cloudFetchWallRefresh(REFRESH_PAGE).catch(() => null);
    if (pack && Array.isArray(pack.rows) && pack.rows.length) {
      return { rows: pack.rows, counts: pack.counts || {}, fromFetch: true };
    }
    const rows = await cloudFetchPosts(REFRESH_PAGE, 0).catch(() => null);
    if (!rows) return null;   /* 拉取失败 → 不覆盖、不回写缓存 */
    const counts = await cloudFetchCommentCounts(rows.map((r) => r.dbId)).catch(() => null);
    return { rows, counts: counts || {}, fromFetch: true };
  };
  if (fresh) {
    /* 轮 77（用户：「刷新根本不动」——上轮死锁真因：拉取失败时 box.posts=null 仍进
       consume → filterBlocked(null) 抛错 → loadingCloud 永久 true → 之后所有刷新被
       卫语句挡死。修：①帖数据必须是数组才进 consume（失败/超时如实提示并复位）；
       ②整函数 try/finally，loadingCloud 任何路径必复位；③评论数后台补不阻塞。 */
    refreshNote.value = "busy";
    const prevNewest = newestSeenTs.value;
    const key = cacheKey("wall:posts", (cloud.user && cloud.user.id) || "");
    /* 轮 169：刷新只有一个请求了——worker 打包「最新+随机+回应+评论数」一次回；
       新帖必现（最新 4 条钉顶），其余随机换一批。 */
    const pull = cloudFetchWallRefresh(REFRESH_PAGE).catch(() => null).then((pack) =>
      pack && Array.isArray(pack.rows) ? { rows: pack.rows, counts: pack.counts || {} } : null);
    const box = await Promise.race([pull, new Promise((res) => setTimeout(() => res(null), 8000))]).catch(() => null);
    /* 轮 79（关键取舍修复）：最新页里**有真新帖**（比见过的最新 ts 还新）→ 用最新页；
       **没有** → 用随机批（换一批）——此前随机批取了但永远不用，内容自然「不刷新」。
       两个分支都回写缓存；都失败/超时 → 如实提示并保留旧列表。 */
    const hasNew = box && box.rows.some((p) => (p.ts || 0) > prevNewest);
    if (box && box.rows.length) {
      lastPulledRows.value = box.rows;
      consume({ rows: box.rows, counts: box.counts || {}, fromFetch: true });
      reveal.value = PAGE_SIZE;
      cacheSet(key, { rows: box.rows, counts: box.counts || {}, fromFetch: true });
      refreshNote.value = hasNew ? "ok" : "batch";
    } else {
      refreshNote.value = "fail";
      freshOk = false;
    }
    /* 轮 227：按状态决定停留时长（fail 短、ok/batch 稍长）；顺手把 false 改成 "" —— 该 ref
       的类型是字符串状态机，塞布尔值虽然 v-if 也能判假，但读起来是两套语义。 */
    setTimeout(() => { refreshNote.value = ""; }, noteMs(refreshNote.value));
  } else {
    await swr(
      cacheKey("wall:posts", (cloud.user && cloud.user.id) || ""),
      { cached: consume, fresh: consumeSoft },
      fetcher,
    );
  }
  /* 轮 77：loadingCloud 用 finally 复位——上面任何一步抛错都不再把刷新锁死 */
  try {
    /* 评论数后台补齐——刚刷新的批先渲染，评论数到达后并入并回写缓存 */
    if (fresh && Array.isArray(lastPulledRows.value) && lastPulledRows.value.length) {
      const ids = lastPulledRows.value.map((r) => r.dbId);
      const key2 = cacheKey("wall:posts", (cloud.user && cloud.user.id) || "");
      cloudFetchCommentCounts(ids).then((counts) => {
        if (!counts) return;
        const next = { ...cloudCmtTotal.value };
        for (const p of lastPulledRows.value) {
          if (p.dbId != null) next[cmtKey(p)] = counts[p.dbId] || 0;
        }
        cloudCmtTotal.value = next;
        cacheSet(key2, { rows: lastPulledRows.value, counts, fromFetch: true });
      }).catch(() => {});
    }
  } finally {
    loadingCloud.value = false;
  }
  return freshOk;
}

/* 触底续载（轮 62 自愈版）：游标取下一页，**追加前去重**——缓存快照与游标页交叠、
   时间戳并列导致跨页重排等任何错位，都只表现为「整页重复」→ 跳过该页用下一页游标续取
   （最多跳 3 页），永不产生重复 :key、永不假到底。 */
async function loadMoreCloud() {
  /* 轮 252：搜索态下触底 = 搜索结果续页（before 游标同款口径） */
  if (searchActive.value) {
    if (!searchDone.value && !searchBusy.value) await runSearch({ append: true });
    return;
  }
  if (cloudDone.value || pageBusy.value || loadingCloud.value) return;
  pageBusy.value = true;
  try {
    let cursor = feedCursor.value;
    for (let hop = 0; hop < 3; hop++) {
      const rows = await cloudFetchPosts(FEED_PAGE, cursor);
      if (!rows) return;                    /* 拉取失败：保留现场，下次触底再试 */
      if (!rows.length) { cloudDone.value = true; return; }   /* 空页 = 真到底 */
      const seen = new Set(cloudPosts.value.map((p) => p.dbId));
      const add = filterBlocked(rows.filter((p) => !seen.has(p.dbId)));
      if (add.length) {
        countViews(add);
        cloudPosts.value = cloudPosts.value.concat(add);
        feedCursor.value = rows[rows.length - 1].dbId;
        cloudDone.value = rows.length < FEED_PAGE;
        const counts = await cloudFetchCommentCounts(rows.map((r) => r.dbId)).catch(() => null);
        if (counts) {
          const next = { ...cloudCmtTotal.value };
          for (const p of add) {
            if (p.dbId != null) next[cmtKey(p)] = counts[p.dbId] || 0;
          }
          cloudCmtTotal.value = next;
        }
        return;
      }
      cursor = rows[rows.length - 1].dbId;  /* 整页都是已加载过的 → 前进游标跳过这页 */
    }
    cloudDone.value = true;                 /* 连跳 3 页全重复：数据库真没有没看过的了 */
  } finally {
    pageBusy.value = false;
  }
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
/* 自己的内容不显示举报（不能举报自己）；游客也显示入口——点了弹窗里会提示先登录。
 * 注意：按钮只出现在「别人」的云端内容上，看自己的帖子/评论没有是设计如此。 */
const canReportPost = (p) => !!(p && p.cloud && p.dbId != null && p.userId && p.userId !== myUid.value);
const canReportCmt = (cm) => !!(cm && cm.cloud && cm.dbId != null && cm.userId && cm.userId !== myUid.value);

/* ═════════ 轮 84 · …菜单（帖子/评论：举报迁入 + 拷贝） ═════════
 * 同一时刻最多开一个菜单（moreKey 唯一键）；透明遮罩盖全屏，点空白收起。
 * 菜单本体渲染在 .post-head / .cmt-head 里（absolute 定位到触发按钮下方）。 */
const moreKey = ref("");
const moreTarget = ref(null);   /* { type, reportable, dbId, label, copy } */
function postMoreKey(p) { return "post:" + (p.dbId != null ? p.dbId : p.id); }
function cmtMoreKey(cm) { return "cmt:" + cm.id; }
/* 轮 128 · 收藏（#13）：⋯菜单收藏/取消；favSet 随信息流批次与登录态刷新 */
const favSet = ref(new Set());
async function refreshFav() {
  if (!signedIn.value) { favSet.value = new Set(); return; }
  const ids = [...new Set(cloudPosts.value.map((x) => x.dbId).filter((x) => x != null))];
  if (!ids.length) return;
  favSet.value = new Set(await cloudFavIds(ids));
}
watch(() => cloudPosts.value, () => { refreshFav(); });
watch(signedIn, () => { refreshFav(); });
function moreFav() {
  const t0 = moreTarget.value;
  closeMore();
  if (!t0 || t0.dbId == null) return;
  if (!signedIn.value) return showWallMsg("fav.signIn");
  const wasOn = favSet.value.has(t0.dbId);
  if (wasOn) {
    favSet.value = new Set([...favSet.value].filter((x) => x !== t0.dbId));
    cloudFavRemove(t0.dbId).then((ok) => { if (!ok) showWallMsg("fav.fail"); });
    showWallMsg("fav.removed");
  } else {
    favSet.value = new Set([...favSet.value, t0.dbId]);
    cloudFavAdd(t0.dbId).then((ok) => {
      if (!ok) {
        favSet.value = new Set([...favSet.value].filter((x) => x !== t0.dbId));
        showWallMsg("fav.fail");
      }
    });
    showWallMsg("fav.done");
  }
}
function togglePostMore(p) {
  const k = postMoreKey(p);
  moreKey.value = moreKey.value === k ? "" : k;
  moreTarget.value = { type: "post", reportable: canReportPost(p), dbId: p.dbId, faved: favSet.value.has(p.dbId), label: p.text || p.en || "", copy: postCopyText(p) };
}
function toggleCmtMore(cm) {
  const k = cmtMoreKey(cm);
  moreKey.value = moreKey.value === k ? "" : k;
  moreTarget.value = { type: "comment", reportable: canReportCmt(cm), dbId: cm.dbId, label: cm.text || "", copy: commentCopyText(cm) };
}
function closeMore() { moreKey.value = ""; }
/* 轮 87：不再用全屏遮罩（.card 的 backdrop-filter 会造出堆叠上下文，菜单 z-index 出不来，
 * 遮罩反而盖住菜单 → 点举报/拷贝全被遮罩吃掉「无反应」）。改为 document 级点击收起：
 * 触发钮有 @click.stop 不会立即关；菜单项点击后冒泡到 document 一并收起，动作不受影响。 */
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
  showWallMsg(ok ? "common.copied" : "common.copyFail");
}

/* ═════════ 轮 84 · 评论回应（❤️ / 💔） ═════════
 * 与帖子厌恶同思路：乐观翻转 → RPC 返回服务端权威计数 → 覆盖；失败回滚。
 * 「我点过哪些」不进列表（按用户变化），展开评论区后单独拉一次 mine。 */
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
async function cmtReact(p, cm, kind) {
  if (!cm || cm.dbId == null || cmtReactBusy.value[cm.id]) return;
  if (!signedIn.value) return showWallMsg("community.reactSignIn");
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
    showWallMsg("community.reactFail");
  }
  const next = { ...cmtReactBusy.value };
  delete next[cm.id];
  cmtReactBusy.value = next;
}
/* 展开评论区后补拉「我点过的」；失败静默（只是少了高亮，不影响计数展示） */
async function loadCmtMine(p, rows) {
  const ids = (Array.isArray(rows) ? rows : []).filter((r) => r.dbId != null).map((r) => r.dbId);
  if (!ids.length || !cloud.user || !cloud.user.id) return;
  const mine = await cloudFetchMyCommentReactions(ids, cloud.user.id);
  if (!mine) return;
  const map = {};
  for (const r of mine) { (map[r.comment_id] = map[r.comment_id] || []).push(r.kind); }
  const arr = comments.value[cmtKey(p)];
  if (!Array.isArray(arr)) return;
  for (const cm of arr) { if (map[cm.dbId]) cm.myReacts = map[cm.dbId]; }
}

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
function wallScroller() {
  return isMobileNav ? (padTopEl.value ? padTopEl.value.parentElement : null) : null;
}
function ts(e) {
  const sc = wallScroller();
  if (!sc || sc.scrollTop <= 0) { pullStart = e.touches[0].clientY; pulling = true; }
}
function tm(e) {
  if (!pulling) return;
  const d = e.touches[0].clientY - pullStart;
  const sc = wallScroller();
  if (d > 0 && (!sc || sc.scrollTop <= 0)) pullDist.value = Math.min(90, d);
  else pulling = false;
}
async function te() {
  if (!pulling) return;
  pulling = false;
  if (pullDist.value >= 62) {
    /* 轮 56：下拉刷新 = 强制取新第 1 页（不再拿缓存装样子）；轮 162：成败如实提示 */
    const okPull = await loadCloud({ fresh: true });
    refreshNote.value = okPull ? "ok" : "fail";
    setTimeout(() => { refreshNote.value = ""; }, noteMs(refreshNote.value));   /* 轮 227：fail 只停 1.2s */
  }
  pullDist.value = 0;
}

/* ════════ 网页端刷新按钮（轮 83）════════
 * 下拉刷新靠 touch 事件（ts/tm/te），桌面网页没有触屏永远够不着 —— 用户点名补一个按钮。
 * 点它 = 与下拉同一条强制取新路径（loadCloud({ fresh: true })，轮 79 取舍逻辑在内部），
 * 提示语（刷新中/已刷新/换一批/失败）也由 loadCloud 内部管理，这里不再重复置。
 * App 壳里隐藏（style.css 的 html.cap-app 规则）：App 有原生下拉，两处入口重复。 */
async function manualRefresh() {
  if (loadingCloud.value) return;   /* 刷新进行中防重入（按钮同时 disabled 兜底） */
  await loadCloud({ fresh: true });
}

/* 轮 232：**再点一次底部「暖心墙」页签 = 回到顶部 + 刷新**（主流做法，用户点名要的口径）。
 * 回顶必须滚**容器** —— 手机端墙是自滚容器（wallScrollerEl，window 一动不动），
 * 而且要把记忆位置 wallScrollTop 一并归零：否则下次离开再回来会被「位置保持」又拽回旧位置，
 * 等于白回顶。刷新复用 manualRefresh（与下拉刷新、网页刷新钮同一条路径，成败都有提示）。 */
watch([retapSeq, retapPath], ([, p]) => {
  if (p !== route.path) return;                 /* 点的是别的页签，不归我管 */
  const el = wallScrollerEl.value;
  if (el) el.scrollTo({ top: 0, behavior: "smooth" });
  else window.scrollTo({ top: 0, behavior: "smooth" });
  wallScrollTop = 0;
  manualRefresh();
});

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
   逻辑全部在 src/utils/comments.js（纯函数，已通过 Node 单元测试） */
function loadComments() {
  /* 轮 146：示例帖下线 → 不再注入示范评论，直接读本机存储 */
  return scopeGet(CMT_KEY, {}) || {};
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
/* 一级评论（主列表）。轮 84：墙内只展示前 WALL_TOP_LIMIT(3) 条；更多 → 「查看更多」进详情页。
 * 顺序维持原口径（按发布先后），详情页里才提供 最新/最热 排序。 */
function listFor(p) { return wallTopComments(topComments(comments.value, p)); }
function hasMoreCmts(p) { return hasMoreComments(topComments(comments.value, p)); }
/* 某条一级评论下的回复（二级） */
function repliesFor(p, cm) { return repliesOf(comments.value, p, cm.id); }
function repliesN(p, cm) { return replyCount(comments.value, p, cm.id); }
/* 轮 50：二级回复默认显示前两条（用户拍板，不再默认全收起）；
   >2 条时「N 条回复」按钮 = 展开全部 ↔ 收回默认两条。 */
function visibleReplies(p, cm) {
  const rs = repliesFor(p, cm);
  return isRepOpen(p, cm) ? rs : rs.slice(0, 2);
}
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
  /* 轮 98：取消按钮已移除 —— 再点同一条的「回复」= 收起该框（无二级框开着时） */
  if (isReplyOpen(p, cm) && !replyRp.value[repKey(p, cm)]) return cancelReply(p);
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
  /* 轮 98：再点同一条回复的「回复」= 收起该框 */
  if (replyRp.value[repKey(p, cm)] === rp.id) return cancelReply(p);
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
  /* 就地出框还要看得见：滚到视野中央（二级「就地」框挂在被回复那条下面，长线程里不滚就会被当成「没反应」；
     轮 110 一级框已上移到本评论正文/操作行之下，仍在原位置附近，滚动保留只为防卡顶把它压到视口外） */
  if (el.scrollIntoView) el.scrollIntoView({ block: "center", behavior: "smooth" });
  if (el.focus) el.focus();
}
function cmtInputSel(p) {
  const k = CSS.escape(String(cmtKey(p)));
  /* 轮 109：主评论输入框上移到卡内「浏览次数 ↔ 评论按钮」之间（id = cmtmain-*）；
     未登录的云端帖该框不渲染 → 兜底仍查评论区内的输入位（老口径不变） */
  return `#cmtmain-${k} input, #cmtmain-${k} textarea, #cmtbox-${k} input, #cmtbox-${k} textarea`;
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
    loadCmtMine(p, rows);   /* 轮 84：补拉「我点过的评论回应」（高亮用，失败静默） */
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

/* ═══ 轮 108 · 手机端主评论两段式（用户截图图1/图2）：卡内常驻「说点温柔的话…」占位条 →
 * 点击弹底部输入条（发送在右），再点占位条或发送成功即收起。
 * 轮 108 续3：一级/二级「回复」也统一走这条底部输入条（回复模式带「回复 xxx…」占位符），
 * 内联回复框只在桌面渲染；发送复用 sendCmt(p, cm) 全套既有逻辑。
 * 桌面（Web 端）保持评论区首部的内联输入框——两平台不同输入方式（轮 106 定案）。
 * 云端帖未登录没有可写输入位：占位条/回复点击只给登录提示（与原内联态一致）。 ═══ */
const mainBarKey = ref("");     /* 底部输入条正服务哪条帖（postKey）；空 = 收起 */
const mainBarPost = ref(null);  /* 对应的帖子对象（发送要用 p.cloud / p.dbId） */
const mainBarReply = ref(null); /* 回复目标 { cm, rp }；null = 主评论模式（续3） */
const mainBarInput = ref(null);
const mainBarEl = ref(null);    /* 条本体（点空白收起时用来排除条内点击） */
function closeMainBar() {
  mainBarKey.value = "";
  mainBarPost.value = null;
  mainBarReply.value = null;
}
/* 底部条草稿：主评论模式读写 cmtDraft[postKey]，回复模式读写 repDraft[repKey]——
 * 与内联框同源存取，切目标/切模式互不串字 */
const mainBarDraft = computed({
  get() {
    const r = mainBarReply.value, p = mainBarPost.value;
    if (!p) return "";
    return r ? (repDraft.value[repKey(p, r.cm)] || "") : (cmtDraft.value[mainBarKey.value] || "");
  },
  set(v) {
    const r = mainBarReply.value, p = mainBarPost.value;
    if (!p) return;
    if (r) repDraft.value = { ...repDraft.value, [repKey(p, r.cm)]: v };
    else cmtDraft.value = { ...cmtDraft.value, [mainBarKey.value]: v };
  },
});
/* 占位文案：主评论 = comment.placeholder；回复 = 「回复 xxx…」（与内联框同源 repPlaceholder） */
const mainBarPh = computed(() => {
  const r = mainBarReply.value, p = mainBarPost.value;
  return r && p ? repPlaceholder(p, r.cm, r.rp) : t("comment.placeholder");
});
/* 输入条开着 = tabbar 收起（贴键盘，图2）+ 点页面空白处即收起（用户反馈）。
 * 组件卸载必须复位/摘监听，否则 tabbar 在别的页消失、document 挂着死监听 */
/* 轮 184（真机 CDP 实测）：点表情按钮会把整条评论条从 DOM 里摘掉。
 * 「面板开着就不关条」这道保险**在同一击里查不到面板**——表情按钮的 @click 把 open 置 true，
 * 面板由 Vue 在微任务里渲染，而 mainBarDocClose 是 document 上的 click 监听，冒泡到底时
 * DOM 还没更新，`querySelector(".emo-panel")` 仍是 null → 直接 closeMainBar()，
 * 用户看到的就是「点表情 → 输入框消失」。面板还在 <teleport to="body"> 里，本就不在条内，
 * contains() 拦不住。修法：改查**静态标记** isEmojiHit()，不查面板在不在 DOM。 */
function mainBarDocClose(e) {
  const tgt = e.target;
  if (mainBarEl.value && mainBarEl.value.contains(tgt)) return;   /* 条内（输入框/发送键）不关 */
  /* 占位条与回复触发点（评论正文/回复钮）不关——它们自己管开条/切换/收起；
   * 否则点「回复」先开条、同一击冒泡到 document 又把它关掉（真机实测条闪没） */
  if (tgt && tgt.closest && tgt.closest(".cmt-entry, .bar-reply-tap")) return;
  closeMainBar();
}
watch(mainBarKey, (v) => {
  tabbarSuppressed.value = !!v;
  if (typeof document === "undefined") return;
  if (v) document.addEventListener("click", mainBarDocClose);
  else document.removeEventListener("click", mainBarDocClose);
});
/* 轮 218：保活期摘掉全局监听与 RO（别的页面滚动不触发墙的窗口重算/续载） */
/* 轮 231：首次激活要跳过静默新鲜化（onMounted 已经拉过一轮，不该重复发请求） */
let activatedOnce = false;
onActivated(() => {
  if (typeof ResizeObserver !== "undefined" && !cardRO) cardRO = new ResizeObserver(scheduleFeedTick);
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onViewport);
  window.addEventListener("wheel", onUserMove, { passive: true });
  window.addEventListener("touchmove", onUserMove, { passive: true });
  window.addEventListener("keydown", onUserMove);
  const y0 = restoreScroll(route.path);   /* 轮 219：回位（隐藏期内完成，用户看不到） */
  document.documentElement.setAttribute("data-cv-act", "act@" + Math.round(performance.now() % 1e6) + " y0=" + y0 + " saved=" + wallScrollTop);   /* 轮 220 侦讯 */
  /* 轮 223：手机端墙**自己滚**（wallScrollerEl 是 fixed + overflowY:auto），window.scrollY
   * 恒为 0 —— 只调 restoreScroll 等于什么都没做，必须把容器 scrollTop 显式钉回去。
   * 同步先钉一记（KeepAlive 复用 DOM，ref 仍有效，此刻钉最稳、零闪），下一帧再补一次
   * （防字体/图片把上方内容顶开），揭示前最后一钉见下。 */
  const pin = () => { if (wallScrollerEl.value) wallScrollerEl.value.scrollTop = wallScrollTop; };
  /* 轮 233 · 秒开：位置一旦落定就**立即**揭示，不再无条件等 250ms。
     真机实测（点回暖心墙）：墙面要 397ms 才可见，可从第一帧（118ms）起 scrollTop 就已经
     等于目标值 1500 —— 也就是说那 250ms 是**纯白等的隐藏期**（轮 222 的保守设计，当时
     同步 pin 还不可靠）。现在同步 pin 能到位，所以：钉一记 → 读回确认 → 到位就亮。
     读回是必要的（不是多此一举）：若容器高度还没算好，scrollTop 会被浏览器夹到更小值，
     这时 pinnedOk() 为假，就退到 nextTick/250ms 兜底，绝不会亮出错误位置。 */
  const pinnedOk = () => {
    const el = wallScrollerEl.value;
    return !!el && Math.abs(el.scrollTop - wallScrollTop) <= 2;
  };
  pin();
  if (pinnedOk()) {
    feedRestoring.value = false;   /* 第一个可绘制帧就在原位置 —— 这就是秒开 */
    scheduleFeedTick();
  } else {
    nextTick(() => {
      pin();
      if (pinnedOk()) { feedRestoring.value = false; scheduleFeedTick(); }
    });
  }
  /* 兜底：极端布局下万一一直钉不到位，250ms 后也必须揭示（保留原超时语义，防永久藏住） */
  setTimeout(() => {
    pin();                            /* 揭示前最后一钉：确保揭示的那一帧已在原位置 */
    feedRestoring.value = false; scheduleFeedTick();
    document.documentElement.setAttribute("data-cv-late", "late@" + Math.round(performance.now() % 1e6) + " y=" + Math.round(window.scrollY) + " pane=" + (wallScrollerEl.value ? Math.round(wallScrollerEl.value.scrollTop) : -1));
  }, 250);
  /* 轮 231：回到暖心墙时静默新鲜化 —— 用户反馈「点暖心墙，那个应该是刷新啊，现在怎么没反应」。
     首次激活跳过（onMounted 已拉过一轮）；等揭示（250ms）之后 300ms 再发，别和回位抢主线程；
     软合并只在顶部并入没见过的新帖，**不动顺序、不动滚动位置**，与位置保持不冲突。 */
  if (cloud.ready && activatedOnce) {
    setTimeout(() => { loadCloud({ quiet: true }); }, 300);
  }
  activatedOnce = true;
});
onDeactivated(() => {
  /* 轮 222：离开即置恢复态——回来时墙先隐藏，滚到位再揭示（零下滑动作） */
  feedRestoring.value = true;
  /* 轮 224 真机实锤：**不能**在这里读 scrollTop —— KeepAlive 的 deactivate 是
     「先把 DOM 移进 display:none 的隐藏容器，**再**回调 onDeactivated」，此刻 scrollTop
     已被浏览器归零。取证（CDP 实测，非推断）：滚到 1400 → 本钩子确实被调用（时间戳前进）
     但读到 0 → data-cv-dea 恒为 saved=0 → 回来永远落在页顶。
     位置改由 onScroll 滚动期实时记账 + onBeforeRouteLeave 抓取（见下）。
     这里只留兜底：只信「仍在文档里」的值，绝不用归零值覆盖真位置。 */
  const el = wallScrollerEl.value;
  if (el && document.contains(el)) wallScrollTop = el.scrollTop;
  document.documentElement.setAttribute("data-cv-dea", "saved=" + Math.round(wallScrollTop) + " @" + Math.round(performance.now() % 1e6));   /* 轮 220/224 侦讯 */
  if (cardRO) { cardRO.disconnect(); cardRO = null; }
  window.removeEventListener("scroll", onScroll);
  window.removeEventListener("resize", onViewport);
  window.removeEventListener("wheel", onUserMove);
  window.removeEventListener("touchmove", onUserMove);
  window.removeEventListener("keydown", onUserMove);
});
/* 轮 224：离开路由**前**抓位置 —— 这是唯一「DOM 还活着」的时机。
 * vue-router 的组件内守卫在导航确认前调用，此时组件仍在文档里，scrollTop 取到的是真值。
 * 与 onScroll 的实时记账互为兜底：任一道失效，另一道还兜得住。 */
onBeforeRouteLeave(() => {
  const el = wallScrollerEl.value;
  if (el && document.contains(el)) {
    wallScrollTop = el.scrollTop;
    document.documentElement.setAttribute("data-cv-dea", "leave=" + Math.round(wallScrollTop) + " @" + Math.round(performance.now() % 1e6));
  }
});
onUnmounted(() => {
  tabbarSuppressed.value = false;
  if (typeof document !== "undefined") document.removeEventListener("click", mainBarDocClose);
});
function focusMainBar() {
  return nextTick().then(() => { try { mainBarInput.value?.focus(); } catch (e) { /* 无焦点环境忽略 */ } });
}
async function openMainBar(p) {
  if (p.cloud && !signedIn.value) {
    if (!isOpen(p)) toggleCmt(p);
    return;
  }
  /* 再点同一条的占位条 = 收起（仅主评论模式；回复模式下点占位条 = 切回主评论） */
  if (mainBarKey.value === cmtKey(p) && !mainBarReply.value) { closeMainBar(); return; }
  mainBarKey.value = cmtKey(p);
  mainBarPost.value = p;
  mainBarReply.value = null;
  await focusMainBar();
}
/* 轮 108 续3：回复统一入口——手机端 = 底部条回复模式；桌面 = 原内联框原路；
 * 云端帖未登录 = 原拦截提示（两平台一致）。再点同目标的「回复」= 收起底部条 */
function replyViaBar(p, cm, rp = null, e = null) {
  if (e) e.stopPropagation();   /* 不让同一击冒泡去触发「点空白收起」/整层评论接管 */
  if (!isMobileNav.value || (p.cloud && !signedIn.value)) {
    if (rp) openReplyTo(p, cm, rp); else openReply(p, cm);
    return;
  }
  const r0 = mainBarReply.value;
  if (mainBarKey.value === cmtKey(p) && r0 && r0.cm.id === cm.id
    && (r0.rp ? r0.rp.id : null) === (rp ? rp.id : null)) {
    closeMainBar();
    return;
  }
  mainBarKey.value = cmtKey(p);
  mainBarPost.value = p;
  mainBarReply.value = { cm, rp: rp || null };
  atName.value = { ...atName.value, [cmtKey(p)]: rp ? (rp.name || "") : "" };
  if (rp) openRep.value = { ...openRep.value, [repOpenKey(p, cm)]: true };
  focusMainBar();
}
/* 轮 108 续3（用户：不只是回复钮——整条评论点哪儿都要弹输入框）：
 * 一级/二级评论整层接管点击（stopPropagation 免得同一击冒泡到 document 的点空白收起）。
 * 内部交互件（按钮/链接/…菜单/展开钮/输入框/作者名）不当作「点评论」；
 * 桌面不接管整层——只有正文点击保持原「就地回复框」行为，其余区域不响应（网页端不改）。 */
function cmtItemTap(p, cm, e, rp = null) {
  if (e) e.stopPropagation();
  const tg = e && e.target;
  if (!isMobileNav.value) {
    if (tg && tg.closest && tg.closest(".cmt-text")) {
      if (rp) openReplyTo(p, cm, rp); else openReply(p, cm);
    }
    return;
  }
  if (tg && tg.closest && tg.closest("button, a, .more-pop, .replies-toggle, .cmt-input, .clickable")) return;
  replyViaBar(p, cm, rp);
}
async function sendMainBar() {
  const p = mainBarPost.value;
  if (!p) return;
  const r = mainBarReply.value;
  await (r ? sendCmt(p, r.cm) : sendCmt(p));
  if (!isOpen(p)) toggleCmt(p);   /* 成败都展开评论区：成功看到新评论，失败看到 cmtErr 提示 */
  /* 草稿被清空 = 发送成功 → 收起输入条；失败时草稿留着（sendCmt 语义），输入条不收 */
  const k = r ? repKey(p, r.cm) : cmtKey(p);
  if (!String((r ? repDraft.value : cmtDraft.value)[k] || "").trim()) closeMainBar();
}
/* 轮 109：网页端顶部输入框的发送——沿用 sendCmt 全套逻辑（含失败提示/草稿保留），
 * 发完把评论区展开：成功看到新评论、失败看到 cmtErr（App 端 sendMainBar 同款处理）。
 * 空草稿不发也不展开（免得误触发送键把评论区扒开）。 */
async function sendTopCmt(p) {
  if (!normalizeText(cmtDraft.value[cmtKey(p)])) return;
  await sendCmt(p);
  if (!isOpen(p)) toggleCmt(p);
}

/* 轮 91：输入框移到评论区最前且手机端常驻显示——「写评论」解锁态（cmtCompose/openComposer）退役 */
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

/* 动态流：云端就绪且拉到帖子 → 真实帖子；否则回退本机帖子（不再凭空消失）。
   轮 146：示例帖已下线（原 SAMPLES 常量），动态流只由真实帖组成。 */
const all = computed(() => [
  ...(cloud.ready && cloudPosts.value.length ? cloudPosts.value : posts.value),
]);
/* 展示用：推荐 = 最近 7 天按天随机（默认）；其余 = 按时间范围筛 + 排序 */
const shown = computed(() => {
  /* 轮 252：搜索激活 → 直接展示搜索结果（正常流的游标/缓存不动，清空搜索即原样回来） */
  if (searchActive.value) return searchRows.value;
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
/* 轮 231：滚到底一次亮多少条。原来就是 PAGE_SIZE(10)，可服务端一次就拉 FEED_PAGE(50) 条 ——
   「亮 10 拉 50」的错配让用户要连滚 5 次才能把新到的一页翻完，手感就是「一顿一顿、拉不动」。
   改成 3 屏（30 条）：一次滚完大半页，DOM 增量也还在可控范围（退役后一张卡 ≈ 300px）。 */
const REVEAL_STEP = 30;
const reveal = ref(PAGE_SIZE);
watch([sortMode, rangeMode], () => { reveal.value = PAGE_SIZE; });
const shownPage = computed(() => shown.value.slice(0, reveal.value));
const hasMore = computed(() => shown.value.length > reveal.value);
const sentEl = ref(null);

/* ══════════ 轮 82 · B1 档：动态流虚拟窗口（只挂视口附近的卡片）══════════
 * 真因：A 档（轮 81）让屏外卡片不参与 style/layout/paint，但「节点数」仍是 O(列表长度)——
 *   滚到 300 条 = 300 张卡 + 上千个 naive 组件实例常驻，数据一变还要全量 diff vnode 树。
 * 做法：把「已亮出条数」和「真正挂进 DOM 的条数」拆开——只挂视口上下各 DEFAULT_OVERSCAN 条，
 *   其余用等高占位块撑住滚动高度。窗口与高度表全是纯函数（utils/feedWindow.js，有 Node 单测）。
 * 三个关键点：
 *   ① 高度优先实测：窗口只朝用户看过的方向扩张，被回收的卡片都量过 → 占位块 = 真实像素和，
 *      页面总高与「还在挂着的卡片的位置」都不变 → 向上回滚不会撞空档，也不必补偿滚动；
 *      只有深链跳转才吃估高，那时按「锚点卡片位移」补偿一次，画面不跳。
 *   ② 短列表不启用（≤ WINDOW_ON_THRESHOLD 条时窗口 = 全部）→ 老路径逐字节不变，可作回退阀。
 *   ③ 触底续载改由 nearEnd 算（视口底接近数据末尾）——一旦有了底部占位块，
 *      原来的哨兵会被推到几万像素外，永远不触发；sentEl 保留作底部锚点与既有测试的选择器。
 */
const POST_GAP = 18;                 /* 卡片间距 = .card 的 margin-bottom（漏算会几百条后串位） */
/* 卡片还没渲染时的 DOM 高度 = .post-card 的 contain-intrinsic-size（已 box-sizing:border-box），
   表格估高必须与它一模一样 —— 差 20px × 窗口尾部十几张就是一截可见空档（真机取证量到过 138px）。
   所以不在这里另写一个数，直接复用 feedWindow 的 DEFAULT_EST：CSS ↔ 常量 ↔ 估高只有一条链
   （feed-window-test 的 T17 与 feed-perf-test 的 T23 把这三者锁成相等）。 */
const FEED_EST = DEFAULT_EST;
const winStart = ref(0);
const winEnd = ref(PAGE_SIZE + 2);   /* 首屏先挂一小把，onMounted 立刻按真实视口算准 */
const padTop = ref(0);    /* 轮 223：虚拟窗口退役，占位块恒 0（保留 ref 兼容模板/锚点） */
const padBottom = ref(0);
const padTopEl = ref(null);
const cardEls = new Map();           /* id → 卡片元素（量高 / 锚点补偿用） */
const seenCards = new Set();         /* 至少在视口里露过面的卡片 id（只有它们的屏外高度可信） */
const heights = {};                  /* id → 实测高度 px（键用 idOf 归一） */
/* 轮 223：虚拟窗口退役——几十条帖子的规模下纯自残（pads 重算把滚动钳回 0，
 * 位置保持全废，用户实测「切页签回页顶」）。全量真实渲染：位置由真实 DOM 天然保持。
 * 真到几百条再上虚拟列表时，必须连滚动容器一起换（window → 内部容器）。 */
const pageItems = computed(() => shownPage.value);

let feedRaf = 0;
let cardRO = null;
let pinnedIdx = -1;                  /* 深链钉住的条号；用户自己滚一下就解除 */
let userMoved = false;
let lastScrollAt = 0;                /* 最近一次滚动事件时刻：正在滚动时别去插一脚 */
let prevAnchor = "";                 /* <html> 上 overflow-anchor 的原值（程序式跳转期间借走、跳完还回去） */

/* —— 浏览器自带「滚动锚定」的临时借用（轮 82 真机取证） ——
   两件事互相冲突，必须分时段：
   ① **用户自己滚**时，视口上方的占位块会长高（估高 → 实测），这时全靠浏览器锚定把画面钉住；
      永久关掉它就是「越滚越跳」（取证 L8：收缩位移在滚动中被漏掉）。
   ② **程序式跳转**（深链定位 / 回顶部）时，锚定会跟我们对拉：取证里 `window.scrollTo(0,0)`
      被它拽回 39k，平滑动画也被它搅坏（L7）。
   所以只在跳转那一小段关掉，跳完（含自查补齐）立刻还回原值。 */
function holdAnchor() {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (root.style.overflowAnchor !== "none") prevAnchor = root.style.overflowAnchor;
  root.style.overflowAnchor = "none";
}
function releaseAnchor() {
  if (typeof document === "undefined") return;
  document.documentElement.style.overflowAnchor = prevAnchor;
}

const cardRefs = new Map();          /* id → 稳定的 ref 回调：模板里 :ref 用它，避免每次渲染换函数
                                        导致 Vue 对同一元素反复「卸载再挂载」回调（顺带反复 unobserve） */
function bindCard(p) {
  const k = idOf(p);
  let fn = cardRefs.get(k);
  if (!fn) {
    if (cardRefs.size > 600) cardRefs.clear();   /* 长列表滚久了别让闭包无界堆积 */
    fn = (el) => setCardEl(p, el);
    cardRefs.set(k, fn);
  }
  return fn;
}

function setCardEl(p, el) {
  const k = idOf(p);
  const old = cardEls.get(k);
  if (!el) {
    if (old && cardRO) cardRO.unobserve(old);
    cardEls.delete(k);
    return;
  }
  cardEls.set(k, el);
  if (cardRO) cardRO.observe(el);
}

/** 卡片间距：从真实卡片上读（随断点/主题会变 —— 真机取证：420px 宽是 12px，桌面是 18px，
 *  写死任一个，几百条之后就是上千像素的累计串位）；读不到再退回常量。
 *  读到的值缓存住（每帧都 getComputedStyle 会强制样式重算），窗口尺寸一变就失效重读。 */
let gapCache = 0;
function feedGap() {
  if (gapCache > 0) return gapCache;
  for (const [, el] of cardEls) {
    try {
      const mb = parseFloat(getComputedStyle(el).marginBottom);
      if (Number.isFinite(mb) && mb > 0) { gapCache = mb; return mb; }
    } catch { break; }        /* 老引擎 / 无头测试环境读不到 → 用兜底 */
  }
  return POST_GAP;            /* 不缓存：等卡片真的挂上来再读一次 */
}

/** 列表内容顶到视口顶的距离（负值 = 已滚过列表顶部多少像素） */
function listScrollTop() {
  const el = padTopEl.value;
  if (!el || typeof el.getBoundingClientRect !== "function") return 0;
  return -el.getBoundingClientRect().top;
}

/** 量卡片的真实高度：只信「确实渲染过」的。
 *  content-visibility:auto 下，没渲染过的卡片（屏外且从没露过面）量到的只是
 *  contain-intrinsic-size 的占位值 —— 拿它当实测没意义（估高已经等于这个值），
 *  而一旦卡片露过面，它的屏外高度就是可信的（浏览器会记住上次渲染的真实尺寸）。
 *  所以：进过视口 ±120px 的卡片，之后无论滚到哪都照量。 */
function measureCards(vh) {
  for (const [k, el] of cardEls) {
    if (!el || typeof el.getBoundingClientRect !== "function") continue;
    const r = el.getBoundingClientRect();
    const inBand = r.bottom > -120 && r.top < vh + 120;
    if (inBand) seenCards.add(k);
    if (!inBand && !seenCards.has(k)) continue;
    const h = Math.round(r.height);
    if (h > 0 && Math.abs((heights[k] || 0) - h) > 0.5) heights[k] = h;
  }
}

/** 算出并应用窗口（轮 223 退役版：pads 恒 0；pin 参数保留仅为兼容深链调用点） */
function syncFeedWindow(pin = -1) {
  /* 全量真实渲染：窗口 = 全部已亮条目，占位块高度恒 0（滚动位置由真实 DOM 天然保持）。
     ⚠ 触底判定不在这里算 —— 见下面的 scrollerNearEnd()（它直接读真实滚动容器）。
     窗口重算曾把 pads 改来改去，而 pads 一变浏览器就把 scrollTop 钳回 0 —— 这正是
     「切页签/返回后回到页顶」的老根因，退役就是为了根治它。 */
  winStart.value = 0;
  winEnd.value = shownPage.value.length;
  padTop.value = 0;
  padBottom.value = 0;
  return { offsets: null, total: 0 };
}

/** 触底判定（轮 223）：虚拟窗口退役后不再靠占位块高度推算，直接读**真实滚动容器**。
 *  手机端墙自滚（wallScrollerEl = fixed + overflowY:auto，window 一动不动）；
 *  桌面端墙随整页滚（window）。两端都要能续载，所以两条都判。 */
function scrollerNearEnd() {
  const el = wallScrollerEl.value;
  if (el && el.scrollHeight > el.clientHeight + 1) {
    return el.scrollTop + el.clientHeight >= el.scrollHeight - NEAR_END_PX;
  }
  const doc = document.documentElement;
  const y = window.scrollY || doc.scrollTop || 0;
  const vh = window.innerHeight || doc.clientHeight || 0;
  return y + vh >= (doc.scrollHeight || 0) - NEAR_END_PX;
}

/** 用户自己动了（滚轮/触摸/按键）→ 深链钉住解除（程序滚动不会触发这些事件） */
function onUserMove() { userMoved = true; }

/** 每帧任务（轮 223 退役版）：窗口重算只剩归一化，真正要做的只有触底续载。
 *  ⚠ feedTick / onUserMove 这两个函数是**必需**的：onMounted / onActivated /
 *  onDeactivated / onUnmounted 都直接引用它们。定义一旦缺失，rAF 求值处就抛
 *  ReferenceError 把整段钩子打断——onActivated 里的回位代码根本没机会执行
 *  （用户实测「从帖子详情返回暖心墙不保持原样」、页签回来落在页顶）。
 *  删它们之前必须先把引用一并删干净。 */
function feedTick() {
  feedRaf = 0;
  if (userMoved) { userMoved = false; pinnedIdx = -1; }
  syncFeedWindow(pinnedIdx);
  if (!scrollerNearEnd()) return;
  /* 轮 231：把「先亮完、再拉下一页」的串行改成并行 ——
     ① 亮：一次补 REVEAL_STEP(30) 条，不再一次只挤 10 条；
     ② 拉：只要已亮的快到「已拉取」的尾部（余量不足半屏），就**提前**向服务器要下一页（预加载）。
     串行版本里，用户每次滚到底都得先把剩下的 10 条熬完，才等到一次网络往返 —— 卡顿感就来自这里。 */
  if (hasMore.value) reveal.value = Math.min(shown.value.length, reveal.value + REVEAL_STEP);
  const notShown = shown.value.length - reveal.value;
  if (!cloudDone.value && notShown < REVEAL_STEP / 2) loadMoreCloud();
}

function scheduleFeedTick() {
  if (feedRaf) return;
  feedRaf = requestAnimationFrame(feedTick);
}

/* 滚动事件单独一支：除了排窗口重算，还要**记下时刻**——锚点补偿靠它判定
   「用户正在滚（平滑动画 / 手势）」并让位（轮 82 前这个时间戳从没被写过，
   于是那条「还在滚别动手」的守卫永远为假 = 形同虚设，补偿有概率掐断平滑滚动）。 */
function onScroll(e) {
  lastScrollAt = performance.now();
  /* 轮 224：滚的正是墙的容器时，顺手把位置记下来。
     必须**在滚动期记账** —— 离开时（onDeactivated）DOM 已被 KeepAlive 移进
     display:none 的隐藏容器，scrollTop 被浏览器归零，那时读什么都晚了。 */
  const el = wallScrollerEl.value;
  if (el && e && e.target === el) wallScrollTop = el.scrollTop;
  scheduleFeedTick();
}

/* 窗口尺寸/断点变化 → 卡片间距、可见范围都得重读（并清掉间距缓存） */
function onViewport() {
  gapCache = 0;
  scheduleFeedTick();
}

watch([shownPage, cloudDone], scheduleFeedTick);     /* 数据一变（续亮/续页/排序）重算窗口与触底 */

onMounted(() => {
  if (typeof ResizeObserver !== "undefined") cardRO = new ResizeObserver(scheduleFeedTick);
  /* 注意：这里**不**关浏览器的滚动锚定 —— 用户自己滚的时候，视口上方占位块会长高
     （估高 → 实测），全靠它把画面钉住。锚定只在程序式跳转那一小段借走（holdAnchor），
     见 centerOn 与上面的说明。 */
  scheduleFeedTick();
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onViewport);
  window.addEventListener("wheel", onUserMove, { passive: true });
  window.addEventListener("touchmove", onUserMove, { passive: true });
  window.addEventListener("keydown", onUserMove);
});
/* 轮 95：恢复离场存档 —— 整份列表/高度表/已亮条数/游标原样回来，
 * 然后 holdAnchor 包住程序式滚动到原位置（占位块用恢复的高度表，零漂移）。
 * restoreTick 在恢复的两个 tick 里拦下自动重拉，避免存档列表被第一页覆盖。
 * 轮 96 修真崩溃：restoreTick 之前漏声明 —— ESM 严格模式赋值未声明标识符直接
 * ReferenceError（踩坑 #33 同类），返回暖心墙必崩进「这里有点小状况」。 */
let restoreTick = false;
function restoreFeed() {
  const s = savedFeedPos;
  if (!s || !Array.isArray(s.rows) || !s.rows.length) { savedFeedPos = null; return; }
  feedRestoring.value = true;   /* 轮 217：恢复期藏墙，落位后揭示（零下滑） */
  Object.assign(heights, s.heights);
  cloudPosts.value = s.rows;
  cloudCmtTotal.value = s.cmtTotal || {};   /* 轮 127：评论数一并恢复（缺失=老存档，回落空表） */
  feedCursor.value = s.cursor;
  cloudDone.value = s.done;
  newestSeenTs.value = Math.max(newestSeenTs.value, s.newestTs || 0);
  reveal.value = s.reveal;
  restoreTick = true;
  nextTick(() => {
    holdAnchor();
    window.scrollTo(0, s.y);                     /* 桌面端：整页滚动的回位 */
    /* 轮 223：手机端位置在容器上（window.scrollY 恒 0）——存档里的 pane 才是真位置 */
    if (s.pane && wallScrollerEl.value) wallScrollerEl.value.scrollTop = s.pane;
    nextTick(() => {
      if (s.pane && wallScrollerEl.value) wallScrollerEl.value.scrollTop = s.pane;   /* 布局落定后再钉一次 */
      releaseAnchor();
      restoreTick = false;
      savedFeedPos = null;
      feedRestoring.value = false;   /* 轮 217：已钉在原位置，揭示 */
      try { removeItem(FEED_ARCHIVE_KEY); } catch (e) { /* 忽略 */ }
      scheduleFeedTick();
    });
  });
}

onUnmounted(() => {
  /* 轮 95：离场存位（含实测高度表），返回时整份恢复 */
  if (cloudPosts.value.length) {
    savedFeedPos = {
      y: window.scrollY,                                                /* 桌面端：整页滚动的位置 */
      pane: wallScrollerEl.value ? wallScrollerEl.value.scrollTop : 0,   /* 轮 223：手机端墙自滚，位置在容器上 */
      reveal: reveal.value,
      cursor: feedCursor.value,
      done: cloudDone.value,
      newestTs: newestSeenTs.value,
      rows: cloudPosts.value,
      heights: { ...heights },
      cmtTotal: { ...cloudCmtTotal.value },   /* 轮 127：评论数跟帖子一起存（否则返回全变 0，用户实测） */
    };
    /* 轮 215：落盘——App 重启/页面刷新后也能回到原位置（体积超 1.5MB 放弃，防撑爆 localStorage） */
    try {
      const blob = JSON.stringify(savedFeedPos);
      if (blob.length < 1500000) setItem(FEED_ARCHIVE_KEY, blob);
    } catch (e) { /* 忽略 */ }
  }
  if (feedRaf) cancelAnimationFrame(feedRaf);
  if (cardRO) cardRO.disconnect();
  releaseAnchor();                   /* 中途离场（跳转动画还没跑完）也要把锚定还回去 */
  cardEls.clear();
  cardRefs.clear();
  seenCards.clear();
  gapCache = 0;
  window.removeEventListener("scroll", onScroll);
  window.removeEventListener("resize", onViewport);
  window.removeEventListener("wheel", onUserMove);
  window.removeEventListener("touchmove", onUserMove);
  window.removeEventListener("keydown", onUserMove);
});

/* 头像/昵称 → TA 的墙上的主页（/u/:id）；示例帖与本地帖没有云身份，不响应点击 */
const router = useRouter();
function canOpen(p) { return !!(p && p.cloud && p.userId); }
function goProfile(p) { if (canOpen(p)) router.push({ name: "waller", params: { id: p.userId } }); }

/* 轮 84：点帖子正文/图 → 帖子详情页（/post/:id）。
 * 示例帖与未上云的本地帖没有 dbId，无处可去 → 不响应（光标也不会变成手型，CSS 同口径）。 */
function goDetail(p) {
  if (!p || p.dbId == null) return;
  router.push({ name: "postDetail", params: { id: p.dbId } });
}

/* 轮 89：墙内回复超过可见数 → 跳详情页（带 cid 参数），详情页自动展开该线程的二级回复 */
function goDetailReplies(p, cm) {
  if (!p || p.dbId == null || !cm || cm.dbId == null) return;
  router.push({ name: "postDetail", params: { id: p.dbId }, query: { cid: cm.dbId } });
}

/* #25 帖子/评论时间显示到分钟。
 * 轮 81 · 动态流性能：包一层记忆化 —— 列表一屏几十条、滚动时每帧都要重算，
 * 而 fmtWhen 内部走 Date#toLocaleString（贵），同一批帖子被反复格式化是纯浪费。
 * 显示结果与直接调用 fmtWhen 完全一致（见 tools/feed-perf-test.mjs）。 */
const whenFmt = memoWhen((ts, locale) => fmtWhen(ts, locale));
const when = (ts) => whenFmt(ts, i18n.locale);

/* —— 深链到某帖：/community?post=<dbId>（分享/直达定位用）——
 * 轮 241：通知中心的评论/回应/点赞点击已改跳 /post/:id 详情页，不再进本深链；
 * 本逻辑保留（外链 /community?post= 仍要能定位到那条帖）。
 * 云端帖的 dbId 才是数据库里的真实 id；还没加载出来（或不是本页可见帖）就什么都不做。 */
const route = useRoute();
const focusId = ref(String(route.query.post || ""));
const focusDone = ref("");   /* 已定位成功的帖：后续续页/数据到达不再把用户拽回来（原来每续一页拽一次） */

function findPostEl(id) {
  if (typeof document === "undefined" || !id) return null;
  return document.getElementById(`post-${id}`);
}

async function focusPost(id) {
  const key = String(id || "");
  focusId.value = key;
  if (!key || focusDone.value === key) return;
  /* 轮 82：目标可能还没「亮」出来（默认只亮 10 条）→ 先把 reveal 撑到它那一条 */
  const idx = shown.value.findIndex((p) => String(p.dbId) === key);
  if (idx >= 0 && idx >= reveal.value) reveal.value = revealTarget(idx, PAGE_SIZE);
  await nextTick();
  let el = findPostEl(key);
  /* 还在窗口外（虚拟窗口只挂视口附近十几条）→ 把窗口钉到目标条上，
     否则 DOM 里根本没有这个元素，scrollIntoView 无处可去 */
  if (!el && idx >= 0) {
    pinnedIdx = idx;
    syncFeedWindow(idx);
    await nextTick();
    el = findPostEl(key);
  }
  if (!el) return;
  focusDone.value = key;
  /* 轮 82 真机取证（feed-window-live）：`await nextTick()` 只保证 DOM 挂上，**布局还没落地**
     ——窗口重算是走 rAF 的，这一刻读到的 rect 还是旧 padTop 下的位置，直接
     `scrollIntoView({behavior:"smooth"})` 等于用旧坐标算出错误终点：真机量到动画结束后
     目标停在视口上方 690px（用户视角：点「评论」跳过去，什么都没看到）。 */
  centerOn(el);
}

/** 把一张卡滚到视口中间：等布局生效 → 按真实 rect 自己算偏移 → 滚完自查补齐。
 *  不自查的话，平滑滚动途中窗口又量到新高度（目标文档位置跟着变），落点会偏一截；
 *  兜底这次用即时定位（跳转本来就发生在「用户点通知」这种明确跳跃场景）。 */
function centerOn(el) {
  holdAnchor();                       /* 跳转期间别让浏览器锚定跟我们抢滚动条 */
  const t0 = performance.now();
  let tries = 0;                      /* 已「重新对准」几次（上限防御，跳转不该无限重试） */
  let stable = 0;                     /* 连续几帧「停住了 + 目标在视口里」 */
  let lastY = NaN;
  let first = true;
  /* 真机取证（轮 82 L7）：原来那版是「平滑滚 + 700ms 后自查一次」，靠不住 ——
     这个距离上平滑动画 700ms 还没跑完（trail：250ms→6.5k、500ms→38k、750ms→57k），
     自查那一刻目标还在半路，算出来的修正量≈0，于是**动画自己的落点**说了算；
     而那个落点是用滚动前的高度表算的（上方一百多条还是估高），等它们逐条量成实测，
     目标就被顶到视口上方一整屏（实测 top=-773，vh=773）。
     改法：等**滚动真的停住**再判落点（滚动中只看不动手，免得掐断动画），
     不在视口里就再对准一次（instant），最多 20 次；连停 3 帧且目标可见才算定住。
     这样落点由「最终高度表 + 真实 rect」决定，与动画时长、是否被打断都无关。 */
  const frame = () => {
    const vh = window.innerHeight || 0;
    const box = el.getBoundingClientRect();
    const y = window.scrollY;
    const moving = y !== lastY;
    lastY = y;
    const inView = box.top >= 0 && box.bottom <= vh;
    if (first) {
      first = false;
      window.scrollTo({ top: y + box.top - Math.max(0, (vh - box.height) / 2), left: 0, behavior: "smooth" });
    } else if (moving) {
      stable = 0;                     /* 动画 / 用户还在动 → 只看不动手 */
    } else if (inView) {
      stable++;
    } else if (tries++ < 20) {
      stable = 0;
      window.scrollTo({ top: y + box.top - Math.max(0, (vh - box.height) / 2), left: 0, behavior: "instant" });
    }
    if (stable >= 3 || tries >= 20 || performance.now() - t0 > 3000) {
      releaseAnchor();                /* 落点定住了，把锚定还回去（用户接着滚要靠它） */
      return;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/* 首屏（含云端帖异步到达）与地址栏变化都要重新定位一次 */
watch(() => route.query.post, (v) => { focusDone.value = ""; focusPost(v); }, { immediate: false });
watch(cloudPosts, () => { if (focusId.value) focusPost(focusId.value); });
onMounted(() => { if (focusId.value) focusPost(focusId.value); });

</script>

<template>
  <!-- 轮 18：原生下拉刷新（顶部下拉 → 松手重拉；此前函数未绑定，用户看到「完全没做」） -->
  <div ref="wallScrollerEl" @touchstart.passive="ts" @touchmove.passive="tm" @touchend.passive="te"
    @scroll.passive="onScroll"
    :style="isMobileNav
      ? { position: 'fixed', inset: 0, overflowY: 'auto', zIndex: 1,
          /* 轮 230：底部留白按**实测 TabBar 高度**给。van-tabbar 实测高 59px，而原来只留 50px ——
         结果最底下那行提示（「就到这里啦…」）有 8px 被 TabBar 盖住（占它 19px 高度的四成），
         用户反馈「提示文字被底部折叠了一半」正是这个。70px = 59 + 缓冲，
         保证任何底部文字都完整露在 TabBar 之上。 */
      paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'calc(70px + env(safe-area-inset-bottom))',
          visibility: feedRestoring ? 'hidden' : 'visible' }
      : { visibility: feedRestoring ? 'hidden' : 'visible' }">
    <div class="wall-pull" :style="{ height: pullDist + 'px', opacity: pullDist / 62 }">↓</div>
    <!-- 头部 + 发布框（手机端收起：发布统一走底部 ＋ → 独立发布页，页顶不再占一屏）
         轮 35：去掉与 h2 重复的小标签；副标题只在桌面显示（手机端两行文案太占首屏）
         轮 47：手机端整卡隐藏——副标题/发布框都是桌面专属后，这张卡里只剩「暖心墙」
         三个字，等于一块纯文字浮窗占着首屏（用户：留在那儿干嘛）；底部 Tab 本来就叫暖心墙。 -->
    <section v-if="!isMobileNav" class="card">
      <h2 style="margin-bottom: 4px">{{ t("community.title") }}</h2>
      <p v-if="!isMobileNav" class="sub">{{ t("community.subtitle") }}</p>

      <div v-if="!isMobileNav" class="composer">
        <van-field
          v-model="draft"
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
        <div v-if="loadingCloud && !shownPage.length" class="sk-feed" aria-hidden="true">
          <div class="sk-card" v-for="n in 2" :key="n">
            <div class="sk-head"><span class="sk-circle"></span><span class="sk-line" style="width: 32%"></span></div>
            <span class="sk-line" style="width: 94%"></span>
            <span class="sk-line" style="width: 80%"></span>
            <span class="sk-line" style="width: 42%"></span>
          </div>
        </div>
        <p v-else-if="loadingCloud" class="notice">{{ t("community.loading") }}</p>
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

    <!-- 轮 60：「已刷新」提示放列表顶部（原来插在底部哨兵旁，下拉的人看不见） -->
    <transition name="t-swap" mode="out-in">
      <div v-if="refreshNote" :key="refreshNote" class="refresh-note" :class="'rn-' + refreshNote">
        <span v-if="refreshNote === 'ok'" class="rn-ic" aria-hidden="true">
          <svg class="rn-heart" viewBox="0 0 24 24">
            <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
          </svg>
        </span>
        <span v-else-if="refreshNote === 'batch'" class="rn-ic" aria-hidden="true">
          <svg class="rn-spark" viewBox="0 0 24 24">
            <path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z" />
          </svg>
        </span>
        <span v-else-if="refreshNote === 'fail'" class="rn-ic rn-warnic" aria-hidden="true">!</span>
        <span v-else class="rn-ic rn-busyic" aria-hidden="true"></span>
        <span>{{ refreshText }}</span>
      </div>
    </transition>

    <!-- 轮 252 · 搜索栏：关键词实时搜（防抖）+ 热门标签 chip（点击筛选/增删） -->
    <div class="wall-search">
      <div class="wall-search-row">
        <input v-model="searchQ" class="wall-search-input" type="search"
          :placeholder="t('community.searchPh')" :aria-label="t('community.searchPh')" />
        <button v-if="searchQ || searchTags.length" class="sort-btn" @click="clearSearch">✕</button>
      </div>
      <div v-if="hotTags.length" class="wall-tag-row">
        <button v-for="tg in hotTags" :key="tg" class="tag-chip"
          :class="{ on: searchTags.includes(tg) }"
          @click="toggleSearchTag(tg)">#{{ tg }}#</button>
      </div>
      <p v-if="searchBusy" class="notice">{{ t("community.searching") }}</p>
      <p v-else-if="searchTouched && searchActive && !searchRows.length" class="notice">
        {{ t("community.searchEmpty") }}</p>
    </div>

    <!-- 排序：默认最新；还有 同感最多 / 抱抱最多 / 暖暖最多 -->
    <div class="sort-row">
      <span class="sort-label">{{ t("community.sortLabel") }}</span>
      <button
        v-for="s in SORT_BTNS" :key="s.key"
        class="sort-btn" :class="{ on: sortMode === s.key }"
        @click="pickSort(s.key)">
        {{ t(s.tk) }}
      </button>
      <!-- 轮 83：网页端刷新按钮（排序行右端，margin-left:auto 推过去）。
           App 壳里由 CSS 隐藏（html.cap-app .wall-refresh），App 用原生下拉刷新。 -->
      <button
        class="sort-btn wall-refresh" :class="{ spin: loadingCloud }"
        :disabled="loadingCloud"
        :title="t('community.refreshBtn')" :aria-label="t('community.refreshBtn')"
        @click="manualRefresh">↻</button>
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

    <!-- 轮 252：手机端首屏骨架（桌面端在 composer 卡内已有；这里 isMobileNav 专属，不重复） -->
    <div v-if="isMobileNav && loadingCloud && !shownPage.length" class="sk-feed" aria-hidden="true">
      <div class="sk-card" v-for="n in 3" :key="n">
        <div class="sk-head"><span class="sk-circle"></span><span class="sk-line" style="width: 32%"></span></div>
        <span class="sk-line" style="width: 94%"></span>
        <span class="sk-line" style="width: 80%"></span>
        <span class="sk-block"></span>
      </div>
    </div>

    <!-- 轮 82 · B1 档：虚拟窗口占位块（高度由脚本按实测高度表写行内 style，撑住滚动高度） -->
    <div ref="padTopEl" class="feed-pad" :style="{ height: padTop + 'px' }" aria-hidden="true"></div>

    <!-- 动态流（默认 10 条，滑到底自动续 10 条；只挂视口附近十几条，其余用占位块撑高） -->
    <article v-for="p in pageItems" :key="p.id" :ref="bindCard(p)" class="post-card card"
      :id="p.dbId != null ? 'post-' + p.dbId : undefined"
      :class="{ 'post-focus': focusId && String(p.dbId) === focusId }">
      <div class="post-head">
        <n-avatar round :size="42" class="post-avatar"
          :class="{ clickable: canOpen(p) }"
          :title="canOpen(p) ? t('community.viewHome') : ''"
          :src="avatarUrlFor(p.userId) || undefined"
          @click="goProfile(p)"><template v-if="!avatarUrlFor(p.userId)" #default>🙂</template><template v-else #fallback>🙂</template>
        </n-avatar>
        <div class="post-meta">
          <div class="post-name"
            :class="{ clickable: canOpen(p) }"
            :title="canOpen(p) ? t('community.viewHome') : ''"
            @click="goProfile(p)">{{ p.name }}</div>
          <div class="post-time">{{ when(p.ts) }}</div>
        </div>
        <!-- 轮 146：示例帖下线，原「示例」角标（v-if="p.sample"）随之移除 -->
        <!-- 轮 84：帖子右上角 … 菜单（举报迁入 + 拷贝正文）；post-foot 里原举报按钮移除 -->
        <button class="more-btn" :title="t('comment.more')" :aria-label="t('comment.more')"
          @click.stop="togglePostMore(p)">⋯</button>
        <div v-if="moreKey === postMoreKey(p)" class="more-pop card" @click.stop>
          <button v-if="canReportPost(p)" class="more-item" @click="moreReport">{{ t("report.act") }}</button>
          <button v-if="moreTarget && moreTarget.dbId != null" class="more-item" @click="moreFav">
            {{ moreTarget.faved ? t("fav.remove") : t("fav.add") }}
          </button>
          <button class="more-item" @click="moreCopy">{{ t("common.copy") }}</button>
        </div>
      </div>

      <!-- 轮 84：点正文/图进帖子详情页（示例帖与本地帖没有 dbId，goDetail 不响应） -->
      <p class="post-text go-detail" @click="goDetail(p)">{{ i18n.locale === "zh" && p.zh ? p.zh : p.text || p.en }}</p>
      <!-- 轮 252：#xxx# 标签 chip（点击 = 按该标签搜索） -->
      <div v-if="p.tags && p.tags.length" class="post-tags">
        <button v-for="tg in p.tags" :key="tg" class="tag-chip" @click.stop="searchByTag(tg)">#{{ tg }}#</button>
      </div>
      <!-- 轮 81 · 动态流性能：图片懒加载 + 异步解码。
           原来一进页面/一续页就把这一页所有图片一起下载解码，滚动时主线程被解码尖刺打断；
           loading=lazy 只解码视口附近的图，decoding=async 让解码离开主线程。 -->
      <img v-if="p.img" :src="p.img" class="pic go-detail" loading="lazy" decoding="async" alt=""
        :style="p.imgW > 0 && p.imgH > 0 ? { aspectRatio: p.imgW + ' / ' + p.imgH } : {}"
        @click="goDetail(p)" />

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
        <!-- 轮 84：举报入口迁入帖子右上角 … 菜单，post-foot 只留浏览数与厌恶 -->
      </div>

      <!-- 轮 109：网页端主评论输入框上移到「浏览次数」与「评论按钮」之间（每条卡都常驻，
           位置与 App 端 .cmt-entry 占位条同位）。手机端不渲染 → App 端零变化（仍走占位条 + 底部输入条）。
           未登录的云端帖没有可写输入位：该框不渲染，点「N 条评论」展开后照旧见登录提示。 -->
      <div v-if="!isMobileNav && (!p.cloud || signedIn)" :id="'cmtmain-' + cmtKey(p)"
        class="cmt-input cmt-input-top">
        <div class="cmt-input-row">
          <van-field
            v-model="cmtDraft[cmtKey(p)]"
            type="textarea"
            rows="1" autosize
            :placeholder="t('comment.placeholder')"
            :maxlength="MAX_LEN" />
          <n-button type="primary" size="small" round class="cmt-send" @click="sendTopCmt(p)">
            {{ t("common.send") }}
          </n-button>
        </div>
      </div>

      <!-- 轮 108：手机端主评论入口条（卡内常驻占位，图1样式；点击弹底部输入条） -->
      <div v-if="isMobileNav" class="cmt-entry" @click="openMainBar(p)">
        {{ t("comment.placeholder") }}
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

        <!-- 轮 91：评论区首部给「未登录」提示（原本这里放输入框——可以评论的位置在最前）。
             轮 108：手机端主评论改走卡内占位条 + 底部输入条（两平台不同输入方式）。
             轮 109：桌面内联输入框整体上移到「浏览次数 ↔ 评论按钮」之间 → 这里只剩未登录提示。 -->
        <div v-if="p.cloud && !signedIn" class="cmt-input">
          <p class="cmt-empty">
            {{ t("community.commentSignIn") }}
            <router-link class="cmt-login" to="/profile">{{ t("common.signIn") }}</router-link>
          </p>
        </div>

        <!-- 一级评论（轮 108 续3：整条评论点哪儿都弹底部输入条——接管层在此，内部按钮除外） -->
        <div v-for="cm in listFor(p)" :key="cm.id" class="cmt-item" @click="cmtItemTap(p, cm, $event)">
          <div class="cmt-head">
            <b :class="{ clickable: canOpen(cm) }"
               :title="canOpen(cm) ? t('community.viewHome') : ''"
               @click="goProfile(cm)">{{ cm.name }}</b>
            <button
              v-if="canDel(cm)"
              class="cmt-del" :title="t('common.delete')"
              @click="delCmt(p, cm)">×</button>
            <!-- 轮 84：评论右上角 … 菜单（举报迁入 + 拷贝） -->
            <button class="cmt-more" :title="t('comment.more')" :aria-label="t('comment.more')"
              @click.stop="toggleCmtMore(cm)">⋯</button>
            <div v-if="moreKey === cmtMoreKey(cm)" class="more-pop card" @click.stop>
              <button v-if="canReportCmt(cm)" class="more-item" @click="moreReport">{{ t("report.act") }}</button>
              <button class="more-item" @click="moreCopy">{{ t("common.copy") }}</button>
            </div>
          </div>
          <p class="cmt-text cmt-text-open" :title="t('comment.reply')">{{ cm.text }}</p>

          <div class="cmt-acts">
            <!-- 轮 84：时间从评论头移到「回复」左侧 -->
            <span class="cmt-time">{{ when(cm.ts) }}</span>
            <button class="cmt-act bar-reply-tap" @click="replyViaBar(p, cm)">{{ t("comment.reply") }}</button>
            <!-- 轮 87：回应图标改空心灰内联 SVG（emoji 太艳丽；点亮 = 深一档灰，不再用品牌色） -->
            <button v-if="cm.dbId != null" class="cmt-react t-like" data-kind="heart" :class="{ on: cmtReacted(cm, 'heart'), 'is-bursting': reactBurst(cm, 'heart') }" :data-liked="cmtReacted(cm, 'heart')"
              :disabled="!!cmtReactBusy[cm.id]" :title="t('comment.likeT')" :aria-label="t('comment.likeT')"
              @click="cmtReact(p, cm, 'heart')"><span class="t-like-icon"><svg class="rc-ico t-like-heart" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21.35 10.55 20.03C5.4 15.36 2 12.27 2 8.5 2 5.41 4.42 3 7.5 3c1.74 0 3.59.94 4.5 2.35C12.91 3.94 14.76 3 16.5 3 19.58 3 22 5.41 22 8.5c0 3.77-3.4 6.86-8.55 11.53L12 21.35z"/></svg></span><span class="t-like-particles" aria-hidden="true"><i v-for="n in 8" :key="n"></i></span><i>{{ reactCount(cm, "heart") }}</i></button>
            <button v-if="cm.dbId != null" class="cmt-react t-like" data-kind="broken" :class="{ on: cmtReacted(cm, 'broken'), 'is-bursting': reactBurst(cm, 'broken') }" :data-liked="cmtReacted(cm, 'broken')"
              :disabled="!!cmtReactBusy[cm.id]" :title="t('comment.brokenT')" :aria-label="t('comment.brokenT')"
              @click="cmtReact(p, cm, 'broken')"><span class="t-like-icon"><svg class="rc-ico t-like-heart" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21.35 10.55 20.03C5.4 15.36 2 12.27 2 8.5 2 5.41 4.42 3 7.5 3c1.74 0 3.59.94 4.5 2.35C12.91 3.94 14.76 3 16.5 3 19.58 3 22 5.41 22 8.5c0 3.77-3.4 6.86-8.55 11.53L12 21.35z"/><path d="M12 6.8 10.4 9.4l2.4 1.5-1.5 2.4 1.1 1.8"/></svg></span><span class="t-like-particles" aria-hidden="true"><i v-for="n in 8" :key="n"></i></span><i>{{ reactCount(cm, "broken") }}</i></button>
              <!-- 轮 88：「N 条回复」按钮移到回复列表底部（见下方 replies-toggle），操作行只留时间/回复/回应 -->
          </div>

          <!-- 轮 110：一级评论的回复框紧跟这条一级评论——正文/操作行之下、二级列表之上
               （用户原话「把一级评论回复框点击后出现在一级评论下面，二级评论上面，你现在是一级评论最下面」）。
               二级评论的就地框（cmt-input-rep-in，位置不动）与手机端底部输入条都不受影响。
               云端帖未登录不给开：openReply 已拦截，这里再守一道（轮 91 口径不变）。 -->
          <div
            :id="'repbox-' + repKey(p, cm)"
            v-if="isReplyOpen(p, cm) && !isMobileNav && !(p.cloud && !signedIn)" class="cmt-input cmt-input-rep">
            <!-- 轮 97：统一输入条样式 -->
            <div class="cmt-input-row">
              <van-field
                v-model="repDraft[repKey(p, cm)]"
                type="textarea"
                rows="1" autosize
                :placeholder="repPlaceholder(p, cm)"
                :maxlength="MAX_LEN" />
              <n-button type="primary" size="small" round @click="sendCmt(p, cm)">
                {{ t("common.send") }}
              </n-button>
            </div>
          </div>

          <!-- 二级：回复列表（轮 50：默认显示前两条；>2 条点「N 条回复」展开全部） -->
          <div v-if="repliesN(p, cm)" class="cmt-reps">
            <div v-for="rp in visibleReplies(p, cm)" :key="rp.id" class="cmt-rep" @click="cmtItemTap(p, cm, $event, rp)">
              <div class="cmt-head">
                <b><span :class="{ clickable: canOpen(rp) }"
                        :title="canOpen(rp) ? t('community.viewHome') : ''"
                        @click="goProfile(rp)">{{ rp.name }}</span><span class="cmt-at" v-if="rp.replyTo">@{{ rp.replyTo }}</span></b>
                <button
                  v-if="canDel(rp)"
                  class="cmt-del" :title="t('common.delete')"
                  @click="delCmt(p, rp)">×</button>
                <!-- 轮 84：回复也有 … 菜单 -->
                <button class="cmt-more" :title="t('comment.more')" :aria-label="t('comment.more')"
                  @click.stop="toggleCmtMore(rp)">⋯</button>
                <div v-if="moreKey === cmtMoreKey(rp)" class="more-pop card" @click.stop>
                  <button v-if="canReportCmt(rp)" class="more-item" @click="moreReport">{{ t("report.act") }}</button>
                  <button class="more-item" @click="moreCopy">{{ t("common.copy") }}</button>
                </div>
              </div>
              <p class="cmt-text cmt-text-open" :title="t('comment.reply')">{{ rp.text }}</p>
                <div class="cmt-acts">
                  <!-- 轮 84：时间移到「回复」左侧 + 轮 87：回应图标改空心灰 -->
                  <span class="cmt-time">{{ when(rp.ts) }}</span>
                  <button class="cmt-act bar-reply-tap" @click="replyViaBar(p, cm, rp)">
                    {{ t("comment.reply") }}
                  </button>
                  <button v-if="rp.dbId != null" class="cmt-react t-like" data-kind="heart" :class="{ on: cmtReacted(rp, 'heart'), 'is-bursting': reactBurst(rp, 'heart') }" :data-liked="cmtReacted(rp, 'heart')"
                    :disabled="!!cmtReactBusy[rp.id]" :title="t('comment.likeT')" :aria-label="t('comment.likeT')"
                    @click="cmtReact(p, rp, 'heart')"><span class="t-like-icon"><svg class="rc-ico t-like-heart" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21.35 10.55 20.03C5.4 15.36 2 12.27 2 8.5 2 5.41 4.42 3 7.5 3c1.74 0 3.59.94 4.5 2.35C12.91 3.94 14.76 3 16.5 3 19.58 3 22 5.41 22 8.5c0 3.77-3.4 6.86-8.55 11.53L12 21.35z"/></svg></span><span class="t-like-particles" aria-hidden="true"><i v-for="n in 8" :key="n"></i></span><i>{{ reactCount(rp, "heart") }}</i></button>
                  <button v-if="rp.dbId != null" class="cmt-react t-like" data-kind="broken" :class="{ on: cmtReacted(rp, 'broken'), 'is-bursting': reactBurst(rp, 'broken') }" :data-liked="cmtReacted(rp, 'broken')"
                    :disabled="!!cmtReactBusy[rp.id]" :title="t('comment.brokenT')" :aria-label="t('comment.brokenT')"
                    @click="cmtReact(p, rp, 'broken')"><span class="t-like-icon"><svg class="rc-ico t-like-heart" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21.35 10.55 20.03C5.4 15.36 2 12.27 2 8.5 2 5.41 4.42 3 7.5 3c1.74 0 3.59.94 4.5 2.35C12.91 3.94 14.76 3 16.5 3 19.58 3 22 5.41 22 8.5c0 3.77-3.4 6.86-8.55 11.53L12 21.35z"/><path d="M12 6.8 10.4 9.4l2.4 1.5-1.5 2.4 1.1 1.8"/></svg></span><span class="t-like-particles" aria-hidden="true"><i v-for="n in 8" :key="n"></i></span><i>{{ reactCount(rp, "broken") }}</i></button>
                </div>

              <!-- 二级评论的回复框就地在它下面出现（用户反馈：以前甩到整块评论底部，像点了没反应） -->
              <div
                :id="'repbox-' + repKey(p, cm) + ':' + rp.id"
                v-if="replyRpOf(p, cm) === rp.id && !isMobileNav && !(p.cloud && !signedIn)"
                class="cmt-input cmt-input-rep-in">
                <!-- 轮 97：回复框同样统一（发送在右 + 自动扩行） -->
                <div class="cmt-input-row">
                  <van-field
                    v-model="repDraft[repKey(p, cm)]"
                    type="textarea"
                    rows="1" autosize
                    :placeholder="repPlaceholder(p, cm, rp)"
                    :maxlength="MAX_LEN" />
                  <n-button type="primary" size="small" round @click="sendCmt(p, cm)">
                    {{ t("common.send") }}
                  </n-button>
                </div>
              </div>
            </div>
          </div>

          <!-- 轮 89：墙内回复超过可见数 → 跳详情页（带 cid 参数定位展开该线程），不再就地展开 -->
          <button v-if="repliesN(p, cm) > 2" class="replies-toggle" @click="goDetailReplies(p, cm)">
            {{ t("comment.viewAllReplies", { n: repliesN(p, cm) }) }}
            <i class="rt-arrow">&#8250;</i>
          </button>

        </div>

        <!-- 轮 84：一级评论超过 3 条 → 「查看更多」进帖子详情页 -->
        <button v-if="hasMoreCmts(p)" class="cmt-act cmt-viewmore" @click="goDetail(p)">
          {{ t("community.viewMore") }} <i class="vm-arrow">&#8250;</i>
        </button>

        <p v-if="!listFor(p).length && !(cmtLoading[cmtKey(p)] && !listed(p))" class="cmt-empty">
          {{ t("comment.empty") }}
        </p>
      </div>
    </article>

    <!-- 窗口下方占位块（同样撑住滚动高度） -->
    <div class="feed-pad" :style="{ height: padBottom + 'px' }" aria-hidden="true"></div>

    <!-- 触底续载哨兵（轮 82 起：续载判断改由 feedWindow.nearEnd 计算——有占位块后哨兵
         会被推到几万像素外，永远不触发；此元素保留作底部锚点与既有测试选择器） -->
    <div ref="sentEl" class="feed-sentinel" aria-hidden="true"></div>
    <p v-if="shownPage.length && !hasMore && cloudDone" class="notice" style="text-align: center">
      {{ t("community.noMore") }}
    </p>
    <p v-if="pageBusy" class="sub" style="text-align: center">{{ t("community.loading") }}</p>

    <!-- 轮 87：…菜单改 document 点击收起（原全屏遮罩被卡片堆叠上下文盖住菜单，举报/拷贝点了没反应） -->

    <!-- 轮 108：手机端主评论底部输入条（图2样式：发送在右；贴键盘；点空白收起；一次只服务一条帖） -->
    <div v-if="isMobileNav && mainBarPost" ref="mainBarEl" class="cmt-main-bar">
      <van-field ref="mainBarInput" v-model="mainBarDraft" type="textarea"
        rows="1" autosize
        :placeholder="mainBarPh" :maxlength="MAX_LEN" />
      <n-button type="primary" size="small" round @click="sendMainBar">{{ t("common.send") }}</n-button>
    </div>

    <!-- 举报弹窗（帖子/评论共用一个实例） -->
    <ReportDialog v-model:show="reportShow" :target="reportTarget" />
  </div>
</template>

<style scoped>
/* 下拉刷新指示条（轮 18）：跟手拉伸，松手回弹 */
.wall-pull { display: flex; align-items: center; justify-content: center; overflow: hidden; color: var(--ink-soft); transition: height .15s ease; }
</style>