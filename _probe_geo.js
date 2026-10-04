(async () => {
  const r = {};
  const vis = e => { if(!e) return false; const b=e.getBoundingClientRect(); const c=getComputedStyle(e);
    return b.width>0 && b.height>0 && c.display!=='none' && c.visibility!=='hidden' && +c.opacity>0; };
  const bx = e => { const b=e.getBoundingClientRect(); return [Math.round(b.x),Math.round(b.y),Math.round(b.width),Math.round(b.height)]; };
  r.buttons = [...document.querySelectorAll('.emo-btn')].filter(vis).map(e => ({ box: bx(e), parent: e.parentElement.className, rowCls: (e.closest('.dm-input-row,.cmt-input-row,.cmt-main-bar')||{}).className }));
  const p = document.querySelector('.emo-panel');
  r.panel = p ? { box: bx(p), cls: p.className } : null;
  const row = document.querySelector('.dm-input-row, .cmt-main-bar');
  r.row = row ? { cls: row.className, box: bx(row), mb: row.style.marginBottom, pos: getComputedStyle(row).position } : null;
  r.innerH = window.innerHeight;
  if (p) {
    const b = e => { const x=e.getBoundingClientRect(); return x; };
    const btn = [...document.querySelectorAll('.emo-btn')].filter(vis).map(b).sort((a,c)=>a.top-c.top)[0];
    if (btn) { const cx=btn.x+btn.width/2, cy=btn.y+btn.height/2; const el=document.elementFromPoint(cx,cy);
      r.atBtnCenter = { pt:[Math.round(cx),Math.round(cy)], hit: el ? el.tagName+'.'+(el.className||'-') : null, insidePanel: p.contains(el) }; }
  }
  return JSON.stringify(r);
})()
