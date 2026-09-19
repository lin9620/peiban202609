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

out.push("");
out.push(`TOTAL ${pass + fail}  PASS ${pass}  FAIL ${fail}`);
console.log(out.join("\n"));
process.exit(fail ? 1 : 0);
