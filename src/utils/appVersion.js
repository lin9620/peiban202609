/* ═══════════════════════════════════════════════════════════════
 * 轮 297 · App 版本检测（版本管理的客户端一侧）
 * ---------------------------------------------------------------
 * 版本权威是 android/app/build.gradle 的 versionCode —— 用户设备上装着的
 * 就是它，vite 的 appVersion 插件在构建期把它烤进 __APP_VERSION_CODE__ /
 * __APP_VERSION_NAME__（vite.config.js）。
 * 服务端那份「最新版本」是管理员在管理中心上传 APK 时一起写进
 * app-releases 桶的 version.json（与 APK 同桶、同为公开对象）。
 *
 * 三条铁律：
 *  1. **绝不抛错**：检查更新是锦上添花，任何失败都必须静默返回"没有新版"，
 *     绝不能因此打扰用户、更不能阻塞启动。
 *  2. **只有 App 壳才谈"更新"**：网页端刷新即最新，提示更新毫无意义；
 *     服务端那份 version.json 描述的是 APK 版本，不是 web 构建。
 *  3. **同版本同会话只提示一次**：否则每次切后台回来都弹一个窗。
 * ═══════════════════════════════════════════════════════════════ */
import { Capacitor } from "@capacitor/core";
import { APP_RELEASE_META_URL, APP_RELEASE_URL } from "./api/db.js";

/** 是否跑在 Capacitor 原生壳里（与 stores/uiStore.js 的 isApp 同源口径） */
export function isApp() {
  try { return !!Capacitor.isNativePlatform(); } catch (e) { return false; }
}

/** 当前版本（构建期注入）。拿不到合法数字就返回 null —— 调用方据此跳过一切更新逻辑。 */
export function currentVersion() {
  try {
    /* typeof 守卫：Node 下跑单测时这两个常量不存在，不能直接取 */
    const rawCode = typeof __APP_VERSION_CODE__ !== "undefined" ? __APP_VERSION_CODE__ : "";
    const rawName = typeof __APP_VERSION_NAME__ !== "undefined" ? __APP_VERSION_NAME__ : "";
    const code = parseInt(rawCode, 10);
    const name = String(rawName || "").trim();
    if (!Number.isFinite(code) || code <= 0 || !name) return null;
    return { code, name };
  } catch (e) { return null; }
}

/** 拉服务端最新版本登记。任何失败（404 / 断网 / 迁移没跑 / 内容不合法）都返回 null。 */
export async function fetchLatestRelease() {
  if (!APP_RELEASE_META_URL) return null;
  try {
    const res = await fetch(APP_RELEASE_META_URL, { cache: "no-store" });
    if (!res || !res.ok) return null;
    const j = await res.json();
    const code = parseInt(j && j.versionCode, 10);
    /* 文件在但内容不合法 —— 等同于没有，绝不因为一个坏 JSON 去打扰用户 */
    if (!Number.isFinite(code) || code <= 0) return null;
    return {
      code,
      name: String(j.versionName || "").trim(),
      notes: String(j.notes || "").trim(),
      /* ★ force 的语义是「关不掉的弹窗」，必须白名单判定，不能写 `!!j.force`：
       *   `!!"false"` === true —— 万一有人手改 version.json 把它写成字符串，
       *   全体用户下次开 App 就会被一个关不掉的窗糊脸，且只能重装才躲得开。
       *   白名单 = 允许的真值形式；其余（含缺失、null、"false"、"0"）一律 false。
       *   宁可少弹一次，绝不误弹一次。 */
      force: j.force === true || j.force === 1 || j.force === "true",
      when: String(j.when || "").trim(),
      apkUrl: String(j.apkUrl || "").trim() || APP_RELEASE_URL,
    };
  } catch (e) { return null; }
}

/* —— 同版本同会话只提示一次 ——
 * 记的是"已经提示过的那个 code"，而不是布尔开关：管理员推了新版本（code 变了）
 * 就该再提示一次。手动检查要能重复提示，调 resetPromptGate() 放行。 */
let promptedCode = 0;
export function takePromptOnce(code) {
  if (!code || promptedCode === code) return false;
  promptedCode = code;
  return true;
}
export function resetPromptGate() { promptedCode = 0; }

/**
 * 检查更新。**绝不抛错**。
 * @returns {Promise<{hasUpdate:boolean, current:object|null, latest:object|null,
 *                    force:boolean, reason:string}>}
 *   reason 仅用于排查：unknown-current（没注入版本号）/ no-latest（拿不到登记）/ up-to-date
 */
export async function checkForUpdate() {
  const current = currentVersion();
  if (!current) return { hasUpdate: false, current: null, latest: null, force: false, reason: "unknown-current" };
  const latest = await fetchLatestRelease();
  if (!latest) return { hasUpdate: false, current, latest: null, force: false, reason: "no-latest" };
  /* 服务端 code 更大 = 有新版。相等或更小都当作已是最新
   * （后者意味着管理员把登记回退了 —— 此时不该逼用户"降级"）。 */
  if (latest.code <= current.code) {
    return { hasUpdate: false, current, latest, force: false, reason: "up-to-date" };
  }
  return { hasUpdate: true, current, latest, force: latest.force, reason: "update-available" };
}
