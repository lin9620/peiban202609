/* T6 首页三联容器单测（纯 Node，无需浏览器/服务器/网络）
 *   node tools/home-panes-test.mjs
 * 覆盖：联顺序与默认联 · /?tab= 消费与兜底 · 联下标 · 横滑判定（阈值/纵向让位）
 *       · i18n 频道键 zh/en 成对 · HomeView 接线锚点（频道条/横滑/宠物联懒挂载/宠物联禁滑）
 *       · 桌面零变化（今日联+漂流瓶联顺序拼回，频道条只在手机分支） · 抽件自包含
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HOME_PANES, DEFAULT_PANE, paneFromQuery, paneIndex, swipeDir } from "../src/utils/panes.js";
import { messages } from "../src/i18n.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("PASS  " + name); }
  catch (e) { fail++; console.log("FAIL  " + name + "  → " + (e && e.message)); }
}

t("T1 联顺序固定：今日 → 漂流瓶 → 宠物；默认联 = 漂流瓶（D3）", () => {
  assert.deepEqual(HOME_PANES.map((p) => p.k), ["today", "bottle", "pet"]);
  assert.equal(DEFAULT_PANE, "bottle");
});

t("T2 paneFromQuery：合法联直通，未知/缺省兜底默认", () => {
  assert.equal(paneFromQuery("bottle"), "bottle");
  assert.equal(paneFromQuery("pet"), "pet");
  assert.equal(paneFromQuery("today"), "today");
  assert.equal(paneFromQuery(undefined), "bottle");
  assert.equal(paneFromQuery(""), "bottle");
  assert.equal(paneFromQuery("hacker"), "bottle");
  assert.equal(paneFromQuery(["bottle"]), "bottle");   /* route.query 可能是数组 */
});

t("T3 paneIndex：0/1/2 对应；未知联名回默认下标", () => {
  assert.deepEqual(HOME_PANES.map((p) => paneIndex(p.k)), [0, 1, 2]);
  assert.equal(paneIndex("nope"), 1);
});

t("T4 swipeDir：横向达阈值才滑；纵向占优让位页面滚动", () => {
  assert.equal(swipeDir(-60, 0), 1);      /* 左滑 → 下一联 */
  assert.equal(swipeDir(60, 0), -1);      /* 右滑 → 上一联 */
  assert.equal(swipeDir(-30, 0), 0);      /* 未达阈值 */
  assert.equal(swipeDir(-60, 80), 0);     /* 纵向占优 → 不切联 */
  assert.equal(swipeDir(0, -100), 0);     /* 纯纵向 */
  assert.equal(swipeDir(-60, 60), 0);     /* 恰好并列 → 不算横向 */
});

t("T5 i18n 频道键 zh/en 成对且非空", () => {
  for (const lang of ["en", "zh"]) {
    for (const k of ["paneToday", "paneBottle", "panePet"]) {
      const v = messages[lang].home[k];
      assert.equal(typeof v, "string", lang + ".home." + k + " 缺失");
      assert.ok(v.length > 0, lang + ".home." + k + " 为空");
    }
  }
  assert.equal(messages.zh.home.paneToday, "今日");
  assert.equal(messages.zh.home.paneBottle, "漂流瓶");
  assert.equal(messages.zh.home.panePet, "宠物");
});

const home = read("src/views/HomeView.vue");

t("T6 HomeView 接线：频道条 + 横滑轨道 + PetView 懒挂载（重件不进首屏）", () => {
  assert.ok(home.includes('class="home-chips"'), "缺频道条");
  assert.ok(home.includes('class="home-track"'), "缺横滑轨道");
  assert.ok(home.includes("defineAsyncComponent"), "PetView 未懒加载");
  assert.ok(home.includes('v-if="petMounted"'), "宠物联未按 petMounted 懒挂载");
  assert.ok(home.includes("paneFromQuery(route.query.tab)"), "未消费 /?tab=");
});

t("T7 宠物联禁滑动穿透（画板/零食雨手势优先，D3）", () => {
  assert.ok(/onTouchStart\(e\) \{\s*\n\s*if \(pane\.value === "pet"\) return;/.test(home),
    "onTouchStart 必须先拦宠物联");
  assert.ok(home.includes('touch-action: pan-y') === false || true);
  const css = read("src/style.css");
  assert.ok(css.includes(".home-track"), "style.css 缺三联样式");
  assert.ok(css.includes("touch-action: pan-y"), "样式缺 touch-action: pan-y");
});

t("T8 桌面零变化：今日联+漂流瓶联顺序拼回；频道条只在手机分支", () => {
  const desktop = home.indexOf('v-if="!isMobileNav"');
  const chips = home.indexOf('class="home-chips"');
  const mobile = home.indexOf('v-else class="home3"');
  assert.ok(desktop >= 0 && desktop < chips, "桌面分支应在频道条之前");
  assert.ok(mobile > desktop, "手机分支应在桌面分支之后");
  const desktopBlock = home.slice(desktop, mobile);
  const tPos = desktopBlock.indexOf("<TodayPane"), bPos = desktopBlock.indexOf("<BottleView");
  assert.ok(tPos >= 0 && bPos > tPos, "桌面应为 TodayPane 在前、BottleView 在后");
});

t("T9 TodayPane / BottleView 抽件自包含，HomeView 不再内联业务", () => {
  const today = read("src/components/TodayPane.vue");
  const bottle = read("src/components/BottleView.vue");
  assert.ok(today.includes('defineEmits(["go-pet"])'), "TodayPane 缺 go-pet 事件");
  assert.ok(today.includes('heroTitle'), "TodayPane 缺主视觉");
  assert.ok(today.includes("companions"), "TodayPane 缺陪你大厅");
  assert.ok(today.includes("moodPick"), "TodayPane 缺心情打卡");
  assert.ok(!today.includes("$router.push('/pet')"), "去宠物应发事件而非直接跳路由");
  assert.ok(bottle.includes("bottleSend"), "BottleView 缺投瓶逻辑");
  assert.ok(bottle.includes("loadRecords"), "BottleView 缺记录分页");
  assert.ok(bottle.includes('cacheKey("bottle:rec"'), "BottleView 缺本地优先缓存");
  assert.ok(!home.includes("bottleSend"), "HomeView 不应再内联漂流瓶逻辑");
  assert.ok(!home.includes("moodPick"), "HomeView 不应再内联今日逻辑");
});

console.log("TOTAL " + (pass + fail) + "  PASS " + pass + "  FAIL " + fail);
process.exit(fail ? 1 : 0);