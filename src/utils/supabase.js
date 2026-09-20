/* Supabase 云端接入（第二批）
 * ------------------------------------------------------------
 * 设计原则（与 storage.js 的防白屏哲学一致）：
 *  1. 未配置（无 .env / supabase.json）→ cloud.ready 恒为 false，
 *     所有调用方走本地模式，行为与第一批完全一致，绝不抛错白屏。
 *  2. 所有云操作都有 try/catch 兜底，失败时返回 null/false 并记录 cloud.error。
 *  3. 配置来源二选一：
 *     a) Vite 环境变量：.env 里 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
 *     b) 站点文件：public/supabase.json（开发时根目录的 supabase.json 也认）
 *     anon key 是公开密钥，安全性由 Supabase RLS 策略保证（见 SUPABASE_SETUP.sql）。
 */

import { reactive } from "vue";
import { createClient } from "@supabase/supabase-js";
import { setAuthTokenProvider } from "./api/authToken.js";
import {
  bestNickname, hasAuthParams, isRecoveryEvent, parseAuthRedirect, redirectUrl, NICK_MAX,
  isMissingFnError, passwordProblem,
} from "./authRules.js";

export const cloud = reactive({
  ready: false,     // 配置存在且 client 创建成功
  checking: true,   // 正在探测配置
  user: null,       // 当前登录用户（supabase user 对象或 null）
  nickname: "",     // 展示昵称（profile > 注册 metadata > 邮箱前缀 > Guest）
  error: "",        // 最近一次云端错误（展示用，不打断界面）
  recovery: false,  // 从「重置密码」邮件链接回来 —— 我的页要显示「设置新密码」
  recoveryErr: "",  // 那封邮件链接已失效/被用过的原因（展示用）
});

let sb = null; // supabase client 单例；未配置时保持 null
let accessToken = ""; // 当前会话 JWT；网关模式下给 /api/* 请求附带 Authorization 用

/* —— 配置探测：环境变量优先，其次站点根的 supabase.json —— */
async function detectConfig() {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (url && key) return { url, key };

  try {
    const r = await fetch("/supabase.json", { cache: "no-store" });
    if (r.ok) {
      const j = await r.json();
      if (j && j.url && j.anonKey) return { url: j.url, key: j.anonKey };
    }
  } catch (e) { /* 没有配置文件，正常 */ }
  return null;
}

/* —— 昵称：profile.nickname 优先 —— */
async function loadProfile(user) {
  if (!sb || !user) return "";
  try {
    const { data, error } = await sb
      .from("profiles").select("nickname").eq("id", user.id).maybeSingle();
    if (!error && data && data.nickname) return data.nickname;
    /* 档案缺失（如触发器建库前注册的老用户）→ 补建；
       Google 登录的元数据里没有 nickname（给的是 full_name / name），由 bestNickname 兜底 */
    const nick = bestNickname(user.user_metadata, user.email);
    await sb.from("profiles").upsert({ id: user.id, nickname: nick });
    return nick;
  } catch (e) {
    console.warn("[cloud] loadProfile:", e);
    return "";
  }
}

async function refreshSession(session) {
  accessToken = session && session.access_token ? session.access_token : "";
  cloud.user = session ? session.user : null;
  cloud.nickname = cloud.user ? await loadProfile(cloud.user) : "";
}

/* —— 邮件链接落地的两个信号（重置密码 / 链接失效） ——
 * 必须在 createClient 之前读：supabase-js 解析完会话会把地址栏参数清掉，
 * 之后就读不到了。
 * ⚠️ 这里【只读不清】：令牌必须留在地址栏里交给 supabase-js —— 它会在用
 * #access_token 建立恢复会话【成功之后】自己清 URL（auth-js _getSessionFromURL
 * 内部 window.location.hash = ''）。若在这里抢先抹掉，恢复会话永远建立不起来，
 * 「设置新密码」会报 Auth session missing（踩过：忘记密码重置必失败）。
 * 失效链接（error 参数，无令牌可消费）则可以安全地提前清掉。 */
function captureRedirect() {
  if (typeof window === "undefined" || !window.location) return;
  const loc = window.location;
  const r = parseAuthRedirect(loc.hash, loc.search);
  if (r.kind === "recovery") cloud.recovery = true;
  if (r.kind === "error") {
    cloud.recoveryErr = r.reason || r.code;
    /* error 分支没有可用令牌，直接清掉难看的错误参数（supabase-js 不会碰它） */
    if (hasAuthParams(loc.hash, loc.search)) {
      try { window.history.replaceState(null, "", loc.pathname); } catch (e) { /* 忽略 */ }
    }
  }
}

/* OAuth / 重置邮件的回跳地址（需与 Supabase → URL Configuration 白名单一致） */
function redirectOptions() {
  const u = (typeof window === "undefined" || !window.location)
    ? ""
    : redirectUrl(window.location.origin, window.location.pathname);
  return u ? { redirectTo: u } : {};
}

