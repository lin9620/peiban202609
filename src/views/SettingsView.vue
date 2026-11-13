<!-- 设置页（/settings）：Soul 风格重构 —— 顶部身份卡 + 分组行式条目 + 点击展开。
     手机与网页共用同一布局（窄屏单列，桌面 640px 居中）；
     功能与旧版一一对应：皮肤 / 语言 / 昵称 / 改密码 / 通知偏好 / 删号 / 隐私政策。 -->
<script setup>
import { ref, computed, nextTick, onMounted, watch } from "vue";
import { useRouter } from "vue-router";
import { t, i18n } from "../i18n.js";
import { cloud, cloudUpdateNickname, cloudChangePassword, cloudDeleteAccount } from "../utils/supabase.js";
import { NICK_MAX, MIN_PASSWORD, passwordProblem } from "../utils/authRules.js";
import * as notifyApi from "../utils/notify.js";
import { normPrefs } from "../utils/notifyRules.js";
import { createTapGuard } from "../utils/tapGuard.js";
import { refreshBadge } from "../stores/badgeStore.js";
import { avatarUrlFor } from "../utils/avatar.js";   /* 轮 238:萌宠头像池 */
import {
  themeKey, themeOptions, applyTheme,
  langOptions, onLangPick, isMobileNav, isApp,
} from "../stores/uiStore.js";
import { contentPref, setPrefMode } from "../utils/contentLang.js";
import { getItem, setItem } from "../utils/storage.js";
import { blockState, refreshBlocks } from "../utils/userBlocks.js";
/* 轮 297 · 版本与检查更新 */
import { currentVersion, checkForUpdate } from "../utils/appVersion.js";
import UpdateDialog from "../components/UpdateDialog.vue";

const router = useRouter();
const cloudSigned = computed(() => !!(cloud.ready && cloud.user));
const userEmail = computed(() => (cloud.user && cloud.user.email) || "");
const userNick = computed(() => cloud.nickname || getItem("wp-nickname") || "");

function goLogin() {
  /* 从设置页去登录：登录成功后按 redirect 回到设置页 */
  router.push({ path: "/login", query: { redirect: "/settings" } });
}
function goBack() {
  /* 有历史就退回去；直链进来（无历史）就回「我的」页 */
  if (typeof window !== "undefined" && window.history.state && window.history.state.back != null) {
    router.back();
  } else {
    router.replace("/profile").catch(() => {});
  }
}

/* ═════════ 轮 297 · 版本行 + 手动检查更新 ═════════
 * 自动弹窗只在 App 壳里做（main.js 启动后静默检查）；设置页这一处原本两端都显示，
 * 轮 309 用户拍板「浏览器端不应该有更新按钮的内容，去掉」——更新是 App 的事，
 * 浏览器刷新即最新，版本行/检查按钮/提示整块只在 App 壳渲染（v-if="isApp"）。
 * 拿不到登记（404 / 迁移没跑 / 断网）时统一显示「已经是最新版本了」，
 * 不把技术细节暴露给用户（appVersion.checkForUpdate 绝不抛错）。 */
const curVer = currentVersion();
const updOpen = ref(false);
const updLatest = ref(null);
const updChecking = ref(false);
const updMsg = ref("");

async function checkUpdates() {
  if (updChecking.value) return;
  updChecking.value = true;
  updMsg.value = t("appUpdate.checking");
  const r = await checkForUpdate();
  updChecking.value = false;
  if (r.hasUpdate) {
    updLatest.value = r.latest;
    updOpen.value = true;
    /* 行下留一句「发现新版本」：弹窗被关掉后这行还在，用户不用重新触发检查就知道有新版 */
    updMsg.value = t("appUpdate.found", { v: r.latest.name || String(r.latest.code) });
    return;
  }
  updLatest.value = null;
  /* 关键区分：没查到 ≠ 已是最新。离线/迁移没跑/还没登记时谎称「已是最新」是骗用户，
   * 所以这两种情况分开说。unknown-current 是构建期没注入版本号，对用户等同于查不到。 */
  updMsg.value = (r.reason === "up-to-date")
    ? t("appUpdate.upToDate")
    : t("appUpdate.checkFail");
}

/* —— Soul 风格行交互：点行展开对应控件，再次点收起 —— */
const open = ref({});
function toggleRow(k) { open.value = { ...open.value, [k]: !open.value[k] }; }
const isOpen = (k) => !!open.value[k];

/* 轮406 · 已拉黑从消息列表移到设置「账号」下方。
 * 轮409 · 不再在设置页内展开，整行跳到独立页 /settings/blocked。
 * 这里只用快照里的数量做行尾提示，不在设置页发名单请求。 */
const blockedCount = computed(() => (blockState.ids || []).length);

/* 当前选中值（行右侧展示） */
const themeName = computed(() => {
  const o = themeOptions.value.find((x) => x.key === themeKey.value);
  return o ? o.label : "";
});
const langName = computed(() => {
  const o = (langOptions || []).find((x) => x.key === i18n.locale);
  return o ? o.label : "";
});
/* 轮 439：内容语言开关。必须是 setup 顶层函数 —— 写进 computed 里模板就取不到（踩过）。
   改了立即生效：暖心墙/故事靠 computed 重排，漂流瓶下次捞才变。 */
function onPrefToggle(v) { setPrefMode(v ? "prefer" : "all"); }

