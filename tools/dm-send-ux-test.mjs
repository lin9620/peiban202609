/* 轮 316 · 聊天「发送手感」四件套单测（源码结构 + 真跑一遍生成器）
 * ------------------------------------------------------------
 * 用户原话：
 *   ① 「写完了点击发送，旁边发送中按钮转半天，不要发送中的提示啊，想发送下一条都发送不了。」
 *   ② 「点击发送之后，发送的内容却不在聊天框之中出现，本地储存了还能这么慢，等很久之后才出现。」
 * 真因（两条都不是玄学，都能在源码里指出来）：
 *   A. send() 的 catch 里引用了 try 内的 const onSameConv —— 每次发送失败都抛 ReferenceError，
 *      失败行永远停在「发送中」，复位发送态的语句也执行不到：按钮永久转圈 +
 *      下一条被那道发送中门挡住（用户原话「转半天，想发送下一条都发送不了」）。
 *   B. 首屏网络回来走整窗替换（msgs.value = asc），把还在飞的乐观行（id<0）一并抹掉；
 *      确认回写再 map 也找不到它 → 用户看到「发出去却看不见，等很久才出现」。
 *   C. 消息区在 entryReady 前是 visibility:hidden，而首选「无本地库」时要等那次跨境 RPC
 *      落定才置位 → 这段时间里发出去的消息一个字都不显示。
 * 断言写法：源码串 + 结构（catch 块内自证作用域），每条都能被「回退源码」打红
 *          （见 _scratch/verify-316-lock.mjs）。会话段与漂流瓶段同款，两侧都要钉。
 * 运行：node tools/dm-send-ux-test.mjs
 */
import fs from "node:fs";

