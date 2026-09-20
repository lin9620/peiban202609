(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  out.href = location.href;
  out.cls = document.querySelector(".shell")?.className;
  out.tabbar = !!document.querySelector(".tabbar");
  out.topbarDisplay = getComputedStyle(document.querySelector(".topbar")).display;
  /* 消息 Tab：点进去看分栏顺序 */
  const tabMsg = [...document.querySelectorAll(".tab-item")].find((b) => /消息|Messages/.test(b.textContent));
  if (tabMsg) {
    tabMsg.click();
    await sleep(900);
    const segBtns = [...document.querySelectorAll(".dm-seg-btn")].map((b) => b.textContent.replace(/\d+\+?$/, "").trim());
    out.segOrder = segBtns;
    out.segOn = document.querySelector(".dm-seg-btn.on")?.textContent.trim();
  } else out.segOrder = "no-tabbar-tab";
  return out;
})()
