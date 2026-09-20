<template>
  <div class="settings-page">
    <section class="card">
      <h1 class="settings-title">{{ t("settings.title") }}</h1>
      <p class="sub">{{ t("settings.sub") }}</p>

      <!-- 皮肤（#13：从顶部栏迁来；选择即生效并持久化） -->
      <div class="set-block">
        <span class="sec-label">{{ t("settings.theme") }}</span>
        <div class="set-opts">
          <button
            v-for="o in themeOptions" :key="o.key"
            class="set-opt" :class="{ on: themeKey === o.key }"
            @click="applyTheme(o.key)">
            {{ o.label }}
          </button>
        </div>
      </div>

      <!-- 语言 -->
      <div class="set-block">
        <span class="sec-label">{{ t("settings.language") }}</span>
        <div class="set-opts">
          <button
            v-for="o in langOptions" :key="o.key"
            class="set-opt" :class="{ on: i18n.locale === o.key }"
            @click="onLangPick(o.key)">
            {{ o.label }}
          </button>
        </div>
      </div>

      <!-- 昵称（登录用户改云端 profiles，署名/主页即时生效；游客先去「我的」页登录） -->
      <div class="set-block">
        <span class="sec-label">{{ t("profile.nickTitle") }}</span>
        <template v-if="signedIn">
          <div class="set-opts wrap nick-row">
            <n-input
              v-model:value="nickDraft" :placeholder="cloud.nickname || t('profile.needNick')"
              :maxlength="NICK_MAX" :disabled="nickBusy" @keyup.enter="saveNick" />
            <button class="set-opt" :disabled="nickBusy" @click="saveNick">
              {{ t("profile.nickSave") }}
            </button>
          </div>
          <p v-if="nickMsg" class="streak-note">{{ nickMsg }}</p>
          <p class="sub">{{ t("profile.nickHint") }}</p>
        </template>
        <p v-else class="notice">{{ t("notif.needSignIn") }}</p>
      </div>

      <!-- 密码（#27：邮箱用户验旧密码后改；谷歌用户直接设新密码，之后可用邮箱＋密码登录） -->
      <div class="set-block">
        <span class="sec-label">{{ t("settings.password") }}</span>
        <template v-if="signedIn">
          <div class="set-opts wrap pw-row">
            <n-input
              v-if="!isGoogle"
              v-model:value="pwOld" type="password" show-password-on="click"
              :placeholder="t('settings.pwOld')" :disabled="pwBusy" />
            <n-input
              v-model:value="pwNew" type="password" show-password-on="click"
              :placeholder="t('settings.pwNew', { n: MIN_PASSWORD })" :disabled="pwBusy" />
            <n-input
              v-model:value="pwConfirm" type="password" show-password-on="click"
              :placeholder="t('settings.pwConfirm')" :disabled="pwBusy" />
            <button class="set-opt" :disabled="pwBusy" @click="savePw">
              {{ t("settings.pwSave") }}
            </button>
          </div>
          <p v-if="pwMsg" class="streak-note">{{ pwMsg }}</p>
          <p class="sub">{{ isGoogle ? t("settings.pwGoogleHint") : t("settings.pwHint") }}</p>
        </template>
        <p v-else class="notice">{{ t("notif.needSignIn") }}</p>
      </div>

      <!-- 删号（App 轨道 T3 · Play 2024 政策硬门槛）：危险区两步确认，删除后立即退出登录 -->
      <div class="set-block">
        <span class="sec-label">{{ t("settings.delTitle") }}</span>
        <template v-if="signedIn">
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
        </template>
        <p v-else class="notice">{{ t("notif.needSignIn") }}</p>
      </div>
    </section>

    <!-- 通知（#13/#14：总开关 + 四类偏好，从通知中心页迁来） -->
    <section class="card">
      <div class="row-between">
        <span class="sec-label">{{ t("notif.prefs") }}</span>
      </div>
      <p class="sub">{{ t("notif.prefsHint") }}</p>

      <template v-if="signedIn">
        <!-- 总开关：关 = 数据库四类全关（真的不再投递）；开 = 回到下面四类的各自选择 -->
        <div class="set-block">
          <button
            class="set-opt master" :class="{ on: masterOn }" :disabled="prefsBusy"
            @click="toggleMaster">
            {{ masterOn ? t("settings.masterOn") : t("settings.masterOff") }}
          </button>
        </div>

        <div class="set-block" :class="{ dimmed: !masterOn }">
          <div class="set-opts wrap">
            <button
              v-for="x in PREFS" :key="x.key"
              class="set-opt" :class="{ on: prefs[x.key] }" :disabled="!masterOn || prefsBusy"
              @click="togglePref(x.key)">
              {{ t(x.tk) }} · {{ prefs[x.key] ? t("settings.on") : t("settings.off") }}
            </button>
          </div>
        </div>
        <p v-if="prefsMsg" class="streak-note">{{ t(prefsMsg) }}</p>
      </template>
      <p v-else class="notice">{{ t("notif.needSignIn") }}</p>
    </section>

    <!-- 隐私政策（手机端 7：从页脚挪进来；/privacy 路由保留供外部审核直接访问） -->
    <router-link class="notif-back" to="/privacy">{{ t("privacy.title") }}</router-link>
    <router-link class="notif-back" to="/profile">{{ "← " + t("nav.profile") }}</router-link>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from "vue";
