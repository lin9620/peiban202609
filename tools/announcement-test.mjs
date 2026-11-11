/* 管理员公告：详情弹层 + 多语言显示（纯函数 + 接线断言）
 * ------------------------------------------------------------
 * 用户反馈：
 *   1. 普通用户点公告没反应，长公告在列表里只露半句；
 *   2. 管理员发中文，其他语言用户收到的还是中文。
 *
 * 这里锁三件事：
 *   - 原文语言判断 / 是否需要翻译 / 本机缓存键（纯函数，可离线跑）；
 *   - 通知中心确实把 system 公告接进弹层，并且按当前语言取正文；
 *   - Worker 有 /api/translate + Workers AI 模型，wrangler 配了 AI binding；
 *     没配时前端有原文回退文案（不能白屏）。
 *
 * 运行：node tools/announcement-test.mjs
 */
import { readFileSync } from "node:fs";
import {
  ANNOUNCE_LANGS, announceLocale, announcementBody, sourceLangOf,
  needsTranslation, hashText, translationCacheKey,
} from "../src/utils/announcement.js";
import { messages } from "../src/i18n.js";

let pass = 0;
const fails = [];
function ok(name, cond, extra = "") {
  if (cond) pass++;
  else fails.push(name + (extra ? ` —— ${extra}` : ""));
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ───────── 语言归一化 ───────── */
ok("支持 5 种语言", eq(ANNOUNCE_LANGS, ["zh", "en", "es", "pt", "fr"]));
ok("zh-CN → zh", announceLocale("zh-CN") === "zh");
ok("en-US → en", announceLocale("en-US") === "en");
ok("es-419 → es", announceLocale("es-419") === "es");
ok("pt_BR → pt", announceLocale("pt_BR") === "pt");
ok("fr → fr", announceLocale("fr") === "fr");
ok("未知语言 → en", announceLocale("de-DE") === "en");
ok("空值 → en", announceLocale(null) === "en");

/* ───────── 正文提取 ───────── */
ok("meta.body 去首尾空白", announcementBody({ body: "  今晚维护  " }) === "今晚维护");
ok("meta 缺失 → 空串", announcementBody(null) === "" && announcementBody({}) === "");
ok("body 非字符串 → 空串", announcementBody({ body: 123 }) === "");

/* ───────── 原文语言 ───────── */
ok("中文原文判 zh", sourceLangOf("今晚维护，大家早点休息。") === "zh");
ok("英文原文判 en", sourceLangOf("We will do a short maintenance tonight, thank you for your patience.") === "en");
ok("西语原文判 es", sourceLangOf("Esta noche hacemos una actualización, gracias por su paciencia.") === "es");
ok("葡语原文判 pt", sourceLangOf("Hoje à noite vamos atualizar, obrigado pela paciência.") === "pt");
ok("法语原文判 fr", sourceLangOf("Ce soir nous faisons une mise à jour, merci pour votre patience.") === "fr");
ok("短中文也能判 zh（不会因长度掉 und）", sourceLangOf("维护") === "zh");
ok("纯 emoji 不炸，退回 en", sourceLangOf("🐾🐾") === "en");

/* ───────── 是否需要翻译 ───────── */
ok("中文 → 英文用户：要翻", needsTranslation("今晚维护", "en") === true);
ok("中文 → 中文用户：不翻", needsTranslation("今晚维护", "zh") === false);
ok("英文 → 英文用户：不翻", needsTranslation("A short maintenance tonight, thanks.", "en") === false);
ok("英文 → 中文用户：要翻", needsTranslation("A short maintenance tonight, thanks.", "zh") === true);
ok("空正文：不翻", needsTranslation("", "en") === false && needsTranslation("   ", "en") === false);

/* ───────── 缓存键 ───────── */
ok("hashText 稳定", hashText("今晚维护") === hashText("今晚维护"));
ok("hashText 对不同正文不同", hashText("今晚维护") !== hashText("今晚维护。"));
ok("缓存键按目标语言隔离",
  translationCacheKey("今晚维护", "en") !== translationCacheKey("今晚维护", "es"));
ok("缓存键以语言开头", translationCacheKey("今晚维护", "en").startsWith("en:"));

/* ───────── i18n：5 种语言都要有公告弹层文案 ───────── */
function flat(obj, prefix = "") {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) Object.assign(out, flat(v, key));
    else out[key] = v;
  }
  return out;
}
for (const loc of ANNOUNCE_LANGS) {
  const set = flat(messages[loc]);
  for (const key of ["notif.readFull", "notif.translating", "notif.original", "common.close"]) {
    ok(`${loc}:${key} 存在且非空`, typeof set[key] === "string" && set[key].length > 0);
  }
}

