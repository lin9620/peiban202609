/* 轮 318 · 会话（旧版输入区）「发送后自动折叠」单测
 * ------------------------------------------------------------
 * 用户原话：「会话框，打字，发送-之后，输入框自动折叠了，不要折叠啊。」
 * 真因（真机 CDP 实测，见 _scratch/dm-compose-probe.mjs 的 before 报告）：
 *   ① 输入框是 Vant `<van-field type="textarea" rows="1" autosize>` —— autosize 按内容算高度，
 *      send() 里把 body 清空 → textarea 立刻被按回一行（实测 92px → 44px），
 *      下方消息区跟着长高 48px，整块往下跳。
 *   ② 点「发送」按钮会把焦点抢到按钮上（实测 activeElement 从 TEXTAREA 变 BODY）
 *      → 手机上键盘收起，想接着打下一条还得再点一次输入框。
 * 修法：发送那一刻量下当前高度写成 min-height 把 autosize 压住 + 焦点拉回输入框；
 *      只有「用户自己把字删空」「换会话」才放开（那时缩回一行是用户自己的动作，不是自动折叠）；
 *      放开的实现必须连 Vant 写死的 height 一起松开再重量一遍 —— 否则 Vant 那次 resize 量到的
 *      是「被钉子撑住的高度」，松手后盒子会一直停在两行上（空输入框仍被挡着）。
 * 断言写法：源码串 + 结构 + 真跑一遍 watch 回调（区分发送清空 / 用户删空），
 *          每条都能被「回退源码」打红（见 _scratch/verify-318-lock.mjs）。
 * 轮 339：漂流瓶聊天框已整体交给 DmVacChat（组件自带输入区/键盘保持），
 *         本文件的「两端」收窄成会话段旧版（?ui=legacy 仍在使用），
 *         漂流瓶只锁「不再手写输入区 + 真的复用了组件」。
 * 运行：node tools/dm-compose-test.mjs
 */
import fs from "node:fs";

