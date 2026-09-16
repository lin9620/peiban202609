/* 登录功能回归：node tools/auth-test.mjs
 * ------------------------------------------------------------
 * 覆盖本轮新增／修好的三件事，外加「接线」检查（纯函数对了不代表页面接上了）：
 *  ① 忘记密码：发重置邮件 → 邮件链接落地识别 → 设置新密码 → 提示语
 *  ② Google 一键登录：入口、跳转参数、失败兜底、昵称兜底（Google 不返回 nickname）
 *  ③ 邮箱 / 密码本地校验：只提前给一句人话，阈值与服务端一致
 * 回归重点（线上踩过的坑）：
 *  · 地址栏令牌必须在 createClient 之前读（supabase-js 解析后会把参数清掉）；
 *  · resetPassword 的链接含 type=recovery（implicit），而 PKCE 流程只有 ?code=，
 *    两条路要互为兜底，任一失效都不该让用户卡在空白页；
 *  · 重置链接只能用一次，第二次点击会带 error_code=otp_expired —— 必须如实说明。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MIN_PASSWORD, NICK_MAX, isEmail, emailProblem, passwordProblem, bestNickname,
  parseAuthRedirect, hasAuthParams, isRecoveryEvent, redirectUrl,
} from "../src/utils/authRules.js";
import { messages, t, i18n } from "../src/i18n.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => {
  if (c) { pass++; console.log("PASS ", n, extra); }
  else { fail++; console.log("FAIL ", n, extra); }
};

/* ═════════ ① 邮箱 / 密码本地校验 ═════════ */
ok("A1 常见邮箱判为合法", isEmail("a@b.co") && isEmail("  me@dale.de5.net  ") && isEmail("x.y+z@sub.example.org"));
ok("A2 明显不是邮箱的判为非法",
  !isEmail("") && !isEmail("abc") && !isEmail("a@b") && !isEmail("a b@c.com")
  && !isEmail("@b.com") && !isEmail("a@.com") && !isEmail("a@b.") && !isEmail("a@b@c.com"));
ok("A3 emailProblem 三态：空 / 格式错 / 通过",
  emailProblem("") === "missing" && emailProblem("abc") === "malformed" && emailProblem("a@b.co") === "");
ok("A4 passwordProblem 三态：空 / 太短 / 通过",
  passwordProblem("") === "missing"
  && passwordProblem("a".repeat(MIN_PASSWORD - 1)) === "short"
  && passwordProblem("a".repeat(MIN_PASSWORD)) === "");
ok("A5 最短密码阈值与服务端一致（Supabase 默认 6）", MIN_PASSWORD === 6, `MIN_PASSWORD=${MIN_PASSWORD}`);

/* ═════════ ② 昵称兜底（Google 元数据里没有 nickname） ═════════ */
ok("A6 Google 的 full_name 能被取用",
  bestNickname({ full_name: "Dale Chen" }, "dale@de5.net") === "Dale Chen");
ok("A7 自家注册的 nickname 优先于 Google 字段",
  bestNickname({ nickname: "爪爪", full_name: "Dale" }, "d@e.net") === "爪爪");
ok("A8 元数据缺失时退回邮箱前缀", bestNickname(null, "linyi@de5.net") === "linyi");
ok("A9 邮箱也没有时给 Guest，不返回空串", bestNickname({}, "") === "Guest" && bestNickname(undefined, null) === "Guest");
ok("A10 脏元数据不抛错（字符串 / 数字 / 数组）",
  bestNickname("weird", "a@b.co") === "a" && bestNickname(123, "") === "Guest" && bestNickname([], "") === "Guest");
ok("A11 超长昵称被截断到 NICK_MAX", bestNickname({ name: "x".repeat(80) }, "").length === NICK_MAX);
ok("A12 全是空白的昵称不算数", bestNickname({ name: "   ", nickname: "\t" }, "hi@b.co") === "hi");

/* ═════════ ③ 邮件链接落地参数解析 ═════════ */
const recHash = "#access_token=eyJhbGciOi&expires_in=3600&refresh_token=abc&token_type=bearer&type=recovery";
ok("A13 implicit 重置链接（type=recovery）被识别",
  parseAuthRedirect(recHash, "").kind === "recovery");
ok("A14 链接失效（error_code=otp_expired）被识别为错误并带原因",
  (() => {
    const r = parseAuthRedirect("#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired", "");
    return r.kind === "error" && r.code === "otp_expired" && r.reason.includes("invalid");
  })());
