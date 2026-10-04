# 轮 189：App 端输入框全量换 Vant Field（用户点单：自研/桌面输入全换别人的）
# n-input → van-field 机械映射 + 全局注册 + 样式接管。桌面（≥900）同文件，样式统一移动优先。
import io, re, glob

FILES = [
    "src/views/MessagesView.vue",
    "src/components/BottleChat.vue",
    "src/views/CommunityView.vue",
    "src/views/PostDetailView.vue",
    "src/components/BottleView.vue",
    "src/components/ReportDialog.vue",
    "src/views/AdminView.vue",
    "src/views/LoginView.vue",
    "src/views/ProfileView.vue",
    "src/views/SettingsView.vue",
]

def conv_props(tag):
    tag = tag
    tag = tag.replace("v-model:value=", "v-model=")
    # autosize 对象 → rows + autosize
    tag = re.sub(
        r':autosize="\{\s*minRows:\s*(\d+)\s*,\s*maxRows:\s*\d+\s*\}"',
        lambda a: 'rows="%s" autosize' % a.group(1),
        tag,
    )
    tag = tag.replace(' size="large"', "").replace(' size="small"', "").replace(' size="tiny"', "")
    tag = tag.replace(" round", "")
    return tag

total = 0
for f in FILES:
    s = io.open(f, encoding="utf-8").read()
    n0 = s.count("<n-input")
    if not n0:
        print("  skip", f)
        continue
    s = re.sub(r"<n-input\b", "<van-field", s)
    # 属性映射（只在 van-field 标签内）
    def map_attrs(m):
        return conv_props(m)
    # 逐个标签处理：找到每个 <van-field ...> 或多行块
    out = []
    i = 0
    while True:
        j = s.find("<van-field", i)
        if j < 0:
            out.append(s[i:])
            break
        out.append(s[i:j])
        # 找标签结束（/> 或 >）
        k_self = s.find("/>", j)
        k_gt = s.find(">", j)
        if k_self < k_gt:
            tag = s[j:k_self + 2]
            out.append(conv_props(tag))
            i = k_self + 2
        else:
            # 多行带子内容？n-input 全部自闭合或带 > 单行结束；找结束 >（非 />）
            e = s.find(">", j)
            tag = s[j:e + 1]
            out.append(conv_props(tag))
            i = e + 1
    s = "".join(out)
    n1 = s.count("<van-field")
    s = s.replace("<van-field\n", "<van-field\n")  # noop keep
    io.open(f, "w", encoding="utf-8", newline="\n").write(s)
    total += n0
    print(f"ok {f}: n-input {n0} → van-field {n1}")
print("total converted:", total)

# ═══ main.js：全局注册 Vant + 样式 ═══
p = "src/main.js"
s = io.open(p, encoding="utf-8").read()
old = """const app = createApp(App);"""
new = """import Vant from "vant";
import "vant/lib/index.css";

const app = createApp(App);
app.use(Vant);   /* 轮 189：App 端组件全量换 Vant（移动端标准件） */"""
assert s.count(old) == 1, "main.js anchor"
s = s.replace(old, new)
# import 放到文件顶部（ES import 提升无所谓位置，但放 createApp 前更整洁）——上面已就地写好
io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("ok main.js")
