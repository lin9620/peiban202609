# -*- coding: utf-8 -*-
"""霞鹜文楷子集化（py -3.12 tools/make-font-subset.py <源ttf> <输出woff2>）

轮 436b：中文字体分层回滚后，中文全站重新走楷体 —— 子集必须覆盖「用户可能打出来的字」，
不能只覆盖源码里出现的字，否则帖子正文里出现新字就掉回系统黑体，一行里两种字体。

字符集 = GB2312 全部汉字（6763）+ ASCII 可打印 + 中文标点/全角区 + 源码里额外出现的字符
（源码那部分是兜底：注释、生僻词、emoji 之外的符号）。
"""
import sys, os, glob
from fontTools import subset

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def source_chars():
    out = set()
    paths = []
    for ext in ("vue", "js", "mjs", "css", "html"):
        paths += glob.glob(os.path.join(ROOT, "src", "**", "*." + ext), recursive=True)
    paths.append(os.path.join(ROOT, "index.html"))
    for p in paths:
        try:
            with open(p, encoding="utf-8") as f:
                out |= set(f.read())
        except (UnicodeDecodeError, OSError):
            pass
    return out


def gb2312_hanzi():
    out = set()
    for hi in range(0xB0, 0xF8):
        for lo in range(0xA1, 0xFF):
            try:
                out.add(bytes([hi, lo]).decode("gb2312"))
            except UnicodeDecodeError:
                pass
    return out


def main():
    src, dst = sys.argv[1], sys.argv[2]
    chars = set()
    chars |= {chr(c) for c in range(0x20, 0x7F)}          # ASCII 可打印
    chars |= gb2312_hanzi()                                # 6763 常用汉字
    chars |= {chr(c) for c in range(0x3000, 0x3040)}       # CJK 标点
    chars |= {chr(c) for c in range(0xFF01, 0xFF61)}       # 全角字符
    chars |= set("·—…“”‘’°±×÷≈≤≥→←↑↓★☆※§¥€£©®™")
    chars |= {c for c in source_chars() if ord(c) > 0x7F}

    opts = subset.Options()
    opts.flavor = "woff2"
    opts.desubroutinize = True
    opts.layout_features = ["*"]
    opts.name_IDs = ["*"]
    opts.notdef_outline = True
    font = subset.load_font(src, opts)
    keep = [c for c in sorted(chars) if ord(c) in font.getBestCmap()]
    subsetter = subset.Subsetter(options=opts)
    subsetter.populate(unicodes=[ord(c) for c in keep])
    subsetter.subset(font)
    subset.save_font(font, dst, opts)
    print("请求 %d 字，字体实有 %d 字 → %s（%.0fKB）" % (
        len(chars), len(keep), dst, os.path.getsize(dst) / 1024))


if __name__ == "__main__":
    main()
