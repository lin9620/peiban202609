(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { href: location.href, err: "" };
  try {
    await sleep(800);
    const inputs = [...document.querySelectorAll(".n-input input")];
    out.inputs = inputs.map((i) => ({ ph: i.placeholder, type: i.type }));
    out.hasGoogle = !!document.querySelector(".oauth-google");
    out.authCard = !!document.querySelector(".auth-card");
    out.crash = document.querySelector(".crash-box")?.innerText?.slice(0, 200) || null;
    return out;
  } catch (e) { out.err = String((e && e.message) || e); return out; }
})()
