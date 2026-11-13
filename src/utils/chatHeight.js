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
export function pickChatRect(innerH, vvH, vvTop, kbH, availH) {
  const vv = pos(vvH);
  const t0 = pos(vvTop);
  /* 轮 507 · 第 5 个参数「真实可视高」：Safari 的底部工具栏盖在页面之上，
   * innerHeight / visualViewport 都不扣它（由 viewportVars 的 svh/dvh 探针量出来）。
   * 容器高必须取这个更小的值，否则盒子底边落到工具栏下面 —— 贴着盒底的表情面板
   * 最后一排正好被吃掉（用户视频里只露出 2 排）。
   * 不传（老调用 / 单测）时行为与改之前完全一致。 */
  const inner = pos(innerH);
  const avail = pos(availH);
  const effInner = avail > 0 && avail < inner ? avail : inner;
  const picked = pickChatHeight(effInner, vv, kbH);
  if (!picked.h) return { h: 0, top: 0, kbOpen: false };
  let h = picked.h;
  let kbOpen = picked.kbOpen;
  if (t0 > 0 && vv > 0 && vv < h) { h = Math.round(vv); kbOpen = true; }
  return { h, top: pickChatTop(inner, t0, h), kbOpen };
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
 * `--kbb` 该取多少 —— 吸底条 / 表情面板离**布局视口底**要抬多高。
 *
 * 这个量只在 **overlay 型内核**（iOS Safari：键盘浮在页面上、布局视口不缩，
 * 底部工具栏也浮在页面之上）才有意义：fixed 元素的 bottom 参照布局视口底，
 * 而用户看到的是可视区底，两者差的那一截就是它。
 *
 * resize 型（安卓 / 小米）**必须恒 0**：布局视口就是可视区，没有这一截。
 * 直接套 `inner − vv高度` 会在小米上算出 31px 的假让位 —— 那 31px 是
 * 这个内核把 `visualViewport.height` 常年报小造成的噪声（见 tools/chat-height-test
 * 的「已知内核样本」），不是工具栏。假让位的后果：吸底条平白浮起 31px、
 * 表情面板整体上移 31px，条和面板之间、面板和屏底之间各露一条空白
 * （用户 2026-11-14 两张截图红框）。
 *
 * @param {number} innerH   布局视口高（innerHeight）
 * @param {number} vvH      可视视口高
 * @param {number} vvTop    可视视口上推量
 * @param {boolean} overlay 是否 overlay 型内核
 * @param {number} fix      闭环修正量（只给 overlay 型用）
 */
export function kbbValue(innerH, vvH, vvTop, overlay, fix) {
  if (!overlay) return 0;
  const inner = pos(innerH);
  const v = pos(vvH);
  const top = pos(vvTop);
  if (!inner) return 0;
  const visBottom = v > 0 ? Math.min(inner, top + v) : inner;
  return Math.max(0, inner - visBottom) + (Number.isFinite(fix) ? Math.round(fix) : 0);
}

/**
 * 无键盘基线要不要换成「当前视口高」。
 *
 * 基线（base）是整条高度推导的锚点：面板高 = base − 键盘态 inner。
 * 它在开机那一帧取定（工具栏一定是展开的），之后冻结 —— 因为滚动时工具栏会临时收起，
 * inner 从 744 跳到 799，拿它当基线会让面板高变成 315 而不是 260。
 *
 * 但工具栏**真的收起来不再展开**时（用户往下滚、或切到别的页回来），
 * `inner − base` 就变成一笔常驻的 24px：`--kb-over` 一直非 0，吸底条永久浮起 24px。
 * 所以过冲要分两种：
 *   · 瞬时（实测 140ms 就回来）→ 只让 --kb-over 抵掉，不动基线；
 *   · 稳定（同一个值连续保持 ≥ ADOPT_MS）→ 认它为新基线，过冲归零。
 *
 * @param {number} base     当前基线
 * @param {number} inner    当前布局视口高
 * @param {boolean} kbUp    键盘是否在屏上（键盘态基线不可信，绝不采纳）
 * @param {number} sameMs   当前这个 inner 已经稳定保持了多久（ms）
 * @returns {boolean} 是否采纳
 */
export const BASE_ADOPT_MS = 500;
export function shouldAdoptBase(base, inner, kbUp, sameMs) {
  const b = pos(base);
  const i = pos(inner);
  if (kbUp || !b || !i) return false;
  /* 两个方向都要认：工具栏收起（inner 变大）要跟上去，工具栏重新展开（inner 变小）
   * 也要跟回来。只认一个方向，另一边就会留下同样一笔 24px 的错位。 */
  if (Math.abs(i - b) <= 8) return false;
  return pos(sameMs) >= BASE_ADOPT_MS;
}

/* ═══ 轮 525 · 不依赖内核类型的键盘度量 ═══
 *
 * 用户「其他浏览器呢，有没有做预防性措施」之后，用 8 组内核读数把真实代码跑了一遍
 * （_scratch/probe/kernel.mjs，小米 393×744 真机 + 视口只读属性覆盖）：
 * 只有 Chromium 原生 / 小米 / X5 三种 resize 型是对的，另外五种全错：
 *
 *   · 大噪声内核（无键盘时 vv 就比 inner 小 200）→ 旧判据 `base − vvH ≥ 150`
 *     在**页面刚打开**就成立，于是键盘一「出现」就把内核判成 overlay，kbb 抬 200px。
 *   · 内核不报 vv（height 恒 0）→ `vvH > 0 &&` 让 kbUp 恒假，面板高永远锁不上，
 *     更糟的是基线会被键盘态的 484 采纳（shouldAdoptBase 以为那是工具栏收起）。
 *   · overlay 但不上推（Firefox 安卓 resizes-visual）→ kbNow 取 vtop 恒 0，
 *     让位算式完全不动，输入条被键盘整个盖住。
 *   · 键盘动画错帧（vv 先掉、inner 后掉）→ 第一帧 inner 只缩了 124，
 *     旧判据算出「inner 没跟着缩」→ 判成 overlay，且只判一次、永不回头。
 *
 * 共同根因：所有判据都在拿「与基线的绝对差」和固定阈值比，而**噪声也在这个差里**。
 * 改成拿「变化量」比：vv 的噪声在开机基线 vvBase 里同样存在，相减就抵掉了。
 */

/**
 * 键盘此刻把可见高度吃掉了多少 —— 与内核类型无关的唯一度量。
 *
 *   resize 型（安卓 / 小米 / X5）：布局视口被压小 → base − inner
 *   overlay 型（iOS / FF 安卓 resizes-visual）：布局视口不动，可视视口缩小 → vvBase − vvH
 *
 * 两条都算、取大者：调用方不需要先知道是哪种内核，也不会因为 vv 常年报小
 * （小米 31px、更狠的内核 200px）而多算 —— vvBase 里带着同样的偏移量。
 *
 * @param {number} base    无键盘时的 innerHeight
 * @param {number} inner   当前 innerHeight
 * @param {number} vvBase  无键盘时的 visualViewport.height（不认识 vv 的内核传 0）
 * @param {number} vvH     当前 visualViewport.height
 */
export function kbHeightNow(base, inner, vvBase, vvH) {
  const b = pos(base);
  const i = pos(inner);
  const vb = pos(vvBase);
  const v = pos(vvH);
  const shrink = b > 0 && i > 0 ? Math.max(0, b - i) : 0;
  const drop = vb > 0 && v > 0 ? Math.max(0, vb - v) : 0;
  return Math.round(Math.max(shrink, drop));
}

/**
 * 键盘在不在屏上。
 *
 * 阈值 150：比浏览器工具栏（真机最大 55~81）大一个量级，比真键盘（≥200）小一档。
 * 认的是「可见高度真的少了 150 以上」，所以一个从来不报 vv 的内核也能靠
 * resize 那一支走通（旧写法在这种情况下 kbUp 恒假）。
 */
export function kbIsUp(base, inner, vvBase, vvH, min) {
  const m = Number.isFinite(min) ? min : 150;
  return kbHeightNow(base, inner, vvBase, vvH) >= m;
}

/**
 * 内核分流：布局视口跟着缩 = resize；只有可视视口缩 = overlay。
 *
 * 为什么不看「inner 有没有缩满 150」：键盘动画是两段式的，实测错帧那一帧
 * vv 已经掉到 550、inner 还停在 620（只缩 124）。按绝对阈值判会当场判成 overlay，
 * 而且旧代码只判一次、永不回头 —— 整场都错。
 * 按比值判：inner 缩量不到 vv 缩量的一半，才算 overlay。
 * 错帧时 124 / 194 → 68% ≥ 50% → 仍是 resize，等它缩到底是同一个结论。
 *
 * @returns {"resize"|"overlay"|""}  "" = 这一帧还看不出来（两路都没动）
 */
export function pickKbKind(base, inner, vvBase, vvH) {
  const b = pos(base);
  const i = pos(inner);
  const vb = pos(vvBase);
  const v = pos(vvH);
  const shrink = b > 0 && i > 0 ? Math.max(0, b - i) : 0;
  const drop = vb > 0 && v > 0 ? Math.max(0, vb - v) : 0;
  if (drop <= 0) return shrink > 0 ? "resize" : "";
  return shrink < drop / 2 ? "overlay" : "resize";
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
