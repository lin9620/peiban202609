/* 轮 342 · 暖心墙输入框（一级/二级/底部条共用）的纯逻辑
 * ------------------------------------------------------------
 * 只放「不碰 DOM」的两件小事，Node 里直接测：
 *   ① 表情插到光标处（有选区就替换选区；超长按 maxlength 截断）
 *   ② 回车到底发不发（桌面 Enter 发；手机/Shift+Enter/输入法组合中不发）
 * 组件 WpComposer.vue 只负责画和事件。
 */

export function insertText(value, start, end, insert, maxLen = 0) {
  const s = String(value == null ? "" : value);
  const add = String(insert == null ? "" : insert);
  let a = Number.isFinite(start) ? Math.trunc(start) : s.length;
  let b = Number.isFinite(end) ? Math.trunc(end) : a;
  a = Math.max(0, Math.min(a, s.length));
  b = Math.max(a, Math.min(b, s.length));
  let next = s.slice(0, a) + add + s.slice(b);
  if (maxLen > 0 && next.length > maxLen) next = next.slice(0, maxLen);
  const caret = Math.min(a + add.length, next.length);
  return { value: next, caret };
}

/* 表情面板往上弹还是往下弹：上方够高就往上；否则哪边空间大往哪边。
 * 暖心墙桌面主评论框贴着页面顶时，往上弹会被视口裁掉半截，必须往下。 */
export function pickerOpensUp(top, bottom, viewportH, panelH, gap = 8) {
  const t = Number(top);
  const b = Number(bottom);
  const vh = Number(viewportH);
  const ph = Number(panelH);
  if (!Number.isFinite(t) || !Number.isFinite(b) || !Number.isFinite(vh) || !Number.isFinite(ph)) return true;
  const above = t - gap;
  const below = vh - b - gap;
  return above >= ph || above >= below;
}

export function enterSends(e, mobile = false) {
  if (!e || mobile) return false;
  if (e.key !== "Enter") return false;
  if (e.shiftKey) return false;
  /* 中文/日文输入法选词时的回车不能当发送（keyCode 229 是老浏览器口径） */
  if (e.isComposing || e.keyCode === 229) return false;
  return true;
}
