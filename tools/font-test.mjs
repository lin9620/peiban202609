/* 字体层回归测试（Node 直跑：node tools/font-test.mjs）
 * ---------------------------------------------------------------------------
 * 背景（轮 436，用户：「现在需要你对网站的英文字体进行优化，现在的英文字体太丑了」）
 *
 * 查出来的四个原因，这条测试把它们逐条钉住：
 *   ① 伪粗体：index.html 只加载 Inter 400/500/600，而代码里 font-weight:700 用了 24 处、
 *      800 用了 4 处 → 浏览器把 600 的轮廓机械描粗（合成加粗），英文发胖、笔画黏连。
 *      EB Garamond 同样只加载 400/500，display 却写 600 → 衬线描粗后更糊。
 *      改法：换 Plus Jakarta Sans **可变字体**（wght 200–800 单文件）→ 700/800 是真字形。
 *   ② 加载成本：霞鹜文楷每字重 97 个 unicode-range 分片，style.css 里 import 了 6 套（含 mono），
 *      光 CSS 就要 ~630KB，国内 jsdelivr 实测 4.5s 起，弱网直接失败。
 *      改法：字体全部自托管到 public/fonts/（App 读本地文件零网络），楷体按项目实际用到的
 *      字符做子集（11.7MB → 603KB）。
 *   ③ 大字号没有负字距：30/34px 的英文标题用默认字距，显得松散。
 *      改法：主视觉大字号保留负字距（436b 后其余标题按用户要求恢复默认字距）。
 *   ④ 中文字体分层：436 曾试过「UI 黑体 / 内容楷体」，用户否掉（中文不如原来的），
 *      436b 已整体回滚：中文全站统一霞鹜文楷，不再按用途拆字体层。
 *
 * 钉住的契约：
 *   F1  两个 @font-face 存在、指向 /fonts/、Jakarta 是可变字重（不是单一静态字重）
 *   F2  --font-body / --font-display 走 Jakarta + 霞鹜文楷，不再含 Inter / EB Garamond
 *   F3  中文全站统一楷体，不再出现 --font-hand / --font-cn 的分层变量
 *   F4  UI 文本类不硬编码楷体字体栈，统一走 --font-body / --font-display
 *   F5  index.html 不许再引 Google Fonts / jsdelivr（那是 630KB CSS 与加载失败的来源）
 *   F6  只 preload 27KB 的 Jakarta，603KB 的楷体不 preload（首屏抢带宽）
 *   F7  字体文件真实存在、体积在预算内（Jakarta < 60KB，楷体子集 < 800KB）
 *   F8  主视觉大字号保留负字距（.wb-name / .hero-title）
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const css = read("src/style.css");
const html = read("index.html");

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log("PASS  " + name); }
  catch (e) { fail++; console.log("FAIL  " + name + "\n      → " + e.message); }
};
const ok = (cond, msg) => { if (!cond) throw new Error(msg || "断言失败"); };

/* ── F1 @font-face ────────────────────────────────────────────── */
t("F1 两个 @font-face：自托管 /fonts/、Jakarta 为可变字重", () => {
  ok(/@font-face\s*\{[^}]*font-family:\s*"Plus Jakarta Sans"[^}]*url\("\/fonts\/plus-jakarta-sans\.woff2"\)/s.test(css),
    "缺少 Plus Jakarta Sans 的 @font-face 或路径不是 /fonts/");
  ok(/@font-face\s*\{[^}]*font-family:\s*"LXGW WenKai"[^}]*url\("\/fonts\/wenkai-subset\.woff2"\)/s.test(css),
    "缺少 LXGW WenKai 的 @font-face 或路径不是 /fonts/");
  /* 可变字重是「700/800 不再是伪粗体」的根：单一数字（如 400）说明退化回静态字体了 */
  const m = css.match(/font-family:\s*"Plus Jakarta Sans";[\s\S]{0,220}?font-weight:\s*([^;]+);/);
  ok(m, "读不到 Jakarta 的 font-weight");
  ok(/^\s*\d+\s+\d+\s*$/.test(m[1]), `Jakarta 的 font-weight 不是区间（${m[1].trim()}），可变轴没生效 → 700/800 又会变伪粗体`);
  ok(/font-display:\s*swap/.test(css), "缺 font-display: swap（字体没到时文本会被隐藏）");
});

/* ── F2 字体栈 ─────────────────────────────────────────────────── */
t("F2 --font-body / --font-display 走 Jakarta + 霞鹜文楷，不再含 Inter / Garamond", () => {
  const body = css.match(/--font-body:\s*([^;]+);/)?.[1] || "";
  const disp = css.match(/--font-display:\s*([^;]+);/)?.[1] || "";
  ok(body.includes("var(--font-latin)"), "--font-body 没走 --font-latin");
  ok(disp.includes("var(--font-latin)"), "--font-display 没走 --font-latin");
  ok(body.includes("LXGW WenKai"), "--font-body 没接霞鹜文楷");
  ok(disp.includes("LXGW WenKai"), "--font-display 没接霞鹜文楷");
  ok(!/\bInter\b/.test(body + disp), "字体栈里还留着 Inter");
  ok(!/Garamond/.test(body + disp), "字体栈里还留着 EB Garamond");
});

