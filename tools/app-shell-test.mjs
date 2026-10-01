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
ok("T15 聊天页隐藏 TabBar（shell--chat 形态类；页脚轮 57 已整体移除；轮108 起叠 tabbarSuppressed）",
  app.includes("'shell--chat': inChat") && app.includes('<TabBar v-if="isMobileNav && !inChat && !tabbarSuppressed"'));
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
ok("T21 手机聊天页隐藏桌面提示（dm-hint）+ 微信式输入行（发送键在框旁,轮 68）",
  css.includes(".shell--mobile-nav.shell--chat .dm-hint { display: none; }")
  && css.includes(".dm-input-row { display: flex; align-items: flex-end;")
  && mv.includes('class="dm-input-row"'));

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
ok("T24 消息Tab三段（手机端：漂流瓶|会话|通知）+ 红点挂分段 + 通知复用 NotificationsView + 桌面列表不再嵌记录（轮134 移除）",
  mv.includes("defineAsyncComponent(() => import(\"./NotificationsView.vue\"))")
  && mv.includes("const dmBadge = computed(() => badge.dm + badge.requests);")
  && mv.includes('v-if="badge.notif" class="notif-count"')
  && mv.includes("seg === 'bottle'")
  && mv.includes('<BottleRecords v-else-if="seg === \'bottle\'" @open="openBottleChat" />')
  && !mv.includes('<BottleRecords v-if="!isMobileNav"')   /* 轮 134：桌面列表已不嵌记录，反向断言钉住 */
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
ok("T29 共有6 我的食谱回原版卡片（菜格 + ♥用心度 + 可删）+ 「去厨房」:手机深链首页宠物联食谱(/?tab=pet&petTab=book)/桌面保持 /pet?tab=book（轮54）",
  read("src/views/ProfileView.vue").includes("petTab: 'book'")
  && read("src/views/ProfileView.vue").includes("'/pet?tab=book'")
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
  /* 轮 139：过渡名 fade → page 后清了「两组类名一起扫」，旧断言只钉 fade 组 → 同步 */
  && /querySelectorAll\("\.fade-enter-active[\s\S]{0,180}\.page-leave-to"\)/.test(app));

/* ─── 用户反馈返工（2026-09-20 第二批） ─── */
const cv = read("src/views/ComposeView.vue");
/* ─── ⑨ T10 · 手机端「＋ 发帖」独立页：整屏编辑器（不能再是默认款 textarea） ─── */
ok("T35 /compose 归到 shell--chat 形态（TabBar 让位，自己吃满 100dvh）",
  /const inChat = computed\(\(\) => isMobileNav\.value[\s\S]{0,160}route\.name === "compose"\)/.test(app)
  && app.includes('<TabBar v-if="isMobileNav && !inChat && !tabbarSuppressed"'));
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
ok("T39 二级评论回复框就地渲染（replyRp + 只在被回复那条下面开框 + 一级框让位；轮108续3 起仅桌面渲染，手机端回复统一走底部输入条）",
  cmt.includes("const replyRp = ref({});")
  && cmt.includes("function openReplyTo(p, cm, rp)")
  && cmt.includes("replyRp.value = { ...replyRp.value, [repKey(p, cm)]: rp.id };")
  && cmt.includes('v-if="replyRpOf(p, cm) === rp.id'));

/* ─── 轮 109 · 网页端主评论输入框位置（用户：「放在评论按钮跟浏览次数按钮中间，每条都是，
         app端不改，只改网页端」）─── */
ok("T40 轮109：网页端主评论输入框在「浏览次数」与「评论按钮」之间（卡内常驻、桌面专属；App 端不渲染）",
  cmt.includes('v-if="!isMobileNav && (!p.cloud || signedIn)"')
  && cmt.includes('class="cmt-input cmt-input-top"')
  && cmt.includes(':id="\'cmtmain-\' + cmtKey(p)"')
  && cmt.indexOf('class="post-foot"') < cmt.indexOf("cmt-input-top")
  && cmt.indexOf("cmt-input-top") < cmt.indexOf('class="cmt-toggle"')
  && cmt.includes("sendTopCmt(p)")
  && cmt.includes("#cmtmain-")
  && css.includes(".cmt-input-top {"));
ok("T41 轮108：底部输入条/回复模式下收起 TabBar（tabbarSuppressed 在 uiStore 导出 + App.vue 接线）",
  read("src/stores/uiStore.js").includes("export const tabbarSuppressed = ref(false);")
  && /import \{[^}]*tabbarSuppressed[^}]*\} from "\.\/stores\/uiStore\.js"/.test(app)
  && app.includes('<TabBar v-if="isMobileNav && !inChat && !tabbarSuppressed"'));