/* —— 昵称修改（常驻；与「我的」页同一套校验与写入路径） —— */
const nickDraft = ref("");
const nickBusy = ref(false);
const nickMsg = ref("");
watch(() => cloud.nickname, (v) => { if (!nickDraft.value && v) nickDraft.value = v; }, { immediate: true });
async function saveNick() {
  if (nickBusy.value) return;
  const s = String(nickDraft.value || "").trim();
  if (!s) { nickMsg.value = t("profile.needNick"); return; }
  nickBusy.value = true;
  nickMsg.value = "";
  const r = await cloudUpdateNickname(s);
  nickBusy.value = false;
  nickMsg.value = !r.ok
    ? t("profile.authFail", { r: r.reason || "unknown" })
    : r.synced
      ? t("profile.nickSavedSynced", { p: r.posts || 0, c: r.comments || 0 })
      : t("profile.nickSavedOld");
  if (r.ok) nickDraft.value = "";
}

/* —— 改密码（#27）：邮箱用户验旧密码；谷歌用户直接设新密码 —— */
const isGoogle = computed(() =>
  !!(cloud.user && cloud.user.app_metadata && cloud.user.app_metadata.provider === "google"));
const pwOld = ref("");
const pwNew = ref("");
const pwConfirm = ref("");
const pwBusy = ref(false);
const pwMsg = ref("");

async function savePw() {
  if (pwBusy.value) return;
  pwMsg.value = "";
  /* 本地先校验（不打扰服务器）：新密码强度 / 两次一致 / 旧密码没填 */
  const problem = passwordProblem(pwNew.value);
  if (problem) { pwMsg.value = t("settings.pwShort", { n: MIN_PASSWORD }); return; }
  if (pwNew.value !== pwConfirm.value) { pwMsg.value = t("settings.pwMismatch"); return; }
  if (!isGoogle.value && !pwOld.value) { pwMsg.value = t("settings.pwNeedOld"); return; }

  pwBusy.value = true;
  const r = await cloudChangePassword(pwOld.value, pwNew.value);
  pwBusy.value = false;
  if (r.ok) {
    pwMsg.value = isGoogle.value ? t("settings.pwGoogleSaved") : t("settings.pwSaved");
    pwOld.value = ""; pwNew.value = ""; pwConfirm.value = "";
    return;
  }
  /* reason 稳定暗号 → 文案（其余透出原文便于排查） */
  pwMsg.value =
    r.reason === "old-password-wrong" ? t("settings.pwOldWrong")
    : r.reason === "old-password-required" ? t("settings.pwNeedOld")
    : r.reason === "missing" || r.reason === "short" ? t("settings.pwShort", { n: MIN_PASSWORD })
    : t("settings.pwFail", { r: r.reason || "unknown" });
}

/* —— 自助删号（T3 · Play 2024 政策）：两步确认 —— */
const delArm = ref(false);
const delBusy = ref(false);
const delMsg = ref("");
function armDelete() { delArm.value = true; delMsg.value = ""; }
function disarmDelete() { delArm.value = false; }
async function doDelete() {
  if (delBusy.value) return;
  delBusy.value = true;
  delMsg.value = "";
  const r = await cloudDeleteAccount();
  delBusy.value = false;
  if (r.ok) { delArm.value = false; delMsg.value = t("settings.delDone"); return; }
  delMsg.value = t("settings.delFail", { r: r.reason || "unknown" });
}

const PREFS = [
  /* #23 私信退出通知中心：dm 通知在库里已不生成，「私信」开关随之移除 */
  { key: "comments", tk: "notif.prefComments" },
  { key: "reactions", tk: "notif.prefReactions" },
  { key: "pets", tk: "notif.prefPets" },
];

const PREFS_DEFAULT = { comments: true, reactions: true, pets: true, dms: true };
/* 本机快照只用来让首帧直接落在用户上次看到的位置；服务器回包仍会校准。
   键按用户区分，换账号不会把上一个人的开关带过来。 */
const PREFS_CACHE = "warm-paws-notif-prefs-v1:";
const prefs = ref({ ...PREFS_DEFAULT });
const prefsBusy = ref(false);
const prefsMsg = ref("");
const prefsReady = ref(false);
/* 用户拍板 A：通知偏好也是开关型，同一颗 350ms 内第二下直接丢弃（不重复写库）。 */
const tapGuard = createTapGuard(350);
const masterOn = computed(() => PREFS.some((x) => prefs.value[x.key]));
let prefsSeq = 0;

function readCachedPrefs(uid) {
  if (!uid) return null;
  try {
    const raw = getItem(PREFS_CACHE + uid);
    return raw ? normPrefs(JSON.parse(raw)) : null;
  } catch (e) { return null; }
}
function writeCachedPrefs(uid, p) {
  if (!uid) return;
  try { setItem(PREFS_CACHE + uid, JSON.stringify(normPrefs(p))); } catch (e) { /* 忽略 */ }
}
async function markPrefsReady() {
  if (prefsReady.value) return;
  /* 先让校准后的状态真正落到 DOM，再恢复过渡；否则首帧从默认全开切到关，
     仍会重播一次关闭动画。用宏任务而不是 rAF：后台标签页 rAF 会被暂停，
     会一直停在 no-anim。 */
  await nextTick();
  setTimeout(() => { prefsReady.value = true; }, 0);
}

