/* 绉佷俊锛?messages 浼氳瘽鍒楄〃锛?messages/:id 鍏蜂綋浼氳瘽锛?
 * ------------------------------------------------------------
 * 澶х珯鍋氭硶锛?
 *  - 宸﹀垪浼氳瘽鍒楄〃锛堝ご鍍?/ 鏄电О / 鏈€鍚庝竴鏉￠瑙?/ 鐩稿鏃堕棿 / 鏈绾㈢偣 / 鍏嶆墦鎵板浘鏍囷級锛?
 *  - 鎼滅储妗嗚繃婊や細璇濓紱銆屾秷鎭姹傘€嶅崟鐙垎缁勶紙闄岀敓浜洪鏉℃秷鎭紝鍚屾剰鍚庢墠杩涘垪琛級锛?
 *  - 鍙冲垪姘旀场瀵硅瘽锛氭垜鐨勯潬鍙炽€佸鏂归潬宸︺€佽法澶╂棩鏈熷垎闅斻€侀《閮ㄣ€屽姞杞芥洿鏃┿€嶅垎椤碉紱
 *  - 鍙戦€侊細Enter 鍙戦€?/ Shift+Enter 鎹㈣銆佷箰瑙備笂灞?+ 鍙戦€佷腑/澶辫触鏍囪锛?
 *  - 鎾ゅ洖锛?5 鍒嗛挓鍐咃紝鏄剧ず銆屽凡鎾ゅ洖銆嶅崰浣嶏級銆佸厤鎵撴壈銆侀殣钘忎細璇濄€佹媺榛?瑙ｉ櫎锛?
 *  - 鎵撳紑浼氳瘽鍗虫姮宸茶姘翠綅锛堟湇鍔＄ dm_mark_read锛夛紱婊氬姩鍒板簳閮紱浠呭湪鍙鏃惰疆璇㈡柊娑堟伅銆?
 */
<script setup>
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch, defineAsyncComponent, onActivated, onDeactivated } from "vue";
import { useRoute, useRouter } from "vue-router";
import { NButton, NInput, NAvatar, NTag } from "naive-ui";
import { t, i18n } from "../i18n.js";
import { cloud } from "../utils/supabase.js";
import * as dmApi from "../utils/dm.js";
import { cacheKey, cacheSet, cachePatch, swr } from "../utils/cache.js";
import { dmStoreLoad, dmStoreSave, dmStoreDrop, dmStoreAppend, dmStoreUpsert, dmStoreReplace, dmStoreRemove } from "../utils/dmStore.js";
import { restoreScroll, rememberScroll } from "../utils/scrollMem.js";
import { avatarUrlFor } from "../utils/avatar.js";   /* 杞?238:钀屽疇澶村儚姹?*/
import { idbMerge, idbOlderThan, idbServerDone, idbDrop, idbLoad, idbRemoveRows } from "../utils/dmIdb.js";
import {
  previewText, sortConvs, filterConvs, searchRows, withDayDividers, displayMsg,
  validateSend, sendErrKey, canRecall, relativeTime, rowView, mergeTail, nextMsgKey, sortMsgRows,
  findSentEcho, dropEchoedDrafts, claimPendingEcho, dropEchoedPending, maxPositiveId, RECALLED_PLACEHOLDER,
  firstLimitLocked,
  convUnread, unreadToClear,
} from "../utils/dmRules.js";
import { badge, refreshBadge, refreshBottleBadge, badgeLocal, badgeDmConvPatch } from "../stores/badgeStore.js";
import { createTapGuard } from "../utils/tapGuard.js";
import { onDmInsert } from "../utils/dmRealtime.js";   /* 杞?269锛氬墠鍙扮杈?*/
/* 杞?34锛氭媺榛戝凡鍏ㄧ珯鐢熸晥锛堢淇℃嫤鎴?+ 鏆栧績澧欏唴瀹归殣钘忥級鈥斺€旇繖閲岃蛋 userBlocks 鐨勫寘瑁咃紝
 * 璁┿€屾媺榛戝悕鍗曘€嶇殑鍐呭杩囨护缂撳瓨涓庣淇″悕鍗曞缁堟槸鍚屼竴浠?*/
import { blockUser, unblockUser, refreshBlocks, isBlocked } from "../utils/userBlocks.js";

import BottleRecords from "../components/BottleRecords.vue";
/* 杞?142 路 妗岄潰銆屾紓娴佺摱銆嶆锛氳寮忓垪琛紙宸﹀垪锛? 鐙珛鑱婂ぉ妗嗭紙涓垪锛夆€斺€斾笌浼氳瘽娈电殑 dm-thread 鍚勮嚜鍗曞紑 */
import BottleChatList from "../components/BottleChatList.vue";
import BottleChat from "../components/BottleChat.vue";
import DmVacChat from "../components/DmVacChat.vue";
import { readDmUi } from "../utils/dmUiFlag.js";
import { isMobileNav, chatOpen, pushBack, popBack } from "../stores/uiStore.js";
import { kickChatViewport } from "../utils/chatViewport.js";
/* T7 娑堟伅 Tab 鍐呭垎鏍忥紙绉佷俊 | 閫氱煡锛夛細閫氱煡娈电洿鎺ュ鐢?NotificationsView
 * 锛堟暟鎹眰闆堕噸鍐欙紱寮傛 chunk 涓嶆嫋鎱㈤灞忥紱鎸傝浇鍗虫媺绗?0 椤碉紝閰?SWR 缂撳瓨绉掑紑锛?*/
const NotificationsView = defineAsyncComponent(() => import("./NotificationsView.vue"));

const route = useRoute();
const router = useRouter();

const convs = ref([]);       // 浼氳瘽鍒楄〃
/* 鐢ㄦ埛鎷嶆澘 A锛氬厤鎵撴壈/鎷夐粦杩欑被寮€鍏虫寜閽紝鍚屼竴 key 350ms 鍐呯浜屼笅鐩存帴涓㈠純銆?*/
const tapGuard = createTapGuard(350);
const q = ref("");           // 鎼滅储
/* 杞?337锛氭悳绱笉鍐嶅彧鎼滄樀绉?棰勮 鈥斺€?鏈湴鑱婂ぉ璁板綍閲屽嚭鐜拌繃涔熺畻锛堝井淇″紡锛夈€?
 * msgHits: conv_id -> { count, snippet, lastAt }锛汭ndexedDB 鏄紓姝ョ殑锛岃緭鍏ラ槻鎶?260ms銆?*/
const msgHits = ref({});
let hitTimer = 0;
let hitSeq = 0;
const loadingConvs = ref(false);
const convsLoaded = ref(false);   /* 杞?266锛氭湇鍔＄**鏄庣‘搴旂瓟杩?*锛堝摢鎬曠┖鍒楄〃锛夋墠绠楀凡鍔犺浇鈥斺€?
    * 銆岃繕娌℃湁浼氳瘽銆嶅彧鍦ㄥ畠涓?true 鏃舵墠鏄剧ず锛涙鍓嶄竴寰嬬粰楠ㄦ灦灞忋€?
    * 淇敤鎴锋姤闅滐細寮辩綉涓嬬綉缁滃け璐?鏈繑鍥炴椂鏃х増鎶娿€岃繕娌℃煡鍒般€嶆覆鏌撴垚銆岃繕娌℃湁浼氳瘽銆嶏紙鍋囩┖锛夈€?*/
const failed = ref(false);
const signedIn = computed(() => !!(cloud.ready && cloud.user));

const activeId = ref(String(route.params.id || ""));

/* 轮 423 · 按压玻璃：**必须保证这一帧被画出来**，不能靠浏览器 :active 自己抢时间。
 * 真机逐帧采样（tools/screencast-tap.mjs + .probe7/sampler.js）：
 *   第一次点：行在 t=164ms 变粉，列表一直到 590ms 才隐藏 → 粉色在屏上活了 426ms（用户看得见）
 *   第二次点：t=578ms 行变粉，**同一帧** list 就 display:none  → 活了 0ms（等于没有）
 * 差别不在 CSS，在于首次要现场挂载聊天组件（几百 ms），列表多停了半秒；
 * 组件就绪后列表瞬间消失，按压态还没被绘制就被撤掉了。
 * 所以：手指落下立刻加 press 类（JS 上色，不等 :active），
 * openConv 里再保证「按下 → 列表隐藏」之间至少过去 PRESS_MS，让这一帧真的合成出来。 */
const PRESS_MS = 140;
const pressedId = ref("");
let pressAt = 0;
let pressTimer = 0;
function onRowPress(id) {
  pressedId.value = String(id);
  pressAt = performance.now();
  clearTimeout(pressTimer);
  /* 抬手/取消后清掉，免得粘成第二个「常亮选中态」。
   * 900ms 是兜底：万一 click 没来（滑走了、超时），也不会留下一直发亮的行。 */
  pressTimer = setTimeout(() => { pressedId.value = ""; }, 900);
}

/* 杞?351 路 鑱婂ぉ闈㈡澘绛夎矾鐢辨彁浜ゅ啀鐢?鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
 * 鐢ㄦ埛瀹炴祴銆屼細璇濇秷鎭緢闀跨殑璁板綍锛岀涓€娆¤繘鍘讳細璺抽棯銆嶃€傜湡鏈洪€愬抚锛堝喎鍚姩棣栨杩?linyi 57 鏉★級锛?
 *   t=544ms 鑱婂ぉ宸茬粡娓叉煋锛屼絾璺敱杩樻病鎻愪氦 鈫?shell 娌℃湁 shell--chat锛圓pp.vue 鐨?inChat 璁よ矾鐢憋級锛?
 *           .dm-thread 娌″畾楂?鈫?鍒楄〃 clientHeight == scrollHeight锛堟暣娈?5659 鎾戝紑锛夛紝
 *           scrollTop 鍐欎笉杩涘幓锛岀敾闈㈠仠鍦ㄦ渶鏃╃殑娑堟伅锛屽簳閮ㄨ繕甯︾潃 tabbar锛?
 *   t=654ms 璺敱鎻愪氦銆佸鍣ㄥ畾楂?719锛泃=666ms 鎵嶉拤鍒板簳銆?
 * openConv 閲?activeId 鍏堣惤銆乺outer.push 鍚庢彁浜わ紝涓棿杩欎竴涓ゅ抚灏辨槸璺抽棯銆?
 * 鍋氭硶锛氭墜鏈哄舰鎬佷笅 activeId 涓庤矾鐢?:id 瀵归綈涔嬪墠涓嶆覆鏌撹亰澶╅潰鏉?鈥斺€?鍒楄〃椤靛師鏍峰仠鐫€锛?
 * 璺敱鍒颁綅鍚庢暣灞忎竴娆″垏杩囧幓锛堥潰鏉夸竴鎸傚嚭鏉ュ氨鏄畾楂樼姸鎬侊紝閽夊簳鍚屽抚瀹屾垚锛夈€?
 * 鍒楄〃鐨?v-show 涔熷甫涓?paneReady锛氫袱杈归兘涓嶈鍚屾椂钘忥紝鍚﹀垯绛夊緟鏈熸槸涓€灞忕┖鐧斤紙鐪熸満瀹炴祴 2 甯э級銆?
 * 妗岄潰鍙屽垪涓嶅彈褰卞搷锛氶潰鏉块珮搴︾敱 .dm-wrap 瀹氭锛屼粠鏉ヤ笉渚濊禆 shell--chat銆?
 * 鍏滃簳锛氳矾鐢辫鎷︼紙閲嶅瀵艰埅绛夛級400ms 鍚庡己鍒舵斁琛岋紝缁濅笉鎶婅亰澶╂案涔呰棌浣忋€?*/
const routeSettledFallback = ref(true);
let routeSettledTimer = 0;
const paneReady = computed(() => {
  const id = String(activeId.value || "");
  if (!id) return true;
  if (!isMobileNav.value) return true;
  if (route.name === "messages" && String(route.params.id || "") === id) return true;
  return routeSettledFallback.value;
});
/* 轮 464：把「聊天面板开着」同步给外壳（App.vue 的 inChat 认它）。
 * 判据必须与面板本身一模一样（activeId + paneReady），否则又会分叉：
 * 面板画出来了、.shell--chat 却没挂 → height:100dvh 那一整套整屏规则全不命中，
 * .dm-page 按内容撑到 2401px（屏高 744），输入条被推到文档末尾、进会话停在最前面。
 * flush 默认 pre：activeId 一变就在同一次更新里写进去，外壳与面板同一帧落地。 */
watch([isMobileNav, activeId, paneReady], () => {
  chatOpen.value = isMobileNav.value && !!activeId.value && paneReady.value;
}, { immediate: true });
/* 轮 474 · 面板一打开就立刻校正视口几何，不等 utils/chatViewport 的 250ms 巡检。
 * 病根：进会话是 history.pushState，不派发任何 resize/pageshow 事件，而
 * `html.kb-web .dm-page--chat` 那条高度规则在**不认 dvh 的内核**上计算期作废
 * （已改成 @supports 兜底，但脚本仍要第一时间写精确的 innerHeight）。
 * nextTick = DOM 更新完、浏览器还没绘制 → 内联高度与面板同帧落地，
 * 用户看不到「输入条先在屏幕中间闪一下再掉下去」。 */
watch(chatOpen, (v) => {
  if (v) nextTick(() => kickChatViewport());
});

/* 轮 481 · 进会话过渡（用户：「进入聊天框搞点过渡动画，现在这啥都没有」）。
 * 只在手机形态（列表 → 会话这一跳）加：桌面双栏是同时可见，没有「进入」这个动作。
 *
 * 为什么是「加类 → 定时摘类」而不是 <transition>：
 * 面板是 v-show 控制的，v-show 只切 display，拿不到 enter 钩子；而且它内部
 * 有 position:fixed 的表情面板，**transform 不能常驻**——一旦残留，fixed 的
 * 包含块就从视口变成这个面板，面板会贴到聊天框底部而不是屏幕底部。
 * 所以动画类跑完就摘，transform 在动画结束瞬间回到 none。 */
const threadIn = ref(false);
let threadInTimer = 0;
watch(chatOpen, (v) => {
  clearTimeout(threadInTimer);
  if (!v) { threadIn.value = false; return; }
  if (!isMobileNav.value) return;
  nextTick(() => {
    threadIn.value = true;
    threadInTimer = setTimeout(() => { threadIn.value = false; }, 320);
  });
});
onBeforeUnmount(() => clearTimeout(threadInTimer));
const msgs = ref([]);        // 褰撳墠浼氳瘽娑堟伅锛堟棫鈫掓柊锛?
let msgsConv = "";           // msgs 鐜板湪瑁呯殑鏄摢涓細璇濓紙杞?157b锛氶槻璺ㄤ細璇濊鍚堝苟锛?
/* 杞?225 路 浼氳瘽鍒囨崲绔炴€佸畧鍗細姣忔銆屾寜浼氳瘽鎷夋秷鎭€嶅彂鍙凤紙msgSeq锛夛紝鍝嶅簲鍥炴潵鏃舵牎楠屽彿涓庡綋鍓嶄細璇濄€?
 * 鐢ㄦ埛瀹炴祴锛氬揩閫熺偣寮€ A 鈫?杩斿洖 鈫?鐐?B 鈫?鐐?C锛屽鎸夊嚑娆″悗 C 閲屽嚭鐜?B 鐢氳嚦 A 鐨勮褰曘€?
 * 鏍瑰洜锛歭oadMessages / tick 鍦?await 鏈熼棿鐢ㄦ埛宸茬粡鍒囪蛋锛屾棫鍝嶅簲鍥炴潵**鏃犳潯浠?*鍐?msgs.value锛?
 * 浜庢槸銆屾渶鍚庤繑鍥炵殑閭ｄ唤銆嶈耽浜?鈥斺€?涓庣敤鎴峰綋鍓嶇偣鐨勬槸璋佸畬鍏ㄦ棤鍏炽€?
 * 涓ら亾鍒ゆ嵁缂轰竴涓嶅彲锛氣憼 鍙疯鏇存柊鐨勮姹傞《鎺夛紙鍚屼竴浼氳瘽杩炵偣涔熻闃诧級锛涒憽 褰撳墠浼氳瘽宸蹭笉鏄畠銆?*/
let msgSeq = 0;
const isStale = (mySeq, id) => mySeq !== msgSeq || String(activeId.value) !== String(id);
/* 杞?375锛氱炕鍘嗗彶鐨勯敋鐐瑰繀椤诲彇**鏈€灏忔 id**锛屼笉鑳芥嬁 msgs[0].id銆?
 * 鏅氬埌鐨勬棫娑堟伅/寰呭彂琛屽彲鑳借杩藉姞鍒版暟缁勫熬閮紝msgs[0] 涓嶄竴瀹氭渶鏃э紱
 * 鎷块敊閿氱偣浼氶噸澶嶆媺鍚屼竴椤碉紝鐢氳嚦姘歌繙缈讳笉鍒版洿鏃┿€?*/
function oldestServerId(list) {
  let min = null;
  for (const m of Array.isArray(list) ? list : []) {
    const id = Number(m && m.id);
    if (Number.isFinite(id) && id > 0 && (min == null || id < min)) min = id;
  }
  return min;
}
const body = ref("");
const sendErr = ref("");
/* 轮388：VAC 在 emit("send") 之后会自己 resetMessage；首聊第 4 条被本地拦下时，
 * 需要在 reset 之后再把这句塞回草稿，否则用户刚打的字会凭空消失。 */
const vacChat = ref(null);
/* 杞?353锛氬垏浼氳瘽鏃舵竻鎺変笂涓€鏉″け璐ュ師鍥?鈥斺€?杩欒鐜板湪浼氱敾杩涚粍浠惰緭鍏ュ尯涓婃柟锛堟棫鐗堝彧鍦?
   闈?vac 鍏滃簳椤电敾锛岃窡鐫€璺戞病浜虹湅瑙侊級锛涗笉娓呭氨浼氭妸 A 鐨勬姤閿欏甫鍒?B 鐨勪細璇濋噷銆?*/
watch(activeId, () => { sendErr.value = ""; });
/* 杞?318锛氫細璇濊緭鍏ユ銆屽彂閫佸悗鑷姩鎶樺彔銆嶁€斺€?
 * 鐢ㄦ埛鍘熻瘽銆屼細璇濇锛屾墦瀛楋紝鍙戦€?涔嬪悗锛岃緭鍏ユ鑷姩鎶樺彔浜嗭紝涓嶈鎶樺彔鍟娿€嶃€?
 * 鐪熷洜锛歷an-field 鐨?autosize 鏄€屾寜鍐呭绠楅珮搴︺€嶏紝send() 閲屾妸 body 娓呯┖ 鈫?textarea 绔嬪埢琚寜鍥炰竴琛?
 * 锛堢湡鏈哄疄娴?92px 鈫?44px锛屽悓鏃舵暣鍧楀竷灞€寰€涓嬭烦 48px锛夛紱鍔犱笂鐐瑰彂閫佹寜閽細鎶婄劍鐐规姠鍒版寜閽笂
 * 锛堟墜鏈轰笂灏辨槸閿洏鏀惰捣锛屾兂鎺ョ潃鎵撹繕寰楀啀鐐逛竴娆¤緭鍏ユ锛夈€?
 * 鍋氭硶锛氬彂閫侀偅涓€鍒婚噺涓嬪綋鍓嶉珮搴︼紝娓呯┖鍚庡啓鎴?min-height 鈥斺€?autosize 鍐嶇畻涔熷帇涓嶄笅鍘伙紱
 * 鍙湁銆岀敤鎴疯嚜宸辨妸瀛楀垹绌恒€嶆垨銆屾崲浼氳瘽銆嶆墠鏀惧紑锛堥偅鏃剁缉鍥炰竴琛屾槸鐢ㄦ埛鑷繁鐨勫姩浣滐紝涓嶆槸鑷姩鎶樺彔锛夈€?
 * 鐒︾偣涔熷湪鍚屼竴鍒绘媺鍥炶緭鍏ユ锛堝湪鐐瑰嚮鐨勭敤鎴锋墜鍔块噷璋?focus锛屾墜鏈洪敭鐩樹笉浼氭敹锛夈€?*/
const composeRow = ref(null);   /* 杈撳叆琛岋紙鎷块噷闈?Vant 鐨?textarea 鍋氶珮搴﹂拤瀛愶級 */
let composeHoldH = 0;           /* >0 = 閽変綇鐨勯珮搴︼紙px锛夛紱0 = 娌￠拤 */
let sentClear = false;          /* 鍖哄垎銆屽彂閫佹竻绌恒€嶄笌銆岀敤鎴疯嚜宸卞垹绌恒€?*/
function taOf() { return composeRow.value ? composeRow.value.querySelector("textarea") : null; }
function holdCompose(h) {
  composeHoldH = h > 0 ? Math.round(h) : 0;
  const ta = taOf();
  if (ta && composeHoldH) ta.style.minHeight = composeHoldH + "px";
}
/* 鏀惧紑閽夊瓙锛歮in-height 鍜?Vant 鍐欐鐨?height 閮借鏉惧紑锛屽啀鎸夊綋鍓嶅唴瀹归噺涓€閬?
 * 锛堢┖ = 鍥炲埌涓€琛岋紱鑽夌杩樺湪鍑犺灏辫繕鏄嚑琛岋級銆?
 * 蹇呴』閲嶉噺涓€閬嶏細娓呯┖閭ｄ竴鍒?Vant 鐨?resize 閲忓埌鐨勬槸銆岃閽夊瓙鎾戜綇鐨勯珮搴︺€嶏紝鏉炬墜鍚庣洅瀛?
 * 浼氫竴鐩村仠鍦ㄤ袱琛屼笂銆傜畻娉曚笌 Vant autosize 鍚屽彛寰勶細height:auto 鈫?璇?scrollHeight銆?*/
function releaseCompose() {
  composeHoldH = 0;
  const ta = taOf();
  if (!ta) return;
  ta.style.minHeight = "";
  ta.style.height = "auto";
  ta.style.height = ta.scrollHeight + "px";
}
watch(body, (v) => {
  if (v) return;
  if (sentClear) { sentClear = false; return; }   /* 杩欐鏄彂閫佹竻鐨勭┖锛氶珮搴︿繚鎸佷綇 */
  releaseCompose();                               /* 鐢ㄦ埛鑷繁鍒犵┖锛氭斁寮€锛屽洖鍒颁竴琛?*/
});
/* 杞?316 路 涔愯琛屼复鏃?id 鐢熸垚鍣細杩炲彂涓ゆ潯钀藉湪鍚屼竴姣鏃?-Date.now() 浼氭挒鍚屼竴涓?id锛?
 * 纭鍥炲啓灏变細鎶婁袱鏉￠兘鏀规垚鍚屼竴鏉°€傚悓姣鍐嶅噺 1锛屾案杩滀弗鏍奸€掑噺锛坕d<0 浠嶆帓灏撅級銆?*/
let lastTempId = 0;
function nextTempId() {
  const t = -Date.now();
  lastTempId = t < lastTempId ? t : lastTempId - 1;
  return lastTempId;
}
/* 杞?376锛氳繕鍦ㄩ鐨勫彂閫侊紙璐熸暟 id锛夈€傛湰鍦板簱浼氬厛瀛樸€屽彂閫佷腑銆嶈锛岄噸杩涙椂鍙湁杩欎簺
 * id 杩樼畻 pending锛涜繘绋嬭鏉€/鎹㈣澶囧悗鐣欎笅鐨勫鍎?pending 瑕侀檷绾ф垚澶辫触琛岋紝
 * 涓嶈兘姘歌繙杞湀锛屼篃涓嶈兘姘歌繙鐪嬩笉瑙併€?*/
const livePending = new Set();
function reviveLocal(m) {
  if (!m || !(m.id < 0) || !m.pending || livePending.has(String(m.id))) return m;
  return { ...m, pending: false, failed: true };
}
const loadingMsgs = ref(false);
const hasMore = ref(true);
const oldestId = ref(null);
const listEl = ref(null);
/* ── 轮491 · 会话列表（aside.dm-list）自己的滚动位置 ──
 * 用户实测：「列表很长的时候，我下拉到最下面，点一个用户进去再返回，结果是回到最上面了」。
 * 病根：aside 是**自己滚动的容器**（手机上 max-height:46vh），进会话时被 v-show 切成
 * display:none —— 不可滚动期间 scrollTop 读出来就是 0，而父级 .dm-wrap 同时从 grid 变
 * flex column、后台 tick 还在刷新会话行，等它重新显示时浏览器未必把旧偏移还回来。
 * 所以位置由我们自己拿：@scroll 实时存住（display:none 期间不会再触发，存的是最后一次
 * 真实值），回列表时主动写回去。
 *
 * 为什么写多次：.dm-page--chat 类移除后 .dm-wrap 要重新布局，第一次写可能被「还没长回
 * 46vh」的容器钳成 0（与首页 track 高度那个坑同源）。一帧后 + 90ms 各补一次，并用代次
 * 号让「用户已经自己滚了」时立刻停手，不跟手指抢。 */
const convListEl = ref(null);
let convListY = 0;
let convRestoreGen = 0;
function onConvListScroll() {
  const el = convListEl.value;
  if (!el) return;
  convListY = el.scrollTop;
  convRestoreGen += 1;   /* 用户自己滚了 → 取消还在排队的补写 */
}
function restoreConvList() {
  const y = convListY;
  if (!y) return;        /* 停在顶部就不用管 */
  const gen = ++convRestoreGen;
  const put = () => {
    if (gen !== convRestoreGen) return;
    const el = convListEl.value;
    if (el) el.scrollTop = y;
  };
  nextTick(() => {
    put();
    requestAnimationFrame(() => { put(); setTimeout(put, 90); });
  });
}

/* 页面（window）这一层的位置：进会话前记一次，返回时补写。
 * 补三拍（nextTick / 一帧 / 90ms）的理由同上 —— 返回那一刻 .dm-page--chat 刚摘掉、
 * aside 刚恢复显示，文档还没长回原来的高度，太早 scrollTo 会被浏览器钳成中途值。 */
let pageY = 0;
function savePageScroll() {
  try { pageY = window.scrollY; rememberScroll(route.path); } catch (e) { /* 忽略 */ }
}
function restorePageScroll() {
  const y = pageY;
  if (!y) return;
  const put = () => {
    try { window.scrollTo({ top: y, left: 0, behavior: "instant" }); }
    catch (e) { window.scrollTo(0, y); }
  };
  nextTick(() => {
    put();
    requestAnimationFrame(() => { put(); setTimeout(put, 90); });
  });
}
function restoreListScroll() {
  restoreConvList();
  /* 桌面双栏一直是同一屏，window 位置没人动过（也不该动）*/
  if (isMobileNav.value) restorePageScroll();
}
/* 从「有会话」回到「没有会话」= 返回列表（路由返回 / 安卓返回键 / 面板收起都走这条）。
 * 轮491：内外两层都要回位 —— 里面是 aside 自己的 scrollTop，外面是 window。
 * 外面那层为什么也会丢：手机形态 .dm-page 高度是 auto（内容撑），进会话后被
 * .dm-page--chat 改成 100dvh，文档当场变短 → 浏览器把 window.scrollY 钳到 0；
 * 返回时文档虽然有变高，但没人再滚回去。列表很长时用户往往已经滚过页面，
 * 于是「返回 = 回到最上面」。 */
watch(activeId, (v, old) => { if (!v && old) restoreListScroll(); });
const userScrolling = ref(false);   /* 杞?173锛氱敤鎴锋墜鍔ㄤ笂婊戞爣璁扳€斺€旇拷搴曞仠鎵?*/
const listRevealed = ref(true);     /* 杞?176锛氳繘浼氳瘽鍏堥殣钘忔秷鎭尯锛岄拤搴曠ǔ瀹氬悗鍐嶆樉绀衡€斺€?
    棣栧抚 fallback 瀛椾綋鎺掔増 鈫?webfont 鎹㈣鎾戦珮鍐呭 = 钀界偣閿欎綅闂幇锛堢敤鎴峰疄娴嬭烦闂級 */
const entryReady = ref(false);      /* 杞?180锛氶灞忥紙fresh锛夋暟鎹惤瀹氭墠鍏佽鏄剧ず鈥斺€?
    缂撳瓨绐楀彛涓?fresh 绐楀彛楂樺害涓嶅悓锛岀紦瀛樺厛娓叉煋鍐嶈鏇挎崲 = 卤鍗僷x 鍙璺冲彉锛堥€愬抚閲囨牱瀹為敜锛?*/
/* 杞?193 璋冭瘯锛堜复鏃讹級锛氭彮绀烘潵婧愯拷韪?*/
watch(listRevealed, (v) => {
  if (typeof window === "undefined") return;
  window.__wpRev = window.__wpRev || [];
  const el = listEl.value;
  window.__wpRev.push({
    v, t: Math.round(performance.now() % 1e7),
    top: el ? Math.round(el.scrollTop) : -1,
    h: el ? Math.round(el.scrollHeight) : -1,
    font: (document.fonts && document.fonts.status) || "?",
    entryReady: entryReady.value,
  });
});
function fontsOk() {                /* 杞?178b锛歸ebfont 娌″湪鍔犺浇涓?= 鎺掔増绋冲畾锛堟瘡甯у疄鏃跺垽瀹氾紝
    fonts.ready 鏈夈€岃Е鍙戣繃鏃╄鏀捐銆嶇殑鍧戯紝寮冪敤锛夛紱鍔犺浇澶辫触涔熶細钀藉埌 loaded锛屼笉浼氭案钘?*/
      return !(document.fonts && document.fonts.status === "loading");
    }
/* 杞?238 路 瀛椾綋銆岄潤榛樸€嶅垽瀹氾細鏂囨シ鎸?unicode-range 鍒嗗潡鍔犺浇锛屼袱鎵逛箣闂?fonts.status
 * 浼氱煭鏆傝鍥?"loaded"鈥斺€攆ontsOk() 琚獥杩?鈫?鎻ず钀藉湪闇囪崱涓 鈫?涓嬩竴涓瓙闆嗗埌杈剧户缁?
 * 閲嶆帓 = 鍐呭闂幇鍙堣烦娌★紙闀挎秷鎭瓙闆嗗銆佺獥鍙ｅ锛岀敤鎴峰疄娴嬨€岄棯鐜板嚭鏉ュ張娑堝け銆嶏級銆?
 * 璁板綍鏈€鍚庝竴娆″瓧浣撴椿鍔ㄦ椂鍒伙紝鎻ず鍓嶈姹傞潤榛?鈮?50ms锛坙oading/loadingdone 閮界畻娲诲姩锛夈€?*/
let lastFontActivity = -1e9;
if (typeof document !== "undefined" && document.fonts) {
  const markFontActivity = () => { lastFontActivity = performance.now(); };
  document.fonts.addEventListener("loading", markFontActivity);
  document.fonts.addEventListener("loadingdone", markFontActivity);
}
const fontQuiet = () =>
  !document.fonts || performance.now() - lastFontActivity > 150;