/* ─── 轮 110 · 网页端一级评论回复框位置（用户：「把一级评论回复框点击后出现在一级评论下面，
         二级评论上面，你现在是一级评论最下面；二级评论输入框不改；app端不改」）─── */
const iActs1 = cmt.indexOf('class="cmt-acts"');
const iRepBox = cmt.indexOf('class="cmt-input cmt-input-rep"');
const iReps = cmt.indexOf('class="cmt-reps"');
const iRepBoxIn = cmt.indexOf('class="cmt-input cmt-input-rep-in"');
const iToggle = cmt.indexOf('class="replies-toggle"');
ok("T42 轮110：网页端一级回复框在「本评论操作行」之下、「二级回复列表」之上（不再压在整条评论底部）；二级就地框仍在二级列表内",
  iActs1 > -1 && iRepBox > -1 && iReps > -1 && iRepBoxIn > -1 && iToggle > -1
  && iActs1 < iRepBox && iRepBox < iReps && iReps < iRepBoxIn && iRepBoxIn < iToggle
  && cmt.includes('v-if="isReplyOpen(p, cm) && !isMobileNav && !(p.cloud && !signedIn)"')
  && cmt.includes('v-if="replyRpOf(p, cm) === rp.id'));

/* ─── 轮 138 · 桌面左导航展开（方案 A：🐾 = 开关，64 → 212px，行内文字 + 品牌行回首页） ─── */
const sn = read("src/components/SideNav.vue");
const ui = read("src/stores/uiStore.js");
ok("T43 轮138：🐾 从回首页链接改为开关按钮（type=button + aria-expanded + 中英 tooltip）",
  sn.includes('class="sn-logo" type="button"') && sn.includes(':aria-expanded="navOpen"')
  && sn.includes("t(navOpen ? 'nav.collapse' : 'nav.expand')")
  && !sn.includes('<router-link to="/" class="sn-logo"'));
ok("T44 轮138：展开 64 → 212px（= 右栏宽度）+ 每项行内文字 + 品牌行承担回首页",
  sn.includes(".sidenav--open { width: 212px;") && sn.includes('class="sn-label"')
  && sn.includes('to="/" class="sn-brand"') && sn.includes(".sidenav--open .sn-item { width: 100%")
  && sn.includes(".sn-label { display: none;"));
ok("T45 轮138：内容左让位改走 --nav-w（收起 92 / 展开 240）+ 壳挂 shell--nav-open",
  css.includes("--nav-w: 92px") && css.includes(".shell--nav-open { --nav-w: 240px; }")
  && css.includes("margin: 0 0 0 var(--nav-w)") && css.includes("calc(var(--nav-w) +")
  && app.includes("'shell--nav-open': !isMobileNav && navOpen"));
ok("T46 轮138/140：展开态记忆在 localStorage，且**默认展开**（未存过=展开；显式收起才存 0）",
  ui.includes('const NAV_KEY = "wp-nav-open"')
  && ui.includes('export const navOpen = ref(getItem(NAV_KEY) !== "0")')
  && ui.includes("export function toggleNav()") && ui.includes("setItem(NAV_KEY"));
