/* 隐私政策页回归测试：node tools/privacy-test.mjs
 * ------------------------------------------------------------
 * 为什么单独一套测试：
 *   这页是给「站点外的人」看的 —— 一是 Google Cloud Console 的 OAuth 发布审核
 *   要求一个可公开访问、内容真实的 Privacy policy URL；二是普通访客想弄清
 *   自己的数据去了哪里。所以除了「页面能不能显示」，更要锁住
 *   Google 审核会逐条核对的合规表述（权限范围 / 不转售 / 不投放广告 /
 *   Limited Use / 撤销授权的方式），以及路由、页脚入口、sitemap、
 *   预渲染产物这些「外部能不能找到这页」的链路。
 *   文案改了但漏了某条合规表述，或路由被通配兜底吃掉，这里都会红。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { messages, t, i18n } from "../src/i18n.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const exists = (p) => fs.existsSync(path.join(root, p));

let pass = 0, fail = 0;
const out = [];
const t_ = (name, fn) => {
  try { fn(); pass++; out.push("PASS  " + name); }
  catch (e) { fail++; out.push("FAIL  " + name + "  → " + e.message); }
};

/* 渲染成某语言的一句话，断言里读起来更直观 */
const say = (loc, key, params) => { i18n.locale = loc; return t(key, params); };
/** 该 key 在两种语言下都要包含这些关键词（大小写不敏感） */
const bothHave = (key, words) => {
  for (const loc of ["en", "zh"]) {
    const s = String(say(loc, key)).toLowerCase();
    for (const w of words) {
      assert.ok(s.includes(w.toLowerCase()), `${loc} 的 ${key} 缺少「${w}」：${s}`);
    }
  }
};
/** 只查某一种语言（合规要点多为英中不同措辞，必须分开指定） */
const has = (loc, key, words, params) => {
  const s = String(say(loc, key, params)).toLowerCase();
  for (const w of words) {
    assert.ok(s.includes(w.toLowerCase()), `${loc} 的 ${key} 缺少「${w}」：${s}`);
  }
};

const view = read("src/views/PrivacyView.vue");
const router = read("src/router.js");
const css = read("src/style.css");
const app = read("src/App.vue");
const vite = read("vite.config.js");
const sm = read("public/sitemap.xml");

/* ═════════ ① 路由与入口：外部找得到这页 ═════════ */
t_("P1 路由 /privacy 已登记且命名 privacy", () => {
  assert.ok(/path:\s*"\/privacy",\s*name:\s*"privacy"/.test(router), "缺少 /privacy 路由");
});
t_("P2 /privacy 按需加载（不拖首屏）", () => {
  assert.ok(/name:\s*"privacy",\s*component:\s*\(\)\s*=>\s*import\(\s*"\.\/views\/PrivacyView\.vue"\s*\)/.test(router),
    "privacy 未使用动态 import");
});
t_("P3 通配兜底在 /privacy 之后（否则会被重定向回首页）", () => {
  const iPrivacy = router.indexOf('path: "/privacy"');
  const iCatch = router.indexOf(":pathMatch");
  assert.ok(iPrivacy > 0 && iCatch > iPrivacy, "通配路由出现在 /privacy 之前");
});
t_("P4 页脚有常驻入口", () => {
  assert.ok(app.includes('<router-link to="/privacy"'), "页脚缺少 /privacy 链接");
  assert.ok(app.includes('t("privacy.title")'), "页脚链接文案未走 i18n");
});
t_("P5 sitemap 登记 /privacy", () => {
  assert.ok(sm.includes("<loc>https://dale.de5.net/privacy</loc>"), "sitemap 未登记");
  assert.ok(/<loc>https:\/\/dale\.de5\.net\/privacy<\/loc>[\s\S]{0,120}<\/url>/.test(sm), "url 项结构不完整");
});
t_("P6 预渲染：/privacy 会生成独立静态 HTML", () => {
  assert.ok(/dir:\s*"privacy"/.test(vite), "vite.config.js 的 seoRoutes 缺少 privacy");
  assert.ok(vite.includes("Warm Paws · Privacy Policy"), "缺少独立标题");
  assert.ok(vite.includes("how Google sign-in data is used"), "缺少独立描述");
  assert.ok(vite.includes("/privacy"), "seo-routes 日志未登记 privacy");
});

