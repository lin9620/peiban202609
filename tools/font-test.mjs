/* 字体层回归测试（Node 直跑：node tools/font-test.mjs）
 * ---------------------------------------------------------------------------
 * 背景（轮 436，用户：「现在需要你对网站的英文字体进行优化，现在的英文字体太丑了」）
 *
 * 查出来的四个原因，这条测试把它们逐条钉住：
 *   ① 伪粗体：index.html 只加载 Inter 400/500/600，而代码里 font-weight:700 用了 24 处、
 *      800 用了 4 处 → 浏览器把 600 的轮廓机械描粗（合成加粗），英文发胖、笔画黏连。
 *      EB Garamond 同样只加载 400/500，display 却写 600 → 衬线描粗后更糊。
 *      改法：换 Plus Jakarta Sans **可变字体**（wght 200–800 单文件），700/800 是真字形。
 *   ② 中英混排割裂：中文全站是霞鹜文楷（手写楷体、笔画细软有笔锋），英文是无衬线
 *      （笔画匀粗）→ 同一行里英文灰度明显重于中文，两种语言像来自两本书。
 *      改法：UI 文本换系统黑体（--font-cn），楷体只留给内容文本（--font-hand）。
 *   ③ 大字号没有负字距：30/34px 的英文标题用默认字距，显得松散。
 *      改法：展示字号按档补 letter-spacing（-0.25 ~ -0.9px）。
 *   ④ 加载成本：霞鹜文楷每字重 97 个 unicode-range 分片，原 style.css 里 import 了 6 套
 *      → 光 CSS 就要 ~630KB，国内 jsdelivr 实测 4.5s 起，弱网直接失败，
 *      回落到系统西文（Arial / 宋体附字体）—— 那才是真正难看的那种。
 *      改法：字体全部自托管进 public/fonts/（App 读本地文件零网络），楷体按项目实际用到的
 *      字符做子集（11.7MB → 603KB）。
 *
 * 钉住的契约：
 *   F1  两个 @font-face 存在、指向 /fonts/、Jakarta 是可变字重（不是单一静态字重）
 *   F2  --font-body / --font-display 用 Jakarta + 系统中文，**不许**再含 Inter / EB Garamond
 *   F3  --font-hand 用霞鹜文楷，且只有内容文本类用它
 *   F4  UI 文本类**不许**再用楷体（否则中英混排又回到不等重）
 *   F5  index.html 不许再引 Google Fonts / jsdelivr（那是 630KB CSS 与加载失败的来源）
 *   F6  只 preload 27KB 的 Jakarta；603KB 的楷体不许 preload（首屏抢带宽）
 *   F7  字体文件真实存在、体积在预算内（Jakarta < 60KB，楷体子集 < 800KB）
 *   F8  大字号展示文本必须有负字距
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

/* ── F2 字体栈 ────────────────────────────────────────────────── */
t("F2 --font-body / --font-display 用 Jakarta + 系统中文，不再含 Inter / Garamond", () => {
  const body = css.match(/--font-body:\s*([^;]+);/)?.[1] || "";
  const disp = css.match(/--font-display:\s*([^;]+);/)?.[1] || "";
  ok(body.includes("var(--font-latin)"), "--font-body 没走 --font-latin");
  ok(disp.includes("var(--font-latin)"), "--font-display 没走 --font-latin");
  ok(!/\bInter\b/.test(body + disp), "字体栈里还留着 Inter");
  ok(!/Garamond/.test(body + disp), "字体栈里还留着 EB Garamond");
  ok(!/LXGW/.test(body + disp), "UI 字体栈里还留着楷体（中英混排会重新不等重）");
});

