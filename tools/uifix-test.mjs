/* 修复项回归测试（Node 直跑：node tools/uifix-test.mjs）
 * ------------------------------------------------------------
 * 覆盖本轮修掉的 4 项问题 + 纯函数回归：
 *  P2  评论 200 字：输入框硬限制 + 剩余字数 + 达上限提示（i18n 双语 + 模板）
 *  P1  上传图片：社区帖之外，自定义立绘也必须走 imaging 管线（体积/比例/最长边）
 *  P2  安全响应头：_headers 补 CSP 与 HSTS
 *  体验 陪你大厅：不再展示本地随机「在线人数」（无 online 计算、无 dayOfYear 依赖）
 * 另外用纯函数直接验证 fitSize/validateImageFile 在新参数下的行为。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fitSize, validateImageFile, MAX_EDGE, MAX_PET_EDGE, MAX_FILE_BYTES,
} from "../src/utils/imaging.js";
import { MAX_LEN } from "../src/utils/comments.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const out = [];
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; out.push("PASS  " + name); }
  catch (e) { fail++; out.push("FAIL  " + name + "  → " + e.message); }
}

/* ═════════ ① 评论 200 字硬限制 ══════════ */
const cmt = read("src/views/CommunityView.vue");
t("T1 评论输入框加 :maxlength 硬限制", () => {
  assert.ok(cmt.includes(':maxlength="MAX_LEN"'), "缺少 :maxlength");
  assert.ok(cmt.includes("MAX_LEN,"), "未从 comments.js 导入 MAX_LEN");
});
t("T2 评论框展示剩余字数 / 上限提示", () => {
  assert.ok(cmt.includes('class="cmt-left"'), "缺少字数提示元素");
  assert.ok(cmt.includes('t("comment.left"'), "缺少剩余字数文案");
  assert.ok(cmt.includes('t("comment.full"'), "缺少达上限文案");
});
t("T3 字数由 MAX_LEN 单一来源驱动（不是写死 200）", () => {
  assert.equal(MAX_LEN, 200);
  assert.ok(/cmtLeft\(p\)[\s\S]{0,120}MAX_LEN/.test(cmt), "cmtLeft 未使用 MAX_LEN");
});
t("T4 文案双语齐备", () => {
  const i18n = read("src/i18n.js");
  for (const k of ['left: "{n} characters left"', 'full: "Reached the {n}-character limit"',
    'left: "还可写 {n} 字"', 'full: "已达 {n} 字上限，不能再输入了"']) {
    assert.ok(i18n.includes(k), "缺少 " + k);
  }
});
t("T5 样式定义了 .cmt-left（含达上限配色）", () => {
  const css = read("src/style.css");
  assert.ok(css.includes(".cmt-left"), "缺少 .cmt-left");
  assert.ok(css.includes(".cmt-left.full"), "缺少达上限配色");
});

