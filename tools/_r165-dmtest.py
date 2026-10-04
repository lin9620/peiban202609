# 轮 165：dm-test 增补回归断言（freshOk 作用域顺序 + 表情贴底 + 僵尸会话自清）
import io
p = "tools/dm-test.mjs"
s = io.open(p, encoding="utf-8").read()
old = 'console.log(`dm-test: ${pass} pass, ${fails.length} fail`);'
new = r"""/* ───────── 轮 165：刷新炸页/僵尸会话/表情贴底回归 ───────── */
{
  const cv = fs.readFileSync("src/views/CommunityView.vue", "utf8");
  const iDecl = cv.indexOf("let freshOk = true;");
  const iIf = cv.indexOf("if (fresh) {");
  ok("刷新成败标记声明在 if(fresh) 之前（函数作用域——块内声明=ReferenceError 炸整页）",
    iDecl > -1 && iIf > -1 && iDecl < iIf && cv.split("let freshOk").length === 2);
  const sb = fs.readFileSync("src/utils/supabase.js", "utf8");
  ok("僵尸会话自清：刷新失败判定死令牌→signOut，网络类失败不误登出",
    sb.includes("deadSessionSignOut") && /session missing\|invalid refresh/i.test(sb)
    && sb.includes("Failed to fetch") === false);
  ok("僵尸会话自清：清空本地 token 与 user 再 signOut", sb.includes('accessToken = "";') && sb.includes("cloud.user = null;"));
  const picker = fs.readFileSync("src/components/EmojiPicker.vue", "utf8");
  ok("表情面板：手机端贴底全宽（<640px），桌面仍按按钮锚定",
    picker.includes("window.innerWidth < 640") && picker.includes('right: "8px"'));
  ok("表情面板开着时点外不连带收评论条", cv.includes('document.querySelector(".emo-panel")'));
}

console.log(`dm-test: ${pass} pass, ${fails.length} fail`);"""
assert s.count(old) == 1
io.open(p, "w", encoding="utf-8", newline="\n").write(s.replace(old, new))
print("dm-test extended 165")
