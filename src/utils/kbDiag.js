/* 轮 463 · 键盘现场自检条（只在 URL 带 ?kbdiag=1 时出现，正常用户看不到）。
 *
 * 为什么要有它：iOS Safari / 小米浏览器的输入法行为没法在桌面模拟器里复现，
 * 之前两轮只能靠「猜 + 桌面合成」，改完真要用户拿手机试。这里把决定布局的几个数
 * 直接画在屏幕上，用户截一张图就能定位是「变量没写 / 类没挂 / 选择器没命中」哪一环。
 *
 * 用法：https://warmpaws.de5.net/messages/xxx?kbdiag=1  然后点开输入框，截图。
 * 关掉：把 URL 里的 ?kbdiag=1 删掉刷新（或点右上角 ×）。
 */
import { pickChatHeight } from "./chatHeight.js";

export function installKbDiag() {
  try {
    if (typeof location === "undefined" || !/[?&]kbdiag=1/.test(location.search)) return;
    if (document.getElementById("wp-kbdiag")) return;

    const box = document.createElement("div");
    box.id = "wp-kbdiag";
    box.style.cssText = [
      "position:fixed", "left:0", "right:0", "top:0", "z-index:2147483000",
      "background:rgba(10,10,14,.9)", "color:#7dffa8", "padding:6px 34px 6px 8px",
      "font:11px/1.5 ui-monospace,Menlo,Consolas,monospace", "white-space:pre-wrap",
      "word-break:break-all", "pointer-events:none", "border-bottom:1px solid #2c2c34",
    ].join(";");
    const close = document.createElement("button");
    close.textContent = "×";
    close.style.cssText = "position:absolute;right:6px;top:4px;width:24px;height:24px;"
      + "border:0;border-radius:6px;background:#2c2c34;color:#e8e8f0;font-size:14px;pointer-events:auto";
    close.onclick = () => box.remove();
    box.appendChild(close);
    document.body.appendChild(box);

    const px = (v) => Math.round(Number(v) || 0);
    const paint = () => {
      const html = document.documentElement;
      const vv = window.visualViewport || {};
      const kbVar = getComputedStyle(html).getPropertyValue("--kb-h").trim();
      const page = document.querySelector(".dm-page");
      const wrap = document.querySelector(".dm-page > .dm-wrap") || document.querySelector(".dm-wrap");
      const thread = document.querySelector(".dm-thread");
      const scroll = document.querySelector(".dm-scroll");
      const shell = document.querySelector(".shell");
      const foot = document.querySelector(".dm-compose") || document.querySelector(".vac-room-footer")
        || document.querySelector('[class*="room-footer"]') || document.querySelector('[class*="footer"]');
      const lines = [
        `kb-web=${html.classList.contains("kb-web") ? "on" : "off"}  --kb-h=${kbVar || "无"}  shell=${html.dataset.theme || "-"}`,
        `innerH=${px(window.innerHeight)}  innerW=${px(window.innerWidth)}  vvH=${px(vv.height)}  vvTop=${px(vv.offsetTop)}  scale=${(vv.scale || 1).toFixed(2)}`,
        `page=${page ? px(page.getBoundingClientRect().height) : "-"}  thread=${thread ? px(thread.getBoundingClientRect().height) : "-"}  样式=${page ? Math.round(parseFloat(getComputedStyle(page).height) || 0) : "-"}`,
        /* 轮 465：网页端改用 fixed 精确覆盖可视视口，这几项直接决定成败 */
        `fix=${html.classList.contains("wp-chat-fix") ? "on" : "off"}  pos=${page ? getComputedStyle(page).position : "-"}  内联h=${page ? (page.style.height || "无") : "-"}  top=${page ? (page.style.top || "无") : "-"}`,
        `dvh=${typeof CSS !== "undefined" && CSS.supports ? CSS.supports("height", "100dvh") : "?"}  cssH=${page ? getComputedStyle(page).height : "-"}`,
        /* 轮 468：换浏览器排查用 —— 显示「按内核语义选了哪个值」，不是随便哪个数 */
        `pick=${(() => {
          const r = pickChatHeight(window.innerHeight, vv.height, kbVar);
          return `h=${r.h}  ${r.kbOpen ? "键盘态→取vv" : "无键盘→取inner"}  差=${px(window.innerHeight - (vv.height || 0))}`;
        })()}`,
        `docScroll=${px(document.documentElement.scrollTop)}  docH=${px(document.documentElement.scrollHeight)}  htmlOv=${getComputedStyle(html).overflow}`,
        /* 轮 469：评论区「打字看不见」排查 —— 焦点到底落在谁身上、那个框在屏幕哪里。
         * 只看 on=1 还不够，要看 t/b 是否落在可视区底以内（被键盘盖住就是 b > 可见高）。 */
        `act=${(() => {
          const a = document.activeElement;
          if (!a || a === document.body) return "无";
          const r = a.getBoundingClientRect();
          const c = typeof a.className === "string" ? a.className.trim().split(/\s+/)[0] : "";
          const ro = a.readOnly || a.getAttribute("readonly") != null ? 1 : 0;
          return `${a.tagName.toLowerCase()}${c ? "." + c : ""} t${px(r.top)}~b${px(r.bottom)} ro=${ro} dis=${a.disabled ? 1 : 0}`;
        })()}`,
        `bar=${(() => {
          const b = document.querySelector(".cmt-main-bar");
          if (!b) return "无";
          const r = b.getBoundingClientRect();
          return `t${px(r.top)}~b${px(r.bottom)}h${px(r.height)}/${getComputedStyle(b).position}`
            + ` 内联t=${b.style.top || "无"} 内联b=${b.style.bottom || "无"}`;
        })()}  entry=${document.querySelector(".cmt-entry") ? "有" : "无"}`,
        `login=${(() => {
          try {
            return localStorage.getItem("sb-rwulplykvipkshkxyxfe-auth-token") ? "已登录" : "未登录";
          } catch (e) { return "?"; }
        })()}`,
        `壳=${shell ? shell.className : "-"}`,
        `foot.bottom=${foot ? px(foot.getBoundingClientRect().bottom) : "-"}  屏底=${px(window.innerHeight)}`,
        /* 轮 466：输入条下方那条空白定性用 —— 谁没贴底、差多少 */
        `wrap=${wrap ? `${px(wrap.getBoundingClientRect().top)}~${px(wrap.getBoundingClientRect().bottom)}h${px(wrap.getBoundingClientRect().height)}` : "-"}`,
        `thr=${thread ? `${px(thread.getBoundingClientRect().top)}~${px(thread.getBoundingClientRect().bottom)}h${px(thread.getBoundingClientRect().height)}` : "-"}  thrCss=${thread ? getComputedStyle(thread).height : "-"}`,
        `thrPad=${thread ? `b${getComputedStyle(thread).paddingBottom}/m${getComputedStyle(thread).marginBottom}` : "-"}  dpad=${page ? `b${getComputedStyle(page).paddingBottom}` : "-"}`,
        `cmp=${foot ? `t${px(foot.getBoundingClientRect().top)}~b${px(foot.getBoundingClientRect().bottom)} h${px(foot.getBoundingClientRect().height)}/${getComputedStyle(foot).position} mb${getComputedStyle(foot).marginBottom} pb${getComputedStyle(foot).paddingBottom}` : "null"}`,
        ...(() => {
          /* 轮 466：手机上真正画输入条的是 vue-advanced-chat，把它的高度链整条摊开 */
          const sels = [".dm-thread > *", ".dm-vac-box", ".dm-vac", ".vac-app", ".vac-room",
            ".vac-room-footer", ".vac-input", ".vac-footer-input-wrapper"];
          const out = sels.map((s) => {
            const el = document.querySelector(s);
            if (!el) return s.replace(/^\./, "").replace(/ .*/, "") + ":无";
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            return `${s.split(".").pop()}:${px(r.top)}~${px(r.bottom)}/${px(r.height)}/${cs.flexGrow}`;
          });
          return [out.slice(0, 4).join("  "), out.slice(4).join("  ")];
        })(),
        ...(() => {
          /* 轮 466c：宿主是 open shadow —— 直接进去量「谁没贴底」 */
          const root = document.querySelector(".dm-vac");
          if (!root) return ["sh:无宿主"];
          const sr = root.shadowRoot;
          if (!sr) return ["sh:closed"];
          const hostCs = getComputedStyle(root);
          const sels = [".vac-app", ".vac-container", ".vac-room", ".vac-room-container",
            ".vac-container-scroll", ".vac-room-footer", ".vac-box-footer", ".vac-textarea"];
          const out = sels.map((s) => {
            const el = sr.querySelector(s);
            if (!el) return s.slice(1) + ":无";
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            return `${s.slice(1)}:${px(r.top)}~${px(r.bottom)}/${px(r.height)}/pb${px(cs.paddingBottom)}`;
          });
          return [
            `host h=${hostCs.height}/${px(root.getBoundingClientRect().height)} sb=${sr.querySelectorAll("*").length}`,
            out.slice(0, 4).join("  "),
            out.slice(4).join("  "),
          ];
        })(),
        `scroll st=${scroll ? px(scroll.scrollTop) : "-"}/${scroll ? px(scroll.scrollHeight) : "-"}/${scroll ? px(scroll.clientHeight) : "-"}`,
        `cls=${html.className.slice(0, 60)}  ${(document.querySelector('script[type="module"]') || {}).src
          ? String(document.querySelector('script[type="module"]').src).split("/").pop() : "-"}`,
      ];
      box.textContent = lines.join("\n");
      box.appendChild(close);   /* textContent 会清掉子节点，按钮补回去 */
    };
    paint();
    setInterval(paint, 400);
  } catch (e) { /* 自检条不能影响正常使用 */ }
}
