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

    <router-link class="notif-back" to="/profile">{{ "← " + t("nav.profile") }}</router-link>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from "vue";
import { t, i18n } from "../i18n.js";
import { cloud } from "../utils/supabase.js";
import * as notifyApi from "../utils/notify.js";
import { normPrefs } from "../utils/notifyRules.js";
import {
  themeKey, themeOptions, applyTheme,
  langOptions, onLangPick,
} from "../stores/uiStore.js";

/* #13 皮肤 / 语言 / 总通知开关 / 通知四类偏好，全部收进设置页 */

const PREFS = [
  { key: "comments", tk: "notif.prefComments" },
  { key: "reactions", tk: "notif.prefReactions" },
  { key: "pets", tk: "notif.prefPets" },
  { key: "dms", tk: "notif.prefDms" },
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

/* 总开关：关 = 四类全关（服务器不再投递任何通知）；开 = 全开（回到默认收齐） */
function toggleMaster() {
  if (masterOn.value) {
    savePrefs({ comments: false, reactions: false, pets: false, dms: false });
  } else {
    savePrefs({ comments: true, reactions: true, pets: true, dms: true });
  }
}
function togglePref(key) {
  const next = { ...prefs.value, [key]: !prefs.value[key] };
  savePrefs(next);
}

onMounted(() => { loadPrefs(); });
</script>