import { NInput } from "naive-ui";
import { t, i18n } from "../i18n.js";
import { cloud, cloudUpdateNickname, cloudChangePassword, cloudDeleteAccount } from "../utils/supabase.js";
import { NICK_MAX, MIN_PASSWORD, passwordProblem } from "../utils/authRules.js";
import * as notifyApi from "../utils/notify.js";
import { normPrefs } from "../utils/notifyRules.js";
import {
  themeKey, themeOptions, applyTheme,
  langOptions, onLangPick,
} from "../stores/uiStore.js";

/* #13 皮肤 / 语言 / 总通知开关 / 通知四类偏好，全部收进设置页 */

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

/* —— 自助删号（T3 · Play 2024 政策）：两步确认（先亮出警示，再点「真的要删除吗」执行）——
 * 成功后账号已从云端消失（cloudDeleteAccount 内部已 signOut），本页给出告别语。 */
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
  /* #23 私信退出通知中心：dm 通知在库里已不生成（MIGRATION_notifications_drop_dm.sql），
     「私信」开关随之移除（保留会给用户「关了就该生效」的错觉） */
  { key: "comments", tk: "notif.prefComments" },
  { key: "reactions", tk: "notif.prefReactions" },
  { key: "pets", tk: "notif.prefPets" },
];

const signedIn = computed(() => !!(cloud.ready && cloud.user));
const prefs = ref({ comments: true, reactions: true, pets: true, dms: true });
const prefsBusy = ref(false);
const prefsMsg = ref("");
const masterOn = computed(() => PREFS.some((x) => prefs.value[x.key]));

async function loadPrefs() {
  if (!signedIn.value) return;
  try {
    prefs.value = normPrefs(await notifyApi.prefsGet());
  } catch (e) { /* 缺行 = 全开，normPrefs 已兜底 */ }
}

async function savePrefs(next) {
  prefsBusy.value = true;
  prefsMsg.value = "";
  try {
    await notifyApi.prefsSet(next);
    prefs.value = normPrefs(next);
    prefsMsg.value = "notif.prefsSaved";
  } catch (e) {
    prefsMsg.value = "notif.loadFail";
  } finally { prefsBusy.value = false; }
}

/* 总开关：关 = 全关（服务器不再投递任何通知）；开 = 全开（回到默认收齐） */
function toggleMaster() {
  if (masterOn.value) {
    savePrefs({ comments: false, reactions: false, pets: false });
  } else {
    savePrefs({ comments: true, reactions: true, pets: true });
  }
}
function togglePref(key) {
  const next = { ...prefs.value, [key]: !prefs.value[key] };
  savePrefs(next);
}

onMounted(() => { loadPrefs(); });
</script>
