(async()=>{try{return await window.__scenario();}catch(e){return {ERR:String(e&&e.message||e), ST:String(e&&e.stack||"").slice(0,600)};}})()
