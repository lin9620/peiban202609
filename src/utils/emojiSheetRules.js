/* 表情面板几何规则（App / 手机端 sheet）—— 纯函数，单测 tools/emoji-sheet-test.mjs
 * ------------------------------------------------------------
 * 用户实测（轮 179，原话）：「消息-会话，先点击输入，再点击表情，还是很长的表情，暖心墙
 * 帖子的评论也是这样。前面没有改好啊。把 app 端所有的表情展开都纳入输入框下面啊。」
 *
 * 真因不是高度参数，而是旧实现把面板写成 `top` + `bottom: "0"`：
 *   Android 键盘弹起会让布局视口变矮（windowSoftInputMode=adjustResize），点表情那一刻
 *   量到的 top 是「键盘还占着位」的坐标；随后的 blur 收起键盘 → 视口长回去 → `bottom: 0`
 *   跟着长 → 面板被拉成整整一屏，上缘却停在中间，反过来把输入行盖住。
 *   无头 Edge 实测（tools/_r179-sheet-probe.mjs，393×780，键盘占 310）：top 273 不动、
 *   高度 197 → 507，`coversInput: true`。
 *
 * 所以这里定死两条，组件只负责把结果贴到样式上：
 *   ① 面板高度是**显式 px**、贴屏底（绝不写 bottom）——视口怎么变都不会被拉伸；
 *   ② 贴底输入行按「面板高度 − 行下方现有空间」向上推开，行底正好落在面板顶：
 *      表情永远展开在输入框**下面**；页内行（不贴底）不动，面板直接挂在它下面。
 */

export const SHEET_WEB_MAX_W = 640;    /* 窄屏网页也走 sheet —— 与旧实现同口径，桌面零变化 */
export const EMOJI_SHEET_H = 208;      /* 面板**默认**高度（px）：键盘没弹时的兜底 */
export const EMOJI_SHEET_MIN_H = 132;  /* 极矮视口（横屏/小窗）下的保底高度 */
export const MIN_KEYBOARD_H = 120;     /* 短于此值不算键盘（地址栏/工具栏的视口抖动不算） */
export const MAX_KEYBOARD_RATIO = 0.55; /* 高于此比例不算键盘（顶多是折叠屏/分屏的怪视口） */

/* ── 轮 184：表情相关的 DOM 命中判定（评论/消息输入条的「点外收起」要用） ──
 * 真机 CDP 实测（tools/emo-device-drive.mjs）：点表情按钮会把整条评论条从 DOM 摘掉。
 * 真因是「面板开着就不关条」这道保险用 `document.querySelector(".emo-panel")` 现查：
 * 表情按钮 @click 把 open 置 true，面板由 Vue 在**微任务**里渲染，而输入条的收起是
 * document 上的 **click** 监听——冒泡到底那一刻 DOM 还没更新，querySelector 仍是 null，
 * 于是判定「点在表情区之外」→ 收起输入条，用户看到的就是「点表情 → 输入框消失」。
 * 面板又 <teleport to="body">，本来就不在输入条内，contains() 也拦不住。
 *
 * 正解：**不要查面板在不在 DOM，要查点击落在不在表情区的静态标记上**——按钮有
 * `.emo-root/.emo-btn`，面板里的格子在渲染后同样带 `.emo-panel` 祖先，两者都命中。
 */
export const EMO_HIT_SEL = ".emo-btn, .emo-panel, .emo-root";

/** 点击目标是否落在表情区（按钮或面板）内；非元素/无 closest 一律 false */
export function isEmojiHit(tgt) {
  if (!tgt || typeof tgt.closest !== "function") return false;
  try { return !!tgt.closest(EMO_HIT_SEL); } catch (e) { return false; }
}

/** 本次展开是「贴屏底的 sheet」还是「桌面小弹层」：App 一律 sheet；网页窄屏与旧口径一致 */
export function emojiSheetMode({ isApp = false, innerWidth = 0 } = {}) {
  return !!isApp || Number(innerWidth) < SHEET_WEB_MAX_W;
}