let scrollGen = 0;                  /* 杞?176b锛氭粴鍔ㄩ摼浠ｆ暟鈥斺€斿钩婊戞粴鍔ㄦ帴绠℃椂浣滃簾鏃ц拷甯ч摼 */
const pinning = ref(false);         /* 杞?173b锛氳繘浼氳瘽閽夊簳涓紙鐩村埌棣栧睆鏁版嵁钀藉畾锛?*/
let entryFallback = 0;              /* 杞?249锛歰penConv 鐨?2s 鎻ず鍏滃簳鍙ユ焺鈥斺€旀柊涓€杞繀椤绘竻鎺夋棫鐨?*/
function onListTouch() { userScrolling.value = true; }
function onListWheel() { userScrolling.value = true; }
const meta = ref(null);      // 褰撳墠浼氳瘽鍏冧俊鎭紙鏄电О / 鍏嶆墦鎵?/ 鎷夐粦 / 娑堟伅璇锋眰锛?
const menuFor = ref("");     /* 展开操作菜单的会话 id */
/* 轮453：菜单默认从行下方展开。会话列表靠屏幕底部时，展开后会顶到视口外 ——
 * 桌面端更强：.dm-list 是 overflow-y:auto，超出列表底边会被直接裁掉（最后两项看不见）。
 * 打开时量一次实际高度，放不下就翻到行上方（.up）。只在会溢出时才生效，不影响常规位置。 */
const menuUp = ref(false);
function toggleRowMenu(ev, convId) {
  const k = String(convId);
  if (menuFor.value === k) { menuFor.value = ""; return; }
  menuUp.value = false;
  menuFor.value = k;
  nextTick(() => {
    /* 注意：不能用 $event.currentTarget —— 事件处理结束后它会被浏览器置 null，
     * 而这里是 nextTick 回调（异步）。target 是持久引用，closest 找到所属行。 */
    const host = ev && ev.target && ev.target.closest && ev.target.closest(".dm-row");
    const el = host && host.querySelector(".dm-menu");
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.bottom > window.innerHeight - 8) menuUp.value = true;
  });
}

const fromList = ref(false); // 鎵嬫満褰㈡€侊細鏈細璇濇槸浠庝細璇濆垪琛ㄧ偣杩涙潵鐨勶紙鈫?鐢?router.back 鍥炲垪琛級

const REQ = "requests";      // 浼細璇濆垎缁勯敭锛堟秷鎭姹傦級

/* 杞?142 路 鍒嗘鍙ｅ緞锛堜竴浣撳寲绉佷俊椤碉級锛?
 *  - 鎵嬫満褰㈡€侊紙涓夋锛屽師鏍蜂笉鍔級锛氭紓娴佺摱 | 浼氳瘽 | 閫氱煡
 *  - 妗岄潰褰㈡€侊紙涓ゆ锛屽弬鑰冨浘锛夛細浼氳瘽 | 婕傛祦鐡?鈥斺€?涓ゆ**鍚勮嚜鍗曞紑鑱婂ぉ妗?*锛堜細璇?dm-thread锛?
 *    婕傛祦鐡?BottleChat锛夛紝涓嶅叡鐢紱閫氱煡涓嶈繘妗岄潰绉佷俊椤碉紙椤舵爮閾冮摏/閫氱煡椤典粛鍙揪锛夈€?
 * 杩涜亰澶?鍥炲垪琛ㄥ己鍒跺洖銆屼細璇濄€嶆銆?*/
const seg = ref("dm");
const dmBadge = computed(() => badge.dm + badge.requests);

/* 鈺愨晲鈺?杞?330 路 浼氳瘽椤垫崲缁勪欢寮€鍏?鈺愨晲鈺?
 * 鏂规 B锛氬垪琛?+ 璇︽儏鏁翠綋鎹㈡垚 vue-advanced-chat锛圖mVacChat.vue锛夈€?
 * 鏃у竷灞€涓€琛屾病鍒狅紝闈犺繖涓紑鍏冲垏锛?
 *   /messages?ui=vac     鈫?鏂帮紙骞惰浣忥紝涓嬫鐩存帴杩涙柊锛?
 *   /messages?ui=legacy  鈫?鏃э紙骞惰浣忥級
 * 缂撳瓨涓夊眰銆佸彂閫侀槦鍒椼€佸凡璇绘按浣嶃€佹媺榛戣繃婊ゅ叏閮戒笉鍙樷€斺€旀柊缁勪欢鍙敾銆佷笉鍙栨暟銆?*/
const vacUi = ref(readDmUi(route.query));
/* 鏂扮粍浠跺悆鐨勮锛氫笌鍒楄〃鍚屼竴濂楄繃婊わ紙娑堟伅璇锋眰 / 鎷夐粦 / 琚垜鎷夐粦 閮戒笉杩涗細璇濆垪琛級 */
const vacConvs = computed(() =>
  convs.value.filter((c) => c && c.accepted !== false && !c.blocked && !isBlocked(c.other_id)));
const vacPeerName = computed(() => (dmPeer.value && dmPeer.value.nickname) || "");

function onVacRecall(id) {
  const m = msgs.value.find((x) => String(x.id) === String(id));
  if (m) recall(m);
}
async function onVacLoadMore() {
  const id = String(activeId.value || "");
  const before = oldestId.value;
  if (!id || !hasMore.value || before == null || loadingMsgs.value) return;
  /* 杞?376锛氳繖閲屽師鏉ュ彧 await backfillOlder(id) 鈥斺€?瀹冩妸鏇存棭鍘嗗彶鍐欒繘 IndexedDB锛?
   * 浣嗕粠涓嶆妸浠讳綍涓€琛屽苟杩?msgs锛岀粍浠朵笂婊戝悗鐪嬪埌鐨勮繕鏄師鏉ラ偅涓€灞忋€?
   * 鐪熸鐨勩€屽姞杞芥洿鏃┿€嶅繀椤昏蛋 loadMessages(before)锛岀敱 applyRows 鎶婁笂涓€椤垫彃鍒伴《閮紱
   * IDB 鍥炲～缁х画鍦ㄥ悗鍙板仛锛岃礋璐ｆ妸鍚庣画椤典篃瀛樹笅鏉ワ紝浣嗕笉闃诲杩欐涓婂睆銆?*/
  await loadMessages(id, { before });
  backfillOlder(id);
}
/* 杞?334锛氱粍浠剁殑杈撳叆妗?/ 澶撮儴銆屸€︺€嶅洖钀藉埌鏃х増閭ｅ鍔ㄤ綔锛堝彂閫侀槦鍒椼€佺湅涓婚〉銆佸厤鎵撴壈銆佹媺榛戦兘涓嶅彉锛?*/
function onVacSend(text) {
  const s = String(text || "").trim();
  if (!s || !canType.value) return;
  body.value = s;
  send();
}
/* 陌生人首聊第 4 条：在写乐观行 / 调 dm_send 之前就拦下，正文留在输入框。
 * 只认当前会话的窗口；msgs 还没装回当前会话时宁可不判，交给服务端兜底。 */
function firstContactBlocked(owner = meId.value, convId = activeId.value) {
  const cid = String(convId || "");
  if (!owner || !cid || String(msgsConv) !== cid) return false;
  const metaRow = meta.value && String(meta.value.conv_id) === cid ? meta.value : null;
  const row = metaRow || activeConv.value;
  const otherId = (row && row.other_id) || (activeConv.value && activeConv.value.other_id);
  return firstLimitLocked(row, msgs.value, owner, otherId);
}
/* 杞?336锛氱粍浠堕噷鐐圭孩鑹层€?銆? 閲嶅彂閭ｆ潯锛堟棫鐗堝彧鏈夈€屽彂閫佸け璐ャ€嶇孩瀛楋紝娌℃湁閲嶅彂锛夈€?
   鍙仛涓や欢浜嬶細鎶婂け璐ヨ浠庡綋鍓嶅垪琛ㄦ憳鎺夛紙鍚屼竴鍙ヤ笉鐣欎袱鏉★級锛屾妸鍐呭濉炲洖 body 鍐嶈蛋鍚屼竴鏉?send()銆?
   缃戠粶銆佷箰瑙備笂灞忋€佸け璐ユ爣璁板叏褰?send() 鈥斺€?杩欓噷娌℃湁绗簩濂楀彂閫侀€昏緫銆?*/
function onVacResend(id) {
  const convId = String(activeId.value || "");
  /* 轮381：重发会先摘掉失败行再走 send()。登出瞬间 meId 为空、或快速切走后
   * msgs 还没装回当前会话时，不能拿别的会话/空账号去删行，否则消息直接丢。 */
  if (!convId || !canType.value || !meId.value || !signedIn.value) return;
  if (msgsConv !== convId) return;
  const m = msgs.value.find((x) => String(x.id) === String(id) && x.failed);
  if (!m) return;
  const text = String(m.body || "").trim();
  if (!text) return;
  /* 鍏堟牎楠屽啀鎽樿锛氫竾涓€鍐呭宸蹭笉鍚堟硶锛堣秴闀跨瓑锛夛紝澶辫触琛屼笉鑳借鐧界櫧鍒犳帀銆?*/
  const err = validateSend(text, null);
  if (err) { sendErr.value = t(err); return; }
  if (firstContactBlocked(meId.value, convId)) {
    sendErr.value = t("dm.errFirstLimit");
    return;
  }
  /* 杞?376锛氶噸鍙戜細鐢熸垚鏂扮殑璐熸暟琛岋紱鏃уけ璐ヨ瑕佷粠鏈湴搴?鍏ㄩ噺闀滃儚鎽樻帀锛屽厤寰楅噸杩涘悗
   * 鍚屾椂鐪嬪埌銆屾棫鐨勫け璐ャ€嶅拰銆屾柊鐨勫彂閫佷腑銆嶃€?*/
  dmStoreRemove(meId.value, convId, m.id);
  idbRemoveRows(convId, [m.id]);
  msgs.value = msgs.value.filter((x) => String(x.id) !== String(m.id));
  body.value = text;
  send();
}
function onVacRoomAction(name) {
  if (name === "profile") goUser((curPeer.value && curPeer.value.user_id) || (activeConv.value && activeConv.value.other_id));
  else if (name === "mute") mutePeer();
  else if (name === "block") blockPeer();
}

/* T7 绯荤粺杩斿洖閿細婕傛祦鐡?閫氱煡娈垫槸娑堟伅 Tab 鐨?*鍐呴儴灞傜骇** 鈫?鍏堝洖浼氳瘽娈碉紙App 鎯緥锛夛紝
 * 宸茶鎺ョ鍒欎笉鍐嶅洖閫€璺敱/鏈€灏忓寲 App锛涚寮€鏈〉寮规爤銆?
 * 璇存槑锛氳亰澶╅〉鍏辩敤銆屾秷鎭€峊ab锛屼絾閭ｆ椂 seg 鎭掍负 dm锛岃繖閲岃繑鍥?false 浜ゅ洖榛樿绛栫暐銆?*/
function segBack() {
  if (seg.value === "dm") return false;
  seg.value = "dm";
  return true;
}
const meId = computed(() => (cloud.user && cloud.user.id) || "");

/* #15 鐐瑰ご鍍?鍚嶅瓧杩涘鏂逛富椤碉紙鍒楄〃琛屼笌鑱婂ぉ澶撮儴鍏辩敤锛?*/
function goUser(id) {
  if (id) router.push({ name: "waller", params: { id } });
}

/* 甯歌浼氳瘽 / 娑堟伅璇锋眰 鍒嗙粍锛堣鎷夐粦鐨勪細璇濆湪 rowView 閲屾妸鏈娓呴浂锛夈€?
 * 杞?238锛氭媺榛戠殑浼氳瘽**鍗虫椂浠庡垪琛ㄩ殣钘?*锛堟湇鍔＄ dm_list_convs 鍚屽彛寰勶級鈥斺€?
 * 杩囨护浠ュ叏绔欐媺榛戞潈濞佸悕鍗?isBlocked 涓哄噯锛堝搷搴斿紡锛涘喎鍚姩鐢ㄥ揩鐓с€乺efreshBlocks 鏍″噯锛夛紝
 * 琛屼笂鐨勪箰瑙傛爣蹇楀彧浣滆ˉ鍏呪€斺€擲WR 缂撳瓨蹇収閲岀殑琛?blocked 鏄棫鍊硷紝鍙湅琛屾爣蹇椾細婕忥紙鐢ㄦ埛瀹炴祴锛夈€?*/
const hitOf = (c) => (c ? msgHits.value[String(c.conv_id)] || null : null);
/* 杞?337锛氭樀绉?棰勮鍛戒腑锛堟棫鍙ｅ緞锛? 鏈湴鑱婂ぉ璁板綍鍛戒腑锛堟柊鍙ｅ緞锛夈€傚懡涓殑琛屽甫涓?c.hit锛?
 * 鍒楄〃閲屽涓€琛屻€孨 鏉¤亰澶╄褰曞尮閰?路 鐗囨銆嶏紝鐢ㄦ埛鎵嶇煡閬撲负浠€涔堣繖琛屼細鍑虹幇銆?*/
const withHits = (list) => {
  const key = q.value;
  const base = filterConvs(list, key);
  const seen = new Set(base.map((c) => String(c.conv_id)));
  const extra = String(key || "").trim()
    ? list.filter((c) => !seen.has(String(c.conv_id)) && hitOf(c))
    : [];
  return sortConvs(base.concat(extra)).map((c) => ({ ...rowView(c), hit: hitOf(c) }));
};
const normal = computed(() => withHits(convs.value.filter((c) => c.accepted !== false && !c.blocked && !isBlocked(c.other_id))));
const requests = computed(() => withHits(convs.value.filter((c) => c.accepted === false && !c.blocked && !isBlocked(c.other_id))));

/* 杞?337锛氭湰鍦板巻鍙叉悳绱紙鍙锛夈€傞槻鎶?+ 搴忓彿锛氭參鐨勯偅娆″洖鏉ユ椂鐢ㄦ埛宸茬粡鏀逛簡璇嶏紝鐩存帴涓㈠純銆?*/
watch(q, (val) => {
  const key = String(val || "").trim();
  clearTimeout(hitTimer);
  const my = ++hitSeq;
  if (!key) { msgHits.value = {}; return; }
  hitTimer = setTimeout(async () => {
    const ids = convs.value.filter((c) => c && c.conv_id != null).map((c) => String(c.conv_id));
    const map = {};
    await Promise.all(ids.map(async (cid) => {
      try {
        const rec = await idbLoad(cid);
        const hit = searchRows(rec && rec.msgs, key);
        if (hit) map[cid] = hit;
      } catch (e) { /* IndexedDB 涓嶅彲鐢細閫€鍥炲彧鎼滄樀绉?棰勮锛屼笉鎶ラ敊 */ }
    }));
    if (my === hitSeq) msgHits.value = map;
  }, 260);
});

/* 杞?268锛氳鏈 = max(鍒楄〃鏉冨▉鍊? badge 琛岀骇鏄犲皠)鈥斺€攂adge 璇锋眰锛?0s 杞 + 瑙掓爣鏈湴缂撳瓨
 * 绉掑嚭锛夋瘮浼氳瘽鍒楄〃蹇紝鏄犲皠鍏堝埌灏卞厛浜孩鐐癸紙淇€岄《/搴曠孩鐐归兘鍦紝涓棿琛岀孩鐐圭瓑濂藉嚑绉掓墠鍑虹幇銆嶏級銆?
 * 涓よ竟閮芥潵鑷湇鍔＄鏉冨▉鏃跺埢锛沷penConv/杞娓呰鏃朵袱鑰呭悓姝ユ竻锛宮ax 涓嶄細璁╃孩鐐瑰娲汇€?*/
function rowUnread(c) {
  /* 免打扰（dm_states.muted）= 不打扰：不亮红数字、不进导航角标
   *（服务端 dm_unread_total 已把静音会话排除，见 MIGRATION_dm_mute_silence.sql）。
   * 消息本身还在：模板里 muted 用 c.unread 画一个无数字灰点，点进去照常能读。 */
  return convUnread(c, badge.dmConvs);
}

/* ── 轮490 · 「全部已读」（用户：会话那个文字那一行的最右边）──
 * 服务端只有单会话 dm_mark_read（没有全读 RPC，也不为了这一颗按钮加一次建表迁移），
 * 所以按会话并发抬水位：会话数一般几条到几十条，并发一次就完；串行在 20+ 会话时要等好几秒。
 *
 * 只清「会话」这一段（已接受、未拉黑、未屏蔽）；消息请求不动 —— 那一段的未读走
 * badge.requests，还没接受之前它不算「会话」，清了反而让请求消失得莫名其妙。
 * 静音会话要算进来：它有灰点未读，用户点「全部已读」时期待灰点也一起没。 */
const allReadBusy = ref(false);
const allReadNote = ref("");     /* "" | "ok" | "fail" */
let allReadTimer = 0;

/** 还有未读的会话（rowUnread 对静音会话返回 0，所以要连原始 unread 一起取大）。
 *  口径要从 convs 起算、不能从 normal 起算：normal 被搜索词过滤过，
 *  搜索态下点「全部已读」会只清掉搜出来的那几条，剩下的红点还在 —— 用户会觉得没生效。 */
const pendingUnread = computed(() => convs.value.filter(
  (c) => c.accepted !== false && !c.blocked && !isBlocked(c.other_id)
    && Math.max(convUnread(c, badge.dmConvs), Number(c.unread) || 0) > 0));

async function markAllRead() {
  if (allReadBusy.value) return;
  const rows = pendingUnread.value;
  if (!rows.length) return;
  allReadBusy.value = true;
  clearTimeout(allReadTimer);
  allReadNote.value = "";
  /* 快照：失败要原样还原。不做「等下一轮角标轮询自己好」——那 30s 里用户看到的
   * 是一份假的干净列表，比明说失败更糟。 */
  const snap = rows.map((c) => {
    const id = String(c.conv_id);
    const row = convs.value.find((x) => String(x.conv_id) === id) || null;
    return { id, row, unread: row ? (Number(row.unread) || 0) : 0 };
  });
  /* 乐观清零：行红点 / 灰点 / 导航角标一起跟手（网络回来再按权威值校正） */
  const lost = rows.reduce((n, c) => n + unreadToClear(c, badge.dmConvs), 0);
  for (const s of snap) {
    if (s.row) s.row.unread = 0;
    badgeDmConvPatch(s.id, 0);
  }
  if (lost) badgeLocal({ dm: Math.max(0, badge.dm - lost) });
  const results = await Promise.all(
    rows.map((c) => dmApi.markRead(c.conv_id).then(() => true).catch(() => false)));
  const bad = results.filter((x) => !x).length;
  for (let i = 0; i < results.length; i++) {
    if (results[i]) continue;
    const s = snap[i];
    if (s.row) s.row.unread = s.unread;   /* 失败的这条把红点放回去 */
  }
  allReadNote.value = bad ? "fail" : "ok";
  refreshBadge();   /* 权威校正：成功的会话服务端已抬水位，失败的会自己补回来 */
  allReadBusy.value = false;
  allReadTimer = setTimeout(() => { allReadNote.value = ""; }, bad ? 3200 : 1600);
}

/* 甯︽棩鏈熷垎闅旂殑娑堟伅娴?*/
const flow = computed(() => withDayDividers(msgs.value.map(displayMsg)));   /* withDayDividers 鍐呮寜 created_at 鎺掑簭 */

const activeConv = computed(() =>
  convs.value.find((c) => String(c.conv_id) === String(activeId.value)) || null);
const title = computed(() =>
  (meta.value && meta.value.nickname) || (activeConv.value && activeConv.value.nickname) || "");

/* 杞?142 路 妗岄潰銆屾紓娴佺摱銆嶆鐘舵€侊紙涓庝細璇濇鍚勮嚜鐙珛銆佷笉鍏辩敤鑱婂ぉ妗嗭級 */
const bottleRow = ref(null);     // 宸﹀垪閫変腑鐨勪俊锛坆ottle_letters 琛岋級
const bottlePending = computed(() => badge.bottle);    // 銆屾垜鍙戝竷鐨勩€嶉噷绛夋垜鐐广€屾効鎰忥紝寮€濮嬭亰澶┿€嶇殑淇℃暟锛堝瓙鍒?搴曟爮绾㈢偣锛?
const bottleList = ref(null);
/* 轮379：按「账号:会话」保存聊天框里还没发出去的文字。只存内存，不落盘；
   换号后 key 不同，不会把上一个账号的草稿显示给下一个账号。 */
const vacDrafts = ref({});
function onVacDraft(e) {
  const d = e || {};
  /* 轮381：d.owner 是组件卸载时捕获的账号；不能因为它为空就回落到「当前账号」，
   * 否则登出瞬间抛出的旧账号草稿会被记到新账号名下。 */
  const owner = String(d.owner != null ? d.owner : (meId.value || ""));
  const convId = String(d.roomId || "");
  if (!owner || !convId) return;
  const key = `${owner}:${convId}`;
  const text = String(d.text || "");
  if (text) vacDrafts.value[key] = text;
  else delete vacDrafts.value[key];
}
const bottleName = ref("");      // 璇ヤ俊鐨勫鏂规樀绉帮紙宸﹀垪瑙ｆ瀽鍚庡甫鍥烇紱绌?= 璧板厹搴曟枃妗堬級
const bottleMeta = ref({});      // 宸插缓浼氳瘽鏃剁殑浼氳瘽鍏冧俊鎭紙鍏嶆墦鎵?鎷夐粦涓庝細璇濇鍚屾簮锛?

/* 澶撮儴銆屸€︺€嶈彍鍗曠殑鏁版嵁婧愶細闅忋€屽綋鍓嶆 + 褰撳墠閫変腑鐨勪汉銆嶅彉锛堜細璇濇鐪嬩細璇濓紱婕傛祦鐡舵鐪嬭繖灏佷俊鐨勪汉锛?*/
const dmPeer = computed(() => {
  const c = activeConv.value || meta.value || {};
  return {
    user_id: c.other_id || "", nickname: title.value || "",
    muted: !!c.muted, blocked: !!c.blocked, conv_id: activeId.value,
  };
});
const bottlePeer = computed(() => {
  const l = bottleRow.value || {};
  const m = bottleMeta.value || {};
  const uid = l.user_id === meId.value ? (l.reply_by || "") : (l.user_id || "");
  return {
    user_id: m.other_id || uid, nickname: m.nickname || bottleName.value || "",
    muted: !!m.muted, blocked: !!m.blocked, conv_id: m.conv_id || l.conv_id || "",
  };
});
const curPeer = computed(() => (seg.value === "bottle" ? bottlePeer.value : dmPeer.value));
const peerInitial = computed(() => (curPeer.value.nickname || "?").slice(0, 1).toUpperCase());
/* 鑿滃崟鐨勬搷浣滃璞★細浼氳瘽娈?褰撳墠浼氳瘽锛涙紓娴佺摱娈?璇ヤ俊宸插缓鐨勪細璇濓紙杩樻病浼氳瘽灏变笉鍑哄姩浣滄寜閽級 */
const curConv = computed(() =>
  convs.value.find((c) => String(c.conv_id) === String(curPeer.value.conv_id)) || null);
/* 杞?143 路 涓垪澶撮儴鍙充笂瑙掋€屸€︺€嶈彍鍗曪紙鍘熷彸鍒楄祫鏂欏崱鍐呭杩佸叆锛屽彧鍦ㄦ闈㈡覆鏌擄級 */
const headMenu = ref(false);
watch(seg, () => { headMenu.value = false; });
/* 杞?44锛氱偣鑿滃崟澶栫┖鐧藉鑷姩鍏筹紙鑿滃崟鍐呭悇椤圭偣鍑诲凡鍚勮嚜 headMenu=false锛?
 * 鏂囨。绾?pointerdown 鍏滀綇椤甸潰浠绘剰浣嶇疆鈥斺€斿垪琛?婊氬姩鍖?杈撳叆妗?鍙︿竴渚ч兘绠椻€滅┖鐧解€濓級 */
function onDocPointerDown(e) {
  /* 杞?209锛氫細璇濊 鈰?鑿滃崟鍚屾牱鐐圭┖鐧藉叧鈥斺€旇疆 197 鎶婂叏閮ㄦ搷浣滄敹杩?鈰?鍚庨珮棰戜娇鐢紝
   * 涔嬪墠鍙湁澶撮儴鑿滃崟鏈夌偣绌虹櫧鍏筹紝鍒楄〃琛岀殑鑿滃崟鐐瑰摢鍎块兘涓嶆敹锛堢敤鎴峰疄娴嬶級銆?*/
  if (menuFor.value) {
    const t = e.target;
    const inMenu = t && t.closest && (t.closest(".dm-menu") || t.closest(".dm-more"));
    if (!inMenu) menuFor.value = "";
  }
  if (!headMenu.value) return;
  if (e.target && e.target.closest && e.target.closest(".dm-head-tools")) return;
  headMenu.value = false;
}

/* 鏄惁鍙互鐩存帴鍙戯細瀵规柟涓嶆槸寰呭鐞嗚姹傘€佸弻鏂归兘娌℃媺榛?*/
const canType = computed(() => {
  if (!activeId.value) return false;
  const c = activeConv.value || meta.value || {};
  if (c.blocked) return false;
  /* 杞?238锛氫互鍏ㄧ珯鎷夐粦鏉冨▉鍚嶅崟涓哄噯锛堟崲璁惧/鍐峰惎鍔ㄥ悗琛屾爣蹇楀彲鑳芥槸缂撳瓨鏃у€硷級 */
  if (isBlocked(c.other_id || c.user_id)) return false;
  if (c.accepted === false) return false;
  return true;
});
const blockedByMe = computed(() =>
  !!(activeConv.value || meta.value || {}).blocked
  || isBlocked((activeConv.value && activeConv.other_id) || (meta.value && meta.value.other_id)));
/* 杞?334锛氳繖涓ゅ彞浠ュ墠鍦ㄦā鏉块噷鍐欐锛岀幇鍦ㄨ浼犵粰缁勪欢鐨勫ご閮?杈撳叆鍖?*/
const gateText = computed(() => (blockedByMe.value ? t("dm.gateBlockedByMe") : t("dm.gateRequest")));
const composePlaceholder = computed(() => (isMobileNav.value ? t("dm.placeholderMobile") : t("dm.placeholder")));


/* 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ 鏁版嵁鍔犺浇 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ */

/* 杞?320 路 浼氳瘽琛屽嵆鏃惰惤缂撳瓨锛堢敤鎴锋姤闅滐細銆屼粠涓婚〉鍙戝畬绉佷俊鍥炲埌浼氳瘽涓績锛岄偅鏉¤褰曞崄鍑犵鎵嶅嚭鐜般€嶏級
 * 鐥呮牴锛氫細璇濆垪琛ㄦ槸**鏈嶅姟绔潈濞?*锛屾湰鍦?SWR 缂撳瓨鍙槸蹇収銆?
 *   浠庝粬浜轰富椤电偣銆屽彂绉佷俊銆嶁啋 dm_open RPC 寤轰細璇濓紙鏈嶅姟绔凡寤猴級鈫?璺宠繘鑱婂ぉ椤?鈫?鍙戦€佹垚鍔熴€?
 *   鍙戦€佸悗鍙敼浜嗗唴瀛橀噷鐨?convs锛堝師鏉ュ彧鏈夈€岃宸插瓨鍦ㄣ€嶇殑鍒嗘敮锛夛紝
 *   鑰屻€屾柊寤虹殑浼氳瘽銆嶅湪鍐呭瓨閲?*鍘嬫牴娌℃湁琛?*锛坈onvs 閲屾煡涓嶅埌 鈫?row 涓?undefined锛夛紝
 *   浜庢槸鏃㈡病杩涘唴瀛樸€佷篃娌¤繘 SWR 缂撳瓨 鈥斺€?杩斿洖鍒楄〃鏃舵覆鏌撶殑浠嶆槸**鏃у揩鐓?*锛堟病鏈夋柊浼氳瘽锛夛紝
 *   鍙兘绛?tick 姣?3 鎷嶏紙绾?15s锛夌殑 loadConvsImplicit() 鎵嶆妸鏂颁細璇濇媺鍥炴潵銆?
 *   鐢ㄦ埛鐪嬪埌鐨勫氨鏄€屾垜鏄庢槑鍒氬彂杩囷紝閭ｆ潯璁板綍鍗佸嚑绉掓墠鍐掑嚭鏉ャ€嶃€?
 * 淇硶锛氭湰鍦板凡鐭ョ殑鐘舵€佸彉鍖栵紙鏂板缓浼氳瘽 / 鏀逛簡棰勮锛?*绔嬪埢**鍐欒繘鍐呭瓨 + 鍥炲啓 SWR 缂撳瓨锛?
 *   杩斿洖鍒楄〃鏃惰缂撳瓨鍗冲懡涓柊琛岋紝鏃犻渶绛夌綉缁溿€?
 *   娉ㄦ剰锛氭湇鍔＄浠嶆槸鏉冨▉锛屽悗缁?loadConvs/fresh 浼氱敤鏈嶅姟绔暣鍖呰鐩栵紙鑷剤锛夈€?*/

/* 杞?320 路 鎶娿€屾湰鍦板凡鐭ョ姸鎬併€嶅悎骞惰繘鏈嶅姟绔暣鍖呫€?
 * 鍦烘櫙锛歴end() 鍒氭妸棰勮鍐欒繘鍐呭瓨/缂撳瓨锛岄殢鍚庝竴杞?loadConvs 鐨?fresh 鍥炴潵浜?鈥斺€?
 *   浣嗛偅杞姹傛槸**鍙戞秷鎭箣鍓?*鍙戝嚭鍘荤殑锛屾湇鍔＄蹇収閲岃繕娌℃湁杩欐潯娑堟伅鐨勯瑙堛€?
 *   鐩存帴鐢ㄦ湇鍔＄鏁村寘瑕嗙洊 鈫?鎴戜滑鐨勮ˉ涓佽鏃у揩鐓у啿鎺?鈫?杩斿洖鍒楄〃鍙堢湅鍒扮┖棰勮
 *   锛堟鏄€屽崄鍑犵鎵嶅嚭鐜般€嶇殑鑰佺棁鐘讹級銆?
 * 鍒ゅ畾锛氫互鏃堕棿鎴充负鍑?鈥斺€?鏈嶅姟绔鐨?last_message_at 姣旀湰鍦拌褰曠殑**鏂?*鎴?*鐩稿悓**鏃讹紝
 *   璇存槑鏈嶅姟绔凡缁忓弽鏄犱簡杩欐鍙樺寲锛屾潈濞佸綊鏈嶅姟绔€佷涪寮冩湰鍦拌鐩栵紙閬垮厤瀵规柟鍥炲鍚?
 *   棰勮琚湰鍦版棫鍊兼案杩滈拤浣忥級锛涙湇鍔＄鏇存棫锛堣繕鍦ㄨ矾涓婏級鎵嶇敤鏈湴鍊奸《涓娿€?
 * 鏈嶅姟绔暣鍖呴噷**鏍规湰娌℃湁**杩欎釜浼氳瘽锛堟柊寤轰腑锛夆啋 鐩存帴琛ヤ笂銆?*/
