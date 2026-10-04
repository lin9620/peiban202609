# 轮 164：评论框/私信框发送键左侧加表情按钮（EmojiPicker 五处接入）
import io

def edit(p, pairs, must=True):
    s = io.open(p, encoding="utf-8").read()
    for old, new in pairs:
        n = s.count(old)
        if must: assert n == 1, f"{p}: anchor x{n}: {old[:70]!r}"
        elif n != 1:
            print(f"  skip ({p}): anchor x{n}")
            continue
        s = s.replace(old, new)
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)
    print("ok", p)

# ═══ ① MessagesView：私信输入行（发送键左侧） ═══
MV = "src/views/MessagesView.vue"
edit(MV, [
("""import BottleRecords from "../components/BottleRecords.vue";""",
 """import BottleRecords from "../components/BottleRecords.vue";
import EmojiPicker from "../components/EmojiPicker.vue";   /* 轮 164：表情按钮 */"""),
("""                  :placeholder="isMobileNav ? t('dm.placeholderMobile') : t('dm.placeholder')"
                  @keydown.enter.exact.prevent="send" />
                <n-button type="primary" round size="small" :loading="sending" :disabled="!body.trim()" @click="send">""",
 """                  :placeholder="isMobileNav ? t('dm.placeholderMobile') : t('dm.placeholder')"
                  @keydown.enter.exact.prevent="send" />
                <EmojiPicker :text="body" @update:text="v => (body = v)" />
                <n-button type="primary" round size="small" :loading="sending" :disabled="!body.trim()" @click="send">"""),
])

# ═══ ② BottleChat：漂流瓶聊天行（同款） ═══
BC = "src/components/BottleChat.vue"
edit(BC, [
("""import { refreshBadge } from "../stores/badgeStore.js";""",
 """import { refreshBadge } from "../stores/badgeStore.js";
import EmojiPicker from "./EmojiPicker.vue";   /* 轮 164：表情按钮 */"""),
("""              :placeholder="t('dm.placeholder')" @keydown.enter.exact.prevent="send" />
            <n-button type="primary" round size="small" :loading="sending" :disabled="!body.trim()" @click="send">""",
 """              :placeholder="t('dm.placeholder')" @keydown.enter.exact.prevent="send" />
            <EmojiPicker :text="body" @update:text="v => (body = v)" />
            <n-button type="primary" round size="small" :loading="sending" :disabled="!body.trim()" @click="send">"""),
])

# ═══ ③ PostDetail：桌面主评论框（发送键左侧） ═══
PD = "src/views/PostDetailView.vue"
s = io.open(PD, encoding="utf-8").read()
if "EmojiPicker" not in s:   # 平行会话可能也在改——幂等保护
    m = "import { isMobileNav, tabbarSuppressed } from \"../stores/uiStore.js\";"
    n = m + "\nimport EmojiPicker from \"../components/EmojiPicker.vue\";   /* 轮 164：表情按钮 */"
    assert s.count(m) == 1, "PD import anchor"
    s = s.replace(m, n)
    old = """            <n-input v-model:value="cmtDraft" type="textarea" :autosize="{ minRows: 1, maxRows: 4 }"
              :placeholder="t('comment.placeholder')" :maxlength="MAX_LEN" />
            <n-button type="primary" size="small" round class="cmt-send" @click="sendTopCmt()">"""
    new = """            <n-input v-model:value="cmtDraft" type="textarea" :autosize="{ minRows: 1, maxRows: 4 }"
              :placeholder="t('comment.placeholder')" :maxlength="MAX_LEN" />
            <EmojiPicker :text="cmtDraft" @update:text="v => (cmtDraft = v)" />
            <n-button type="primary" size="small" round class="cmt-send" @click="sendTopCmt()">"""
    assert s.count(old) == 1, "PD row anchor"
    s = s.replace(old, new)
    io.open(PD, "w", encoding="utf-8", newline="\n").write(s)
    print("ok", PD)
else:
    print("  skip (PD): already integrated")

# ═══ ④ CommunityView：内联评论框 + 手机底部输入条 ═══
CV = "src/views/CommunityView.vue"
s = io.open(CV, encoding="utf-8").read()
if 'EmojiPicker :text="cmtDraft[cmtKey(p)]"' not in s:
    m = 'import { isMobileNav, pushBack, popBack } from "../stores/uiStore.js";'
    if m not in s:
        import re
        mm = re.search(r'import \{ isMobileNav[^}]*\} from "\.\./stores/uiStore\.js";', s)
        assert mm, "CV uiStore import"
        m = mm.group(0)
    n = m + '\nimport EmojiPicker from "../components/EmojiPicker.vue";   /* 轮 164：表情按钮 */'
    assert s.count(m) == 1, "CV import anchor"
    s = s.replace(m, n)
    old = """            :placeholder="t('comment.placeholder')"
            :maxlength="MAX_LEN" />
          <n-button type="primary" size="small" round class="cmt-send" @click="sendTopCmt(p)">"""
    new = """            :placeholder="t('comment.placeholder')"
            :maxlength="MAX_LEN" />
          <EmojiPicker :text="cmtDraft[cmtKey(p)] || ''" @update:text="v => (cmtDraft[cmtKey(p)] = v)" />
          <n-button type="primary" size="small" round class="cmt-send" @click="sendTopCmt(p)">"""
    assert s.count(old) == 1, "CV inline anchor"
    s = s.replace(old, new)
    old = """        :placeholder="mainBarPh" :maxlength="MAX_LEN" />
      <n-button type="primary" size="small" round @click="sendMainBar">{{ t("common.send") }}</n-button>"""
    new = """        :placeholder="mainBarPh" :maxlength="MAX_LEN" />
      <EmojiPicker :text="mainBarDraft" @update:text="v => (mainBarDraft = v)" />
      <n-button type="primary" size="small" round @click="sendMainBar">{{ t("common.send") }}</n-button>"""
    assert s.count(old) == 1, "CV mainBar anchor"
    s = s.replace(old, new)
    io.open(CV, "w", encoding="utf-8", newline="\n").write(s)
    print("ok", CV)
else:
    print("  skip (CV): already integrated")

# ═══ ⑤ i18n：emoji.title 键对（zh/en） ═══
edit("src/i18n.js", [
("""      refreshed: "已刷新",
      refreshFail: "没刷出来，再试一次",""",
 """      refreshed: "已刷新",
      refreshFail: "没刷出来，再试一次",
      emojiTitle: "表情","""),
("""      refreshed: "Refreshed",
      refreshFail: "Couldn't refresh — try again",""",
 """      refreshed: "Refreshed",
      refreshFail: "Couldn't refresh — try again",
      emojiTitle: "Emoji","""),
])
print("ALL 164 EDITS DONE")
