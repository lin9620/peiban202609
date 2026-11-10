/* 分享面板护栏（Node 直跑：node tools/share-page-test.mjs）
 * ------------------------------------------------------------
 * 轮 501。用户（附「我的」页分享面板截图 + 红框圈出那行小字）：
 *   「你这个分享怎么做的，我们是面向海外用户，你搞这个？？重新设计这个分享功能」
 *
 * 病根不是样式，是**受众**：面板里只有「复制后粘到微信 / QQ 发给朋友」，
 * 五语种里的 WeChat / QQ 全是从中文版直接抄过去的 —— 对英语/西语/葡语/法语区的
 * 用户来说，这不是少一个入口，是**看不出这产品是给他的**。
 *
 * 现在钉住六件事：
 *   ① 首选系统分享（navigator.share），用户取消不算失败；缺席或抛错才开面板；
 *   ② 面板必须给直连渠道：WhatsApp / Telegram / X / Facebook / Email / SMS + 复制；
 *   ③ 分享出去的地址是**站点首页**，不是只有自己看得懂的 /profile；
 *   ④ 任何语种的可见文案里都不许再出现 WeChat / QQ / 微信；
 *   ⑤ 复制走 utils/clipboard（带 execCommand 兜底）；失败必须说话，不许静默；
 *   ⑥ 面板层级 / Teleport / 主题色 / 五语种文案齐全。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { messages } from "../src/i18n.js";
import { shareUrl, shareHref, SHARE_TARGETS, SITE_ORIGIN } from "../src/utils/shareLinks.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

let pass = 0;
let fail = 0;
const out = [];
function t(name, fn) {
  try {
    fn();
    pass++;
    out.push("ok   " + name);
  } catch (e) {
    fail++;
    out.push("FAIL " + name + " :: " + e.message);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const pv = read("src/views/ProfileView.vue");
const i18n = read("src/i18n.js");
const es = read("src/i18n.es.js");
const fr = read("src/i18n.fr.js");
const pt = read("src/i18n.pt.js");
const clip = read("src/utils/clipboard.js");
const links = read("src/utils/shareLinks.js");
const pkg = JSON.parse(read("package.json"));

/* 抠出 sharePage 函数体，避免整文件正则误伤 */
const shareFn = (() => {
  const i = pv.indexOf("async function sharePage");
  assert(i > 0, "ProfileView 里找不到 sharePage —— 函数被改名或删了");
  const j = pv.indexOf("\nfunction ", i + 10);
  return pv.slice(i, j > 0 ? j : i + 1800);
})();

/* ─── ① 系统分享优先 ─── */
t("S1 系统分享优先；缺席时开面板（不许静默复制了事）", () => {
  assert(/navigator\.share/.test(shareFn), "sharePage 没检测 navigator.share");
  assert(/shareOpen\.value\s*=\s*true/.test(shareFn), "sharePage 没有开面板 —— 又会变成「只闪一句已复制」");
  assert(!/copyText/.test(shareFn), "sharePage 里直接调了 copyText —— 那是静默降级的旧行为");
  /* 系统分享必须在开面板之前尝试（顺序反了 = 面板先弹、系统面板后弹，两层叠着） */
  const iShare = shareFn.indexOf("navigator.share(");
  const iOpen = shareFn.indexOf("shareOpen.value = true");
  assert(iShare > 0 && iOpen > iShare, "开面板写在了系统分享前面（会两层叠着弹）");
});

t("S2 用户取消（AbortError）静默退出；其它错误落到面板", () => {
  assert(/AbortError/.test(shareFn), "没有单独处理 AbortError（用户点取消不该弹面板）");
  const catchPart = shareFn.slice(shareFn.indexOf("catch"));
  assert(/shareOpen\.value\s*=\s*true/.test(catchPart), "catch 之后没开面板（分享失败会变成什么都不发生）");
});