function mergeLocalConvs(rows) {
  const servedBy = new Map((rows || []).map((r) => [String(r.conv_id), r]));
  const list = (rows || []).map((r) => {
    const loc = convLocal.get(String(r.conv_id));
    if (!loc || !loc.last_message_at) return r;
    const srv = Date.parse(r.last_message_at || r.created_at || "") || 0;
    const loc2 = Date.parse(loc.last_message_at || "") || 0;
    /* 杞?376锛氭挙鍥炲彧鏀?last_preview銆佷笉鏀?last_message_at銆傛湇鍔＄蹇収鑻ユ槸鎾ゅ洖鍓?
     * 鍙戝嚭鐨勶紙鍚屼竴鏃堕棿鎴炽€佹棫姝ｆ枃锛夛紝鎸夋椂闂存瘮杈冧細鍒ゃ€屾湇鍔＄涓嶆棫銆嶈€屾妸 鉄?鐩栧洖鍘汇€?
     * preview_rev 鏄挙鍥炶ˉ涓佺殑绮樻€ф爣璁帮細鏃堕棿涓嶆洿鏃т笖姝ｆ枃杩樻病璺熶笂鏃讹紝鏈湴鎾ゅ洖棰勮浼樺厛锛?
     * 鏈嶅姟绔洿鏂板嚭 鉄诧紙鎴栨潵浜嗘洿鏂扮殑娑堟伅锛夊悗鑷劧娓呮帀銆?*/
    if (loc.preview_rev && srv <= loc2 && r.last_preview !== loc.last_preview
      && r.last_preview !== RECALLED_PLACEHOLDER
      && (loc.recalled_from == null || r.last_preview === loc.recalled_from)) {
      return { ...r, ...loc };
    }
    /* 轮382：时间戳相同但服务端预览还是空（跨境网关/旧缓存偶尔只看到时间），
     * 不能拿空预览把刚发的正文盖掉。 */
    if (srv === loc2 && loc.last_preview && !r.last_preview) return { ...r, ...loc };
    if (srv >= loc2) return r;         /* 鏈嶅姟绔凡鏇存柊/鐩稿悓 鈫?鐢ㄦ湇鍔＄鐨?*/
    return { ...r, ...loc };            /* 鏈嶅姟绔洿鏃?鈫?鏈湴椤朵笂 */
  });
  /* 鏈嶅姟绔暣鍖呴噷娌℃湁鐨勬湰鍦颁細璇濓紙鏂颁細璇濊繕娌¤繘鏈嶅姟绔揩鐓э級鈫?琛ヤ笂 */
  const served = new Set(list.map((r) => String(r.conv_id)));
  const patched = new Set();
  for (const [cid, loc] of convLocal) {
    if (served.has(cid)) continue;
    const hit = convs.value.find((c) => String(c.conv_id) === cid);
    if (!hit) continue;
    patched.add(cid);
    list.unshift({ ...hit, ...loc });
  }
  /* 鏈嶅姟绔凡杩戒笂鐨勪細璇?鈫?鎾ゆ帀鏈湴璁板綍锛?
   *   鈶?闃叉鏃ч瑙堟案杩滈拤浣忥紙瀵规柟鍥炲鍚庯紝鏈嶅姟绔鏇存柊锛屼絾鏈湴鍊艰繕鍦?鈫?涓€鐩磋鐩栧洖鍘伙級锛?
   *   鈶?杩欏紶琛ㄤ笉鑳芥棤闄愬闀裤€?
   * 鍒ゅ畾锛氭湇鍔＄鏁村寘閲屾湁瀹冿紝涓旀湇鍔＄ last_message_at 涓嶆瘮鏈湴鏃?鈫?鏈嶅姟绔凡鏄潈濞併€?*/
  for (const r of list) {
    const cid = String(r.conv_id);
    if (patched.has(cid)) continue;
    const loc = convLocal.get(cid);
    if (!loc || !loc.last_message_at) continue;
    const srv = Date.parse(r.last_message_at || r.created_at || "") || 0;
    const loc2 = Date.parse(loc.last_message_at || "") || 0;
    /* 鍚屾椂闂存埑涓旀挙鍥炶ˉ涓佽繕绮樼潃锛氬彧鏈夋湇鍔＄姝ｆ枃宸茬粡璺熶笂锛堟垨鏃堕棿鏇存柊锛夋墠鎾ゆ帀鏈湴琛ヤ竵銆?*/
    const raw = servedBy.get(cid) || r;
    const staleRecall = loc.preview_rev && srv <= loc2
      && raw.last_preview !== loc.last_preview
      && raw.last_preview !== RECALLED_PLACEHOLDER
      && (loc.recalled_from == null || raw.last_preview === loc.recalled_from);
    const sameTimeEmptyPreview = srv === loc2 && !!loc.last_preview && !raw.last_preview;
    if (!staleRecall && srv >= loc2 && !sameTimeEmptyPreview) convLocal.delete(cid);
  }
  return list;
}

/* 杞?320 路 鏈湴宸茬煡鐨勪細璇濈姸鎬侊紙conv_id 鈫?棰勮/鏃堕棿锛夈€?
 * 鐢ㄩ€旓細娑堥櫎绔炴€?鈥斺€?openConv 閲?loadMeta锛堣ˉ琛岋級涓?send 閲?bumpConvPreview锛堟敼棰勮锛?
 *   鏄袱鏉″苟琛岀殑缃戠粶锛岃皝鍏堝洖鏉ラ兘涓嶇‘瀹氥€傝嫢 send 鍏堝洖鏉ワ紝琛岃繕娌″缓 鈫?棰勮浼氫涪锛?
 *   鍙嶄箣 loadMeta 鍚庡埌锛屼細鐢ㄧ┖棰勮鎶婃柊娑堟伅鐩栨帀銆?
 *   杩欓噷鎶娿€屾垜鍒氬彂鐨勩€嶈鍦ㄨ繖寮犺〃閲岋紝寤鸿鏃跺悎骞惰繘鍘伙紝涓ょ鏃跺簭缁撴灉涓€鑷淬€?*/
const convLocal = new Map();

/* 杞?376锛氭湰鍦拌ˉ涓佸彧鑳藉線鍓嶈蛋锛屼笉鑳借鏅氬埌鐨勬棫纭/鏃у疄鏃惰鐩栧洖鍘汇€?
 * 鍚屼竴鏉′細璇濊繛鍙?A銆丅 鏃讹紝B 鍏堢‘璁ゃ€丄 鍚庣‘璁わ紱鏃х増 A 鍥炴潵浼氭妸鍒楄〃棰勮
 * 鏀瑰洖 A锛堟椂闂磋繕鍐欐垚銆岀幇鍦ㄣ€嶏級锛岃繑鍥炲垪琛ㄧ湅鍒扮殑灏辨槸涓婁竴鏉″唴瀹广€?*/
function convLatestAt(cid) {
  const key = String(cid || "");
  const loc = convLocal.get(key);
  const hit = convs.value.find((c) => String(c.conv_id) === key);
  return Math.max(
    Date.parse((loc && loc.last_message_at) || "") || 0,
    Date.parse((hit && hit.last_message_at) || "") || 0,
  );
}

/** 浼氳瘽琛屽啓缂撳瓨锛氬唴瀛?convs 涓?SWR 蹇収鍚屾椂鏇存柊锛堟湇鍔＄鏁村寘鍥炴潵鍚庤嚜鐒惰鐩栵級 */
function writeConvRow(row) {
  if (!row || row.conv_id == null) return;
  const cid = String(row.conv_id);
  /* 鍚堝苟鏈湴宸茬煡鐘舵€侊紙棰勮/鏃堕棿锛夆€斺€?琛ヨ鏃朵笉瑕佹妸銆屾垜鍒氬彂鐨勬秷鎭€嶇洊鎴愮┖棰勮 */
  const loc = convLocal.get(cid);
  const merged = loc ? { ...row, ...loc } : row;
  const hit = convs.value.find((c) => String(c.conv_id) === cid);
  if (hit) Object.assign(hit, merged);
  else convs.value = [merged, ...convs.value];
  if (!meId.value) return;
  cachePatch(cacheKey("dm:convs", meId.value), (rows) => {
    const i = rows.findIndex((c) => String(c.conv_id) === cid);
    if (i >= 0) { rows[i] = { ...rows[i], ...merged }; return rows; }
    return [merged, ...rows];
  }, { createIfMissing: true });
}

/** 鎴戝垰鍙戝嚭鐨勬秷鎭?鈫?璇ヤ細璇濈殑棰勮/鏃堕棿鏇存柊锛堝唴瀛?+ 缂撳瓨鍙屽啓锛?
 *  at 鐢ㄦ湇鍔＄纭鐨?created_at锛氬悓涓€浼氳瘽杩炲彂鏃讹紝鏅氱‘璁ょ殑鏃ф秷鎭笉鑳芥妸
 *  棰勮鏀瑰洖涓婁竴鏉★紱姣斿綋鍓嶅凡鐭ユ渶鏂版椂闂存洿鏃у氨鏁存潯涓㈠純銆?*/
function bumpConvPreview(convId, text, at = "", sender = meId.value) {
  const cid = String(convId);
  const ts = Date.parse(at || "") || Date.now();
  const stamp = new Date(ts).toISOString();
  if (ts < convLatestAt(cid)) return;
  const row = {
    last_preview: String(text || "").slice(0, 80),
    last_message_at: stamp,
    /* 杞?376锛氶瑙堟槸璋佸彂鐨勪篃瑕佽窡鎵嬶紝鍚﹀垯鍒楄〃浼氭妸鎴戠殑鏈€鏂版秷鎭敾鎴愬鏂圭殑銆?*/
    last_sender: sender || undefined,
    preview_rev: 0,   /* 鏂版秷鎭細鑷劧鐩栨帀鎾ゅ洖琛ヤ竵 */
    recalled_from: null,
  };
  /* 璁拌繘鏈湴鐘舵€佽〃锛氳杩樻病寤猴紙meta 鍦ㄨ矾涓婏級涔熶笉涓㈣繖鏉￠瑙?*/
  convLocal.set(cid, { ...(convLocal.get(cid) || {}), ...row });
  const hit = convs.value.find((c) => String(c.conv_id) === cid);
  /* 轮382：从 TA 的主页刚开的会话，loadMeta 可能还在跨境路上。旧代码只更新已存在的行，
   * 用户发完立刻返回列表时这一行根本不存在，只能等 meta / 15s 列表轮询 —— 正是
   * 「发了消息退出看不到，要等很久」。这里先用占位行顶上，loadMeta 回来只补昵称/对方 id。 */
  const info = meta.value && String(meta.value.conv_id) === cid ? meta.value : null;
  const stub = {
    conv_id: convId,
    other_id: (info && info.other_id) || "",
    nickname: (info && info.nickname) || t("dm.someone"),
    accepted: !info || info.accepted !== false,
    muted: !!(info && info.muted),
    hidden: !!(info && info.hidden),
    blocked: !!(info && info.blocked),
    unread: 0,
    created_at: stamp,
    ...row,
  };
  if (hit) Object.assign(hit, row);
  else convs.value = [stub, ...convs.value];
  if (!meId.value) return;
  cachePatch(cacheKey("dm:convs", meId.value), (rows) => {
    const i = rows.findIndex((c) => String(c.conv_id) === cid);
    if (i < 0) return [stub, ...rows];      /* 浼氳瘽杩樻病杩涘垪琛?鈫?涓嶅嚟绌洪€犺锛堢瓑 loadMeta 琛ヨ鏃跺悎骞讹級 */
    rows[i] = { ...rows[i], ...row };
    return rows;
  }, { createIfMissing: true });
}

/** 杞?376锛氭挙鍥炵殑鑻ユ槸鏈€鍚庝竴鏉★紝鍒楄〃棰勮涓嶈兘缁х画鏄剧ず琚挙鍥炵殑鏃ф鏂囥€?
 *  鍙敼棰勮/褰掑睘锛屼笉鍔?last_message_at锛堟挙鍥炰笉鏄柊娑堟伅锛屼笉鑳芥妸浼氳瘽椤跺埌鏈€鍓嶏級銆?*/
function bumpConvRecall(convId, row, list) {
  const cid = String(convId);
  const formal = (Array.isArray(list) ? list : []).filter((m) => m && Number(m.id) > 0);
  if (!formal.length) return;
  const latest = formal.slice().sort((a, b) => {
    const ta = Date.parse(a.created_at) || 0;
    const tb = Date.parse(b.created_at) || 0;
    return ta - tb || (Number(a.id) || 0) - (Number(b.id) || 0);
  }).pop();
  if (!latest || String(latest.id) !== String(row && row.id)) return;
  const hit = convs.value.find((c) => String(c.conv_id) === cid);
  const loc = convLocal.get(cid);
  /* 宸茬粡绮樿繃涓€娆℃挙鍥烇紙渚嬪 tick 鍙堟媺鍒板悓涓€鏉★級灏辨部鐢ㄦ渶鍒濈殑鏃ф鏂囷紝鍒妸 recalled_from
   * 鏀规垚銆屽凡鎾ゅ洖銆嶁€斺€旈偅鏍蜂笅涓€浠芥挙鍥炲墠鐨勬湇鍔＄蹇収灏变細琚綋鎴愭柊姝ｆ枃銆?*/
  const prevPreview = (loc && loc.recalled_from)
    ? loc.recalled_from
    : ((loc && loc.last_preview != null ? loc.last_preview : (hit && hit.last_preview)) || "");
  const patch = {
    last_preview: t("dm.recalled"),
    last_sender: (row && row.sender) || meId.value || undefined,
    preview_rev: Date.now(),   /* 鏈嶅姟绔挙鍥炰笉鏇存柊鏃堕棿鎴筹紝闈犲畠鎸′綇鏃у揩鐓?*/
    recalled_from: prevPreview,
  };
  convLocal.set(cid, { ...(convLocal.get(cid) || {}), ...patch });
  if (hit) Object.assign(hit, patch);
  if (!meId.value) return;
  cachePatch(cacheKey("dm:convs", meId.value), (rows) => {
    const i = rows.findIndex((c) => String(c.conv_id) === cid);
    if (i < 0) return rows;
    rows[i] = { ...rows[i], ...patch };
    return rows;
  });
}

/* 杞?238 路 鎷夐粦琛屼繚鐣欙紙tombstone锛夛細鏈嶅姟绔?dm_list_convs **涓嶈繑鍥?*琚媺榛戠殑浼氳瘽锛?
 * 鑻ュ埛鏂版椂鐩存帴鏁翠綋鏇挎崲 convs锛岃В闄ゆ媺榛戞椂鏈湴宸叉棤琛屽彲鎭㈠锛堝彧鑳界瓑鏈嶅姟绔啀鍒凤級= 涓嶈窡鎵嬨€?
 * 杩欓噷鎶娿€屾湰鍦板凡鎷夐粦銆佹湇鍔＄娌¤繑鍥炪€嶇殑琛岋紙甯﹀畬鏁?conv_id锛夋嫾鍥炲幓鈥斺€斿畠浠 normal/
 * requests 杩囨护鐫€涓嶅彲瑙侊紝瑙ｉ櫎鎷夐粦鍗虫椂鎭㈠銆?*/
function withBlockedTombstones(rows) {
  /* 轮381：conv_id 可能是数字/字符串混用；按 String 比较，否则同一条会话
   * 既在服务端列表里又会被当成「未返回的拉黑行」拼出第二行。 */
  const served = new Set((rows || []).map((r) => String(r.conv_id)));
  const extra = convs.value.filter((c) => c.blocked && !served.has(String(c.conv_id)));
  return extra.length ? (rows || []).concat(extra) : rows;
}

async function loadConvs() {
  if (!signedIn.value) return;
  const owner = meId.value;
  if (!owner) return;
  loadingConvs.value = true;
  const mine = () => signedIn.value && meId.value === owner;
  /* 鏈湴浼樺厛锛圫WR锛夛細鏈夌紦瀛樺厛娓叉煋涓嶉棯銆岃浇鍏ヤ腑銆嶏紝鍚庡彴鍒锋柊锛涙崲璐﹀彿闈?key 閲岀殑 uid 闅旂 */
  await swr(
    cacheKey("dm:convs", owner),
    {
      cached: (rows) => {
        if (!mine()) return;
        convs.value = withBlockedTombstones(mergeLocalConvs(rows));
        loadingConvs.value = false;
        /* 有缓存行时列表已经可信；空缓存仍等后台明确应答（same/fresh）再亮空态，
         * 避免网络失败时把「缓存里恰好是空」误报成「没有会话」。 */
        if (Array.isArray(rows) && rows.length) convsLoaded.value = true;
      },
      fresh: (rows) => {
        if (!mine()) return;
        const merged = withBlockedTombstones(mergeLocalConvs(rows));
        convs.value = merged;
        failed.value = false;
        convsLoaded.value = true;   /* 鏈嶅姟绔槑纭簲绛旓紙鍚┖鍒楄〃锛夆€斺€斻€岃繕娌℃湁浼氳瘽銆嶄粠姝ゅ埢璧锋墠鍙俊 */
        convsRetryN = 0;            /* 鎴愬姛鍗冲仠蹇€熼噸璇?*/
        /* 杞?376锛歴wr 鍥炲啓鐨勬槸鏈嶅姟绔師濮嬪揩鐓э紱鎶婂悎骞跺悗鐨勬湰鍦版挙鍥?棰勮琛ヤ竵鍐嶇洊鍥炲幓锛?
         * 鍚﹀垯鍒锋柊涓€娆″垪琛ㄥ氨鎶婂垰鎾ゅ洖鐨勯瑙堟崲鍥炴棫姝ｆ枃銆?*/
        cacheSet(cacheKey("dm:convs", owner), merged);
      },
      same: () => {
        if (!mine()) return;
        /* 轮454：缓存里的空列表 + 服务端仍返回空列表时，swr 会跳过 fresh。
         * 这里补收加载态，否则「没有会话」空态永远不出现，用户每次进来都像还在转圈。 */
        convsLoaded.value = true;
        failed.value = false;
        convsRetryN = 0;
      },
      onError: () => { if (mine()) { failed.value = true; scheduleConvsRetry(); } },
    },
    () => dmApi.listConvs(200, 0),
  );
  if (mine()) loadingConvs.value = false;
}

/* 杞?266锛氱綉缁滃け璐ュ揩閫熼噸璇曪紙鏃х増澶辫触鍚庤绛?15s 鍚庣殑杞鎵嶅彲鑳芥仮澶嶏紝
 * 鏈熼棿鍒楄〃鏄剧ず銆岃繕娌℃湁浼氳瘽銆? 鐢ㄦ埛鐪嬪埌鐨勩€屽亣绌恒€嶏級銆?s 涓€璇曘€佹渶澶?3 娆★紝鎴愬姛鍗冲仠銆?*/
let convsRetryN = 0;
let convsRetryTimer = 0;
function scheduleConvsRetry() {
  if (convsRetryN >= 3 || convsRetryTimer) return;
  convsRetryN += 1;
  convsRetryTimer = setTimeout(() => { convsRetryTimer = 0; loadConvs(); }, 3000);
}

async function openBottleChat(id) {
  /* 杞?238锛?*鍏堝紑鑱婂ぉ**锛堟湰鍦板簱绉掑紑锛夛紝鍒楄〃鍒锋柊杞悗鍙扳€斺€?
   * 鏃х増 await loadConvs() 鎸″湪鍓嶉潰锛岀敤鎴峰疄娴嬨€屾參鐨勮姝伙紝涓嶆槸瀛樻湰鍦板悧銆嶏細
   * 瀛樹簡鏈湴涔熻浼氳瘽鍒楄〃鐨勭綉缁滃埛鏂板牭姝汇€傚垪琛ㄦ暟鎹敱鍚庡彴鍒锋柊琛ラ綈銆?*/
  openConv(String(id));
  loadConvs();
}

async function loadMeta(id) {
  const cid = String(id);
  const owner = meId.value;
  if (!owner) return;
  try {
    const m = await dmApi.convMeta(id);
    if (!signedIn.value || meId.value !== owner) return;   /* 杞?376锛氱櫥鍑?鎹㈠彿鍚庢棫 meta 涓嶈鍐欒繘鏂拌处鍙?*/
    /* 杞?376锛氭繁閾?A 杩樻病鍥炲氨鍒囧埌 B锛孉 鐨?meta 鍥炴潵浼氭妸 B 鐨勬爣棰?鑿滃崟鐩栨垚 A銆?
     * 鍙厑璁稿綋鍓嶄細璇濆啓 meta锛涜ˉ鍒楄〃浠嶇劧鍙互鍋氾紙閭ｆ槸浼氳瘽鏁版嵁锛屼笉鏄綋鍓嶅ご锛夈€?*/
    if (String(activeId.value) === cid) meta.value = m;
    /* 杞?320锛歮eta 鍥炴潵 = 宸茬粡鐭ラ亾杩欎釜浼氳瘽鏄皝锛堟樀绉?瀵规柟 id锛夆€斺€?椤哄娍鎶婂畠**琛ヨ繘鍒楄〃**
       锛堝唴瀛?+ SWR 缂撳瓨锛夈€傝繖鏄€屼粠涓婚〉鍙戠淇°€嶉偅鏉￠摼璺殑缂哄彛锛?
       dm_open 鍦ㄦ湇鍔＄寤轰簡浼氳瘽锛屼絾瀹㈡埛绔唴瀛?缂撳瓨閲屾病鏈夊搴旇锛?
       鍒楄〃瑕佺瓑涓嬩竴娆″畬鏁村埛鏂帮紙tick 姣?3 鎷?鈮?5s锛夋墠鐪嬪緱鍒拌繖鏉℃柊浼氳瘽銆?
       杩欓噷琛ヨ鍚庯紝杩斿洖鍒楄〃绔嬪埢鍙锛涢殢鍚?loadConvs 鐨?fresh 浼氱敤鏈嶅姟绔暣鍖呮牎鍑嗐€?*/
    if (m && m.conv_id != null) {
      const hit = convs.value.find((c) => String(c.conv_id) === String(m.conv_id));
      const row = {
        conv_id: m.conv_id,
        last_message_at: (hit && hit.last_message_at) || new Date().toISOString(),
        last_preview: (hit && hit.last_preview) || "",
        created_at: (hit && hit.created_at) || new Date().toISOString(),
        accepted: m.accepted != null ? m.accepted !== false : (hit ? hit.accepted !== false : true),
        muted: m.muted != null ? !!m.muted : !!(hit && hit.muted),
        hidden: m.hidden != null ? !!m.hidden : !!(hit && hit.hidden),
        blocked: m.blocked != null ? !!m.blocked : !!(hit && hit.blocked),
        unread: (hit && hit.unread) || 0,
      };
      if (m.other_id != null) row.other_id = m.other_id;
      if (m.nickname != null) row.nickname = m.nickname;
      /* 首聊上限的可选精确字段：后端将来带上时别在 loadMeta 这层丢掉。 */
      if (m.peer_replied != null) row.peer_replied = m.peer_replied === true;
      if (m.my_count != null) row.my_count = Number(m.my_count);
      writeConvRow(row);
    }
  } catch (e) { /* 鐢ㄥ垪琛ㄩ噷鐨勮鍏滃簳 */ }
}

