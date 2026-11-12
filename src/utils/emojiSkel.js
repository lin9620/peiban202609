/* ═══ 表情面板骨架层（轮 521）═══
 *
 * 用户原话：「要照暖心墙那样补个骨架」。
 *
 * 病灶（真机逐帧 probe-fill）：每次点表情，库都把 <emoji-picker> 重新挂一遍，
 * shadowRoot 里的格子是这样长起来的 ——
 *     t0      17 个（只有「最近使用」那几条）
 *     t+120   179
 *     t+600   187（铺满）
 * 面板的**位置**第一帧就对了，但里面整整 0.6 秒是一块空白。位置对了、内容没来，
 * 看着就是「点了没反应」。
 *
 * 做法跟暖心墙（WpComposer 的 .wp-picker-skel）一致：面板一出现就铺一层 8 列灰块，
 * 真格子够数了就摘掉。尺寸也照抄那边（34px 行高 / 4px 间距 / 8 列），
 * 换真内容时不会看到「一小撮 → 一整屏」的跳变。
 *
 * 为什么不做成组件：面板在 vendored 库的 shadow tree 里，宿主插不进去，
 * 只能往面板容器里 append 一个绝对定位层。
 *
 * 为什么放独立文件：这段有三个容易错的边界（面板晚一帧才插入、面板被重建、
 * 数据拉不下来时要收手），单独一个模块才测得动 —— 本机 harness 直接 import 它。
 */

const SKEL_CLASS = "wp-picker-skel";
/* 格子数按「面板最高可能高度」给足：8 列 × 9 行。多出来的部分被面板裁掉，
 * 不会撑高面板。 */
const CELLS = 72;
/* 真格子到多少算「铺满了」。库先渲染 17 个（最近使用），再一次性补到 179+，
 * 40 这个界正好把前一阶段挡在外面。 */
const FILLED_AT = 40;
/* 兜底：数据拉不下来（离线 / 库停空态）时不能永远盖着骨架 —— 那比空白更像坏了。 */
const GIVE_UP_MS = 2500;
/* 面板可能晚一帧才被 Vue 插进 DOM，等 30 帧（约 0.5s）。 */
const WAIT_FRAMES = 30;

export function createEmojiSkel(hostGetter) {
  let raf = 0;
  let tries = 0;
  let at = 0;
  let node = null;

  const patchOf = () => {
    const host = hostGetter && hostGetter();
    const sr = host && host.shadowRoot;
    if (!sr) return null;
    return sr.querySelector(".vac-emoji-wrapper .vac-emoji-picker");
  };

  /* 真格子够不够数。跨内核一律 try：有的 WebView 不让读自定义元素内部的 shadowRoot。 */
  const filled = (pk) => {
    try {
      const ep = pk && pk.querySelector("emoji-picker");
      const esr = ep && ep.shadowRoot;
      if (esr && esr.querySelectorAll(".emoji").length >= FILLED_AT) return true;
    } catch (e) { /* 读不到就按「没满」处理，靠时间上限收尾 */ }
    return false;
  };

  const stop = () => {
    if (raf) { try { cancelAnimationFrame(raf); } catch (e) { /* 忽略 */ } raf = 0; }
    tries = 0;
    at = 0;
  };

  const drop = () => {
    stop();
    if (node && node.parentNode) {
      try { node.parentNode.removeChild(node); } catch (e) { /* 已随面板销毁 */ }
    }
    node = null;
  };

  const build = () => {
    const wrap = document.createElement("div");
    wrap.innerHTML = '<div class="' + SKEL_CLASS + '" aria-hidden="true">'
      + "<i></i>".repeat(CELLS) + "</div>";
    return wrap.firstElementChild;
  };

  const tick = () => {
    raf = 0;
    const pk = patchOf();
    /* 面板还没插进来（Vue 的下一帧）—— 再等一帧，别一次就放弃 */
    if (!pk) {
      if (tries++ < WAIT_FRAMES) raf = requestAnimationFrame(tick);
      else drop();
      return;
    }
    if (filled(pk) || Date.now() - at > GIVE_UP_MS) { drop(); return; }
    /* 面板被重建过（库每次开关都重建）—— 旧节点已随旧面板消失，重新铺一层 */
    if (!node || node.parentNode !== pk) {
      const old = pk.querySelector("." + SKEL_CLASS);
      if (old) old.remove();
      node = build();
      try { pk.appendChild(node); } catch (e) { /* 忽略 */ }
    }
    raf = requestAnimationFrame(tick);
  };

  const mount = () => {
    drop();
    at = Date.now();
    tries = 0;
    raf = requestAnimationFrame(tick);
  };

  return { mount, drop };
}