/* 应用启动时调用一次（App.vue onMounted）。任何失败都只是关闭云端，不抛出 */
export async function initCloud() {
  cloud.checking = true;
  try {
    /* 邮件链接的信号先收好（重置密码 / 链接失效），见 captureRedirect 注释 */
    captureRedirect();
    const cfg = await detectConfig();
    if (!cfg) { cloud.ready = false; return cloud; }
    sb = createClient(cfg.url, cfg.key, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
    /* 网关模式：/api/* 请求带上当前用户 JWT（Worker 只透传，RLS 仍由数据库执行） */
    setAuthTokenProvider(() => accessToken);
    const { data, error } = await sb.auth.getSession();
    if (error) throw error;
    await refreshSession(data ? data.session : null);
    /* ready 放在会话恢复之后：组件们以 cloud.ready 触发首拉，
       这样登录用户的帖子/私信/通知首拉就带着本人身份（回应 mine 标记、未读数都正确），
       不会出现「先以游客身份拉一遍 → 已点过的回应显示成没点」的竞态（用户实测点不掉回应的根因）。 */
    cloud.ready = true;
    sb.auth.onAuthStateChange((evt, session) => {
      /* PKCE 流程的地址栏里没有 type=recovery，靠这个事件识别重置链接落地 */
      if (isRecoveryEvent(evt)) cloud.recovery = true;
      /* 会话建立完成后 supabase-js 已消费并清掉地址栏令牌；若 URL 仍残留
         （个别 implicit 边界情况），这里兜底抹一次 —— 只在会话在手时才安全 */
      if (session && typeof window !== "undefined" && hasAuthParams(window.location.hash, window.location.search)) {
        try { window.history.replaceState(null, "", window.location.pathname); } catch (e) { /* 忽略 */ }
      }
      refreshSession(session);
    });
  } catch (e) {
    console.warn("[cloud] init failed, fallback to local mode:", e);
    cloud.ready = false;
    sb = null;
    cloud.error = e && e.message ? e.message : String(e);
  } finally {
    cloud.checking = false;
  }
  return cloud;
}

/* —— 供数据层判断 —— */
export function getClient() { return sb; }
export const isCloudOn = () => !!(sb && cloud.user);

/* —— 登录 / 注册 / 退出 —— */
export async function cloudSignUp(email, password, nickname) {
  if (!sb) return { ok: false, reason: "no-cloud" };
  try {
    const { data, error } = await sb.auth.signUp({
      email, password,
      options: { data: { nickname: nickname || "" } },
    });
    if (error) return { ok: false, reason: error.message };
    /* 若项目关闭邮箱验证，signUp 直接返回 session */
    if (data && data.session) await refreshSession(data.session);
    return { ok: true, needVerify: !(data && data.session) };
  } catch (e) {
    return { ok: false, reason: e && e.message ? e.message : String(e) };
  }
}

export async function cloudSignIn(email, password) {
  if (!sb) return { ok: false, reason: "no-cloud" };
  try {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) return { ok: false, reason: error.message };
    await refreshSession(data ? data.session : null);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e && e.message ? e.message : String(e) };
  }
}

export async function cloudSignOut() {
  if (!sb) return;
  try { await sb.auth.signOut(); } catch (e) { /* 忽略 */ }
  cloud.user = null;
  cloud.nickname = "";
}

/* —— 忘记密码：发重置邮件（链接回到 /profile，落地后显示「设置新密码」） —— */
export async function cloudResetPassword(email) {
  if (!sb) return { ok: false, reason: "no-cloud" };
  try {
    const { error } = await sb.auth.resetPasswordForEmail(email, redirectOptions());
    if (error) return { ok: false, reason: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e && e.message ? e.message : String(e) };
  }
}

/* —— 设置新密码（重置链接落地后调用）。成功后当前会话即为已登录状态 —— */
export async function cloudUpdatePassword(password) {
  if (!sb) return { ok: false, reason: "no-cloud" };
  try {
    const { error } = await sb.auth.updateUser({ password });
    if (error) return { ok: false, reason: error.message };
    /* 会话还是同一个人，但昵称最近可能刚同步过，统一再同步一次保持一致 */
    const { data } = await sb.auth.getSession();
    await refreshSession(data ? data.session : null);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e && e.message ? e.message : String(e) };
  }
}

/* —— 设置页改密码（#27）——
 * 邮箱用户：先用旧密码重登一次（signInWithPassword 成功即证明旧密码正确），再 updateUser；
 * 谷歌用户：没有旧密码，直接设置新密码 —— 之后即可用「邮箱＋密码」登录（不再只依赖谷歌）。
 * 返回 { ok, reason }：reason 走稳定暗号，由设置页映射文案（old-password-wrong / missing / short 等）。
 */