async function loadMessages(id, { before = null } = {}) {
  if (!id) return false;
  /* 杞?225锛氭湰杞殑鍙?鈥斺€?await 鍥炴潵鍚庤嫢鍙疯椤舵帀銆佹垨鐢ㄦ埛宸插垏璧帮紝杩欎唤鏁版嵁鏁翠唤涓㈠純 */
  const mySeq = ++msgSeq;
  const cid = String(id);
  const owner = meId.value;
  if (!owner) return false;   /* 杞?376锛氭湭璁よ瘉涓嶈涓嶅啓浠讳綍鏈湴搴?*/
  /* 杞?376锛氶櫎浜嗗垏浼氳瘽/鏂板姞杞斤紝鐧诲嚭鎹㈠彿涔熺畻杩囨湡 鈥斺€?鏃у搷搴斾笉鑳藉啓杩涙柊璐﹀彿鐨勫簱銆?*/
  const stale = () => isStale(mySeq, cid) || (!!owner && meId.value !== owner);
  /* 杞?214锛氬垏浼氳瘽鍏堟竻灞忊€斺€斾笂涓€涓細璇濈殑娑堟伅鍙杩樼暀鍦?msgs 閲岋紝浠讳綍鏃跺簭绔炴€?
   * 锛堟湰鍦板簱涓虹┖鐨勪細璇濄€佺綉缁滄參銆佺‖涓婇檺鍏滃簳鎻ず锛夐兘浼氳瀹冮棯鍑烘潵
   * 锛堢敤鎴峰疄娴嬨€屾墦寮€鍙︿竴涓細璇濇湁鏃惰烦闂墠涓€涓細璇濈殑鍐呭銆嶏級銆傜粨鏋勪笂娓呴浂锛屾案缁濆悗鎮ｃ€?*/
  if (msgsConv !== cid) {
    msgs.value = [];
    /* 轮381：清屏后必须把「当前窗口属于哪个会话」也清掉。旧代码留着上一个
     * 会话的 cid，A→B→A 时 B 的加载刚把 msgs 清空、msgsConv 还是 A，
     * 此时在 A 发送会被误判成「窗口里就是 A」，拿只有一条确认行的列表覆盖 A 的历史。 */
    msgsConv = "";
    oldestId.value = null;
    hasMore.value = true;
  }
  let smoothed = false;   /* 杞?173c锛歠resh 鏈夋柊娑堟伅鏃跺凡骞虫粦婊氬埌鏂板簳锛岃皟鐢ㄦ柟鍏嶅啀鐬椂婊?*/
  loadingMsgs.value = true;
  const applyRows = (rows, more) => {
    if (stale()) return false;   /* 杞?225锛氳繃鏈熷搷搴旂粷涓嶈惤杩涘垪琛紙杩欐槸涓蹭細璇濈殑鐩存帴鍏ュ彛锛?*/
    /* 鏈嶅姟绔繑鍥炴柊鈫掓棫锛氬弽杞负鏃р啋鏂帮紙娓叉煋椤哄簭锛夛紱鏈湴搴撻噷鍙兘娈嬬暀涓婃宕╂簝鐨?
     * 銆屽彂閫佷腑銆嶈锛屾病鏈夊搴斿湪椋炶姹傚氨闄嶇骇鎴愬け璐ヨ锛岄伩鍏嶆案涔?pending銆?*/
    /* 杞?376锛氱綉鍏抽噸澶嶉〉 / 鏈湴鍧忓簱鍙兘甯﹀悓 id 涓よ锛涘厛鎸?id 鍘婚噸鍐嶄笂灞忥紝
     * 鍚﹀垯鏃х増鍒楄〃浼氶噸澶嶆樉绀恒€佹棩鏈熷垎闅斾篃璺熺潃閲嶃€?*/
    const asc = [];
    const seen = new Set();
    for (const r of (Array.isArray(rows) ? rows.slice().reverse() : [])) {
      /* 轮 377：网关/RPC 可能混用数字/字符串 id，按 String 去重。 */
      const idKey = r && r.id != null ? String(r.id) : "";
      if (!r || r.id == null || seen.has(idKey)) continue;
      seen.add(idKey);
      asc.push(reviveLocal(r));
    }
    if (before == null || msgsConv !== cid) {
      /* 杞?316/376锛氭暣绐楁浛鎹笉璁稿悶鎺夊湪椋炵殑涔愯琛岋紝涔熶笉璁稿悶鎺夊彂閫佸凡缁忕‘璁ゃ€?
       * 浣嗕笉鍦ㄨ繖娆￠灞忓揩鐓ч噷鐨勬鏁拌銆傛棫鐗堝彧淇濈暀 id<0锛岀‘璁よ浼氳鏁寸獥鎶规帀锛?
       * 鐢ㄦ埛鐪嬪埌銆屽彂鍑哄幓鏈夈€佸啀鐐硅繘鏉ユ病浜嗭紝寰堜箙鍚庢墠鍑虹幇銆嶃€?*/
      /* 轮382：快照自己可能就同时带着「发送中」和「已发送」两条（上一条 RPC 还没回来），
       * 先在同一份快照里认领；再和屏上还在飞的乐观行认领。 */
      const snap = dropEchoedPending(asc);
      const incoming = new Set(snap.map((m) => String(m.id)));
      const claimed = claimPendingEcho(msgs.value, snap);
      /* 轮 377：负数待发行也只有「不在 incoming 里」才保留。IDB/本地快照可能已经带着
       * 同一条负数行，旧写法无条件保留会把它 concat 成两行。 */
      const keep = claimed.rows.filter((m) => !incoming.has(String(m.id)));
      msgs.value = dropEchoedDrafts(keep.length ? snap.concat(keep) : snap, snap);
    } else {
      /* 杞?157锛氬悜涓婄炕鍘嗗彶鐨勯敋鐐逛繚鎸佲€斺€斿厛閲忛珮銆佹彃琛屻€佷笅涓€甯ф妸 scrollTop 琛ヤ笂宸€笺€?
       * 涓嶈ˉ鐨勮瘽娴忚鍣ㄦ妸瑙嗗彛閽夊湪鍘?scrollTop 涓婏紝鍐呭鍑┖銆岃烦銆嶄竴椤碉紱
       * 涓存椂鍏冲钩婊戞粴鍔紝闃叉祻瑙堝櫒鍔ㄧ敾涓庝汉閿氱偣鎵撴灦銆?*/
      const el = listEl.value;
      const oldH = el ? el.scrollHeight : 0;
      /* 杞?376锛氱綉鍏抽噸澶嶉〉 / 鏈湴椤典笌缃戠粶椤佃竟鐣岄噸鍙犳椂鎸?id 鍘婚噸锛?
       * 鍚﹀垯鍚屼竴鏉″巻鍙蹭細鍦ㄥ垪琛ㄩ噷鍑虹幇涓ゆ锛屽垎椤甸敋鐐逛篃浼氳閲嶅椤垫嫋浣忋€?*/
      const seen = new Set(msgs.value.map((m) => String(m.id)));
      msgs.value = asc.filter((m) => !seen.has(String(m.id))).concat(msgs.value);
      if (el) requestAnimationFrame(() => {
        /* 轮 377：这一帧到来前用户可能已切到别的会话；旧代码仍拿旧会话的
         * 高度差去改新会话的 scrollTop = 切完位置乱跳。 */
        if (msgsConv !== cid || String(activeId.value) !== String(cid)) return;
        const prevSb = el.style.scrollBehavior;
        el.style.scrollBehavior = "auto";
        el.scrollTop += el.scrollHeight - oldH;
        el.style.scrollBehavior = prevSb || "";
      });
    }
    msgsConv = cid;
    hasMore.value = more != null ? more : rows.length === 30;
    oldestId.value = oldestServerId(msgs.value);
    return true;
  };
  /* 鈹€鈹€ 杞?194锛氭湰鍦板簱绉掑紑鈥斺€旇繘浼氳瘽鐬棿娓叉煋鏈湴瀹屾暣鍘嗗彶锛堥浂缃戠粶绛夊緟銆侀浂闂烦锛夆攢鈹€
   * 193c 鍘绘帀缂撳瓨涓棿鎬佸悗棣栨杩涘叆瑕佺瓑缃戠粶锛堢敤鎴峰疄娴?~10s 绌虹櫧锛夆€斺€?
   * 姝ｈВ鏄井淇″紡鏈湴搴擄細localStorage 鎸佷箙瀛樻瘡浼氳瘽鍏ㄩ噺娑堟伅锛岃繘浼氳瘽鍚屾璇诲彇娓叉煋銆?*/
  if (before == null) {
    const local = dmStoreLoad(meId.value, cid);
    if (local.msgs.length) {
      /* 杞?376锛氬悓浼氳瘽閲嶅紑鏃朵笉鑳芥嬁鏈湴搴撴暣绐楁浛鎹㈠綋鍓?msgs 鈥斺€?鐢ㄦ埛鍙兘宸茬粡涓婃粦
       * 缈昏繃鍑犻〉鍘嗗彶锛屾湰鍦板簱鍙瓨鏈€杩?400 鏉★紝鏁寸獥鏇挎崲浼氭妸缈昏繃鐨勬洿鏃╅〉涓㈡帀
       * 锛堝啀鎯崇湅寰楅噸鏂版粴/閲嶆柊鎷夛級銆傚悓浼氳瘽鍙ˉ褰撳墠娌℃湁鐨勮锛?
       * 宸叉湁琛屼互褰撳墠鍐呭瓨涓哄噯锛堝彲鑳藉垰浠庢湇鍔＄鎾ゅ洖/鏇存柊锛夛紝鏈湴鏃ф鏂囦笉璁稿€掔亴锛?
       * 鏈湴澶氬嚭鏉ョ殑鏇存棭椤靛垯骞惰繘鏉ワ紝淇濊瘉閲嶅紑浠嶈兘绔嬪埢鐪嬪埌闀垮巻鍙层€?
       * 棣栨杩涘叆锛坢sgsConv 涓嶅悓锛夋墠鏁寸獥钀藉睆銆?*/
      const sameConv = msgsConv === cid && msgs.value.length > 0;
      if (sameConv) {
        const have = new Set(msgs.value.map((m) => String(m.id)));
        /* 鍙ˉ鏈湴纭杩囩殑姝ｆ暟琛岋紱鏈湴娈嬬暀鐨勫け璐?寰呭彂琛屼笉瑕侀噸鏂板€掔亴杩涘綋鍓嶄細璇?
         * 锛堢敤鎴峰彲鑳藉凡缁忛噸鍙戞垚鍔燂紝褰撳墠鍒楄〃閲屾病鏈夐偅鏉℃棫璐熸暟琛屼簡锛夈€?*/
        const extra = local.msgs.filter((m) => m.id > 0 && !have.has(String(m.id)));
        if (extra.length) {
          /* 轮382：本地库若已经写入了刚发那条的正式行，先从屏上摘掉它的乐观行，
           * 再把正式行补进来；否则重开同会话会短暂看到两条。 */
          const claimed = claimPendingEcho(msgs.value, extra);
          const got = new Set(claimed.rows.map((m) => String(m.id)));
          const add = extra.filter((m) => !got.has(String(m.id)));
          msgs.value = dropEchoedDrafts(add.length ? claimed.rows.concat(add) : claimed.rows, local.msgs);
        }
        oldestId.value = oldestServerId(msgs.value);
      } else if (!applyRows(local.msgs.slice().reverse(), local.more)) {
        return false;   /* 杞?225锛氬凡杩囨湡灏卞埆缁х画 */
      }
      entryReady.value = true;   /* 杞?194锛氭湰鍦版暟鎹凡钀藉畾锛屾彮绀洪棬鎺у嵆鍒诲彲寮€ */
      /* 杞?228 路 绉掑紑锛氭湰鍦板簱鍛戒腑鐨勬槸**璇ヤ細璇濈殑瀹屾暣鍘嗗彶**锛堟渶澶?400 鏉★級锛屾鍒诲凡鍚屾娓叉煋瀹屾瘯锛?
       * 鈹€鈹€ 杩欏氨鏄€屽井淇″紡绉掑紑銆嶈鏈夌殑鏍峰瓙銆備笉鍐嶅幓绛夈€屽瓧浣撳氨缁?+ 楂樺害杩炵画 hold ms銆嶉偅閬撻棬锛?
       * 閭ｉ亾闂ㄦ槸杞?176/180 涓恒€?0 鏉＄紦瀛樼獥鍙ｈ fresh 绐楀彛鏁寸獥鏇挎崲銆侀珮搴?卤鍗?px銆嶅噯澶囩殑锛?
       * 鑰屾湰鍦板簱璺緞鏍规湰涓嶅瓨鍦ㄦ暣绐楁浛鎹紙缃戠粶鍥炴潵鍙蛋 mergeTail 寰€灏鹃儴骞讹級銆?
       * 鐢ㄦ埛瀹炴祴鍙嶉锛氭湰鍦板簱鏄庢槑宸茬粡璇诲嚭鏉ヤ簡锛岀偣杩涗細璇濆嵈杩樿妤炰竴涓?鈥斺€?灏辨槸琚繖閬撻棬鎸′綇鐨勩€?
       * 娉ㄦ剰蹇呴』璧?scrollBottom 鐨?reveal 鍙傛暟锛堥拤搴曚笌鎻ず鍚屼竴甯э級锛屼笉鑳藉湪杩欓噷鐩存帴缃?true锛?
       * 鍚﹀垯浼氬厛浜嚭鍒楄〃椤堕儴鍐嶈烦鍒板簳锛堢湡鏈哄疄娴嬮甯ц窛搴?4649px锛夈€?*/
      scrollBottom(false, true);
      loadingMsgs.value = false;
    }
  }
  /* ── 轮 330 · IndexedDB 补首帧 ──
   * dmStore锛坙ocalStorage锛夊彧瀛樻渶鍚庝竴灞忥紙鈮?00 鏉★級锛屾崲璁惧 / 娓呰繃 localStorage 鏃舵病鏈夊畠锛?
   * 鏃ц矾寰勫氨寰楃瓑缃戠粶锛堝疄娴?0.6~1s 绌虹櫧锛屾濂借鐢ㄦ埛鐪嬫垚銆岀偣杩涘幓鍗婂ぉ娌℃秷鎭€嶏級銆?
   * IndexedDB 閲屾湰鏉ュ氨鏈夊叏閲忓巻鍙诧紝鍏堟嬁瀹冮《涓婏細鍜?dmStore 涓€鏍峰悓姝ヨ惤灞忥紝缃戠粶鍥炴潵鍐嶅苟灏鹃儴銆?*/
  /* 轮 377：本地库可能只有一条失败草稿（没有正式历史）；IDB 里有完整历史时
   * 也要顶上来。旧条件只看 msgs.length，会把「只有负数行」误判成已有首帧。 */
  const thinLocal = msgs.value.length > 0 && msgs.value.length < 5;
  if (before == null && meId.value
    && (!msgs.value.some((m) => Number(m.id) > 0) || thinLocal)) {
    const rec = await idbLoad(cid);
    if (stale()) return false;
    const idbRows = (rec && Array.isArray(rec.msgs)) ? rec.msgs : [];
    if (idbRows.length) {
      /* 轮378：全量库可能有几万条；首帧只上最近 400 条，和 localStorage 同量级，
       * 避免进会话先渲染几万个节点卡死。更早的继续走 loadMore/idbOlderThan。 */
      const latest = idbRows.slice(-400);
      const hasOlder = idbRows.length > latest.length;
      if (!applyRows(latest.slice().reverse(), hasOlder || !(rec && rec.serverDone))) return false;
      entryReady.value = true;
      scrollBottom(false, true);
      loadingMsgs.value = false;
    }
  }
  /* 杞?376锛氬悓浼氳瘽閲嶅紑鏃讹紝褰撳墠 msgs 閲屾湰鏉ュ氨鏈夋秷鎭紙鍙槸鏈湴搴撳彲鑳借娓呰繃 /
   * 闅愮妯″紡涓嶅彲鐢級銆傛棫浠ｇ爜鍙銆屾湰鍦板簱鍛戒腑銆嶆墠鎻ず锛岃繖閲屼細涓€鐩寸瓑鍒扮綉缁滃洖鏉ワ紝
   * 鍙堝彉鎴愮敤鎴疯鐨勩€岀偣杩涘幓鍗婂ぉ涓嶆樉绀恒€嶃€傚唴瀛樺凡鏈夋暟鎹氨鐩存帴鎻ず骞堕拤搴曘€?*/
  if (before == null && msgsConv === cid && msgs.value.length) {
    entryReady.value = true;
    scrollBottom(false, true);
    loadingMsgs.value = false;
    /* 鍐呭瓨閲屽凡鏈夊畬鏁寸獥鍙ｅ氨椤烘墜鍥炲啓锛岄伩鍏嶃€屾湰鍦板簱琚竻杩?+ 杩欐缃戠粶鍙堝け璐ャ€?
     * 瀵艰嚧涓嬫杩涙潵浠嶇劧绌虹櫧銆?*/
    if (meId.value) {
      dmStoreSave(meId.value, cid, msgs.value, hasMore.value);
      idbMerge(cid, msgs.value);
    }
  }
  /* 鈹€鈹€ 缃戠粶锛氬閲忔媺鍙栧悗鍚堝苟锛堜笉鏇挎崲娓叉煋涓殑鍒楄〃锛夆攢鈹€ */
  try {
    if (before != null) {
      /* 杞?204锛氱炕鍘嗗彶浼樺厛鍚冩湰鍦板叏閲忓簱锛圛ndexedDB锛夆€斺€旀湰鍦版湁灏辩洿鎺ヨˉ椤碉紝闆剁綉缁滈浂绛夊緟 */
      const idbRows = await idbOlderThan(cid, before, 30);
      if (stale()) return false;   /* 杞?225 */
      /* 轮379：本地只剩 1~4 条更早历史时也要先上屏。旧条件 >=5 会把这几条
       * 藏起来去等网络；弱网/离线时用户上滑一直看不到，误以为历史丢了。 */
      if (idbRows.length > 0) {
        /* idbOlderThan 杩斿洖鐨勬槸**鍗囧簭**锛堟棫鈫掓柊锛夛紝applyRows 绾﹀畾鍏ュ弬鏄湇鍔＄鐨?
         * 鏂扳啋鏃э紱鏃т唬鐮佺洿鎺ヤ紶杩涘幓浼氬厛 reverse 鎴愰檷搴忓啀 concat锛宺aw msgs 椤哄簭琚墦涔便€?
         * 杞?376锛氬厛缈绘垚鏂扳啋鏃у啀浜ょ粰 applyRows锛屼繚璇佸垎椤甸敋鐐?鏈湴搴撻兘鎸夊悓涓€椤哄簭钀姐€?*/
        /* 轮379：若本地页全是已上屏的行（锚点过期/边界重叠），不能在这里直接 return；
         * 否则 oldestId 不动、hasMore 仍为 true，用户每次上滑都重复同一页却永远翻不动。 */
        const prevOldest = oldestId.value;
        if (!applyRows(idbRows.slice().reverse(), true)) return false;
        if (oldestId.value !== prevOldest) {   /* 鏈湴椤靛亣璁捐繕鏈夋洿鏃╋紙缃戠粶灞備粛鏈夊垯鍚庣画鍐嶈ˉ锛?*/
          dmStoreSave(meId.value, cid, msgs.value, hasMore.value);
          loadingMsgs.value = false;
          /* 轮381：上滑页可能在本轮 openConv 的钉底还没收尾时就到（legacy 自动翻页）；
           * 不释放 pinning 会让后续 onScrollTop 永远早退。 */
          pinning.value = false;
          return smoothed;
        }
      }
    }
    const rows = (await dmApi.listMessages(cid, { before, limit: 30 })) || [];
    /* 杞?225锛氱瓑鍝嶅簲杩欐灏辨槸绔炴€佺獥鍙?鈥斺€?鐢ㄦ埛鍙兘宸茬粡杩斿洖鍒楄〃鎴栫偣寮€浜嗗埆鐨勪細璇濄€?
     * 杩囨湡灏辨暣浠戒涪寮冿細涓嶅啓鍒楄〃銆佷笉钀芥湰鍦板簱銆佷笉瑙﹀彂鍥炲～锛堝惁鍒欎細鎶?A 鐨勬秷鎭瓨杩?B 鐨勫簱锛夈€?*/
    if (stale()) return false;
    const asc = rows.slice().reverse();
    if (before != null) {
      /* 轮381：网关若忽略 p_before 返回同一页，applyRows 之后锚点不动；
       * 不能再让 hasMore 保持 true，否则每次上滑都拉同一页。 */
      const prevOldest = oldestId.value;
      if (!applyRows(rows, rows.length === 30)) return false;
      if (rows.length === 30 && oldestId.value === prevOldest) hasMore.value = false;
      idbMerge(cid, rows, { older: true });   /* 杞?204锛氱綉缁滃巻鍙查〉闀滃儚杩涘叏閲忓簱 */
    } else if (msgsConv === cid) {
      /* 閲嶅紑/鍒锋柊鍚屼細璇濓細灏鹃儴澧為噺骞跺叆锛堜繚浣忓凡缈诲巻鍙诧級锛屼笉鏁寸獥鏇挎崲銆?
       * 杞?375锛氳繖閲屽師鏉ヨ繕瑕佹眰銆屾病鏈夎礋鏁板緟鍙戣銆嶆墠璧?mergeTail锛涗竴鏃︽湁寰呭彂琛屽氨鏁寸獥鏇挎崲锛?
       * 鑰屽垰纭鐨勮 id 宸茬粡鍙樻垚姝ｆ暟锛屼笉鍦ㄦ湇鍔＄杩欐蹇収閲?鈫?琚暣绐楁姽鎺夛紝
       * 鐢ㄦ埛鐪嬪埌銆屽彂鍑哄幓鏈夈€佸啀鐐硅繘鏉ユ病浜嗭紝寰堜箙鍚庢墠鍑虹幇銆嶃€傜幇鍦ㄥ悓浼氳瘽涓€寰?mergeTail锛?
       * 寰呭彂琛屻€佸垰纭琛屻€佸凡缈诲巻鍙查兘淇濅綇锛屾湇鍔＄鍙ˉ灏鹃儴銆?*/
      const { rows: merged, added } = mergeTail(msgs.value, asc);
      if (added) {
        pinning.value = false;
        scrollGen++;
        smoothed = true;
        msgs.value = merged;
        /* 轮 377：同会话重开时消息区还隐藏，这里若只做 smooth 滚动不会揭示；
         * openConv 又因 smoothed=true 跳过 scrollBottom，只能等 2s 兜底。 */
        if (!listRevealed.value) scrollBottom(false, true);
        else nextTick(() => {
          /* 轮 377：下一帧前切走，不要把新会话平滑滚到底。 */
          if (msgsConv !== cid || String(activeId.value) !== String(cid)) return;
          const el = listEl.value;
          if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
        });
      } else if (merged !== msgs.value) {
        /* 鏃犳柊澧炰絾鏈夊師浣嶆洿鏂帮紙濡傚鏂规挙鍥烇級锛氳惤鍥炲搷搴斿紡鏁扮粍銆?
         * 娉ㄦ剰蹇呴』姣斿 mergeTail 鐨勮繑鍥炲€尖€斺€旀瘮瀵瑰師濮?rows 浼氭妸鏈嶅姟绔€掑簭绐楀彛濉炶繘鍒楄〃锛堣疆194瀹炴祴bug锛夈€?*/
        msgs.value = merged;
      }
      /* 杞?376锛氬悓浼氳瘽閲嶅紑涓旀湰鍦板簱涓虹┖鏃朵篃浼氳蛋鍒拌繖閲屻€傛棫浠ｇ爜鍙湪銆屾崲浼氳瘽/鏈湴鍛戒腑銆?
       * 鍒嗘敮鎶?entryReady 缃?true锛岃繖鏉″垎鏀竴鐩?false 鈫?娑堟伅鍖鸿鎻ず闂ㄦ帶钘忎綇锛?
       * 瑕佺瓑 10s 纭笂闄愭墠浜€傜綉缁滃凡缁忓簲绛旓紝杩欓噷灏辨槸鍙互鎻ず鐨勬椂鏈恒€?*/
      entryReady.value = true;
      oldestId.value = oldestServerId(msgs.value);
    } else {
      if (!applyRows(rows, rows.length === 30)) return false;
      entryReady.value = true;   /* 杞?194锛氶杩涙棤鏈湴搴擄紝缃戠粶钀藉畾鍗冲紑鎻ず闂ㄦ帶 */
    }
    if (stale()) return false;   /* 杞?225锛氳惤搴撳墠鍐嶇‘璁や竴娆?鈥斺€?闃叉妸 A 鐨勬秷鎭啓杩?B 鐨勬湰鍦板簱 */
    /* 鏈湴搴撳悓姝ワ紙鍏ㄩ噺钀界洏锛?*/
    dmStoreSave(meId.value, cid, msgs.value, hasMore.value);
    idbMerge(cid, msgs.value);   /* 杞?204锛氶暅鍍忚繘鍏ㄩ噺搴?*/
    if (before == null) backfillOlder(cid);   /* 杞?204锛氶潤榛樺洖濉洿鏃╁巻鍙诧紙鍙啓搴撲笉杩?UI锛?*/
  } catch (e) {
    if (stale()) return false;   /* 杞?225 */
    /* 杞?376锛氶灞忕綉缁滃け璐ユ椂涓嶈鎶?hasMore 閽夋鎴?false銆傚惁鍒欎箣鍚庡疄鏃?杞琛ヨ繘
     * 绗竴鏉℃秷鎭€佹湁浜?oldestId锛屼篃姘歌繙涓婃粦涓嶅姩鏇存棭鍘嗗彶銆備繚鐣?true锛岀瓑涓嬩竴娆?
     * 杩涗細璇濇垨瀹炴椂娑堟伅鍐嶇户缁炕銆?*/
    if (before == null) {
      if (msgsConv !== cid) applyRows([], true);
      /* 轮 377：首屏网络失败且本地/IDB 都没有数据时，旧代码 entryReady 一直为 false，
       * openConv 的揭示兜底也要求 entryReady，消息区会一直隐藏到 10s 硬上限。
       * 这里标记首屏已落定，让空态（或已存在的乐观行）按正常节奏显示。 */
      if (String(activeId.value) === cid) entryReady.value = true;
    }
  }
  if (stale()) return false;   /* 杞?225锛氳繃鏈熸椂杩?loadingMsgs/pinning 閮戒笉瑕佺锛堟柊璇锋眰鍦ㄧ锛?*/
  loadingMsgs.value = false;
  if (before == null) pinning.value = false;
  return smoothed;
}

/* 鈹€鈹€ 杞?204 路 鍚庡彴鍥炲～锛氭妸璇ヤ細璇濇湇鍔″櫒渚х殑鏇存棭鍘嗗彶鍒嗛〉鎷夊叏銆佸彧鍐?IndexedDB锛堜笉杩?UI锛夈€?
 * 鏂偣锛歜ackfilledTo锛堝凡鍥炲～鍒扮殑鏈€鏃?id锛夛紱璺戝畬缃?serverDone=true 姘镐箙璺宠繃銆?
 * 鑺傛祦锛氭瘡椤?sleep 120ms锛涘崟娆¤繘浼氳瘽鏈€澶?40 椤碉紙闃插け鎺э級锛屾病鎷夊畬涓嬫杩涗細璇濈画浼犮€?*/
const backfillBusy = new Set();
async function backfillOlder(convId) {
  if (backfillBusy.has(String(convId))) return;
  const owner = meId.value;
  backfillBusy.add(String(convId));
  try {
    if (!owner || !signedIn.value) return;
    if (await idbServerDone(convId)) return;
    /* 杞?376锛氭柇鐐圭画浼?鈥斺€?鏃х増姣忔閮戒粠 watermark=null 閲嶆媺鏈€鏂?50 鏉★紝
     * 涓婃宸茬粡鍥炲～鍒颁竴鍗婄殑浼氳瘽涓嬫杩涘張浠庡ご鎵竴閬嶏紙寮辩綉/闀垮巻鍙茬櫧鑰楁祦閲忥級銆?
     * backfilledTo 灏辨槸涓婃宸插洖濉埌鐨勬渶鏃?id锛岀洿鎺ヤ粠瀹冪户缁線鍓嶃€?*/
    const rec = await idbLoad(convId);
    let watermark = rec && rec.backfilledTo != null ? rec.backfilledTo : null;
    for (let page = 0; page < 40; page++) {
      /* 轮381：离开会话就停（|| 不是 &&）—— 旧写法在切到 B、msgsConv 还是 A 时
       * 仍会继续拉 A 的历史，白耗流量；切回 A 时会重新触发。 */
      if (String(activeId.value) !== String(convId) || msgsConv !== convId) return;   /* 宸茬寮€璇ヤ細璇?*/
      if (!signedIn.value || meId.value !== owner) return;   /* 杞?376锛氱櫥鍑?鎹㈠彿鍚庡仠鍐欐棫璐﹀彿 */
      const rows = (await dmApi.listMessages(convId, { before: watermark, limit: 50 })) || [];
      if (!signedIn.value || meId.value !== owner) return;   /* 杞?376锛氳姹傛湡闂存崲鍙凤紝鍒妸鏃ц处鍙峰巻鍙插啓杩涙湰鏈哄簱 */
      if (!rows.length) { await idbMerge(convId, [], { serverDone: true }); return; }
      await idbMerge(convId, rows, { older: true });
      watermark = rows[rows.length - 1].id;   /* rows 鏂扳啋鏃э紝鏈潯鏈€鏃?*/
      if (rows.length < 50) { await idbMerge(convId, [], { serverDone: true }); return; }
      await new Promise((r) => setTimeout(r, 120));
    }
  } catch (e) { /* 闈欓粯锛氫笅娆¤繘浼氳瘽缁紶 */ }
  finally { backfillBusy.delete(String(convId)); }
}

function scrollBottom(smooth = false, reveal = false) {
  const cid = String(activeId.value);
  nextTick(() => {
    /* 轮 377：nextTick 前切走会话，旧会话的钉底/揭示不能作用到新会话。 */
    if (String(activeId.value) !== cid) return;
    const el = listEl.value;
    if (!el) { if (reveal) listRevealed.value = true; return; }   /* 娌℃湁瀹瑰櫒灏辨棤鎵€璋撲綅缃?*/
    /* 杞?173锛氳惤鍦板悗杩炵画鍑犲抚杩介拤搴曢儴鈥斺€斿瓧浣?鍐呭鏅氬埌浼氭妸宸叉帓濂界殑娑堟伅鎾戦珮锛?
     * 鍙粴涓€娆′細鍋滃湪銆屼腑闂淬€嶏紙鐢ㄦ埛瀹炴祴锛氳褰曞浜嗚繘浼氳瘽钀藉湪鍗婃埅锛夈€?
     * 鐢ㄦ埛涓€鏃︿笂婊戯紙瑙︽懜/婊氳疆锛夌珛鍗冲仠杩斤紝涓嶆墦鎵板洖鐪嬨€?*/
    userScrolling.value = false;
    const gen = ++scrollGen;   /* 杞?176b锛氭柊婊氬姩閾句綔搴熸棫閾锯€斺€斿钩婊戞粴鍔ㄦ椂涓嶈杩藉抚鐨勭灛鏃堕噸閽夐《鎺?*/
    let frames = 0;
    /* 杞?196锛氭寕杞藉垵鏈熷鍣?鍐呭楂樺害鏈畾鍨嬶紝浼氬嚭鐜般€屽唴瀹规伆濂借婊″鍣ㄣ€嶇殑鐭钩鍙?
     * 锛坓ap=0銆侀珮搴︾ǔ瀹氾級鈥斺€旀寜鏃ф潯浠朵細绔嬪嵆鎻ず锛岄殢鍚庡唴瀹规暟鍊嶅睍寮€ = 鍙椤堕儴闂抚
     * 锛堢嚎涓婇€愬抚瀹炴祴 t鈮?30ms 涓€甯э級銆傚墠 40 甯т笉鎶婂钩鍙板綋绋冲畾锛涚湡鐭細璇濋潬纭笂闄愬厹搴曘€?*/
    const plateau = () => el.scrollHeight <= el.clientHeight + 24 && frames < 40;
    const set = () => {
      el.scrollTop = el.scrollHeight;
      /* 杞?203锛歴et() 鍙拤搴曘€?*姘镐笉鎻ず**鈥斺€斿竷灞€闇囪崱鏈熺殑鐬€侀拤绋筹紙gap<4锛変細楠楄繃鍗虫椂鎻ず锛?
       * 闅忓悗鍐呭缁х画閲嶆帓 = 鍙璺冲彉锛堢湡鏈洪€愬抚瀹炴祴 sh 鍏闇囪崱 524鈫?682鈫?611鈫?659鈫?600鈫?786鈫?706锛夈€?
       * 鎻ず鍞竴閫氶亾 = chase 閲屻€岀ǔ瀹氭寔缁?300ms銆嶃€?*/
    };
    set();
    /* 杞?173b锛氳繘浼氳瘽鏈熼棿鎸佺画閽夊簳锛坧inning锛夆€斺€旀棫缂撳瓨鍏堣惤搴曘€佺綉缁滃洖鏉ユ柊娑堟伅鎶婂簳鎾戜笅鍘伙紝
       灏变細鍑虹幇銆屽仠鍦ㄤ腑闂翠竴涓嬪啀璺冲簳閮ㄣ€嶇殑涓ゆ寮忚惤鍦帮紱閽変綇鍚庢柊娑堟伅钀借繘鏉ヨ绾胯窡鐫€璧帮紝鏃犲仠椤?*/
    /* 杞?193d锛氱‘瀹氭€х姸鎬佹満鈥斺€旈殣钘忔湡姣忓抚閽夊簳锛涖€屽瓧浣撳畬鎴?+ 楂樺害杩炵画 3 甯т笉鍙樸€?
     * 鍙屾潯浠跺悓鏃舵弧瓒虫墠鎻ず銆備换浣曞崟甯ч敊浣嶏紙瀛椾綋鎹㈣/鏁版嵁鏇挎崲/閲嶆帓锛夐兘鍙戠敓鍦ㄩ殣钘忔湡锛?
     * 鐢ㄦ埛鍙鐨勭涓€甯у繀鐒跺凡鍦ㄦ渶鏂颁綅缃€?*/
    let stableFrames = 0;
    let lastH = -1;
    let stableSince = 0;
    const chase = () => {
      if (gen !== scrollGen) return;                   /* 宸叉湁鏂伴摼锛堝骞虫粦婊氬姩锛夋帴绠?*/
      if (userScrolling.value) return;                 /* 鐢ㄦ埛涓婃粦锛氱珛鍗冲仠锛屼笉鎵撴壈鍥炵湅 */
      if (frames > 600) { listRevealed.value = true; return; }   /* 纭笂闄?~10s锛岄槻寮傚父姘歌棌 */
      set();
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
      /* 杞?238锛氬瓧浣撻潤榛樹篃鍏ョǔ瀹氬垽鎹€斺€斿垎鍧楀姞杞界殑闂撮殭 sh 浼氱煭鏆備笉鍔紝鑾綋鐪?*/
      const settled = fontQuiet() && fontsOk() && entryReady.value && el.scrollHeight === lastH && !plateau() && gap < 4;
      lastH = el.scrollHeight;
      if (settled) stableFrames++; else stableFrames = 0;
      if (settled && !stableSince) stableSince = performance.now();
      if (!settled) stableSince = 0;
      /* 杞?205 鈫?杞?238锛氭彮绀虹瓑寰呰嚜閫傚簲鈥斺€斿瓧浣撻潤榛樹笖椤甸潰宸叉椿杩?2.5s 鈫?80ms 蹇溅閬?
       * 锛堝井淇″紡绉掑紑锛夛紱瀛椾綋浠嶅湪鍒嗗潡鍒拌揪 鈫?300ms 淇濆畧锛堝悗娈典綅绉诲悶杩涢殣钘忔湡锛夈€?*/
      const hold = (fontQuiet() && performance.now() > 2500) ? 80 : 300;
      if (stableSince && performance.now() - stableSince >= hold && !listRevealed.value) listRevealed.value = true;
      frames++;
      requestAnimationFrame(chase);
    };
    if (smooth && el.scrollTo) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    requestAnimationFrame(chase);
    /* 杞?228 路 绉掑紑鎻ず锛?*纭鐪熺殑璐村簳浜嗗啀浜?*銆?
       涓轰粈涔堜笉鑳界畝鍗曞湴鍦?set() 鍚庨潰鐩存帴缃?true锛歴et() 鎵ц鏃?DOM 鍒?patch銆佸唴瀹归珮搴﹁繕娌?
       灞曞紑瀹岋紝scrollTop 浼氳澶瑰洖 0锛堢湡鏈哄疄娴嬫彮绀洪甯?st=0 sh=5375 gap=4649 鈥斺€?绛変簬鍏堢粰
       鐢ㄦ埛鐪嬩竴鐪煎垪琛ㄩ《锛屼笅涓€甯ф墠璺冲埌搴曪紝姣旀參鏇寸碂锛夈€?
       杩欓噷鑷繁姣忓抚閽夊簳锛?*绛夊埌 gap<4 鐨勯偅涓€甯ф墠鎻ず** 鈥斺€?鎻ず涓庨拤搴曞悓甯э紝浜嚭鏉ュ氨鍦ㄦ渶鏂版秷鎭€?
       鏈惊鐜疆 249 璧锋寕 scrollGen锛氭棫鐗堝埢鎰忎笉鎸傦紝浣嗗揩閫熻繘鍑轰細璇濇椂涓婁竴杞殑鎻ず寰幆杩樻椿鐫€锛?
       浼氭妸鏂颁竴杞繕鍦ㄩ拤绋虫湡鐨勯〉闈㈡彁鍓嶆彮绀猴紙鐪熸満 ~7% 姒傜巼闂存瓏璺抽棯锛夛紱60 甯у厹搴曚繚鐣欍€?*/
    if (reveal) {
      let rf = 0, lastSh = -1, sameSh = 0;
      const myGen = scrollGen;   /* 杞?249锛氭柊涓€杞粴鍔ㄩ摼鍚姩鍗充綔搴熸棫鎻ず寰幆锛堝揩閫熻繘鍑虹殑闂存瓏璺抽棯婧愶級 */
      const revealWhenPinned = () => {
        if (myGen !== scrollGen) return;   /* 鏂伴摼宸叉帴绠?*/
        if (listRevealed.value) return;
        const e2 = listEl.value;
        if (!e2) { listRevealed.value = true; return; }
        e2.scrollTop = e2.scrollHeight;
        const sh = e2.scrollHeight;
        const g = sh - e2.scrollTop - e2.clientHeight;
        /* 銆岄珮搴﹁繛缁?2 甯т笉鍙樸€? 鍐呭宸插畾鍨嬶紝杩欎竴姝ヤ笉鑳界渷锛?
           鍒?patch 瀹岀殑鐬棿鍐呭杩樻病閾哄紑锛宻crollHeight 鍙槸銆屽垰濂借婊″鍣ㄣ€嶇殑鐭€硷紝
           姝ゆ椂 gap 澶╃劧涓?0 鈥斺€?鍋囪创搴曘€傜湡鏈哄疄娴嬪氨鏄瀹冮獥杩囷細鍒ゆ嵁璁や负宸插埌搴?鈫?鎻ず 鈫?
           涓嬩竴甯у唴瀹瑰睍寮€鎴?5375px锛岀敾闈㈠叾瀹炲仠鍦ㄩ《閮紙棣栧抚璺濆簳 4649px锛夈€?
           鍐呭瀹氬瀷鍚庡啀纭 gap<4锛屼寒鍑烘潵鎵嶆槸鐪熺殑鏈€鏂版秷鎭€?
           杞?238锛氳繕瑕佸瓧浣撻潤榛樷€斺€旈暱娑堟伅鐨勬枃妤峰垎鍧楀湪涓ゆ壒涔嬮棿 sh 浼氱煭鏆備笉鍔紝
           銆? 甯хǔ瀹氥€嶈鍋囪薄楠楄繃 鈫?鎻ず鍚庣户缁噸鎺?= 闂幇鍙堣烦娌★紙鐢ㄦ埛瀹炴祴锛夈€?
           鐭細璇濓紙鏈潵灏变笉澶熶竴灞忥級鍚屾牱浼氬緢蹇畾鍨?+ gap=0锛屼竴鏍风寮€锛?
           60 甯э紙~1s锛夊厹搴曚紭鍏堜簬瀛椾綋闈欓粯锛岀粷涓嶆妸娑堟伅鍖烘案涔呰棌浣忋€?*/
        if (sh === lastSh) sameSh++; else { sameSh = 0; lastSh = sh; }
        if (((sameSh >= 2 && g < 4) && fontQuiet()) || ++rf > 60) { listRevealed.value = true; return; }
        requestAnimationFrame(revealWhenPinned);
      };
      requestAnimationFrame(revealWhenPinned);
    }
  });
}

