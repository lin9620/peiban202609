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
  bestNickname, hasAuthParams, isRecoveryEvent, parseAuthRedirect, redirectUrl,
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
 * 之后就读不到了。读完顺手把令牌从地址栏抹掉（别留在会被复制分享的链接里）。 */
function captureRedirect() {
  if (typeof window === "undefined" || !window.location) return;
  const loc = window.location;
  const r = parseAuthRedirect(loc.hash, loc.search);
  if (r.kind === "recovery") cloud.recovery = true;
  if (r.kind === "error") cloud.recoveryErr = r.reason || r.code;
  if (hasAuthParams(loc.hash, loc.search)) {
    try { window.history.replaceState(null, "", loc.pathname); } catch (e) { /* 忽略 */ }
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
    cloud.ready = true;
    /* 网关模式：/api/* 请求带上当前用户 JWT（Worker 只透传，RLS 仍由数据库执行） */
    setAuthTokenProvider(() => accessToken);
    const { data, error } = await sb.auth.getSession();
    if (error) throw error;
    await refreshSession(data ? data.session : null);
    sb.auth.onAuthStateChange((evt, session) => {
      /* PKCE 流程的地址栏里没有 type=recovery，靠这个事件识别重置链接落地 */
      if (isRecoveryEvent(evt)) cloud.recovery = true;
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
