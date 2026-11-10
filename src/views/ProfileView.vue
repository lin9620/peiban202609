<script setup>
import { ref, computed, watch, onActivated, onMounted, onBeforeUnmount } from "vue";
import { useRouter, useRoute } from "vue-router";
import { NButton, NInput, NAvatar, NTag, NProgress } from "naive-ui";
import { t, i18n } from "../i18n.js";
import { getItem, setItem, removeItem } from "../utils/storage.js";
import { restoreScroll } from "../utils/scrollMem.js";
import { cookbook, removeDish, moodLog, moodStreak, wallet } from "../stores/petStore.js";
import MoodFace from "../components/MoodFace.vue";
import { isMobileNav, isApp, openDownload } from "../stores/uiStore.js";
import { todayKey } from "../utils/daily.js";
import {
  cloud, cloudSignOut,
  cloudUpdatePassword, cloudClearRecovery,
  cloudUpdateNickname, cloudNicknameIsAuto,
} from "../utils/supabase.js";
/* 登录规则（纯函数，Node 单测覆盖）：本地校验 / 昵称兜底 / 邮件链接解析 / 回跳地址 */
import { MIN_PASSWORD, NICK_MAX, passwordProblem } from "../utils/authRules.js";
/* 轮 44：帖子卡时间从「只有日期」改为格式化文案；轮 288：**统一到分**（fmtWhen），
 * 与暖心墙 / 详情页 / 我的帖子 / 收藏页同一口径，并把 locale 传进去。 */
import { fmtWhen } from "../utils/wallRules.js";
import { db } from "../utils/api/db.js";
import { cloudFetchUserPosts } from "../utils/wall.js";
import { cacheKey, cachePeek, cacheSet, cachePatch, swr } from "../utils/cache.js";
import { avatarUrlFor } from "../utils/avatar.js";   /* 轮 238:萌宠头像池 */
import { copyText } from "../utils/clipboard.js";    /* 轮 485：带 execCommand 兜底的复制 */
/* 轮 501：分享地址与各渠道 intent（纯函数，tools/share-page-test 覆盖） */
import { shareUrl, shareHref, SHARE_TARGETS } from "../utils/shareLinks.js";
import { setPostNav } from "../utils/postNav.js";    /* 轮 279:进详情前存列表快照,左右滑用 */
import { onPostReaction, patchPostList } from "../utils/postReactionSync.js";
/* 轮 460：帖子评论区（暖心墙卡片同款）——「我的页面」里这三张帖子卡也要能看评论 */
import PostComments from "../components/PostComments.vue";
/* 轮447：关注数（「关注 N」入口的角标）。只读 ids.length，进页面校准一次。 */
import { followingCount, refreshFollows } from "../utils/follows.js";

/* 轮 288:与 WallerView / PostDetailView 同名同口径的时间文案（到分） */
const when = (ts) => fmtWhen(ts, i18n.locale);

/* 心情图标：一律用 Unicode 转义，避免源码中的 emoji 编码损坏 */
/* 轮 155：日历表情与打卡统一——旧系统 emoji 数组退役，格子改用 MoodFace 手绘脸。
 * legacyIndex → kind 映射与 home.mood.faceOrder 同源（0=happy 1=steady 2=calm 3=low 4=tired）。 */
const MOOD_KIND = ["happy", "steady", "calm", "low", "tired"];
const PAW = "\u{1F43E}";
const HEART = "\u{1F497}";

const NICK_KEY = "wp-nickname";

const nickname = ref(getItem(NICK_KEY) || "");
const draftNick = ref("");
/* 云登录优先；否则退回本地访客昵称 */
const cloudSigned = computed(() => !!(cloud.ready && cloud.user));

/* 与暖心墙同款的三种回应（计数只读展示；点卡片回墙里互动） */
const REACTIONS = [
  { key: "hug", tk: "community.reactHug" },
  { key: "warm", tk: "community.reactWarm" },
  { key: "relate", tk: "community.reactRelate" },
];
const signedIn = computed(() => cloudSigned.value || !!nickname.value.trim());
const displayName = computed(() => (cloudSigned.value ? (cloud.nickname || nickname.value) : nickname.value));
const streak = computed(() => moodStreak());

/* 管理中心入口：仅数据库认定的管理员可见（is_admin()；失败一律当不是）。
 * 跟随登录态重新判定 —— 登录表单就在本页，组件挂载时常常还没登录 / Auth 还没就绪 */
const isAdmin = ref(false);
onActivated(() => { restoreScroll(route.path); });   /* 轮 219：页签回位 */

watch(
  () => [cloud.ready, cloud.user && cloud.user.id],
  async ([ready, uid]) => {
    if (!ready || !uid) {
      isAdmin.value = false;
      return;
    }
    try {
      isAdmin.value = (await db.amAdmin()) === true;
    } catch (e) {
      isAdmin.value = false;
    }
  },
  { immediate: true },
);

/* #9 我在暖心墙的帖子：默认只展示最新 3 条（共有 5），「更多」进 /my-posts 分页看全部。
 * 轮 58：接 SWR（快照秒开 + 后台取新 + 回写）——此前每次进页干等一次网络往返，
 * 用户报「我的帖子老是出现的很慢」；/my-posts 页早有同款（轮 36），这里补齐。
 * 键带 uid 换号不串；缓存的是 rowsToPosts 视图（img 已是 URL，可序列化）。 */
const myPosts = ref([]);
const myPostsBusy = ref(false);
/* 轮 206：挂载同步秒出——用本地持久 uid（wp-uid）直接读缓存快照，不等 cloud.ready 的启动间隙。
 * （用户实测「我的页面帖子只展示前 3 条为什么也这么慢」——慢在 ready 前的空窗。）
 * 轮 281：wp-uid 可能还没落位（首装登录态在 in-flight）→ 云端 uid 兜底；两个 uid 都
 * 拿不到才退到下面的 watch 路径。key 与 App.vue prefetchProfilePosts 同一条（profile-myposts|uid）。 */
