/* App 壳测试（T5）：底部 TabBar / 双形态切换 / i18n tab 键成对
 *   node tools/app-shell-test.mjs
 * 口径：静态断言关键接线（组件存在、条件渲染、桌面锚点保留）+ i18n 运行时渲染。 */
import { readFileSync } from "node:fs";
import { t, i18n, messages } from "../src/i18n.js";

const out = [];
let pass = 0, fail = 0;
function ok(name, cond, extra = "") {
  out.push((cond ? "PASS  " : "FAIL  ") + name + (cond ? "" : "  → " + extra));
  cond ? pass++ : fail++;
}
const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");

/* ─── ① TabBar 组件 ─── */
const tb = read("src/components/TabBar.vue");
ok("T1 TabBar 存在且含 4 Tab 路由",
  ['path: "/"', '"/community"', '"/messages"', '"/profile"'].every((s) => tb.includes(s)));
ok("T2 TabBar 含 ＋ 弹层与两瓣入口", tb.includes("tabbar-sheet") && tb.includes("composeBottle") && tb.includes("composePost"));
ok("T3 消息红点接 badgeStore（dm+requests）", tb.includes("badge.dm + badge.requests"));
ok("T4 投瓶走 /?tab=bottle（T6 三联消费）", tb.includes('query: { tab: "bottle" }'));

/* ─── ② App.vue 双形态接线（桌面零变化锚点） ─── */
const app = read("src/App.vue");
ok("T5 TabBar 仅 isMobileNav 渲染（聊天页让位）", app.includes('<TabBar v-if="isMobileNav'));
ok("T6 SideRails 桌面专属（isMobileNav 时隐藏）", app.includes('<SideRails v-if="!isMobileNav"'));
ok("T7 桌面顶栏 NAV 数组原样保留（零变化锚点）", app.includes("const NAV = [") && app.includes('exact-active-class="active"'));
ok("T8 shell 挂 mobile-nav 形态类", app.includes("shell--mobile-nav"));

/* ─── ③ i18n：tab 组键成对 + 运行时渲染 ─── */
const keys = ["tab.home", "tab.community", "tab.messages", "tab.profile",
  "tab.composeBottle", "tab.composeBottleSub", "tab.composePost", "tab.composePostSub"];
for (const loc of ["en", "zh"]) {
  const grp = messages[loc].tab || {};
  const missing = keys.map((k) => k.split(".")[1]).filter((k) => !grp[k]);
  ok(`T9 ${loc} tab 组 8 键齐全`, missing.length === 0, missing.join(","));
}
i18n.locale = "en";
ok("T10 en 渲染不冒 key", keys.every((k) => t(k) !== k));
i18n.locale = "zh";
ok("T11 zh 渲染不冒 key", keys.every((k) => t(k) !== k));
ok("T12 zh tab.home=首页（区别于 nav.home=今天）", t("tab.home") === "首页" && t("nav.home") === "今天");
i18n.locale = "en";

/* ─── ④ 样式与 safe-area ─── */
const css = read("src/style.css");
ok("T13 TabBar 样式含 safe-area 与桌面隔离",
  css.includes("env(safe-area-inset-bottom") && css.includes(".shell--mobile-nav .topbar") && css.includes(".tabbar {"));

/* ─── ⑤ 消息页微信式（手机：列表页 ↔ 聊天页 二选一，聊天页整屏） ─── */
const mv = read("src/views/MessagesView.vue");
const cmt = read("src/views/CommunityView.vue");
ok("T14 聊天页整屏样式（shell--chat + 100dvh + 内部滚动）",
  css.includes(".shell--mobile-nav.shell--chat .dm-page") && css.includes("height: 100dvh")
  && css.includes(".shell--mobile-nav.shell--chat .dm-scroll"));
ok("T15 聊天页隐藏 TabBar 与页脚（shell--chat 形态类）",
  app.includes("'shell--chat': inChat") && app.includes('<TabBar v-if="isMobileNav && !inChat"')
  && css.includes(".shell--mobile-nav.shell--chat .footer { display: none; }"));
