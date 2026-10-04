(async () => {
  await new Promise(r => setTimeout(r, 900));
  /* 切英文：点顶栏语言钮 → 选 English */
  const langBtn = document.querySelector(".lang-btn");
  if (!langBtn) return "NO lang btn";
  langBtn.click();
  await new Promise(r => setTimeout(r, 500));
  const opts = Array.from(document.querySelectorAll("li, .n-dropdown-option, [role=menuitem], .n-dropdown-option-body"));
  const en = opts.find((o) => /English/i.test(o.textContent));
  if (en) { en.click(); } else {
    /* 兜底：直接写 localStorage + 重载 */
    localStorage.setItem("wp-lang", "en");
    location.reload();
  }
  await new Promise(r => setTimeout(r, 800));
  return document.querySelector(".lang-btn").textContent.trim() + " | locale=" + (document.documentElement.lang || "?");
})()
