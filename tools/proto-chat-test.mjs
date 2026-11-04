/* 会话页原型 · 「不转圈 / 不闪跳」接线锁（Node 直跑）
 *   node tools/proto-chat-test.mjs
 *
 * 锁的是轮 328 修掉的两个真机/真浏览器故障，防止以后又改回去：
 *   ① 点会话一直转圈：组件每换一次房间都把 loadingMessages 置 true，只认 messagesLoaded
 *      的 false→true **变化**；`fetch-messages` 只能用来收尾，不能用来猜是哪个会话。
 *   ② 切换闪跳：先清空再等数据，中间必然出现「空列表帧」。必须先取数，再在同一个 tick 里
 *      一起提交 roomId + messages，让组件「开 loader → 立刻发现已有消息 → 滚到底并关掉」。
 *
 * 另锁：换会话口子必须是 `fetch-room`（2.1.2 点会话只发这个，自己**不换**房间）；
 *      首帧翻转压在同一帧（nextTick），不用定时器等几十毫秒；
 *      原型页对缓存仍然只读（不写 SWR、不写 IndexedDB）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
let pass = 0, fail = 0; const out = [];
function t(name, fn) {
  try { fn(); pass++; out.push("ok   " + name); }
  catch (e) { fail++; out.push("FAIL " + name + " :: " + e.message); }
}

const SRC = read("src/proto/chat-proto.js");
const CACHE = read("src/proto/dm-cache.js");

/* 取某个函数的函数体（从 `const 名字 = ` 到下一个顶格 `    const ` / `};`），够用即可 */
function block(name) {
  const i = SRC.indexOf("const " + name + " =");
  assert.ok(i >= 0, "找不到 " + name);
  const rest = SRC.slice(i);
  const end = rest.indexOf("\n    };");
  assert.ok(end > 0, name + " 没有正常结束");
  return rest.slice(0, end);
}

/* ───────── ① 转圈：onFetch 必须有「已在加载态就别再翻」的守卫 ───────── */
t("T1 onFetch 有 loaded 守卫（首帧/连环 fetch 时二次翻转会闪）", () => {
  const b = block("onFetch");
  assert.match(b, /if\s*\(!loaded\.value\)\s*return;/, "onFetch 缺少 if (!loaded.value) return 守卫");
  assert.match(b, /loaded\.value\s*=\s*false/);
  assert.match(b, /loaded\.value\s*=\s*true/);
});

t("T2 onFetch 用 nextTick 收尾（不再用定时器等几十毫秒）", () => {
  const b = block("onFetch");
  assert.match(b, /await\s+nextTick\(\)/, "onFetch 收尾必须压在同一帧");
  assert.doesNotMatch(b, /setTimeout/, "onFetch 里不该再用 setTimeout 拉长空窗");
});

/* ───────── ② 闪跳：openRoom 必须先取数、再同 tick 提交 ───────── */
t("T3 openRoom 先取数后提交（roomId 赋值出现在 list 计算之后）", () => {
  const b = block("openRoom");
  const iList = b.indexOf("const list =");
  const iRoom = b.indexOf("roomId.value = cid;");
  assert.ok(iList > 0, "openRoom 没有先算 list");
  assert.ok(iRoom > iList, "必须先算好 list 再改 roomId，否则中间会出现空列表帧");
  assert.match(b, /messages\.value\s*=\s*list;/, "roomId 之后必须紧跟 messages 提交");
});

t("T4 有历史时不动 loaded（动了就会隐藏整个消息区 = 闪跳）", () => {
  const b = block("openRoom");
  /* loaded 的翻转只允许出现在「空会话」兜底分支里，且该分支必须以 if (!list.length) 开头 */
  const iFlip = b.indexOf("loaded.value = false");
  if (iFlip < 0) return;                     /* 全不翻也合规 */
  const iEmpty = b.indexOf("if (!list.length)");
  assert.ok(iEmpty > 0, "切会话时不允许无条件翻 loaded");
  assert.ok(iFlip > iEmpty, "loaded 翻转必须只发生在 if (!list.length) 空会话分支里");
});

t("T5 两种数据源都接上（样例 / 本地缓存）", () => {
  const b = block("openRoom");
  assert.match(b, /cached\.value/, "openRoom 没判断当前模式");
  assert.match(b, /readCachedMessages\(cid\)/, "缓存模式必须从 IndexedDB 读历史");
  assert.match(b, /MESSAGES\[cid\]/, "样例模式必须取样例消息");
});

/* ───────── ③ 换会话口子 + 首帧 ───────── */
t("T6 监听 fetch-room（2.1.2 点会话只发它，组件自己不换房间）", () => {
  assert.match(SRC, /addEventListener\("fetch-room",\s*onFetchRoom\)/);
  assert.match(SRC, /removeEventListener\("fetch-room",\s*onFetchRoom\)/, "解绑必须成对");
  const b = block("onFetchRoom");
  assert.match(b, /e\.detail[\s\S]{0,40}room/, "fetch-room 的 detail.room 才是被点的会话");
  assert.match(b, /openRoom\(/, "收到 fetch-room 必须换成对应会话");
});

t("T7 首帧翻在同一次 nextTick 里（不是 120ms 定时器）", () => {
  const i = SRC.indexOf("onMounted(");
  assert.ok(i > 0);
  const b = SRC.slice(i, i + 600);
  assert.match(b, /loaded\.value\s*=\s*false/);
  assert.match(b, /nextTick\(/, "首帧要靠 nextTick 收尾");
  assert.doesNotMatch(b, /setTimeout\(/, "首帧不许再用定时器拖出空白帧");
});

/* ───────── ④ 缓存只读（换组件不许顺手改缓存层） ───────── */
t("T8 原型页对缓存只读：不写 SWR、不写 IndexedDB", () => {
  for (const [name, src] of [["chat-proto.js", SRC], ["dm-cache.js", CACHE]]) {
    assert.doesNotMatch(src, /\bcacheSet\(/, name + " 不该写 SWR");
    assert.doesNotMatch(src, /\bcachePatch\(/, name + " 不该改 SWR");
    assert.doesNotMatch(src, /\bidbMerge\(|\bidbDrop\(|\bidbOlderThan\(/i, name + " 不该写 IndexedDB");
  }
  assert.match(CACHE, /cachePeek\(/, "会话列表仍应从 SWR 只读窥视");
  assert.match(CACHE, /idbLoad\(/, "历史仍应从 IndexedDB 只读加载");
});

t("T9 标题栏跟着换（roomId 是唯一真源，不许另存一份选中的会话）", () => {
  /* 组件右侧标题取自它自己的 roomId prop；我们只允许改 roomId.value，不许再维护 selectedId 之类 */
  const b = block("openRoom");
  assert.doesNotMatch(b, /selected/, "不要另造一份「当前选中会话」状态");
  assert.match(SRC, /"room-id":\s*roomId\.value/, "必须把 roomId 绑到组件的 room-id 属性上");
});

console.log(out.join("\n"));
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
