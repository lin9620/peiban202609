(() => {
  const doc = document.documentElement;
  const sp = document.getElementById("app-splash");
  const app = document.getElementById("app");
  const cs = sp ? getComputedStyle(sp) : null;
  const r = sp ? sp.getBoundingClientRect() : null;
  const ab = app ? app.getBoundingClientRect() : null;
  const htmlCs = getComputedStyle(doc);
  const bodyCs = getComputedStyle(document.body);
  const px = (sel) => { const e = document.querySelector(sel); return e ? getComputedStyle(e).backgroundColor : null; };
  const el = (x, y) => { const e = document.elementFromPoint(x, y); if (!e) return null; const c = getComputedStyle(e); return { tag: e.tagName, id: e.id, cls: (e.className || "").toString().slice(0, 60), bg: c.backgroundColor, rect: (() => { const b = e.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; })() }; };
  return {
    ua: navigator.userAgent,
    capApp: doc.classList.contains("cap-app"),
    hasAndroidBridge: !!window.androidBridge,
    hasCapacitor: !!window.Capacitor,
    isNative: !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()),
    innerW: window.innerWidth, innerH: window.innerHeight,
    clientW: doc.clientWidth, clientH: doc.clientHeight,
    bodyScrollW: document.body.scrollWidth, bodyScrollH: document.body.scrollHeight,
    dpr: window.devicePixelRatio,
    screen: { w: screen.width, h: screen.height, aw: screen.availWidth, ah: screen.availHeight },
    visualViewport: window.visualViewport ? { w: Math.round(visualViewport.width), h: Math.round(visualViewport.height), scale: visualViewport.scale } : null,
    splash: sp ? { display: cs.display, opacity: cs.opacity, visibility: cs.visibility, bg: cs.backgroundColor, zIndex: cs.zIndex, rect: r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null, cls: sp.className, removed: false } : { removed: true },
    htmlBg: htmlCs.backgroundColor, bodyBg: bodyCs.backgroundColor,
    appRect: ab ? [Math.round(ab.x), Math.round(ab.y), Math.round(ab.width), Math.round(ab.height)] : null,
    appBg: px("#app"),
    edgeTopLeft: el(2, 2), edgeTopMid: el(Math.round(window.innerWidth / 2), 2), edgeTopRight: el(window.innerWidth - 3, 2),
    edgeBotLeft: el(2, window.innerHeight - 3), edgeBotRight: el(window.innerWidth - 3, window.innerHeight - 3),
    mounted: !!window.__WP_MOUNTED__,
    route: location.hash || location.pathname,
  };
})()
