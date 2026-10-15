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

/* ═══ ⑤ 启动检查挂载点 ═══ */
const main = rd("src/main.js");
ok(/scheduleUpdateCheck\(\)/.test(main), "main.js 挂了启动检查");
ok(/isApp\(\)\) return/.test(main), "只在 App 壳弹（网页端刷新即最新，提示更新毫无意义）");
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
ok(/nextCode/.test(ad), "versionCode 自动在已登记基础上 +1");
ok(/admin\.appRelease\.codeHint/.test(ad), "界面提示把 versionCode 同步进 build.gradle（不让人猜）");
ok(/relForce/.test(ad) && /relNotes/.test(ad), "可填更新说明与强制更新标记");

/* ═══ ⑧ i18n en/zh 成对 ═══ */
const i18n = rd("src/i18n.js");
for (const k of ["title", "versionLine", "notes", "later", "go", "forceHint", "upToDate", "found", "checking", "checkFail", "currentVer", "checkBtn"]) {
  const hits = [...i18n.matchAll(new RegExp(`\\b${k}:`, "g"))].length;
  ok(hits >= 2, `appUpdate.${k} en/zh 都有（${hits} 处）`);
}
for (const k of ["verCap", "verPh", "verBad", "notesPh", "force", "registered", "codeHint"]) {
  const hits = [...i18n.matchAll(new RegExp(`\\b${k}:`, "g"))].length;
  ok(hits >= 2, `admin.appRelease.${k} en/zh 都有（${hits} 处）`);
}

/* ═══ ⑨ 迁移文件仍在（桶是前提，没跑过则静默降级） ═══ */
ok(existsSync(join(ROOT, "MIGRATION_app_release.sql")), "app-releases 桶迁移文件仍在");

console.log(`app-version-test: ${pass} pass, ${fail} fail`);
if (fail) process.exit(1);
