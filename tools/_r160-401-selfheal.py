# 轮 160：登录态「假登录」自愈 —— 网关 401 强制刷新会话重试 + StoryFeed 错误可自清
import io

def edit(p, pairs):
    s = io.open(p, encoding="utf-8").read()
    for old, new in pairs:
        assert s.count(old) == 1, f"{p}: anchor x{s.count(old)}: {old[:70]!r}"
        s = s.replace(old, new)
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)
    print("ok", p)

# ═══ ① supabase.js：导出 refreshAccessToken（单飞；直接落位 accessToken，不等事件回调） ═══
edit("src/utils/supabase.js", [
("""async function refreshSession(session) {
  accessToken = session && session.access_token ? session.access_token : "";
  cloud.user = session ? session.user : null;
  cloud.nickname = cloud.user ? await loadProfile(cloud.user) : "";
}""",
 """async function refreshSession(session) {
  accessToken = session && session.access_token ? session.access_token : "";
  cloud.user = session ? session.user : null;
  cloud.nickname = cloud.user ? await loadProfile(cloud.user) : "";
}

/* 轮 160：401 自愈用的「强制刷新会话」。
 * 背景：轮 36 ready 提前后，boot 用【本地存储的会话】立刻点亮登录态（顶栏/头像马上有），
 * 但那个 access_token 可能已过期——autoRefreshToken 的后台刷新若失败（/sb 代理链路抖、
 * 长时间挂起后回来），后续所有带身份请求一直 401：故事栏挂「请先登录」、顶栏却是登录态。
 * 这里给网关层一个可调用的强制刷新：单飞（并发 401 共享同一次刷新），成功后【直接落位
 * accessToken】——不等 onAuthStateChange 事件回调，重试请求拿到的必是新 token。 */
let refreshing = null;
export async function refreshAccessToken() {
  if (!sb) return "";
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const { data, error } = await sb.auth.refreshSession();
      if (error) return "";
      const s = data && data.session;
      if (!s || !s.access_token) return "";
      accessToken = s.access_token;
      cloud.user = s.user || cloud.user;
      return accessToken;
    } catch (e) {
      return "";
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}"""),
])

# ═══ ② db.gateway.js：call() 401 → 刷新会话 → 换新 token 重试一次 ═══
edit("src/utils/api/db.gateway.js", [
("""import { getClient } from "../supabase.js";
import { getAuthToken } from "./authToken.js";""",
 """import { getClient, refreshAccessToken } from "../supabase.js";
import { getAuthToken } from "./authToken.js";

/* 轮 160：单测可注入的「刷新会话」替身；生产走 supabase.js 的 refreshAccessToken */
let refresher = null;
export function setGatewayTokenRefresher(fn) {
  refresher = typeof fn === "function" ? fn : null;
}
async function refreshTokenOnce() {
  if (refresher) return refresher();
  return refreshAccessToken();
}"""),
("""/** 一次网关调用：非 2xx → throw（消息取错误体的 message/error），2xx 空 body → null */
async function call(path, { method = "GET", body, headers } = {}) {
  if (!authReady()) throw new Error("cloud-not-ready");
  let res;
  try {
    const isBytes = body instanceof ArrayBuffer || body instanceof Uint8Array;
    res = await fetch(BASE + path, {
      method,
      headers: authHeaders({
        ...(body !== undefined && !isBytes ? { "content-type": "application/json" } : {}),
        ...(headers || {}),
      }),
      body: body === undefined ? undefined : isBytes ? body : JSON.stringify(body),
    });
  } catch (e) {
    throw new Error("gateway-unreachable");
  }
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch (e) { data = null; }
  }
  if (!res.ok) {
    const msg = (data && (data.message || data.error)) || `HTTP ${res.status}`;
    throw new Error(String(msg));
  }
  return data;
}""",
 """/** 一次网关调用：非 2xx → throw（消息取错误体的 message/error），2xx 空 body → null。
 * 轮 160：带身份的请求吃 401 时——本地会话大概率是「后台刷新失败后一直揣着过期 JWT」
 * （顶栏已显示登录、接口却 401 的假登录态）——强制刷新一次会话（单飞）再重试本请求；
 * 只重试一次（刷新失败 / 仍 401 都按原错误上抛），绝不循环。 */
async function call(path, { method = "GET", body, headers } = {}) {
  if (!authReady()) throw new Error("cloud-not-ready");
  const hadAuth = !!getAuthToken();
  const attempt = async () => {
    let res;
    try {
      const isBytes = body instanceof ArrayBuffer || body instanceof Uint8Array;
      res = await fetch(BASE + path, {
        method,
        headers: authHeaders({
          ...(body !== undefined && !isBytes ? { "content-type": "application/json" } : {}),
          ...(headers || {}),
        }),
        body: body === undefined ? undefined : isBytes ? body : JSON.stringify(body),
      });
    } catch (e) {
      throw new Error("gateway-unreachable");
    }
    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch (e) { data = null; }
    }
    if (!res.ok) {
      const msg = (data && (data.message || data.error)) || `HTTP ${res.status}`;
      const err = new Error(String(msg));
      err.status = res.status;
      throw err;
    }
    return data;
  };
  try {
    return await attempt();
  } catch (e) {
    if (e && e.status === 401 && hadAuth) {
      const t = await refreshTokenOnce();
      if (t) return await attempt();   /* authHeaders 每次现取 token → 重试必带新 JWT */
    }
    throw e;
  }
}"""),
])

# ═══ ③ StoryFeed.vue：拉取成功时清掉旧错误（401 自愈后红字不残留） ═══
edit("src/components/story/StoryFeed.vue", [
("""      cached: (data) => { rows.value = data || []; loading.value = false; },
      fresh: (data) => { rows.value = first ? (data || []) : rows.value.concat(data || []); },
      onError: (e) => { err.value = t(storyErrKey(e || new Error("network"))); },""",
 """      cached: (data) => { rows.value = data || []; err.value = ""; loading.value = false; },
      fresh: (data) => { rows.value = first ? (data || []) : rows.value.concat(data || []); err.value = ""; },
      onError: (e) => { err.value = t(storyErrKey(e || new Error("network"))); },"""),
])
print("ALL 160 EDITS DONE")
