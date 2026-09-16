/* Supabase 连通性验证（无需浏览器）：
 *   node tools/cloud-verify.mjs
 * 读项目根目录 .env 或 supabase.json / public/supabase.json，
 * 依次探测：Auth 健康 → 四张表 → Storage 桶 → RLS 匿名读。
 * 全部通过 = 可以重启 dev.cmd 使用云端暖心墙。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = [];
let bad = 0;
const ok = (name, cond, extra = "") => {
  if (cond) out.push("PASS  " + name + (extra ? "  " + extra : ""));
  else { bad++; out.push("FAIL  " + name + (extra ? "  " + extra : "")); }
};

/* —— 读配置：.env 优先，其次 supabase.json —— */
let cfg = null;
try {
  const env = fs.readFileSync(path.join(root, ".env"), "utf8");
  const get = (k) => {
    const m = env.match(new RegExp("^\\s*" + k + "\\s*=\\s*([^\\s].*?)\\s*$", "m"));
    return m ? m[1].replace(/^["']|["']$/g, "") : "";
  };
  const url = get("VITE_SUPABASE_URL"), key = get("VITE_SUPABASE_ANON_KEY");
  if (url && key) cfg = { url, key };
} catch (e) { /* 没有 .env，继续找 json */ }
if (!cfg) {
  for (const p of ["supabase.json", path.join("public", "supabase.json")]) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));
      if (j.url && j.anonKey) { cfg = { url: j.url, key: j.anonKey }; break; }
    } catch (e) { /* 这个文件不存在 */ }
  }
}

if (!cfg) {
  console.error("NO_CONFIG 未找到配置：请创建 .env（VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY）或 public/supabase.json");
  process.exit(1);
}
out.push("配置已找到  " + cfg.url);

const sb = createClient(cfg.url, cfg.key, { auth: { persistSession: false } });

/* 1) Auth 服务健康 */
try {
  const r = await fetch(cfg.url + "/auth/v1/health", { headers: { apikey: cfg.key } });
  ok("Auth 服务健康 (/auth/v1/health)", r.ok, "HTTP " + r.status);
} catch (e) { ok("Auth 服务健康", false, e.message); }

/* 2) 各表是否存在且可读（含宠物主页：互动计数是独立列 pats/feeds） */
for (const t of ["profiles", "wall_posts", "wall_comments", "wall_reactions", "wall_post_views", "pet_profiles", "pet_interactions"]) {
  try {
    const { error } = await sb.from(t).select("*").limit(1);
    ok("表 " + t + " 存在且匿名可读", !error, error ? error.message : "");
  } catch (e) { ok("表 " + t, false, e.message); }
}

/* 2b) 宠物互动计数列：老库要重跑 MIGRATION_wall_daily_view_dislike.sql 才会补上 */
try {
  const { error } = await sb.from("pet_profiles").select("pats,feeds").limit(1);
  ok("pet_profiles 计数列 pats/feeds 已就位", !error, error ? error.message : "");
} catch (e) { ok("pet_profiles 计数列", false, e.message); }

/* 3) Storage 桶（RLS 允许公开读，anon list 应成功；空桶返回 []） */
try {
  const { error } = await sb.storage.from("wall-images").list("", { limit: 1 });
  ok("Storage 桶 wall-images 可访问", !error,
    error ? error.message + "（Bucket not found = 还没跑 SUPABASE_SETUP.sql）" : "");
} catch (e) { ok("Storage 桶 wall-images", false, e.message); }

/* 4) RLS 冒烟：匿名读帖子应被允许（0 行也正常） */
try {
  const { data, error } = await sb.from("wall_posts").select("id").limit(1);
  ok("RLS：匿名可读 wall_posts", !error && Array.isArray(data),
    error ? error.message : "(行数 " + data.length + "，0 行也正常)");
} catch (e) { ok("RLS：匿名可读 wall_posts", false, e.message); }

out.push("", bad === 0
  ? "CLOUD_VERIFY ALL PASS — 重启 dev.cmd 即可使用云端暖心墙"
  : "CLOUD_VERIFY FAILED=" + bad + "（多数原因是还没在 SQL Editor 执行 SUPABASE_SETUP.sql）");
console.log(out.join("\n"));
process.exit(bad ? 1 : 0);
