(async () => {
  await new Promise(r => setTimeout(r, 500));
  const t = document.querySelector(".cmt-toggle");
  if (t) t.click();
  await new Promise(r => setTimeout(r, 800));
  const b = document.querySelector(".cmt-entry");
  if (b) b.click();
  await new Promise(r => setTimeout(r, 600));
  return "done";
})()
