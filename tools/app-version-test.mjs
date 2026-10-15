/* App 版本管理 + 版本检测更新 测试（轮 297）
 * ------------------------------------------------------------
 * 覆盖：
 *   · 版本号权威是 android/app/build.gradle，由 vite 的 appVersion 插件烤进产物
 *   · appVersion.js：拿不到合法版本就返回 null；比较用 <=（服务端回退不逼用户降级）；
 *     同版本同会话只提示一次；任何失败都静默（绝不抛错）
 *   · UpdateDialog：n-modal 必须显式给宽度（轮 40 的坑）；force 时不可关；
 *     App 端去更新走 @capacitor/browser（裸 window.open 在 WebView 里不触发下载）
 *   · main.js 启动后静默检查，只在 App 壳弹；且**不碰 App.vue**（那是另一个 AI 的地面）
 *   · 两个 db 适配层成对实现 appReleasePublishMeta（契约一致，缺一边就是网关模式半残）
 *   · 设置页有版本行 + 手动检查；管理端上传时随包写版本登记
 *   · i18n 的 appUpdate / appRelease 新键 en/zh 成对
 * 运行：node tools/app-version-test.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyBump } from "./bump-version.mjs";   /* 轮297d：发版 bump 脚本的纯逻辑 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; } else { fail++; console.error("FAIL", name); } };
const rd = (p) => readFileSync(join(ROOT, p), "utf8");

/* ═══ ① 版本号权威与注入 ═══ */
const gradle = rd("android/app/build.gradle");
ok(/versionCode\s+\d+/.test(gradle), "build.gradle 有 versionCode（客户端拿它比大小）");
ok(/versionName\s+"[^"]+"/.test(gradle), "build.gradle 有 versionName（显示给用户看）");

const vite = rd("vite.config.js");
ok(/function appVersion\(\)/.test(vite), "vite.config 有 appVersion 插件");
ok(/__APP_VERSION_CODE__/.test(vite) && /__APP_VERSION_NAME__/.test(vite), "插件注入 code 与 name 两个常量");
ok(/appVersion\(\)[\s\S]{0,400}?\}\), seoSitemap\(\)/.test(vite) || vite.includes("envGuard(), appVersion()"),
  "插件确实注册进了 plugins 数组（没注册等于白写）");