/* ───────── 通知中心接线 ───────── */
const view = readFileSync("src/views/NotificationsView.vue", "utf8");
ok("系统公告点击进入详情（不是只标已读就返回）",
  /if \(n\.kind === "system" && systemBody\(n\)\)[\s\S]{0,80}openAnnouncement\(n\)[\s\S]{0,20}return;/.test(view));
ok("详情弹层 Teleport 到 body（避开 transform 包含块）",
  view.includes('<Teleport to="body">') && view.includes('class="announce-mask"'));
ok("详情弹层有标题/正文无障碍关联",
  view.includes('aria-labelledby="announce-title"') && view.includes('aria-describedby="announce-body"'));
ok("手机端公告也居中，不是底部抽屉",
  /@media \(max-width: 640px\)[\s\S]{0,240}\.announce-mask\s*\{[^}]*align-items:\s*center/s.test(view)
  && !view.includes("align-items: flex-end"));
ok("详情弹层有底部主按钮", view.includes('class="announce-cta"'));
ok("详情弹层正文按当前语言取 bodyFor",
  /const detailBody[\s\S]{0,240}bodyFor\(detail\.value\.n\)/.test(view));
ok("翻译中先显示骨架，不先闪原文",
  /trBusy\[detailKey\.value\]\) return ""/.test(view) && view.includes("announce-skeleton"));
ok("弹层开着切语言也会重新翻译",
  /watch\(detail,[\s\S]{0,140}ensureBody\(d\.n\)/.test(view));
ok("Esc 可关闭公告",
  view.includes('e.key === "Escape"') && view.includes('window.addEventListener("keydown"'));
ok("列表正文走 bodyFor(n)（按当前语言取译文）", view.includes("{{ bodyFor(n) }}"));
ok("弹层正文走 detailBody", view.includes("{{ detailBody }}"));
ok("翻译中 / 原文回退都有提示",
  view.includes('t("notif.translating")') && view.includes('t("notif.original")'));
ok("列表提供「查看全文」入口", view.includes('t("notif.readFull")'));

/* 列表不再单行省略；改成两行 clamp，长公告点开看全文 */
const css = readFileSync("src/style.css", "utf8");
ok("通知正文列表两行截断（不再是 nowrap 单行）",
  /\.notif-quote\s*\{[^}]*-webkit-line-clamp:\s*2[^}]*white-space:\s*normal/s.test(css));

/* ───────── Worker / 配置 ───────── */
const worker = readFileSync("worker/api.js", "utf8");
ok("Worker 有 /api/translate 路由", /seg\[0\] === "translate"/.test(worker));
ok("Worker 用 m2m100 翻译模型", worker.includes("@cf/meta/m2m100-1.2b"));
ok("未配 AI 时返回 ai-not-configured（前端可退回原文）", worker.includes('"ai-not-configured"'));
ok("翻译接口要求登录", /seg\[0\] === "translate"[\s\S]{0,260}auth-required/.test(worker));
ok("wrangler 配了 AI binding", /"ai"\s*:\s*\{\s*"binding"\s*:\s*"AI"/.test(readFileSync("wrangler.jsonc", "utf8")));

const tr = readFileSync("src/utils/translate.js", "utf8");
ok("前端请求同源 /api/translate", tr.includes("/api/translate"));
ok("前端翻译请求带 JWT", tr.includes("authorization") && tr.includes("getAuthToken"));
ok("译文有本机缓存", tr.includes("wp-announce-tr:v1:"));

console.log(`announcement-test: ${pass} pass, ${fails.length} fail`);
for (const f of fails) console.log("FAIL  " + f);
if (fails.length) process.exit(1);