/* 杞?157锛氳Е椤惰嚜鍔ㄧ炕鍘嗗彶鈥斺€攔AF 鑺傛祦 + passive 鐩戝惉锛屾粴鍒伴《 140px 鍐呰嚜鍔ㄦ媺涓婁竴鎵癸紱
 * 銆屽姞杞芥洿鏃┿€嶆寜閽繚鐣欙紙鍙鐨?loading 鎬佸厹搴曪級銆?*/
let topRaf = 0;
function onScrollTop() {
  if (topRaf) return;
  topRaf = requestAnimationFrame(() => {
    topRaf = 0;
    /* 杞?196锛氬叆鍦哄竷灞€绔炴€佷細鏈変竴鐬?scrollTop=0鈥斺€旈偅涓嶆槸鐢ㄦ埛鍦ㄥ洖鐪嬶紝鏄拤搴曡繕娌¤惤銆?
     * 鍏ュ満鏈猴紙杩藉簳涓?鏈彮绀猴級鏈熼棿涓嶈嚜鍔ㄧ炕鍘嗗彶锛屽惁鍒欐瘡娆¤繘浼氳瘽閮借璺戜竴瓒熺炕鍘嗗彶锛?
     * 缃戠粶鍥炴潵鍐嶅叏鍒楄〃閲嶆覆鏌?= 绗簩娆″彲瑙佽烦鍙橈紙閫愬抚瀹炴祴 t鈮?1.4s 绗簩娉㈤棯锛夈€?*/
    if (pinning.value || !listRevealed.value) return;
    const el = listEl.value;
    if (!el || loadingMsgs.value || !hasMore.value || !oldestId.value || !activeId.value) return;
    if (el.scrollTop < 140) loadMessages(activeId.value, { before: oldestId.value });
  });
}

/* 轮 464：进会话时同步地址栏（手机 push 留历史 / 桌面 replace 不污染）。
 * 抽出来是因为要两处调用：正常路径、以及「认证还没就绪」的早退路径。 */
function syncConvRoute(id, same) {
  if (isMobileNav.value) {
    /* 轮491：进会话前把列表的页面位置记下来（返回时 restoreListScroll 补回去） */
    if (!same) fromList.value = true;
    if (!same) savePageScroll();
    router.push({ name: "messages", params: { id: String(id) } }).catch(() => {});
  } else {
    router.replace({ name: "messages", params: { id: String(id) } }).catch(() => {});
  }
}

async function openConv(id) {
  const owner = meId.value;
  seg.value = "dm";
  menuFor.value = "";
  headMenu.value = false;
  const same = String(activeId.value) === String(id);
  /* 轮 423：先把按压玻璃留在屏上至少 PRESS_MS 再切页。
   * 从按下（touchstart/mousedown）算起，长按已经够久就不补；点太快（<140ms）才补差值。
   * 这一步就是「第二次点也能看见玻璃」的全部原因 —— 第一次是挂载慢，天然给了 426ms。 */
  if (pressAt) {
    const held = performance.now() - pressAt;
    if (held < PRESS_MS) await new Promise((r) => setTimeout(r, PRESS_MS - held));
  }
  activeId.value = String(id);
  /* 按压态收工：此刻行已换成 .on（同一层玻璃），视觉不断，但不会跟着回到列表 */
  pressedId.value = "";
  /* 杞?376锛氳璇佽繕娌″氨缁椂鍙浣?activeId锛屽叿浣撳姞杞戒氦缁?boot 鐨?firstOpen锛?
   * 鍚﹀垯浼氭嬁绌鸿处鍙峰幓璇诲簱/鍙?markRead銆?*/
  /* 轮 464：地址栏同步提到 owner 判断之前 —— 认证未就绪只表示「数据晚点拉」，
   * 不代表「URL 不用变」。以前这里直接 return：activeId 有了、路由还停在 /messages，
   * 而 App.vue 的 inChat 只认路由 → .shell--chat 不挂 → 整屏高度那一整套规则全不命中
   * （真机 ?kbdiag=1：.dm-page 撑到 2401px，屏高只有 744，输入条被推到文档末尾）。 */
  syncConvRoute(id, same);
  if (!owner) return;
  /* 杞?318锛氭崲浼氳瘽 = 杈撳叆妗嗗洖鍒颁竴琛岋紝鍒妸涓婁竴涓細璇濈殑銆岄珮搴﹂拤瀛愩€嶅甫杩囨潵 */
  if (!same) releaseCompose();
  /* 杞?254 路 绾㈢偣璺熸墜锛氳繘浼氳瘽閭ｄ竴鍒诲氨鎶婃湰鍦拌鏈娓呴浂 + 瀵艰埅瑙掓爣鍚屾閫掑噺锛?ms 璺熸墜锛夛紝
   * 缃戠粶 markRead 鈫?refreshBadge 鍙仛鏈嶅姟绔牎姝ｏ紙澶辫触涔熶笉褰卞搷瑙傛劅锛屼笅杞疆璇㈣嚜鎰堬級銆?
   * 涓嶇瓑 loadMessages/缃戠粶寰€杩旓紝鐢ㄦ埛銆岀偣杩涘幓椹笂杩斿洖銆嶇孩鐐逛篃宸茬粡娑堜簡銆?
   * 杞?268锛氳鏈鐨勪箰瑙傛潵婧愭湁涓や釜锛堝垪琛ㄨ鍊?+ badge 琛岀骇鏄犲皠锛夛紝鍙?max 鎵嶆槸銆岀敤鎴?
   * 鐪肩潧鐪嬪埌鐨勬湭璇汇€嶁€斺€斿彧鎸夎鍊煎噺浼氭紡鎺夈€屽揩鐓ф棫銆佹槧灏勬柊銆嶇殑鍦烘櫙锛涙槧灏勪竴骞舵竻鎺夐槻澶嶆椿銆?*/
  {
    const row = convs.value.find((c) => String(c.conv_id) === String(id));
    /* 静音会话的未读没算进 badge.dm（服务端已排除），这里不能拿它去减导航角标，
     * 否则会把别的会话的未读数减掉。行内清零点照旧。口径收在 dmRules.unreadToClear。 */
    const lost = unreadToClear(row, badge.dmConvs);
    if (row && lost) row.unread = 0;
    if (lost) badgeLocal({ dm: Math.max(0, badge.dm - lost) });
    badgeDmConvPatch(id, 0);
  }
  /* 鍙屽舰鎬佸鑸紙寰俊寮忥級锛?
   *  - 鎵嬫満褰㈡€侊細鑱婂ぉ鏄嫭绔嬫暣灞忛〉 鈫?push锛屽巻鍙蹭繚鐣欏垪琛?鈫?鈫?閽?/ 绯荤粺杩斿洖閿兘鑳藉洖鍒楄〃锛?
   *  - 妗岄潰褰㈡€侊細鍒楄〃涓庤亰澶╁悓椤靛弻鍒?鈫?replace锛岀偣浼氳瘽涓嶆薄鏌撴祻瑙堝櫒鍘嗗彶锛堝師琛屼负涓嶅彉锛夈€?*/
  if (isMobileNav.value) {
    if (!same) fromList.value = true;
    router.push({ name: "messages", params: { id: String(id) } }).catch(() => {});
  } else {
    router.replace({ name: "messages", params: { id: String(id) } }).catch(() => {});
  }
  /* 杞?351锛氶潰鏉挎斁琛屽厹搴?鈥斺€?璺敱姝ｅ父涓€涓や釜 tick 鍐呮彁浜わ紙paneReady 鑷劧杞?true锛夛紝
     鍙湁瀵艰埅琚嫤锛堥噸澶?push 绛夛級鎵嶇敤寰椾笂杩?400ms锛涜 paneReady 娉ㄩ噴銆?*/
  routeSettledFallback.value = false;
  clearTimeout(routeSettledTimer);
  routeSettledTimer = setTimeout(() => { routeSettledFallback.value = true; }, 400);
  meta.value = null;
  /* 杞?238锛歮eta 鎷夊彇涓嶅啀闃诲鏈湴搴撴覆鏌撯€斺€旀爣棰樼瓑 meta 鍥炴潵鍚庡搷搴斿紡琛ヤ笂銆?
   * 鏃х増 await loadMeta 鎶娿€屾湰鍦扮寮€銆嶅牭鍦ㄤ竴涓綉缁滆姹傚悗闈紙婕傛祦鐡?娣遍摼杩涘叆灏ゅ叾鏄庢樉锛夈€?*/
  if (!convs.value.some((c) => String(c.conv_id) === String(activeId.value))) {
    loadMeta(activeId.value);
  }
  pinning.value = true;   /* 杞?173b锛氳繘浼氳瘽閽夊簳锛岀洿鍒伴灞忔暟鎹惤瀹?*/
  listRevealed.value = false;   /* 杞?176锛氭秷鎭尯鍏堥殣锛岄拤搴曠ǔ浜嗗啀鏄剧ず锛堥槻棣栧抚閿欎綅璺抽棯锛?*/
  entryReady.value = false;     /* 杞?180锛氭樉绀洪棬鎺ч噸缃€斺€旂瓑 fresh 鏁版嵁钀藉畾 */

  /* 杞?180 鈫?238锛氬厹搴曞彧鎻ず宸茶惤瀹氱殑锛涙彮绀哄墠鍏堝悓姝ラ拤涓€娆″簳锛堝惁鍒?2s 鍏滃簳浜嚭
   * 鏉ョ殑鍙兘杩樻槸椤堕儴/鍗婃埅浣嶇疆 鈥斺€?闀挎秷鎭?+ 瀛椾綋闇囪崱鏃跺挨鍏跺姝わ級锛屼寒鍑烘潵鐨勫氨鏄渶鏂版秷鎭€?
   * 杞?249锛堢敤鎴峰疄娴嬨€屽揩閫熺偣鍑诲伓鍙戜竴闂€岃繃銆嶏級锛氬繀椤绘竻鎺変笂涓€杞殑鍏滃簳 鈥斺€?蹇€熻繘鍑轰細璇濇椂
   * 鏃?setTimeout 鐓у父瑙﹀彂锛屾妸鏂颁竴杞繕鍦ㄩ拤绋虫湡鐨勯〉闈㈡彁鍓嶆彮绀?= 闂存瓏璺抽棯锛垀7% 姒傜巼锛夈€?*/
  clearTimeout(entryFallback);
  entryFallback = setTimeout(() => {
    if (!listRevealed.value) {
      const el2 = listEl.value;
      if (el2) el2.scrollTop = el2.scrollHeight;
      listRevealed.value = true;
    }
  }, 2000);   /* 杞?180锛氬厹搴曞彧鎻ず宸茶惤瀹氱殑 */
  const smoothed = await loadMessages(id);
  /* 杞?225锛氱瓑娑堟伅鏈熼棿鐢ㄦ埛鍙堢偣浜嗗埆鐨勪細璇?/ 杩斿洖浜嗗垪琛?鈫?鍒啀鍔ㄦ粴鍔ㄤ笌宸茶鏍囪
   * 锛堝惁鍒欎細鐢ㄦ棫浼氳瘽鐨勮惤鐐规妸鏂颁細璇濈殑灞忔粴涔憋紝杩欐槸銆屽垏瀹屼綅缃贡璺炽€嶇殑鍙︿竴鍗婏級銆?*/
  /* 轮380：等消息期间用户切到漂流瓶/通知段 → activeId 还在，但人已经不在聊天里，
     不能再滚隐藏的列表、更不能替这条会话抬已读（红点会被白白清掉）。 */
  if (String(activeId.value) !== String(id) || seg.value !== "dm"
    || (typeof document !== "undefined" && document.hidden)) return;
  /* 杞?376锛氱瓑娑堟伅鏈熼棿鐧诲嚭/鎹㈠彿 鈫?鏃ц处鍙风殑宸茶鏍囪涓嶈鎵撳埌鏂颁細璇濅笂銆?*/
  if (!signedIn.value || meId.value !== owner) return;
  if (!smoothed) scrollBottom();   /* 鏈夋柊娑堟伅鏃跺凡骞虫粦婊氳繃锛屼笉鍐嶇灛鏃惰烦 */
  /* 杞?254锛氬厛绛夈€屽凡璇汇€嶈惤搴撳啀鍒疯鏍囷紙鏃у啓娉曚袱涓苟鍙戝彂锛岃杩樻病鍐欒繘鍘诲氨鎷?鈫?鎷夊洖鏃у€硷紝
   * 绾㈢偣瑕佺瓑涓嬩竴杞?30s 杞鎵嶆秷 鈥斺€?鐢ㄦ埛瀹炴祴銆岀偣杩涘幓椹笂杩斿洖锛岀孩鐐逛笉璺熸墜銆嶏級銆?*/
  refreshBadge({ after: dmApi.markRead(id).catch(() => {}) });
}

/* 鈫?杩斿洖浼氳瘽鍒楄〃锛堟墜鏈哄舰鎬侊級锛氫粠鍒楄〃鐐硅繘鏉?鈫?閫€涓€姝ワ紙涓嶇暀澶氫綑鍘嗗彶锛夛紱
 * 鐩撮摼杩涙潵锛堥€氱煡涓績 / 鐡跺瓙璁板綍锛夆啋 鐩存帴璺冲垪琛ㄣ€?*/
function backToList() {
  /* 轮 464：路由没跟上时（openConv 早退 / 导航被拦 / 直链后回过列表）绝不能走
   * router.back() —— 地址栏本来就在 /messages，一退就直接离开消息页。就地清态即可。 */
  const onConvRoute = route.name === "messages" && !!route.params.id;
  if (!onConvRoute) {
    fromList.value = false;
    resetConv();
    return;
  }
  if (fromList.value) {
    fromList.value = false;
    router.back();
    return;
  }
  router.push({ name: "messagesList" }).catch(() => {});
}

/* 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ 鍙戦€?/ 鎾ゅ洖 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ */

async function send() {
  /* 杞?316锛氬垹鎺夈€屽彂閫佷腑銆嶉樆濉?鈥斺€?鐢ㄦ埛鍘熻瘽銆屾梺杈瑰彂閫佷腑鎸夐挳杞崐澶╋紝鎯冲彂閫佷笅涓€鏉￠兘鍙戦€佷笉浜嗐€嶃€?
     寰俊寮忥細鐐瑰彂閫佺珛鍒讳笂灞忋€佺珛鍒昏兘鍐欎笅涓€鍙ワ紱澶辫触鐨勯偅涓€鏉¤嚜宸卞湪琛屽唴甯︽爣璁般€?
     鏃х増閭ｉ亾銆屼笂涓€鍙ユ病鍥炴潵灏变笉缁欏彂涓嬩竴鍙ャ€嶇殑鍙戦€佷腑闂紝鍦ㄥ急缃戜笅绛変簬鎶婅緭鍏ユ閿佹鍑犲崄绉掋€?*/
  const err = validateSend(body.value, null);
  if (err) { sendErr.value = t(err); return; }
  const text = body.value.trim();
  const convId = activeId.value;
  /* 杞?376锛氬彂閫?纭璺ㄨ处鍙锋椂锛屾棫璐﹀彿鐨勭‘璁よ缁濅笉鑳藉啓杩涙柊璐﹀彿鐨勬湰鍦板簱锛?
   * 涔熶笉鑳藉湪鐧诲嚭鍚庣殑绌鸿亰澶╂閲岄噸鏂伴暱鍑烘潵銆傛崟鑾峰彂閫佹椂鐨?owner锛宎wait 鍥炴潵鍐嶆牎楠屻€?*/
  const owner = meId.value;
  if (!owner || !convId) return;
  if (firstContactBlocked(owner, convId)) {
    sendErr.value = t("dm.errFirstLimit");
    /* 组件先 emit 再 resetMessage：等这一拍过去再把正文放回输入框。 */
    nextTick(() => {
      const vc = vacChat.value;
      if (vc && typeof vc.restoreDraft === "function") vc.restoreDraft(text, convId);
    });
    return;
  }
  /* 杞?318锛氬彂閫佸墠鍏堟妸銆屼笉鎶樺彔 + 涓嶅け鐒︺€嶅仛鎺夛紙鐢ㄦ埛鍘熻瘽銆屽彂閫佷箣鍚庤緭鍏ユ鑷姩鎶樺彔浜嗭紝涓嶈鎶樺彔銆嶏級锛?
   *  鈶?閲忎笅姝ゅ埢杈撳叆妗嗛珮搴?鈫?娓呯┖鍚庡綋 min-height锛宎utosize 鎸変笉鍥炰竴琛岋紙鐪熸満瀹炴祴 92px 浼氳鎸夊埌 44px锛夛紱
   *  鈶?鐒︾偣鎷夊洖杈撳叆妗?鈥斺€?鐐瑰彂閫佹寜閽細鎶婄劍鐐规姠鍒版寜閽笂锛屾墜鏈轰簬鏄敹閿洏锛屽緱鍐嶇偣涓€娆℃墠鑳芥帴鐫€鎵擄紱
   *  鈶?鏍囪杩欐娓呯┖鏉ヨ嚜鍙戦€侊紝璁╀笂闈㈢殑 watch 涓嶈鏀惧紑楂樺害銆?*/
  {
    const ta = taOf();
    if (ta) { holdCompose(ta.getBoundingClientRect().height); ta.focus(); }
    sentClear = true;
  }
  body.value = "";
  sendErr.value = "";
  /* 轮 377：记下发送前已有的 id；RPC 超时/没回 msg_id 时，用它判断尾部新行是不是这次的回显。 */
  const beforeIds = new Set(msgs.value.map((m) => String(m.id)));
  /* 轮382：发送前窗口里最大的正式 id。重开 App 后本地快照里 pending + 确认行
   * 同时存在时，用它判断哪条才是这次发送的新回显，不依赖设备时钟。 */
  const beforeMax = maxPositiveId(msgs.value);
  /* 涔愯涓婂睥锛氫复鏃?id 涓鸿礋锛屾湇鍔＄纭鍚庡氨鍦拌惤浣?*/
  const temp = {
    id: nextTempId(), sender: owner, body: text, image_path: null,
    created_at: new Date().toISOString(), pending: true,
    /* 杞?352锛氱ǔ瀹氳 key锛堢‘璁ゅ洖鍐欐部鐢級鈥斺€?瑙?nextMsgKey 娉ㄩ噴 */
    key: nextMsgKey(msgs.value),
    before_max: beforeMax,
  };
  msgs.value = msgs.value.concat([temp]);
  livePending.add(String(temp.id));
  let confirmedAt = "";   /* 鏈嶅姟绔‘璁ょ殑鍙戦€佹椂闂达細鍒楄〃棰勮鎸夊畠姣旀柊鏃?*/
  let sent = false;       /* 鍙湁鐪熸鎷垮埌 msg_id 鎵嶆洿鏂板垪琛ㄩ瑙?*/
  /* 杞?376锛氫箰瑙傝绔嬪埢钀芥湰鍦板簱銆傜敤鎴峰彂瀹岄┈涓婅繑鍥?閲嶈繘鏃讹紝RPC 鍙兘杩樻病鍥炴潵锛?
   * 鏃х増鍙妸瀹冩斁鍦ㄥ唴瀛橈紝resetConv 涓€娓呭氨娌′簡锛岄噸杩涘彧鑳藉共绛夌綉缁溿€?*/
  dmStoreUpsert(owner, convId, temp);
  /* 轮382：列表预览先按本地时间乐观更新。旧代码只在 dm_send 回包、甚至 IDB 写完
   * 之后才 bump —— 用户发完立刻返回列表时，会话行还是旧预览，弱网要等十几秒。
   * 确认回包若更晚，会再用服务端 created_at 校正；失败时保留草稿预览，点进去能看到红「!」。 */
  bumpConvPreview(convId, text, temp.created_at, owner);
  /* 杞?316锛氱敤鎴蜂富鍔ㄥ彂娑堟伅 = 绔嬪埢浜嚭娑堟伅鍖哄苟閽夊簳銆?
     鏃х増瑕佺瓑 entryReady锛堥杩涙棤鏈湴搴撴椂 = 绛夐偅娆¤法澧?RPC 钀藉畾锛夋墠鎻ず锛?
     鐢ㄦ埛鐪嬪埌鐨勫氨鏄€屾垜鍙戝嚭鍘荤殑娑堟伅涓嶅湪鑱婂ぉ妗嗛噷锛岀瓑寰堜箙鎵嶅嚭鐜般€嶃€?*/
  pinning.value = false;
  listRevealed.value = true;
  scrollBottom(true);
  try {
    const r = await dmApi.send(convId, text, null);
    /* 杞?157锛歞m_send 鐩存帴鍥炰紶 {msg_id, created_at} 鈫?灏卞湴鎶婁箰瑙傝鎹㈡垚姝ｅ紡琛岋紝
     * 涓嶅啀鏁存閲嶈浇 30 鏉★紙鍙戦€佸埌銆屽凡鍙戙€嶅皯涓€娆＄綉缁滃線杩旓紝寮辩綉灏ゅ叾鏄庢樉锛?*/
    const mid = r && r.msg_id;
    /* 杞?225锛氬彂閫佹湡闂寸敤鎴峰彲鑳藉凡缁忓垏璧?鈥斺€?閭ｆ椂 msgs 瑁呯殑鏄埆浜虹殑娑堟伅锛?
     * 缁濅笉鑳芥嬁瀹冨幓鏀瑰垪琛?/ 钀藉簱锛堜細鎶?B 鐨勬秷鎭啓杩?A 鐨勬湰鍦板簱锛夈€?*/
    const onSameConv = String(activeId.value) === String(convId);
    /* 轮380：activeId 回到 A 不代表 msgs 已经装回 A —— 快速 A→B→A 时 B 的加载
       可能先落屏，此时确认/失败行只能写 A 的本地库，绝不能 concat 进 B 的列表。 */
    /* 轮381：只认 msgsConv —— 不能因为「临时行还在列表里」就认定窗口是 A。
     * loadMessages 清屏后 msgsConv 已同步清空；此时 temp 可能被拼在空列表/别的
     * 会话列表里，拿它整窗写 A 的库会把历史覆盖成一条。 */
    const sameWindow = onSameConv && String(msgsConv) === String(convId);
    const sameAccount = signedIn.value && meId.value === owner;
    if (mid != null) {
      const rowSrv = { id: mid, sender: owner, body: text, image_path: null,
        created_at: r.created_at || temp.created_at, deleted_at: null,
        key: temp.key };   /* 杞?352锛氭部鐢ㄤ箰瑙傝 key锛屼笉閲嶆寕 */
      confirmedAt = rowSrv.created_at;
      sent = true;
      if (!sameAccount) {
        /* 鍙戦€佹湡闂村凡鐧诲嚭/鎹㈠彿锛氭湇鍔″櫒宸茬粡鏀跺埌锛屼絾鏈湴涓嶅啀鍐欙紱鏃ц处鍙烽噸鐧诲悗鐢辩綉缁滆ˉ銆?
         * 鍚屾椂鎶婅繕鍦ㄦ湰鏈洪噷鐨勮礋鏁颁箰瑙傝鎽樻帀锛屽厤寰楅噸鐧诲悗鍜岀‘璁よ鍚屾椂鍑虹幇銆?*/
        dmStoreRemove(owner, convId, temp.id);
        idbRemoveRows(convId, [temp.id]);
        msgs.value = msgs.value.filter((m) => String(m.id) !== String(temp.id));
      } else if (sameWindow) {
        /* 杞?316锛氭壘涓嶅埌涔愯琛屽氨琛ュ洖锛堟暣绐楁浛鎹細鎶婂湪椋炵殑涔愯琛屾姽鎺夛級锛屽凡鏈夊悓 id 鍙幓閲?*/
        const rest = msgs.value.filter((m) => String(m.id) !== String(temp.id));
        /* 轮381：实时 INSERT 可能比 send RPC 先到，屏上已有这条但没有 key。
         * 把本次发送的稳定 key 补到已存在的行上，后面另一条同文发送超时认领时
         * 才能凭 key 认出「这条不是我的」，不会两条只留一条。 */
        const at = rest.findIndex((m) => String(m.id) === String(mid));
        msgs.value = at < 0
          ? rest.concat([rowSrv])
          : rest.map((m, i) => (i === at && (m.key == null || m.key === "")
            ? { ...m, key: temp.key } : m));
        dmStoreSave(meId.value, convId, msgs.value, hasMore.value);
        const snapshot = msgs.value;
        await idbMerge(convId, snapshot);   /* 杞?204锛氬彂閫侀暅鍍忓叏閲忓簱 */
        await idbRemoveRows(convId, [temp.id]);   /* 杞?376锛氬埆鎶婅礋鏁颁箰瑙傝鐣欏湪鍏ㄩ噺搴?*/
        /* 杞?376锛氱瓑鍏ㄩ噺搴撳啓瀹屾湡闂寸敤鎴峰彲鑳藉凡缁忓垏璧帮紱涓嶈兘鎷挎柊浼氳瘽鐨?msgs 鏀规棫浼氳瘽鐨勯敋鐐广€?*/
        if (signedIn.value && meId.value === owner && String(activeId.value) === String(convId)
          && msgsConv === convId) oldestId.value = oldestServerId(msgs.value);
      } else {
        /* 杞?375锛氱敤鎴峰彂瀹屽凡缁忓垏璧?杩斿洖鍒楄〃锛岀‘璁よ涔熷繀椤昏惤鍒?*璇ヤ細璇?*鐨勬湰鍦板簱銆?
           鏃т唬鐮佸彧鍦?onSameConv 鏃朵繚瀛橈紝纭鍥炴潵鏃?msgs 鏄埆鐨勪細璇濓紝浜庢槸杩欐潯娑堟伅
           鍦ㄦ湰鍦板簱閲屼笉瀛樺湪锛涘啀鐐硅繘鏉ュ厛鐪嬪埌鏃х獥鍙ｏ紝绛変竴娆＄綉缁滄墠銆屽緢涔呬箣鍚庡嚭鐜般€嶃€?*/
        /* 杞?376锛氬彂閫佹椂宸茬粡鍏堟妸璐熸暟涔愯琛屽啓杩涙湰鍦板簱锛涚‘璁ゅ悗瑕佹妸璐熸暟琛屾崲鎴?
         * 姝ｅ紡琛岋紝鍚﹀垯閲嶈繘浼氳瘽浼氬悓鏃剁湅鍒般€屽彂閫佷腑銆嶅拰銆屽凡鍙戦€併€嶄袱鏉°€?*/
        dmStoreReplace(meId.value, convId, temp.id, rowSrv);
        await idbMerge(convId, [rowSrv]);
        await idbRemoveRows(convId, [temp.id]);
        /* 轮381：人已经回到 A，但当前 msgs 还不能证明属于 A（msgsConv 已清空）。
         * 确认行已经安全写进 A 的本地库/IDB；从当前列表摘掉这条乐观行，
         * 等 A 的 loadMessages 把完整历史和确认行一起装回来。 */
        if (onSameConv) {
          msgs.value = msgs.value.filter((m) => String(m.id) !== String(temp.id));
        }
      }
    } else if (!sameAccount) {
      /* 缃戝叧娌″洖 msg_id 涓斿凡鎹㈠彿锛氭湰鍦拌礋鏁拌鍚屾牱瑕佹憳鎺夛紝鍒暀鍦ㄦ棫璐﹀彿搴撻噷杞湀銆?*/
      dmStoreRemove(owner, convId, temp.id);
      idbRemoveRows(convId, [temp.id]);
      msgs.value = msgs.value.filter((m) => String(m.id) !== String(temp.id));
    } else if (onSameConv) {
      await loadMessages(convId);
      const stillSame = signedIn.value && meId.value === owner
        && String(activeId.value) === String(convId) && msgsConv === convId;
      if (!stillSame) {
        const failedRow = { ...temp, pending: false, failed: true };
        dmStoreUpsert(owner, convId, failedRow);
        idbMerge(convId, [failedRow]);
      } else {   /* 鍏滃簳锛氭嬁涓嶅埌 msg_id锛堝紓甯哥綉鍏筹級鎵嶈蛋鏁存閲嶈浇 */
      /* 杞?376锛氱綉鍏虫病鍥?msg_id銆佸揩鐓ч噷涔熸病鎶婅繖鏉＄‘璁ゆ帀鏃讹紝涓嶈兘姘歌繙鍋滃湪銆屽彂閫佷腑銆嶃€?
       * 淇濈暀姝ｆ枃骞堕檷绾ф垚鍙噸鍙戠殑澶辫触琛岋紱閲嶆柊杩涘叆涔熶細璧?reviveLocal 鍚屼竴鍙ｅ緞銆?*/
      const echo = findSentEcho(msgs.value, temp, beforeIds);
      if (echo) {
        /* 服务端其实已经插入了，只是 RPC 没回 msg_id；认领正式行，别再标一条失败。 */
        dmStoreRemove(owner, convId, temp.id);
        msgs.value = msgs.value.filter((m) => String(m.id) !== String(temp.id));
        dmStoreSave(meId.value, convId, msgs.value, hasMore.value);
        idbMerge(convId, [echo]);
        idbRemoveRows(convId, [temp.id]);
        bumpConvPreview(convId, echo.body || text, echo.created_at);
      } else if (signedIn.value && meId.value === owner && String(activeId.value) === String(convId)
        && msgsConv === convId) {
        const failedRow = { ...temp, pending: false, failed: true };
        /* 轮381：loadMessages 清屏时会摘掉乐观行；不能因为“列表里已经没有 temp”
         * 就放过，否则网关不回 msg_id、快照也没确认时这条会整条消失。 */
        msgs.value = msgs.value.some((m) => String(m.id) === String(temp.id))
          ? msgs.value.map((m) => (String(m.id) === String(temp.id) ? failedRow : m))
          : msgs.value.concat([failedRow]);
        dmStoreSave(meId.value, convId, msgs.value, hasMore.value);
        idbMerge(convId, msgs.value);
      }
      }
    } else {
      /* 娌″洖 msg_id 涓斿凡缁忓垏璧帮細鎶婂け璐ヨ崏绋垮啓鍥炲彂閫佹椂閭ｄ釜浼氳瘽锛屽埆璁╁畠鍦ㄦ湰鍦板簱姘歌繙杞湀銆?*/
      const failedRow = { ...temp, pending: false, failed: true };
      dmStoreUpsert(meId.value, convId, failedRow);
      idbMerge(convId, [failedRow]);
    }
    /* 鍙戦€佹湡闂村凡鐧诲嚭/鎹㈠彿锛氭湇鍔″櫒鏀跺埌灏辫锛屼笉鍐嶅姩鏂拌处鍙风殑鍒楄〃/棰勮/瑙掓爣銆?*/
    /* 轮377：等 IDB / 无 msg_id 重载期间可能换号；不能用 await 前的 sameAccount
     * 做最终写入，否则旧账号的消息会去更新新账号的会话列表预览。 */
    if (!signedIn.value || meId.value !== owner) return;
    const stillSameConv = String(activeId.value) === String(convId) && msgsConv === convId;
    /* 寮傚父缃戝叧娌℃湁 msg_id锛氳繖鏉″凡鎸夊け璐ヨ澶勭悊锛屽埆鎶婂け璐ユ鏂囧啓鎴愬垪琛ㄦ渶鏂伴瑙堛€?*/
    if (!sent) { refreshBadge(); return; }
    /* 杞?376锛氬彂閫佺瓑寰呮湡闂寸敤鎴峰彲鑳戒笂婊戝洖鐪嬪巻鍙诧紱纭鍥炴潵鏃朵笉鑳藉啀鎶婁汉鎷藉洖搴曢儴銆?
     * userScrolling 鐢卞垪琛?touch/wheel 缃?true锛屽彧鏈夌敤鎴蜂粛鍦ㄥ簳閮ㄦ椂鎵嶈拷涓€娆°€?*/
    if (stillSameConv && !userScrolling.value) scrollBottom(true);
    /* 杞?320锛氶瑙堟洿鏂拌蛋 bumpConvPreview 鈥斺€?鍐呭瓨 + SWR 缂撳瓨鍙屽啓銆?
       鏃т唬鐮佸彧鏀瑰唴瀛橀噷**宸插瓨鍦?*鐨勮锛坮ow 瀛樺湪鎵嶆敼锛夛紝鏂板缓鐨勪細璇濓紙鍐呭瓨閲屾病琛岋級
       鏃㈡病杩涘唴瀛樹篃娌¤繘缂撳瓨 鈫?杩斿洖鍒楄〃鏃剁湅涓嶅埌杩欐潯璁板綍锛堢敤鎴锋姤闅滐細鍗佸嚑绉掓墠鍑虹幇锛夈€?
       杩欓噷鍗充娇鍐呭瓨閲屾病琛屼篃鐓ф牱鏇存柊缂撳瓨閲屽凡瀛樺湪鐨勯偅琛岋紱鑻ョ紦瀛橀噷涔熸病鏈夛紙鏈湴浠庢病鏈夎繃
       杩欎釜浼氳瘽锛夛紝鐢?openConv 閭ｆ潯閾捐矾琛ヨ銆?*/
    bumpConvPreview(convId, text, confirmedAt);
    refreshBadge();
  } catch (e) {
    /* 杞?316锛氳繖閲屽師鏉ュ紩鐢ㄧ殑鏄?try 鍐呯殑 const onSameConv 鈥斺€?姣忔鍙戦€佸け璐ラ兘鎶?ReferenceError锛?
     * 澶辫触琛屾案杩滃仠鍦ㄣ€屽彂閫佷腑銆嶏紝澶嶄綅鍙戦€佹€佺殑璇彞涔熷氨鎵ц涓嶅埌锛氭寜閽案涔呰浆鍦?+
     * 涓嬩竴鏉′篃琚偅閬撳彂閫佷腑闂ㄦ尅鍦ㄥ闈紙鐢ㄦ埛鍘熻瘽銆岃浆鍗婂ぉ锛屾兂鍙戦€佷笅涓€鏉￠兘鍙戦€佷笉浜嗐€嶏級銆?
     * 鐜板湪鏈潡鑷甫鍒ゅ畾锛屼笉鍐嶄緷璧?try 鐨勪綔鐢ㄥ煙銆?*/
    const onSameConv = String(activeId.value) === String(convId);
    /* 轮380：和成功分支同一道窗口校验 —— B 的列表不能拿来认领 A 的回显，
       更不能把 B 的消息整份写进 A 的本地库。 */
    /* 轮381：只认 msgsConv —— 不能因为「临时行还在列表里」就认定窗口是 A。
     * loadMessages 清屏后 msgsConv 已同步清空；此时 temp 可能被拼在空列表/别的
     * 会话列表里，拿它整窗写 A 的库会把历史覆盖成一条。 */
    const sameWindow = onSameConv && String(msgsConv) === String(convId);
    const sameAccount = signedIn.value && meId.value === owner;
    const failedRow = { ...temp, pending: false, failed: true };
    /* 轮 377：超时/断网时服务端可能已经插入，实时行也已经到了；先认领回显，
     * 认领到就不要再标一条红色失败（否则同一条消息会变成「已发 + 失败」两条）。 */
    const echo = sameAccount && sameWindow ? findSentEcho(msgs.value, temp, beforeIds) : null;
    if (echo) {
      dmStoreRemove(owner, convId, temp.id);
      msgs.value = msgs.value.filter((m) => String(m.id) !== String(temp.id));
      dmStoreSave(meId.value, convId, msgs.value, hasMore.value);
      idbMerge(convId, [echo]);
      idbRemoveRows(convId, [temp.id]);
      bumpConvPreview(convId, echo.body || text, echo.created_at);
    } else if (!sameAccount) {
      /* 鐧诲嚭/鎹㈠彿鏈熼棿澶辫触锛氫笉瑕佹妸鏃ц处鍙风殑澶辫触琛屽啓杩涙柊璐﹀彿鐨勫簱銆?*/
      dmStoreRemove(owner, convId, temp.id);
      idbRemoveRows(convId, [temp.id]);
      msgs.value = msgs.value.filter((m) => String(m.id) !== String(temp.id));
    } else if (sameWindow) {
      msgs.value = msgs.value.some((m) => String(m.id) === String(temp.id))
        ? msgs.value.map((m) => (String(m.id) === String(temp.id) ? failedRow : m))
        : msgs.value.concat([failedRow]);
      sendErr.value = t(sendErrKey(e));
      /* 杞?376锛氬け璐ヨ涔熻钀界洏銆傛棫浠ｇ爜鍙敼鍐呭瓨锛岀敤鎴风湅鍒扮孩銆?銆嶅悗杩斿洖鍒楄〃锛?
       * 鍐嶇偣杩涙潵鏈湴搴撴病鏈夎繖鏉★紝澶辫触娑堟伅灏卞嚟绌烘秷澶变簡銆?*/
      dmStoreSave(meId.value, convId, msgs.value, hasMore.value);
      idbMerge(convId, msgs.value);
    } else {
      /* 杞?376锛氬彂瀹岀珛鍒诲垏璧?杩斿洖鍒楄〃锛屽彂閫佸嵈澶辫触 鈥斺€?鏃т唬鐮佹妸澶辫触琛岀暀鍦ㄦ棫 msgs 閲岋紝
       * 鍒囪蛋鍚庤繖浠?msgs 宸茶鏇挎崲锛屽け璐ヨ闅?GC 娑堝け锛涘啀鐐硅繘鏉ョ敤鎴峰彧鐪嬪埌銆屾秷鎭病浜嗐€嶃€?
       * 澶辫触琛屾槸鐪熷疄鐨勬湰鏈鸿崏绋匡紝鍝€曚細璇濊繕娌℃湁浠讳綍鍘嗗彶涔熻钀藉簱锛屽惁鍒欑敤鎴风殑绗竴鍙?
       * 澶辫触娑堟伅浼氱洿鎺ヤ涪澶憋紙閲嶈繘鍙墿绌虹櫧锛夈€?*/
      /* 轮381：人回到 A 但窗口尚未装回 A 时，失败行只落 A 的库；
       * 当前 msgs 里那条乐观行要摘掉，不能让它挂在不属于 A 的列表上。 */
      if (onSameConv) {
        sendErr.value = t(sendErrKey(e));
        msgs.value = msgs.value.filter((m) => String(m.id) !== String(temp.id));
      }
      dmStoreUpsert(meId.value, convId, failedRow);
      await idbLoad(convId);   /* 绛夋湰鍦板簱灏辩华锛屽啀鎺掗槦闀滃儚 */
      if (!signedIn.value || meId.value !== owner) return;   /* 杞?376锛氱瓑 IDB 鏈熼棿鎹㈠彿 */
      await idbMerge(convId, [failedRow]);   /* 璐熸暟澶辫触琛屼篃闀滃儚锛涚‘璁?閲嶅彂鏃朵細鎽樻帀 */
    }
  } finally {
    livePending.delete(String(temp.id));
  }
}

