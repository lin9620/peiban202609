(async () => {
  await new Promise(r => setTimeout(r, 900));
  /* 切到故事联 */
  const tab = Array.from(document.querySelectorAll(".pane-tab, [role=tab], button")).find((b) => b.textContent.trim() === "故事");
  if (tab) { tab.click(); await new Promise(r => setTimeout(r, 1000)); }
  const navs = Array.from(document.querySelectorAll(".st-feed-nav"));
  const pairs = navs.map((n) => {
    const r = n.getBoundingClientRect();
    const card = n.closest(".card, .home-pane");
    return { x: Math.round(r.x), y: Math.round(r.y), inCard: !!card, cardClass: card ? card.className.slice(0, 40) : "" };
  });
  const subs = Array.from(document.querySelectorAll(".st-feed-sub, .st-sub")).map((p) => ({ cls: p.className.slice(0, 24), txt: p.textContent.trim().slice(0, 16), y: Math.round(p.getBoundingClientRect().y) }));
  return JSON.stringify({ navCount: navs.length, pairs, subs }, null, 1);
})()
