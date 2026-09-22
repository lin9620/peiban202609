/* 临时工具：反复构建直到 env-guard 放行（产物里真的有 VITE_SUPABASE_URL）。
 * 背景：env-guard 是间歇性 flake（其注释自述「重跑即正常」），而 npm run build
 * 失败后若继续 deploy 会把坏包发上线（本轮真实事故）。此脚本把「构建+校验」
 * 做成原子动作：build → 自己再验一遍产物 → 不合格自动重试，最多 5 次。
 * 用完即删（tools/_* 规则）。 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

const slug = (readFileSync(new URL("../.env", import.meta.url), "utf8")
  .match(/^VITE_SUPABASE_URL=https:\/\/([a-z0-9]+)\.supabase\.co/m) || [])[1];
if (!slug) { console.error("NO_SLUG_IN_ENV"); process.exit(1); }

for (let i = 1; i <= 5; i++) {
  /* 关键：清掉运行环境里的空 VITE_SUPABASE_*（Vite 中进程环境优先于 .env，
   * 空串会把真配置顶掉 → 产物没 slug → 线上登录整个失效） */
  const env = { ...process.env };
  delete env.VITE_SUPABASE_URL;
  delete env.VITE_SUPABASE_ANON_KEY;
  const r = spawnSync(process.execPath, ["node_modules/vite/bin/vite.js", "build"],
    { stdio: "inherit", cwd: new URL("..", import.meta.url).pathname.replace(/^\/(\w:)/, "$1"), env });
  if (r.status !== 0) { console.log(`[try ${i}] vite build 退出码 ${r.status}，重试`); continue; }

  /* 不信 guard 一面之词：自己再读产物验一遍 slug。
   * 口径与 vite.config.js 的 env-guard 一致（轮 31）：只验 index.html 真正加载的入口脚本
   * —— `@capacitor/browser` 动态 import 会额外产出一个不含 env 的 index-<hash>.js 懒块，
   * 旧口径「所有 index-*.js 都要含 slug」会把好包误判成坏包（BUILD_ALWAYS_BAD）。 */
  const distDir = new URL("../dist/", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
  const html = readFileSync(distDir + "index.html", "utf8");
  const entries = [...html.matchAll(/src="\/assets\/([^"]+\.js)"/g)].map((m) => m[1]);
  const bad = entries.filter((f) => !readFileSync(distDir + "assets/" + f, "utf8").includes(slug));
  console.log(`[try ${i}] 入口=${entries.join(",")} 缺slug=${bad.join(",") || "无"}`);
  if (entries.length > 0 && bad.length === 0) {
    console.log(`BUILD_GOOD ${entries.join(",")}`);
    process.exit(0);
  }
}
console.error("BUILD_ALWAYS_BAD");
process.exit(1);