/* ══════════ ② 自定义立绘上传校验 ══════════ */
const pet = read("src/views/PetView.vue");
t("T6 立绘上传接入 imaging 管线", () => {
  for (const s of ["validateImageFile(file)", "isSaneShape(", "isUsableDataUrl(", "shrinkToDataUrl("]) {
    assert.ok(pet.includes(s), "缺少 " + s);
  }
});
t("T7 立绘压缩到 MAX_PET_EDGE 且保留 PNG 透明底", () => {
  assert.ok(pet.includes("MAX_PET_EDGE"), "未使用 MAX_PET_EDGE");
  assert.ok(/shrinkToDataUrl\(img[^)]*"image\/png"[^)]*MAX_PET_EDGE/.test(pet), "未按 png+480 压缩");
});
t("T8 立绘错误提示双语齐备", () => {
  const i18n = read("src/i18n.js");
  assert.ok(i18n.includes('imgTooLarge: "That image is over 5 MB'), "en pet.imgTooLarge 缺失");
  assert.ok(i18n.includes('imgTooLarge: "这张图片超过 5 MB 了'), "zh pet.imgTooLarge 缺失");
  assert.ok(pet.includes("t(customErr)"), "错误提示未渲染");
});
t("T9 选同一张图两次都会触发校验（input 已清空）", () => {
  assert.ok(/e\.target\.value = "";/.test(pet), "未清空 input.value");
});
t("T10 纯函数：立绘缩放到 480 长边", () => {
  assert.equal(MAX_PET_EDGE, 480);
  assert.deepEqual(fitSize(1600, 1200, MAX_PET_EDGE), { width: 480, height: 360 });
  assert.deepEqual(fitSize(300, 200, MAX_PET_EDGE), { width: 300, height: 200 });
});
t("T11 纯函数：立绘文件同样受 5MB / 图片类型约束", () => {
  assert.deepEqual(validateImageFile({ type: "image/png", size: MAX_FILE_BYTES + 1 }),
    { ok: false, reason: "too-large" });
  assert.equal(validateImageFile({ type: "text/plain", size: 10 }).ok, false);
});
t("T12 shrinkToDataUrl 支持 mime/最长边参数（社区图仍默认 900 jpeg）", () => {
  const img = read("src/utils/imaging.js");
  assert.ok(/shrinkToDataUrl\(img, quality = 0\.78, mime = "image\/jpeg", maxEdge = MAX_EDGE\)/.test(img),
    "签名不符");
  assert.equal(MAX_EDGE, 900);
  assert.ok(img.includes("toDataURL(mime, quality)"), "未使用 mime 参数");
});
/* ═════════ ③ 安全响应头（CSP + HSTS） ══════════ */
const hdr = read("public/_headers");
t("T13 _headers 含 Content-Security-Policy", () => {
  assert.ok(hdr.includes("Content-Security-Policy:"), "缺少 CSP");
});
t("T14 CSP 关键指令：禁 object / 限 frame-ancestors / default-src self", () => {
  assert.ok(hdr.includes("object-src 'none'"), "缺少 object-src 'none'");
  assert.ok(hdr.includes("frame-ancestors 'self'"), "缺少 frame-ancestors 'self'");
  assert.ok(hdr.includes("default-src 'self'"), "缺少 default-src 'self'");
});
t("T15 CSP 放行项目实际依赖（Google Fonts / jsDelivr / Supabase / dataURL 图）", () => {
  for (const s of ["style-src 'self' 'unsafe-inline' https:", "img-src 'self' data: blob: https:",
    "font-src 'self' data: https:", "connect-src 'self' https: wss: data:"]) {
    assert.ok(hdr.includes(s), "缺少 " + s);
  }
  assert.ok(read("index.html").includes("fonts.googleapis.com"), "静态依赖变了，CSP 需要同步复查");
});
t("T16 _headers 含 HSTS", () => {
  assert.ok(/Strict-Transport-Security:\s*max-age=\d{6,}/.test(hdr), "缺少 HSTS");
});
t("T17 旧的 4 个安全头仍在（不回归）", () => {
  for (const s of ["X-Content-Type-Options: nosniff", "Referrer-Policy: strict-origin-when-cross-origin",
    "X-Frame-Options: SAMEORIGIN", "Permissions-Policy:"]) {
    assert.ok(hdr.includes(s), "缺少 " + s);
  }
});

/* ══════════ ④ 陪你大厅：不再展示虚构在线人数 ══════════ */
const home = read("src/views/HomeView.vue");
const todayPane = read("src/components/TodayPane.vue");   /* T6 抽件：大厅文案在这里 */
t("T18 首页不再计算/展示在线人数（HomeView + TodayPane）", () => {
  assert.ok(!home.includes("const online = computed"), "仍有 online 计算");
  assert.ok(!home.includes("{{ online }}"), "模板仍渲染 online");
  assert.ok(!home.includes("dayOfYear"), "dayOfYear 已成死导入");
  assert.ok(!todayPane.includes("const online = computed") && !todayPane.includes("{{ online }}"), "抽件后仍残留 online");
});
t("T19 大厅文案改为如实描述（tag + hall）", () => {
  assert.ok(todayPane.includes('t("home.companions.tag")'), "缺少 tag 文案");
  assert.ok(todayPane.includes('t("home.companions.hall")'), "缺少 hall 文案");
  const i18n = read("src/i18n.js");
  assert.ok(i18n.includes('tag: "always on"') && i18n.includes('tag: "一直亮着"'), "tag 文案缺失");
  assert.ok(!i18n.includes('online: "{n} kind souls'), "残留 online 文案（en）");
  assert.ok(!i18n.includes('online: "此刻有 {n} 位温柔的人陪着你"'), "残留 online 文案（zh）");
});

