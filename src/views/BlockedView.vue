<!-- 已拉黑名单（/settings/blocked）：轮409 从设置页的展开面板改为独立页。 -->
<script setup>
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { NAvatar, NButton } from "naive-ui";
import { t } from "../i18n.js";
import { cloud } from "../utils/supabase.js";
import { blockState, refreshBlocks, unblockUser } from "../utils/userBlocks.js";
import { avatarUrlFor } from "../utils/avatar.js";

const router = useRouter();
const signedIn = computed(() => !!(cloud.ready && cloud.user));
const rows = computed(() => {
  const ids = Array.isArray(blockState.ids) ? blockState.ids : [];
  const list = Array.isArray(blockState.rows) ? blockState.rows : [];
  if (!ids.length) return list.filter((r) => r && r.user_id);
  const byId = new Map(list.filter((r) => r && r.user_id).map((r) => [r.user_id, r]));
  return ids.map((id) => byId.get(id) || { user_id: id, nickname: "", created_at: "" });
});
const loading = computed(() => blockState.loading && !rows.value.length);
const loadError = computed(() => blockState.error && !rows.value.length);
const busy = ref("");
const msg = ref("");

function goBack() {
  /* 有历史就退回去；直链进来（无历史）就回设置页 */
  if (typeof window !== "undefined" && window.history.state && window.history.state.back != null) {
    router.back();
  } else {
    router.replace("/settings").catch(() => {});
  }
}
function goSignIn() {
  router.push({ path: "/login", query: { redirect: "/settings/blocked" } });
}
async function load() {
  msg.value = "";
  await refreshBlocks();
}
async function unblockOne(b) {
  if (busy.value) return;
  busy.value = b.user_id;
  msg.value = "";
  try {
    await unblockUser(b.user_id);
  } catch (e) {
    msg.value = t("dm.errNetwork");
  } finally {
    busy.value = "";
  }
}
onMounted(() => { if (signedIn.value) load(); });
watch(signedIn, (v) => { if (v) load(); });
</script>

<template>
  <div class="blocked-page">
    <header class="blocked-head">
      <button class="blocked-back" aria-label="back" @click="goBack">&#8592;</button>
      <div class="blocked-head-t">
        <h1>{{ t("dm.blockedTitle") }}</h1>
        <p v-if="signedIn" class="sub">{{ t("dm.blockedHint") }}</p>
      </div>
      <button
        v-if="signedIn" class="blocked-refresh"
        :disabled="blockState.loading" :aria-label="t('community.refreshBtn')"
        @click="load">
        &#8635;
      </button>
    </header>

    <section v-if="!signedIn" class="card blocked-signin">
      <p class="sub">{{ t("notif.needSignIn") }}</p>
      <n-button type="primary" round @click="goSignIn">{{ t("profile.goSignIn") }}</n-button>
    </section>

    <template v-else>
      <p v-if="loading" class="card sub blocked-note">…</p>
      <p v-else-if="loadError" class="card sub blocked-note">{{ t("dm.errNetwork") }}</p>
      <p v-else-if="!rows.length" class="card sub blocked-note">{{ t("dm.blockedEmpty") }}</p>

      <template v-else>
        <p v-if="msg" class="blocked-msg">{{ msg }}</p>
        <section class="card blocked-list">
          <div v-for="b in rows" :key="b.user_id" class="blocked-row">
            <n-avatar round :size="40" :src="avatarUrlFor(b.user_id) || undefined">
              <template v-if="!avatarUrlFor(b.user_id)" #default>{{ (b.nickname || "?").slice(0, 1).toUpperCase() }}</template>
              <template v-else #fallback>{{ (b.nickname || "?").slice(0, 1).toUpperCase() }}</template>
            </n-avatar>
            <b class="blocked-name">{{ b.nickname || t("dm.someone") }}</b>
            <button
              class="blocked-unblock" :disabled="busy === b.user_id"
              @click="unblockOne(b)">
              {{ t("dm.blockedGo") }}
            </button>
          </div>
        </section>
      </template>
    </template>
  </div>
</template>

<style scoped>
.blocked-page { max-width: 860px; margin: 0 auto; }
@media (min-width: 900px) { .blocked-page { max-width: none; } }
.blocked-head { display: flex; align-items: flex-start; gap: 10px; margin: 2px 0 12px; }
.blocked-head-t { flex: 1; min-width: 0; }
.blocked-head h1 { font-size: 20px; margin: 0; }
.blocked-head .sub { margin: 2px 0 0; }
.blocked-back, .blocked-refresh {
  appearance: none; font: inherit; cursor: pointer;
  min-width: 40px; min-height: 40px; border-radius: 999px;
  border: 1px solid rgba(160, 110, 60, .2); background: rgba(255, 255, 255, .7);
  font-weight: 500; font-size: 16px; flex: none;
}
.blocked-refresh:disabled { opacity: .5; cursor: default; }
.blocked-signin {
  text-align: center; display: grid; gap: 10px;
  justify-items: center; padding: 18px 14px;
}
.blocked-note { margin: 0; }
.blocked-msg { margin: 0 0 8px; font-size: 12.5px; color: var(--low, #b45c4a); }
.blocked-list { padding: 4px 0; }
.blocked-row {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 16px; border-bottom: 1px solid var(--hairline);
}
.blocked-row:last-child { border-bottom: 0; }
.blocked-name {
  flex: 1; min-width: 0; font-size: 14px; font-weight: 500;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.blocked-unblock {
  appearance: none; font: inherit; cursor: pointer; flex: none;
  padding: 6px 14px; border-radius: 999px;
  border: 1px solid rgba(160, 110, 60, .25);
  background: transparent; color: var(--ink-soft);
  font-size: 12.5px; font-weight: 500;
  transition: all .18s ease;
}
.blocked-unblock:hover { color: var(--low); border-color: var(--low); }
.blocked-unblock:disabled { opacity: .5; cursor: default; }
html[data-theme="night"] .blocked-back, html[data-theme="night"] .blocked-refresh {
  background: rgba(30, 35, 64, .6); border-color: rgba(255, 255, 255, .14);
}
</style>
