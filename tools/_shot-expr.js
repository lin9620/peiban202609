(async () => {
  await new Promise(r => setTimeout(r, 500));
  const t = document.querySelector(".cmt-toggle");
  if (t) t.click();
  await new Promise(r => setTimeout(r, 800));
  const e = document.querySelector(".cmt-entry");
  if (e) e.click();
  await new Promise(r => setTimeout(r, 600));
  return "done";
})()
