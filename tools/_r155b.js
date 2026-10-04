(async () => {
  await new Promise(r => setTimeout(r, 900));
  const faces = Array.from(document.querySelectorAll(".mood-cell .mood-svg")).length;
  const kinds = Array.from(document.querySelectorAll(".mood-cell .mood-svg")).map((s) => {
    const use = s.innerHTML;
    return use.includes("mf-blush") ? (use.split("mf-blush").length > 2 ? "happy" : "steady") : (use.includes("mf-drop") ? "low" : use.includes("mf-z") ? "tired" : "calm");
  });
  return JSON.stringify({ moodFaceCells: faces, kinds });
})()
