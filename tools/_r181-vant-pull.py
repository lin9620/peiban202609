# 轮 181：暖心墙下拉刷新换 Vant PullRefresh（自研触摸手势退役）
import io

p = "src/views/CommunityView.vue"
s = io.open(p, encoding="utf-8").read()

# ① 引入 Vant PullRefresh（样式按需）
old = 'import ShareCard from "../components/ShareCard.vue";'
new = old + '\nimport { PullRefresh as VanPullRefresh } from "vant";\nimport "vant/es/pull-refresh/style/index.css";   /* 轮 181：Vant 下拉刷新（替换自研触摸手势） */'
assert s.count(old) == 1, "import x%d" % s.count(old)
s = s.replace(old, new)

# ② 自研下拉手势块 → Vant refreshing/onRefresh
old = """/* touchstart 在页面顶部下拉 → 松手重拉云端。走 SWR（loadCloud）：
 * 先渲染缓存再后台刷新，不闪白屏；60px 阈值，指示条跟手。 */
let pullStart = 0, pulling = false;
const pullDist = ref(0);
function ts(e) { if (window.scrollY <= 0) { pullStart = e.touches[0].clientY; pulling = true; } }
function tm(e) {
  if (!pulling) return;
  const d = e.touches[0].clientY - pullStart;
  if (d > 0 && window.scrollY <= 0) pullDist.value = Math.min(90, d);
  else pulling = false;
}
async function te() {
  if (!pulling) return;
  pulling = false;
  if (pullDist.value >= 62) {
    /* 轮 56：下拉刷新 = 强制取新第 1 页（不再拿缓存装样子）；轮 162：成败如实提示 */
    const okPull = await loadCloud({ fresh: true });
    refreshNote.value = okPull ? "ok" : "fail";
    setTimeout(() => { refreshNote.value = ""; }, 2500);
  }
  pullDist.value = 0;
}"""
new = """/* 轮 181：下拉刷新换 Vant PullRefresh（自研触摸手势退役）——
 * onRefresh 与桌面刷新按钮同一条强制取新路径（loadCloud({ fresh: true })，
 * 轮 79 取舍 / 轮 162 成败提示逻辑全在 loadCloud 内部）；refreshing 交给 v-model。 */
const refreshing = ref(false);
async function onRefresh() {
  await loadCloud({ fresh: true });
  refreshing.value = false;
}"""
assert s.count(old) == 1, "handlers x%d" % s.count(old)
s = s.replace(old, new)

# ③ 模板：根 div 的 touch 手势 + 自研指示条 → van-pull-refresh 包裹
old = """  <div @touchstart.passive="ts" @touchmove.passive="tm" @touchend.passive="te">
    <div class="wall-pull" :style="{ height: pullDist + 'px', opacity: pullDist / 62 }">↓</div>"""
new = """  <van-pull-refresh v-model="refreshing" @refresh="onRefresh" :head-height="62">
  <div>"""
assert s.count(old) == 1, "template-open x%d" % s.count(old)
s = s.replace(old, new)

# ④ 根 div 收尾：补 </van-pull-refresh>（举报弹窗之后、根 div 关闭之前）
old = """    <!-- 举报弹窗（帖子/评论共用一个实例） -->
    <ReportDialog v-model:show="reportShow" :target="reportTarget" />
  </div>
</template>"""
new = """    <!-- 举报弹窗（帖子/评论共用一个实例） -->
    <ReportDialog v-model:show="reportShow" :target="reportTarget" />
  </div>
  </van-pull-refresh>
</template>"""
assert s.count(old) == 1, "template-close x%d" % s.count(old)
s = s.replace(old, new)

io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("ok CommunityView vant pull")
PYEOF
node tools/build-until-good.mjs 2>&1 | tail -1