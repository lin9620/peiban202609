/* 轮 183 · 表情面板真交互回归（构建 harness → 起静态服务 → 无头 Edge 真点 → 断言）
 *   node tools/emo-drive.mjs [--keep]
 * 背景见 tools/emo-harness/main.js 顶部：前两轮全是字符串断言，用户真机连报三次。
 */
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(root, "tools", "_emo-harness-dist");
const keep = process.argv.includes("--keep");

/* 1) 单独把 harness 构建成一个真页面（引的是仓库里真的 src/ 组件与 style.css） */
const cfg = path.join(root, "tools", "emo-harness", "vite.harness.config.mjs");
writeFileSync(cfg, `import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import path from "node:path";
const R = ${JSON.stringify(root)};
export default defineConfig({
  root: path.join(R, "tools", "emo-harness"),
  base: "./",
  plugins: [vue()],
  resolve: { alias: { "@": path.join(R, "src") } },
  define: { "process.env.NODE_ENV": '"production"' },
  build: { outDir: ${JSON.stringify(OUT)}, emptyOutDir: true, target: "es2019" },
});
`);
const b = spawnSync(process.execPath, [path.join(root, "node_modules", "vite", "bin", "vite.js"), "build", "--config", cfg],
  { cwd: root, encoding: "utf8" });
if (b.status !== 0) { console.error("HARNESS_BUILD_FAIL\n" + (b.stdout || "") + (b.stderr || "")); process.exit(1); }

/* 2) 每个宿主跑一遍场景 */
const expr = path.join(root, "tools", "_emo-drive-expr.js");
writeFileSync(expr, `(async () => {
  for (let i = 0; i < 60 && !window.__ready; i++) await new Promise(r => setTimeout(r, 100));
  if (!window.__ready) return { error: "harness-not-ready" };
  return await window.__scenario();
})()`);

const results = {};
for (const which of ["chat", "wall"]) {
  const r = spawnSync(process.execPath, [
    "tools/web-probe.mjs", `--serve=${OUT}`, `--url=/index.html#${which}`,
    "--w=393", "--h=852", "--wait=3000", `--file=${expr}`,
  ], { cwd: root, encoding: "utf8", env: { ...process.env, MSYS2_ARG_CONV_EXCL: "--url" } });
  const out = (r.stdout || "") + (r.stderr || "");
  try { results[which] = JSON.parse(out.slice(out.indexOf("{"))); }
  catch (e) { results[which] = { error: "no-json", raw: out.slice(-400) }; }
}

/* 3) 断言：期望值写死在这儿，任何一条不符就是回归 */
let fail = 0;
const ok = (cond, msg, got) => { if (!cond) { fail++; console.log("FAIL  " + msg + "  got=" + JSON.stringify(got)); } else console.log("PASS  " + msg); };
const step = (r, k) => (r.steps || []).find((s) => s[0] === k)?.[1];

for (const which of ["chat", "wall"]) {
  const r = results[which];
  console.log(`\n──── ${which} ────`);
  if (!r || r.error) { fail++; console.log("FAIL  场景没跑起来  " + JSON.stringify(r)); continue; }
  console.log(JSON.stringify(r.steps));
  const open = step(r, "sheetOpen"), pick = step(r, "afterPick"), off = step(r, "afterToggleOff"), fin = step(r, "final");

  ok(open.panel && open.cells === 64, `${which} 点按钮面板打开且 64 个表情`, open);
  ok(open.panelH === 310, `${which} 面板高度 == 实测键盘高 310`, open.panelH);
  ok(open.inputVisible && open.barVisible, `${which} 面板展开时输入框仍可见（没被顶出屏幕）`, open);
  /* 输入行底 == 面板顶：面板就贴在输入框下面，中间不留缝也不重叠 */
  ok(Math.abs(open.barBottom - open.panelTop) <= 1, `${which} 输入行底正好压在面板顶上（无缝隙/无重叠）`,
    { barBottom: open.barBottom, panelTop: open.panelTop });

  /* 光标在第 3 位（"abc|def"），两个表情各占 2 个 UTF-16 码元 → 插完是abc😊😄def，光标 7 */
  const WANT = "abc😊😄def", WANT_CARET = 7;
  ok(pick.text === WANT, `${which} 连点两个表情插在光标处（不是末尾）`, pick.text);
  ok(pick.stillOpen, `${which} 选完不收面板（可连选）`, pick.stillOpen);
  ok(pick.inputVisible, `${which} 选完表情输入框还在（用户报的第二条：直接隐藏输入框）`, pick);

  ok(off.closed, `${which} 再点按钮收起`, off.closed);
  ok(off.text === WANT, `${which} 收起后文字没丢`, off.text);
  ok(off.focused, `${which} 收起后焦点自动回到输入框（不用再点一次）`, off.focused);
  /* 用户报的第一条：光标跳回首字。必须停在最后插入的表情后（7），不是 0 也不是文本末尾 10 */
  ok(off.caret === WANT_CARET, `${which} 光标停在最后插入的表情后（不是首字、不是末尾）`, { got: off.caret, want: WANT_CARET });
  ok(off.inputVisible && off.barVisible, `${which} 收起后输入框可见`, off);
  ok(off.marginCleared, `${which} 收起后 margin 复位`, off.marginCleared);
  ok(fin.inputVisible && fin.barVisible, `${which} 键盘回来后输入框仍可见`, fin);
}

if (!keep) { rmSync(OUT, { recursive: true, force: true }); rmSync(cfg, { force: true }); rmSync(expr, { force: true }); }
console.log(`\nemo-drive: ${fail === 0 ? "ALL PASS" : fail + " FAIL"}`);
process.exit(fail === 0 ? 0 : 1);