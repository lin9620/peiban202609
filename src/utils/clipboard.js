/* 轮 84：拷贝到剪贴板（…菜单的「拷贝」用）
 * WebView / 老浏览器里 navigator.clipboard 可能缺失或被拒（App 内file 场景、
 * 非安全上下文等），必须给 execCommand 兜底 —— 同踩坑 #27 的思路：
 * 浏览器惯用手法在 Capacitor WebView 里不能假设可用。
 * 纯工具：返回 true/false，调用方决定提示什么。 */
export async function copyText(text) {
  const s = String(text == null ? "" : text);
  if (!s) return false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(s);
      return true;
    }
  } catch (e) { /* 授权拒绝/不可用 → 落到下面的兜底 */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = s;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, s.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch (e) {
    return false;
  }
}
