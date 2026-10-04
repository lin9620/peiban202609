# 轮 164：dm-test 增补表情按钮接线断言
import io
p = "tools/dm-test.mjs"
s = io.open(p, encoding="utf-8").read()
old = 'console.log(`dm-test: ${pass} pass, ${fails.length} fail`);'
new = r"""/* ───────── 轮 164：表情按钮接线（评论框/私信框五处 + 组件本身） ───────── */
{
  const picker = fs.readFileSync("src/components/EmojiPicker.vue", "utf8");
  const emojiCells = (picker.match(/"[^"]*[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}][^"]*"/gu) || []);
  const uniq = new Set(emojiCells);
  ok("表情面板：按钮同行找 textarea 光标插入（拿不到就追加）",
    picker.includes('parentElement.querySelector("textarea, input")')
    && picker.includes("selectionStart") && picker.includes("setSelectionRange"));
  ok("表情面板：fixed 定位 + teleport 到 body（防 overflow 裁剪/transform 陷阱）",
    picker.includes("position: fixed") && picker.includes('to="body"'));
  ok("表情面板：表情足量（≥56 格）且无重复", emojiCells.length >= 56 && uniq.size === emojiCells.length);
  ok("表情面板：i18n 键 emoji.title 在用", picker.includes('t("emoji.title")'));
  const cases = [
    ["私信会话框", "src/views/MessagesView.vue", 1],
    ["漂流瓶聊天框", "src/components/BottleChat.vue", 1],
    ["帖子详情评论框", "src/views/PostDetailView.vue", 1],
    ["暖心墙（内联框+底部输入条）", "src/views/CommunityView.vue", 2],
  ];
  for (const [name, f, need] of cases) {
    const c = fs.readFileSync(f, "utf8");
    const used = (c.match(/<EmojiPicker /g) || []).length;
    const wired = c.includes('from "../components/EmojiPicker.vue"') || c.includes('from "./EmojiPicker.vue"');
    ok("表情按钮接入：" + name, used >= need && wired);
  }
}

console.log(`dm-test: ${pass} pass, ${fails.length} fail`);"""
assert s.count(old) == 1
io.open(p, "w", encoding="utf-8", newline="\n").write(s.replace(old, new))
print("dm-test extended 164")
