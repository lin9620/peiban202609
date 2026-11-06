# 字体文件（自托管）

轮 436 从外部 CDN 改为打包内置。改前的问题与取舍见 `src/style.css` 顶部注释。

## 文件

| 文件 | 字体 | 许可 | 体积 | 用途 |
|---|---|---|---|---|
| `plus-jakarta-sans.woff2` | Plus Jakarta Sans | SIL Open Font License 1.1 | 27KB | 西文 + 数字，`--font-body` / `--font-display` |
| `wenkai-subset.woff2` | LXGW WenKai（霞鹜文楷） | SIL Open Font License 1.1 | 603KB | 内容文本（帖子正文 / 信件 / 故事），`--font-hand` |

两者均为 OFL 1.1，允许随产品分发与再分发，保留本说明即可。

## 两个文件为什么这么大差别

- **Jakarta** 是可变字体（wght 200–800 单文件），只含 latin 子集，所以只有 27KB。
  一个文件覆盖全部字重 —— 这正是「700/800 不再是伪粗体」的原因。
- **楷体**原始文件 11.7MB。这里用 fontTools 按**项目实际用到的 2892 个字符**
  （`src/`、`index.html` 里出现的全部汉字 + ASCII + 中文标点）做了子集，压到 603KB。
  用户输入项目里没有的生僻字时会自然落到 `--font-cn` 的系统中文字体，不会出豆腐块。

## 重新生成楷体子集

改动界面文案后如果出现新的汉字，需要重跑一次（否则新字会用系统字体显示，观感不一致）：

```bash
# 1. 拿完整字体（11.7MB，走 jsdelivr 的 GitHub 镜像，直连 GitHub 在国内常超时）
curl -sL -o /tmp/wk.ttf \
  "https://cdn.jsdelivr.net/gh/lxgw/LxgwWenKai-Lite@v1.510/fonts/TTF/LXGWWenKaiLite-Regular.ttf"

# 2. 装工具
pip install fonttools brotli

# 3. 提取字符集 → 子集化（脚本见下）
```

字符集提取覆盖 `src/**/*.vue`、`src/**/*.js`、`index.html` 里的全部 CJK 字符，
外加 ASCII 可打印字符和中文标点。注意 `src/views/MessagesView.vue` 里有一批
**编码损坏的注释**（UTF-8 被按 GBK 解释过的产物，约 470 个乱码字符），
提取时要排除 —— 它们不是真实文案，混进字符集只会让子集体积无谓变大。
