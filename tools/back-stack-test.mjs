/* 系统返回键拦截栈（T26）运行时单测
 *   node tools/back-stack-test.mjs
 * 口径：真跑 uiStore 的 pushBack/popBack/runBack —— 后进先出 / true 才算「已处理」/
 *   未拦截返回 false（App.vue 才会继续回退路由或最小化）/ 卸载后弹栈不再拦。
 *   App.vue 的接线（if (runBack()) return;）与 MessagesView 的 push/pop 由 app-shell-test 锁形。 */
import { pushBack, popBack, runBack, isMobileNav } from "../src/stores/uiStore.js";

const out = [];
let pass = 0, fail = 0;
function ok(name, cond, extra = "") {
  out.push((cond ? "PASS  " : "FAIL  ") + name + (cond ? "" : "  → " + extra));
  cond ? pass++ : fail++;
}

/* 0) 空栈：不拦截（→ App.vue 继续回退路由 / 根视图最小化） */
ok("B1 空栈 runBack()=false（不吞返回键）", runBack() === false);

/* 1) 单层：返回 true 才算已处理（栈里只有它时被调用一次） */
let hits = 0;
const lv1 = () => { hits++; return true; };
pushBack(lv1);
ok("B2 栈顶返回 true → runBack()=true（已处理）+ 被调用一次", runBack() === true && hits === 1);
popBack(lv1);

/* 2) 全层放行（例：用户已在「私信」段）→ false，让 App.vue 继续回退路由 / 最小化 */
const lvPass = () => false;
pushBack(lvPass);
ok("B3 全层返回 false → runBack()=false（放行给路由/最小化）", runBack() === false);
popBack(lvPass);

/* 3) 后进先出：通知段压在列表层之上 → 先问通知段；它卸载后再轮到列表层 */
const order = [];
const listLv = () => { order.push("list"); return true; };
const notifLv = () => { order.push("notif"); return true; };
pushBack(listLv); pushBack(notifLv);
const first = runBack();
popBack(notifLv);
const second = runBack();
ok("B4 后进先出（通知段先拦，它卸载后列表层接手）",
  first === true && second === true && order.join(">") === "notif>list", order.join(">"));

/* 3b) 顶层放行时下层仍能接手（嵌套两级：弹层关掉后 → 段位仍能拦） */
const passLv = () => { order.push("pass"); return false; };
pushBack(passLv);
const third = runBack();
ok("B4b 顶层 false → 下层接手（否则整页会直接退出去）",
  third === true && order.slice(-1)[0] === "list", order.join(">"));
popBack(passLv);

/* 3c) 拦截器抛异常不能吞返回键（视为不处理 → 继续往下 / 最终放行） */
popBack(listLv);
const boomLv = () => { throw new Error("boom"); };
pushBack(boomLv);
ok("B4c 拦截器异常 → 当作不处理（不会白吞一次返回键）", runBack() === false);
popBack(boomLv);

/* 4) 卸载弹栈（onBeforeUnmount）→ 不再拦截 */
popBack(lv1);
ok("B5 全部弹栈后 runBack()=false（离开页面不残留拦截）", runBack() === false);

/* 5) 弹不存在的函数：不误伤其它层 */
const keep = () => true;
pushBack(keep); popBack(() => true);
ok("B6 popBack 陌生函数不误删（栈仍有效）", runBack() === true);
popBack(keep);

/* 6) 形态判定仍是「App 或窄视口」（返回键策略的前提） */
ok("B7 isMobileNav 在 Node 侧为 false（无 window/非原生壳，与真机判定口径一致）", isMobileNav.value === false);

out.push("");
out.push(`TOTAL ${pass + fail}  PASS ${pass}  FAIL ${fail}`);
console.log(out.join("\n"));
process.exit(fail ? 1 : 0);