/* ── F3 中文分层回滚 ──────────────────────────────────────────── */
t("F3 中文全站统一楷体，不再出现 --font-hand / --font-cn 分层变量", () => {
  ok(!/--font-hand\s*:/.test(css), "又出现了 --font-hand 分层变量");
  ok(!/--font-cn\s*:/.test(css), "又出现了 --font-cn 分层变量");
  ok(!/font-family:\s*var\(--font-hand\)/.test(css), "还有选择器在用 --font-hand");
  ok(/body\s*\{[^}]*font-family:\s*var\(--font-body\)/s.test(css), "body 没走 --font-body");
});

/* ── F4 UI 文本硬编码 ────────────────────────────────────────── */
t("F4 UI 文本类不硬编码楷体字体栈，统一走字体变量", () => {
  /* 这些是界面骨架：导航 / 按钮 / 标签 / 列表 / 私信气泡 */
  const ui = ["dm-text", "post-name", "status-name", "tabbar-opt-txt", "btn"];
  for (const u of ui) {
    const rule = css.match(new RegExp(`\\.${u}\\s*\\{[^}]*\\}`))?.[0] || "";
    ok(!/font-family:\s*["']?LXGW|font-family:\s*var\(--font-hand\)/.test(rule),
      `.${u} 还在硬编码楷体/分层变量`);
  }
});

/* ── F5 外部字体引用 ──────────────────────────────────────────── */
t("F5 index.html 不再引 Google Fonts / jsdelivr", () => {
  /* 先剔掉 HTML 注释：注释里要说明「改前用的是 Inter / EB Garamond」，
     直接全文匹配会把说明文字当成引用。只看真正会被浏览器加载的标签。 */
  const htmlLive = html.replace(/<!--[\s\S]*?-->/g, "");
  ok(!/fonts\.googleapis\.com/.test(htmlLive), "还引着 fonts.googleapis.com");
  ok(!/fonts\.gstatic\.com/.test(htmlLive), "还引着 fonts.gstatic.com");
  ok(!/lxgw-wenkai-webfont/.test(htmlLive), "还引着 jsdelivr 的楷体包（97 分片 × 6 套 → 630KB CSS）");
  ok(!/Inter|EB\+Garamond/.test(htmlLive), "index.html 里还有 Inter / EB Garamond 的引用");
});

/* ── F6 preload 策略 ──────────────────────────────────────────── */
t("F6 只 preload 27KB 的 Jakarta，603KB 的楷体不 preload", () => {
  ok(/rel="preload"[^>]*plus-jakarta-sans\.woff2/.test(html), "Jakarta 没 preload（首帧会闪系统字体）");
  ok(!/rel="preload"[^>]*wenkai-subset\.woff2/.test(html), "楷体被 preload 了 —— 603KB 会抢首屏带宽");
  ok(/as="font"/.test(html) && /crossorigin/.test(html), "preload 缺 as=font / crossorigin（字体会被下两次）");
});

/* ── F7 文件体积 ──────────────────────────────────────────────── */
t("F7 字体文件存在且体积在预算内", () => {
  const jk = join(root, "public/fonts/plus-jakarta-sans.woff2");
  const wk = join(root, "public/fonts/wenkai-subset.woff2");
  ok(existsSync(jk), "缺 public/fonts/plus-jakarta-sans.woff2");
  ok(existsSync(wk), "缺 public/fonts/wenkai-subset.woff2");
  const sj = statSync(jk).size, sw = statSync(wk).size;
  ok(sj > 10_000 && sj < 60_000, `Jakarta 体积异常：${(sj / 1024).toFixed(0)}KB（预期 20–35KB）`);
  ok(sw > 100_000 && sw < 800_000, `楷体子集体积异常：${(sw / 1024).toFixed(0)}KB（预期 300–700KB；超过 800KB 说明没子集化）`);
});

/* ── F8 负字距 ────────────────────────────────────────────────── */
t("F8 主视觉大字号保留负字距（436b 后其余标题恢复默认字距）", () => {
  const big = [["wb-name", 30], ["hero-title", 34]];
  for (const [sel, size] of big) {
    const all = [...css.matchAll(new RegExp(`\\.${sel}\\s*\\{[^}]*\\}`, "g"))].map((m) => m[0]);
    const rule = all.find((r) => r.replace(/\s+/g, "").includes(`font-size:${size}px`));
    ok(rule, `找不到 .${sel}（${size}px）的规则；实际有 ${all.length} 条`);
    const ls = rule.match(/letter-spacing:\s*(-?[\d.]+)px/);
    ok(ls, `.${sel} 没有 letter-spacing`);
    ok(Number(ls[1]) < 0, `.${sel}（${size}px）的字距是 ${ls[1]}px，主视觉大字号必须为负值`);
  }
});

console.log(`\nTOTAL ${pass + fail}  PASS ${pass}  FAIL ${fail}`);
process.exit(fail ? 1 : 0);