(() => {
  try {
    const uid = getItem("wp-uid") || ((cloud.user && cloud.user.id) || "");
    if (!uid) return;
    const snap = cachePeek(cacheKey("profile-myposts", uid));
    /* 正常缓存是 rowsToPosts 数组；兼容早期 {rows:[...]} 形状，避免旧包升级后首屏空白。 */
    if (Array.isArray(snap)) myPosts.value = snap;
    else if (snap && Array.isArray(snap.rows)) myPosts.value = snap.rows;
  } catch (e) { /* 忽略 */ }
})();
/* 轮 281：加载抽成函数——watch（登录态就绪）与 onActivated（KeepAlive 切回页签）共用。
 * SWR 语义不变：缓存先渲染（cached），网络回来覆盖（fresh）并回写。 */
async function loadMyPosts() {
  const uid = (cloud.user && cloud.user.id) || "";
  if (!uid) {
    /* 轮 213：启动空窗不清缓存——挂载时同步秒出的缓存渲染要保留到 ready（用户实测 10s 空窗） */
    if (!myPosts.value.length) myPosts.value = [];
    return;
  }
  myPostsBusy.value = true;
  await swr(
    cacheKey("profile-myposts", uid),
    {
      cached: (rows) => { myPosts.value = rows; },
      fresh: (rows) => { myPosts.value = rows; },
    },
    async () => {
      /* 轮 372：回应数必须跟帖子一起回来再写缓存。
       * 旧写法先回写 0，再在后台改内存——用户会看到「我的页面 0 / 详情 2」，
       * 而且下一次进页又从缓存读到 0。这里复用暖心墙/我的帖子同一取数口径。 */
      const got = (await cloudFetchUserPosts(uid, 3)) || [];
      return got.length ? got : null;   /* 空列表/失败不覆盖快照、不回写 */
    },
  );
  myPostsBusy.value = false;
}
watch(
  () => [cloud.ready, cloud.user && cloud.user.id],
  async ([ready, uid]) => {
    if (!ready || !uid) return;   /* 轮 281：不清缓存（213 口径），只等 ready */
    await loadMyPosts();
  },
  { immediate: true },
);
/* 轮 281：KeepAlive 切回页签 = 静默新鲜化——缓存先在屏，网络回来覆盖（滚动位不动，
 * 与暖心墙轮 231 同款语义）。首次激活由上面 immediate watch 拉过，跳过防双发。 */
let myPostsActivated = false;
onActivated(() => {
  if (!myPostsActivated) { myPostsActivated = true; return; }
  loadMyPosts();
});

/* 轮 372：详情页改回应 → 仍被 KeepAlive 保活的「我的」页立刻同步。
 * 旧问题：详情显示 2，返回我的页面还是缓存里的 0，要等下一次网络刷新。
 * 同时回写 profile-myposts 缓存，切页签/重进也不会退回 0。 */
function syncProfileReaction(id, patch) {
  const uid = (cloud.user && cloud.user.id) || "";
  if (!uid) return;
  const next = patchPostList(myPosts.value, id, patch);
  if (next !== myPosts.value) myPosts.value = next;
  cachePatch(cacheKey("profile-myposts", uid), (rows) => patchPostList(rows, id, patch));
}
let stopPostReactionSync = null;
onMounted(() => { stopPostReactionSync = onPostReaction(syncProfileReaction); });
/* 轮447：进「我的」页校准一次关注数（本地快照先出，云端再校正） */
onMounted(() => { refreshFollows(); });
onBeforeUnmount(() => {
  if (stopPostReactionSync) stopPostReactionSync();
  stopPostReactionSync = null;
});

/* 进详情前把当前这篇帖写进 wall:post 缓存：详情页 0ms 先渲染正确计数，弱网不空等。 */
function openMyPost(p) {
  if (!p || p.dbId == null) return;
  setPostNav(myPosts.value);
  cacheSet(cacheKey("wall:post", p.dbId), p);
  /* 轮 460：卡片从 <router-link> 改成 <article>（卡片里要放评论输入框/按钮，
     链接里嵌交互元素在手机上会让「点输入框」变成跳详情），导航改在这里做 */
  router.push({ path: `/post/${p.dbId}` });
}

/* 轮 254：内嵌收藏逻辑（favRows/watch/unFav/showFavs）已迁往独立页 FavoritesView；
   头部按钮改为 router.push('/favorites')，缓存键 profile-favs 两页同用。 */

/* —— 登录 / 注册 / 忘记密码已独立成页（/login，手机与网页共用）——
 * 本页未登录时只放一张入口卡；老的重置邮件可能回落到 /profile，
 * 所以「重置链接落地 → 设置新密码」的收尾逻辑仍留在这里。 */
const newPass = ref("");
const passBusy = ref(false);
const passMsg = ref("");

/* 页面级提示（保存成功的提示要放在登录卡片外——那时卡片已被隐藏） */
const flash = ref("");

/* —— 改昵称（Google 首登提示 + 任何时候可改） ——
 * 昵称还是 Google 自动兜底时就一直给一个紧凑入口（提示语 + 「改一改」），
 * 点开才出现输入框；改成功（或本来就不是自动昵称）框就不出现。设置页里也常驻可改。 */
const nickEdit = ref(false);
const nickDraft = ref("");
const nickBusy = ref(false);
const nickMsg = ref("");
const nickAuto = ref(false);

function nickProblem(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return t("profile.needNick");
  if (s.length > NICK_MAX) return t("profile.nickLong", { n: NICK_MAX });
  return "";
}
function startNickEdit() {
  nickDraft.value = cloud.nickname || "";
  nickMsg.value = "";
  nickEdit.value = true;
}
function cancelNickEdit() {
  nickEdit.value = false;
  nickDraft.value = "";
  nickMsg.value = "";
}
async function saveNick() {
  if (nickBusy.value) return;
  const bad = nickProblem(nickDraft.value);
  if (bad) { nickMsg.value = bad; return; }
  nickBusy.value = true;
  nickMsg.value = "";
  const r = await cloudUpdateNickname(nickDraft.value);
  nickBusy.value = false;
  if (!r.ok) { nickMsg.value = t("profile.authFail", { r: r.reason || "unknown" }); return; }
  /* 成功：署名键与云端同步（syncNickname 走 cloud.nickname），提示框收起 */
  syncNickname();
  nickAuto.value = false;
  nickEdit.value = false;
  nickDraft.value = "";
  flash.value = r.synced
    ? t("profile.nickSavedSynced", { p: r.posts || 0, c: r.comments || 0 })
    : t("profile.nickSavedOld");
}
/* 登录态变化时判定：昵称是否仍是 Google 自动兜底 */
watch(
  () => [cloud.ready, cloud.user && cloud.user.id, cloud.nickname],
  async ([ready, uid]) => {
    nickAuto.value = !!(ready && uid) && cloudNicknameIsAuto();
    if (!(ready && uid)) cancelNickEdit();
  },
  { immediate: true },
);

