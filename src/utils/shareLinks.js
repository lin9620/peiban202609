/* 分享链接（海外版）· 纯函数，Node 单测覆盖
 * ------------------------------------------------------------
 * 轮 501。用户（附「我的」页分享面板截图）：「你这个分享怎么做的，我们是面向海外用户，
 * 你搞这个？？重新设计这个分享功能」
 *
 * 旧面板只有一句话：「复制后粘到微信 / QQ 发给朋友」。暖爪的用户在英语 / 西语 / 葡语 /
 * 法语区，那五语种里的 WeChat / QQ 是直接从中文版抄过去的 —— 对海外用户来说这不是
 * 「少一个入口」，而是**看起来就不像给他的产品**。
 *
 * 所以分享拆成两层：
 *   ① 系统分享（navigator.share）：iOS / 安卓 Chrome / 桌面 Chrome 都有，
 *      一次覆盖 AirDrop、Messages、Instagram、Gmail…（不需要我们枚举平台）
 *   ② 系统分享缺席时（各家内置浏览器、旧内核）→ 给**直连**入口：
 *      WhatsApp / Telegram / X / Facebook / Email / SMS + 复制链接
 *
 * 这里只做「链接怎么拼」，不碰 DOM。所有平台都用公开的 share intent URL，
 * 没有 SDK、没有 App ID，网页端与 App 内 WebView 都能用（https 链接由系统接手）。
 */

/* 正式站点（App 内 WebView 的 origin 是 capacitor://localhost，不能拿来分享） */
export const SITE_ORIGIN = "https://warmpaws.de5.net";

/* 直连渠道。顺序即面板里的格子顺序：先 IM，再社交，最后邮件/短信 */
export const SHARE_TARGETS = ["whatsapp", "telegram", "x", "facebook", "email", "sms"];

const enc = (s) => encodeURIComponent(String(s == null ? "" : s));

/* 本地/局域网地址不能拿去分享：App 内 WebView 的 origin 是 https://localhost，
   开发预览是 http://127.0.0.1:5173 —— 发出去对方打开是一片空白。 */
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|0\.0\.0\.0|.*\.local)$/i;

/**
 * 要分享出去的地址。
 * 只取 origin + "/"：分享的是「这个地方」，不是某个人的 /profile
 * （陌生人点开 /profile 看到的是登录提示，等于什么都没分享）。
 * 本地地址 / App 内 WebView 的 localhost 一律回落到正式站点。
 * @param {string} href 当前页完整地址
 * @returns {string} 形如 https://warmpaws.de5.net/
 */
export function shareUrl(href) {
  const h = String(href || "");
  try {
    const u = new URL(h);
    const okProto = u.protocol === "https:" || u.protocol === "http:";
    if (okProto && u.host && !LOCAL_HOST.test(u.hostname)) return u.origin + "/";
  } catch (e) { /* 非法地址 / capacitor:// → 用正式站点 */ }
  return SITE_ORIGIN + "/";
}

/**
 * 拼某个渠道的分享地址。
 * @param {string} key SHARE_TARGETS 里的一个
 * @param {{url?:string,text?:string,subject?:string}} [meta]
 * @returns {string} 空串 = 未知渠道（调用方应直接忽略）
 */
export function shareHref(key, meta) {
  const m = meta || {};
  const url = String(m.url || "");
  const text = String(m.text || "");
  const subject = String(m.subject || text);
  if (!url && !text) return "";
  switch (key) {
    /* wa.me 是 WhatsApp 官方的点击聊天入口：text 里带链接，App 会自己识别 */
    case "whatsapp":
      return "https://wa.me/?text=" + enc([text, url].filter(Boolean).join(" "));
    /* Telegram 明确分 url / text 两个参数 */
    case "telegram":
      return "https://t.me/share/url?url=" + enc(url) + "&text=" + enc(text);
    /* X（原 Twitter）用 intent/post；老域名 twitter.com/intent/tweet 会自动跳过来 */
    case "x":
      return "https://x.com/intent/post?text=" + enc(text) + "&url=" + enc(url);
    /* Facebook 只吃 u（正文由它自己抓 Open Graph），多传 text 会被忽略 */
    case "facebook":
      return "https://www.facebook.com/sharer/sharer.php?u=" + enc(url);
    /* mailto：主题用 subject，正文 = 一句话 + 空行 + 链接 */
    case "email":
      return "mailto:?subject=" + enc(subject) + "&body=" + enc(text ? text + "\n\n" + url : url);
    /* sms: 的写法 iOS 与安卓都能认（iOS 用 &body，安卓用 ?body，?&body 两边通吃）。
       注意安卓上对 + 号敏感，所以正文里的空格必须编码成 %20 而不是 + ——
       encodeURIComponent 给的正是 %20。 */
    case "sms":
      return "sms:?&body=" + enc(text ? text + " " + url : url);
    default:
      return "";
  }
}