/* ─── ② 直连渠道（本轮的主角） ─── */
t("S3 六个直连渠道齐全，且都在面板里渲染", () => {
  const want = ["whatsapp", "telegram", "x", "facebook", "email", "sms"];
  assert(SHARE_TARGETS.length === want.length && want.every((k) => SHARE_TARGETS.includes(k)),
    `渠道表是 ${SHARE_TARGETS.join("/")}，应为 ${want.join("/")}`);
  assert(/SHARE_TARGETS/.test(pv) && /v-for="k in SHARE_TARGETS"/.test(pv), "面板没有按 SHARE_TARGETS 渲染格子");
  for (const k of want) {
    assert(new RegExp("case \"" + k + "\":").test(links), `shareLinks 里没有 ${k} 的拼法`);
    assert(new RegExp("\\b" + k + ":\\s*\\[").test(pv), `ProfileView 的 GLYPHS 缺 ${k} 图标`);
  }
  /* 九宫格里只能有 v-for 这一个按钮：多写一个「复制」就会孤零零多出一行
     （3 列 × 6 渠道刚好两行；第 7 个格子必然落单 —— 第一版就是这么翻车的） */
  const iGrid = pv.indexOf('<div class="share-grid">');
  assert(iGrid > 0, "找不到 .share-grid");
  const grid = pv.slice(iGrid, pv.indexOf("</div>", iGrid));
  assert((grid.match(/<button/g) || []).length === 1, "格子块里除了 v-for 还多写了按钮（会多一行落单的格子）");
});

t("S4 每个渠道都是公开 share intent（不要 SDK / 不要私有 scheme）", () => {
  const meta = { url: "https://warmpaws.de5.net/", text: "hi there & more", subject: "Warm Paws" };
  assert(/^https:\/\/wa\.me\/\?text=/.test(shareHref("whatsapp", meta)), "WhatsApp 不是 wa.me 入口");
  assert(/^https:\/\/t\.me\/share\/url\?url=/.test(shareHref("telegram", meta)), "Telegram 不是 t.me/share 入口");
  assert(/^https:\/\/x\.com\/intent\/post\?/.test(shareHref("x", meta)), "X 不是 intent/post 入口");
  assert(/^https:\/\/www\.facebook\.com\/sharer\/sharer\.php\?u=/.test(shareHref("facebook", meta)), "Facebook 不是 sharer 入口");
  assert(/^mailto:\?subject=/.test(shareHref("email", meta)), "Email 不是 mailto");
  assert(/^sms:\?&body=/.test(shareHref("sms", meta)), "SMS 不是 sms: 入口");
  assert(shareHref("wechat", meta) === "", "未知渠道应返回空串（调用方据此忽略）");
});

t("S5 正文与链接都做过 URL 编码（含 & / 空格 / 换行）", () => {
  const href = shareHref("x", { url: "https://warmpaws.de5.net/?a=1&b=2", text: "A & B 你好" });
  assert(!/A & B/.test(href), "正文没编码（空格和 & 会把 intent 参数切断）");
  assert(href.includes("%26") || href.includes("%20"), "正文里的 & / 空格没转义");
  assert(href.includes(encodeURIComponent("https://warmpaws.de5.net/?a=1&b=2")), "链接没编码");
  const mail = shareHref("email", { url: "https://warmpaws.de5.net/", text: "line1" });
  assert(mail.includes("%0A%0A"), "邮件正文没用 %0A 换行（多数客户端会把整段挤成一行）");
});

/* ─── ③ 分享的是首页，不是「我的」页 ─── */
t("S6 分享链接取站点首页（陌生人点开 /profile 只有登录提示，等于没分享）", () => {
  assert(shareUrl("https://warmpaws.de5.net/profile") === "https://warmpaws.de5.net/",
    "shareUrl 没把 /profile 收成首页");
  assert(shareUrl("https://warmpaws.de5.net/community?x=1").endsWith("de5.net/"), "带查询串时没回收成首页");
  const app = shareUrl("capacitor://localhost/profile");
  assert(app === SITE_ORIGIN + "/", "App 内 WebView 的 capacitor:// 地址被原样拿去分享了");
  /* 安卓 WebView 的 origin 是 https://localhost（看起来像 https，其实是本机） */
  assert(shareUrl("https://localhost/profile") === SITE_ORIGIN + "/", "App 内 https://localhost 被当成真地址分享了");
  assert(shareUrl("http://127.0.0.1:5173/profile") === SITE_ORIGIN + "/", "开发预览的 127.0.0.1 被拿去分享了");
  assert(shareUrl("") === SITE_ORIGIN + "/", "空地址没回落到正式站点");
  assert(/<span class="share-url">/.test(pv) && /shareLink/.test(pv), "面板里没显示要分享的地址");
});

