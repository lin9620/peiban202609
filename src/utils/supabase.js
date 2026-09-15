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

export const cloud = reactive({
  ready: false,     // 配置存在且 client 创建成功
  checking: true,   // 正在探测配置
  user: null,       // 当前登录用户（supabase user 对象或 null）
  nickname: "",     // 展示昵称（profile > 注册 metadata > 邮箱前缀 > Guest）
  error: "",        // 最近一次云端错误（展示用，不打断界面）
});

let sb = null; // supabase client 单例；未配置时保持 null

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
    /* 档案缺失（如触发器建库前注册的老用户）→ 补建 */
    const nick = (user.user_metadata && user.user_metadata.nickname)
      || (user.email ? user.email.split("@")[0] : "Guest");
    await sb.from("profiles").upsert({ id: user.id, nickname: nick });
    return nick;
  } catch (e) {
    console.warn("[cloud] loadProfile:", e);
    return "";
  }
}

async function refreshSession(session) {
  cloud.user = session ? session.user : null;
  cloud.nickname = cloud.user ? await loadProfile(cloud.user) : "";
}

/* 应用启动时调用一次（App.vue onMounted）。任何失败都只是关闭云端，不抛出 */
export async function initCloud() {
  cloud.checking = true;
  try {
    const cfg = await detectConfig();
    if (!cfg) { cloud.ready = false; return cloud; }
    sb = createClient(cfg.url, cfg.key, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
    cloud.ready = true;
    const { data, error } = await sb.auth.getSession();
    if (error) throw error;
    await refreshSession(data ? data.session : null);
    sb.auth.onAuthStateChange((_evt, session) => { refreshSession(session); });
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
