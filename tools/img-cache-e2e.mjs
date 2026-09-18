/* 图片边缘缓存线上实测（轮 10 · egress 优化）
 *   node tools/img-cache-e2e.mjs
 * 验证 worker/api.js 的 imgResponse：302 直连 → 字节代理 + Cache API。
 * 核心问题：第二次请求（不带任何 cookie/token，等同另一个访客）能否吃到边缘缓存？
 * 做法：注册测试号 → 经 Worker 上传一张真实 PNG → 连打 /api/img/* 两次 → 比对 x-img-cache 与字节。
 * 断言：MISS→HIT（跨用户共享）/ 字节一致 / immutable 头 / 上游 404 退回 302 / 路径穿越 400。
 * 副作用：注册 1 个测试账号（邮箱 wp-imgcache-*）+ 1 个 120B 的 Storage 对象，结束前删除对象。
 */
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = fs.readFileSync(path.join(root, ".env"), "utf8");
const get = (k) => { const m = env.match(new RegExp("^\\s*" + k + "\\s*=\\s*(\\S+)\\s*$", "m")); return m ? m[1] : ""; };
const URL_ = get("VITE_SUPABASE_URL"), KEY = get("VITE_SUPABASE_ANON_KEY");
const BASE = "https://dale.de5.net/api";

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => {
  if (c) { pass++; console.log("PASS  " + n + (extra ? "  " + extra : "")); }
  else { fail++; console.log("FAIL  " + n + (extra ? "  " + extra : "")); }
};
const info = (n, extra = "") => console.log("INFO  " + n + (extra ? "  " + extra : ""));

const PNG_4x4 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAP0lEQVR42gXBoQHAIAwAQdz7ejwirpYFkFmjDpORsub3bgAGmGCBg42xH3NPay8HF+NO877WPQ4ao5fZx+rPHyENGz3VtD1BAAAAAElFTkSuQmCC";
const bytes = Buffer.from(PNG_4x4.split(",")[1], "base64");

const sbAnon = createClient(URL_, KEY, { auth: { persistSession: false } });
const email = "wp-imgcache-" + Date.now() + "@gmail.com";
const { data: su, error: suErr } = await sbAnon.auth.signUp({
  email, password: "warm-paws-123", options: { data: { nickname: "缓存探针" } },
});
if (suErr || !su || !su.session) {
  console.log("NEED_VERIFY 注册无 session：" + (suErr ? suErr.message : "no session"));
  process.exit(2);
}
const uid = su.user.id;
const token = su.session.access_token;
const sb = createClient(URL_, KEY, {
  auth: { persistSession: false },
  global: { headers: { Authorization: "Bearer " + token } },
});
await sb.auth.setSession(su.session);
info("测试账号已注册", uid);

/* 1) 经 Worker 上传（与前端 cloudUploadImage 同一条链路） */
const imgPath = uid + "/cache-probe-" + Date.now() + ".png";
const up = await fetch(`${BASE}/uploads?path=${encodeURIComponent(imgPath)}`, {
  method: "POST", headers: { authorization: "Bearer " + token, "content-type": "image/png" }, body: bytes,
});
ok("上传成功（Worker 转发到 Storage）", up.status >= 200 && up.status < 300, "HTTP " + up.status);

/* 2) 连打两次 /api/img/*：（不带凭证 = 另一个访客视角，正是「跨用户共享」要证明的） */
const imgUrl = `${BASE}/img/${imgPath.split("/").map(encodeURIComponent).join("/")}`;
const hit1 = await fetch(imgUrl, { redirect: "manual" });
const b1 = Buffer.from(await hit1.arrayBuffer());
const cache1 = hit1.headers.get("x-img-cache");

/* Cache API 的 put 在 waitUntil 里异步落盘：给它一点时间再打第二次 */
let hit2 = null, b2 = null, cache2 = "", tries = 0;
for (let i = 0; i < 6; i++) {
  await new Promise((r) => setTimeout(r, 700));
  tries++;
  hit2 = await fetch(imgUrl, { redirect: "manual" });
  b2 = Buffer.from(await hit2.arrayBuffer());
  cache2 = hit2.headers.get("x-img-cache") || "";
  if (cache2 === "HIT") break;
}

info("第 1 次", "HTTP " + hit1.status + " cache=" + cache1 + " bytes=" + b1.length);
info("第 2 次", "HTTP " + hit2.status + " cache=" + cache2 + " bytes=" + b2.length + "（等待 " + tries + " 轮）");

ok("第一次请求返回 200 且是字节代理（不是 302 重定向）",
  hit1.status === 200 && b1.length === bytes.length, "status=" + hit1.status + " len=" + b1.length);
ok("第一次标记 MISS（从 Storage 回源）", cache1 === "MISS", "x-img-cache=" + cache1);
ok("图片字节与上传的完全一致（没被改写/截断）", b1.equals(bytes), b1.length + "B");
ok("带 immutable 长缓存头（浏览器侧也不用反复问）",
  (hit1.headers.get("cache-control") || "").includes("immutable"), hit1.headers.get("cache-control") || "");
ok("content-type 透传为 image/png", (hit1.headers.get("content-type") || "").includes("image/png"),
  hit1.headers.get("content-type") || "");

ok("第二次（无凭证的另一访客）命中边缘缓存 HIT ⭐ 跨用户共享成立", cache2 === "HIT", "x-img-cache=" + cache2);
ok("HIT 响应字节与首次一致", !!b2 && b2.equals(bytes), b2 ? b2.length + "B" : "无响应");
ok("HIT 仍是 200 直出字节（浏览器不需要再连 Storage）", hit2.status === 200, "status=" + hit2.status);

/* 3) 不存在的图：上游 404 → 退回 302 直连（图仍能显示，最差等于改造前） */
const miss = await fetch(`${BASE}/img/${encodeURIComponent(uid)}/not-exist-${Date.now()}.png`, { redirect: "manual" });
ok("图不存在时退回 302 直连 Storage（不白块、不 500）",
  miss.status === 302 && (miss.headers.get("location") || "").includes("storage"),
  "status=" + miss.status + " x-img-cache=" + miss.headers.get("x-img-cache"));

/* 4) 路径穿越仍被挡 */
const evil = await fetch(`${BASE}/img/${encodeURIComponent("../../etc/passwd")}`, { redirect: "manual" });
ok("路径穿越 / 非法路径 → 400（安全阀没被缓存改造放松）", evil.status === 400, "status=" + evil.status);

/* 清理：删掉测试对象（storage own delete 策略） */
const { error: rmErr } = await sb.storage.from("wall-images").remove([imgPath]);
info(rmErr ? "清理提示：对象可能仍在（" + rmErr.message + "）" : "测试对象已删除");

console.log("\nTOTAL " + (pass + fail) + "  PASS " + pass + "  FAIL " + fail);
process.exit(fail ? 1 : 0);