async function persistRecallPatch(convId, patch, owner = meId.value) {
  /* 杞?376锛氭挙鍥炴垚鍔熶絾褰撳墠鍒楄〃娌¤杩欐潯锛堢敤鎴峰垏璧板張鍒囧洖銆佸垪琛ㄨ繕鍦ㄥ姞杞斤級鈥斺€?
   * 鍙洿鏂板凡鏈夊巻鍙茬殑搴擄紝涓嶅嚟绌哄垱寤恒€屽彧鏈変竴鏉℃挙鍥炪€嶇殑娈嬬己棣栧抚銆?*/
  if (!owner || !convId) return;
  const cur = dmStoreLoad(owner, convId);
  if (cur.msgs.length) {
    dmStoreUpsert(owner, convId, patch);
    /* 轮 377：本地库可能没有这条（被 400 条裁掉/清过缓存），但 IDB 里它是最后一条；
     * 把 patch 一起参与「谁是最新」的判断，否则列表预览不会变「已撤回」。 */
    bumpConvRecall(convId, patch, cur.msgs.concat([patch]));
  }
  const rec = await idbLoad(convId);
  if (!signedIn.value || meId.value !== owner) return;   /* 杞?376锛氱瓑 IDB 鏈熼棿鎹㈠彿 */
  if (rec && Array.isArray(rec.msgs) && rec.msgs.length) {
    await idbMerge(convId, [patch]);
    if (!signedIn.value || meId.value !== owner) return;
    /* 轮 377：localStorage 被清过时，IDB 才是唯一历史；同样把 patch 参与最后一条判断。 */
    bumpConvRecall(convId, patch, rec.msgs.concat([patch]));
  }
}

async function recall(m) {
  const convId = String(activeId.value);   /* 杞?225锛氬厛鎹曡幏褰掑睘浼氳瘽鈥斺€斿垏璧板悗灏卞埆鍐嶅姩褰撳墠鍒楄〃/钀藉簱 */
  const owner = meId.value;
  if (!owner) return;
  try {
    await dmApi.recall(m, owner);
    const patch = { ...m, deleted_at: new Date().toISOString(), body: "", image_path: null };
    /* 杞?376锛氭挙鍥炴湡闂寸櫥鍑?鎹㈠彿 鈫?鏈嶅姟鍣ㄥ凡鎾ゅ洖锛屼絾鏈湴涓嶅啀鍐欐柊璐﹀彿鐨勫簱銆?*/
    const sameAccount = signedIn.value && meId.value === owner;
    if (!sameAccount) {
      /* 鏃ц处鍙锋湰鍦板簱淇濇寔鍘熸牱锛岄噸鐧诲悗鐢辩綉缁滄牎姝ｃ€?*/
    } else if (String(activeId.value) === convId) {
      const hit = msgs.value.some((x) => String(x.id) === String(m.id));
      if (!hit) {
        await persistRecallPatch(convId, patch, owner);
      } else {
        msgs.value = msgs.value.map((x) =>
          (String(x.id) === String(m.id) ? { ...x, deleted_at: patch.deleted_at, body: "", image_path: null } : x));
        dmStoreSave(meId.value, convId, msgs.value, hasMore.value);   /* 杞?194锛氭挙鍥炶惤鐩?*/
        idbMerge(convId, msgs.value);   /* 杞?204锛氭挙鍥為暅鍍忓叏閲忓簱 */
        bumpConvRecall(convId, patch, msgs.value);   /* 杞?376锛氬垪琛ㄩ瑙堝埆鐣欐棫姝ｆ枃 */
      }
    } else {
      /* 杞?376锛氭挙鍥炴垚鍔熸椂鐢ㄦ埛鍙兘宸茬粡鍒囪蛋銆傛棫浠ｇ爜鍙湪褰撳墠浼氳瘽鍐欑洏 鈥斺€?鍒囪蛋鍚?
       * 璇ヤ細璇濇湰鍦板簱浠嶆槸鏃ф鏂囷紝鍐嶇偣杩涘幓浼氬厛鎶婃挙鍥炲唴瀹规樉绀哄嚭鏉ワ紝绛夌綉缁滄墠鍙樼伆銆?*/
      await persistRecallPatch(convId, patch, owner);
    }
  } catch (e) {
    /* 杞?376锛氬け璐ユ彁绀哄彧灞炰簬鍙戣捣鎾ゅ洖鐨勯偅涓細璇濓紱鍒囪蛋鍚庡埆鍐嶅脊鍒版柊浼氳瘽澶翠笂銆?*/
    if (signedIn.value && meId.value === owner && String(activeId.value) === convId) {
      const late = e && String(e.message || e).includes("too-late");
      sendErr.value = t(late ? "dm.errTooLate" : "dm.errNetwork");
    }
  }
  menuFor.value = "";
}

/* 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ 浼氳瘽鎿嶄綔锛氳姹?/ 鍏嶆墦鎵?/ 闅愯棌 / 鎷夐粦 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ */

async function acceptReq(c) {
  const owner = meId.value;
  /* 杞?238 路 涔愯鏇存柊锛氭湰鍦扮姸鎬佸厛钀斤紙鎸夐挳鍏堟秷澶便€佽鍏堣繘銆屼細璇濄€嶇粍锛夛紝缃戠粶鍙仛纭锛?
   * 澶辫触鍥炴粴 鈥斺€?鏃у啓娉?await 瀹屾墠鏀圭晫闈紝寮辩綉鐐逛竴涓嬪崐澶╂病鍔ㄩ潤锛堢敤鎴峰疄娴嬨€屼笉璺熸墜銆嶏級銆?
   * 鏀圭殑蹇呴』鏄?convs.value 閲岀殑鍘熷琛岋紙rowView 灞曠ず鎷疯礉涓嶅洖娴佷笉鍝嶅簲锛岃疆 197 缁撹锛夈€?*/
  const row = convs.value.find((x) => String(x.conv_id) === String(c.conv_id));
  if (row) row.accepted = true;
  if (meta.value && String(meta.value.conv_id) === String(c.conv_id)) meta.value.accepted = true;
  /* 杞?254锛氳姹傛暟瑙掓爣鏈湴鍏堝噺锛堜箰瑙傝窡鎵嬶級锛岀綉缁滆惤搴撳悗鍐嶆媺鏈嶅姟绔潈濞佸€兼牎姝ｃ€?
     鏃у啓娉?refreshBadge 鍦?accept 涔嬪墠骞跺彂鍙?鈥斺€?璇昏繕娌″啓杩涘幓锛岃鏍囦笉鍔ㄣ€?*/
  badgeLocal({ requests: Math.max(0, badge.requests - 1) });
  try { await dmApi.accept(c.conv_id); }
  catch (e) {   /* 闈欓粯鍥炴粴鎴愯姹傛€?*/
    if (row) row.accepted = false;
    if (meta.value && String(meta.value.conv_id) === String(c.conv_id)) meta.value.accepted = false;
    /* 轮 377：请求期间换号，失败回滚不能加到新账号的角标上。 */
    if (meId.value === owner) badgeLocal({ requests: badge.requests + 1 });
  }
  if (meId.value === owner) {
    /* 轮 377：await 期间列表刷新可能用旧 accepted=false 覆盖乐观行，成功后补一次。 */
    const r = convs.value.find((x) => String(x.conv_id) === String(c.conv_id));
    if (r) r.accepted = true;
    if (meta.value && String(meta.value.conv_id) === String(c.conv_id)) meta.value.accepted = true;
    refreshBadge();
  }
}

async function rejectReq(c) {
  const owner = meId.value;
  /* 杞?238 路 涔愯鏇存柊锛氳鍏堟秷澶憋紱澶辫触鎻掑洖鍘熶綅锛堟湰鍦板簱绛夋竻绌虹暀鍒扮‘璁ゆ垚鍔熷悗锛?*/
  const idx = convs.value.findIndex((x) => String(x.conv_id) === String(c.conv_id));
  const removed = idx >= 0 ? convs.value.splice(idx, 1)[0] : null;
  /* 杞?254锛氭嫆缁?= 璇锋眰鎬佹秷涓€涓?鈫?瑙掓爣鏈湴鍏堝噺锛涜惤搴撳悗鏍℃锛堟棫鍐欐硶 refresh 鍦?hide 涔嬪墠鍙戯級 */
  badgeLocal({ requests: Math.max(0, badge.requests - 1) });
  try {
    await dmApi.hide(c.conv_id);
    dmStoreDrop(owner, c.conv_id);   /* 杞?194锛氫細璇濈Щ鍑哄垪琛ㄥ嵆娓呮湰鍦板簱 */
    idbDrop(c.conv_id);   /* 杞?204锛氬叏閲忓簱鍚屾竻 */
    /* 轮 377：await 期间可能有列表刷新把服务端旧行又拉回来（hide 尚未提交），
     * 成功后要再摘一次，别让被拒请求在列表里复活到下一拍。 */
    if (meId.value === owner) {
      convs.value = convs.value.filter((x) => String(x.conv_id) !== String(c.conv_id));
      convLocal.delete(String(c.conv_id));
    }
  } catch (e) {   /* 闈欓粯鍥炴粴 */
    /* 轮 377：请求期间换号，旧账号的会话行/角标不能插回新账号列表。 */
    if (removed && meId.value === owner) convs.value.splice(Math.min(idx, convs.value.length), 0, removed);
    if (meId.value === owner) badgeLocal({ requests: badge.requests + 1 });
  }
  if (meId.value === owner) refreshBadge();
}

async function toggleMute(c) {
  const on = !c.muted;
  if (!tapGuard.accept(`mute:${c.conv_id}`)) return;
  menuFor.value = "";
  /* 杞?238 路 涔愯鏇存柊锛氿煍?鍥炬爣鍏堢炕锛岀綉缁滃彧鍋氱‘璁わ紱澶辫触鍥炴粴銆?
   * 鏃у啓娉曚袱涓瘺鐥咃細await 瀹屾墠鏀?+ 鏀圭殑鏄?rowView 鎷疯礉锛堜笉鍝嶅簲寮忥級锛?
   * 缁撴灉寮辩綉鐐瑰畬娌″姩闈欍€佸浘鏍囪绛変笅杞垪琛ㄥ埛鏂版墠鍑虹幇锛堢敤鎴峰疄娴嬨€屼笉璺熸墜銆嶏級銆?*/
  const row = convs.value.find((x) => String(x.conv_id) === String(c.conv_id));
  if (row) row.muted = on;
  /* 静音那一刻立刻把这一行的未读从导航角标里摘掉（服务端 dm_unread_total 已排除静音
   * 会话，见 MIGRATION_dm_mute_silence.sql）；取消静音交给 refreshBadge 用权威值补回。
   * 不这么做的话，用户点完「免打扰」角标还要等 30s 轮询才肯掉。 */
  const pending = Number(row && row.unread) || 0;
  if (on && pending) badgeLocal({ dm: Math.max(0, badge.dm - pending) });
  try { await dmApi.mute(c.conv_id, on); refreshBadge(); }
  catch (e) {
    if (row) row.muted = !on;
    if (on && pending) refreshBadge();   /* 回滚：把刚才乐观减掉的补回来 */
  }
}

async function hideConv(c) {
  const owner = meId.value;
  menuFor.value = "";
  /* 杞?238 路 涔愯鏇存柊锛氳鍏堟秷澶便€佽亰澶╅〉鍏堥€€鍑猴紱澶辫触鎻掑洖鍘熶綅銆傛湰鍦板簱娓呯悊绛夌‘璁ゆ垚鍔熷啀鍋氥€?*/
  const idx = convs.value.findIndex((x) => String(x.conv_id) === String(c.conv_id));
  const removed = idx >= 0 ? convs.value.splice(idx, 1)[0] : null;
  if (String(activeId.value) === String(c.conv_id)) {
    activeId.value = "";
    router.replace({ name: "messagesList" }).catch(() => {});
  }
  try {
    await dmApi.hide(c.conv_id);
    dmStoreDrop(owner, c.conv_id);   /* 杞?194锛氫細璇濈Щ鍑哄垪琛ㄥ嵆娓呮湰鍦板簱 */
    idbDrop(c.conv_id);   /* 杞?204锛氬叏閲忓簱鍚屾竻 */
    if (meId.value === owner) {
      /* 轮 377：await 期间列表刷新可能把服务端旧行又拉回来，成功后要再摘一次。 */
      convs.value = convs.value.filter((x) => String(x.conv_id) !== String(c.conv_id));
      convLocal.delete(String(c.conv_id));
      if (meta.value && String(meta.value.conv_id) === String(c.conv_id)) meta.value = null;
      refreshBadge();   /* 轮 377：换号后不再刷旧账号的角标 */
    }
  } catch (e) {   /* 闈欓粯鍥炴粴 */
    /* 轮 377：请求期间换号，旧账号的会话行不能插回新账号列表。 */
    if (removed && meId.value === owner) convs.value.splice(Math.min(idx, convs.value.length), 0, removed);
  }
}

async function toggleBlock(c) {
  /* 杞?238 路 涔愯鏇存柊锛氳涓婄殑鎷夐粦鎬佸厛缈伙紙鏈娓呴浂/鍒楄〃杩囨护绔嬪嵆鐢熸晥锛夛紝鑿滃崟鍏堟敹锛?
   * 缃戠粶鍙仛纭锛涘け璐ュ洖婊氥€傚垪琛ㄥ埛鏂伴檷绾т负鍚庡彴闅愬紡鍒凤紙涓嶅啀 await 鎸′綇鎿嶄綔鍙嶉锛夈€?*/
  const row = convs.value.find((x) => String(x.conv_id) === String(c.conv_id));
  const wasBlocked = !!(row ? row.blocked : (activeConv.value || meta.value || {}).blocked);
  if (!tapGuard.accept(`block:${c.conv_id}`)) return;
  menuFor.value = "";
  if (row) row.blocked = !wasBlocked;
  try {
    /* 杞?34锛氭媺榛?鍏ㄧ珯鐢熸晥锛堢淇?+ 鏆栧績澧欏唴瀹硅繃婊わ級锛岀紦瀛樺悓姝ヨ蛋 userBlocks */
    if (wasBlocked) await unblockUser(c.other_id);
    else await blockUser(c.other_id, c.nickname);
  } catch (e) {   /* 闈欓粯鍥炴粴 */
    if (row) row.blocked = wasBlocked;
  }
  loadConvsImplicit();
  refreshBadge();
}

/* 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ 杞?142/143 路 婕傛祦鐡舵锛堟闈級锛氶€変腑/鍚屾剰/澶撮儴鑿滃崟鎿嶄綔 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ */

/* 宸﹀垪鐐逛竴灏佷俊 鈫?涓垪 BottleChat 鐙珛娓叉煋锛堜笉纰颁細璇濇鐨?activeId锛?*/
function pickBottle(row, name) {
  bottleRow.value = row;
  bottleName.value = name || "";
  bottleMeta.value = {};
  headMenu.value = false;
}

/* 轮448：左列把「当前正在看的那封信」撤回/隐藏掉了 → 清掉选中，中列回到
 * 「点一封信看看」的空态（BottleChat 已有 !letter 占位，不会停在已删的信上）。
 * 撤的是别的信则不动选中。 */
function onBottleRemoved(id) {
  if (bottleRow.value && String(bottleRow.value.id) === String(id)) {
    bottleRow.value = null;
    bottleName.value = "";
    bottleMeta.value = {};
  }
}

/* 瀛愬垪鎶娿€屽緟鎴戝喅瀹氥€嶇殑鏁伴噺鎶ヤ笂鏉ワ細鎵嬫満鍒嗘鏉?/ 妗岄潰鍒嗘鏉?/ 搴曢儴娑堟伅 Tab 鍏辩敤杩欎竴棰楃孩鐐广€?
 * 杞?371锛氬悓姝ュ啓 badgeStore 鈥斺€?搴曢儴 TabBar 涓庢闈㈤《鏍忚鐨勬槸鍚屼竴涓?badge.bottle銆?*/
function onBottlePending(n) {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  badgeLocal({ bottle: v });
}

/* 棣栧睆灏辨妸銆屾紓娴佺摱銆嶅垎娈电孩鐐逛寒鍑烘潵锛屼笉鐢ㄧ瓑鐢ㄦ埛鍏堢偣杩涘幓銆?
 * 鍙彇涓€娆★紙鈮?00锛屼笌瀛愬垪鍚屽彛寰勶級锛涘け璐ラ潤榛樷€斺€斿瓙鍒楁墦寮€鍚庝細鍐嶆姤涓€娆°€?
 * 杞?371锛氬彇鏁伴€昏緫鏀惰繘 badgeStore.refreshBottleBadge锛屽簳鏍忎笌鍒嗘鍏辩敤鍚屼竴鍙ｅ緞銆?*/
async function refreshBottlePending() {
  await refreshBottleBadge();
}

/* 鍚屾剰鑱婂ぉ 鈫?鏁版嵁搴撳缓浼氳瘽锛氭妸鏂颁細璇濆甫杩涖€屼細璇濄€嶆鍒楄〃 + 鍒风孩鐐癸紙涓垪缁х画鍋滃湪婕傛祦鐡惰亰澶╂锛?*/
async function onBottleAccepted(convId) {
  if (convId) openConv(String(convId));   /* accept -> enter the DM chat directly; do not wait for the list refresh */
  loadConvs();
  /* 杞?254锛氱瓑銆屽凡璇汇€嶈惤搴撳啀鏍℃瑙掓爣锛堟棫鍐欐硶 markRead 涓?await 灏?refresh锛屽苟鍙戞媺鍥炴棫鍊硷紝
     绾㈢偣瑕佺瓑涓嬩竴杞?30s 杞鎵嶆秷锛夈€?*/
  refreshBadge({ after: convId ? dmApi.markRead(convId).catch(() => {}) : null });
}

/* 鍚屾剰鎴栨嫆缁濆悗閮介噸鎷夊乏鍒楋細寰呭喅瀹氱殑淇′粠缃《/绾㈢偣閲岀珛鍗虫秷澶憋紙鎷掔粷涓嶄細寤轰細璇濓級銆?*/
function onBottleDecided() {
  bottleList.value?.reload?.();
}

/* BottleChat 鍥炰紶鐨勪汉/浼氳瘽淇℃伅锛坈onvMeta 鎴栧厹搴曞悕瀛楋級鈥斺€斿ご閮ㄣ€屸€︺€嶈彍鍗曟嵁姝ゆ樉绀?*/
function onBottlePeer(info) {
  if (!info) return;
  if (info.nickname) bottleName.value = info.nickname;
  bottleMeta.value = { ...(bottleMeta.value || {}), ...info };
}

/* 璧勬枡鍗＄殑涓や釜鍔ㄤ綔锛氭湁浼氳瘽琛屽氨澶嶇敤浼氳瘽娈电殑 toggleMute/toggleBlock锛涘惁鍒欐寜 conv_id / user_id 鐩存帴璋?*/
async function mutePeer() {
  const row = curConv.value;
  if (row) return toggleMute(row);
  const id = curPeer.value.conv_id;
  if (!id) return;
  if (!tapGuard.accept(`mute:peer:${id}`)) return;
  const on = !curPeer.value.muted;
  /* 杞?238 路 涔愯鏇存柊锛氬ご閮ㄨ彍鍗曟€佸厛缈伙紱澶辫触鍥炴粴 */
  bottleMeta.value = { ...(bottleMeta.value || {}), muted: on };
  try { await dmApi.mute(id, on); refreshBadge(); }
  catch (e) { bottleMeta.value = { ...(bottleMeta.value || {}), muted: !on }; }
}

async function blockPeer() {
  const row = curConv.value;
  if (row) return toggleBlock(row);
  const uid = curPeer.value.user_id;
  if (!uid) return;
  if (!tapGuard.accept(`block:peer:${uid}`)) return;
  const blocked = curPeer.value.blocked;
  /* 杞?238 路 涔愯鏇存柊锛氳彍鍗曟€佸厛缈伙紱澶辫触鍥炴粴 */
  bottleMeta.value = { ...(bottleMeta.value || {}), blocked: !blocked };
  try {
    if (blocked) await unblockUser(uid);
    else await blockUser(uid, curPeer.value.nickname);
    refreshBadge();       /* 杞?254锛氭尓鍒拌惤搴撲箣鍚庯紙鏃у啓娉曞湪鍐欎箣鍓嶅苟鍙戝彂锛屾媺鍥炴棫鍊硷級 */
  } catch (e) {   /* 闈欓粯鍥炴粴 */
    bottleMeta.value = { ...(bottleMeta.value || {}), blocked };
  }
}

/* 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ 杞锛堝彧鍦ㄥ彲瑙?+ 鏈変細璇濇椂璺戯級 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ */

let timer = null;
let tickN = 0;        /* 杞?157锛氳疆璇㈡媿鏁?*/
let tickBusy = false; /* 杞?157锛氫笂涓€鎷嶆病鍥炴潵灏辫烦杩囷紝寮辩綉涓嬩笉鍙犺姹?*/
async function tick() {
  if (tickBusy) return;
  if (typeof document !== "undefined" && document.hidden) return;
  if (!signedIn.value) return;
  tickN++;
  tickBusy = true;
  try {
    if (activeId.value) await pullTail(String(activeId.value));
    /* 浼氳瘽鍒楄〃涓嶅啀姣忔媿鍏ㄩ噺鎷?200 琛岋細姣?3 鎷嶏紙绾?15s锛変竴娆★紝鏈/棰勮浠嶅鏂伴矞锛?
     * 鍚庡彴 chatter 灏?2/3锛屽急缃戜笅涓嶈窡鐢ㄦ埛鎿嶄綔鎶㈠甫瀹姐€傛秷鎭疆璇紭鍏堜簬鍒楄〃鍒锋柊銆?*/
    if (tickN % 3 === 1) await loadConvsImplicit();
  } catch (e) { /* 闈欓粯 */ }
  finally { tickBusy = false; }
}

/* 杞?355锛氭妸灏鹃儴琛岋紙瀹炴椂 INSERT 鎴栫綉缁滄媺鍙栵級骞惰繘褰撳墠浼氳瘽銆?
 * 瀹炴椂閫氶亾鎷垮埌鐨勬槸瀹屾暣 dm_messages 琛岋紝鐩存帴璧拌繖閲屼笂灞忥紱鏃х増鏃犺瀹炴椂杩樻槸杞閮藉啀鍙戜竴娆?
 * dm_list_messages 鈥斺€?寮辩綉涓嬮偅涓€娆″氨鏄敤鎴风湅鍒扮殑銆屽垪琛ㄥ凡鏈夋柊娑堟伅锛岀偣杩涘幓鍗磋绛夊ソ鍑犵銆嶃€?
 * 鍙鐞嗗綋鍓嶄細璇濅笖 msgs 纭疄瑁呯潃瀹冿細鍚﹀垯浜ょ粰 loadMessages / cacheIncoming銆?*/
/* 轮380：清未读只走这一个入口。用户切到漂流瓶/通知段时 activeId 仍然留着，
 * 旧代码的轮询/实时回调会顺手 markRead，红点会在没看会话时消失。 */
function markConversationRead(cid) {
  const id = String(cid || "");
  if (!id || seg.value !== "dm" || !signedIn.value) return;
  const crow = convs.value.find((x) => String(x.conv_id) === id);
  const clost = unreadToClear(crow, badge.dmConvs);   /* 静音会话不重复从角标里扣 */
  if (crow && clost) crow.unread = 0;
  if (clost) badgeLocal({ dm: Math.max(0, badge.dm - clost) });
  badgeDmConvPatch(id, 0);
  refreshBadge({ after: dmApi.markRead(id).catch(() => {}) });
}

