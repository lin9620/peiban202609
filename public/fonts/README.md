# 字体（轮 437b 定稿）

## 包内只有一个文件

| 文件 | 字体 | 许可 | 体积 | 用途 |
|---|---|---|---|---|
| `plus-jakarta-sans.woff2` | Plus Jakarta Sans 可变字体 | SIL OFL 1.1 | 27KB | 西文 + 数字，`--font-body` / `--font-display` 的首位 |

**中文（霞鹜文楷）不打进包**，和轮 406 之前一样由 `index.html` 从 jsdelivr 拉：

```
https://cdn.jsdelivr.net/npm/lxgw-wenkai-webfont@1.7.0/lxgwwenkai-regular.css
https://cdn.jsdelivr.net/npm/lxgw-wenkai-webfont@1.7.0/lxgwwenkai-bold.css
```

只引 regular + bold 两套。原包的 `style.css` 会把 light / mono 一起 `@import`（多约 400KB 无用 CSS），
项目里没有 `font-weight: 300` 的用法，去掉不影响任何页面。

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

`tools/font-test.mjs` 的 F7 会检查本目录：**只准有 `plus-jakarta-sans.woff2` 一个字体文件**，
且必须 < 60KB。塞回楷体测试会红。

## 附：如果以后真要离线包里带楷体

子集化脚本还留着：`tools/make-font-subset.py`（GB2312 全部 6763 字 + ASCII + 标点 + 源码字符）。
原始字体走 jsdelivr 的 Lite 仓库（11.7MB），每档子集约 1.7MB。
注意确认真下完整（曾有 3.1MB 半截文件导致 fontTools 报 `unexpected end of 'post' table data`）。