let pass = 0;
const fails = [];
function ok(name, cond, extra = "") {
  if (cond) pass++;
  else fails.push(name + (extra ? ` —— ${extra}` : ""));
}
const read = (p) => fs.readFileSync(p, "utf8");
/* 去注释/模板注释：断言只认代码，不认解释（否则自己写的注释会把锁打红） */
const code = (s) =>
  s.replace(/<!--[\s\S]*?-->/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
/* 取某个函数的完整函数体（先配平参数括号，再从函数体左括号配平——
   注意参数里的默认值 `{ before = null } = {}` 也带花括号，直接数花括号会被它骗） */
function fnBody(src, head) {
  const i = src.indexOf(head);
  if (i < 0) return "";
  let d = 0, j = i;
  for (; j < src.length; j++) {
    if (src[j] === "(") d++;
    else if (src[j] === ")") { d--; if (d === 0) { j++; break; } }
  }
  const start = src.indexOf("{", j);
  if (start < 0) return "";
  let b = 0;
  for (let k = start; k < src.length; k++) {
    if (src[k] === "{") b++;
    else if (src[k] === "}") { b--; if (b === 0) return src.slice(i, k + 1); }
  }
  return src.slice(i);
}

const MV = "src/views/MessagesView.vue";     /* 会话聊天（用户报的就是这里） */
const BC = "src/components/BottleChat.vue";  /* 漂流瓶聊天（同款代码，同款毛病 */
const mvRaw = read(MV), bcRaw = read(BC);
const mv = code(mvRaw), bc = code(bcRaw);
const mvSend = fnBody(mv, "async function send()");
const bcSend = fnBody(bc, "async function send()");
const mvLoad = fnBody(mv, "async function loadMessages(");
const bcLoad = fnBody(bc, "async function loadMessages(");
const catchOf = (fnSrc) => { const i = fnSrc.indexOf("} catch (e) {"); return i < 0 ? "" : fnSrc.slice(i); };

/* ══════════ ① 发送不再被「发送中」阻塞，也不再有那个转圈 ══════════ */
ok("会话段 · send 里没有发送态门的早退（连发送态变量本身都不该再存在）",
  !/\bsending\b/.test(mv) && !/\bsending\b/.test(bc));
ok("两端 · 发送键只按「有没有内容」禁用，不再挂发送中态",
  /class="dm-send-btn" :disabled="!body\.trim\(\)"/.test(mv)
  && /class="dm-send-btn" :disabled="!body\.trim\(\)"/.test(bc));
ok("两端 · 发送键不再有转圈元素", !/dm-send-spin/.test(mv) && !/dm-send-spin/.test(bc));
ok("两端 · 发送键文案恒亮（不再按发送态藏标签）",
  !/visibility: sending/.test(mv) && !/visibility: sending/.test(bc));

/* ══════════ ② 发送失败：行内标红，不能只剩个「发送中」 ══════════ */
ok("两端 · 行内不再出现「发送中…」提示", !/t\("dm\.sending"\)/.test(mv) && !/t\("dm\.sending"\)/.test(bc));
ok("两端 · 失败就在那条消息文字旁标红（dm.sendFailed + dm-err）",
  /v-if="it\.msg\.failed" class="dm-err">\{\{ t\("dm\.sendFailed"\) \}\}/.test(mvRaw)
  && /v-if="it\.msg\.failed" class="dm-err">\{\{ t\("dm\.sendFailed"\) \}\}/.test(bcRaw));

const mvCatch = catchOf(mvSend), bcCatch = catchOf(bcSend);
ok("会话段 · catch 自带会话判定，不引用 try 作用域的 onSameConv（旧版就死在这：每失败必 ReferenceError）",
  !/\bonSameConv\b/.test(mvCatch) || /const onSameConv = String\(activeId\.value\) === String\(convId\);/.test(mvCatch));
ok("两端 · 失败行找不到乐观行就补回列表（否则用户看不到任何失败标记）",
  /failed: true/.test(mvCatch)
  && /msgs\.value\.some\(\(m\) => m\.id === temp\.id\)[\s\S]{0,140}?msgs\.value\.concat\(\[failedRow\]\)/.test(mvCatch)
  && /failed: true/.test(bcCatch)
  && /msgs\.value\.some\(\(m\) => m\.id === temp\.id\)[\s\S]{0,140}?msgs\.value\.concat\(\[failedRow\]\)/.test(bcCatch));

/* ══════════ ③ 发出去立刻上屏：不被整窗替换吞掉，也不被揭示门控藏住 ══════════ */
ok("两端 · 首屏整窗替换不吞在飞的乐观行（pend 守卫）",
  /const pend = msgs\.value\.filter\(\(m\) => m\.id < 0\);[\s\S]{0,180}?msgs\.value = pend\.length \? asc\.concat\(pend\) : asc;/.test(mvLoad)
  && /const pend = msgs\.value\.filter\(\(m\) => m\.id < 0\);[\s\S]{0,180}?msgs\.value = pend\.length \? asc\.concat\(pend\) : asc;/.test(bcLoad));
ok("两端 · 发消息即揭示消息区并钉底（不再等 entryReady / 跨境 RPC）",
  /pinning\.value = false;[\s\S]{0,90}?listRevealed\.value = true;[\s\S]{0,40}?scrollBottom\(true\);/.test(mvSend)
  && /pinning\.value = false;[\s\S]{0,90}?listRevealed\.value = true;[\s\S]{0,40}?scrollBottom\(true\);/.test(bcSend));
ok("两端 · 确认回写：找不到乐观行就补回，已有同 id 只去重（防两条同 id）",
  /const rest = msgs\.value\.filter\(\(m\) => m\.id !== temp\.id\)/.test(mvSend)
  && /rest\.some\(\(m\) => m\.id === mid\) \? rest : rest\.concat\(\[rowSrv\]\)/.test(mvSend)
  && /const rest = msgs\.value\.filter\(\(m\) => m\.id !== temp\.id\)/.test(bcSend)
  && /rest\.some\(\(m\) => m\.id === mid\) \? rest : rest\.concat\(\[rowSrv\]\)/.test(bcSend));

/* ══════════ ④ 乐观行临时 id：同毫秒连发不能撞（撞了就两条合成一条） ══════════ */
ok("两端 · 乐观行 id 走生成器（不再裸用 -Date.now()）",
  /id: nextTempId\(\)/.test(mvSend) && !/id: -Date\.now\(\)/.test(mvSend)
  && /id: nextTempId\(\)/.test(bcSend) && !/id: -Date\.now\(\)/.test(bcSend));
{
  /* 真跑一遍生成器：同毫秒也必须严格递减（旧代码没有这个函数 → 三条全红） */
  const decl = (mvRaw.match(/let lastTempId = 0;/) || [])[0];
  const fn = (mvRaw.match(/function nextTempId\(\) \{[\s\S]*?\n\}/) || [])[0];
  const make = (nowMs) => {
    if (!decl || !fn) return null;
    return new Function("Date", `${decl}\n${fn}\nreturn nextTempId;`)({ now: () => nowMs });
  };
  const T0 = 1_800_000_000_000;
  const g1 = make(T0);
  const a = g1 ? g1() : 0, b = g1 ? g1() : 0;
  ok("生成器：连续两次严格递减且都为负（id<0 才会被当作乐观行压尾）", !!g1 && a < 0 && b < a);
  const g2 = make(T0);                                    /* 同一毫秒连发两次 */
  ok("生成器：同一毫秒连发两次不撞 id", !!g2 && g2() !== g2());
  const g3 = make(T0);
  const three = g3 ? [g3(), g3(), g3()] : [];
  ok("生成器：同毫秒连发 N 次全部互不相同", three.length === 3 && new Set(three).size === 3);
}

console.log(`dm-send-ux-test: ${pass} pass, ${fails.length} fail`);
if (fails.length) { for (const f of fails) console.log("  FAIL " + f); process.exit(1); }