async function loadPrefs() {
  const uid = (cloud.user && cloud.user.id) || "";
  if (!uid) return;
  const seq = prefsSeq;
  const cached = readCachedPrefs(uid);
  if (cached) prefs.value = cached;
  /* 首屏拉取可能比用户手速慢：如果这次请求发出后用户已经点了开关
     （prefsSeq 变了），旧回包不能再把新状态盖回去，否则开关会「自己跳回来」。 */
  try {
    const loaded = await notifyApi.prefsGet();
    if (seq === prefsSeq) prefs.value = normPrefs(loaded);
    if (seq === prefsSeq) writeCachedPrefs(uid, prefs.value);
  } catch (e) { /* 缺行 = 全开，normPrefs 已兜底 */ }
  finally {
    if (seq === prefsSeq) markPrefsReady();
  }
}

async function savePrefs(next) {
  /* 先乐观翻开关，再写库：App 弱网下点一下要等一次 RPC 才动，会被当成「开关坏了」。
   * 失败回滚到最后一次已接受的状态；用序号防止连续点两个开关时旧请求
   * 失败/晚到把新状态盖回去。 */
  const uid = (cloud.user && cloud.user.id) || "";
  const seq = ++prefsSeq;
  const prev = { ...prefs.value };
  const clean = normPrefs(next);
  prefs.value = clean;
  writeCachedPrefs(uid, clean);
  prefsBusy.value = true;
  prefsMsg.value = "";
  try {
    await notifyApi.prefsSet(clean);
    if (seq === prefsSeq) {
      prefs.value = clean;
      writeCachedPrefs(uid, clean);
      prefsMsg.value = "notif.prefsSaved";
    }
    /* 关掉某类时服务端会把该类未读标记已读（MIGRATION_notif_prefs_clear.sql），
     * 这里立刻重拉角标 —— 否则用户点完开关，顶部铃铛红点要等 30s 轮询才肯掉，
     * 看上去就是「关了没效果」。 */
    refreshBadge();
  } catch (e) {
    if (seq === prefsSeq) {
      prefs.value = prev;
      writeCachedPrefs(uid, prev);
      prefsMsg.value = "notif.loadFail";
    }
  } finally {
    if (seq === prefsSeq) {
      prefsBusy.value = false;
      markPrefsReady();
    }
  }
}

/* 总开关：关 = 全关（服务器不再投递任何通知）；开 = 全开（回到默认收齐） */
function toggleMaster() {
  if (!tapGuard.accept("settings:notify:master")) return;
  if (masterOn.value) {
    savePrefs({ comments: false, reactions: false, pets: false });
  } else {
    savePrefs({ comments: true, reactions: true, pets: true });
  }
}
function togglePref(key) {
  if (!tapGuard.accept(`settings:notify:${key}`)) return;
  const next = { ...prefs.value, [key]: !prefs.value[key] };
  savePrefs(next);
}

/* 用户恢复/切换后重新取偏好；首帧先用本机快照，避免每次进设置都重播一遍开关动画。 */
watch(() => (cloud.user && cloud.user.id) || "", (uid) => {
  prefsSeq++;
  prefsReady.value = false;
  prefsMsg.value = "";
  if (!uid) {
    prefs.value = { ...PREFS_DEFAULT };
    return;
  }
  const cached = readCachedPrefs(uid);
  prefs.value = cached || { ...PREFS_DEFAULT };
  /* 有本机快照时首帧已经是对的，不必等网络；服务器若真改了值，再做一次校准动画。 */
  if (cached) markPrefsReady();
  loadPrefs();
}, { immediate: true });

onMounted(() => {
  /* 轮409：进设置顺手校准一次数量；点进「已拉黑」独立页时已有快照，直接出人。 */
  if (cloudSigned.value && !blockState.loaded) refreshBlocks();
});
watch(cloudSigned, (v) => {
  if (v && !blockState.loaded) refreshBlocks();
});
</script>

