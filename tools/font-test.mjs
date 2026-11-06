/* 字体层回归测试（Node 直跑：node tools/font-test.mjs）
 * ---------------------------------------------------------------------------
 * 背景
 *   轮 436（用户：「英文字体太丑了」）：Google Fonts 只加载 Inter 400/500/600，
 *     而代码里 700 有 24 处、800 有 4 处 → 合成加粗，英文发胖发糊。
 *     改成可变字体（当时是 Plus Jakarta Sans）→ 伪粗体消失。
 *   轮 436b（用户：「你这中文字体，还不如原来的呢，改回原来的」）：
 *     试过的「UI 黑体 / 内容楷体」分层整体回滚，中文全站统一霞鹜文楷。
 *   轮 437b（用户：「我让你回退，为什么字体能占用这么大的体积，字体以前就有啊」）：
 *     楷体曾经被打进安装包（603KB→3.4MB），APK 从 6.8MB 涨到 9.7MB。
 *     但「以前」它根本不在包里 —— 是网页从 jsdelivr 拉的。现在回到那个做法：
 *     包内只留西文可变字体，中文楷体一律走 CDN。
 *   轮 456（用户：「英文字体确定了，用 reddit 的同款字体」「除了中文外的其他语言也是用 reddit 的」）：
 *     换成 Reddit Sans（Reddit 2023 自有字体，SIL OFL 1.1，Google Fonts latin 分片 41.8KB，
 *     wght 200–900 可变）。英/西/葡/法共用这一个文件，中文仍走霞鹜文楷。
 *
 * 钉住的契约：
 *   F1  Reddit Sans 的 @font-face 在、可变字重、swap；楷体不许有本地 @font-face
 *   F2  字体栈 = Reddit Sans + 霞鹜文楷（CDN family 名）+ 系统中文兜底，且西文只此一家
 *   F3  中文只有一层：不存在 --font-hand / --font-cn
 *   F4  index.html 必须引 CDN 的楷体（regular + bold），否则中文没有字体
 *   F5  不许再引 Google Fonts / Inter / EB Garamond / Jakarta
 *   F6  只 preload 41KB 的 Reddit Sans，不许 preload 楷体
 *   F7  public/fonts 里只准有 reddit-sans.woff2 一个字体文件，且 < 60KB（体积纪律）
 *   F8  主视觉大字号保留负字距
 */
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
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
t("F1 只有 Reddit Sans 的本地 @font-face（可变字重），楷体不许进包", () => {
  ok(/@font-face\s*\{[^}]*font-family:\s*"Reddit Sans"[^}]*url\("\/fonts\/reddit-sans\.woff2"\)/s.test(css),
    "缺少 Reddit Sans 的 @font-face 或路径不是 /fonts/");
  const m = css.match(/font-family:\s*"Reddit Sans";[\s\S]{0,220}?font-weight:\s*([^;]+);/);
  ok(m, "读不到 Reddit Sans 的 font-weight");
  ok(/^\s*\d+\s+\d+\s*$/.test(m[1]), `Reddit Sans 的 font-weight 不是区间（${m[1].trim()}），可变轴没生效 → 700/800 又会变伪粗体`);
  ok(/font-display:\s*swap/.test(css), "缺 font-display: swap（字体没到时文本会被隐藏）");
  /* 楷体只能来自 CDN。一旦本地写 @font-face 指向 /fonts/wenkai-*，就是又把它塞回包了 */
  ok(!/@font-face\s*\{[^}]*LXGW WenKai/s.test(css),
    "又给楷体写了本地 @font-face —— 楷体必须走 CDN（index.html 的 jsdelivr 引用），不要打进安装包");
});

/* ── F2 字体栈 ────────────────────────────────────────────────── */
t("F2 字体栈 = Reddit Sans + 霞鹜文楷 + 系统兜底", () => {
  const body = css.match(/--font-body:\s*([^;]+);/)?.[1] || "";
  const disp = css.match(/--font-display:\s*([^;]+);/)?.[1] || "";
  ok(body.includes("var(--font-latin)"), "--font-body 没走 --font-latin");
  ok(disp.includes("var(--font-latin)"), "--font-display 没走 --font-latin");
  ok(/--font-latin:\s*"Reddit Sans"/.test(css), "--font-latin 不是 Reddit Sans");
  ok(body.includes("LXGW WenKai"), "--font-body 没接霞鹜文楷（中文会掉回系统黑体）");
  ok(disp.includes("LXGW WenKai"), "--font-display 没接霞鹜文楷");
  ok(body.indexOf("LXGW WenKai") < body.indexOf("PingFang SC"), "楷体排在苹方后面 → iOS/macOS 上永远轮不到楷体");
  ok(!/\bInter\b/.test(body + disp), "字体栈里还留着 Inter");
  ok(!/Garamond/.test(body + disp), "字体栈里还留着 EB Garamond");
  ok(!/Jakarta/.test(body + disp), "字体栈里还留着旧的 Plus Jakarta Sans");
});

