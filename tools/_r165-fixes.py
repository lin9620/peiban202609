# 轮 165：freshOk 块级作用域炸页 + 僵尸会话自清 + 表情面板手机端贴底
import io

def edit(p, pairs):
    s = io.open(p, encoding="utf-8").read()
    for old, new in pairs:
        assert s.count(old) == 1, f"{p}: anchor x{s.count(old)}: {old[:70]!r}"
        s = s.replace(old, new)
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)
    print("ok", p)

# ═══ ① 图2 根因：freshOk 声明在 if(fresh) 块内、return 在块外 → ReferenceError 炸整页 ═══
edit("src/views/CommunityView.vue", [
("""async function loadCloud({ fresh = false } = {}) {
  loadingCloud.value = true;""",
 """async function loadCloud({ fresh = false } = {}) {
  loadingCloud.value = true;
  let freshOk = true;   /* 轮 165 修：必须声明在函数作用域——上一轮写进了 if(fresh) 块内，
                           而函数尾 return freshOk 在块外 → ReferenceError 直接把整页炸成错误卡 */"""),
("""    refreshNote.value = "busy";
    let freshOk = true;
    const prevNewest = newestSeenTs.value;""",
 """    refreshNote.value = "busy";
    const prevNewest = newestSeenTs.value;"""),
])

# ═══ ② 图3 根因：僵尸会话——刷新令牌已死时 refreshAccessToken 静默失败，
#        顶栏仍显示「已登录」，所有带身份请求（含公开读）持续 401。失败且判定
#        「令牌真死」时客户端自清（signOut），界面回到未登录态引导重登；
#        纯网络抖动（Failed to fetch）不清理，避免弱网误登出。 ═══
edit("src/utils/supabase.js", [
("""    try {
      const { data, error } = await sb.auth.refreshSession();
      if (error) return "";
      const s = data && data.session;
      if (!s || !s.access_token) return "";
      accessToken = s.access_token;
      cloud.user = s.user || cloud.user;
      return accessToken;
    } catch (e) {
      return "";
    } finally {
      refreshing = null;
    }""",
 """    try {
      const { data, error } = await sb.auth.refreshSession();
      if (error) { await deadSessionSignOut(error); return ""; }
      const s = data && data.session;
      if (!s || !s.access_token) { await deadSessionSignOut(error); return ""; }
      accessToken = s.access_token;
      cloud.user = s.user || cloud.user;
      return accessToken;
    } catch (e) {
      await deadSessionSignOut(e);
      return "";
    } finally {
      refreshing = null;
    }"""),
("""let refreshing = null;
export async function refreshAccessToken() {""",
 """let refreshing = null;
/** 轮 165：刷新令牌「真死」（失效/被吊销/会话缺失）→ 清掉本地僵尸会话：
 *  顶栏不再假显示已登录，页面按未登录渲染，用户重新登录即可恢复。
 *  仅网络类失败（Failed to fetch / 超时）不清理——弱网误登出比多 401 一次更伤。 */
async function deadSessionSignOut(err) {
  const msg = String((err && (err.message || err.code)) || err || "");
  if (!/session missing|invalid refresh|refresh token|invalid grant|401|403/i.test(msg)) return;
  try {
    accessToken = "";
    cloud.user = null;
    await sb.auth.signOut();
  } catch (e) { /* 清理失败下次再清 */ }
}
export async function refreshAccessToken() {"""),
])

# ═══ ③ 图1：表情面板手机端贴底成微信式横条面板 + 外点收面板时不再连带收评论条 ═══
edit("src/components/EmojiPicker.vue", [
("""function toggle() {
  if (open.value) { open.value = false; return; }
  const r = root.value.getBoundingClientRect();
  const left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - 304));
  pos.value = { left: left + "px", bottom: Math.max(8, window.innerHeight - r.top + 8) + "px" };
  open.value = true;
}""",
 """function toggle() {
  if (open.value) { open.value = false; return; }
  const r = root.value.getBoundingClientRect();
  const bottom = Math.max(8, window.innerHeight - r.top + 8) + "px";
  if (window.innerWidth < 640) {
    /* 轮 165：手机端贴底全宽（微信式），不再按按钮位置浮在半空挡内容 */
    pos.value = { left: "8px", right: "8px", width: "auto", bottom };
  } else {
    const left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - 304));
    pos.value = { left: left + "px", bottom };
  }
  open.value = true;
}"""),
(""".emo-panel {
  position: fixed; z-index: 260;
  width: 296px; max-width: calc(100vw - 16px); max-height: 40vh; overflow-y: auto;""",
 """.emo-panel {
  position: fixed; z-index: 260;
  width: 296px; max-width: calc(100vw - 16px); max-height: 42vh; overflow-y: auto;"""),
])

edit("src/views/CommunityView.vue", [
("""function mainBarDocClose(e) {
  const tgt = e.target;
  if (mainBarEl.value && mainBarEl.value.contains(tgt)) return;   /* 条内（输入框/发送键）不关 */""",
 """function mainBarDocClose(e) {
  const tgt = e.target;
  if (mainBarEl.value && mainBarEl.value.contains(tgt)) return;   /* 条内（输入框/发送键）不关 */
  if (document.querySelector(".emo-panel")) return;   /* 轮 165：表情面板开着时点外只收面板，别把评论条一并收了 */"""),
])
print("ALL 165 EDITS DONE")