<template>
  <div class="set-page">
    <!-- 顶栏：手机形态有返回键；桌面保持原有顶栏导航 -->
    <header class="set-top">
      <button v-if="isMobileNav" class="set-back" aria-label="back" @click="goBack">&#8592;</button>
      <div class="set-top-t">
        <h1>{{ t("settings.title") }}</h1>
        <p class="sub">{{ t("settings.sub") }}</p>
      </div>
    </header>

    <!-- 用户卡：Soul 式顶部身份区 -->
    <section class="card set-user" :class="{ 'set-user--guest': !cloudSigned }">
      <div class="set-avatar" :class="{ paw: !cloudSigned }">
        <img v-if="cloudSigned && avatarUrlFor(cloud.user && cloud.user.id)" class="set-avatar-img" :src="avatarUrlFor(cloud.user && cloud.user.id)" alt="" />
        <span v-else>{{ cloudSigned ? (userNick || "?").slice(0, 1).toUpperCase() : "\u{1F43E}" }}</span>
      </div>
      <div class="set-user-body">
        <b class="set-user-name">
          {{ cloudSigned ? (userNick || t("profile.needNick")) : t("profile.notSigned") }}
        </b>
        <span v-if="cloudSigned && userEmail" class="sub set-user-mail">{{ userEmail }}</span>
        <span v-else class="sub set-user-mail">{{ t("settings.tapToLogin") }}</span>
      </div>
      <button v-if="!cloudSigned" class="set-go" @click="goLogin">{{ t("profile.goSignIn") }}</button>
    </section>

    <!-- 外观 -->
    <section class="card set-group">
      <span class="sec-label set-cap">{{ t("settings.appearance") }}</span>
      <div class="set-row" :class="{ open: isOpen('theme') }" @click="toggleRow('theme')">
        <span class="set-ico" aria-hidden="true">&#127912;</span>
        <span class="set-label">{{ t("settings.theme") }}</span>
        <span class="set-val">{{ themeName }}</span>
        <span class="set-arrow" :class="{ on: isOpen('theme') }">&#9662;</span>
      </div>
      <div v-if="isOpen('theme')" class="set-opts">
        <button
          v-for="o in themeOptions" :key="o.key"
          class="set-opt" :class="{ on: themeKey === o.key }"
          @click.stop="applyTheme(o.key)">
          {{ o.label }}
        </button>
      </div>

      <div class="set-row" :class="{ open: isOpen('lang') }" @click="toggleRow('lang')">
        <span class="set-ico" aria-hidden="true">&#127760;</span>
        <span class="set-label">{{ t("settings.language") }}</span>
        <span class="set-val">{{ langName }}</span>
        <span class="set-arrow" :class="{ on: isOpen('lang') }">&#9662;</span>
      </div>
      <div v-if="isOpen('lang')" class="set-opts">
        <button
          v-for="o in langOptions" :key="o.key"
          class="set-opt" :class="{ on: i18n.locale === o.key }"
          @click.stop="onLangPick(o.key)">
          {{ o.label }}
        </button>
        <!-- 轮 439：内容语言开关。跟上面的界面语言是两件事 ——
             界面语言决定按钮和标题说什么话，这个决定别人写的内容先给你看哪种语言。 -->
        <div class="lang-pref" @click.stop>
          <span class="lang-pref-text">
            <span class="lang-pref-title">{{ t("settings.preferLang") }}</span>
            <span class="lang-pref-hint">{{ t("settings.preferLangHint") }}</span>
          </span>
          <van-switch :model-value="contentPref.mode === 'prefer'" size="20px"
            @update:model-value="onPrefToggle" />
        </div>
      </div>
    </section>

    <!-- 账号（游客 → 一行「去登录」；登录 → 昵称 / 密码行展开） -->
    <section class="card set-group">
      <span class="sec-label set-cap">{{ t("settings.account") }}</span>

      <template v-if="cloudSigned">
        <div class="set-row" :class="{ open: isOpen('nick') }" @click="toggleRow('nick')">
          <span class="set-ico" aria-hidden="true">&#9998;&#xFE0F;</span>
          <span class="set-label">{{ t("settings.nickRow") }}</span>
          <span class="set-val">{{ userNick || t("profile.needNick") }}</span>
          <span class="set-arrow" :class="{ on: isOpen('nick') }">&#9662;</span>
        </div>
        <div v-if="isOpen('nick')" class="set-panel">
          <div class="set-opts wrap nick-row">
            <van-field
              v-model="nickDraft" :placeholder="cloud.nickname || t('profile.needNick')"
              :maxlength="NICK_MAX" :disabled="nickBusy" @keyup.enter="saveNick" />
            <button class="set-opt" :disabled="nickBusy" @click="saveNick">
              {{ t("profile.nickSave") }}
            </button>
          </div>
          <p v-if="nickMsg" class="streak-note">{{ nickMsg }}</p>
          <p class="sub">{{ t("profile.nickHint") }}</p>
        </div>

        <div class="set-row" :class="{ open: isOpen('pw') }" @click="toggleRow('pw')">
          <span class="set-ico" aria-hidden="true">&#128273;</span>
          <span class="set-label">{{ t("settings.pwRow") }}</span>
          <span class="set-val"></span>
          <span class="set-arrow" :class="{ on: isOpen('pw') }">&#9662;</span>
        </div>
        <div v-if="isOpen('pw')" class="set-panel">
          <div class="set-opts wrap pw-row">
            <van-field
              v-if="!isGoogle"
              v-model="pwOld" type="password" show-password-on="click"
              :placeholder="t('settings.pwOld')" :disabled="pwBusy" />
            <van-field
              v-model="pwNew" type="password" show-password-on="click"
              :placeholder="t('settings.pwNew', { n: MIN_PASSWORD })" :disabled="pwBusy" />
            <van-field
              v-model="pwConfirm" type="password" show-password-on="click"
              :placeholder="t('settings.pwConfirm')" :disabled="pwBusy" />
            <button class="set-opt" :disabled="pwBusy" @click="savePw">
              {{ t("settings.pwSave") }}
            </button>
          </div>
          <p v-if="pwMsg" class="streak-note">{{ pwMsg }}</p>
          <p class="sub">{{ isGoogle ? t("settings.pwGoogleHint") : t("settings.pwHint") }}</p>
        </div>
      </template>

      <div v-else class="set-row" @click="goLogin">
        <span class="set-ico" aria-hidden="true">&#128274;</span>
        <span class="set-label">{{ t("profile.goSignIn") }}</span>
        <span class="set-val"></span>
        <span class="set-arrow on">&#8250;</span>
      </div>

      <!-- 轮406：已拉黑名单从消息列表迁到「账号」下方。
           轮409：点整行进入独立页，不在设置页内展开。 -->
      <router-link v-if="cloudSigned" class="set-row link" to="/settings/blocked">
        <span class="set-ico" aria-hidden="true">&#128683;</span>
        <span class="set-label">{{ t("dm.blockedTitle") }}</span>
        <span class="set-val set-mini">{{ blockedCount || "" }}</span>
        <span class="set-arrow on">&#8250;</span>
      </router-link>
    </section>

    <!-- 通知：总开关 + 三类偏好（#23 私信已退出通知中心，无开关） -->
    <section class="card set-group">
      <span class="sec-label set-cap">{{ t("settings.notifRow") }}</span>
      <template v-if="cloudSigned">
        <div class="set-row" @click.stop="toggleMaster">
          <span class="set-ico" aria-hidden="true">&#128276;</span>
          <span class="set-label">{{ t("notif.prefs") }}</span>
          <span class="set-val set-mini">{{ masterOn ? t("settings.on") : t("settings.off") }}</span>
          <span class="set-switch" :class="{ on: masterOn, 'no-anim': !prefsReady }" aria-hidden="true">
            <span class="knob"></span>
          </span>
        </div>
        <div
          v-for="x in PREFS" :key="x.key"
          class="set-row sub-row" :class="{ dim: !masterOn }"
          @click.stop="masterOn && togglePref(x.key)">
          <span class="set-label">{{ t(x.tk) }}</span>
          <span class="set-val set-mini">{{ prefs[x.key] ? t("settings.on") : t("settings.off") }}</span>
          <span class="set-switch sm" :class="{ on: prefs[x.key] && masterOn, 'no-anim': !prefsReady }" aria-hidden="true">
            <span class="knob"></span>
          </span>
        </div>
        <p v-if="prefsMsg" class="streak-note">{{ t(prefsMsg) }}</p>
      </template>
      <p v-else class="notice">{{ t("notif.needSignIn") }}</p>
    </section>

    <!-- 危险区：删号两步确认（登录才可见） -->
    <section v-if="cloudSigned" class="card set-group danger">
      <span class="sec-label set-cap danger-cap">{{ t("settings.dangerZone") }}</span>
      <div class="set-row" :class="{ open: isOpen('del') }" @click="toggleRow('del')">
        <span class="set-ico" aria-hidden="true">&#128465;&#xFE0F;</span>
        <span class="set-label danger-t">{{ t("settings.delTitle") }}</span>
        <span class="set-val"></span>
        <span class="set-arrow" :class="{ on: isOpen('del') }">&#9662;</span>
      </div>
      <div v-if="isOpen('del')" class="set-panel">
        <p class="sub">{{ t("settings.delWarn") }}</p>
        <div class="set-opts wrap">
          <template v-if="!delArm">
            <button class="set-opt danger" @click="armDelete">{{ t("settings.delBtn") }}</button>
          </template>
          <template v-else>
            <button class="set-opt danger" :disabled="delBusy" @click="doDelete">
              {{ t("settings.delAsk") }}
            </button>
            <button class="set-opt" :disabled="delBusy" @click="disarmDelete">
              {{ t("common.cancel") }}
            </button>
          </template>
        </div>
        <p v-if="delMsg" class="streak-note">{{ delMsg }}</p>
      </div>
    </section>

    <!-- 关于 -->
    <section class="card set-group">
      <span class="sec-label set-cap">{{ t("settings.about") }}</span>
      <router-link class="set-row link" to="/privacy">
        <span class="set-ico" aria-hidden="true">&#128220;</span>
        <span class="set-label">{{ t("privacy.title") }}</span>
        <span class="set-val"></span>
        <span class="set-arrow on">&#8250;</span>
      </router-link>
      <div v-if="isMobileNav" class="set-row link" @click="goBack">
        <span class="set-ico" aria-hidden="true">&#128054;</span>
        <span class="set-label">{{ t("nav.profile") }}</span>
        <span class="set-val"></span>
        <span class="set-arrow on">&#8250;</span>
      </div>
      <!-- 轮 297 · 版本行 + 手动检查更新；轮 309（用户拍板）整块只给 App 壳 ——
           浏览器（手机+桌面）刷新即最新，版本行/检查按钮/提示一概不显示 -->
      <div v-if="isApp" class="set-row">
        <span class="set-ico" aria-hidden="true">&#128241;</span>
        <span class="set-label">{{ t("appUpdate.currentVer", { v: curVer ? curVer.name : "—" }) }}</span>
        <span class="set-val"></span>
        <button class="set-check" :disabled="updChecking" @click="checkUpdates">
          {{ t("appUpdate.checkBtn") }}
        </button>
      </div>
      <p v-if="isApp && updMsg" class="streak-note">{{ updMsg }}</p>
    </section>

    <UpdateDialog v-if="isApp" v-model:show="updOpen" :current="curVer" :latest="updLatest" />
  </div>
