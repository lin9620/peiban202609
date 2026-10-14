/* 私信「切会话串内容」竞态回归测试（Node 直跑：node tools/dm-race-test.mjs）
 * ------------------------------------------------------------
 * 用户报障：快速点开用户 A 的会话 → 返回 → 快速点 B → 再点 C，多按几次之后
 * 「C 的会话里最后出现的可能是 B，也可能是 A」——完全不能用。
 *
 * 根因（纯异步竞态，网络越慢越容易撞，与用户手速无关）：
 *   loadMessages / tick 都是「await 网络 → 写 msgs.value」的形状，而 await 期间
 *   用户完全可以切走。旧响应回来时**没有任何身份校验**就写全局 msgs.value，
 *   于是「最后返回的那份」赢了 —— 与你当前点的是谁无关。
 *   5s 一次的轮询也在做同样的事：`listMessages(activeId.value)` 回来后直接
 *   mergeTail 进 msgs，会把 A 的新消息并进当前打开的 B/C 会话。
 *
 * 修法（轮 225）：每次「按会话拉消息」发号 + 校验会话身份，过期响应整份丢弃：
 *   const mySeq = ++msgSeq; const cid = String(id);
 *   const stale = () => mySeq !== msgSeq || String(activeId.value) !== cid;
 *   每个 await 之后 if (stale()) return false;  → 不写列表、不落本地库、不触发回填。
 *
 * 本文件重点是**结构断言 + 防回退**：只要有人在异步路径上漏了这道校验，
 * 或又拿可变的 activeId.value 当落库键，这里就红。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

let pass = 0;
const fails = [];
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; return; }
  fails.push(name);
  console.log("FAIL  " + name + (extra ? "  → " + extra : ""));
};

/* 去注释：注释里写着 stale() / activeId.value 这些词会把「代码里到底有没有」判反 */
const strip = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
  .replace(/(^|[^:\w"'`])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));

const mv = strip(read("src/views/MessagesView.vue"));

/** 切一个函数的完整体：从签名到下一个**顶层**声明（行首无缩进，函数体内的不匹配） */
function fnBody(src, signature) {
  const i = src.indexOf(signature);
  if (i < 0) return "";
  const stops = ["\nasync function ", "\nfunction ", "\nconst ", "\nlet ", "\nwatch(", "\nonMounted(", "\nonActivated(", "\nonDeactivated(", "\nonBeforeUnmount(", "\n</script>"];
  const cuts = stops.map((s) => src.indexOf(s, i + signature.length)).filter((v) => v > 0);
  return cuts.length ? src.slice(i, Math.min(...cuts)) : src.slice(i);
}

/* ══════════ 守卫基础设施 ══════════ */
ok("R1 有请求代次计数器 msgSeq", /^let msgSeq = \d+;/m.test(mv), "缺 msgSeq");
ok("R2 有过期判据 isStale（号被顶掉 或 已切走，二者缺一不可）",
  /const isStale = \(mySeq, id\) => mySeq !== msgSeq \|\| String\(activeId\.value\) !== String\(id\);/.test(mv),
  "isStale 不存在或判据被改弱");

/* ══════════ loadMessages：全链路校验 ══════════ */
const lm = fnBody(mv, "async function loadMessages(");
ok("R3 loadMessages 函数体切取成功", lm.length > 400, "切分失败（签名改了？）");
ok("R4 每轮加载都取新号并锁定会话 id",
  /const mySeq = \+\+msgSeq;/.test(lm) && /const cid = String\(id\);/.test(lm)
    && /const stale = \(\) => isStale\(mySeq, cid\);/.test(lm));
ok("R5 applyRows 第一件事就是丢弃过期响应",
  /const applyRows = \(rows, more\) => \{\s*if \(stale\(\)\) return false;/.test(lm),
  "applyRows 没有首行 stale 校验 —— 这是串会话最直接的入口");
ok("R6 每个 await 之后都有过期校验（防新加 await 忘守卫）", (() => {
  const idx = [...lm.matchAll(/\bawait /g)].map((m) => m.index);
  return idx.every((i) => /stale\(\)/.test(lm.slice(i, i + 300)));
})(), "有 await 之后 300 字符内没有 stale() 校验");
ok("R7 落本地库之前再校验一次（防把 A 的消息写进 B 的库）",
  /if \(stale\(\)\) return false;[\s\S]{0,200}?dmStoreSave\(meId\.value, cid,/.test(lm));
ok("R8 落库 / 镜像 / 回填都用锁定后的 cid",
  /dmStoreSave\(meId\.value, cid, msgs\.value, hasMore\.value\)/.test(lm)
    && /idbMerge\(cid, msgs\.value\)/.test(lm)
    && /backfillOlder\(cid\)/.test(lm));
ok("R9 过期时不碰 loadingMsgs（新请求正在管它）",
  /if \(stale\(\)\) return false;[\s\S]{0,120}?loadingMsgs\.value = false;/.test(lm));

/* ══════════ openConv：await 后校验 ══════════ */
const oc = fnBody(mv, "async function openConv(");
ok("R10 openConv 等完消息后校验 activeId，才动滚动与已读",
  /const smoothed = await loadMessages\(id\);/.test(oc)
    && /if \(String\(activeId\.value\) !== String\(id\)\) return;/.test(oc));

/* ══════════ tick：轮询不能把旧会话数据并进来 ══════════ */
/* 轮 269：尾部刷新已抽成 pullTail（tick 内联 → 独立函数，实时通道复用）——
 * 断言改为 tick 调 pullTail + pullTail 内三道守卫齐全（语义与旧内联版一致）。 */
const tk = fnBody(mv, "async function tick(");
const pt = fnBody(mv, "async function pullTail(");
ok("R11 轮询在 await 后丢弃旧会话的尾部数据",
  /await pullTail\(String\(activeId\.value\)\);/.test(tk)
    && /const mySeq = msgSeq;/.test(pt)
    && /if \(isStale\(mySeq, cid\)\) return false;/.test(pt),
  "tick 没做会话身份校验 —— 5s 一次的轮询会把 A 的新消息并进当前会话");

/* ══════════ send：切走后不得拿别人的 msgs 落库 ══════════ */
const sd = fnBody(mv, "async function send(");
ok("R12 发送回来先确认还在同一会话（onSameConv）",
  /const onSameConv = String\(activeId\.value\) === String\(convId\);/.test(sd));
ok("R13 发送的换行 / 落库 / 滚动都在 onSameConv 之内",
  /if \(onSameConv\) \{[\s\S]{0,400}?dmStoreSave\(meId\.value, convId,/.test(sd)
    && /if \(onSameConv\) scrollBottom\(true\);/.test(sd));

/* ══════════ recall：先捕获归属会话 ══════════ */
const rc = fnBody(mv, "async function recall(");
ok("R14 撤回先捕获 convId，回来校验后才改列表 / 落库",
  /const convId = String\(activeId\.value\);/.test(rc)
    && /if \(String\(activeId\.value\) === convId\) \{/.test(rc));

/* ══════════ 防回退：不得再拿可变全局当会话键落库 ══════════ */
ok("R15 没有任何地方用 activeId.value 直接当落库键（await 后它可能已变）",
  !/dmStoreSave\(meId\.value, activeId\.value,/.test(mv) && !/idbMerge\(activeId\.value,/.test(mv),
  "有地方拿 activeId.value 落库 —— 切会话后会把消息写进错误的本地库");

/* ══════════ 自检 ══════════ */
{
  const self = read("tools/dm-race-test.mjs");
  const exitAt = self.indexOf("process.exit(");
  ok("R16 本文件所有用例都注册在 process.exit 之前", exitAt > 0 && !/^ok\(/m.test(self.slice(exitAt)));
}

console.log(`\nTOTAL ${pass + fails.length}  PASS ${pass}  FAIL ${fails.length}`);
process.exit(fails.length ? 1 : 0);
