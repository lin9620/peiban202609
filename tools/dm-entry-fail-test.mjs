/* 轮 377 · 首屏失败揭示 + 会话操作换号守卫
 * node tools/dm-entry-fail-test.mjs
 *
 * 锁两件事：
 *   1. 首屏网络失败且本地库/IDB 都为空时，entryReady 不能一直 false；
 *      实时/轮询补进第一条消息时也要恢复揭示链，不能等到 10s 硬上限。
 *   2. hide/reject/accept 的 await 期间换号，旧账号的会话行和角标不能写进新账号。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { withDayDividers } from "../src/utils/dmRules.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "src/views/MessagesView.vue"), "utf8");

let pass = 0, fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log("PASS ", name); }
  else { fail++; console.log("FAIL ", name); }
};

ok("F1 首屏网络失败后标记 entryReady，空态不再藏到 10s 硬上限",
  /if \(before == null\) \{\s*if \(msgsConv !== cid\) applyRows\(\[\], true\);[\s\S]{0,500}if \(String\(activeId\.value\) === cid\) entryReady\.value = true;/.test(src));

ok("F2 尾部落进第一条时补 entryReady，实时/轮询也能救回首屏",
  /msgs\.value = rows;[\s\S]{0,500}if \(!entryReady\.value\) entryReady\.value = true;/.test(src));

ok("F3 消息区仍隐藏时，尾部落行重新走揭示链而不是只判断 nearBottom",
  /if \(added\) \{[\s\S]{0,500}if \(!listRevealed\.value\) scrollBottom\(false, true\);/.test(src));

ok("F4 hideConv 捕获发送时账号，换号后不清新账号的本地库",
  /async function hideConv\(c\) \{\s*const owner = meId\.value;/.test(src)
  && (src.match(/dmStoreDrop\(owner, c\.conv_id\);/g) || []).length === 2);

ok("F5 rejectReq 捕获账号，失败回滚不插回新账号列表/角标",
  /async function rejectReq\(c\) \{\s*const owner = meId\.value;/.test(src)
  && /if \(removed && meId\.value === owner\) convs\.value\.splice/.test(src)
  && /if \(meId\.value === owner\) badgeLocal\(\{ requests: badge\.requests \+ 1 \}\);/.test(src));

ok("F6 acceptReq 失败回滚角标也按账号校验",
  /async function acceptReq\(c\) \{\s*const owner = meId\.value;/.test(src)
  && /if \(meId\.value === owner\) badgeLocal\(\{ requests: badge\.requests \+ 1 \}\);/.test(src));

/* 待发行被规则压到末尾；若它的 created_at 跨回前一天，不能再插“昨天”分隔符。 */
const crossMidnight = withDayDividers([
  { id: 10, created_at: new Date(2026, 9, 30, 0, 1).toISOString() },
  { id: -1, created_at: new Date(2026, 9, 29, 23, 59).toISOString(), pending: true },
]);
ok("F7 待发行跨午夜时日期分隔不倒挂（不再补昨天的分隔符）",
  crossMidnight.filter((x) => x.type === "day").length === 1);

ok("F8 hide/reject 成功后再次摘行，防 await 期间列表刷新把旧行拉回来",
  (src.match(/convs\.value = convs\.value\.filter\(\(x\) => String\(x\.conv_id\) !== String\(c\.conv_id\)\);/g) || []).length >= 2);

ok("F9 登出清空本地预览补丁，换号后不串账号",
  /msgsConv = "";\s*convLocal\.clear\(\);/.test(src));

ok("F10 同意请求成功后补回 accepted，防旧列表快照覆盖乐观行",
  /const r = convs\.value\.find\(\(x\) => String\(x\.conv_id\) === String\(c\.conv_id\)\);\s*if \(r\) r\.accepted = true;/.test(src));

ok("F11 同会话尾部新增且消息区仍隐藏时，直接走揭示链不等 2s 兜底",
  /msgs\.value = merged;[\s\S]{0,400}if \(!listRevealed\.value\) scrollBottom\(false, true\);/.test(src));

ok("F12 翻历史补 scrollTop 的 rAF 要校验会话，切走后不能改新会话位置",
  /requestAnimationFrame\(\(\) => \{[\s\S]{0,300}if \(msgsConv !== cid \|\| String\(activeId\.value\) !== String\(cid\)\) return;/.test(src));

ok("F13 同会话尾部 smooth 滚到底也要校验会话，切走后不能拽新会话",
  /else nextTick\(\(\) => \{[\s\S]{0,300}if \(msgsConv !== cid \|\| String\(activeId\.value\) !== String\(cid\)\) return;/.test(src));

ok("F14 scrollBottom 的 nextTick 也要校验会话，旧会话不能钉新会话底部",
  /function scrollBottom\(smooth = false, reveal = false\) \{\s*const cid = String\(activeId\.value\);\s*nextTick\(\(\) => \{[\s\S]{0,200}if \(String\(activeId\.value\) !== cid\) return;/.test(src));

ok("F15 保活停用后停掉钉底/揭示 rAF，后台不再改 DOM",
  /onDeactivated\(\(\) => \{[\s\S]{0,120}?scrollGen\+\+;/.test(src));

ok("F16 卸载后停掉旧 rAF 并取消 topRaf",
  /onBeforeUnmount\(\(\) => \{[\s\S]{0,200}?scrollGen\+\+;[\s\S]{0,120}?cancelAnimationFrame\(topRaf\)/.test(src));

ok("F17 保活恢复时首屏仍隐藏则重开揭示链，不等 2s 兜底", (() => {
  const i = src.indexOf("onActivated(() => {");
  const b = src.slice(i, i + 1600);
  return i > 0 && /if \(!listRevealed\.value\) \{\s*scrollBottom\(false, true\);/.test(b);
})());

console.log(`\ndm-entry-fail-test: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