export async function cloudChangePassword(oldPw, newPw) {
  if (!sb) return { ok: false, reason: "no-cloud" };
  if (!cloud.user) return { ok: false, reason: "auth-required" };
  const v = String(newPw == null ? "" : newPw);
  const problem = passwordProblem(v);   /* 与注册同款校验（missing / short） */
  if (problem) return { ok: false, reason: problem };
  const isGoogle = !!(cloud.user.app_metadata && cloud.user.app_metadata.provider === "google");
  if (!isGoogle) {
    if (!oldPw) return { ok: false, reason: "old-password-required" };
    try {
      const { error } = await sb.auth.signInWithPassword({ email: cloud.user.email || "", password: String(oldPw) });
      if (error) return { ok: false, reason: "old-password-wrong" };
    } catch (e) {
      return { ok: false, reason: e && e.message ? e.message : String(e) };
    }
  }
  try {
    const { error } = await sb.auth.updateUser({ password: v });
    if (error) return { ok: false, reason: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e && e.message ? e.message : String(e) };
  }
}

/* —— Google 一键登录：整页跳到 Google，回来时 supabase-js 自动建会话 ——
 * 前提：Supabase → Authentication → Providers → Google 已开启（填好 Client ID / Secret），
 * 且 Google 侧的 Authorized redirect URI 填 https://<项目>.supabase.co/auth/v1/callback。 */
export async function cloudSignInWithGoogle() {
  if (!sb) return { ok: false, reason: "no-cloud" };
  try {
    const { error } = await sb.auth.signInWithOAuth({ provider: "google", options: redirectOptions() });
    if (error) return { ok: false, reason: error.message };
    return { ok: true, redirecting: true };
  } catch (e) {
    return { ok: false, reason: e && e.message ? e.message : String(e) };
  }
}

/* —— 离开「设置新密码」界面（点「返回登录」或保存成功后） —— */
export function cloudClearRecovery() {
  cloud.recovery = false;
  cloud.recoveryErr = "";
}

/* —— 昵称是否还是登录时的自动兜底（只针对 Google 登录：它用 full_name/邮箱前缀起名） ——
 * 邮箱注册的用户在注册表单里自己起过名，不算"自动"；改过一次（哪怕又改回原样）也不再提示。
 * 「我的」页据此在首登后给出"可以改昵称"的提示框。 */
export function cloudNicknameIsAuto() {
  const u = cloud.user;
  if (!u) return false;
  const provider = u.app_metadata && u.app_metadata.provider;
  if (provider !== "google") return false;
  const auto = bestNickname(u.user_metadata, u.email);
  return !!cloud.nickname && cloud.nickname === auto;
}

/* —— 修改昵称（登录用户）——
 * 首选 RPC rename_me：一个事务里改 profiles.nickname + 自己旧帖/旧评论的 author_name
 * （墙上署名是插入时写死的冗余列，只改 profiles 会出现「我改名了、旧帖还是旧名」）。
 * 没跑 MIGRATION_nickname_sync.sql 时函数不存在（PGRST202/42883）→ 退回只改 profiles，
 * 旧帖留旧名，返回 synced:false 让界面如实提示，不报错、不白屏。
 * 成功后同步 cloud.nickname，页面各处（头像/署名/主页）立即生效 */
export async function cloudUpdateNickname(nick) {
  if (!sb) return { ok: false, reason: "no-cloud" };
  if (!cloud.user) return { ok: false, reason: "auth-required" };
  const v = String(nick == null ? "" : nick).trim().slice(0, NICK_MAX);
  if (!v) return { ok: false, reason: "empty-nickname" };
  try {
    const { data, error } = await sb.rpc("rename_me", { p_nick: v });
    if (!error) {
      cloud.nickname = v;
      const row = Array.isArray(data) ? data[0] : data;
      return { ok: true, synced: true, posts: (row && row.posts) || 0, comments: (row && row.comments) || 0 };
    }
    if (!isMissingFnError(error.message, error.code)) return { ok: false, reason: error.message };
  } catch (e) {
    if (!isMissingFnError(e && e.message)) return { ok: false, reason: e && e.message ? e.message : String(e) };
  }
  /* 退化路径：只改档案（旧内容署名保持旧名） */
  try {
    const { error } = await sb.from("profiles").update({ nickname: v }).eq("id", cloud.user.id);
    if (error) return { ok: false, reason: error.message };
    cloud.nickname = v;
    return { ok: true, synced: false };
  } catch (e) {
    return { ok: false, reason: e && e.message ? e.message : String(e) };
  }
}

/* —— 自助删号（App 轨道 T3 · Play 2024 政策）：调 delete_my_account RPC ——
 * 语义：云端账号与全部个人数据立即删除；本机「游客/本地模式」数据与该账号无关，原样保留（D9 口径）。
 * 成功后立即退出登录（auth.users 行已删，会话随之失效）；未跑迁移时 PGRST202 → 明确提示
 * （错误分类沿用 isMissingFnError 的 code+message 双认，见坑录 #14）。与 cloudUpdateNickname 同款直连惯例。 */
export async function cloudDeleteAccount() {
  if (!sb) return { ok: false, reason: "no-cloud" };
  if (!cloud.user) return { ok: false, reason: "auth-required" };
  try {
    const { error } = await sb.rpc("delete_my_account");
    if (error) return { ok: false, reason: error.message };
    await cloudSignOut();
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e && e.message ? e.message : String(e) };
  }
}