ok("T47 轮138：窄桌面（<1480）展开时会话三栏收两栏（资料卡退场）",
  css.includes(".shell--nav-open .dm-wrap { grid-template-columns: 300px minmax(0, 1fr); }")
  && css.includes(".shell--nav-open .dm-info { display: none; }"));
ok("T48 轮138：nav.expand/collapse 两键 zh/en 成对 + 渲染不冒 key",
  !!(messages.en.nav.expand && messages.en.nav.collapse && messages.zh.nav.expand && messages.zh.nav.collapse)
  && t("nav.expand") !== "nav.expand" && t("nav.collapse") !== "nav.collapse");
ok("T49 轮138：展开动画尊重 prefers-reduced-motion（栏宽/文字动画都关）",
  sn.includes(".sidenav { transition: none !important; }")
  && sn.includes(".sidenav--open .sn-item .sn-label { animation: none !important; }")
  && css.includes("@media (min-width: 900px) and (prefers-reduced-motion: reduce)"));

/* ─── 轮 139 · 死规则清理 + 页面容器口径统一 ─── */
ok("T50 轮139：设置页死规则已清（.settings-page / .settings-title / .set-block 不得回潮）",
  !css.includes(".settings-page {") && !css.includes(".settings-title {")
  && !css.includes(".set-block {") && !css.includes(".set-block.dimmed"));
const PAGE_FILL = [
  [".bottle-page", "src/views/BottlePageView.vue"],
  [".set-page", "src/views/SettingsView.vue"],
  [".compose-page", "src/views/ComposeView.vue"],
  [".pd", "src/views/PostDetailView.vue"],
  [".login-page", "src/views/LoginView.vue"],
  [".legal-page", "src/style.css"],
];
const missingFill = PAGE_FILL.filter(([c, f]) =>
  !(f === "src/style.css" ? css : read(f)).includes("@media (min-width: 900px) { " + c + " { max-width: none; } }"));
ok("T51 轮139：六处页面容器桌面（≥900）一律铺满（轮137 五处 + 政策页）",
  missingFill.length === 0, missingFill.map((x) => x[0]).join(","));

/* ─── 轮 140 · 左导航默认展开 + 展开态透明 + 漂流瓶上移 + 首页去漂流瓶 ─── */
ok("T52 轮140：展开态去掉卡片背景与描边（与右栏 `.rail` 同口径透明）",
  sn.includes(".sidenav--open { width: 212px; background: transparent; border-color: transparent; }"));
ok("T53 轮140：左导航顺序 = 今天|宠物|漂流瓶|暖心墙|私信（漂流瓶移到暖心墙之上）", (() => {
  const iB = sn.indexOf('{ to: "/bottle"'), iC = sn.indexOf('{ to: "/community"');
  return iB > 0 && iC > iB;
})());
ok("T54 轮140：桌面首页不再内联漂流瓶（只剩手机三联那一个 BottleView）",
  (read("src/views/HomeView.vue").match(/<BottleView/g) || []).length === 1);

/* ─── 轮 141 · 右栏去掉「海边来信」 ─── */
ok("T55 轮141：右栏「海边来信」整块移除且不留半套（模板/逻辑/样式/i18n 四清）", (() => {
  const rails = read("src/components/SideRails.vue");
  const i18 = read("src/i18n.js");
  return !rails.includes("rail.bottleTitle")
    && !rails.includes("btLeft") && !rails.includes("btHeld")
    && !rails.includes("bottleQuota") && !rails.includes("bottleHeld(")
    && !rails.includes(".bt-line") && !rails.includes("signedIn")
    && !/bottleTitle|bottleLeft:|bottleHeld:|bottleGo:/.test(i18);
})());

out.push("");
out.push(`TOTAL ${pass + fail}  PASS ${pass}  FAIL ${fail}`);
console.log(out.join("\n"));
process.exit(fail ? 1 : 0);