function applyTail(cid, asc) {
  if (!asc.length) return false;
  if (!signedIn.value) return false;   /* 杞?376锛氱櫥鍑哄悗瀹炴椂/杞鐨勮繜鍒拌涓嶈鍐嶄笂灞?钀藉簱 */
  if (String(activeId.value) !== String(cid) || msgsConv !== cid) return false;
  /* 轮381：页面被 KeepAlive 切到首页时 document 仍可能是 visible；在飞的 tick
   * 回来后 applyTail 不能替缓存会话清红点，等 onActivated 回到消息页再清。 */
  const viewing = seg.value === "dm" && !wasDeactivated.value
    && !(typeof document !== "undefined" && document.hidden);
  /* 灏鹃儴澧為噺鍚堝苟锛坢ergeTail锛夛細宸茶琛屽師浣嶆洿鏂般€佹柊琛岃拷鍔犫€斺€旂炕杩囩殑鍘嗗彶涓嶅啀琚啿鎺?*/
  const { rows, added } = mergeTail(msgs.value, asc);
  if (rows === msgs.value) return false;
  const el = listEl.value;
  const nearBottom = !el || (el.scrollHeight - el.scrollTop - el.clientHeight) < 120;
  msgs.value = rows;
  /* 轮 377：首屏失败后实时/轮询补进第一条消息时，也要把首屏标记为已落定；
   * 否则下面不落库，openConv 的揭示链也可能一直等不到 entryReady。 */
  if (!entryReady.value) entryReady.value = true;
  /* 杞?376锛氬熬閮ㄨ涔熷彲鑳芥妸銆屽彧鏈夊緟鍙戣銆嶇殑浼氳瘽绗竴娆¤ˉ鍑烘鏁?id锛涘垎椤甸敋鐐硅窡鐫€鏇存柊锛?
   * 鍚﹀垯 oldestId 杩樻槸 null锛屼笂婊戝姞杞芥洿鏃╂案杩滀笉瑙﹀彂銆?*/
  oldestId.value = oldestServerId(msgs.value);
  const crow = convs.value.find((x) => String(x.conv_id) === String(cid));
  /* 杞?376锛氫笉鍙柊澧炶璺熸墜鏇存柊棰勮锛涘鏂规挙鍥炴渶鍚庝竴鏉℃椂 added=false锛?
   * 鏃т唬鐮佷笉鏇存柊棰勮锛岃繑鍥炲垪琛ㄤ粛鐪嬪埌宸叉挙鍥炵殑鏃ф鏂囷紙瑕佺瓑 15s 杞锛夈€?
   * 鍙湁杩欐鍝嶅簲鐪熺殑纰板埌褰撳墠鏈€鍚庝竴鏉℃椂鎵嶆敼锛岄伩鍏嶆妸鏃ф秷鎭殑鏇存柊鍐欐垚鏂伴瑙堛€?*/
  /* raw rows 鍙兘鍥犱负鍚屼細璇濊ˉ鏈湴椤?纭琛岃拷鍔犺€屾殏鏃朵笉鏄椂闂村簭锛?
   * 棰勮蹇呴』鍙栥€屾渶鍚庝竴鏉℃寮忔秷鎭€嶏紝涓嶈兘鐩存帴鎷挎暟缁勬湯琛屻€?*/
  const orderedRows = sortMsgRows(rows);
  const latestRow = [...orderedRows].reverse().find((r) => r && r.id > 0) || orderedRows[orderedRows.length - 1];
  const touchedLatest = !!latestRow && asc.some((r) => String(r.id) === String(latestRow.id));
  if (crow && touchedLatest) {
    const oldLoc = convLocal.get(cid) || {};
    const patch = {
      last_preview: latestRow.deleted_at
        ? t("dm.recalled")
        : (latestRow.body ? String(latestRow.body).slice(0, 80) : (latestRow.image_path ? "📷" : "")),
      last_message_at: latestRow.created_at || crow.last_message_at,
      last_sender: latestRow.sender || crow.last_sender,
      /* 鎾ゅ洖琛屼篃绮樹綇锛氭湇鍔＄鎾ゅ洖涓嶆敼鏃堕棿鎴筹紝鏃у揩鐓т細鎷挎棫姝ｆ枃鎶婂畠鐩栧洖鍘汇€?
       * recalled_from 璁颁綇鎾ゅ洖鍓嶉偅鏉℃鏂囷紝鏈嶅姟绔湡鍑轰簡鏂版秷鎭椂涓嶄細鍐嶈绮樸€?*/
      preview_rev: latestRow.deleted_at ? Date.now() : 0,
      recalled_from: latestRow.deleted_at
        ? (oldLoc.recalled_from || (crow.last_preview || ""))
        : null,
    };
    /* 杞?376锛氬熬閮ㄩ瑙堜篃璁拌繘鏈湴琛ヤ竵琛紝闃叉涓嬩竴杞?15s 鐨勬棫鏈嶅姟绔揩鐓ф妸瀹冪洊鍥炲幓銆?*/
    convLocal.set(cid, { ...(convLocal.get(cid) || {}), ...patch });
    Object.assign(crow, patch);
  }
  if (added) {
    /* 轮 377：消息区还隐藏（首屏失败/入场钉底）时，尾部落进第一条必须重新走揭示链；
     * 旧代码只在 nearBottom 时滚，隐藏列表的 gap 很大，结果一直不揭示。 */
    if (!listRevealed.value) scrollBottom(false, true);
    else if (nearBottom) scrollBottom(true);
    /* 杞?254锛氳鏈鏈湴鍏堟竻 + 瑙掓爣鍚屾鍑忥紙涔愯璺熸墜锛夛紝绛夎惤搴撳啀鏍℃
       轮380：只有人真的在会话段时才清；在漂流瓶/通知段只更新消息与预览。 */
    if (viewing) markConversationRead(cid);
  }
  /* 杞?355/376锛氬疄鏃?杞鏀跺埌鐨勬柊娑堟伅涔熻惤鏈湴搴撱€傛棫鐗堝彧鏈?loadMessages / send 钀藉簱锛?
   * 鍦ㄤ細璇濋噷鏀跺埌娑堟伅鍚庣寮€鍐嶈繘锛屾湰鍦板簱杩樻槸鏃х殑 鈫?鍙堣绛変竴娆＄綉缁溿€?
   * 杞?376锛氫笉鍙湪 added 鏃跺啓 鈥斺€?鍘熶綅鏇存柊锛堝鏂规挙鍥炪€佸け璐ユ爣璁板埛鏂帮級鍚屾牱瑕佽惤鐩橈紝
   * 鍚﹀垯绂诲紑鍐嶈繘浼氬厛鐪嬪埌鏃ф鏂囷紝绛夌綉缁滃洖鏉ユ墠鍙樸€屽凡鎾ゅ洖銆嶃€?
   * entryReady=true 琛ㄧず msgs 宸叉槸璇ヤ細璇濈殑瀹屾暣鏈湴绐楀彛锛屾暣绐楀啓鍥炲畨鍏紱
   * 鍙啓灏鹃儴浼氳涓嬫杩涗細璇濇妸銆屼竴鏉″熬閮ㄣ€嶅綋瀹屾暣鍘嗗彶锛堟洿鏃╃殑璁板綍鎺掍笉鍒板畠鍓嶉潰锛夈€?*/
  if (entryReady.value && meId.value) {
    dmStoreSave(meId.value, cid, msgs.value, hasMore.value);
    idbMerge(cid, msgs.value);
  }
  return added;
}

/* 轮380：从漂流瓶/通知切回会话段时补一次已读 —— 切走期间 applyTail 故意没有清，
 * 否则用户只是去别的段转一圈，回来会看到自己明明在看的会话还挂着红点。 */
watch(seg, (v) => {
  if (v !== "dm") return;
  const cid = String(activeId.value || "");
  if (cid && String(msgsConv) === cid) markConversationRead(cid);
});

/* 灏鹃儴鍒锋柊锛氱綉缁滄媺璇ヤ細璇濇湇鍔″櫒渚ф渶鏂?20 鏉★紝浜ょ粰 applyTail 鍚堝苟銆?
 * 杞?225 璇箟鍘熸牱淇濈暀锛氬彧璇讳笉鍙戝彿锛坢ySeq = msgSeq锛夛紝鍝嶅簲鍥炴潵鍙牎楠屽彿涓庝細璇濓紱
 * 鍙戝彿鏉冧粛褰?loadMessages锛坥penConv锛夛紝杞缁濅笉椤跺彿銆傚疄鏃?INSERT 宸茬洿鎺ヨ蛋 applyTail锛?
 * 涓嶅啀涓轰簡銆屽疄鏃躲€嶅鎵撲竴娆?dm_list_messages銆?*/
async function pullTail(cid) {
  const mySeq = msgSeq;
  const owner = meId.value;
  const got = (await dmApi.listMessages(cid, { before: null, limit: 20 })) || [];
  /* 绛夊搷搴旀湡闂寸敤鎴峰垏璧颁簡浼氳瘽锛堟垨鍙戣捣浜嗘柊鐨勫姞杞斤級鈫?杩欎唤灏鹃儴鏁版嵁灞炰簬鏃т細璇濓紝鏁翠唤涓㈠純銆?*/
  if (isStale(mySeq, cid)) return false;
  if (!signedIn.value || (!!owner && meId.value !== owner)) return false;   /* 杞?376锛氭崲鍙峰悗鐨勬棫灏鹃儴涓嶈惤鐩?*/
  return applyTail(cid, got.slice().reverse());
}

/* 杞閲岀殑鍒楄〃鍒锋柊锛氫笉鍔?loadingConvs锛岄伩鍏嶅垪琛ㄩ棯銆岃浇鍏ヤ腑銆?*/
async function loadConvsImplicit() {
  const owner = meId.value;
  if (!signedIn.value || !owner) return;
  try {
    const rows = (await dmApi.listConvs(200, 0)) || [];
    if (!signedIn.value || meId.value !== owner) return;
    const merged = mergeLocalConvs(rows);
    convs.value = withBlockedTombstones(merged);
    convsLoaded.value = true;   /* 杞?266锛氳疆璇篃绠楁湇鍔＄搴旂瓟锛堥鎷夊け璐ュ悗杞鏁戝洖 = 绌烘€佸彲淇★級 */
    failed.value = false;
    convsRetryN = 0;
    /* 杞?296锛氭妸杩欎唤鏈€鏂板垪琛?*鍥炲啓 SWR 缂撳瓨**銆傛鍓嶅畠缁曡繃缂撳瓨銆佷篃涓嶅洖鍐?鈥斺€?
     * 浜庢槸銆屽喎寮€ / 鍒锋柊钀藉湪娑堟伅椤点€嶉偅鏉″厹搴曡矾锛坙oadConvsImplicit 鏄偅閲屽敮涓€鐨勫姞杞藉櫒锛?
     * 姘歌繙鍚冧笉鍒板揩鐓э紝姣忔閮藉緱绛変竴娆″畬鏁?RPC锛涗笅娆″喎鍚姩鐓ф牱娌℃湁鍙寮€鐨勬暟鎹€?
     * 鍥炲啓涔嬪悗 loadConvs 鐨?cached 閽╁瓙鎵嶅彲鑳藉懡涓€?
     * 杞?320锛氬洖鍐欑殑鏄?*鍚堝苟鍚?*鐨勫垪琛紙鍚湰鍦板垰鍙戠殑棰勮锛夆€斺€?
     * 鐩存帴鍐欐湇鍔＄鍘熷€间細鎶娿€屾垜鍒氬彂鐨勬秷鎭€嶄粠缂撳瓨閲屾姽鎺夛紝杩斿洖鍒楄〃鍙堝彉绌洪瑙堛€?*/
    if (meId.value) cacheSet(cacheKey("dm:convs", meId.value), merged);
  } catch (e) { /* 闈欓粯 */ }
}

/* 杞?355锛氬埆鐨勪細璇濇敹鍒板疄鏃舵柊娑堟伅 鈫?鍏堟妸杩欐潯鍐欒繘璇ヤ細璇濇湰鍦板簱銆?
 * 鍒楄〃棰勮浼氱敱 loadConvsImplicit 鏇存柊锛屼絾鐐硅繘浼氳瘽鏃?loadMessages **鍙鏈湴搴?*锛?
 * 涓嶅啓灏辫绛変竴娆¤法澧?dm_list_messages 鈥斺€?鐢ㄦ埛鐪嬪埌鐨勫氨鏄€屽垪琛ㄦ湁鏂版秷鎭紝鐐硅繘鍘绘病鏈夛紝
 * 濂藉嚑绉掑悗鎵嶅嚭鏉ャ€嶃€傚彧鍦ㄨ浼氳瘽宸叉湁鍘嗗彶鏃惰拷鍔狅紙dmStoreAppend 鍐呴儴鍒ゅ畾锛夛紝
 * 娌℃湁鍘嗗彶涓嶅啓锛岄伩鍏嶆妸涓€鏉″熬閮ㄥ綋鎴愬畬鏁村巻鍙层€佽繘浼氳瘽鍚庢洿鏃╄褰曟帓涓嶅埌瀹冨墠闈€?*/
async function cacheIncoming(cid, row) {
  const owner = meId.value;
  if (!owner || !cid || !row || row.id == null) return;
  dmStoreAppend(owner, cid, row);
  /* 鍒楄〃琛屽厛璺熸墜锛堜笅涓€娆?loadConvsImplicit 浼氱敤鏈嶅姟绔暣琛屾牎姝ｏ級銆?
   * 杞?376锛氬疄鏃惰涔熷彲鑳戒贡搴忓埌杈撅紱姣斿綋鍓嶉瑙堟洿鏃х殑琛屽彧杩涙秷鎭簱锛屼笉璁告妸棰勮鐩栧洖鍘汇€?*/
  const crow = convs.value.find((x) => String(x.conv_id) === String(cid));
  const rowAt = Date.parse(row.created_at || "") || 0;
  if (crow && rowAt >= convLatestAt(cid)) {
    const oldLoc = convLocal.get(cid) || {};
    const patch = {
      last_preview: row.deleted_at
        ? t("dm.recalled")
        : (row.body ? String(row.body).slice(0, 80) : (row.image_path ? "📷" : "")),
      last_message_at: row.created_at || crow.last_message_at,
      last_sender: row.sender || crow.last_sender,   /* 杞?376锛氶瑙堝綊灞炶窡鎵?*/
      preview_rev: row.deleted_at ? Date.now() : 0,
      recalled_from: row.deleted_at
        ? (oldLoc.recalled_from || (crow.last_preview || ""))
        : null,
    };
    convLocal.set(cid, { ...(convLocal.get(cid) || {}), ...patch });
    Object.assign(crow, patch);
  }
  try {
    const rec = await idbLoad(cid);
    if (!signedIn.value || meId.value !== owner) return;   /* 杞?376锛氱瓑 IDB 鏈熼棿鎹㈠彿锛屾棫琛屼笉鍐?*/
    if (rec && Array.isArray(rec.msgs) && rec.msgs.length) await idbMerge(cid, [row]);
  } catch (e) { /* 鏈湴搴撲笉鍙敤锛氳繘浼氳瘽缃戠粶鍏滃簳 */ }
}

/* 杞?269 路 瀹炴椂 INSERT 鍥炶皟锛?
 *  - 浜嬩欢灞炰簬褰撳墠鎵撳紑鐨勪細璇?鈫?鐩存帴鎷垮疄鏃惰 applyTail 涓婂睆锛堜笉鍐嶅缁曚竴娆＄綉缁滐級锛?
 *  - 灞炰簬鍒殑浼氳瘽 鈫?鍏堝啓鏈湴搴擄紙cacheIncoming锛夛紝鍐嶉殣寮忓埛鏂板垪琛紙鑺傛祦 3s 涓€娆★級锛?
 *    琛屾湭璇荤孩鐐圭敱 badge 鐨?refreshBadge(conv 鏄庣粏) 鍏堜寒锛坉mRealtime 宸茶Е鍙戯級銆?*/
let offDmInsert = null;
let rtListAt = 0;
function armDmRealtime() {
  if (offDmInsert) return;
  offDmInsert = onDmInsert((row) => {
    if (!signedIn.value) return;
    const cid = String((row && row.conv_id) || "");
    if (!cid) return;
    if (activeId.value && String(activeId.value) === cid) {
      /* 瀹炴椂琛屽氨鏄畬鏁存秷鎭紱msgs 杩樻病瑁呰繖涓細璇濇椂锛堥寮€缃戠粶鏈洖锛変氦缁?cacheIncoming锛?
         鐢?loadMessages 鏁寸獥鎷夊彇锛岀粷涓嶆妸涓€琛屽杩涚┖鍒楄〃銆?*/
      if (!applyTail(cid, [row])) cacheIncoming(cid, row).catch(() => {});
      return;
    }
    cacheIncoming(cid, row).catch(() => {});
    const now = Date.now();
    if (now - rtListAt < 3000) return;
    rtListAt = now;
    loadConvsImplicit();
  });
}
function disarmDmRealtime() {
  if (offDmInsert) { try { offDmInsert(); } catch (e) {} offDmInsert = null; }
}

function onVisible() {
  /* 轮381：页面被 KeepAlive 缓存但已切走（onDeactivated）时，全局 visibilitychange
   * 仍会打到这里。旧写法只判断 seg==="dm"，于是人在首页/别的页回前台，
   * 也会替缓存里的会话抬已读、后台跑轮询 —— 红点凭空消失。 */
  if (wasDeactivated.value) return;
  if (typeof document !== "undefined" && !document.hidden) {
    /* 轮380：后台期间 applyTail 故意没清未读；回到前台且会话仍开着，补一次已读。 */
    const cid = String(activeId.value || "");
    if (seg.value === "dm" && cid && String(msgsConv) === cid) markConversationRead(cid);
    tickN = 0;
    tick();
  }
}

/* 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺?杞?296 路 鍐峰紑 / 鍒锋柊钀藉湪鏈〉锛屼細璇濆垪琛ㄧ櫧绛?5 绉?鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺?
 * 鐢ㄦ埛鐐瑰崟锛氥€岄噸鏂版墦寮€ app 鎴栬€呯數鑴戝埛鏂帮紝娑堟伅鐨勪細璇濆垪琛ㄨ繕鏄嚭鐜板緱闈炲父鎱€嶃€?
 * 鐥呮牴涓嶆槸鏌ヨ鎱紝鏄?*鏍规湰娌″彂鏌ヨ**锛?
 *   signedIn = computed(() => !!(cloud.ready && cloud.user))锛?1 琛岋級锛?
 *   鍐峰紑 / F5 鏃惰矾鐢辩粍浠舵寕杞界殑閭ｄ竴鍒?initCloud() 杩樻病璺戝畬 鈫?signedIn 涓?false
 *   鈫?onMounted 绗竴鍙ョ洿鎺?return锛宺efreshBlocks / loadConvs / 杞 / 瀹炴椂鍥炶皟鍏ㄨ璺宠繃銆?
 *   鍏ㄦ枃浠跺張娌℃湁浠讳綍 watch(signedIn)锛屾棭閫€涔嬪悗**娌℃湁浠讳綍涓滆タ鍥炴潵琛ヨ窇**銆?
 *   鍞竴娲荤潃鐨勬仮澶嶉€氶亾鏄?onActivated 鎸傜殑 5 绉掕疆璇紝涓斿畠璧扮殑鏄?loadConvsImplicit
 *   锛堜笉鍚?SWR 缂撳瓨銆佺函缃戠粶锛夈€傛墍浠ャ€岃惤鍦ㄦ秷鎭〉銆? 鑷冲皯 5 绉?+ 涓€娆″畬鏁?RPC銆?
 *   瀵圭収锛氫粠鍒殑椤电鐐硅繘鏉ユ槸姣绾?鈥斺€?閭ｆ椂 signedIn 宸叉槸 true锛岃蛋 loadConvs 鐨?
 *   cached 閽╁瓙鍚屾娓叉煋锛?72 琛岋級銆傚悓涓€椤甸潰涓ょ浣撻獙锛屽樊鍒彧鍦ㄨ璇佸氨缁簡娌℃湁銆?
 * 淇硶锛氭妸銆屽氨缁悗璇ュ共鐨勪簨銆嶆娊鎴?boot()锛宱nMounted 涓?watch(signedIn) 鍏辩敤 鈥斺€?
 *   璁よ瘉涓€灏辩华绔嬪埢璺戯紝涓嶅啀绛夎疆璇㈣妭鎷嶃€俠oot 骞傜瓑锛坆ooted 闂搁棬锛夛紝涓ゆ潯璺緞鎾炶溅鍙窇涓€娆°€?*/
let booted = false;
/* 轮381：用 ref 而不是普通 let —— 模板要把后台状态传给漂流瓶聊天；
 * 普通 let 改了不会触发重渲染，子组件会一直以为父页还在前台。 */
const wasDeactivated = ref(false);
async function boot() {
  if (booted || !signedIn.value) return;
  booted = true;
  refreshBlocks();   /* 杞?34锛氳繘娑堟伅椤靛悓姝ユ媺榛戝悕鍗曪紙鍐呭杩囨护涓庣淇″悕鍗曞悓婧愶級 */
  refreshBottlePending();   /* 杞?368锛氶灞忕偣浜€屾紓娴佺摱銆嶅垎娈电殑寰呭喅瀹氱孩鐐?*/
  /* 杞?245锛堢敤鎴峰疄娴嬪喎鍚姩銆屾紓娴佺摱鈫掕繘鑱婂ぉ鍋滈《/璺抽棯銆嶏級锛歰penConv 涓嶅啀绛変細璇濆垪琛?鈥斺€?
   * loadConvs 鍐峰惎鍔ㄨ璧扮綉缁?鏈湴搴擄紝鎶婂畠 await 瀹屾墠 openConv 浼氭妸閽夊簳/鎻ず閾惧牭鍦ㄥ悗闈細
   * 鏈熼棿 listRevealed 杩樻槸鍒濆 true銆丏OM 鍋滃湪鏃т綅缃紙=鍏堢湅鍒伴《锛夛紝openConv 缁堜簬璺戣捣鏉?
   * 鎵嶉殣钘忊啋閽夊簳鈫掓彮绀猴紙=鍐嶈烦涓€涓嬪埌搴曪級銆傚苟琛屽悗閽夊簳閾剧珛鍒绘帴绠°€?
   * openConv 鍙湪 convs 閲屾煡涓嶅埌浼氳瘽鏃舵墠椤哄甫 loadMeta锛坈onvs 鏈氨缁?= 蹇呮媺锛岃涔変粛瀵癸級銆?*/
  const firstOpen = activeId.value ? openConv(activeId.value) : null;
  await loadConvs();
  if (firstOpen) await firstOpen;
  /* 淇濇椿鏈?onDeactivated 宸叉妸 timer 娓呬簡锛氳鍥句笉鍦ㄥ墠鍙版椂鍒妸杞鍙堟媺璧锋潵锛坥nActivated 浼氳嚜宸遍噸鎸傦級 */
  if (!timer && !wasDeactivated.value) timer = setInterval(tick, 5000);
  /* 轮381：认证在页面被 KeepAlive 缓存期间才就绪时，boot 不能把实时回调又挂起来；
   * 回到消息页由 onActivated 统一重挂。 */
  if (!wasDeactivated.value) armDmRealtime();   /* 杞?269锛氬疄鏃跺洖璋冩寕杞斤紙鏈鍥惧嵏杞藉嵆娉ㄩ攢锛?*/
}

onMounted(() => {
  pushBack(segBack);
  document.addEventListener("pointerdown", onDocPointerDown);   /* 杞?44锛氣嫰鑿滃崟鐐圭┖鐧藉叧 */
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
  boot();   /* 宸茬櫥褰?鈫?绔嬪埢璺戯紱鏈櫥褰?鈫?绛変笅闈㈢殑 watch(signedIn) 琛ヨ窇锛堣疆 296锛?*/
});

/* 杞?296锛氳璇佸氨缁悗琛ヨ窇銆傝繖鏄笂闈㈤偅鏉℃璺紙鏃╅€€鍚庢病浜虹锛夊敮涓€鐨勬仮澶嶉€氶亾锛?
 * 鍘熷厛鍙兘骞茬瓑 5 绉掕疆璇€傜櫥鍑烘椂鎶婇椄闂ㄦ斁涓嬶紝閲嶆柊鐧诲綍褰撲綔鍐峰惎鍔ㄩ噸璺戜竴閬?
 * 锛圓pp 渚х櫥鍑轰細 cacheDrop("dm:")锛屾湰椤电殑 convs 涔熻閲嶆柊鎷夛級銆?*/
watch(signedIn, (v) => {
  if (!v) {
    booted = false;
    /* 杞?376锛氱櫥鍑哄悗涓嶈兘鎶婁笂涓€涓处鍙风殑浼氳瘽/娑堟伅鐣欏湪 DOM/鍐呭瓨閲屻€?*/
    msgSeq++;   /* 浣滃簾鎵€鏈夊湪閫?loadMessages */
    convs.value = [];
    msgs.value = [];
    msgsConv = "";
    convLocal.clear();   /* 轮 377：本地预览补丁也按账号隔离，换号后不能带过去 */
    oldestId.value = null;
    convsLoaded.value = false;
    loadingConvs.value = false;
    failed.value = false;
    convsRetryN = 0;
    clearTimeout(convsRetryTimer);
    convsRetryTimer = 0;
    clearInterval(timer);
    timer = 0;
    return;
  }
  boot();
});

/* 杞?218锛氫繚娲绘湡鏆傚仠杞/鐩戝惉锛圞eepAlive 涓?onBeforeUnmount 涓嶈Е鍙戯級 */
/* 杞?247锛氬尯鍒嗐€岄娆℃縺娲汇€嶄笌銆岀湡鎭㈠銆嶁€斺€擪eepAlive 棣栨鎸傝浇涔熶細瑙﹀彂 onActivated锛?
 * 鏃犲樊鍒己鍒舵彮绀轰細鎶?openConv 鍒氳鐨勩€岄殣钘忓緟閽夌ǔ銆嶇珛鍒绘敼鍥炲彲瑙侊紝閽夊簳闇囪崱鍏ㄧ▼瑁稿
 * 锛堢湡鏈洪€愬抚瀹炶瘉锛歷is 浠庣涓€甯у氨鏄?visible銆乼op 0鈫?811鈫?433鈫?841 鎶樿繑璺?= 鐢ㄦ埛鎶ョ殑璺抽棯锛夈€?
 * 锛堣疆 296锛歸asDeactivated 鐨勫０鏄庢尓鍒颁簡涓婃柟 boot() 澶?鈥斺€?boot 瑕佽瀹冨垽鏂繚娲绘湡鍒媺杞锛?*/
onActivated(() => {
  if (!timer) timer = setInterval(tick, 5000);
  armDmRealtime();   /* 杞?269锛氫繚娲绘仮澶嶆椂閲嶆寕瀹炴椂鍥炶皟锛堜笌杞鍚岃妭濂忥級 */
  document.addEventListener("pointerdown", onDocPointerDown);
  restoreScroll(route.path);   /* 杞?219锛氬洖浣嶏紙KeepAlive 閲嶆彃鐬棿锛?*/
  restoreConvList();           /* 轮491：会话列表自己的滚动位置（切走再回来的那条路） */
  /* 杞?245 鈫?247/248 鏀跺彛锛氱湡鎭㈠鏃?*鍙ˉ婊氬姩浣嶇疆锛岀粷涓嶅姩 listRevealed** 鈥斺€?
   * 鈶?鍚屼細璇濇仮澶嶏細缂撳瓨 DOM 鏈氨澶勪簬鎻ず鎬侊紙涓婃绂诲紑鏃?visible锛夛紝鍙渶鎶婂仠鍦ㄩ《閮ㄧ殑
   *    scrollTop 閽夊洖搴曪紙淇€岀浜屾杩涜亰澶╁仠椤躲€嶏級锛?
   * 鈶?涓嶅悓浼氳瘽锛堝浠庡埆浜轰富椤点€屽彂绉佷俊銆嶆繁閾捐繘鏉ワ級锛歸atch 浼氳Е鍙?openConv锛岄拤绋虫彮绀洪摼
   *    鍏ㄦ潈鎺ョ 鈥斺€?杩欓噷鑻ュ己鍒?listRevealed=true 浼氭妸銆岄殣钘忓緟閽夌ǔ銆嶇炕鍥炲彲瑙侊紝
   *    閽夊簳闇囪崱鍏ㄧ▼瑁稿锛堢湡鏈洪€愬抚瀹炶瘉锛歵op 0鈫?811鈫?433鈫?841 鎶樿繑璺?= 鐢ㄦ埛鎶ョ殑璺抽棯锛夛紱
   * 鈶?棣栨鎸傝浇锛歰nActivated 涔熶細瑙﹀彂锛圞eepAlive 棣栨婵€娲伙級锛寃asDeactivated=false 鎷︿綇銆?*/
  if (wasDeactivated.value && seg.value === "dm" && route.name === "messages"
    && route.params.id && String(route.params.id) === activeId.value) {
    pinning.value = false;
    /* 轮377：离开时首屏揭示链可能还没跑完（listRevealed=false）。旧版回来只改
     * scrollTop，消息区仍 visibility:hidden，只能干等 2s 兜底。这里重开揭示链。 */
    if (!listRevealed.value) {
      scrollBottom(false, true);
    } else if (!userScrolling.value) {
      nextTick(() => { const el = listEl.value; if (el) el.scrollTop = el.scrollHeight; });
    }
    /* 轮381：从别的页面/路由回到这个仍开着的会话，人已经看到聊天框了；
     * 离开期间攒下的未读应立刻清，不必等下一拍轮询拉到新行。 */
    if (typeof document === "undefined" || !document.hidden) {
      markConversationRead(String(activeId.value));
    }
  }
  wasDeactivated.value = false;
});
onDeactivated(() => {
  wasDeactivated.value = true;
  scrollGen++;   /* 轮 377：停掉旧的钉底/揭示 rAF，后台不再改 DOM */
  clearInterval(timer); timer = 0;
  disarmDmRealtime();   /* 杞?269锛氫繚娲绘湡鏆傚仠瀹炴椂鍥炶皟锛堜笌杞〃鍚岃妭濂忥級 */
  document.removeEventListener("pointerdown", onDocPointerDown);
});
onBeforeUnmount(() => {
  popBack(segBack);
  chatOpen.value = false;
  scrollGen++;   /* 轮 377：卸载后旧 rAF 不再写 DOM */
  if (topRaf) { cancelAnimationFrame(topRaf); topRaf = 0; }
  document.removeEventListener("pointerdown", onDocPointerDown);
  clearInterval(timer);
  clearTimeout(hitTimer); hitTimer = 0;   /* 杞?337锛氬埆璁╅槻鎶栭噷鐨勬悳绱㈠湪椤甸潰鍗歌浇鍚庡啓鐘舵€?*/
  disarmDmRealtime();   /* 杞?269 */
  clearTimeout(convsRetryTimer); convsRetryTimer = 0;
  clearTimeout(entryFallback); entryFallback = 0;   /* 轮 377：卸载后别再揭示/改状态 */   /* 杞?266锛氬埆鎶婇噸璇曞甫杩涘潫澧?*/
  if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
});

