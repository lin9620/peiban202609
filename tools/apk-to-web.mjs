/* 把刚打好的 debug APK 复制进 public/apk/，供网页端「下载 App」弹窗分发
 * （/apk/warm-paws.apk；直接下载与扫码二维码都指向它）。
 * 运行：npm run apk:web   （打完 APK 后跑一次；public/apk/ 随构建发布上线）
 */
import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "android", "app", "build", "outputs", "apk", "debug", "app-debug.apk");
const OUT = join(ROOT, "public", "apk", "warm-paws.apk");

try {
  mkdirSync(join(ROOT, "public", "apk"), { recursive: true });
  copyFileSync(SRC, OUT);
  const mb = (statSync(OUT).size / 1048576).toFixed(1);
  console.log(`[apk-to-web] ${OUT}（${mb} MB）`);
} catch (e) {
  console.error("[apk-to-web] 复制失败（先跑 android 的 assembleDebug？）：", e.message);
  process.exit(1);
}
