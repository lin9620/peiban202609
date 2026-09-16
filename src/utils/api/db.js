/* 云端数据访问适配层 —— 实现选择器（阶段 2）
 * ------------------------------------------------------------
 * 两种实现、同一契约（方法 / 参数 / 返回 / 错误上抛）：
 *   db.supabase.js  直连 Supabase（PostgREST / Storage，supabase-js）—— 默认
 *   db.gateway.js   同源 /api/* 网关（worker/api.js 翻译到上游）—— VITE_API_GATEWAY=1 时启用
 * wall.js 等调用方只 import 这里的 db —— 以后换后端时改这里的指向即可。
 * 契约测试：tools/api-contract-test.mjs（直连）+ tools/gateway-contract-test.mjs（网关）
 *           + tools/worker-test.mjs（Worker 侧）。
 */
import { db as directDb, setDbClient, IMAGE_BUCKET } from "./db.supabase.js";
import { db as gatewayDb } from "./db.gateway.js";

/* import.meta.env 由 Vite 构建期注入；Node 单测里是 undefined —— 兜底空对象 */
const env = import.meta.env || {};
const flag = String(env.VITE_API_GATEWAY || "").trim().toLowerCase();
export const db = flag === "1" || flag === "true" ? gatewayDb : directDb;
export { setDbClient, IMAGE_BUCKET };