/* 鍦板潃鏍忓彉浜嗭紙閫氱煡涓績鐐圭淇¤烦杩涙潵 / 鈫?閽?/ 绯荤粺杩斿洖閿級鈫?鍒囦細璇濇垨鍥炲垪琛?*/
watch(() => route.params.id, (v) => {
  /* 杞?237 路 鍙绉佷俊璺敱鑷繁鐨?:id 鈥斺€?鏈〉琚?KeepAlive 淇濇椿锛岃繖涓?watch 鍦ㄥ埆鐨勯〉闈篃娲荤潃銆?
   * 浠庢秷鎭垪琛ㄧ偣澶村儚銆岀湅 TA 鐨勪富椤点€嶈烦 /u/:id 鏃讹紝route.params.id 鍙樻垚**鐢ㄦ埛 uuid**锛?
   * 鏃т唬鐮佹妸瀹冨綋浼氳瘽 id 鈫?openConv(uuid) 鈫?push /messages/<uuid>锛氱敤鎴峰垰钀藉埌涓婚〉灏辫
   * 鍔寔杩涗竴涓┖浼氳瘽锛堟爣棰樿惤鍒般€岃繖浣嶄紮浼淬€嶃€佹秷鎭尯鍏ㄧ┖锛岀敤鎴峰疄娴嬶級銆?
   * /post/:id銆?story/:id 绛夋暟瀛?id 鍚岀悊浼氫腑鎷涳紙璇诲笘 7 浼氳鎷借繘浼氳瘽 7锛夈€?
   * 淇硶锛歳oute 涓嶆槸 messages/messagesList 鏃朵竴寰嬫棤瑙?鈥斺€?姝ゆ椂鏈〉涓嶅彲瑙侊紝:id 涓庢湰椤垫棤鍏炽€?*/
  if (route.name !== "messages" && route.name !== "messagesList") {
    /* 杞?245锛堢敤鎴峰疄娴嬨€屼粠鑱婂ぉ鐗╃悊杩斿洖婕傛祦鐡?鈫?鍐嶇偣娑堟伅椤?= 濉岀缉銆嶏級锛氭棤瑙?鈮?涓嶆竻鐞嗐€?
     * 绂诲紑娑堟伅缁勬椂浼氳瘽鎬佸繀椤绘竻绌?鈥斺€?鍚﹀垯 params.id 浠?"26"鈫抲ndefined 琚笂闈㈢殑瀹堝崼
     * 鎷︽帀銆佸啀杩?/messages 鏃?id 鏃犲彉鍖?watch 涓嶈Е鍙戯紝activeId="26" 涓€璺畫鐣欙細
     * thread 鐨?v-show="!!activeId" 浠嶆樉绀猴紝浣?inChat=false 宸插嵏鎺?shell--chat锛?
     * thread 钀藉洖鍩虹 min-height:60vh = 鑱婂ぉ鍖哄缂┿€佽緭鍏ユ鎮┖锛堢敤鎴锋埅鍥惧疄璇侊級銆?
     * 椤甸潰涓嶅彲瑙佹椂娓呯殑鏄唴閮ㄧ姸鎬侊紝涓嶈Е纰颁换浣曟粴鍔?鐒︾偣锛屽銆岀湅 TA 涓婚〉銆嶇瓑鏉ュ洖鏃犳劅銆?*/
    if (activeId.value) resetConv();
    return;
  }
  const id = String(v || "");
  if (id) {
    if (id !== activeId.value) openConv(id);
    return;
  }
  /* 鍥炲埌鍒楄〃锛氭竻绌哄綋鍓嶄細璇濓紙鎵嬫満褰㈡€佷笅 .dm-list 绔嬪埢鎺ョ鏁村睆锛? 鍥炵淇℃ */
  resetConv();
});

/* 杞?245锛氭竻浼氳瘽鎬佹娊鎴愪竴澶勶紙watch 鐨勪袱涓嚭鍙ｅ叡鐢紱涓庡師銆屽洖鍒板垪琛ㄣ€嶅垎鏀€愬瓧娈靛悓鍙ｅ緞锛?*/
function resetConv() {
  activeId.value = "";
  msgs.value = [];
  msgsConv = "";
  /* 杞?237锛氱炕椤垫父鏍囦竴骞跺浣?鈥斺€?鍙竻 msgs 涓嶆竻 oldestId/hasMore锛屼笅涓細璇濋灞忔暟鎹?
   * 钀藉畾鍓嶄細闂嚭銆屽姞杞芥洿鏃╃殑娑堟伅銆嶆寜閽紙old 娈嬬暀 + 绌哄垪琛ㄧ殑鐭涚浘鎬侊紝鐢ㄦ埛鎴浘瀹炶瘉锛夈€?*/
  oldestId.value = null;
  hasMore.value = true;
  meta.value = null;
  fromList.value = false;
  seg.value = "dm";
}

const when = (ts) => relativeTime(ts, Date.now(), t);
/* 鈹€鈹€ 杞?19鈶ｏ細鍒嗘爮宸﹀彸婊戯紙鍍忛椤典笁鑱旈偅鏍凤細宸︽粦鍘诲彸杈圭殑鏍忥紝鍙虫粦鍘诲乏杈圭殑鏍忥級鈹€鈹€
 * 椤哄簭涓庨《閮ㄦ寜閽竴鑷达細婕傛祦鐡?| 浼氳瘽 | 閫氱煡锛涘彧璁ゆí鍚戜富杞达紝绾靛悜婊氬姩涓嶅彈褰卞搷锛?
 * 浼氳瘽鎵撳紑鏃跺垪琛ㄦ暣椤甸殣钘忥紙v-show=false锛夛紝澶╃劧涓嶈Е鍙戯紝涓嶄細鎶婅亰澶╅〉婊戣蛋銆?*/
const SEG_ORDER = ["bottle", "dm", "notif"];
let segX = 0, segY = 0, segArmed = false;
function segTouchStart(e) {
  const t0 = e.touches[0];
  segX = t0.clientX; segY = t0.clientY; segArmed = true;
}
function segTouchMove(e) {
  if (!segArmed) return;
  const t0 = e.touches[0];
  const dx = t0.clientX - segX, dy = t0.clientY - segY;
  if (Math.abs(dx) < 56) return;                  /* 涓嶅闀夸笉瑙﹀彂 */
  if (Math.abs(dx) < Math.abs(dy) * 1.4) return;  /* 鏂滅潃璧帮紳鎯虫粴鍔紝涓嶈Е鍙?*/
  segArmed = false;                               /* 涓€娆℃墜鍔垮彧鍒囦竴鏍?*/
  if (e.target && e.target.closest && e.target.closest("input, textarea, select")) return;
  const i = SEG_ORDER.indexOf(seg.value);
  const next = dx < 0 ? i + 1 : i - 1;
  if (next >= 0 && next < SEG_ORDER.length) seg.value = SEG_ORDER[next];
}
function segTouchEnd() { segArmed = false; }
const clock = (ts) => {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const dayLabel = (ts) => new Date(ts).toLocaleDateString(
  i18n.locale === "zh" ? "zh-CN" : "en-US", { year: "numeric", month: "short", day: "numeric" });

/* 鏈櫥褰?鈫?鐧诲綍椤碉紙杞?17 缁熶竴鍙ｅ緞锛夛細甯﹀綋鍓?fullPath锛堝惈浼氳瘽 id锛夛紝鐧诲綍鍚庢寜 ?redirect=
 * 鐩存帴鍥炲埌鍘熷锛屼笉鍐嶇粫閬撱€屾垜鐨勩€嶉〉 */
function goSignIn() {
  router.push({ path: "/login", query: { redirect: route.fullPath || "/messages" } });
}
</script>

<template>
  <div class="dm-page" :class="{ 'dm-page--chat': isMobileNav && !!activeId && paneReady }">
    <!-- 杞?344锛氬喎鍚姩鍏堢瓑鐧诲綍鎬佹仮澶嶏紝鍒妸銆屾鍦ㄦ仮澶嶃€嶇敾鎴愩€屾湭鐧诲綍銆?-->
    <div v-if="!signedIn && cloud.checking" class="dm-wrap">
      <section
        class="card dm-list dm-auth-wait"
        aria-busy="true"
        style="grid-column: 1 / -1; align-items: center; justify-content: center; border-right: 0;">
        <svg class="rn-busy" viewBox="0 0 24 24" style="width: 26px; height: 26px;" aria-hidden="true">
          <circle class="rb-track" cx="12" cy="12" r="9" />
          <circle class="rb-arc" cx="12" cy="12" r="9" stroke-dasharray="42 15" />
        </svg>
      </section>
    </div>
    <section v-else-if="!signedIn" class="card dm-empty">
      <p class="sub">{{ t("dm.needSignIn") }}</p>
      <n-button type="primary" round @click="goSignIn">{{ t("profile.goSignIn") }}</n-button>
    </section>

    <div v-else class="dm-wrap">
      <!-- 宸﹀垪锛氫細璇濆垪琛紙鎵嬫満褰㈡€?= 寰俊寮忓垪琛ㄩ〉锛涜繘鍏ヤ細璇濆悗鏁撮〉璁╃粰鑱婂ぉ鍖猴級 -->
      <aside
        v-show="!isMobileNav || !activeId || !paneReady"
        ref="convListEl"
        class="card dm-list"
        :class="{ 'dm-list--seg': isMobileNav && seg === 'notif' }"
        @scroll.passive="onConvListScroll"
        @touchstart.passive="segTouchStart"
        @touchmove.passive="segTouchMove"
        @touchend.passive="segTouchEnd">
        <!-- T8 鍒嗘爮锛堟墜鏈哄舰鎬侊紝鍘熸牱涓嶅姩锛夛細婕傛祦鐡?| 浼氳瘽涓績 | 閫氱煡 -->
        <div v-if="isMobileNav" class="dm-seg" role="tablist">
          <button type="button" class="dm-seg-btn" :class="{ on: seg === 'bottle' }" role="tab" :aria-selected="seg === 'bottle'" @click="seg = 'bottle'">
            {{ t("tab.segBottle") }}
            <span v-if="bottlePending" class="notif-count">{{ bottlePending > 99 ? "99+" : bottlePending }}</span>
          </button>
          <button type="button" class="dm-seg-btn" :class="{ on: seg === 'dm' }" role="tab" :aria-selected="seg === 'dm'" @click="seg = 'dm'">
            {{ t("tab.segDm") }}
            <span v-if="dmBadge" class="notif-count">{{ dmBadge > 99 ? "99+" : dmBadge }}</span>
          </button>
          <button type="button" class="dm-seg-btn" :class="{ on: seg === 'notif' }" role="tab" :aria-selected="seg === 'notif'" @click="seg = 'notif'">
            {{ t("tab.segNotif") }}
            <span v-if="badge.notif" class="notif-count">{{ badge.notif > 99 ? "99+" : badge.notif }}</span>
          </button>
        </div>
        <!-- 杞?142 路 妗岄潰鍒嗘爮锛堝弬鑰冨浘锛夛細浼氳瘽 | 婕傛祦鐡讹紙閫氱煡涓嶈繘妗岄潰绉佷俊椤碉紱涓ゆ鍚勮嚜鍗曞紑鑱婂ぉ妗嗭級 -->
        <div v-else class="dm-seg dm-seg--desk" role="tablist">
          <button type="button" class="dm-seg-btn" :class="{ on: seg === 'dm' }" role="tab" :aria-selected="seg === 'dm'" @click="seg = 'dm'">
            {{ t("tab.segChat") }}
            <span v-if="dmBadge" class="notif-count">{{ dmBadge > 99 ? "99+" : dmBadge }}</span>
          </button>
          <button type="button" class="dm-seg-btn" :class="{ on: seg === 'bottle' }" role="tab" :aria-selected="seg === 'bottle'" @click="seg = 'bottle'">
            {{ t("tab.segBottle") }}
            <span v-if="bottlePending" class="notif-count">{{ bottlePending > 99 ? "99+" : bottlePending }}</span>
          </button>
        </div>

        <template v-if="seg === 'dm'">
        <van-field v-model="q" clearable :placeholder="t('dm.search')" class="dm-search" />


        <p v-if="failed" class="notice">{{ t("dm.loadFail") }}</p>

        <!-- 娑堟伅璇锋眰锛氶檶鐢熶汉棣栨潯娑堟伅锛屽悓鎰忔墠杩涘垪琛?-->
        <template v-if="requests.length">
          <div class="dm-sec">
            <span class="sec-label">{{ t("dm.requests") }}</span>
            <span class="notif-count">{{ requests.length }}</span>
          </div>
          <div v-for="c in requests" :key="'r' + c.conv_id" class="dm-row req">
            <n-avatar round :size="38" class="post-avatar clickable" :title="t('dm.viewHome')" :src="avatarUrlFor(c.other_id) || undefined" @click.stop="goUser(c.other_id)"><template v-if="!avatarUrlFor(c.other_id)" #default>{{ (c.nickname || "?").slice(0, 1).toUpperCase() }}</template><template v-else #fallback>{{ (c.nickname || "?").slice(0, 1).toUpperCase() }}</template></n-avatar>
            <div class="dm-row-body">
              <div class="dm-row-top">
                <b class="dm-name">{{ c.nickname }}</b>
                <span class="sub dm-time">{{ when(c.last_message_at || c.created_at) }}</span>
              </div>
              <p v-if="c.hit" class="sub dm-hit">{{ c.hit.snippet }}<template v-if="c.hit.count > 1"> 路 {{ t("dm.searchHit", { n: c.hit.count }) }}</template></p>
              <p v-else class="sub dm-preview">{{ previewText(c.last_preview, t) }}</p>
              <div class="dm-req-acts">
                <button class="dm-act primary" @click="acceptReq(c)">{{ t("dm.accept") }}</button>
                <button class="dm-act" @click="rejectReq(c)">{{ t("dm.reject") }}</button>
              </div>
            </div>
          </div>
        </template>

        <template v-if="normal.length">
          <!-- 轮490：会话标题这一行的最右边放「全部已读」。
               只在真有未读时出现 —— 一颗点了没反应的按钮比没有更糟；
               点完未读清空，它就自己消失，这就是最直接的「做完了」反馈。 -->
          <div class="dm-sec">
            <span class="sec-label">{{ t("dm.conversations") }}</span>
            <button
              v-if="pendingUnread.length || allReadNote"
              type="button" class="dm-sec-act"
              :class="{ 'is-ok': allReadNote === 'ok', 'is-fail': allReadNote === 'fail' }"
              :disabled="allReadBusy || !pendingUnread.length"
              :title="t('dm.markAll')"
              @click.stop="markAllRead">
              {{ allReadBusy ? t("dm.markAllBusy")
                : allReadNote === "ok" ? t("dm.markAllDone")
                : allReadNote === "fail" ? t("dm.markAllFail")
                : t("dm.markAll") }}
            </button>
          </div>
          <!-- 杞?197锛氱敤鎴风偣鍗曗€斺€旀挙鎺夊井淇″紡宸︽粦锛堣疆 190 鐨?SwipeCell锛夛紝鎿嶄綔鍏ㄨ蛋 鈰?鑿滃崟
           * 锛堟墦寮€ / 鍏嶆墦鎵?/ 闅愯棌浼氳瘽 / 鎷夐粦锛屾湰鏉ュ氨鍦ㄩ噷闈級锛屾仮澶嶄互鍓嶇殑绾鏍峰紡 -->
          <div
            v-for="c in normal" :key="c.conv_id"
            class="dm-row" :class="{ on: String(c.conv_id) === String(activeId), press: String(c.conv_id) === String(pressedId) }"
            @touchstart.passive="onRowPress(c.conv_id)"
            @mousedown="onRowPress(c.conv_id)"
            @click="openConv(c.conv_id)">
            <n-avatar round :size="38" class="post-avatar clickable" :title="t('dm.viewHome')" :src="avatarUrlFor(c.other_id) || undefined" @click.stop="goUser(c.other_id)"><template v-if="!avatarUrlFor(c.other_id)" #default>{{ (c.nickname || "?").slice(0, 1).toUpperCase() }}</template><template v-else #fallback>{{ (c.nickname || "?").slice(0, 1).toUpperCase() }}</template></n-avatar>
            <div class="dm-row-body">
            <div class="dm-row-top">
              <b class="dm-name">{{ c.nickname }}</b>
              <!-- 杞?238 路 鍏嶆墦鎵版爣鏀瑰井淇″紡锛氬皬鐏版爣缁濆瀹氫綅鍦ㄦ椂闂村乏渚э紙鏃犳枃瀛椼€佷笉鍙備笌 baseline
               * 瀵归綈 鈥斺€?svg 娌℃湁鏂囧瓧鍩虹嚎锛岃繘 flex 琛屼細鎶婃暣琛屾拺楂橀敊浣嶏紝瀹炴祴 21px鈫?4px锛?-->
              <span class="sub dm-time" :class="{ 'has-mute': c.muted }">
                <svg v-if="c.muted" class="dm-muted-ico" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" />
                  <path d="M16 9.8l4.4 4.4M20.4 9.8L16 14.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none" />
                </svg>
                {{ when(c.last_message_at || c.created_at) }}
              </span>
            </div>
            <p v-if="c.hit" class="sub dm-hit">{{ c.hit.snippet }}<template v-if="c.hit.count > 1"> 路 {{ t("dm.searchHit", { n: c.hit.count }) }}</template></p>
            <p v-else class="sub dm-preview">
              {{ previewText(c.last_preview, t) }}
            </p>
            </div>
            <span v-if="rowUnread(c)" class="dm-badge">{{ rowUnread(c) > 99 ? "99+" : rowUnread(c) }}</span>
            <!-- 免打扰会话：不亮数字，只留一个无数字灰点（有未读但不催你） -->
            <i v-else-if="c.muted && Number(c.unread) > 0" class="dm-quiet-dot" :title="t('dm.mutedPending', { n: c.unread })"></i>
            <button class="dm-more" :title="t('dm.more')" @click.stop="toggleRowMenu($event, c.conv_id)">⋯</button>
            <div v-if="menuFor === String(c.conv_id)" class="dm-menu" :class="{ up: menuUp }">
              <button class="dm-menu-item" @click.stop="openConv(c.conv_id); menuFor = ''">{{ t("dm.open") }}</button>
              <button class="dm-menu-item" @click.stop="toggleMute(c)">{{ c.muted ? t("dm.unmute") : t("dm.mute") }}</button>
              <button class="dm-menu-item" @click.stop="hideConv(c)">{{ t("dm.hide") }}</button>
              <button class="dm-menu-item danger" @click.stop="toggleBlock(c)">{{ t("dm.block") }}</button>
              <div class="dm-menu-sep" role="separator"></div>
              <button class="dm-menu-item dm-menu-close" @click.stop="menuFor = ''">{{ t("common.close") }}</button>
            </div>
          </div>
        </template>

        <!-- 杞?276锛堢敤鎴锋媿鏉匡級锛氫細璇濆垪琛ㄥ簳閮ㄩ鏋堕€€褰癸紙涓庢殩蹇冨杞?272 鍚屽彛寰勶細鍘诲睍绀虹暀鏈哄埗锛夈€?
             convsLoaded 浠嶄繚鐣欎綔銆岀┖鎬佸彲淇°€嶉棬鎺э紱澶辫触鎬佺殑涓婃柟 loadFail 鎻愮ず + 3s 蹇€熼噸璇曚笉鍙樸€?-->

        <p v-if="!normal.length && !requests.length && convsLoaded && !failed" class="sub dm-empty">{{ q.trim() ? t("dm.searchEmpty", { q: q.trim() }) : t("dm.empty") }}</p>
        </template>
        <!-- 杞?142 路 婕傛祦鐡舵锛氭闈?= 琛屽紡鍒楄〃锛堥€変腑浜ょ粰涓垪 BottleChat锛夛紱鎵嬫満 = 鍘熷崱鐗囧紡 BottleRecords锛堥浂鏀瑰姩锛?-->
        <BottleChatList
          v-else-if="seg === 'bottle' && !isMobileNav" ref="bottleList"
          :selected-id="bottleRow && bottleRow.id" @select="pickBottle" @pending="onBottlePending"
          @removed="onBottleRemoved" />
        <BottleRecords v-else-if="seg === 'bottle'" @open="openBottleChat" @pending="onBottlePending" />
        <NotificationsView v-else-if="seg === 'notif'" class="dm-seg-notif" />
      </aside>

      <!-- 涓垪锛堣疆 142锛夛細妗岄潰銆屾紓娴佺摱銆嶆 = 鐙珛鑱婂ぉ妗?BottleChat锛堜笌浼氳瘽娈电殑 dm-thread 鍚勮嚜鍗曞紑锛?-->
      <BottleChat
        v-if="!isMobileNav && seg === 'bottle'"
        :letter="bottleRow" :me-id="meId" :peer-name="bottleName" :drafts="vacDrafts"
        :page-active="!wasDeactivated"
        @accepted="onBottleAccepted" @decided="onBottleDecided" @peer="onBottlePeer"
        @draft="onVacDraft">
        <!-- 杞?143 路 婕傛祦鐡惰亰澶╁ご鍙充笂瑙掑悓鏍峰嚭銆屸€︺€嶈彍鍗曪紙鍐呭涓庝細璇濆ご鍚屼竴浠斤細curPeer 闅忔鑱斿姩锛?-->
        <template #headtools>
          <div v-if="!isMobileNav" class="dm-head-tools">
            <button type="button" class="dm-more dm-head-more" :title="t('dm.more')" :aria-expanded="headMenu" @click="headMenu = !headMenu">⋯</button>
            <div v-if="headMenu" class="dm-menu dm-head-menu">
              <button v-if="curPeer.user_id" class="dm-menu-item" @click="headMenu = false; goUser(curPeer.user_id)">{{ t("dm.viewHome") }} ←</button>
              <template v-if="curPeer.conv_id">
                <button class="dm-menu-item" @click="headMenu = false; mutePeer()">{{ curPeer.muted ? t("dm.unmute") : t("dm.mute") }}</button>
                <button class="dm-menu-item danger" @click="headMenu = false; blockPeer()">{{ curPeer.blocked ? t("dm.unblock") : t("dm.block") }}</button>
              </template>
              <p v-else class="sub dm-menu-note">{{ t("bottle.noChatYet") }}</p>
              <div class="dm-menu-sep" role="separator"></div>
              <button class="dm-menu-item dm-menu-close" @click="headMenu = false">{{ t("common.close") }}</button>
            </div>
          </div>
        </template>
      </BottleChat>

      <!-- 涓垪锛氬綋鍓嶄細璇濓紙鎵嬫満褰㈡€?= 寰俊寮忕嫭绔嬭亰澶╅〉锛屽甫杩斿洖锛?-->
      <section v-else v-show="!isMobileNav || (!!activeId && paneReady)" class="card dm-thread" :class="{ 'dm-thread--in': threadIn }">
        <template v-if="activeId && paneReady">
          <!-- 杞?334锛堢敤鎴锋媿鏉匡級锛氫細璇濇銆岃亰澶╁ご + 娑堟伅娴?+ 杈撳叆鍖恒€嶆暣娈典氦缁欑粍浠讹紝
               杩炲ご閮ㄥ拰杈撳叆妗嗕篃鐢ㄧ粍浠惰嚜宸辩殑锛堜笉鍐嶆墜鍐欓偅涓ゅ潹锛夈€傛棫鐗堥偅濂楀彧鍦ㄩ潪 vac 鏃跺厹搴曘€?
               鏍峰瓙浠嶆寜鏃х増锛歍HEME_CSS 閲屽ご閮?缁嗚櫄绾?+ 40px 澶村儚 + 鈰?鑿滃崟锛?
               杈撳叆鍖?铏氱嚎 + 鑳跺泭杈撳叆妗?+ 鐝婄憵銆屽彂閫併€嶏紝瑙?DmVacChat.vue銆?-->
          <DmVacChat
            v-if="vacUi && seg === 'dm'"
            ref="vacChat"
            :convs="vacConvs"
            :messages="msgs"
            :room-id="activeId"
            :me-id="meId"
            :peer-name="vacPeerName"
            :loading-messages="loadingMsgs"
            :can-type="canType"
            :gate="gateText"
            :err="sendErr"
            :placeholder="composePlaceholder"
            :show-back="isMobileNav"
            :peer="activeConv || meta || null"
            :drafts="vacDrafts"
            @send="onVacSend"
            @recall="onVacRecall"
            @load-more="onVacLoadMore"
            @room-action="onVacRoomAction"
            @resend="onVacResend"
            @draft="onVacDraft"
            @back="backToList" />

          <template v-else>
          <!-- 杞?334锛氫笂闈㈤偅娈垫棫鑱婂ぉ澶?娑堟伅娴?杈撳叆鍖哄彧鍦ㄩ潪 vac 鏃剁敤锛坴-else锛?-->
          <header class="dm-thread-head">
            <button v-if="isMobileNav" class="dm-thread-back" @click="backToList">←</button>
            <n-avatar v-if="!isMobileNav" round :size="40" class="dm-msg-avatar" :src="avatarUrlFor((activeConv && activeConv.other_id) || (meta && meta.other_id)) || undefined">{{ peerInitial }}<template #fallback>{{ peerInitial }}</template></n-avatar>
            <b class="dm-name dm-peer-link" :title="t('dm.viewHome')" @click="goUser(activeConv && activeConv.other_id)">{{ title || t("dm.someone") }}</b>
            <!-- 杞?244锛堢敤鎴锋媿鏉匡級锛氳亰澶╁ご閮?*涓嶆寕**鍏嶆墦鎵板皬鐏版爣 鈥斺€?寰俊鍙ｅ緞锛氬厤鎵撴壈鏍囧織鍙嚭鐜板湪
             * 浼氳瘽鍒楄〃琛岋紙鏃堕棿宸︿晶鐨勫皬鐏版爣锛岃涓婃柟 .dm-time.has-mute锛夛紝鑱婂ぉ澶撮儴灏辨槸鏄电О鏈韩锛?
             * 杩涘埌鑱婂ぉ閲岃繕椤剁潃鏍囧織鏄浣欑殑锛堢敤鎴峰疄娴嬨€屽厤鎵撴壈鏍囧織鍑虹幇鍦ㄨ亰澶╂涔嬩腑锛岃繖涓嶅銆嶏級銆?-->
            <n-tag v-if="activeConv && activeConv.accepted === false" round size="small" :bordered="false" class="soft-tag">
              {{ t("dm.requestTag") }}
            </n-tag>
            <span class="dm-spacer"></span>
            <!-- 杞?143 路 鍙充笂瑙掋€屸€︺€嶈彍鍗曪細鍘熷彸鍒楄祫鏂欏崱鍐呭锛堢湅涓婚〉 / 闈欓煶 / 鎷夐粦 / 鏃犱細璇濊鏄庯級杩佸埌杩?-->
            <div v-if="!isMobileNav" class="dm-head-tools">
              <button type="button" class="dm-more dm-head-more" :title="t('dm.more')" :aria-expanded="headMenu" @click="headMenu = !headMenu">⋯</button>
              <div v-if="headMenu" class="dm-menu dm-head-menu">
                <button v-if="curPeer.user_id" class="dm-menu-item" @click="headMenu = false; goUser(curPeer.user_id)">{{ t("dm.viewHome") }} ←</button>
                <template v-if="curPeer.conv_id">
                  <button class="dm-menu-item" @click="headMenu = false; mutePeer()">{{ curPeer.muted ? t("dm.unmute") : t("dm.mute") }}</button>
                  <button class="dm-menu-item danger" @click="headMenu = false; blockPeer()">{{ curPeer.blocked ? t("dm.unblock") : t("dm.block") }}</button>
                </template>
                <!-- 婕傛祦鐡惰繕娌″缓浼氳瘽锛氭病鏈夊彲闈欓煶/鎷夐粦鐨勪細璇濓紝濡傚疄璇存槑锛堜笉鎽嗙┖鎸夐挳锛?-->
                <p v-else-if="seg === 'bottle'" class="sub dm-menu-note">{{ t("bottle.noChatYet") }}</p>
                <div class="dm-menu-sep" role="separator"></div>
                <button class="dm-menu-item dm-menu-close" @click="headMenu = false">{{ t("common.close") }}</button>
              </div>
            </div>
          </header>

          <!-- 娑堟伅娴侊紙鏃х増 路 浠呴潪 vac锛?-->
          <div ref="listEl" class="dm-scroll" :style="{ visibility: listRevealed ? 'visible' : 'hidden' }"
            @scroll.passive="onScrollTop"
            @touchstart.passive="onListTouch" @wheel.passive="onListWheel">
            <div class="dm-topmore">
              <button v-if="hasMore && oldestId" class="dm-act" :disabled="loadingMsgs"
                @click="loadMessages(activeId, { before: oldestId })">{{ t("dm.older") }}</button>
              <span v-else class="sub">{{ t("dm.reachTop") }}</span>
            </div>

            <template v-for="it in flow" :key="it.key">
              <div v-if="it.type === 'day'" class="dm-day"><span>{{ dayLabel(it.ts) }}</span></div>
              <div v-else class="dm-line" :class="{ mine: it.msg.sender === meId }">
                <n-avatar v-if="it.msg.sender !== meId" round :size="30" class="dm-msg-avatar" :src="avatarUrlFor(it.msg.sender) || undefined"><template v-if="!avatarUrlFor(it.msg.sender)" #default>{{ peerInitial }}</template><template v-else #fallback>{{ peerInitial }}</template></n-avatar>
                <div class="dm-msg-col">
                  <div class="dm-bubble" :class="{ recalled: it.msg.recalled, failed: it.msg.failed }">
                    <p v-if="it.msg.recalled" class="dm-recalled">{{ t("dm.recalled") }}</p>
                    <p v-else class="dm-text">{{ it.msg.body }}</p>
                  </div>
                  <span class="dm-stamp">
                    <span v-if="it.msg.failed" class="dm-err">{{ t("dm.sendFailed") }}</span><template v-else-if="!it.msg.pending">{{ clock(it.msg.created_at) }}</template>
                    <button
                      v-if="canRecall(it.msg, meId) && !it.msg.pending"
                      class="dm-recall" :title="t('dm.recall')"
                      @click="recall(it.msg)">{{ t("dm.recall") }}</button>
                  </span>
                </div>
              </div>
            </template>

            <p v-if="!flow.length && !loadingMsgs" class="sub dm-empty">{{ t("dm.noMessages") }}</p>
          </div>

          <!-- 杈撳叆鍖?-->
          <footer class="dm-compose">
            <p v-if="!canType" class="notice dm-gate">
              {{ blockedByMe ? t("dm.gateBlockedByMe") : t("dm.gateRequest") }}
            </p>
            <template v-else>
              <!-- 杞?238锛氭闈㈤敭浣嶈鏄庡彧鐣欐闈紙鎵嬫満閿洏娌℃湁 Shift+Enter锛岀函鍗犲湴鏂癸級 -->
              <p v-if="!isMobileNav" class="sub dm-hint">{{ t("dm.hint") }}</p>
              <p v-if="sendErr" class="sub dm-err">{{ sendErr }}</p>
              <!-- 杞?68锛氬井淇″紡杈撳叆琛屸€斺€斿崟琛岃捣銆侀殢鍐呭闀块珮锛?~6 琛岋級锛屽彂閫侀敭鍦ㄦ鍙充晶 -->
              <div class="dm-input-row" ref="composeRow">
                <van-field
                  v-model="body" type="textarea" rows="1" autosize :maxlength="2000"
                  :placeholder="isMobileNav ? t('dm.placeholderMobile') : t('dm.placeholder')"
                  @keydown.enter.exact.prevent="send" />
                <n-button type="primary" round size="small" class="dm-send-btn" :disabled="!body.trim()" @click="send">
                  {{ t("dm.send") }}
                  <!-- 杞?316锛氫笉鍐嶆湁銆屽彂閫佷腑銆嶈浆鍦堚€斺€斿井淇″紡锛屽彂鍑哄幓灏卞畬浜嬶紱澶辫触鍦ㄩ偅鏉℃秷鎭鍐呮爣绾?-->
                </n-button>
              </div>
            </template>
          </footer>
          </template>
        </template>

        <p v-else class="sub dm-empty">{{ t("dm.pickOne") }}</p>
      </section>

    </div>
  </div>
</template>
