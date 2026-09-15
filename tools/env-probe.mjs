/* 探测 dev 服务器是否已注入云端 .env：
 * Vite 会在「转换后的模块源码」里把 import.meta.env 替换成真实值，
 * 因此直接抓 /src/utils/supabase.js 的转换产物，看云端 URL 是否出现。 */
const r = await fetch("http://localhost:5173/src/utils/supabase.js");
const t = await r.text();
if (t.includes("rwulplykvipkshkxyxfe")) {
  console.log("ENV_INJECTED 云端 URL 已注入（重启生效）");
} else if (t.includes("VITE_SUPABASE_URL")) {
  console.log("ENV_MISSING 仍是旧进程：import.meta.env 未被替换，请重跑 tools/restart-dev.cmd");
} else {
  console.log("UNEXPECTED dev 服务器响应异常（HTTP " + r.status + "）");
}