</template>

<style scoped>
/* 轮 137：桌面流式壳（轮 133 起）下不再收窄居中——铺满左导航与右栏之间的整块宽度；
 * 窄屏/App 形态不受影响（860 的 max-width 在 <900px 视口本就触不到）。 */
.set-page { max-width: 860px; margin: 0 auto; }
@media (min-width: 900px) { .set-page { max-width: none; } }
.set-top { display: flex; align-items: flex-start; gap: 10px; margin: 2px 0 12px; }
.set-back {
  appearance: none; font: inherit; cursor: pointer;
  min-width: 40px; min-height: 40px; border-radius: 999px;
  border: 1px solid rgba(160, 110, 60, .2); background: rgba(255, 255, 255, .7);
  font-weight: 500; font-size: 16px; flex: none;
}
.set-top-t h1 { font-size: 20px; margin: 0; }
.set-top-t .sub { margin: 2px 0 0; }

/* 用户卡 */
.set-user { display: flex; align-items: center; gap: 14px; }
.set-avatar {
  width: 54px; height: 54px; border-radius: 50%; flex: none;
  display: flex; align-items: center; justify-content: center;
  font-size: 24px; font-weight: 500; color: #fff;
  background: var(--accent);
  /* 轮 527：原来这里是旧品牌橙 rgba(240,132,47,.25) —— 轮 120 全站换陶土那次漏掉的老色。
   * 它不看主题：薄荷/薰衣草/樱粉主题下都是一圈橙影。改成中性墨影，只做接触感、不表色。 */
  box-shadow: 0 6px 14px rgba(58, 46, 42, .14);
}
.set-avatar.paw { background: var(--accent-soft); color: var(--accent-deep); font-size: 26px; box-shadow: none; }
/* 轮 238:设置页头像 = 萌宠头像池（图盖满圆框；未登录落回爪印） */
.set-avatar-img { width: 100%; height: 100%; border-radius: 50%; object-fit: cover; display: block; }
.set-user-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.set-user-name { font-size: 16px; }
.set-user-mail { font-size: 12px; overflow-wrap: anywhere; }
.set-go {
  appearance: none; font: inherit; cursor: pointer; flex: none;
  border: none; border-radius: 999px; padding: 9px 16px;
  font-weight: 500; font-size: 13px; color: #fff; background: var(--accent);
}
.set-go:hover { filter: brightness(1.05); }

