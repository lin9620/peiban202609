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

/* 轮 238 · App 安装包公开下载地址（固定对象名 warm-paws.apk，管理员上传后内容即新包）。
 * 走 /sb 代理（生产同源；App 端 VITE_API_BASE 指向站点），国内直连 Storage 的问题一并绕开。 */
export const APP_RELEASE_URL =
  String(env.VITE_API_BASE || "").replace(/\/$/, "") +
  "/sb/storage/v1/object/public/app-releases/warm-paws.apk";