function syncNickname() {
  if (cloud.nickname) { nickname.value = cloud.nickname; setItem(NICK_KEY, cloud.nickname); }
}
/* —— 登录 / 注册已独立成页（/login，手机与网页共用）——
 * 本页未登录时只放一张入口卡；重置密码落地（cloud.recovery）的收尾仍在这里处理，
 * 因为老的重置邮件可能回落到 /profile。 */
const router = useRouter();
const route = useRoute();

function goSignIn(withForgot = false) {
  /* 把当前位置带过去：登录成功后回到原来的页面（默认 /profile）；
   * withForgot = 重置链接失效场景 → 直达「忘记密码」表单
   * 轮 21 加固：只有**显式 true** 才算忘记密码。此处用 === true 兜住
   * 「模板 @click 不带括号 → MouseEvent 被当实参」这类误传（真根因见本函数调用处注释）。 */
  const here = route.fullPath || "/profile";
  const query = withForgot === true ? { redirect: here, forgot: "1" } : { redirect: here };
  router.push({ path: "/login", query });
}

/* 密码本地校验（与 /login 同一套规则；权威判断始终在服务端） */
function passHint(pass) {
  const p = passwordProblem(pass);
  if (!p) return "";
  return p === "missing" ? t("profile.needPass") : t("profile.shortPass", { n: MIN_PASSWORD });
}

/* —— 重置链接已生效：设置新密码 —— */
async function doSetPassword() {
  if (passBusy.value) return;
  const bad = passHint(newPass.value);
  if (bad) { passMsg.value = bad; return; }
  passBusy.value = true;
  passMsg.value = "";
  const r = await cloudUpdatePassword(newPass.value);
  passBusy.value = false;
  if (!r.ok) { passMsg.value = t("profile.authFail", { r: r.reason || "unknown" }); return; }
  syncNickname();
  newPass.value = "";
  cloudClearRecovery();
  flash.value = t("profile.resetDone");
}
/* 轮 501 · 分享（海外版）
 * 用户原话：「我们是面向海外用户，你搞这个？？重新设计这个分享功能」
 * 旧面板只有「复制后粘到微信 / QQ 发给朋友」，五语种里全是直接从中文版抄的 WeChat / QQ ——
 * 对英语 / 西语 / 葡语 / 法语区用户来说，这不是少个入口，是**看不出这产品是给他的**。
 *
 * 现在的两层：
 *   ① 系统分享（navigator.share）：iOS / 安卓 Chrome / 桌面 Chrome 一把覆盖
 *      AirDrop、Messages、Instagram、Gmail……不用我们枚举平台 —— 有就直接走它，
 *      面板都不弹（系统面板本来就是我们想做的东西）。
 *   ② 系统分享缺席（各家内置浏览器、旧内核）或抛错 → 弹面板，给**直连**入口：
 *      WhatsApp / Telegram / X / Facebook / Email / SMS + 复制链接。
 *      直连地址由 utils/shareLinks 拼（纯函数，有单测），https 链接交给系统接手，
 *      网页端与 App 内 WebView 走同一条路。
 * 复制仍走 utils/clipboard 的 copyText（带 execCommand 兜底）。 */
const shareOpen = ref(false);
/* 复制状态："" 未复制 / "ok" 成功 / "fail" 失败 —— 失败也要说话，不能像旧版那样静默 */
const shareState = ref("");
const shareBusy = ref(false);
/* 面板里显示的地址 = 实际分享出去的地址（都是站点首页，不是 /profile） */
const shareLink = ref(shareUrl(typeof location !== "undefined" ? location.href : ""));
/* 有没有系统分享（模板里决定要不要那条主按钮） */
const canNativeShare = ref(typeof navigator !== "undefined" && typeof navigator.share === "function");
/* 微信/QQ 等内置浏览器只能「···→ 在浏览器打开」；只有真在里面时才提示 */
const inWeChat = typeof navigator !== "undefined" && /MicroMessenger/i.test(navigator.userAgent || "");

const shareText = () => t("profile.shareText");
const shareSubject = () => t("profile.shareSubject");
const copyLabel = () => t(shareState.value === "ok" ? "profile.shareCopied"
  : shareState.value === "fail" ? "profile.shareFail" : "profile.shareCopy");
/* 渠道标签：**字面量集中在这里**（i18n-usage-test 靠字面量判死键，模板里拼字符串会被当成死键） */
const TARGET_LABEL = {
  whatsapp: "profile.shareWhatsapp",
  telegram: "profile.shareTelegram",
  x: "profile.shareX",
  facebook: "profile.shareFacebook",
  email: "profile.shareEmail",
  sms: "profile.shareSms",
};

function closeShare() {
  shareOpen.value = false;
  shareState.value = "";
}

async function copyShareLink() {
  if (shareBusy.value) return;
  shareBusy.value = true;
  const ok = await copyText(shareLink.value);
  shareBusy.value = false;
  shareState.value = ok ? "ok" : "fail";
  setTimeout(() => { shareState.value = ""; }, 2400);
}

/* 面板里的直连渠道：https 走新标签、mailto/sms 交给系统，点完就收面板。
 * 收面板是**同步**的：早先写成 setTimeout(160) 收，那次延时会把「刚被重新打开的面板」
 * 一起关掉（实测连点时面板闪一下就没了）。点击事件在收面板前已经派发完，不需要等。 */
function openShareTarget(key) {
  const href = shareHref(key, { url: shareLink.value, text: shareText(), subject: shareSubject() });
  if (!href) return;
  const a = document.createElement("a");
  a.href = href;
  a.target = key === "email" || key === "sms" ? "_self" : "_blank";
  a.rel = "noopener noreferrer";
  document.body.appendChild(a);
  a.click();
  a.remove();
  closeShare();
}