/**
 * 轮 182：实测「键盘此刻占了多高」（px），测不出返回 0。
 *
 * 为什么要实测：面板高度必须**等于键盘高度** —— 这是轮 182 用户原话
 * 「表情包高度跟输入法输入框高度不一致」的正解。固定 208px 时，点表情按钮收键盘、
 * 弹面板，输入行会被顶起 (键盘高 − 208) 的额外距离，松手再点表情按钮回来又是一跳；
 * 高度对齐后，键盘↔面板是**同高互换**，输入框一像素都不动（微信/QQ 同款手感）。
 *
 * @param {Object} input
 * @param {number} input.innerH 当前 window.innerHeight（键盘弹起时已被压矮）
 * @param {number} input.restH   键盘收起时的视口高（组件滚动维护的历史最大值）
 * @returns {number} 键盘高度；判定不成立时 0（调用方回落到 EMOJI_SHEET_H）
 */
export function keyboardHeight({ innerH, restH } = {}) {
  const cur = Number(innerH);
  const rest = Number(restH);
  if (!Number.isFinite(cur) || !Number.isFinite(rest) || rest <= 0) return 0;
  const kb = Math.round(rest - cur);
  if (kb < MIN_KEYBOARD_H) return 0;          /* 没有键盘 / 只是视口微抖 */
  if (kb > rest * MAX_KEYBOARD_RATIO) return 0; /* 视口整体变了，不当成键盘 */
  return kb;
}

/**
 * 面板 / 输入行的几何结果（轮 182：面板高度与键盘高度对齐）。
 * @param {Object} input
 * @param {number} input.viewportH        当前布局视口高（window.innerHeight；键盘弹起时已被压矮）
 * @param {number} input.rowBottomNatural 输入行的「未被顶开」时的 rect.bottom（**当前视口**坐标）
 * @param {boolean} input.anchored        输入行是否贴屏底（聊天 footer / 暖心墙底部输入条）
 * @param {number} [input.baseMargin]     该行原有的 margin-bottom（px），避免多次展开累加
 * @param {number} [input.sheetH]         面板目标高度（轮 182：传实测键盘高 = 与键盘同高）
 * @param {number} [input.restH]          键盘收起时的视口高（历史最大值）。**仅用于夹住面板高度上限**，
 *                                         不参与定位 —— 见下面轮 184 的更正。
 * @returns {{height:number, shift:number, margin:number, top:number, bottom:number}}
 */
export function sheetLayout({ viewportH, rowBottomNatural, anchored, baseMargin = 0, sheetH = 0, restH = 0 } = {}) {
  const vh = Math.max(0, Math.round(Number(viewportH) || 0));
  const rowB = Math.max(0, Math.round(Number(rowBottomNatural) || 0));
  /* 轮184 更正（真机 CDP 实测抓到的错）：面板必须钉在**当前**布局视口底，不能钉restH。
   * Android WebView 是 adjustResize —— 键盘弹起时布局视口本身就变矮，**视觉底== 布局底**，
   * 键盘的位置并没有「多出来一段需要还原」。早先按 restH 定位，等于把面板画到
   * 「键盘收起后才存在的那段屏幕」上：键盘弹着时面板整个落在可见区之外，
   * 而输入行被按同样错的高度顶开 → 输入行底232、面板顶 542，中间空310 的洞。
   * 面板高度仍取实测键盘高（与键盘同高互换、输入框零位移），只是**落点回到当前视口**。 */
  const rest = vh;
  /* 高度：优先用实测键盘高（面板与键盘同高互换，输入框纹丝不动）；没测到就用默认兜底。
   * 上限按收起态视口算 —— 万一键盘异常高，不能把上方内容全挤没。 */
  const ceiling = Math.max(vh, Math.round(Number(restH) || 0));
  const want = Math.round(Number(sheetH) || 0) || EMOJI_SHEET_H;
  const height = Math.max(EMOJI_SHEET_MIN_H, Math.min(want, ceiling - 132));
  /* 贴底行：行底恒等于「当前」布局视口底 —— adjustResize 下它就是视觉底。
   * 键盘弹着（vh 已矮）与收起（vh 变高）两态各自算各自的，面板始终紧贴输入行下方。 */
  const rowBottomRest = anchored ? rest : rowB;
  const top = anchored ? rest - height : Math.min(rowBottomRest, Math.max(0, rest - height));
  const shift = anchored ? Math.max(0, rowBottomRest - top) : 0;
  const base = Number.isFinite(Number(baseMargin)) ? Math.max(0, Math.round(Number(baseMargin))) : 0;
  return { height, shift, margin: base + shift, top: Math.max(0, top), bottom: rest };
}