/* 分组 */
.set-group { padding: 4px 0 10px; }
.set-cap { display: block; padding: 10px 16px 4px; }
.danger-cap { color: var(--low); }

/* 行：左图标 + 标签 + 当前值 + 箭头/开关 */
.set-row {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 16px; cursor: pointer; border-radius: 12px;
  transition: background .15s ease; user-select: none;
}
.set-row:hover { background: var(--accent-soft); }
.set-row.link { text-decoration: none; color: inherit; }
.set-row.sub-row { padding-top: 9px; padding-bottom: 9px; padding-left: 56px; }
.set-row.sub-row.dim { opacity: .55; }
.set-ico {
  width: 30px; height: 30px; border-radius: 10px; flex: none;
  background: var(--accent-soft); display: flex; align-items: center; justify-content: center;
  font-size: 15px;
}
.set-label { flex: 1; font-size: 14px; font-weight: 500; min-width: 0; }
.danger-t { color: var(--low); }
.set-val { font-size: 12.5px; color: var(--ink-soft); max-width: 44%; overflow-wrap: anywhere; text-align: right; }
.set-val.set-mini { flex: none; max-width: none; }
.set-arrow { color: var(--ink-faint); font-size: 14px; flex: none; transition: transform .18s ease; }
.set-arrow.on { transform: rotate(180deg); }

/* 展开面板 */
.set-panel { padding: 2px 16px 12px 56px; display: flex; flex-direction: column; gap: 8px; }
.set-panel .set-opts { margin-top: 0; }
/* 轮 476：.set-hint / .set-hint-soft 随通知区的两段介绍文字一起退役（用户嫌字多） */

/* 开关 */
.set-switch {
  width: 40px; height: 22px; border-radius: 999px; flex: none;
  background: rgba(160, 110, 60, .22); position: relative;
  transition: background .18s ease;
}
.set-switch.sm { width: 36px; height: 20px; }
/* 首屏校准期间不动画：否则每次重进设置都会看到关闭动画重播一次 */
.set-switch.no-anim, .set-switch.no-anim .knob { transition: none; }
.set-switch .knob {
  position: absolute; top: 2px; left: 2px; width: 18px; height: 18px;
  border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, .2);
  transition: transform .18s ease;
}
.set-switch.on { background: var(--accent); }
.set-switch.on .knob { transform: translateX(18px); }
.set-switch.sm.on .knob { transform: translateX(16px); }

