/* ═══ 轮 468 · 聊天容器高度决策（纯函数，无 DOM）═══
 *
 * 为什么单独抽出来：前几轮的教训是「在一台机器上调到一个数字，换台设备又崩」。
 * 各家内核对 innerHeight / visualViewport.height 的语义并不统一，实测样本：
 *
 *   内核                        无键盘                              键盘弹起
 *   Chrome / Chromium           innerH == vv.height == 真实可见高    两者同时缩（resizes-content）
 *   小米自带浏览器（MIUI 14）    innerH 对（768）· vv 少 31px（737）  两者同时缩
 *   iOS Safari                  innerH == vv.height                   innerH 不变，只有 vv 缩
 *   部分国产内核（overlay 键盘）  innerH == 真实可见高                  innerH 不变，只有 vv 缩
 *
 * 唯一在**所有**样本上都成立的两条：
 *   ① 无键盘时 innerHeight 等于真实可见高（工具栏伸缩改的就是布局视口高度）；
 *   ② 有键盘时只有 visualViewport.height 会跟着键盘缩。
 * 所以不猜偏移量、不取平均、不做经验补偿 —— 就按「有没有键盘」二选一。
 *
 * 键盘判据也不只靠 --kb-h：老 iOS / 部分国产内核不派发驱动事件，--kb-h 可能一直是 0，
 * 但 vv 已经缩了。此时「inner - vv > 100」兜底（浏览器工具栏一般 ≤ 80px，有量级余量）。
 */

/** 「键盘是否占位」的兜底阈值：inner 与 vv 的差超过它就认为键盘弹出。
 *  取 100 而不是 80：给工具栏/缩放留余量，宁可漏判（走 inner，最多不多留白）
 *  也不要误判（走 vv，会平白矮一截留出空白）。 */
export const KB_GAP = 100;

function pos(v) {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * @param {number} innerH  布局视口高（innerHeight）
 * @param {number} vvH     可视视口高（visualViewport.height）
 * @param {number} kbH     CSS 变量 --kb-h 的当前值
 * @returns {{h:number, kbOpen:boolean}} h=0 表示数据不可用，调用方应放弃接管
 */
export function pickChatHeight(innerH, vvH, kbH) {
  const inner = pos(innerH);
  const vv = pos(vvH);
  const kb = pos(kbH);

  if (!inner && !vv) return { h: 0, kbOpen: false };
  if (!inner) return { h: Math.round(vv), kbOpen: true };
  if (!vv) return { h: Math.round(inner), kbOpen: false };

  const kbOpen = kb > 0 || inner - vv > KB_GAP;
  return { h: Math.round(kbOpen ? vv : inner), kbOpen };
}

/**
 * fixed 容器的 top：只在键盘把可视视口顶开时才有位移，且不能超过「布局视口 - 容器高」，
 * 否则极端情况下会把整页推出屏幕。无键盘时恒为 0。
 */
export function pickChatTop(innerH, vvTop, h) {
  const inner = pos(innerH);
  const top = pos(vvTop);
  const height = pos(h);
  if (!inner || !height) return 0;
  const maxTop = Math.max(0, inner - height);
  return Math.min(top, maxTop);
}

/**
 * 轮 503 · 聊天页那一块 fixed 盒子该占哪一段：{h, top, kbOpen}。
 *
 * 唯一权威的判据是「此刻能看见哪一块」= [vvTop, vvTop + vvHeight]。
 * 单独抽出来是因为踩过一次：iOS 为露出光标会把可视视口**上推**（vvTop > 0），
 * 而旧代码只在「判定键盘态」时才用 vv.height —— 于是页面仍是整屏高，
 * iOS 一推，整页跟着跑到屏幕上方：输入条贴在地址栏底下、下面一大片空白、
 * 消息一条不见（用户四张截图里的第 4 张）。
 *
 * 规则：只要 vvTop > 0 且 vvHeight 比容器矮，就把容器裁到 vvHeight。
 * 这不是「猜」，是把容器裁进**可证明可见**的那一段。
 */
export function pickChatRect(innerH, vvH, vvTop, kbH) {
  const vv = pos(vvH);
  const t0 = pos(vvTop);
  const picked = pickChatHeight(innerH, vv, kbH);
  if (!picked.h) return { h: 0, top: 0, kbOpen: false };
  let h = picked.h;
  let kbOpen = picked.kbOpen;
  if (t0 > 0 && vv > 0 && vv < h) { h = Math.round(vv); kbOpen = true; }
  return { h, top: pickChatTop(innerH, t0, h), kbOpen };
}

/** 浏览器工具栏的量级上限。比它矮的「差值」一律当成工具栏，不当键盘。
 *  真键盘最低也 ≥ 200px，80 两边都不误伤。 */
export const TOOLBAR_GAP = 80;

/**
 * 网页端 --kb-h 该取多少（评论条 / 回复栏靠它让位）。
 *
 * 坑：小米浏览器无键盘时 vv 比 inner 矮 31px（工具栏被重复扣一次）。如果只按
 * 「输入框有焦点」就让位，这 31px 会被当成键盘 → 输入条整体抬 31px，下方平白留白。
 * 所以焦点只是「加速」，两个条件都必须先过工具栏闸门。
 *
 * @param {number} raw     kbWebInset 算出的原始差值
 * @param {boolean} focused 当前是否聚焦在可编辑元素上
 */
export function kbInsetValue(raw, focused) {
  const r = pos(raw);
  if (r <= TOOLBAR_GAP) return 0;
  return focused || r > KB_GAP ? r : 0;
}

/**
 * 吸底条（暖心墙评论条 / 详情页回复栏）该钉在哪 —— 返回相对 ICB 顶的 top（px）。
 *
 * 为什么不继续用 `bottom: var(--kb-h)`：
 *   那是**间接推导**——只要 --kb-h 在某个内核上没算出来（事件不派发、焦点判据失效、
 *   缩放保护误触），条就停在 bottom:0，被键盘整个盖住，用户「打字看不见」。
 *   这里直接读 visualViewport：可见区底 = 键盘态 ? offsetTop + vv.height : innerHeight，
 *   条贴上去就完事，不经过任何中间变量。判据与聊天容器共用 pickChatHeight。
 *
 * @param {number} innerH 布局视口高
 * @param {number} vvH    可视视口高
 * @param {number} vvTop  可视视口位移
 * @param {number} kbH    --kb-h 当前值
 * @param {number} barH   条自身高度
 */
export function fixedBarTop(innerH, vvH, vvTop, kbH, barH) {
  const inner = pos(innerH);
  const bar = pos(barH);
  if (!inner || !bar) return 0;
  const { h, kbOpen } = pickChatHeight(inner, vvH, kbH);
  if (!h) return 0;
  /* 无键盘时不能用 vv.offsetTop：那时它是脏值（有的内核会残留上次的值），
   * 而可见区底就是 innerHeight，直接减条高即可。 */
  const bottomEdge = kbOpen ? pos(vvTop) + h : h;
  return Math.round(Math.max(0, bottomEdge - bar));
}
