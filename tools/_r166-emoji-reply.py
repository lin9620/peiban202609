# 轮 166：回复框表情接入（4 处）+ 输入行挤压布局（输入框扩宽）
import io

def edit(p, pairs):
    s = io.open(p, encoding="utf-8").read()
    for old, new in pairs:
        assert s.count(old) == 1, f"{p}: anchor x{s.count(old)}: {old[:70]!r}"
        s = s.replace(old, new)
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)
    print("ok", p)

CV = "src/views/CommunityView.vue"
edit(CV, [
# ① 一级回复框（ repPlaceholder(p, cm) ）
("""                v-model:value="repDraft[repKey(p, cm)]"
                type="textarea"
                :autosize="{ minRows: 1, maxRows: 4 }"
                :placeholder="repPlaceholder(p, cm)"
                :maxlength="MAX_LEN" />
              <n-button type="primary" size="small" round @click="sendCmt(p, cm)">""",
 """                v-model:value="repDraft[repKey(p, cm)]"
                type="textarea"
                :autosize="{ minRows: 1, maxRows: 4 }"
                :placeholder="repPlaceholder(p, cm)"
                :maxlength="MAX_LEN" />
              <EmojiPicker :text="repDraft[repKey(p, cm)] || ''" @update:text="v => (repDraft[repKey(p, cm)] = v)" />
              <n-button type="primary" size="small" round @click="sendCmt(p, cm)">"""),
# ② 二级就地回复框（ repPlaceholder(p, cm, rp) ）
("""                    :placeholder="repPlaceholder(p, cm, rp)"
                    :maxlength="MAX_LEN" />
                  <n-button type="primary" size="small" round @click="sendCmt(p, cm)">""",
 """                    :placeholder="repPlaceholder(p, cm, rp)"
                    :maxlength="MAX_LEN" />
                  <EmojiPicker :text="repDraft[repKey(p, cm)] || ''" @update:text="v => (repDraft[repKey(p, cm)] = v)" />
                  <n-button type="primary" size="small" round @click="sendCmt(p, cm)">"""),
])

PD = "src/views/PostDetailView.vue"
edit(PD, [
# ③ 一级回复框（ repPlaceholder(cm) ）
("""                <n-input v-model:value="repDraft[cm.id]" type="textarea" :autosize="{ minRows: 1, maxRows: 4 }"
                  :placeholder="repPlaceholder(cm)" :maxlength="MAX_LEN" />
                <n-button type="primary" size="small" round @click="sendCmt(cm)">""",
 """                <n-input v-model:value="repDraft[cm.id]" type="textarea" :autosize="{ minRows: 1, maxRows: 4 }"
                  :placeholder="repPlaceholder(cm)" :maxlength="MAX_LEN" />
                <EmojiPicker :text="repDraft[cm.id] || ''" @update:text="v => (repDraft[cm.id] = v)" />
                <n-button type="primary" size="small" round @click="sendCmt(cm)">"""),
# ④ 二级就地回复框（ repPlaceholder(cm, rp) ）
("""                    <n-input v-model:value="repDraft[cm.id]" type="textarea" :autosize="{ minRows: 1, maxRows: 4 }"
                      :placeholder="repPlaceholder(cm, rp)" :maxlength="MAX_LEN" />
                    <n-button type="primary" size="small" round @click="sendCmt(cm, rp)">""",
 """                    <n-input v-model:value="repDraft[cm.id]" type="textarea" :autosize="{ minRows: 1, maxRows: 4 }"
                      :placeholder="repPlaceholder(cm, rp)" :maxlength="MAX_LEN" />
                    <EmojiPicker :text="repDraft[cm.id] || ''" @update:text="v => (repDraft[cm.id] = v)" />
                    <n-button type="primary" size="small" round @click="sendCmt(cm, rp)">"""),
])

# ⑤ 输入行布局：输入框弹性占满、按钮不挤占（手机端表情/发送靠右收紧）
edit("src/style.css", [
("""/* 轮 162：刷新结果小药丸（暖爪可爱版）""",
 """/* 轮 166：输入行挤压——输入框弹性占满剩余宽（min-width:0 防撑破），表情/发送按钮收紧靠右；
   手机端表情按钮略缩（30px），给正文让宽 */
.cmt-input-row .n-input, .cmt-main-bar .n-input, .dm-input-row .n-input { flex: 1 1 auto; min-width: 0; }
.cmt-input-row .emo-root, .cmt-main-bar .emo-root, .dm-input-row .emo-root { flex: none; align-self: center; }
@media (max-width: 640px) {
  .cmt-input-row .emo-btn, .cmt-main-bar .emo-btn, .dm-input-row .emo-btn { width: 30px; height: 30px; }
  .cmt-input-row .emo-btn svg, .cmt-main-bar .emo-btn svg, .dm-input-row .emo-btn svg { width: 19px; height: 19px; }
}
/* 轮 162：刷新结果小药丸（暖爪可爱版）"""),
])
print("ALL 166 EDITS DONE")
