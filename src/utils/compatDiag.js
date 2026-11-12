/* 轮 502 · 跨机型兼容自检（只在 URL 带 ?diag=1 时出现，正常用户看不到）。
 *
 * 为什么要有它：iOS Safari 的问题是「某一台机器上某一条 CSS 没生效」，而这类事没法在
 * Windows 上远程点按复现，我也不该按「iPhone 14 Pro 852×393」去猜常量（轮 500 的教训：
 * 按屏幕尺寸写死的值换块屏就废）。所以反过来 —— 让每台机器自己把能力报上来：
 * 这里全部走 CSS.supports / getComputedStyle / visualViewport 实测，**不读 UA 做分支**
 * （UA 只原样打印出来给人看，不参与任何判断）。
 *
 * 用法：https://warmpaws.de5.net/?diag=1  →  点「复制」把纯文本发我，比截图准。
 * 关掉：把 URL 里的 ?diag=1 删掉刷新。
 */
import { copyText } from "./clipboard.js";

/* 我们真正依赖的能力。加一项就是给未来留一条证据。 */
const PROBES = [
  ["100dvh", "height: 100dvh"],
  ["100svh", "height: 100svh"],
  ["dvh-unit", "height: 1dvh"],
  ["backdrop-filter", "backdrop-filter: blur(1px)"],
  ["-webkit-backdrop-filter", "-webkit-backdrop-filter: blur(1px)"],
  [":has()", "selector(:has(*))"],
  ["aspect-ratio", "aspect-ratio: 1"],
  ["inset-shorthand", "inset: 0"],
  ["overscroll-behavior", "overscroll-behavior: contain"],
  ["text-wrap:balance", "text-wrap: balance"],
  ["color-mix()", "color: color-mix(in srgb, red, blue)"],
  ["gap(flex)", "gap: 1px"],
  ["position:sticky", "position: sticky"],
  ["env(safe-area)", "padding-top: env(safe-area-inset-top)"],
  ["-webkit-line-clamp", "-webkit-line-clamp: 2"],
  ["touch-action", "touch-action: manipulation"],
];

const supports = (prop) => {
  try { return typeof CSS !== "undefined" && CSS.supports ? CSS.supports(prop) : null; }
  catch (e) { return null; }
};