ok("A15 PKCE 流程（?code=…，无 type）不误判成 recovery —— 交给 PASSWORD_RECOVERY 事件",
  parseAuthRedirect("", "?code=abc123").kind === "");
ok("A16 干净的地址栏没有任何信号",
  parseAuthRedirect("", "").kind === "" && parseAuthRedirect("#", "?").kind === "");
ok("A17 错误优先于 recovery（同时存在时以错误为准）",
  parseAuthRedirect("#type=recovery&error_code=otp_expired", "").kind === "error");
ok("A18 & 与 %20 都能正确还原（error_description 带空格）",
  parseAuthRedirect("#error_code=otp_expired&error_description=Link+expired%20already", "").reason === "Link expired already");
ok("A19 hasAuthParams：令牌在 hash / search 里都算，普通地址不算",
  hasAuthParams(recHash, "") && hasAuthParams("", "?code=abc")
  && !hasAuthParams("", "") && !hasAuthParams("#top", "?page=2"));
ok("A20 长得像但不是的参数不误清地址栏（lake= / codes=）",
  !hasAuthParams("#lake=1", "?codes=2"));
ok("A21 isRecoveryEvent 只认 PASSWORD_RECOVERY", isRecoveryEvent("PASSWORD_RECOVERY") && !isRecoveryEvent("SIGNED_IN"));

/* ═════════ ④ 回跳地址 ═════════ */
ok("A22 回跳到当前页（登录表单在 /profile）",
  redirectUrl("https://dale.de5.net", "/profile") === "https://dale.de5.net/profile");
ok("A23 本地开发端口与末尾斜杠都正确",
  redirectUrl("http://localhost:5173", "/profile") === "http://localhost:5173/profile"
  && redirectUrl("https://dale.de5.net/", "/profile") === "https://dale.de5.net/profile");
ok("A24 非 http(s) / 空 origin 返回空串（交给 Site URL 兜底，不抛错）",
  redirectUrl("file://", "/profile") === "" && redirectUrl("", "/") === "" && redirectUrl(null, "/") === "");
ok("A25 pathname 缺前导斜杠时补上", redirectUrl("https://a.com", "profile") === "https://a.com/profile");

/* ═════════ ⑤ 接线：supabase.js 真的用了这些规则 ═════════ */
const sb = read("src/utils/supabase.js");
ok("A26 supabase.js 调用 resetPasswordForEmail 且带 redirectTo",
  /resetPasswordForEmail\(\s*email\s*,\s*redirectOptions\(\)\s*\)/.test(sb));
ok("A27 supabase.js 调用 signInWithOAuth({ provider: \"google\" }) 且带 redirectTo",
  /signInWithOAuth\(\s*\{\s*provider:\s*"google",\s*options:\s*redirectOptions\(\)\s*\}\s*\)/.test(sb));
ok("A28 supabase.js 调用 updateUser({ password }) 设置新密码",
  /updateUser\(\s*\{\s*password\s*\}\s*\)/.test(sb));
ok("A29 令牌在 createClient 之前读取（否则解析完就没了）", (() => {
  const cap = sb.indexOf("captureRedirect();");
  const cc = sb.indexOf("createClient(");
  return cap > 0 && cc > 0 && cap < cc;
})(), "captureRedirect 必须在 createClient 之前");
ok("A30 读到令牌后把地址栏抹掉（replaceState 到 pathname）",
  /history\.replaceState\(null,\s*"",\s*loc\.pathname\)/.test(sb));
