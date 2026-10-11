/* 「下载 App」按钮 + 弹窗测试（轮 238）
 * ------------------------------------------------------------
 * 覆盖：
 *   · public/apk/warm-paws.apk 存在且是真 APK（ZIP 魔数 PK）
 *   · App.vue 接线：欢迎条入口按钮 / NModal 弹窗 / 直接下载链接 / 二维码懒生成 / App 内隐藏
 *   · i18n：appDownload 键 en/zh 成对
 *   · cap-strip-hero 会剥掉同步进 App 资源的内嵌 apk（App 体积不翻倍）
 * 运行：node tools/app-download-test.mjs
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; } else { fail++; console.error("FAIL", name); } };

/* ① APK 产物就位（网页下载 & 二维码都指向它） */
const apkPath = join(ROOT, "public", "apk", "warm-paws.apk");
ok(existsSync(apkPath), "public/apk/warm-paws.apk 存在");
if (existsSync(apkPath)) {
  const head = readFileSync(apkPath).subarray(0, 2).toString("latin1");
  ok(head === "PK", "是真 APK/ZIP（PK 魔数）");
  ok(statSync(apkPath).size > 1024 * 1024, "体积 > 1MB（不是占位文件）");
}

/* ② App.vue 接线 */
const app = readFileSync(join(ROOT, "src", "App.vue"), "utf8");
ok(app.includes('class="wb-dl"') && app.includes('dlOpen = true'), "欢迎条有下载入口按钮");
ok(app.includes('v-if="!isApp"') && app.includes('wb-dl'), "App 内不显示下载入口");
ok(app.includes("<n-modal") && app.includes('v-model:show="dlOpen"'), "弹窗用 NModal 挂 dlOpen");
ok(app.includes(':href="dlUrl" download="warm-paws.apk"'), "下载链接用解析后的 dlUrl（上传包优先/内置包兜底）");
  ok(app.includes("APP_RELEASE_URL") && app.includes("HEAD"), "打开弹窗先探测 Storage 上传包（HEAD）");
ok(app.includes('import("qrcode")') && app.includes("toString"), "二维码用 qrcode 懒加载生成");
ok(app.includes("dl-qr-svg") && app.includes("v-html=\"dlQr\""), "二维码 SVG 直插 DOM");
ok(app.includes("const abs = /^https?:/.test(url) ? url : location.origin + url"), "二维码指向解析后的绝对地址（上传包优先/内置包兜底）");

/* ③ i18n en/zh 成对 */
const i18n = readFileSync(join(ROOT, "src", "i18n.js"), "utf8");
const KEYS = ["button", "title", "intro", "direct", "directHint", "qr", "qrHint", "qrFail", "close"];
for (const k of KEYS) {
  const re = new RegExp(`appDownload:\\s*\\{[^}]*\\b${k}:`, "g");
  const hits = [...i18n.matchAll(re)].length;
  ok(hits >= 2, `appDownload.${k} en/zh 都有（${hits} 处）`);
}

/* ④ App 资源剥内嵌 apk */
const strip = readFileSync(join(ROOT, "tools", "cap-strip-hero.mjs"), "utf8");
ok(strip.includes('join(root, "apk")') && strip.includes("rmSync"), "cap-sync 时剥掉 App 资源里的内嵌 apk");

/* ⑤ 打包脚本就位 */
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
ok(pkg.scripts["apk:web"] === "node tools/apk-to-web.mjs", "npm run apk:web 就位");
ok(existsSync(join(ROOT, "tools", "apk-to-web.mjs")), "apk-to-web.mjs 存在");
ok(existsSync(join(ROOT, "MIGRATION_app_release.sql")), "app-releases 桶迁移文件存在");
const admin = readFileSync(join(ROOT, "src", "views", "AdminView.vue"), "utf8");
ok(admin.includes("appReleaseUpload") && admin.includes("appReleaseMeta"), "AdminView 有上传/元信息接线");
ok(admin.includes('accept=".apk,application/vnd.android.package-archive"'), "文件选择器限定 .apk")
const dbSupa = readFileSync(join(ROOT, "src", "utils", "api", "db.supabase.js"), "utf8");
ok(dbSupa.includes("app-releases") && dbSupa.includes("appReleaseUpload"), "直连适配层有 app-releases 上传");

console.log(`app-download-test: ${pass} pass, ${fail} fail`);
if (fail) process.exit(1);
