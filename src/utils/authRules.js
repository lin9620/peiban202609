/* 登录规则：纯逻辑层（不依赖 Vue / supabase-js / 浏览器 API，Node 可直接单测）
 * ------------------------------------------------------------
 * 这里放四件事，全部是「输入 → 输出」的纯函数：
 *   1. 邮箱 / 密码的本地校验：只是提前给一句人话，权威判断永远在服务端；
 *      阈值与服务端一致（Supabase 默认最短 6 位），避免「本地放行、服务端报错」。
 *   2. 昵称兜底：Google 登录回来的元数据里没有 nickname（给的是 full_name / name），
 *      邮箱注册给的是 nickname —— 都得能落成一个能看的昵称。
 *   3. 邮件回到本站时的参数解析：
 *      · 重置密码链接：implicit 流程令牌在 # 后（#access_token=…&type=recovery）；
 *      · 链接过期/已用：Supabase 会带 #error=…&error_code=otp_expired；
 *      · PKCE 流程（?code=…）不带 type，识别交给 supabase-js 的 PASSWORD_RECOVERY 事件
 *        （见 isRecoveryEvent）——两条路互为兜底。
 *   4. 跳转地址：OAuth 与重置邮件的 redirectTo，必须与 Supabase → URL Configuration
 *      的 Redirect URLs 白名单一致，否则登录回来会停在 Supabase 域名上。
 * 页面：src/views/ProfileView.vue；封装：src/utils/supabase.js；测试：tools/auth-test.mjs
 */

/* ══════════ 邮箱 / 密码 ══════════ */

/** Supabase 默认要求的最短密码长度；本地提示与它保持一致 */
export const MIN_PASSWORD = 6;

/**
 * 邮箱是否看起来可用。
 * 刻意不做 RFC 完备校验（那是服务端的事）：只拦「明显不是邮箱」的输入，
 * 免得把合法但少见的地址挡在门外。
 */
export function isEmail(s) {
  const v = String(s == null ? "" : s).trim();
  if (v.length < 3 || v.length > 254) return false;
  if (/\s/.test(v)) return false;
  const at = v.indexOf("@");
  if (at <= 0 || at !== v.lastIndexOf("@")) return false;
  const domain = v.slice(at + 1);
  return domain.includes(".") && !domain.startsWith(".") && !domain.endsWith(".");
}

/** 邮箱问题原因（"" = 没问题）：missing | malformed —— 由 i18n 翻成人话 */
export function emailProblem(email) {
  const v = String(email == null ? "" : email).trim();
  if (!v) return "missing";
  return isEmail(v) ? "" : "malformed";
}

/** 密码问题原因（"" = 没问题）：missing | short */
export function passwordProblem(pass) {
  const v = String(pass == null ? "" : pass);
  if (!v) return "missing";
  return v.length < MIN_PASSWORD ? "short" : "";
}

/* ══════════ 昵称兜底（Google / 邮箱注册都走这里） ══════════ */

/** 昵称最长长度（超长名字会撑破侧栏与帖子署名） */
export const NICK_MAX = 24;

/**
 * 从登录元数据里挑一个能看的昵称。
 * 优先级：nickname（我们自己注册时写的）> full_name / name（Google 给的）> 邮箱前缀 > Guest。
 * @param {Object} meta user.user_metadata（可能是 null / 脏值）
 * @param {string} email user.email
 * @returns {string} 干净的昵称（已 trim 并截断）
 */
export function bestNickname(meta, email) {
  const m = meta && typeof meta === "object" ? meta : {};
  const cand = [m.nickname, m.full_name, m.name, m.display_name];
  for (const c of cand) {
    const v = typeof c === "string" ? c.trim() : "";
    if (v) return v.slice(0, NICK_MAX);
  }
  const e = String(email == null ? "" : email);
  const at = e.indexOf("@");
  const pre = (at > 0 ? e.slice(0, at) : "").trim();
  return pre ? pre.slice(0, NICK_MAX) : "Guest";
}

/* ══════════ 邮件回到本站时的参数解析 ══════════ */

/** 把 "a=1&b=2"（可带开头的 # / ?）拆成对象；脏值不抛错 */
function params(s) {
  const out = {};
  const raw = String(s == null ? "" : s).replace(/^[#?]/, "");
  if (!raw) return out;
  for (const kv of raw.split("&")) {
    if (!kv) continue;
    const i = kv.indexOf("=");
    const k = i < 0 ? kv : kv.slice(0, i);
    const v = i < 0 ? "" : kv.slice(i + 1);
    try { out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, " ")); }
    catch (e) { out[k] = v; }
  }
  return out;
}

/**
 * 解析「从邮件链接回到本站」时地址栏里的信号。
 * @param {string} hash location.hash（implicit 流程：令牌在 # 后）
 * @param {string} search location.search（PKCE 流程：?code=…）
 * @returns {{kind:""|"recovery"|"error", code:string, reason:string}}
 *   recovery —— 重置密码链接（type=recovery）
 *   error    —— 链接失效 / 被用过（error_code，如 otp_expired）
 */
export function parseAuthRedirect(hash = "", search = "") {
  const h = params(hash);
  const q = params(search);

  const code = h.error_code || q.error_code || "";
  const err = h.error || q.error || "";
  if (code || err) {
    const reason = h.error_description || q.error_description || code || err;
    return { kind: "error", code: code || err, reason: String(reason) };
  }

  const type = h.type || q.type || "";
  if (type === "recovery") return { kind: "recovery", code: "", reason: "" };
  return { kind: "", code: "", reason: "" };
}

/**
 * 地址栏里是否带着登录令牌 / 邮件链接结果（用来决定要不要把这段参数抹掉）。
 * 令牌留在地址栏既难看又会被复制分享出去，落地后应立即清掉。
 */
export function hasAuthParams(hash = "", search = "") {
  return /(^|[#?&])(access_token|refresh_token|provider_token|type|error|error_code|code)=/.test(
    String(hash == null ? "" : hash) + String(search == null ? "" : search)
  );
}

/** supabase-js 的事件名是否为「重置密码链接已生效」（PKCE 流程靠它识别） */
export function isRecoveryEvent(event) {
  return event === "PASSWORD_RECOVERY";
}

/* ══════════ 跳转地址 ══════════ */

/**
 * OAuth / 重置邮件的回跳地址：当前 origin + 当前路径（登录表单在 /profile）。
 * 非 http(s)（如 file:// 调试）或没有 origin 时返回 ""，交给 supabase-js 用 Site URL 兜底 —— 不抛错。
 * @param {string} origin location.origin
 * @param {string} pathname location.pathname
 * @returns {string} 如 https://dale.de5.net/profile
 */
export function redirectUrl(origin, pathname = "/") {
  const o = String(origin == null ? "" : origin);
  if (!/^https?:\/\//i.test(o)) return "";
  let p = String(pathname == null ? "/" : pathname);
  if (!p.startsWith("/")) p = "/" + p;
  return o.replace(/\/+$/, "") + p;
}