ok("T16 手机形态 push / 桌面形态 replace（历史不污染、返回键可用）",
  mv.includes("if (isMobileNav.value) {") && mv.includes('router.push({ name: "messages"')
  && mv.includes('router.replace({ name: "messages"'));
ok("T17 ← 返回钮走 backToList（非硬跳 /messages）", mv.includes('class="dm-thread-back" @click="backToList"'));
ok("T18 回到列表时清空当前会话（activeId='' + msgs=[]）",
  mv.includes('activeId.value = "";') && mv.includes("msgs.value = [];"));

/* ─── ⑥ 安卓系统返回键（T9 提前） ─── */
ok("T19 系统返回键：二级页/聊天页回退 + 根视图最小化",
  app.includes('addListener("backButton"') && app.includes("minimizeApp") && app.includes("const ROOT_VIEWS = ["));

/* ─── ⑦ 手机聊天页横向撑满（真机回归：曾表现为「只占左侧一条」） ─── */
const chatWrap = (css.match(/\.shell--mobile-nav\.shell--chat \.dm-wrap \{[\s\S]*?\}/) || [""])[0];
const chatThread = (css.match(/\.shell--mobile-nav\.shell--chat \.dm-thread \{[\s\S]*?\}/) || [""])[0];
ok("T20 手机聊天卡横向撑满（flex column 必须重置 align-items:stretch）",
  /align-items:\s*stretch/.test(chatWrap) && /width:\s*100%/.test(chatWrap)
  && /width:\s*100%/.test(chatThread), chatWrap.replace(/\s+/g, " "));
ok("T21 手机聊天页隐藏桌面提示（dm-hint）+ 发送键靠右",
  css.includes(".shell--mobile-nav.shell--chat .dm-hint { display: none; }")
  && css.includes(".shell--mobile-nav.shell--chat .dm-send-row { justify-content: flex-end; }"));

ok("T22 手机输入框用短占位符（桌面仍保留 Enter/Shift 说明）",
  mv.includes("isMobileNav ? t('dm.placeholderMobile') : t('dm.placeholder')")
  && messages.en.dm.placeholderMobile === "Write something…"
  && messages.zh.dm.placeholderMobile === "写点什么…"
  && messages.en.dm.placeholder.includes("Shift+Enter"));

/* ─── ⑧ 消息 Tab 内分栏（T7：私信 | 通知，小红书同款） ─── */
ok("T23 分栏条仅手机形态渲染，桌面零变化（桌面 template 恒渲染、通知组件不挂）",
  mv.includes('<div v-if="isMobileNav" class="dm-seg" role="tablist">')
  && mv.includes('v-if="!isMobileNav || seg === \'dm\'"')
  && mv.includes("v-else-if=\"seg === 'notif'\"")
  && mv.includes("seg.value = \"dm\";"));
ok("T24 消息Tab三段（手机端 1：会话|漂流瓶|通知）+ 红点挂分段 + 通知复用 NotificationsView",
  mv.includes("defineAsyncComponent(() => import(\"./NotificationsView.vue\"))")
  && mv.includes("const dmBadge = computed(() => badge.dm + badge.requests);")
  && mv.includes('v-if="badge.notif" class="notif-count"')
  && mv.includes("seg === 'bottle'")
  && mv.includes('<BottleRecords v-else-if="seg === \'bottle\'" @open="openBottleChat" />')
  && mv.includes('<BottleRecords v-if="!isMobileNav" @open="openBottleChat" />')
  && messages.en.tab.segDm === "Chats" && messages.en.tab.segBottle === "Bottle" && messages.en.tab.segNotif === "Alerts"
  && messages.zh.tab.segDm === "会话中心" && messages.zh.tab.segBottle === "漂流瓶" && messages.zh.tab.segNotif === "通知"
  /* 手机端 1（返工）：分栏顺序 = 左漂流瓶 · 中会话中心 · 右通知（按分栏按钮的点击绑定取序，避免被 class 绑定误判） */
  && mv.indexOf("@click=\"seg = 'bottle'\"") < mv.indexOf("@click=\"seg = 'dm'\"")
  && mv.indexOf("@click=\"seg = 'dm'\"") < mv.indexOf("@click=\"seg = 'notif'\""));
