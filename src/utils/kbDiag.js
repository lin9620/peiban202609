/* 轮 463 · 键盘现场自检条（只在 URL 带 ?kbdiag=1 时出现，正常用户看不到）。
 *
 * 为什么要有它：iOS Safari / 小米浏览器的输入法行为没法在桌面模拟器里复现，
 * 之前两轮只能靠「猜 + 桌面合成」，改完真要用户拿手机试。这里把决定布局的几个数
 * 直接画在屏幕上，用户截一张图就能定位是「变量没写 / 类没挂 / 选择器没命中」哪一环。
 *
 * 用法：https://warmpaws.de5.net/messages/xxx?kbdiag=1  然后点开输入框，截图。
 * 关掉：把 URL 里的 ?kbdiag=1 删掉刷新（或点右上角 ×）。
 */
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
      const thread = document.querySelector(".dm-thread");
      const scroll = document.querySelector(".dm-scroll");
      const foot = document.querySelector(".dm-compose") || document.querySelector(".vac-room-footer");
      const lines = [
        `kb-web=${html.classList.contains("kb-web") ? "on" : "off"}  --kb-h=${kbVar || "无"}  shell=${html.dataset.theme || "-"}`,
        `innerH=${px(window.innerHeight)}  vvH=${px(vv.height)}  vvTop=${px(vv.offsetTop)}  scale=${(vv.scale || 1).toFixed(2)}`,
        `page=${page ? px(page.getBoundingClientRect().height) : "-"}  thread=${thread ? px(thread.getBoundingClientRect().height) : "-"}`,
        `foot.bottom=${foot ? px(foot.getBoundingClientRect().bottom) : "-"}  屏底=${px(window.innerHeight)}`,
        `scroll st=${scroll ? px(scroll.scrollTop) : "-"}/${scroll ? px(scroll.scrollHeight) : "-"}/${scroll ? px(scroll.clientHeight) : "-"}`,
        `cls=${html.className.slice(0, 60)}`,
      ];
      box.textContent = lines.join("\n");
      box.appendChild(close);   /* textContent 会清掉子节点，按钮补回去 */
    };
    paint();
    setInterval(paint, 400);
  } catch (e) { /* 自检条不能影响正常使用 */ }
}