/* 读不到 gradle 时必须退到 package.json —— 否则纯 web 构建直接崩 */
ok(/catch \(e\) \{ \/\* 没有 Android 工程/.test(vite) && /package\.json/.test(vite),
  "读不到 gradle 时退 package.json（纯 web 构建也能出包）");

/* ═══ ② appVersion.js 的判断规则 ═══ */
const av = rd("src/utils/appVersion.js");
ok(/export function currentVersion\(\)/.test(av), "有 currentVersion()");
ok(/typeof __APP_VERSION_CODE__ !== "undefined"/.test(av),
  "取常量前有 typeof 守卫（Node 下跑单测时它不存在，直接取会 ReferenceError）");
ok(/!Number\.isFinite\(code\) \|\| code <= 0/.test(av),
  "拿不到合法版本号就返回 null —— 调用方据此跳过一切更新逻辑");
/* 比较必须是 <= ：服务端把登记回退了，不该逼用户「降级」 */
ok(/latest\.code <= current\.code/.test(av), "比较用 <=（登记回退不逼用户降级）");
ok(/takePromptOnce/.test(av) && /promptedCode === code/.test(av),
  "同版本同会话只提示一次（否则每次切后台回来都弹窗）");
ok(/resetPromptGate/.test(av), "有放行口 —— 手动检查要能重复提示");
/* 失败静默：三处 return null 都在 catch 里，函数签名无 throw */
ok((av.match(/catch \(e\) \{ return null; \}/g) || []).length >= 2, "fetchLatestRelease / currentVersion 失败都返回 null");
ok(/export async function checkForUpdate\(\)/.test(av) && !/throw/.test(av), "checkForUpdate 绝不抛错（检查更新是锦上添花）");
ok(/cache: "no-store"/.test(av), "版本登记不走缓存（传了新包要立刻能查到）");
/* ★ force 的语义是「关不掉的弹窗」—— `!!"false"` 是 true，误弹一次全体用户都躲不开 */
ok(/force: j\.force === true \|\| j\.force === 1 \|\| j\.force === "true"/.test(av),
  "force 用白名单判定，不是 !!j.force（!!\"false\" 会把所有人糊在关不掉的窗里）");
ok(!/force: !!j\.force/.test(av), "没有退回 !!j.force");
{
  /* 真值表钉死，防止以后有人把它「简化」回去 */
  const judge = (v) => v === true || v === 1 || v === "true";
  ok(judge(true) && judge(1) && judge("true"), "白名单接受 true / 1 / \"true\"");
  ok(!judge(false) && !judge("false") && !judge(0) && !judge("") && !judge(null) && !judge(undefined),
    "白名单拒绝 false / \"false\" / 0 / 空串 / null / undefined（宁可少弹不误弹）");
}

/* ═══ ③ 版本登记与 APK 同桶、公开可读 ═══ */
const dbjs = rd("src/utils/api/db.js");
ok(dbjs.includes("/sb/storage/v1/object/public/app-releases/version.json"),
  "version.json 走与 APK 同一个公开桶（零迁移、零 RPC、匿名可读）");
ok(dbjs.includes("/sb/storage/v1/object/public/app-releases/warm-paws.apk"),
  "APK 公开地址仍在（轮 238 口径不变）");

/* 两个适配层必须成对 —— 缺一边就是网关模式半残 */
for (const f of ["src/utils/api/db.supabase.js", "src/utils/api/db.gateway.js"]) {
  ok(rd(f).includes("appReleasePublishMeta"), `${f} 有 appReleasePublishMeta`);
}
ok(rd("src/utils/api/db.supabase.js").includes('upload("version.json"'), "直连层写的是 version.json");
ok(rd("src/utils/api/db.gateway.js").includes("x-upsert"), "网关层带 x-upsert（覆盖旧登记）");

/* ═══ ④ 更新弹窗 ═══ */
const dlg = rd("src/components/UpdateDialog.vue");
ok(/<n-modal/.test(dlg), "弹窗用 n-modal");
ok(/style="width: min\(/.test(dlg), "n-modal 显式给了宽度（轮 40：不给会被容器撑满）");
ok(/:closable="!force"/.test(dlg) && /:mask-closable="!force"/.test(dlg), "强制更新时不可关（右上角 × 与遮罩点击都关不掉）");
ok(/v-if="!force"/.test(dlg), "强制更新时不给「稍后再说」按钮");
ok(/import\("@capacitor\/browser"\)/.test(dlg), "App 端去更新走 @capacitor/browser（WebView 里裸 window.open 不触发下载）");
ok(!/window\.open\(/.test(dlg), "没有裸 window.open");
/* 轮297c：强制更新时按系统返回键不许「绕过」——
 * App.vue:165 的兜底是 router.back() / minimizeApp()，弹窗底下那页会跟着变 */
ok(/pushBack/.test(dlg) && /popBack/.test(dlg), "强制更新走 uiStore 的返回键拦截栈吞掉返回键");
ok(/onBeforeUnmount[\s\S]{0,120}?popBack/.test(dlg),
  "弹窗卸载必弹栈（拦截器泄漏会让之后所有返回键都被吞掉，App 变砖）");
ok(/justify-content: center/.test(dlg), "去更新按钮居中（用户点单：不靠右贴边）");

/* ═══ ⑤ 启动检查挂载点 ═══ */
const main = rd("src/main.js");
ok(/scheduleUpdateCheck\(\)/.test(main), "main.js 挂了启动检查");
ok(/isApp\(\)\) return/.test(main), "只在 App 壳弹（网页端刷新即最新，提示更新毫无意义）");
/* 轮297b：非必须更新不许自动弹 —— 每次开 App 弹一个关不掉的窗只会招人烦 */
ok(/if \(!r\.force\) return;/.test(main), "只有「必须更新」才在启动时自动弹（非必须更新不打扰，留给设置页手动检查）");
ok(/requestIdleCallback/.test(main), "空闲期才跑（不抢首屏带宽与主线程）");
ok(/takePromptOnce\(r\.latest\.code\)/.test(main), "启动检查也走「同版本只提示一次」");
ok(/createApp\(UpdateDialog,/.test(main), "弹窗用独立小 app 挂 body");
/* App.vue 属于另一个 AI 的地面 —— 版本检查绝不能往里塞 */
const appVue = rd("src/App.vue");
ok(!/checkForUpdate|UpdateDialog|appVersion/.test(appVue), "App.vue 里没有任何版本检查接线（那是另一个 AI 的地面）");

/* ═══ ⑥ 设置页 ═══ */
const st = rd("src/views/SettingsView.vue");
ok(st.includes("currentVersion") && st.includes("checkForUpdate"), "设置页有版本与检查更新接线");
ok(/appUpdate\.currentVer/.test(st), "设置页显示当前版本号");
ok(/appUpdate\.checkBtn/.test(st), "设置页有手动检查按钮");
ok(/<UpdateDialog/.test(st), "手动检查发现新版时复用同一个弹窗");
ok(/appUpdate\.upToDate/.test(st), "已是最新时有明确文案");
/* 「查不到」不许说成「已是最新」—— 离线时谎称最新是骗用户，不是措辞问题 */
ok(/appUpdate\.checkFail/.test(st), "查不到时说「没能检查到」，不谎称「已是最新」");
ok(/r\.reason === "up-to-date"/.test(st), "两种文案按 reason 分流（合并成一句就是骗人）");

/* ═══ ⑦ 管理端 ═══ */
const ad = rd("src/views/AdminView.vue");
ok(ad.includes("appReleasePublishMeta"), "管理端上传时随包写版本登记");
/* ★ versionCode 必须取自当前构建（= gradle），不能是「已登记 +1」——
 *   后者在重传同一个包时会让 version.json 比包里的值大 1，客户端装完仍算
 *   「有新版」→ 死循环；叠上「必须更新」就是用户永远关不掉的窗。 */
ok(/const buildCode = String\(\(currentVersion\(\) \|\| \{\}\)\.code \|\| ""\)/.test(ad),
  "versionCode 默认取当前构建的值（vite 从 build.gradle 读来），不是推算的");
ok(!/relReg\.value\.code\) \|\| 0\) \+ 1/.test(ad), "没有退回「已登记 code + 1」（重传同一个包会死循环）");
ok(/admin\.appRelease\.codeBad/.test(ad) && /codeNum/.test(ad),
  "上传前先校验 versionCode —— 非法就别传，免得包换了登记没换（中间态最难查）");
ok(/admin\.appRelease\.codeDiffers/.test(ad),
  "改得和当前构建不一致时有显式警告（用旧网页传新包 = 死循环高发场景）");
ok(/relForce/.test(ad) && /relNotes/.test(ad), "可填更新说明与更新方式");
/* 轮297b：更新方式必须是显式二选一，不能是埋在角落、没人注意的勾选框 */
ok(/type="radio"/.test(ad) && /optForce/.test(ad) && /optNormal/.test(ad),
  "更新方式是二选一卡片（必须更新 / 非必须更新）");
ok(/role="radiogroup"/.test(ad), "二选一组带 radiogroup 语义（读屏能读出这是单选）");
ok(/:value="true"/.test(ad) && /:value="false"/.test(ad), "radio 的 value 是真布尔（别用字符串 \"true\"，存进 version.json 会变成永真）");

/* ═══ ⑧ i18n en/zh 成对 ═══ */
const i18n = rd("src/i18n.js");
for (const k of ["title", "versionLine", "notes", "later", "go", "forceHint", "upToDate", "found", "checking", "checkFail", "currentVer", "checkBtn"]) {
  const hits = [...i18n.matchAll(new RegExp(`\\b${k}:`, "g"))].length;
  ok(hits >= 2, `appUpdate.${k} en/zh 都有（${hits} 处）`);
}
for (const k of ["verCap", "verPh", "verBad", "notesPh", "forceCap", "optNormal", "optNormalHint", "optForce", "optForceHint", "registered", "codePh", "codeBad", "codeHint", "codeDiffers"]) {
  const hits = [...i18n.matchAll(new RegExp(`\\b${k}:`, "g"))].length;
  ok(hits >= 2, `admin.appRelease.${k} en/zh 都有（${hits} 处）`);
}

/* ═══ ⑨ 迁移文件仍在（桶是前提，没跑过则静默降级） ═══ */
ok(existsSync(join(ROOT, "MIGRATION_app_release.sql")), "app-releases 桶迁移文件仍在");

/* ═══ ⑩ 发版 bump 脚本（轮297d）—— 忘了 bump 是死循环的第一大来源 ═══ */
const bumpSrc = rd("tools/bump-version.mjs");
ok(/export function applyBump/.test(bumpSrc), "bump 脚本把核心逻辑导出成纯函数（可测）");
const pkg = JSON.parse(rd("package.json"));
ok(pkg.scripts && pkg.scripts.release === "node tools/bump-version.mjs", "package.json 有 release 脚本");

/* —— 纯逻辑：用假的 gradle 文本喂，绝不碰真文件 —— */
const FAKE = [
  "android {",
  "    defaultConfig {",
  '        applicationId "net.de5.warmpaws"',
  "        versionCode 1",
  '        versionName "1.0"',
  "    }",
  "}",
].join("\n");

{
  const r = applyBump(FAKE, "1.1");
  ok(!!r, "合法输入有返回");
  if (r) {
    ok(r.next === 2, `versionCode 必须 +1（实际 ${r.next}）`);
    ok(/versionCode 2/.test(r.out), "产物里是 versionCode 2");
    ok(/versionName "1\.1"/.test(r.out), "产物里是 versionName \"1.1\"");
    ok(/^ {8}versionCode 2$/m.test(r.out), "缩进原样保留（别顺手动到别的配置）");
    ok(/applicationId "net\.de5\.warmpaws"/.test(r.out), "applicationId 一行不受影响");
    ok((r.out.match(/versionCode/g) || []).length === 1, "产物里只有一个 versionCode（没插出重复行）");
    ok((r.out.match(/versionName/g) || []).length === 1, "产物里只有一个 versionName");
    ok(r.out.split(/\r?\n/).length === FAKE.split(/\r?\n/).length, "总行数不变（只改值，不增删行）");
  }
}
/* 版本名格式：宁可拒也别写出个 JSON 读不回来的东西 */
for (const bad of ["../evil", "", "  ", "abc", "1.2.3.4.5", "1..2", "1 2", "1.2/../../x"]) {
  ok(applyBump(FAKE, bad) === null, `拒绝非法版本名 "${bad}"`);
}
for (const good of ["1", "1.2", "1.2.3", "1.2.3.4", "1.2.3-beta", "1.2+build5"]) {
  ok(applyBump(FAKE, good) !== null, `接受合法版本名 "${good}"`);
}
/* gradle 缺行时必须返回 null，不能猜一个出来 */
ok(applyBump('android {\n  versionCode 1\n}\n', "1.1") === null, "缺 versionName 行 → null（不猜）");
ok(applyBump('android {\n  versionName "1.0"\n}\n', "1.1") === null, "缺 versionCode 行 → null（不猜）");
ok(applyBump("", "1.1") === null, "空文件 → null");

/* —— CLI 守卫：--dry-run / --file= 必须存在，否则没法安全试跑 —— */
ok(/--dry-run/.test(bumpSrc), "支持 --dry-run（只打印不落盘）");
ok(/--file=/.test(bumpSrc), "支持 --file=（测试用临时副本跑，不碰真 gradle）");
ok(/VERIFY_FAILED/.test(bumpSrc), "写盘后回读校验 —— writeFileSync 没抛异常不等于写对了");
ok(/process\.exit\(1\)/.test(bumpSrc), "任何失败都非零退出（CI / 脚本链才拦得住）");
/* 真文件此刻必须还是 1 / "1.0" —— 测试跑完不许把仓库改脏 */
ok(/versionCode\s+1\b/.test(gradle) && /versionName\s+"1\.0"/.test(gradle),
  "build.gradle 仍是 1 / \"1.0\"（本测试只用假文本与临时副本，不许动真文件）");

console.log(`app-version-test: ${pass} pass, ${fail} fail`);
if (fail) process.exit(1);