ok("T25 通知段避「卡中卡」（只去装饰、保留内缩，仅手机形态 + 仅通知段）",
  mv.includes("'dm-list--seg': isMobileNav && seg === 'notif'")
  && css.includes(".shell--mobile-nav .dm-list--seg {")
  && /\.dm-list--seg \{[\s\S]*?background: transparent/.test(css)
  && /\.dm-list--seg \{[\s\S]*?border-color: transparent/.test(css)
  && !/\.dm-list--seg \{[\s\S]*?padding: 0;/.test(css)
  && css.includes(".shell--mobile-nav .dm-seg-notif .notif-back { display: none; }"));
ok("T26 系统返回键先退内部层级（拦截栈：通知段 → 私信段，再回退路由/最小化）",
  read("src/stores/uiStore.js").includes("export function pushBack(")
  && read("src/stores/uiStore.js").includes("export function runBack()")
  && read("src/stores/uiStore.js").includes("export function popBack(")
  && app.includes("if (runBack()) return;")
  && mv.includes("function segBack()") && mv.includes("pushBack(segBack);")
  && mv.includes("popBack(segBack);") && mv.includes('if (seg.value === "dm") return false;'));
ok("T27 我的 Tab 整合（手机形态补钱包金币 = 桌面顶栏口径；桌面零变化）",
  read("src/views/ProfileView.vue").includes('v-if="isMobileNav" round :bordered="false" class="soft-tag"')
  && read("src/views/ProfileView.vue").includes("{{ wallet.coins }}")
  && read("src/views/ProfileView.vue").includes('import { isMobileNav } from "../stores/uiStore.js"'));
const pet = read("src/views/PetView.vue");
ok("T28 共有1 宠物睡着了送行给「弹窗」提示（以前角落一句小字没人看 → sleepWarn 弹窗 + 知道啦）",
  read("src/views/PetView.vue").includes('t("adventure.sleepingBlock"')
  && read("src/views/PetView.vue").includes("activePet.value.sleeping")
  && read("src/views/PetView.vue").includes("sleepWarn.value = true;")
  && read("src/views/PetView.vue").includes('class="adopt-modal sleep-modal"')
  && read("src/views/PetView.vue").includes('t("adventure.sleepingTitle"')
  && read("src/views/PetView.vue").includes('t("common.gotIt")')
  && pet.includes(".sleep-modal {"));
ok("T29 共有6 我的食谱回原版卡片（菜格 + ♥用心度 + 可删）+ 标题行「去厨房 →」跳 /pet?tab=book",
  read("src/views/ProfileView.vue").includes('class="my-posts-link" to="/pet?tab=book"')
  && read("src/views/ProfileView.vue").includes("const HEART =")
  && read("src/views/ProfileView.vue").includes("{{ HEART }} {{ d.effort }}%")
  && read("src/views/ProfileView.vue").includes('@click="removeDish(d.id)"')
  && !read("src/views/ProfileView.vue").includes('class="card book-card"')
  && pet.includes('["care", "adv", "paint", "book"].includes(qTab)'));
ok("T30 手机端9 Tab 纯文字（无图标）+ 选中放大（小红书式）",
  !read("src/components/TabBar.vue").includes("tab-ico")
  && css.includes(".tab-item.active .tab-label { transform: scale(1.18); }"));
ok("T31 手机端5 今日联去宠物卡 + 毛玻璃退场 + 轨道高度跟当前联（下拉无空白）",
  read("src/components/TodayPane.vue").includes('<section v-if="!isMobileNav" class="hero">')
  && css.includes(".shell--mobile-nav .card,")
  && css.includes(".shell--mobile-nav .home-chips {")
  && read("src/views/HomeView.vue").includes("trackH")
  && read("src/views/HomeView.vue").includes("setPane(HOME_PANES[idx.value - 1].k)")
  && read("src/views/HomeView.vue").includes("setPane(HOME_PANES[idx.value + 1"));
ok("T32 手机端4 捞到的瓶子居中弹出（bottle-tray fixed 居中 + 压暗背景）",
  css.includes(".shell--mobile-nav .bottle-tray {")
  && css.includes("translate(-50%, -50%)")
  && css.includes("@keyframes bottle-pop"));
ok("T33 长词断行护栏（乱码长词不再撑爆 grid 轨道：minmax(0,1fr)+min-width:0+anywhere+shell clip）",
  css.includes(".dm-wrap { grid-template-columns: minmax(0, 1fr); }")
  && css.includes(".dm-wrap > * { min-width: 0; max-width: 100%; }")
  && css.includes(".bottle-record-text { overflow-wrap: anywhere; }")
  && /\.shell \{[^}]*overflow-x: clip/.test(css)
  && /\.dm-text \{[^}]*overflow-wrap: anywhere/.test(css)
  && /\.notif-quote \{[\s\S]*?overflow-wrap: anywhere/.test(css));
ok("T34 冻结过渡自愈（后台/遮挡时路由过渡停在 opacity:0 → 回前台整页空白）：可见性恢复+路由后延迟清扫 fade 类",
  app.includes("function scrubStuckFade()")
  && app.includes('document.addEventListener("visibilitychange"')
  && app.includes("setTimeout(scrubStuckFade, 120)")
  && app.includes("scrubTimer = setTimeout(scrubStuckFade, 700)")
  && app.includes('querySelectorAll(".fade-enter-active, .fade-leave-active, .fade-enter-from, .fade-leave-to")'));

/* ─── 用户反馈返工（2026-09-20 第二批） ─── */
const cv = read("src/views/ComposeView.vue");
/* ─── ⑨ T10 · 手机端「＋ 发帖」独立页：整屏编辑器（不能再是默认款 textarea） ─── */
ok("T35 /compose 归到 shell--chat 形态（TabBar + 页脚让位，自己吃满 100dvh）",
  /const inChat = computed\(\(\) => isMobileNav\.value[\s\S]{0,160}route\.name === "compose"\)/.test(app)
  && app.includes('<TabBar v-if="isMobileNav && !inChat"')
  && css.includes(".shell--mobile-nav.shell--chat .footer { display: none; }"));
ok("T36 发帖页有真正的排版样式（顶栏 / 卡片 / 大输入框 / 动作条，不再是光秃 textarea）",
  cv.includes(".compose-head {")
  && cv.includes(".compose-area {")
  && cv.includes(".compose-bar {")
  && cv.includes(".compose-tool {")
  && cv.includes(".compose-page {")
  && cv.includes(".compose-back")
  && cv.includes("min-height: 100dvh;")
  && cv.includes("env(safe-area-inset-bottom")
  && /\.compose-area \{[\s\S]*?flex: 1 1 auto/.test(cv)
  && cv.includes("html[data-theme=\"night\"] .compose-card"));
ok("T37 发帖输入框硬限制 + 字数（与 wall.js 的 1000 字同口径）",
  cv.includes("const POST_MAX = 1000;")
  && cv.includes(':maxlength="POST_MAX"')
  && cv.includes("{{ draft.length }}/{{ POST_MAX }}"));
ok("T38 回应按钮涟漪关掉（连续点击不再留一圈颜色阴影）+ 按钮不停在 :focus 态",
  css.includes(".react-row .n-button .n-button-base-wave { display: none !important; }")
  && css.includes(".react-row .n-button,")
  && cmt.includes(':focusable="false"'));
ok("T39 共有5 二级评论回复框就地渲染（replyRp + 只在被回复那条下面开框 + 一级框让位）",
  cmt.includes("const replyRp = ref({});")
  && cmt.includes("function openReplyTo(p, cm, rp)")
  && cmt.includes("replyRp.value = { ...replyRp.value, [repKey(p, cm)]: rp.id };")
  && cmt.includes("v-if=\"replyRpOf(p, cm) === rp.id")
  && cmt.includes(":id=\"'repbox-' + repKey(p, cm) + ':' + rp.id\"")
  && cmt.includes("function repInputSel(p, cm, rp = null)")
  && cmt.includes("delete nextTo[k];")
  && cmt.includes("class=\"cmt-input cmt-input-rep-in\"")
  && css.includes(".cmt-input-rep-in"));

out.push("");
out.push(`TOTAL ${pass + fail}  PASS ${pass}  FAIL ${fail}`);
console.log(out.join("\n"));
process.exit(fail ? 1 : 0);