/* ─── ④ 受众：不许再出现微信 / QQ ─── */
t("S7 五语种的可见文案里再没有 WeChat / QQ / 微信", () => {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const [name, src] of [["i18n.js", i18n], ["i18n.es.js", es], ["i18n.fr.js", fr], ["i18n.pt.js", pt]]) {
    const body = strip(src);
    for (const bad of ["WeChat", "QQ", "微信"]) {
      assert(!body.includes(bad), `${name} 里还有「${bad}」—— 面向海外用户的界面不能出现`);
    }
  }
  /* 之前那行红框小字（复制后粘到微信/QQ）必须彻底消失 */
  assert(!/shareHowto/.test(pv) && !/shareHowto/.test(i18n), "旧的 shareHowto（粘到微信/QQ）还在");
});

t("S8 「点了没反应」的兜底提示留给内置浏览器，文案与平台无关", () => {
  assert(/MicroMessenger/i.test(pv), "没有识别内置浏览器（微信/QQ 内置 WebView 里直连会失效）");
  assert(/share-tip-wx/.test(pv) && /inWeChat/.test(pv), "内置浏览器的 ··· 提示缺失");
  const zhWx = messages.zh.profile.shareWx;
  assert(/···/.test(zhWx) && !/微信|WeChat/.test(zhWx), "中文兜底提示还在点名微信：" + zhWx);
});

/* ─── ⑤ 复制 ─── */
t("S9 复制走 utils/clipboard 的 copyText（带 execCommand 兜底），失败要说话", () => {
  assert(/import\s*\{[^}]*copyText[^}]*\}\s*from\s*"\.\.\/utils\/clipboard\.js"/.test(pv),
    "ProfileView 没引入 copyText");
  assert(/execCommand\("copy"\)/.test(clip), "clipboard.js 的 execCommand 兜底没了");
  assert(!/navigator\.clipboard\.writeText/.test(pv), "ProfileView 又直连 navigator.clipboard（老内核/非安全上下文会失败）");
  assert(/profile\.shareFail/.test(pv), "复制失败没有提示（静默失败 = 用户以为按钮坏了）");
});

/* ─── ⑥ 结构 / 样式 / 文案 ─── */
t("S10 面板：遮罩点空白关闭 + 地址行可复制 + 关闭按钮", () => {
  assert(/v-if="shareOpen"/.test(pv), "模板里没有 v-if=\"shareOpen\"");
  assert(/class="share-mask"[^>]*@click\.self="closeShare"/.test(pv), "遮罩没有 @click.self 关闭（点空白关不掉）");
  assert(/class="share-copy"/.test(pv) && /copyShareLink/.test(pv), "地址行不是复制按钮 / 没接 copyShareLink");
  assert(/class="share-close"/.test(pv), "没有关闭按钮（手机手势不规范时只能靠它）");
});

t("S11 文案五语种齐全（缺一条退英文，面板里中英混排）", () => {
  const keys = ["shareTitle", "shareSub", "shareSubject", "shareNative", "shareDirect",
    "shareCopy", "shareCopied", "shareFail", "shareHint", "shareWx",
    "shareWhatsapp", "shareTelegram", "shareX", "shareFacebook", "shareEmail", "shareSms"];
  for (const loc of ["en", "zh", "es", "pt", "fr"]) {
    const p = messages[loc] && messages[loc].profile;
    assert(p, `messages.${loc}.profile 不存在`);
    for (const k of keys) {
      const v = p[k];
      assert(typeof v === "string" && v.trim(), `messages.${loc}.profile.${k} 缺失或为空`);
    }
  }
  /* 品牌名在各语种里保持一致（译成「电报」「脸书」等于把入口藏起来） */
  for (const loc of ["en", "zh", "es", "pt", "fr"]) {
    const p = messages[loc].profile;
    assert(p.shareWhatsapp === "WhatsApp" && p.shareTelegram === "Telegram" && p.shareX === "X"
      && p.shareFacebook === "Facebook", `${loc} 把品牌名翻译了`);
  }
});