export function installCompatDiag() {
  try {
    if (typeof location === "undefined" || !/[?&]diag=1/.test(location.search)) return;
    if (document.getElementById("wp-diag")) return;

    const px = (v) => Math.round(Number(v) || 0);
    /* 安全区不能读 —— env() 不是可查询的量，只能挂个探针元素让浏览器算一遍再读回来 */
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;visibility:hidden;"
      + "padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)";
    document.body.appendChild(probe);
    const safe = () => {
      const cs = getComputedStyle(probe);
      return { t: px(cs.paddingTop), r: px(cs.paddingRight), b: px(cs.paddingBottom), l: px(cs.paddingLeft) };
    };

    /* 轮 508 · 视口单位探针（现场量，不是查支持表）。
     * 这三个数就是「这台机/这个系统认哪个单位」的全部证据：
     *   iOS 15–18：svh == dvh == inner（工具栏已在 inner 里扣掉）
     *   iOS 26   ：inner > svh == dvh（inner 是含玻璃栏的大视口，栏收放时 dvh 会变）
     *   X 内置   ：svh > dvh（svh 被报成 lvh，是错的）
     * 用户报「这台不对」时，有这三行就能立刻判断该走哪条分支，不用再猜。 */
    const vhProbe = document.createElement("div");
    vhProbe.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:0;visibility:hidden;pointer-events:none";
    document.body.appendChild(vhProbe);
    const mh = (css) => { vhProbe.style.height = css; return px(vhProbe.getBoundingClientRect().height); };
    const unitProbe = () => ({ svh: mh("100svh"), dvh: mh("100dvh"), lvh: mh("100lvh") });

    /* 键盘态：记下没有输入框聚焦时的可视视口高，聚焦后再取一次 —— 差值就是键盘真实高度。
       这一行能直接判定「iOS 只改 visualViewport、不改 innerHeight」到底成不成立。 */
    let baseline = null;
    let kbSeen = null;
    document.addEventListener("focusin", () => {
      if (baseline == null && window.visualViewport) baseline = px(window.visualViewport.height);
      setTimeout(() => {
        const vv = window.visualViewport;
        if (vv && baseline != null) kbSeen = { vvH: px(vv.height), drop: baseline - px(vv.height), innerH: px(window.innerHeight) };
        paint();
      }, 360);
    }, true);

    const box = document.createElement("div");
    box.id = "wp-diag";
    box.style.cssText = [
      "position:fixed", "left:0", "right:0", "top:0", "z-index:2147483001",
      "max-height:64vh", "overflow:auto",
      "background:rgba(8,10,14,.94)", "color:#8fe3ff", "padding:8px 76px 10px 9px",
      "font:11px/1.55 ui-monospace,Menlo,Consolas,monospace", "white-space:pre-wrap",
      "word-break:break-word", "border-bottom:1px solid #26313c",
    ].join(";");

    const btn = (text, right, fn) => {
      const b = document.createElement("button");
      b.textContent = text;
      b.style.cssText = "position:absolute;top:6px;right:" + right + "px;height:24px;padding:0 8px;border:0;"
        + "border-radius:6px;background:#26313c;color:#dceaf7;font:11px/24px ui-monospace,monospace;cursor:pointer";
      b.onclick = fn;
      return b;
    };

    const report = () => {
      const html = document.documentElement;
      const vv = window.visualViewport || {};
      /* 这几个变量全部定义在 <html> 上（--sat/--sab 只在 html.cap-app 有），
         从 html 读就对了 —— 之前试着读 .shell--mobile-nav 是读错了宿主。 */
      const cs = getComputedStyle(html);
      const safeNow = safe();
      const up = unitProbe();
      /* viewportVars 的判定结果（只读，不改行为）。它才是「吸底条/面板为什么在那」的答案：
         kb=键盘本体高 · kbb=让位量 · bars=浏览器 UI 遮挡基线 · src=--vph 取自哪个单位 */
      const wv = window.__wpVars || null;
      const caps = PROBES.map(([name, prop]) => {
        const v = supports(prop);
        return name + (v === true ? "=✓" : v === false ? "=✗" : "=?");
      });
      return [
        "—— Warm Paws 兼容自检 · 轮 508 ——",
        "UA: " + (navigator.userAgent || "-"),
        "屏: " + px(screen.width) + "×" + px(screen.height) + "  dpr=" + (window.devicePixelRatio || 1),
        "inner: " + px(window.innerWidth) + "×" + px(window.innerHeight)
          + "  vv: " + px(vv.height) + "x" + px(vv.width) + " top=" + px(vv.offsetTop) + " scale=" + (vv.scale || 1).toFixed(2),
        "安全区 env(): t" + safeNow.t + " r" + safeNow.r + " b" + safeNow.b + " l" + safeNow.l,
        "变量: --sat=" + (cs.getPropertyValue("--sat") || "未定义").trim()
          + " --sab=" + (cs.getPropertyValue("--sab") || "未定义").trim()
          + " --kb-h=" + (cs.getPropertyValue("--kb-h") || "未定义").trim()
          + " --kbb=" + (cs.getPropertyValue("--kbb") || "未定义").trim()
          + " --vph=" + (cs.getPropertyValue("--vph") || "未定义").trim()
          + " --kb-last=" + (cs.getPropertyValue("--kb-last") || "未定义").trim()
          + " --kb-panel-h=" + (cs.getPropertyValue("--kb-panel-h") || "未定义").trim()
          /* --sat/--sab 只定义在 html.cap-app（原生壳）里。浏览器里读到「未定义」是**正常的**，
             不是变量丢了 —— 这句写出来，免得下一轮把正常现象当 bug 查。 */
          + (html.classList.contains("cap-app") ? "  [App 壳]" : "  [浏览器：--sat/--sab 本就未定义]"),
        "class: " + (html.className || "-") + "  theme=" + (html.dataset.theme || "-"),
        "独立窗口(PWA): " + (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches ? "是" : "否"),
        /* 轮 508：这三行是「换一台苹果手机还会不会坏」的判据，比截图有用 */
        "单位探针: svh=" + up.svh + "  dvh=" + up.dvh + "  lvh=" + up.lvh
          + "   inner=" + px(window.innerHeight)
          + "  → " + (wv ? "vph 取 " + wv.vphSrc + "=" + wv.vph : "（viewportVars 未跑）"),
        "判定: " + (wv
          ? "kb=" + wv.kb + "  kbb=" + wv.kbb + "  bars=" + wv.bars + "  kbMax=" + wv.kbMax + "  restH=" + wv.restH
          : "（未跑：可能是 App 壳，原生路径不写这些变量）"),
        "键盘实测: " + (wv && wv.kb > 0
          ? "kb=" + wv.kb + "  kbb=" + wv.kbb + "（viewportVars 实时值）"
          : kbSeen
            ? "vvH " + kbSeen.vvH + " 掉了 " + kbSeen.drop + "px  innerH=" + kbSeen.innerH
            : "（还没点过输入框）"),
        /* 轮 511 · 表情面板实测：用户报「面板下面空一大片、点空白也能选表情」。
           这三段（容器 / picker / 网格）任意一段比别的小，就能直接看出面板高度被谁吃了。
           面板在 vue-advanced-chat 的 shadowRoot 里，主文档查不到，所以逐层往下探。 */
        "表情面板: " + (() => {
          try {
            const host = document.querySelector("vue-advanced-chat");
            const sr = host && host.shadowRoot;
            const wrap = sr && sr.querySelector(".vac-emoji-picker");
            if (!wrap) return "（没开面板 / 当前不是会话页）";
            const er = wrap.getBoundingClientRect();
            const ep = wrap.querySelector("emoji-picker");
            const epr = ep && ep.getBoundingClientRect();
            const epsr = ep && ep.shadowRoot;
            const grid = epsr && epsr.querySelector(".tabpanel");
            const gr = grid && grid.getBoundingClientRect();
            const n = epsr ? epsr.querySelectorAll("button.emoji").length : 0;
            return "容器 " + px(er.height)
              + "  picker " + (epr ? px(epr.height) : "?")
              + "  网格 " + (gr ? px(gr.height) : "?")
              + "（滚动高 " + (grid ? px(grid.scrollHeight) : "?") + "）"
              + "  emoji " + n + " 个";
          } catch (e) { return "读取失败：" + (e && e.message); }
        })(),
        "能力:",
        "  " + caps.join("  "),
      ].join("\n");
    };

    /* 轮 506：正文与按钮分开 —— 以前每次 paint 都 box.textContent = report()，
       按钮跟着重建，所以只能「按需重绘」（原来只在 focusin 后刷一次）。
       但键盘高度、--kbb、--kb-panel-h 恰恰是**随时变**的三个数：
       用户点输入框 → 键盘弹起 → 点表情 → 键盘收起、面板出现，这三步里只有第一步会重绘，
       面板那一步看不到 —— 而用户要报的就是「面板跟键盘对不上」。
       现在正文放在 <pre> 里单独更新，按钮只建一次，可以放心定时刷。 */
    const pre = document.createElement("pre");
    pre.style.cssText = "margin:0;white-space:pre-wrap;word-break:break-word;font:inherit;color:inherit";
    box.appendChild(pre);

    const c = btn("复制", 34, async () => {
      c.textContent = "…";
      const ok = await copyText(report());
      c.textContent = ok ? "已复制" : "复制失败";
      setTimeout(() => { c.textContent = "复制"; }, 1800);
    });
    box.appendChild(c);
    box.appendChild(btn("×", 6, () => box.remove()));

    let lastText = "";
    const paint = () => {
      const t = report();
      /* 内容没变就不碰 DOM：键盘动画期间每帧都在变，不比较会让面板一直闪 */
      if (t !== lastText) { lastText = t; pre.textContent = t; }
    };

    document.body.appendChild(box);
    paint();
    /* 键盘起落 / 面板开关都不会触发 focusin，定时刷才能看到实时值 */
    setInterval(paint, 600);
  } catch (e) { /* 自检面板绝不影响正常使用 */ }
}
