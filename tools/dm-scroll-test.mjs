/* 轮 340 · 进会话必须落到底（不管最后一条是谁发的、有没有本地库）
 *   node tools/dm-scroll-test.mjs
 *
 * 用户原话：「图一点进去是直接在顶部，图二点进去会下拉到底部……旧版的那个好好的。」
 * 根因（不是旧页面那套 listEl/scrollBottom —— 那是 vac 关闭时的死代码）：
 *   vue-advanced-chat 自己只在「最后一条是我发的」时才滚（autoScroll.receive.newAfterScrollUp
 *   默认 false），而且走 setTimeout(50)+smooth；本地库秒开时消息随 roomId 同帧到场，
 *   组件等不到 messages 变化，干脆不滚 → 停在顶部。
 * 修法：外壳负责钉底（直接 scrollTop=scrollHeight，瞬移），布局/内容变化时补枪；
 *   用户一上滑就撤销，翻历史（load-more）绝不钉底。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const RAW = (p) => fs.readFileSync(path.join(root, p), "utf8");
const code = (s) => s.replace(/<!--[\s\S]*?-->/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
const VAC_RAW = RAW("src/components/DmVacChat.vue");
const VAC = code(VAC_RAW);
const VIEW = code(RAW("src/views/MessagesView.vue"));
const fnBody = (src, sig, endSig) => {
  const i = src.indexOf(sig);
  if (i < 0) return "";
  const j = endSig ? src.indexOf(endSig, i) : -1;
  return src.slice(i, j > i ? j : i + 1600);
};

let pass = 0, fail = 0; const out = [];
const t = (name, fn) => {
  try { fn(); pass++; out.push("ok   " + name); }
  catch (e) { fail++; out.push("FAIL " + name + " :: " + e.message); }
};
const has = (src, re, msg) => { if (!re.test(src)) throw new Error(msg); };

t("S1 进房钉底：直接写 scrollTop=scrollHeight", () => {
  const pin = fnBody(VAC, "const pinOnce = () =>", "const pinBottom");
  has(pin, /scrollTop = n\.scrollHeight/, "pinOnce 没把 scrollTop 写到 scrollHeight");
  const pb = fnBody(VAC, "const pinBottom = () => {", "const stopPin");
  has(pb, /nextTick\(pinOnce\)/, "下一帧没补");
  has(pb, /requestAnimationFrame\(\(\) => requestAnimationFrame\(pinOnce\)\)/, "双 rAF 没补");
});

t("S2 瞬移：摘掉组件的 smooth 类 + 内联 scroll-behavior:auto", () => {
  const pin = fnBody(VAC, "const pinOnce = () =>", "const pinBottom");
  has(pin, /classList\.remove\("vac-scroll-smooth"\)/, "没摘 .vac-scroll-smooth（会变成 1s 平滑动画）");
  has(pin, /style\.scrollBehavior = "auto"/, "没强制瞬时滚动");
});

t("S3 换房重置钉底意图（needPin / userStopped）", () => {
  const w = fnBody(VAC, "watch(curRoom, (r, old) => {", "watch([curRoom, curMsgs]");
  has(w, /needPin = true/, "换房没重置 needPin");
  has(w, /userStopped = false/, "换房没清掉「用户上滑过」");
  has(w, /entryAt = Date\.now\(\)/, "换房没记进房时间");
  has(w, /firstPinDone = false/, "换房没重新打开首帧隐藏门控（第二个会话会露顶部）");
  has(w, /clearTimeout\(gateTimer\)/, "换房没清上一房的兜底揭示定时器");
});

t("S4 首屏消息到场 → 钉底（本地库秒开也走这条）", () => {
  const w = fnBody(VAC, "watch([curRoom, curMsgs]", "watch(loaded");
  has(w, /if \(needPin && msgs\.length\)/, "没有「首次有消息才钉底」的判断");
  has(w, /pinBottom\(\)/, "没钉底");
  has(w, /\{ immediate: true \}/, "首帧不触发（本地库命中时不会钉）");
});

t("S5 布局追帧：ResizeObserver 盯容器与内容 + rAF 循环", () => {
  has(VAC, /new ResizeObserver\(/, "没有 ResizeObserver（父级定高前 scrollTop 写不进去）");
  has(VAC, /ro\.observe\(n\)/, "没盯滚动容器");
  has(VAC, /vac-messages-container/, "没盯内容容器（消息逐条挂上要补）");
  has(VAC, /requestAnimationFrame\(tick\)/, "没有 rAF 追帧");
});

t("S6 loader 收尾补一枪（且尊重用户已上滑）", () => {
  const w = fnBody(VAC, "watch(loaded, (v) => {", "const TEXT");
  has(w, /!userStopped/, "用户上滑后仍会把人拽回底部");
  has(w, /Date\.now\(\) - entryAt < 2500/, "没有进房时间窗（翻历史收尾也会钉底）");
  has(w, /pinBottom\(\)/, "loader 收尾没补枪");
});

t("S7 用户一上滑就撤销：wheel 上滚 / 手指下滑 / mousedown / PageUp", () => {
  const b = fnBody(VAC, "const bindScrollIntent = () => {", "watch(curRoom");
  has(b, /wheel[\s\S]{0,80}deltaY < 0[\s\S]{0,40}stopPin\(\)/, "滚轮上滑没撤销");
  has(b, /touchmove[\s\S]{0,160}y > touchY \+ 4[\s\S]{0,40}stopPin\(\)/, "手指下滑没撤销");
  has(b, /mousedown[\s\S]{0,40}stopPin\)?/, "拖滚动条没撤销");
  has(b, /PageUp[\s\S]{0,120}stopPin\(\)/, "键盘翻页没撤销");
});

t("S8 卸载清理：定时器 / RO / rAF 都收", () => {
  has(fnBody(VAC, "const clearPin = () => {", "const pinOnce"), /cancelAnimationFrame\(rafId\)/, "rAF 没取消");
  has(fnBody(VAC, "const clearPin = () => {", "const pinOnce"), /ro\.disconnect\(\)/, "RO 没断开");
  has(fnBody(VAC, "onBeforeUnmount(() => {", "</script>"), /clearPin\(\)/, "卸载没清理");
});

t("S9 翻历史不钉底（load-more 收尾不许把人拉回底部）", () => {
  const f = fnBody(VAC, "const onFetchMessages = async () => {", "const onAction");
  assert.ok(!f.includes("pinBottom"), "onFetchMessages 里调了 pinBottom（翻历史会被拽到底）");
  assert.ok(!f.includes("pinOnce"), "onFetchMessages 里调了 pinOnce");
});

t("S10 别误伤：私信/漂流瓶都走这个外壳，hideHeader 默认仍是 false", () => {
  has(VAC, /hideHeader: \{ type: Boolean, default: false \}/, "hideHeader 默认值变了");
  has(VIEW, /v-if="vacUi && seg === 'dm'"/, "会话段不再走 DmVacChat");
  has(RAW("src/components/BottleChat.vue"), /<DmVacChat[\s\S]{0,240}?hide-header/, "漂流瓶不再复用 DmVacChat");
});

console.log(out.join("\n"));
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