/* 轮 297 · 「检查更新」小按钮（跟在版本号右侧，不做成整行可点以免误触） */
.set-check {
  appearance: none; font: inherit; font-size: 12px; cursor: pointer;
  padding: 4px 10px; border-radius: 999px; border: 1px solid rgba(160, 110, 60, .28);
  background: transparent; color: var(--low, #8a7a6a);
  transition: background .18s ease, color .18s ease;
}
.set-check:not(:disabled):hover { background: var(--glass, rgba(255, 240, 226, .6)); color: var(--accent, #e58a3a); }
.set-check:disabled { opacity: .55; cursor: default; }

/* ═════════ 手机端设置页（≤640）═════════
 * 桌面端保持原来的「顶部身份卡 + 分组行」不动；这里只重排窄屏：
 * 身份卡变成暖色主视觉，分组用独立卡片和分隔线，选项改成两列网格，
 * 行高、开关、输入框都按 44px 以上的触控目标放大。 */
@media (max-width: 640px) {
  .set-page { padding-bottom: max(10px, env(safe-area-inset-bottom, 0px)); }

  /* 顶栏：大标题 + 圆角返回键 */
  .set-top { align-items: center; gap: 12px; margin: 4px 2px 14px; }
  .set-back {
    width: 42px; height: 42px; min-width: 42px; min-height: 42px;
    border-radius: 15px; border: 1px solid var(--hairline);
    background: var(--glass-strong); color: var(--ink);
    box-shadow: 0 4px 12px rgba(83, 51, 30, .07);
    font-size: 18px; line-height: 1;
  }
  .set-top-t { min-width: 0; }
  .set-top-t h1 {
    font-family: var(--font-display); font-size: 26px;
    line-height: 1.2; letter-spacing: -.4px;
  }
  .set-top-t .sub {
    margin-top: 4px; font-size: 12.5px; line-height: 1.45;
    color: var(--ink-faint);
  }

  /* 身份卡：暖色渐变主视觉，不再是普通白卡 */
  .set-user {
    position: relative; overflow: hidden;
    padding: 20px 18px;
    color: #fff;
    /* glass.css 给 .card 的 background / border / radius 都是 !important，
       手机端身份卡要盖过它，否则会退回普通白卡、白字直接看不见。 */
    border: 0 !important;
    border-radius: 24px !important;
    /* 轮 527 · 第二档原来写的是 var(--accent-deep)。彩色主题里它是同族深色，没问题；
     * 但夜间主题为了「页签字压在深底上读得出来」，glass.css 把 --accent-deep 单独改成了
     * 浅陶土 #E8A184 —— 于是星夜蓝主题下这张卡从蓝渐变到陶土，成了日落色，跟整页的蓝对不上。
     * 现在第二档不用 accent-deep，改成一层「左上高光 → 右下压暗」的斜向罩子叠在纯主色上：
     * 哪个主题都只在主色自己身上做深浅，不会跨色相。 */
    background:
      linear-gradient(135deg, rgba(255, 255, 255, .14), rgba(0, 0, 0, .20)),
      var(--accent) !important;
    box-shadow: 0 14px 30px rgba(150, 82, 48, .22) !important;
  }
  .set-user::before {
    content: ""; position: absolute; top: -72px; right: -44px;
    width: 160px; height: 160px; border-radius: 50%;
    background: rgba(255, 255, 255, .16); pointer-events: none;
  }
  .set-user::after {
    content: "\1F43E"; position: absolute; right: 16px; bottom: -10px;
    font-size: 66px; line-height: 1; opacity: .10;
    transform: rotate(-15deg); pointer-events: none;
  }
  .set-avatar {
    width: 62px; height: 62px; font-size: 26px;
    background: rgba(255, 255, 255, .20); color: #fff;
    box-shadow: inset 0 0 0 2px rgba(255, 255, 255, .40), 0 6px 16px rgba(80, 40, 20, .16);
  }
  .set-avatar.paw { background: rgba(255, 255, 255, .18); color: #fff; }
  .set-user-body { gap: 4px; }
  .set-user-name {
    font-size: 18px; font-weight: 600; letter-spacing: -.2px;
    overflow-wrap: anywhere;
  }
  .set-user-mail, .set-user .sub {
    color: rgba(255, 255, 255, .80) !important;
    font-size: 12px; line-height: 1.45;
  }
  .set-go {
    min-height: 40px; padding: 0 16px; border-radius: 13px;
    background: #fff; color: var(--accent-deep);
    font-size: 13px; font-weight: 600;
    box-shadow: 0 6px 14px rgba(70, 35, 20, .14);
  }
  /* 游客态：昵称/提示和按钮挤在一行时「Not signed in」会被压成两行，
     手机端改成第一行头像+文案、第二行整宽按钮。 */
  .set-user--guest { flex-wrap: wrap; }
  .set-user--guest .set-user-body { flex: 1 1 160px; }
  .set-user--guest .set-go { flex: 0 0 100%; width: 100%; margin-top: 4px; }

  /* 分组卡片与小标题 */
  .set-group {
    padding: 0 0 8px; margin-bottom: 14px;
    border-radius: 22px !important; border-color: rgba(160, 110, 60, .13) !important;
    background: var(--g-bg-card, var(--wash-strong)) !important;
    box-shadow: 0 8px 22px rgba(83, 51, 30, .055), inset 0 1px 0 rgba(255, 255, 255, .88) !important;
  }
  .set-group.danger {
    background: rgba(255, 246, 243, .88) !important;
    border-color: rgba(198, 69, 69, .16) !important;
  }
  .set-cap {
    display: flex; align-items: center; gap: 10px;
    padding: 14px 18px 6px;
    font-size: 10.5px; letter-spacing: .18em;
    color: var(--ink-faint); opacity: 1;
  }
  .set-cap::after {
    content: ""; flex: 1; height: 1px; border-radius: 1px;
    background: var(--hairline);
  }
  .danger-cap { color: var(--low); }
  .danger-cap::after { background: rgba(198, 69, 69, .16); }

  /* 行：更大的触控高度、圆角图标、发丝分隔线 */
  .set-row {
    min-height: 56px; padding: 10px 14px; gap: 12px;
    border-radius: 14px; -webkit-tap-highlight-color: transparent;
  }
  .set-row:hover { background: transparent; }
  .set-row:active { background: var(--accent-soft); }
  .set-row + .set-row { position: relative; }
  .set-row + .set-row::before {
    content: ""; position: absolute; top: 0; left: 60px; right: 16px;
    height: 1px; background: var(--hairline); opacity: .8;
    pointer-events: none;
  }
  .set-ico {
    width: 34px; height: 34px; border-radius: 11px; font-size: 16px;
    background: linear-gradient(135deg, var(--accent-soft), var(--wash-strong));
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .55);
  }
  .set-label { font-size: 14.5px; line-height: 1.35; }
  .set-val { max-width: 40%; font-size: 12px; line-height: 1.4; }
  .set-arrow {
    width: 26px; height: 26px; display: inline-flex;
    align-items: center; justify-content: center;
    border-radius: 50%; background: var(--wash-mid);
    font-size: 12px; color: var(--ink-faint);
  }
  .set-row.link .set-arrow.on { transform: none; }
  .set-row.sub-row {
    min-height: 50px; padding-top: 8px; padding-bottom: 8px;
    padding-left: 60px;
  }
  .set-row.sub-row .set-label { font-size: 13.5px; color: var(--ink-soft); }
  .set-row.sub-row.dim { opacity: .45; }

  /* 开关放大，和 56px 行高匹配 */
  .set-switch { width: 46px; height: 26px; }
  .set-switch .knob { width: 22px; height: 22px; }
  .set-switch.on .knob { transform: translateX(20px); }
  .set-switch.sm { width: 42px; height: 24px; }
  .set-switch.sm .knob { width: 20px; height: 20px; }
  .set-switch.sm.on .knob { transform: translateX(18px); }

  /* 主题 / 语言：两列选项卡片，选中态用主题色填满 */
  .set-group > .set-opts {
    display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px; margin: 4px 14px 10px; padding: 8px;
    border-radius: 16px; background: var(--accent-soft);
  }
  .set-group > .set-opts .set-opt {
    width: 100%; min-height: 42px; padding: 0 10px;
    border: 1.5px solid transparent; border-radius: 11px;
    background: var(--wash-strong); color: var(--ink-soft);
    font-size: 13px; white-space: nowrap;
  }
  .set-group > .set-opts .set-opt.on {
    background: var(--accent); border-color: var(--accent);
    color: #fff; font-weight: 600;
    box-shadow: 0 4px 10px rgba(150, 82, 48, .16);
  }
  /* 语言有 5 项：最后一项独占一行，避免右下角留一个空网格 */
  .set-group > .set-opts > .set-opt:last-of-type:nth-child(odd) {
    grid-column: 1 / -1;
  }
  .lang-pref {
    grid-column: 1 / -1; margin-top: 0; padding: 12px;
    border: 1px solid var(--hairline); border-radius: 13px;
    background: var(--wash-strong);
  }
  .lang-pref :deep(.van-switch) { flex: 0 0 auto; }
  .lang-pref-title { font-size: 13.5px; }
  .lang-pref-hint { font-size: 11.5px; line-height: 1.5; }

  /* 展开面板：去掉桌面端的 56px 左缩进，字段与按钮铺满 */
  .set-panel { padding: 2px 14px 14px; gap: 10px; }
  .set-panel .set-opts.wrap {
    display: flex; flex-direction: column; gap: 8px;
    margin: 0; width: 100%;
  }
  .set-panel .set-opt {
    width: 100%; min-height: 44px; border-radius: 12px;
    font-size: 13.5px;
  }
  .set-panel .set-opts.nick-row { flex-direction: row; align-items: center; }
  .set-panel .nick-row :deep(.van-field) { flex: 1; min-width: 0; }
  .set-panel .nick-row .set-opt { width: auto; flex: none; padding: 0 16px; }
  .set-panel :deep(.van-field) {
    min-height: 44px; padding: 8px 12px;
    border-radius: 12px; background: var(--wash-mid);
  }
  .set-panel :deep(.van-field__control) { font-size: 14px; color: var(--ink); }
  .set-panel :deep(.van-field__control::placeholder) { color: var(--ink-faint); }
  .set-panel .sub {
    margin: 0 2px; font-size: 12px; line-height: 1.55;
    color: var(--ink-faint);
  }
  .set-panel .streak-note { margin: 0 2px; font-size: 12px; }

  /* 未登录通知提示：做成轻量空状态 */
  .set-group .notice {
    margin: 4px 14px 10px; padding: 16px 14px;
    border-radius: 14px; background: var(--wash-mid);
    font-size: 12.5px; line-height: 1.6; text-align: center;
  }
  .set-group .notice::before {
    content: "\1F514"; display: block; margin-bottom: 6px;
    font-size: 20px; filter: grayscale(.15);
  }

  /* 危险区：整组浅红底，按钮保留红调 */
  .set-group.danger .set-ico {
    background: rgba(198, 69, 69, .10);
    box-shadow: inset 0 0 0 1px rgba(198, 69, 69, .08);
  }
  .set-group.danger .set-opt.danger {
    background: rgba(198, 69, 69, .10);
    border-color: rgba(198, 69, 69, .24);
    color: var(--low);
  }
  .set-group.danger .set-opt.danger:active { background: rgba(198, 69, 69, .17); }
  .set-group.danger .set-panel .sub { color: var(--low); opacity: .85; }

  /* App 版本行的手动检查按钮也放到触控尺寸 */
  .set-check {
    min-height: 34px; padding: 0 12px; border-radius: 10px;
    font-size: 12px;
  }
}

@media (max-width: 360px) {
  .set-top-t h1 { font-size: 23px; }
  .set-user { padding: 18px 14px; gap: 12px; }
  .set-user-name { font-size: 16px; }
  .set-go { padding: 0 12px; }
  .set-group > .set-opts { grid-template-columns: 1fr; }
}
</style>