/* ══════════ ⑤ 陪你大厅状态上云：未跑迁移时给一句人话 ══════════ */
t("T20 状态同步失败区分「未开启」与「同步失败」", () => {
  assert.ok(todayPane.includes('t("home.companions.syncNeedSetup")'), "缺少未迁移提示");
  assert.ok(todayPane.includes('t("home.companions.syncFail")'), "缺少同步失败提示");
  assert.ok(todayPane.includes('errorKind(cloud.error) === "not-migrated"'), "未用 errorKind 归类失败原因");
  assert.ok(!todayPane.includes("myStatusFail"), "残留旧的布尔失败标记");
  const i18n = read("src/i18n.js");
  assert.ok(i18n.includes("syncNeedSetup:"), "词典缺 syncNeedSetup");
  assert.ok(
    i18n.split("syncNeedSetup:").length === 3,
    "syncNeedSetup 未做到双语（en/zh 各一份）",
  );
  const wall = read("src/utils/wall.js");
  assert.ok(
    /catch \(e\) \{[\s\S]{0,160}cloud\.error = e && e\.message/.test(wall.split("export async function cloudSetStatus")[1] || ""),
    "cloudSetStatus 未记录 cloud.error（errorKind 归类无依据）",
  );
});

/* ══════════ ⑥ 文档同步 ══════════ */
t("T21 README 不再宣称展示在线人数，且登记新测试与迁移", () => {
  const md = read("README.md");
  assert.ok(!md.includes("显示此刻在线陪伴人数"), "README 仍在描述在线人数");
  assert.ok(md.includes("tools/uifix-test.mjs"), "README 未登记 uifix-test");
  assert.ok(md.includes("MIGRATION_profile_status.sql"), "README 未登记大厅状态迁移");
  assert.ok(md.includes("MIGRATION_dm_notifications.sql"), "README 未登记私信迁移");
});

/* ══════════ ⑦ 浏览眼睛摘除 / 我的页帖子 / 角色名额口径（#8 #9 #12） ══════════ */
const communityView = read("src/views/CommunityView.vue");
const wallerViewSrc = read("src/views/WallerView.vue");
const profileView = read("src/views/ProfileView.vue");
const petStoreSrc = read("src/stores/petStore.js");
const petViewSrc = read("src/views/PetView.vue");
t("T22 浏览眼睛已摘除（#8）：视图不再渲染 👁，浏览数文案保留", () => {
  for (const s of [communityView, wallerViewSrc]) {
    assert.ok(!s.includes("&#128065;") && !s.includes("👁"), "视图仍渲染眼睛图标");
  }
  assert.ok(communityView.includes('t("community.views"'), "浏览数文案被误删（应只去图标）");
});
t("T23 「我的」页展示我的帖子（共有 5：默认最新 3 条 + 「更多」→ /my-posts）", () => {
  assert.ok(profileView.includes("cloudFetchUserPosts(uid, 3)"), "ProfileView 应只拉最新 3 条");
  assert.ok(profileView.includes('to="/my-posts"') && profileView.includes("profile.more"), "缺「更多」入口");
  assert.ok(profileView.includes("profile.myPosts") && profileView.includes("profile.myPostsEmpty"), "缺少帖子区块文案键");
  assert.ok(profileView.includes("'/post/' + p.dbId"), "深链进独立详情页 /post/:id（轮 20，不再跳回暖心墙列表）");
  const i18n = read("src/i18n.js");
  assert.ok(i18n.split("myPosts:").length >= 3, "myPosts 未做到双语（en/zh 各一份）");
  /* 轮 36：首屏走 SWR（PAGE, 0）+ 翻页走 offset——两条路径都要在 */
  const myPostsSrc = read("src/views/MyPostsView.vue");
  assert.ok(myPostsSrc.includes("cloudFetchUserPosts(uid.value, PAGE, offset)"), "MyPostsView 翻页应用 offset 分页");
  assert.ok(myPostsSrc.includes("PAGE, 0") && myPostsSrc.includes("swr("), "MyPostsView 首屏应走 SWR 缓存（轮 36）");
  assert.ok(read("src/router.js").includes('"./views/MyPostsView.vue"'), "路由未挂 /my-posts");
});
t("T24 角色名额只数上传的「我的角色」（#12）：初始/物种伙伴不占名额", () => {
  assert.ok(petStoreSrc.includes("MAX_CUSTOM_PETS = 3"), "常量未改为 MAX_CUSTOM_PETS");
  assert.ok(!petStoreSrc.includes("MAX_PETS "), "残留旧常量 MAX_PETS");
  assert.ok(
    petStoreSrc.includes("if (custom && this.pets.filter((p) => p.custom && !p.dead).length >= MAX_CUSTOM_PETS)"),
    "adopt 的名额判定未按 custom 过滤",
  );
  assert.ok(petViewSrc.includes("customCount") && petViewSrc.includes("customQuotaHit"), "PetView 未切换到 customCount/customQuotaHit");
  assert.ok(!petViewSrc.includes("adoptLimitHit"), "残留已改名的 adoptLimitHit（未定义符号，走到即 ReferenceError）");
  assert.ok(!petViewSrc.includes("aliveCount") && !petViewSrc.includes("MAX_PETS,"), "PetView 残留旧口径");
  assert.ok(!petViewSrc.includes('t("pet.quota"'), "模板仍引用已删除的 pet.quota");
  assert.ok(petViewSrc.includes('t("pet.customQuota"'), "缺少 customQuota 名额展示");
  const i18n = read("src/i18n.js");
  assert.ok(!i18n.includes('quota: "Companions') && !i18n.includes('quota: "伙伴名额'), "旧 quota 文案未清理");
  assert.ok(i18n.split("customQuota:").length >= 3, "customQuota 未做到双语（en/zh 各一份）");
});

out.push("");
out.push("TOTAL " + (pass + fail) + "  PASS " + pass + "  FAIL " + fail);
console.log(out.join("\n"));
process.exit(fail ? 1 : 0);