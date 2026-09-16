/* 用户 JWT 提供者（阶段 2 网关模式的鉴权接线）
 * ------------------------------------------------------------
 * supabase.js 在 Auth 客户端就绪后注册 provider；db.gateway.js 每次 /api/* 请求前
 * 取当前 access_token 放进 Authorization 头。Worker 只透传、不解析 —— RLS 照旧由数据库执行。
 * 未注册 / 未登录 → 返回空串 → 请求以 anon 身份走网关（能读到什么由 RLS 决定）。
 * 本模块是叶子（无任何 import），supabase.js 与 db.gateway.js 都可以安全引用它。
 */

let provider = null;

/** 注册「取当前 token」的函数；生产代码只在 supabase.js 的 initCloud 成功后调用一次 */
export function setAuthTokenProvider(fn) {
  provider = typeof fn === "function" ? fn : null;
}

/** 当前用户 JWT；拿不到就给空串（绝不抛错 —— 鉴权缺失一律按匿名处理） */
export function getAuthToken() {
  try {
    const t = provider ? provider() : "";
    return typeof t === "string" ? t : "";
  } catch (e) {
    return "";
  }
}