/* 面板里的「系统分享」按钮：刚才 share() 抛错时给一次重试机会 */
async function shareNative() {
  if (typeof navigator === "undefined" || typeof navigator.share !== "function") return;
  try {
    await navigator.share({ title: shareSubject(), text: shareText(), url: shareLink.value });
    closeShare();
  } catch (e) {
    if (e && e.name === "AbortError") return;   /* 用户点取消，不算失败 */
  }
}

async function sharePage() {
  shareLink.value = shareUrl(location.href);
  shareState.value = "";
  canNativeShare.value = typeof navigator !== "undefined" && typeof navigator.share === "function";
  /* 有系统分享就先走它：用户点取消（AbortError）静默退出，别追着弹面板 */
  if (canNativeShare.value) {
    try {
      await navigator.share({
        title: shareSubject(),
        text: shareText(),
        url: shareLink.value,
      });
      return;
    } catch (e) {
      if (e && e.name === "AbortError") return;
      /* 其他错误（不支持这组数据 / 权限被拒）→ 落到面板，别静默复制 */
    }
  }
  shareOpen.value = true;
}

/* 渠道图标（24×24，单色描边全部走 currentColor，颜色由 CSS 的格子底色反白）。
 * 用 SVG 手绘而不是引第三方 icon 包：分享面板只有 7 个图标，不值得为它加依赖；
 * 也不用 emoji —— 各家系统的 emoji 字体差异大，WhatsApp 的绿色电话 emoji 根本认不出来。 */
const GLYPHS = {
  whatsapp: [
    "M12.04 3.2c-4.9 0-8.86 3.96-8.86 8.85 0 1.56.41 3.09 1.19 4.44L3.1 21.2l4.83-1.25a8.86 8.86 0 0 0 4.11 1.05h.01c4.89 0 8.86-3.96 8.86-8.85 0-2.37-.92-4.59-2.6-6.26a8.8 8.8 0 0 0-6.27-2.6Zm0 16.2h-.01a7.36 7.36 0 0 1-3.74-1.02l-.27-.16-2.78.72.74-2.71-.17-.28a7.32 7.32 0 0 1-1.13-3.9c0-4.06 3.31-7.36 7.37-7.36 1.97 0 3.82.77 5.21 2.16a7.3 7.3 0 0 1 2.16 5.21c-.01 4.06-3.31 7.34-7.38 7.34Z",
    "M16.6 13.87c-.25-.13-1.47-.72-1.7-.8-.23-.09-.4-.13-.56.13-.17.25-.65.8-.8.96-.14.17-.29.19-.54.06-.25-.12-1.06-.39-2.01-1.24-.74-.66-1.25-1.48-1.39-1.73-.15-.25-.02-.39.11-.51.11-.11.25-.29.37-.44.13-.14.17-.25.25-.41.09-.17.04-.31-.02-.44-.06-.13-.55-1.33-.76-1.82-.2-.48-.4-.41-.55-.42h-.47c-.16 0-.42.06-.64.31-.22.25-.84.82-.84 2 0 1.18.86 2.32.98 2.48.12.17 1.68 2.68 4.08 3.66 2.4.98 2.4.65 2.83.61.43-.04 1.39-.57 1.59-1.12.2-.55.2-1.02.14-1.12-.06-.1-.22-.16-.47-.29Z",
  ],
  telegram: [
    "M21.6 4.3c.3-1.2-.45-1.75-1.28-1.44L2.7 9.83c-1.2.46-1.19 1.13-.21 1.43l4.5 1.4 1.75 5.4c.2.55.36.77.73.77.36 0 .52-.16.72-.35l1.72-1.66 3.54 2.6c.65.36 1.12.17 1.29-.6l2.36-11.1Zm-4.5 3.15-6.6 6.05-.26 3.1-1.33-4.28 8.19-4.87Z",
  ],
  x: [
    "M17.6 3.5h2.9l-6.33 7.23L21.6 20.5h-5.5l-4.3-5.6-4.92 5.6H4l6.77-7.72L3.4 3.5h5.64l3.9 5.14 4.66-5.14Zm-1.02 15.2h1.6L8.02 5.2H6.3l10.28 13.5Z",
  ],
  facebook: [
    "M13.6 20.7v-7.3h2.47l.42-2.87H13.6V8.7c0-.83.23-1.4 1.42-1.4h1.5V4.72c-.26-.03-1.15-.11-2.19-.11-2.17 0-3.66 1.33-3.66 3.76v2.16H8.2v2.87h2.47v7.3h2.93Z",
  ],
  email: [
    "M4.5 5h15A2.5 2.5 0 0 1 22 7.5v9a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 2 16.5v-9A2.5 2.5 0 0 1 4.5 5Zm0 1.6 7.5 5.1 7.5-5.1h-15Zm15.6 1.9-7.4 5.03a1.7 1.7 0 0 1-1.4 0L3.9 8.5v8a.9.9 0 0 0 .9.9h14.4a.9.9 0 0 0 .9-.9v-8Z",
  ],
  sms: [
    "M12 3.5c-5 0-9 3.24-9 7.24 0 2.3 1.33 4.35 3.4 5.68l-.6 3.28c-.05.3.26.53.52.38l3.7-2.09c.63.12 1.3.19 1.98.19 5 0 9-3.24 9-7.24s-4-7.24-9-7.24Z",
  ],
};

function leaveRecovery() {
  newPass.value = "";
  passMsg.value = "";
  cloudClearRecovery();
}

function continueAsGuest() {
  const n = draftNick.value.trim();
  if (!n) return;
  nickname.value = n;
  setItem(NICK_KEY, n);
}

async function signOut() {
  if (cloudSigned.value) await cloudSignOut();
  removeItem(NICK_KEY);
  nickname.value = "";
  /* 退出时把残留的提示与「设置新密码」界面一起收掉 */
  flash.value = "";
  leaveRecovery();
}