/* ── F3/F4 中文分层 ───────────────────────────────────────────── */
t("F3 --font-hand 用霞鹜文楷，且只服务内容文本", () => {
  const hand = css.match(/--font-hand:\s*([^;]+);/)?.[1] || "";
  ok(hand.includes("LXGW WenKai"), "--font-hand 没用霞鹜文楷");
  const users = [...css.matchAll(/\.([a-z-]+)\s*\{[^}]*font-family:\s*var\(--font-hand\)/g)].map((x) => x[1]);
  const want = ["story-body", "quote-hero", "post-text", "bottle-record-text", "st-read-body"];
  for (const w of want) ok(users.includes(w), `.${w} 没用 --font-hand（内容文本应当保留手写温度）`);
  ok(users.length <= 8, `用 --font-hand 的类有 ${users.length} 个，太泛（楷体应只留给真正的内容文本）`);
});

t("F4 UI 文本类不许再用楷体（否则中英混排回到不等重）", () => {
  /* 这些是界面骨架：导航 / 按钮 / 标签 / 列表 / 私信气泡 —— 都用 --font-body */
  const ui = ["dm-text", "post-name", "status-name", "tabbar-opt-txt", "btn"];
  for (const u of ui) {
    const rule = css.match(new RegExp(`\\.${u}\\s*\\{[^}]*\\}`))?.[0] || "";
    ok(!/LXGW|--font-hand/.test(rule), `.${u} 还在用楷体`);
  }
});

/* ── F5 外部字体引用 ──────────────────────────────────────────── */
t("F5 index.html 不再引 Google Fonts / jsdelivr", () => {
  /* 先剔除 HTML 注释：注释里要说明「改前用的是 Inter / EB Garamond」，
     直接全文匹配会把说明文字当成引用。只看真正会被浏览器加载的标签。 */
  const htmlLive = html.replace(/<!--[\s\S]*?-->/g, "");
  ok(!/fonts\.googleapis\.com/.test(htmlLive), "还引着 fonts.googleapis.com");
  ok(!/fonts\.gstatic\.com/.test(htmlLive), "还引着 fonts.gstatic.com");
  ok(!/lxgw-wenkai-webfont/.test(htmlLive), "还引着 jsdelivr 的楷体包（97 分片 × 6 套 ≈ 630KB CSS）");
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
  ok(sj > 10_000 && sj < 60_000, `Jakarta 体积异常：${(sj / 1024).toFixed(0)}KB（预期 20–55KB）`);
  ok(sw > 100_000 && sw < 800_000, `楷体子集体积异常：${(sw / 1024).toFixed(0)}KB（预期 300–800KB；超过 800KB 说明没子集化）`);
});

/* ── F8 负字距 ────────────────────────────────────────────────── */
t("F8 大字号展示文本有负字距", () => {
  const big = [
    ["wb-name", 30], ["hero-title", 34], ["bt-title", 24], ["story-title", 26],
    ["st-read-title", 28], ["today-hi-title", 20], ["st-stat b", 20],
  ];
  for (const [sel, size] of big) {
    /* 同一个选择器可能有多条规则（如 .story-title 有 15.5px 的列表标题 + 26px 的展示标题），
       取「字号等于声明值」的那条；否则会拿小字号那条来判，凭空报错。 */
    const all = [...css.matchAll(new RegExp(`\\.${sel.replace(/ /g, "\\s+")}\\s*\\{[^}]*\\}`, "g"))].map((m) => m[0]);
    const rule = all.find((r) => r.replace(/\s+/g, "").includes(`font-size:${size}px`));
    ok(rule, `找不到 .${sel}（${size}px）的规则；实际有 ${all.length} 条：${all.map((r) => r.slice(0, 40)).join(" | ")}`);
    const ls = rule.match(/letter-spacing:\s*(-?[\d.]+)px/);
    ok(ls, `.${sel} 没有 letter-spacing`);
    ok(Number(ls[1]) < 0, `.${sel}（${size}px）的字距是 ${ls[1]}px，大字号必须为负值`);
  }
});

console.log(`\nTOTAL ${pass + fail}  PASS ${pass}  FAIL ${fail}`);
process.exit(fail ? 1 : 0);
