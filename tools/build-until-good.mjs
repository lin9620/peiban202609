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

  /* 不信 guard 一面之词：自己再读产物验一遍 slug */
  const dir = new URL("../dist/assets/", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
  const entries = readdirSync(dir).filter((f) => /^index-.*\.js$/.test(f));
  const good = entries.filter((f) => readFileSync(dir + f, "utf8").includes(slug));
  console.log(`[try ${i}] entries=${entries.join(",")} good=${good.join(",") || "无"}`);
  if (good.length === entries.length && entries.length > 0) {
    console.log(`BUILD_GOOD ${good.join(",")}`);
    process.exit(0);
  }
}
console.error("BUILD_ALWAYS_BAD");
process.exit(1);