let pass = 0;
const fails = [];
function ok(name, cond, extra = "") {
  if (cond) pass++;
  else fails.push(name + (extra ? ` —— ${extra}` : ""));
}
const read = (p) => fs.readFileSync(p, "utf8");
/* 去注释：断言只认代码，不认解释（自己写的注释不能把锁打红） */
const code = (s) =>
  s.replace(/<!--[\s\S]*?-->/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
/* 取某个函数的完整函数体（配平括号，参数里的默认值带花括号也不怕） */
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
/* 抽出 watch(body, (v) => { ... }) 的回调体，真跑一遍它对三种输入的判定 */
function watchRun(raw) {
  const m = raw.match(/watch\(body, \(v\) => \{([\s\S]*?)\n\}\)/);
  if (!m) return null;
  const src = m[1].replace(/\bsentClear\b/g, "st.sentClear");
  let fn;
  try { fn = new Function("v", "holdCompose", "releaseCompose", "st", src); } catch (e) { return null; }
  return (v, sentClear) => {
    const calls = [], st = { sentClear };
    fn(v, (h) => calls.push("hold:" + h), () => calls.push("release"), st);
    return { calls, st };
  };
}

const MV = "src/views/MessagesView.vue";     /* 会话聊天（用户报的就是这里） */
const BC = "src/components/BottleChat.vue";  /* 漂流瓶聊天（轮 339 起交给组件） */
const mvRaw = read(MV), bcRaw = read(BC);
const mv = code(mvRaw), bc = code(bcRaw);
const mvSend = fnBody(mv, "async function send()");
const TAOF = 'function taOf() { return composeRow.value ? composeRow.value.querySelector("textarea") : null; }';

/* ══════════ ① 输入行拿得到 Vant 里面那个 textarea（会话段旧版） ══════════ */
ok("会话段 · 输入行挂了 ref，能定位 Vant 内层的 textarea",
  /class="dm-input-row" ref="composeRow"/.test(mvRaw));
ok("会话段 · 高度钉子落在 textarea 自身（不是外面那圈 row / footer）",
  mv.includes(TAOF) && /const ta = taOf\(\);/.test(mvSend));

/* ══════════ ② 发送前：钉住高度 + 焦点拉回（都在清空 body 之前） ══════════ */
ok("会话段 · 发送时按当前高度钉住输入框（autosize 按不回一行）",
  /holdCompose\(ta\.getBoundingClientRect\(\)\.height\)/.test(mvSend));
ok("会话段 · 发送时焦点拉回输入框（点按钮抢走焦点 = 手机收键盘，得再点一次才能接着打）",
  /\bta\.focus\(\)/.test(mvSend));
{
  const clearAt = (s) => s.indexOf('body.value = ""');
  const holdAt = (s) => s.indexOf("holdCompose(ta.getBoundingClientRect().height)");
  const focusAt = (s) => s.indexOf("ta.focus()");
  ok("会话段 · 钉高度发生在清空 body 之前（清完才量就只剩一行高）",
    holdAt(mvSend) > 0 && holdAt(mvSend) < clearAt(mvSend));
  ok("会话段 · focus 也在清空之前、还在点击的手势栈里（异步之后再 focus，手机可能不再弹键盘）",
    focusAt(mvSend) > 0 && focusAt(mvSend) < clearAt(mvSend));
}

/* ══════════ ③ 钉住 / 放开两个方向都要有，且放开要重量一遍 ══════════ */
ok("会话段 · 有「钉住」实现：min-height 写成发送前的高度",
  /function holdCompose\(h\) \{[\s\S]{0,200}?ta\.style\.minHeight = composeHoldH \+ "px";/.test(mv));
ok("会话段 · 有「放开」实现：连 Vant 写死的 height 一起松开，再按 scrollHeight 重量（空 = 一行）",
  /function releaseCompose\(\) \{[\s\S]{0,240}?ta\.style\.minHeight = "";[\s\S]{0,140}?ta\.style\.height = "auto";[\s\S]{0,90}?ta\.style\.height = ta\.scrollHeight \+ "px";/.test(mv));
ok("会话段 · 发送清空打了标记（否则 watch 分不清是发送还是用户删空）",
  /sentClear = true;/.test(mvSend));
ok("会话段 · watch：发送清空那次直接返回、不松开钉子",
  /if \(sentClear\) \{ sentClear = false; return; \}/.test(mv));
ok("会话段 · watch：用户自己删空才 releaseCompose() 放开",
  /if \(v\) return;[\s\S]{0,200}?releaseCompose\(\);/.test(mv));
ok("会话段 · send 里不会刚清空就把钉子放开（那样等于没修）",
  /holdCompose\(ta\.getBoundingClientRect\(\)\.height\)/.test(mvSend)
  && !/body\.value = "";[\s\S]{0,60}?releaseCompose\(\)/.test(mvSend));
ok("会话段 · 换会话把钉子归位（草稿不清，但高度别带过去）",
  /if \(!same\) releaseCompose\(\);/.test(mv));

{ /* 真跑 watch 回调：三种输入各判一次 */
  const mvW = watchRun(mv);
  const sendClear = mvW && mvW("", true);
  ok("真跑 watch：发送清空那次不松开钉子（且标记被消费掉）",
    !!sendClear && sendClear.calls.length === 0 && sendClear.st.sentClear === false);
  const userClear = mvW && mvW("", false);
  ok("真跑 watch：用户自己删空 → 放开钉子（缩回一行是用户自己的动作）",
    !!userClear && userClear.calls.length === 1 && userClear.calls[0] === "release");
  const typing = mvW && mvW("还有字", false);
  ok("真跑 watch：输入框里还有内容时不动钉子",
    !!typing && typing.calls.length === 0);
}

/* ══════════ ④ 轮 339 · 漂流瓶聊天框不再手写输入区 ══════════ */
ok("漂流瓶 · 复用 DmVacChat 且藏掉组件头（头仍用旧那条带胶囊 + ⋯）",
  bc.includes('import DmVacChat from "./DmVacChat.vue"') && bc.includes("hide-header"));
ok("漂流瓶 · 自己不再有任何输入区（van-field / dm-compose / 高度钉子全无）",
  !bc.includes("van-field") && !bc.includes("dm-compose") && !bc.includes("holdCompose")
  && !bc.includes("releaseCompose") && !bc.includes("taOf"));
ok("漂流瓶 · 头部胶囊与父级 ⋯ 菜单还在",
  bcRaw.includes('class="bchat-tag"') && bcRaw.includes('<slot name="headtools">'));
ok("漂流瓶 · 发送仍走同一条数据链（sendText → dm_send 回传 msg_id）",
  /async function sendText\(raw\)/.test(bc) && bc.includes("r.msg_id") && bc.includes("dmStoreSave(props.meId"));

console.log(`dm-compose-test: ${pass} pass, ${fails.length} fail`);
if (fails.length) { for (const f of fails) console.log("  FAIL " + f); process.exit(1); }
