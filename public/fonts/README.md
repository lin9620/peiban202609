# 字体（轮 456 定稿）

## 包内只有一个文件

| 文件 | 字体 | 许可 | 体积 | 用途 |
|---|---|---|---|---|
| `reddit-sans.woff2` | Reddit Sans 可变字体（wght 200–900） | SIL OFL 1.1 | 41.8KB | **英 / 西 / 葡 / 法** 全部西文与数字，`--font-body` / `--font-display` 的首位 |

**中文（霞鹜文楷）不打进包**，和轮 406 之前一样由 `index.html` 从 jsdelivr 拉：

```
https://cdn.jsdelivr.net/npm/lxgw-wenkai-webfont@1.7.0/lxgwwenkai-regular.css
https://cdn.jsdelivr.net/npm/lxgw-wenkai-webfont@1.7.0/lxgwwenkai-bold.css
```

只引 regular + bold 两套。原包的 `style.css` 会把 light / mono 一起 `@import`（多约 400KB 无用 CSS），
项目里没有 `font-weight: 300` 的用法，去掉不影响任何页面。

## Reddit Sans 的来历（轮 456）

用户原话：「英文字体确定了，用 reddit 的同款字体」「除了中文外的其他语言也是用 reddit 的」。

- Reddit 2023 年换牌时与 Pentagram 合作的**自有字体**，SIL Open Font License 1.1 开源：
  <https://github.com/reddit/redditsans> ｜ <https://fonts.google.com/specimen/Reddit+Sans>
- 取的是 Google Fonts 的 **latin 分片**（`EYq3maFOxq1T_-ETdN7EKQNre5Y.woff2`，v6，41.8KB）：
  `unicode-range` 含 `U+0000-00FF`、`U+0152-0153`（法语 œ）、`U+2000-206F`（弯引号），
  英/西/葡/法四种语言的 ñ ã ç œ ¿ ¡ 全部覆盖。
- **latin-ext（34KB）不要**：那是越南语与东欧语，项目没有这些语言，白占体积。
- 可变轴 `wght 200 900`：一个文件顶七档，代码里 700/800 是真字形，不会出现「英文合成加粗发胖」。

替换前的旧字体（Plus Jakarta Sans，27KB）在 `.stale-assets/<时间戳>/` 里，确认无碍后可整体清空。

## 为什么中文不进包（轮 437b）

轮 436 为了修英文，把楷体也做子集塞进了安装包（603KB → 后来 3.4MB），APK 从 6.8MB 涨到 9.7MB。
用户直接问：「我让你回退，为什么字体能占用这么大的体积，字体以前就有啊」——
以前它**不在**包里，是网页从 CDN 拉的，包内是零。现在回到那个做法。

进包 vs 走 CDN 的取舍：走 CDN 弱网时会先显示系统黑体、字体到了再换（`font-display: swap`）；
进包是零延迟但要背 3MB 体积。用户选前者。

## 中文为什么不再分层

轮 436 试过「UI 用系统黑体、正文用楷体」，用户否掉了（「还不如原来的」），已整体回滚：
中文全站统一霞鹜文楷，不再有 `--font-hand` / `--font-cn`。`tools/font-test.mjs` 的 F3 盯死这一点。

## 别再往这里塞楷体

`tools/font-test.mjs` 的 F7 会检查本目录：**只准有 `reddit-sans.woff2` 一个字体文件**，
且必须 < 60KB。塞回楷体测试会红。

## 附：如果以后真要离线包里带楷体

子集化脚本还留着：`tools/make-font-subset.py`（GB2312 全部 6763 字 + ASCII + 标点 + 源码字符）。
原始字体走 jsdelivr 的 Lite 仓库（11.7MB），每档子集约 1.7MB。
注意确认真下完整（曾有 3.1MB 半截文件导致 fontTools 报 `unexpected end of 'post' table data`）。