/* ═════════ ② 页面结构：文案都在 i18n，模板不堆字 ═════════ */
t_("P7 组件单根节点（多根会让过渡白屏）", () => {
  const tpl = view.slice(view.indexOf("<template>"));
  const roots = tpl.match(/\n {2}<(div|section|main)\b/g) || [];
  assert.equal(roots.length, 1, `模板顶层节点数=${roots.length}`);
  assert.ok(tpl.includes('class="legal-page"'), "根节点缺少 legal-page 类");
});
t_("P8 模板里没有硬编码正文（全部走 t()）", () => {
  const tpl = view.slice(view.indexOf("<template>"));
  /* 插值里只允许 t(...) / 变量 / 章节字段，不允许写死字符串。
     t("privacy.title") 里的引号是「取词条的钥匙」，不是硬编码文案，先剥掉再查 */
  for (const m of tpl.matchAll(/\{\{([^}]*)\}\}/g)) {
    const expr = m[1].replace(/\bt\(\s*"[^"]*"\s*(?:\{[^}]*\})?\s*\)/g, "T").trim();
    assert.ok(!/["'][^"']*[A-Za-z]{4}/.test(expr), `插值里写死了文案：${expr}`);
  }
  /* 标签之间也不该出现整句英文（emoji、符号除外） */
  assert.ok(!/>\s*[A-Z][a-z]+\s+[a-z]+\s+[a-z]+/.test(tpl), "模板里出现硬编码英文句子");
});
t_("P9 13 个章节全部接上（含单独渲染的联系方式节）", () => {
  for (let i = 1; i <= 12; i++) assert.ok(view.includes(`privacy.s${i}t`), `缺少第 ${i} 节`);
  assert.ok(view.includes('t("privacy.s13t")'), "缺少联系方式节");
  assert.ok(view.includes('t("privacy.s13p1", { mail: CONTACT_MAIL })'), "联系方式未插入真实邮箱");
});
t_("P10 列表型文案（s2l/s3l/s4l/s9l）由数组驱动，模板能容错", () => {
  for (const k of ["s2l", "s3l", "s4l", "s9l"]) {
    assert.ok(Array.isArray(messages.en.privacy[k]) && Array.isArray(messages.zh.privacy[k]), `${k} 不是数组`);
    assert.equal(messages.en.privacy[k].length, messages.zh.privacy[k].length, `${k} 中英条数不一致`);
  }
  assert.ok(view.includes("Array.isArray(v) ? v : []"), "缺少数组兜底（脏值会让模板报错）");
});
t_("P11 章节标题不重复渲染（联系方式节只在模板出现一次）", () => {
  const inSections = view.slice(view.indexOf("const SECTIONS"), view.indexOf("function items"));
  assert.ok(!inSections.includes("privacy.s13"), "SECTIONS 里不该再有第 13 节");
});

/* ═════════ ③ 内容与合规要点（Google 审核逐条核对的部分） ═════════ */
t_("P12 en/zh 的 privacy 子树键对称", () => {
  const flat = (o, pre = "") => Object.entries(o).flatMap(([k, v]) =>
    v && typeof v === "object" && !Array.isArray(v) ? flat(v, pre + k + ".") : [pre + k]);
  const en = new Set(flat(messages.en.privacy));
  const zh = new Set(flat(messages.zh.privacy));
  const onlyEn = [...en].filter((k) => !zh.has(k));
  const onlyZh = [...zh].filter((k) => !en.has(k));
  assert.equal(onlyEn.length + onlyZh.length, 0, `en-only=${onlyEn} zh-only=${onlyZh}`);
  assert.ok(en.size >= 30, `词条太少，可能漏写：${en.size}`);
});
t_("P13 两种语言下都不冒出原始 key", () => {
  for (const loc of ["en", "zh"]) {
    i18n.locale = loc;
    for (const k of Object.keys(messages[loc].privacy)) {
      const v = t("privacy." + k);
      assert.notEqual(v, "privacy." + k, `${loc} 缺 ${k}`);
    }
  }
});
t_("P14 声明只申请 email / profile 两个权限", () => {
  has("en", "privacy.s4l", ["email and profile"]);
  has("zh", "privacy.s4l", ["email 和 profile"]);
});
t_("P15 明确不申请 Gmail / Drive / 日历等敏感权限", () => {
  has("en", "privacy.s4l", ["gmail", "drive", "calendar"]);
  has("zh", "privacy.s4l", ["gmail", "drive", "日历"]);
});
t_("P16 声明不出售、不出租、不分享给第三方", () => {
  has("en", "privacy.s4l", ["sell", "third parties"]);
  has("zh", "privacy.s4l", ["出售", "第三方"]);
});
t_("P17 声明不用于广告 / 定向投放", () => {
  has("en", "privacy.s4l", ["advertising"]);
  has("zh", "privacy.s4l", ["广告"]);
});
t_("P18 Limited Use 声明在案（Google API 用户数据政策）", () => {
  const en = String(say("en", "privacy.s5p1"));
  assert.ok(en.includes("Google API Services User Data Policy"), "en 缺政策名");
  assert.ok(en.includes("Limited Use requirements"), "en 缺 Limited Use");
  const zh = String(say("zh", "privacy.s5p1"));
  assert.ok(zh.includes("有限使用") && zh.includes("Google API 服务用户数据政策"), `zh 缺：${zh}`);
});
t_("P19 说明了如何撤销 Google 授权", () => {
  has("en", "privacy.s4l", ["myaccount.google.com", "revoke"]);
  has("zh", "privacy.s4l", ["myaccount.google.com", "撤销"]);
});
t_("P20 说明了数据存在哪里（Supabase）与保护方式（RLS）", () => {
  bothHave("privacy.s4l", ["supabase"]);
  bothHave("privacy.s6p1", ["supabase"]);
  has("en", "privacy.s11p1", ["row-level security"]);
  has("zh", "privacy.s11p1", ["行级安全"]);
});
t_("P21 声明不使用广告 Cookie / 不做画像", () => {
  bothHave("privacy.s7p1", ["cookie"]);
  has("en", "privacy.s2p1", ["no profiling"]);
  has("zh", "privacy.s2p1", ["画像"]);
});
t_("P22 有儿童条款（13 岁）", () => {
  bothHave("privacy.s10p1", ["13"]);
});
t_("P23 有用户权利与删号途径（含处理时限）", () => {
  has("en", "privacy.s9l", ["delete", "7 days"]);
  has("zh", "privacy.s9l", ["删除", "7 天"]);
});
t_("P24 联系方式渲染后是一封真邮箱", () => {
  const mail = "linyi0123456@outlook.com";
  assert.ok(view.includes(`const CONTACT_MAIL = "${mail}"`), "组件里的邮箱常量变了");
  for (const loc of ["en", "zh"]) {
    const s = String(say(loc, "privacy.s13p1", { mail }));
    assert.ok(s.includes(mail), `${loc} 未插入邮箱：${s}`);
    assert.ok(!s.includes("{mail}"), `${loc} 占位符没被替换`);
  }
});
t_("P25 更新时间是真实日期格式", () => {
  assert.ok(/\d{4}/.test(String(say("zh", "privacy.updated"))), "zh 更新时间缺年份");
  assert.ok(/2026/.test(String(say("en", "privacy.updated"))), "en 更新时间缺年份");
});
t_("P26 如实说明公开范围（帖子公开、管理员可见邮箱）", () => {
  has("en", "privacy.s8p1", ["visible to anyone", "email"]);
  has("zh", "privacy.s8p1", ["访客", "邮箱"]);
});

/* ═════════ ④ 样式 ═════════ */
t_("P27 样式齐备（版面 + 页脚入口）", () => {
  for (const cls of [".legal-page", ".legal-title", ".legal-p", ".legal-list", ".legal-mail", ".footer-link"]) {
    assert.ok(css.includes(cls), `style.css 缺少 ${cls}`);
  }
  assert.ok(css.includes(".legal-list li::marker"), "列表符号未按主题着色");
});
t_("P28 页脚改为可换行的一行（窄屏不挤压）", () => {
  assert.ok(/\.footer\s*\{[^}]*flex-wrap:\s*wrap/.test(css), "页脚缺少 flex-wrap");
});

/* ═════════ ⑤ 构建产物（若已构建） ═════════ */
if (exists("dist/privacy/index.html")) {
  const h = read("dist/privacy/index.html");
  /* 邮箱常量以组件为准，产物必须与它一致（两处不能各写各的） */
  const CONTACT_MAIL = (view.match(/const CONTACT_MAIL = "([^"]+)"/) || [])[1] || "";
  t_("P29 产物 /privacy/index.html 标题与 canonical 独立", () => {
    assert.ok(h.includes("<title>Warm Paws · Privacy Policy</title>"), "标题不对");
    assert.ok(h.includes('rel="canonical" href="https://dale.de5.net/privacy"'), "canonical 不对");
    assert.ok(h.includes('property="og:title" content="Warm Paws · Privacy Policy"'), "og:title 不对");
    assert.ok(h.includes('property="og:url" content="https://dale.de5.net/privacy"'), "og:url 不对");
  });
  t_("P30 产物可被搜索引擎收录（无 noindex）", () => {
    assert.ok(h.includes('content="index, follow"'), "缺少 index,follow");
    assert.ok(!/noindex/i.test(h), "产物里出现 noindex");
  });
  /* ── 以下四项锁住「不执行 JS 也能读到完整政策」──
     这正是 Google 存品牌页时抓取该链接、OAuth 审核方直接取 HTML 的场景：
     纯 SPA 壳子（空 <div id="app">）在它们眼里等于空白页 */
  t_("P31 正文预渲染进静态 HTML（13 节标题 + 4 个列表都展开）", () => {
    const body = h.slice(h.indexOf('<div id="app">'), h.indexOf("<noscript>"));
    for (let i = 1; i <= 13; i++) {
      const head = messages.en.privacy[`s${i}t`];
      assert.ok(head, `i18n 缺第 ${i} 节标题`);
      assert.ok(body.includes(`<h2>${head}</h2>`), `静态正文缺第 ${i} 节：${head}`);
    }
    assert.equal((body.match(/<h2>/g) || []).length, 13, "静态正文的章节数不是 13");
    for (const k of ["s2l", "s3l", "s4l", "s9l"]) {
      for (const it of messages.en.privacy[k]) {
        assert.ok(body.includes(`<li>${it}</li>`), `${k} 的词条未进静态正文：${it}`);
      }
    }
  });
  t_("P32 全部词条都进静态正文（防改文案后预渲染失同步）", () => {
    const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const body = h.slice(h.indexOf('<div id="app">'), h.indexOf("<noscript>"));
    const missing = [];
    for (const [k, v] of Object.entries(messages.en.privacy)) {
      for (const one of Array.isArray(v) ? v : [v]) {
        const want = esc(String(one).replace("{mail}", CONTACT_MAIL));
        if (!body.includes(want)) missing.push(`${k}=${want.slice(0, 40)}`);
      }
    }
    assert.equal(missing.length, 0, "未进静态正文：" + missing.join(" | "));
  });
  t_("P33 描述按路由独立（不再沿用全站通用那句）", () => {
    /* 只看 <head>：<noscript> 里保留全站那句话是正常的（无 JS 的兜底说明） */
    const head = h.slice(0, h.indexOf("<body>"));
    assert.ok(!head.includes("一个温暖的角落"), "head 里仍带着全站通用描述");
    assert.ok(/<meta name="description" content="What Warm Paws stores/.test(head), "描述未换成隐私政策专用");
  });
  t_("P34 预渲染邮箱与组件常量同源", () => {
    assert.ok(CONTACT_MAIL, "组件里找不到 CONTACT_MAIL");
    assert.ok(h.includes(`<p class="legal-mail">${CONTACT_MAIL}</p>`),
      "产物里的邮箱与组件常量不一致");
  });
} else {
  out.push("SKIP  P29~P34 尚未构建 dist（先跑 npm run build）");
}

/* 还原语言，避免影响同进程后续断言 */
i18n.locale = "en";

out.push("");
out.push("TOTAL " + (pass + fail) + "  PASS " + pass + "  FAIL " + fail);
console.log(out.join("\n"));
process.exit(fail ? 1 : 0);