/* 最近 30 天日历 */
const cells = computed(() => {
  const out = [];
  const d = new Date();
  d.setDate(d.getDate() - 29);
  for (let i = 0; i < 30; i++) {
    const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    const idx = moodLog[key];
    out.push({
      key,
      idx: idx === undefined ? -1 : idx,
      emoji: idx === undefined ? "" : MOOD_KIND[idx],
      kind: idx === undefined ? "" : MOOD_KIND[idx],
      today: key === todayKey(),
    });
    d.setDate(d.getDate() + 1);
  }
  return out;
});

const loggedDays = computed(() => cells.value.filter((c) => c.emoji).length);

/* 明亮心情（开心 / 不错）占比 */
const brightRatio = computed(() => {
  const vals = cells.value.filter((c) => c.idx >= 0);
  if (!vals.length) return 0;
  const good = vals.filter((c) => c.idx <= 1).length;
  return Math.round((good / vals.length) * 100);
});
</script>

<template>
  <div>
    <!-- 账户 -->
    <section class="card profile-head">
      <n-avatar round :size="64" class="profile-avatar" :src="avatarUrlFor(cloud.user && cloud.user.id) || undefined"><template v-if="!avatarUrlFor(cloud.user && cloud.user.id)" #default>{{ signedIn ? displayName.slice(0, 1).toUpperCase() : PAW }}</template><template v-else #fallback>{{ signedIn ? displayName.slice(0, 1).toUpperCase() : PAW }}</template>
      </n-avatar>
      <div class="profile-id">
        <span class="sec-label">{{ t("profile.title") }}</span>
        <h2 v-if="signedIn">{{ t("profile.hello", { n: displayName }) }}</h2>
        <h2 v-else>{{ t("profile.notSigned") }}</h2>
        <p class="sub" style="margin: 4px 0 0">
          {{ cloud.ready
            ? (cloudSigned ? t("profile.cloudSignedIn") : t("profile.cloudReady"))
            : t("profile.authLocal") }}
        </p>
      </div>
      <div class="profile-actions">
        <template v-if="signedIn">
          <!-- 轮 254：收藏改独立页（用户拍板「不要在我的页面下面显示」）→ 跳 /favorites -->
          <n-button quaternary round @click="router.push('/favorites')">
            {{ t("fav.title") }}
          </n-button>
          <!-- 轮447：关注（独立页 /following）。只显示关注数，**不显示粉丝** ——
               详见 docs/PLAN-wall-follow.md：粉丝数一旦出现就必须能点进去看「谁」，
               那会把「谁关注了我」变成公开看板，与拉黑/漂流瓶的隐私口径全线冲突。 -->
          <n-button quaternary round @click="router.push('/following')">
            {{ t("follow.followingBtn", { n: followingCount }) }}
          </n-button>
          <n-tag v-if="streak > 0" round :bordered="false" class="soft-tag">
            {{ t("home.mood.streak", { n: streak }) }}
          </n-tag>
          <n-button quaternary round @click="signOut">{{ t("common.signOut") }}</n-button>
        </template>
        <router-link v-if="isAdmin" to="/admin" class="admin-entry">
          {{ t("admin.entry") }}
        </router-link>
        <!-- T7 我的 Tab 整合：手机形态顶栏已隐藏（金币/连签原本在桌面顶栏）→ 钱包挪进「我的」头部 -->
        <n-tag v-if="isMobileNav" round :bordered="false" class="soft-tag">
          &#128176; {{ wallet.coins }}
        </n-tag>
        <!-- #13 设置入口：皮肤 / 语言 / 通知偏好都收在设置页 -->
        <router-link to="/settings" class="admin-entry">
          ⚙️ {{ t("settings.entry") }}
        </router-link>
        <!-- 轮 308 回炉（用户拍板）：下载 App 入口只放「我的」页、紧贴设置 ——
             不再每页顶部挂条（打扰）。条件 = 网页端（桌面 + 手机浏览器；App 内不显示） -->
        <div v-if="!isApp" class="admin-row">
          <button type="button" class="admin-entry m-dl-pill"
            :title="t('appDownload.button')" @click="openDownload">
            <span class="m-dl-ico" aria-hidden="true">⤓</span>{{ t("appDownload.button") }}
          </button>
          <button type="button" class="admin-entry m-share-pill"
            :title="t('profile.sharePage')" @click="sharePage">
            <span class="m-share-ico" aria-hidden="true">↗</span>{{ t("profile.sharePage") }}
          </button>
        </div>
      </div>
    </section>

    <!-- 轮 254：内嵌「我的收藏」区块退役 → 独立页 /favorites（按钮见上方头部）。
         数据/取消收藏逻辑一并迁走（FavoritesView）；缓存键 profile-favs 保留同用。 -->
    <!-- 改昵称：Google 首登自动昵称 → 常驻紧凑提示；点「改一改」出现输入框。
         保存走 profiles self update（RLS），署名/主页/头像即时生效 -->
    <section v-if="cloudSigned && (nickAuto || nickEdit)" class="card nick-box">
      <div class="row-between">
        <span class="sec-label">{{ t("profile.nickTitle") }}</span>
        <n-button v-if="!nickEdit" quaternary size="small" round @click="startNickEdit">
          {{ t("profile.nickChange") }}
        </n-button>
        <n-button v-else quaternary size="small" round :disabled="nickBusy" @click="cancelNickEdit">
          {{ t("common.cancel") }}
        </n-button>
      </div>
      <p class="sub">{{ nickAuto ? t("profile.nickAutoHint") : t("profile.nickHint") }}</p>
      <div v-if="nickEdit" class="nick-row">
        <van-field
          v-model="nickDraft" :placeholder="displayName"
          :maxlength="NICK_MAX" :disabled="nickBusy" @keyup.enter="saveNick" />
        <n-button type="primary" :loading="nickBusy" @click="saveNick">
          {{ t("profile.nickSave") }}
        </n-button>
      </div>
      <p v-if="nickMsg" class="streak-note">{{ nickMsg }}</p>
    </section>

    <!-- 刚完成动作的提示（如「新密码已保存」）—— 放在登录卡片外：成功后那张卡片会被隐藏 -->
    <section v-if="flash" class="card auth-flash">{{ flash }}</section>

    <!-- 重置邮件失效（链接被用过 / 已过期）：如实说明，并给一条重新发的路 -->
    <section v-if="cloud.ready && !cloudSigned && cloud.recoveryErr && !cloud.recovery" class="card auth-card">
      <h2>{{ t("profile.resetLinkBad") }}</h2>
      <p class="notice">{{ t("profile.resetLinkBadWhy", { r: cloud.recoveryErr }) }}</p>
      <div style="margin-top: 12px">
        <n-button type="primary" round @click="goSignIn(true)">{{ t("profile.forgotTitle") }}</n-button>
      </div>
    </section>

    <!-- 重置链接已生效：设置新密码（保存后即为登录状态） -->
    <section v-else-if="cloud.ready && cloud.recovery" class="card auth-card">
      <h2>{{ t("profile.setPassTitle") }}</h2>
      <p class="notice">{{ t("profile.setPassHint") }}</p>
      <div class="q-input" style="margin-top: 12px">
        <van-field v-model="newPass" type="password" show-password-on="click"
          :placeholder="t('profile.newPass')" @keyup.enter="doSetPassword" />
      </div>
      <div class="auth-actions">
        <n-button type="primary" round size="large" :loading="passBusy" @click="doSetPassword">
          {{ t("profile.savePass") }}
        </n-button>
        <n-button quaternary round @click="leaveRecovery">{{ t("profile.backToSignIn") }}</n-button>
      </div>
      <p v-if="passMsg" class="notice bad">{{ passMsg }}</p>
    </section>

    <!-- 未登录：登录 / 注册已独立成页（/login，手机与网页共用）；这里只留一张入口卡 -->
    <section v-else-if="cloud.ready && !cloudSigned" class="card auth-card">
      <h2>{{ t("profile.authTitle") }}</h2>
      <p class="sub" style="margin-top: 6px">{{ t("settings.tapToLogin") }}</p>
      <div class="auth-actions">
        <!-- 轮 21 根因修复：@click="goSignIn" 不带括号时 Vue 会把 MouseEvent 当第一实参传入，
             withForgot 收到 truthy → 跳 /login?forgot=1 → 用户点「去登录」直接看到忘记密码页。
             必须显式传 false（函数内也加了 === true 兜底，双保险）。 -->
        <n-button type="primary" round size="large" @click="goSignIn(false)">
          {{ t("profile.goSignIn") }}
        </n-button>
      </div>
    </section>

    <!-- 起昵称（本地模式，或登录前的访客身份） -->
    <section v-if="!cloud.ready && !signedIn" class="card">
      <h2>{{ t("profile.setNick") }}</h2>
      <div class="q-input" style="margin-top: 12px">
        <van-field
          v-model="draftNick"
          :placeholder="t('common.nickname')"
          @keyup.enter="continueAsGuest" />
        <n-button type="primary" round size="large" @click="continueAsGuest">
          {{ t("common.save") }}
        </n-button>
      </div>
      <p class="notice">{{ t("common.localMode") }}</p>
    </section>

    <!-- 心情日历 -->
    <section class="card">
      <div class="row-between">
        <h2>{{ t("profile.moodCal") }}</h2>
        <n-tag round size="small" :bordered="false" class="soft-tag">
          {{ t("profile.days") }}
        </n-tag>
      </div>

      <div class="stat-row">
        <div class="stat">
          <b>{{ loggedDays }}</b>
          <span>{{ t("profile.daysLogged") }}</span>
        </div>
        <div class="stat-growth">
          <n-progress
            type="line" :percentage="brightRatio" :height="8" :show-indicator="false"
            color="#CC785C" rail-color="#E6DFD8" />
          <span class="stat-cap">{{ t("profile.brightDays") }} · {{ brightRatio }}%</span>
        </div>
      </div>

      <div v-if="loggedDays > 0" class="mood-cal">
        <div
          v-for="c in cells" :key="c.key"
          class="mood-cell" :class="{ has: c.emoji, today: c.today }">
          <MoodFace v-if="c.kind" :kind="c.kind" />
        </div>
      </div>
      <p class="cal-legend">{{ t("profile.moodEmpty") }}</p>
    </section>

    <!-- 我的食谱（共有 6）：原版卡片（♥用心度 + 可删）——标题行的「去厨房 →」跳宠物页食谱 Tab -->
    <section class="card">
      <div class="row-between">
        <h2>{{ t("profile.myBook") }}</h2>
        <!-- 轮 54：手机端不再跳独立 /pet 页（跳出三联还要找返回），改深链首页宠物联+食谱页签
             （/?tab=pet 落宠物联，petTab=book 由 PetView 消费）；桌面布局无三联，保持独立页。 -->
        <router-link class="my-posts-link"
          :to="isMobileNav ? { path: '/', query: { tab: 'pet', petTab: 'book' } } : '/pet?tab=book'">
          {{ t("profile.bookOpen") }} →
        </router-link>
      </div>
      <p v-if="!cookbook.length" class="sub">{{ t("profile.bookEmpty") }}</p>
      <div v-else class="book-grid">
        <div v-for="d in cookbook" :key="d.id" class="dish">
          <img :src="d.img" :alt="d.name" />
          <div class="name">{{ d.name }}</div>
          <div class="row">
            <span class="notice" style="margin: 0">{{ HEART }} {{ d.effort }}%</span>
            <n-button quaternary size="tiny" @click="removeDish(d.id)">
              {{ t("common.delete") }}
            </n-button>
          </div>
        </div>
      </div>
    </section>

    <!-- #9 我在暖心墙的帖子（共有 5：默认最新 3 条 + 「更多」→ /my-posts 分页看全部）。
         轮 44：整块从「改昵称」下方挪到页面最底（用户拍板：在我的食谱下面）；
         轮 288：帖子时间统一到分（fmtWhen），与暖心墙 / 详情页同口径。 -->
    <section v-if="cloudSigned" class="card">
      <div class="row-between">
        <h2>{{ t("profile.myPosts") }}</h2>
        <router-link class="my-posts-link" to="/my-posts">{{ t("profile.more") }} →</router-link>
      </div>
      <!-- 轮 287：busy 占位只在「屏上本来就没帖子」时显示（首拉无缓存）。
           onActivated 静默刷新会置 busy=true——若无条件渲染这个 …，返回页签的瞬间会把
           KeepAlive 原样保留的帖子盖掉，等网络回来（跨境 2~5s）才放出，用户报「点别的
           页面再返回还要等几秒帖子才出现」。暖心墙口径：有内容在屏就永不遮。 -->
      <p v-if="myPostsBusy && !myPosts.length" class="sub">…</p>
      <p v-else-if="!myPosts.length" class="sub">{{ t("profile.myPostsEmpty") }}</p>
      <!-- 轮 18：与暖心墙完全同款的帖子卡（头像/署名/时间/全文/配图/回应数/浏览数）；
           轮 20：整卡点击进独立详情页 /post/:id（完整帖子+评论展开），不再跳回暖心墙列表 -->
      <div v-else class="my-posts">
        <article
          v-for="p in myPosts" :key="p.id"
          class="post-card card my-post"
          @click="openMyPost(p)">
          <div class="post-head">
            <n-avatar round :size="42" class="post-avatar" :src="avatarUrlFor(cloud.user && cloud.user.id) || undefined"><template v-if="!avatarUrlFor(cloud.user && cloud.user.id)" #default>🙂</template><template v-else #fallback>🙂</template></n-avatar>
            <div class="post-meta">
              <div class="post-name">{{ p.name }}</div>
              <div class="post-time">{{ when(p.ts) }}</div>
            </div>
          </div>
          <p class="post-text">{{ p.text || "🖼️" }}</p>
          <img loading="lazy" v-if="p.img" :src="p.img" class="pic" alt="" />
          <div class="react-row">
            <n-button
              v-for="r in REACTIONS" :key="r.key"
              round size="small" quaternary :focusable="false">
              {{ t(r.tk) }} · {{ (p.reacts && p.reacts[r.key]) || 0 }}
            </n-button>
          </div>
          <div v-if="p.stats" class="post-foot">
            <span class="post-views">{{ t("community.views", { n: p.views || 0 }) }}</span>
          </div>
          <!-- 轮460：与暖心墙卡片同款的评论区（说点温柔的话 + 💬 N 条评论 ▾）；
               点这一块不触发整卡跳详情 -->
          <div @click.stop>
            <PostComments :post="p" />
          </div>
        </article>
      </div>
    </section>

    <!-- 轮 501 · 分享面板（海外版）。
         旧版只有「复制后粘到微信 / QQ」—— 暖爪面向海外用户，那句话等于把产品说给了中国人。
         现在：系统分享优先（有就直接走系统面板，不弹这个）；没有就弹这里，
         给 WhatsApp / Telegram / X / Facebook / Email / SMS + 复制链接六条直连。
         Teleport 到 body 是必须的：`.shell` 自带 z-index:1，页内子元素写多大都只是
         「壳内第一」，根级底栏(140)照样盖在上面（实测面板下沿被页签切掉一截）。 -->
    <Teleport to="body">
      <div v-if="shareOpen" class="share-mask" @click.self="closeShare">
        <div class="share-sheet" role="dialog" aria-modal="true" :aria-label="t('profile.shareTitle')">
          <span class="share-grab" aria-hidden="true"></span>
          <div class="share-head">
            <div class="share-title">{{ t("profile.shareTitle") }}</div>
            <p class="share-sub">{{ t("profile.shareSub") }}</p>
          </div>
          <!-- 要分享的地址：点一下即复制（知道自己在发什么，也知道能直接拿走） -->
          <button type="button" class="share-copy" :disabled="shareBusy" @click="copyShareLink">
            <span class="share-url">{{ shareLink }}</span>
            <span class="share-copy-tag" aria-live="polite">{{ copyLabel() }}</span>
          </button>
          <button v-if="canNativeShare" type="button" class="share-native" @click="shareNative">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path v-for="(d, i) in [
              'M12 3v11.2',
              'M8.2 6.5 12 2.8l3.8 3.7',
              'M6 12.5H4.6A1.6 1.6 0 0 0 3 14.1v5.3A1.6 1.6 0 0 0 4.6 21h14.8a1.6 1.6 0 0 0 1.6-1.6v-5.3a1.6 1.6 0 0 0-1.6-1.6H18'
            ]" :key="i" :d="d" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
            {{ t("profile.shareNative") }}
          </button>
          <div class="share-or">{{ t("profile.shareDirect") }}</div>
          <div class="share-grid">
            <button v-for="k in SHARE_TARGETS" :key="k" type="button"
              class="share-tile" :class="'is-' + k" @click="openShareTarget(k)">
              <span class="share-tile-ico" aria-hidden="true">
                <svg viewBox="0 0 24 24"><path v-for="(d, i) in GLYPHS[k]" :key="i" :d="d" fill="currentColor" /></svg>
              </span>
              <span class="share-tile-label">{{ t(TARGET_LABEL[k]) }}</span>
            </button>
          </div>
          <p class="share-tip">{{ t("profile.shareHint") }}</p>
          <p v-if="inWeChat" class="share-tip share-tip-wx">{{ t("profile.shareWx") }}</p>
          <button type="button" class="share-close" @click="closeShare">{{ t("common.close") }}</button>
        </div>
      </div>
    </Teleport>

  </div>
