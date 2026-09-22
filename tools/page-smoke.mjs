/* 页面挂载冒烟（轮 34 补：TDZ 崩溃类的运行时防线）
 *   node tools/page-smoke.mjs [--serve=dist]
 * 行为：无头 Edge 真实挂载关键路由（web-probe 同链路），断言两件事：
 *   ① 挂载成功（#app .shell 存在）② 无崩溃盒（App.vue onErrorCaptured 兜住的 .crash-box）。
 * 背景：构建/undef-check 都不执行代码，「immediate watch 引用了后面才声明的 const」这类
 *       TDZ 错误（轮 34 真实事故：/admin 白屏）只有真挂载才抓得到。
 * 注意：Git Bash 下跑 web-probe 必须 MSYS2_ARG_CONV_EXCL="--url"（否则 /admin 会被
 *       MSYS 路径转换改写成 Windows 路径 → 导航失败），本脚本已内置。
 */
import { spawnSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const serve = (process.argv.find((a) => a.startsWith("--serve=")) || "--serve=dist").slice(8);
const PAGES = ["/", "/admin", "/community", "/login", "/profile", "/messages", "/post/1", "/u/xxx"];

const expr = path.join(root, "tools", "_page-smoke-expr.js");
writeFileSync(expr, `(async () => {
  await new Promise(r => setTimeout(r, 500));
  const crash = document.querySelector(".crash-box");
  return { crash: crash ? crash.textContent.slice(0, 200) : null,
           mounted: !!document.querySelector("#app .shell") };
})()`);

let fail = 0;
for (const p of PAGES) {
  const r = spawnSync(process.execPath, [
    "tools/web-probe.mjs",
    `--serve=${serve}`, `--url=${p}`, "--w=1280", "--h=900", "--wait=1500", `--file=${expr}`,
  ], { cwd: root, encoding: "utf8", env: { ...process.env, MSYS2_ARG_CONV_EXCL: "--url" } });
  const out = (r.stdout || "") + (r.stderr || "");
  let mounted = false, crash = "(求值失败)";
  try {
    const j = JSON.parse(out.slice(out.indexOf("{")));
    mounted = !!j.mounted;
    crash = j.crash;
  } catch (e) { /* 输出里没有 JSON：直接算失败 */ }
  const okPage = mounted && crash === null;
  if (!okPage) fail++;
  console.log((okPage ? "PASS  " : "FAIL  ") + p +
    (okPage ? "" : "  mounted=" + mounted + " crash=" + JSON.stringify(crash)));
}
rmSync(expr, { force: true });
console.log(`\npage-smoke: ${PAGES.length - fail}/${PAGES.length} pass`);
process.exit(fail ? 1 : 0);
