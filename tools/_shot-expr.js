(async () => {
  await new Promise(r => setTimeout(r, 500));
  const t = document.querySelector(".cmt-toggle");
  if (t) t.click();
  await new Promise(r => setTimeout(r, 900));
  return "opened";
})()