</template>

<style scoped>
/* 轮 35：入口链接统一主题色（此前无 color，落到浏览器默认蓝紫，跳出暖色调） */
.my-posts-link { text-decoration: none; color: var(--accent-deep); font-weight: 500; }
.my-posts-link:hover { color: var(--accent); }
.my-posts { display: flex; flex-direction: column; gap: 10px; margin-top: 10px; }
.my-post {
  display: block; text-decoration: none; color: inherit;
  /* 轮 460：卡片由 <router-link> 改为 <article>（卡内要放评论框），手型要自己给 */
  cursor: pointer;
}
.my-post:hover { background: var(--accent-soft); }
/* 轮 18：卡片结构与暖心墙完全同款（.post-card/.post-head/.post-text/.pic/.react-row 全局类），
   这里只保留链接化外观；旧的 mp-* 缩略样式随结构一起退役 */

/* 轮 501 · 分享面板（移动端贴底，桌面端居中）：层级压过底栏 140 与聊天壳 200，
   低于维护遮罩 4000。表面色走主题变量，夜间主题自动跟随，不写死白底。
   结构：把手 → 标题 → 地址（点即复制）→ 系统分享（可选）→ 六渠道九宫格 → 说明 → 关闭。 */
.share-mask {
  position: fixed; inset: 0; z-index: 300;
  display: flex; align-items: flex-end; justify-content: center;
  background: rgba(28, 22, 16, .42);
}
.share-sheet {
  width: 100%; max-width: 480px;
  display: flex; flex-direction: column; gap: 12px;
  padding: 6px 18px calc(16px + var(--sab, env(safe-area-inset-bottom, 0px)));
  /* glass 主题把 --card 定义成半透明白（alpha .62），直接当面板底会透出被压暗的页面，
     字也糊。这里「不透明画布色打底 + 半透明卡色叠加」：视觉仍是卡色，但底下不透光。
     不用 --glass-strong：它在几个主题里同样带 alpha。 */
  background-color: var(--page-bg, #faf9f5);
  background-image: linear-gradient(var(--card, #efe9de), var(--card, #efe9de));
  border-radius: 22px 22px 0 0;
  box-shadow: 0 -12px 40px rgba(20, 20, 19, .18);
  color: var(--ink);
  animation: share-rise .22s cubic-bezier(.2, .8, .3, 1);
}
@keyframes share-rise {
  from { transform: translateY(14px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}
/* 顶部把手：底部面板的通用暗号（小红书/微信同款），给「可以点外面关掉」一个视觉锚 */
.share-grab {
  width: 36px; height: 4px; border-radius: 999px;
  background: var(--hairline); margin: 4px auto 2px; flex: none;
}
.share-head { text-align: center; }
.share-title { font-size: 16px; font-weight: 650; letter-spacing: .2px; }
.share-sub { margin: 4px 0 0; font-size: 12.5px; line-height: 1.5; color: var(--ink-soft); }

/* 地址行：左边链接（单行截断），右边「复制链接 / 已复制」小标签 —— 整行就是一个复制按钮 */
.share-copy {
  display: flex; align-items: center; gap: 10px;
  width: 100%; min-width: 0; text-align: left;
  border: 1px solid var(--hairline); border-radius: 12px;
  padding: 10px 12px; background: var(--accent-soft);
  color: var(--ink-soft); cursor: pointer;
  /* 手机浏览器里 300ms 点击延迟 + 双击缩放会把「点了没反应」放大，这里一并关掉 */
  touch-action: manipulation;
}
.share-copy:disabled { opacity: .6; }
.share-copy:active { background: var(--accent-soft); filter: brightness(.97); }
.share-url {
  flex: 1 1 auto; min-width: 0;
  font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  user-select: text; -webkit-user-select: text;
}
.share-copy-tag {
  flex: none; border-radius: 999px; padding: 3px 9px;
  font-size: 11px; font-weight: 600;
  color: var(--accent-deep); background: var(--card);
  border: 1px solid var(--hairline);
}

/* 系统分享：能用到就放最显眼的位置（一次覆盖 AirDrop / Messages / Instagram…） */
.share-native {
  display: flex; align-items: center; justify-content: center; gap: 8px;
  border: 0; border-radius: 13px; padding: 12px 16px;
  font-size: 14.5px; font-weight: 600; color: #fff;
  background: var(--accent); cursor: pointer; touch-action: manipulation;
}
.share-native svg { width: 17px; height: 17px; }

.share-or { font-size: 11.5px; color: var(--ink-faint); text-align: center; letter-spacing: .2px; }

/* 六渠道：3 列 × 2 行。图标底色即品牌色，标签走主题字色（夜间不打眼） */
.share-grid {
  display: grid; grid-template-columns: repeat(3, 1fr);
  gap: 6px 4px;
}
.share-tile {
  display: flex; flex-direction: column; align-items: center; gap: 6px;
  border: 0; background: transparent; padding: 4px 2px 6px;
  cursor: pointer; touch-action: manipulation; color: var(--ink-soft);
  border-radius: 12px;
}
.share-tile:active { background: var(--accent-soft); }
.share-tile-ico {
  width: 48px; height: 48px; border-radius: 15px;
  display: flex; align-items: center; justify-content: center;
  /* 图标色只由两个变量决定：底色 --tile、字色 --tile-ink（由 .is-* 设在按钮上，图标继承）。
     **不要在图标自己身上声明这两个变量的默认值** —— 自定义属性在自身声明后会压掉继承，
     六个格子会一起变成同一块颜色（实测踩过）。默认值只能走 var() 的第二参数。
     也不让字色跟着主题走：夜间主题里 --accent-deep / --ink-soft 会翻成浅色，
     白字配浅底只剩 1.6:1 对比度（邮件/短信两格几乎看不见）。 */
  color: var(--tile-ink, #fff); background: var(--tile, var(--ink-soft));
  box-shadow: 0 2px 8px rgba(20, 20, 19, .14);
}
.share-tile-ico svg { width: 26px; height: 26px; }
.share-tile-label { font-size: 11.5px; font-weight: 500; line-height: 1.2; max-width: 100%;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 品牌色：官方主色，只用在图标底上（整块按钮染色会抢走面板的主次）。
   邮件 / 短信没有公认品牌色，用固定深色 —— 两套主题里都是白字，对比度稳定。 */
.share-tile.is-whatsapp { --tile: #25d366; }
.share-tile.is-telegram { --tile: #2aabee; }
.share-tile.is-facebook { --tile: #1877f2; }
/* X 是黑白标：底色取正文色、字色取画布色 —— 浅色主题黑底白字，夜间主题自动反过来 */
.share-tile.is-x { --tile: var(--ink); --tile-ink: var(--page-bg); }
.share-tile.is-email { --tile: #6c6a64; }
.share-tile.is-sms { --tile: #a9583e; }

.share-tip { margin: 0; font-size: 11.5px; line-height: 1.5; color: var(--ink-faint); text-align: center; }
.share-tip-wx { color: var(--accent-deep); }
.share-close {
  border: 1px solid var(--hairline); border-radius: 13px;
  padding: 11px 16px; font-size: 14px; color: var(--ink-soft);
  background: transparent; cursor: pointer; touch-action: manipulation;
}
@media (min-width: 720px) {
  .share-mask { align-items: center; }
  .share-sheet { border-radius: 20px; padding-bottom: 18px; animation: none; }
  .share-grab { display: none; }
}
</style>