t("S12 标签用字面量映射（模板里拼 key 会让 i18n-usage-test 把新键判成死键）", () => {
  assert(/const TARGET_LABEL = \{/.test(pv), "没有 TARGET_LABEL 字面量映射");
  assert(/t\(TARGET_LABEL\[k\]\)/.test(pv), "模板没走 TARGET_LABEL");
  assert(!/t\("profile\.share"\s*\+/.test(pv), "模板里还在拼 i18n key");
});

t("S13 层级压过底栏 140 与聊天壳 200、低于维护遮罩 4000", () => {
  const m = pv.match(/\.share-mask\s*\{[^}]*z-index:\s*(\d+)/);
  assert(m, ".share-mask 没有 z-index");
  const z = Number(m[1]);
  assert(z > 200, `.share-mask z-index=${z}，会被底栏(140)/聊天壳(200) 盖住`);
  assert(z < 4000, `.share-mask z-index=${z}，会盖住维护遮罩(4000)`);
});

t("S14 面板表面走主题变量（夜间主题不许一片白），X 标跟着主题反转", () => {
  const m = pv.match(/\.share-sheet\s*\{[\s\S]*?\n\}/);
  assert(m, "找不到 .share-sheet 规则");
  const block = m[0];
  const bg = (block.match(/background(?:-color)?:\s*([^;]+);/) || [])[1];
  assert(bg && /var\(--/.test(bg), `.share-sheet 背景写死了色值（${(bg || "").trim()}），换主题不会跟随`);
  assert(/background-color:\s*var\(--/.test(block) && /background-image:\s*linear-gradient/.test(block),
    "只有半透明卡色、没有不透明打底（glass 主题下会透出页面）");
  assert(/\.is-x[^{]*\{[^}]*--tile:\s*var\(--ink\)/.test(pv), "X 图标底色写死了，没有跟随主题");
  /* 反过来：邮件/短信**不能**用会随主题翻面的变量（夜间主题里 --accent-deep 变浅色，
     白字当场只剩 1.6:1 对比度 —— 实测这两格几乎看不见） */
  for (const k of ["email", "sms"]) {
    const m2 = pv.match(new RegExp("\\.share-tile\\.is-" + k + "\\s*\\{([^}]*)\\}"));
    assert(m2, `找不到 .is-${k} 的配色`);
    assert(/--tile:\s*#[0-9a-f]{3,8};/i.test(m2[1]), `.is-${k} 用了主题变量当底色，夜间会翻成浅底白字`);
  }
});

t("S15 面板必须 Teleport 到 body（否则被根级底栏盖住）", () => {
  assert(/<Teleport\s+to="body">[\s\S]{0,900}?class="share-mask"/.test(pv),
    "share-mask 没在 <Teleport to=\"body\"> 里 —— 会被底栏(140)盖住");
  const count = (pv.match(/class="share-mask"/g) || []).length;
  assert(count === 1, `share-mask 出现 ${count} 次（应只有 1 处）`);
});

t("S16 按钮关掉 300ms 点击延迟（面板里每个可点元素都要）", () => {
  assert(/\.share-copy[^{]*\{[^}]*touch-action:\s*manipulation/.test(pv), ".share-copy 没设 touch-action: manipulation");
  assert(/\.share-close[^{]*\{[^}]*touch-action:\s*manipulation/.test(pv), ".share-close 没设 touch-action: manipulation");
  assert(/\.share-tile[^{]*\{[^}]*touch-action:\s*manipulation/.test(pv), ".share-tile 没设 touch-action: manipulation");
});

t("S17 shareLinks 是纯函数（不碰 DOM / 不读 UA），能直接被 Node 单测", () => {
  const body = links.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert(!/document\.|window\.|navigator\./.test(body), "shareLinks.js 里出现了 DOM/UA 依赖，纯函数性质没了");
  assert(typeof pkg.version === "string" && pkg.version.length > 0, "package.json 版本号丢了");
});

console.log(out.join("\n"));
console.log(`\n${pass} pass, ${fail} fail  →  ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