ok("A31 PASSWORD_RECOVERY 事件挂上了（PKCE 流程兜底）",
  /isRecoveryEvent\(evt\)/.test(sb) && /onAuthStateChange\(\(evt,\s*session\)/.test(sb));
ok("A32 昵称兜底改走 bestNickname（Google 没有 nickname 字段）",
  /bestNickname\(user\.user_metadata,\s*user\.email\)/.test(sb));
ok("A33 cloud 暴露 recovery / recoveryErr 两个状态位",
  /recovery:\s*false/.test(sb) && /recoveryErr:\s*""/.test(sb));
ok("A34 未配置云端时不抛错（no-cloud 兜底至少 4 处）",
  (sb.match(/return \{ ok: false, reason: "no-cloud" \};/g) || []).length >= 4);

/* ═════════ ⑥ 接线：「我的」页 ═════════ */
const pv = read("src/views/ProfileView.vue");
ok("A35 ProfileView 引入四个新能力 + 三个纯函数",
  pv.includes("cloudResetPassword") && pv.includes("cloudUpdatePassword")
  && pv.includes("cloudSignInWithGoogle") && pv.includes("cloudClearRecovery")
  && pv.includes("MIN_PASSWORD") && pv.includes("emailProblem") && pv.includes("passwordProblem"));
ok("A36 Google 登录按钮存在并绑定 doGoogle",
  pv.includes('class="oauth-google"') && pv.includes("@click=\"doGoogle\""));
ok("A37 忘记密码入口在登录表单上（仅登录模式）",
  /v-if="authMode === 'signin'"[\s\S]{0,120}startForgot/.test(pv));
ok("A38 重置落地卡片由 cloud.recovery 驱动，并显示「保存新密码」",
  pv.includes("cloud.ready && cloud.recovery") && pv.includes("doSetPassword") && pv.includes('t("profile.savePass")'));
ok("A39 链接失效时如实说明并可重发（resetLinkBadWhy + 重新发链接）",
  pv.includes('t("profile.resetLinkBad")') && pv.includes('t("profile.resetLinkBadWhy"')
  && /resetLinkBad[\s\S]{0,400}startForgot/.test(pv));
ok("A40 保存成功后清掉 recovery 并给页面级提示（卡片此时已隐藏）",
  /cloudClearRecovery\(\);\s*\n\s*flash\.value = t\("profile\.resetDone"\)/.test(pv) && pv.includes("auth-flash"));
ok("A41 本地校验在提交前拦下并给人话（emailHint / passHint）",
  pv.includes("emailHint(email) || passHint(authPass.value)")
  && pv.includes("passHint(newPass.value)")
  && pv.includes("emailHint(authEmail.value)"));
ok("A42 退出登录时把提示与重置界面一起收掉",
  /async function signOut[\s\S]{0,300}leaveRecovery\(\)/.test(pv));
ok("A43 忘记密码模式下不显示 Google 按钮与密码框（避免歧义）",
  /<template v-if="!forgot">[\s\S]{0,700}oauth-google/.test(pv));
ok("A44 样式齐备（按钮 / 分隔线 / 提示配色 / 页面级提示）", (() => {
  const css = read("src/style.css");
  return [".auth-actions", ".oauth-google", ".oauth-g", ".or-line", ".notice.good", ".notice.bad", ".auth-flash"]
    .every((s) => css.includes(s));
})());

/* ═════════ ⑦ 文案：双语齐备 ═════════ */
const KEYS = [
  "googleSignIn", "googleBusy", "orEmail", "needEmail", "badEmail", "needPass", "shortPass",
  "passRule", "forgot", "forgotTitle", "forgotHint", "forgotHint2", "forgotSend", "forgotSent",
  "setPassTitle", "setPassHint", "newPass", "savePass", "backToSignIn", "resetDone",
  "resetLinkBad", "resetLinkBadWhy",
];
const missEn = KEYS.filter((k) => !messages.en.profile[k]);
const missZh = KEYS.filter((k) => !messages.zh.profile[k]);
ok("A45 新增文案 en 齐备", missEn.length === 0, missEn.join(","));
ok("A46 新增文案 zh 齐备", missZh.length === 0, missZh.join(","));
ok("A47 passRule / shortPass 的 {n} 真会被替换（不是原样吐出来）", (() => {
  i18n.locale = "zh";
  const a = t("profile.passRule", { n: MIN_PASSWORD });
  const b = t("profile.shortPass", { n: MIN_PASSWORD });
  i18n.locale = "en";
  const c = t("profile.passRule", { n: MIN_PASSWORD });
  const okAll = a.includes("6") && !a.includes("{n}") && b.includes("6") && c.includes("6");
  i18n.locale = "en";
  return okAll && t("profile.googleSignIn") === "Continue with Google";
})());
ok("A48 没有本地假成功文案（重置必须走邮件，不能宣称密码已改）", (() => {
  const s = JSON.stringify(messages);
  return !/密码已(修改|重置)/.test(s);
})());

console.log(`\nTOTAL ${pass + fail}  PASS ${pass}  FAIL ${fail}`);
if (fail > 0) process.exitCode = 1;