/* ── F3 中文单层 ─────────────────────────────────────────────── */
t("F3 中文只有一层：不存在 --font-hand / --font-cn", () => {
  ok(!/--font-hand\s*:/.test(css), "又出现了 --font-hand（轮 436b 已回滚的分层，别再加回来）");
  ok(!/--font-cn\s*:/.test(css), "又出现了 --font-cn（系统中文栈，会把界面中文切成黑体）");
  const content = ["story-body", "quote-hero", "post-text", "bottle-record-text", "st-read-body"];
  for (const c of content) {
    const rules = [...css.matchAll(new RegExp(`\\.${c}\\s*\\{[^}]*\\}`, "g"))].map((m) => m[0]);
    for (const r of rules) ok(!/font-family/.test(r), `.${c} 又单独声明了 font-family（应继承正文楷体）`);
  }
});

/* ── F4 楷体的 CDN 引用 ──────────────────────────────────────── */
t("F4 index.html 引了 CDN 的楷体（regular + bold）", () => {
  const live = html.replace(/<!--[\s\S]*?-->/g, "");
  ok(/lxgw-wenkai-webfont/.test(live), "index.html 没引霞鹜文楷 —— 中文会全部掉回系统黑体");
  ok(/lxgwwenkai-regular\.css/.test(live), "没引 regular 档（400 的正文会变黑体）");
  ok(/lxgwwenkai-bold\.css/.test(live), "没引 bold 档（700 的标题会被合成加粗，楷体看着像黑体）");
  ok(/cdn\.jsdelivr\.net/.test(live), "楷体不是从 jsdelivr 拿的？确认下 CDN 地址");
  ok(/<noscript>[\s\S]*lxgw-wenkai-webfont[\s\S]*<\/noscript>/.test(live), "缺 noscript 兜底（禁用 JS 时中文没字体）");
});

/* ── F5 外部字体引用 ──────────────────────────────────────────── */
t("F5 不引 Google Fonts / Inter / EB Garamond / 旧 Jakarta", () => {
  const live = html.replace(/<!--[\s\S]*?-->/g, "");
  ok(!/fonts\.googleapis\.com/.test(live), "还引着 fonts.googleapis.com");
  ok(!/fonts\.gstatic\.com/.test(live), "还引着 fonts.gstatic.com");
  ok(!/Inter|EB\+Garamond/.test(live), "index.html 里还有 Inter / EB Garamond 的引用");
  ok(!/plus-jakarta-sans|Jakarta/.test(live), "index.html 里还 preload 着旧的 Jakarta");
});

/* ── F6 preload 策略 ──────────────────────────────────────────── */
t("F6 只 preload 41KB 的 Reddit Sans，楷体不 preload", () => {
  ok(/rel="preload"[^>]*reddit-sans\.woff2/.test(html), "Reddit Sans 没 preload（首帧会闪系统字体）");
  ok(!/rel="preload"[^>]*wenkai/.test(html), "楷体被 preload 了 —— 它走 CDN，preload 会抢首屏带宽");
  ok(/as="font"/.test(html) && /crossorigin/.test(html), "preload 缺 as=font / crossorigin（字体会被下两次）");
});

/* ── F7 体积纪律 ──────────────────────────────────────────────── */
t("F7 public/fonts 只准有 Reddit Sans 一个字体，且 < 60KB", () => {
  const dir = join(root, "public/fonts");
  const fonts = readdirSync(dir).filter((f) => /\.(woff2?|ttf|otf)$/i.test(f));
  ok(fonts.length === 1, `public/fonts 里有 ${fonts.length} 个字体文件（${fonts.join(", ")}）—— 只有 Reddit Sans 该进包`);
  ok(fonts[0] === "reddit-sans.woff2", `包内字体是 ${fonts[0]}，不是 Reddit Sans`);
  const rs = join(dir, "reddit-sans.woff2");
  ok(existsSync(rs), "缺 public/fonts/reddit-sans.woff2");
  const sj = statSync(rs).size;
  ok(sj > 30_000 && sj < 60_000, `Reddit Sans 体积异常：${(sj / 1024).toFixed(0)}KB（latin 分片预期 40–45KB）`);
});

/* ── F8 负字距 ────────────────────────────────────────────────── */
t("F8 主视觉大字号保留负字距", () => {
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
