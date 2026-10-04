# 轮 157：聊天页性能优化一次性补丁（dmRules + MessagesView + BottleChat + style.css）
import io

def edit(p, pairs):
    s = io.open(p, encoding="utf-8").read()
    for old, new in pairs:
        assert s.count(old) == 1, f"{p}: anchor x{s.count(old)}: {old[:60]!r}"
        s = s.replace(old, new)
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)
    print("ok", p)

# ═══ ① dmRules.js：mergeTail 纯函数 ═══
edit("src/utils/dmRules.js", [(
"""    out.push({ type: \"msg\", key: `m${m.id}`, msg: m });
  }
  return out;
}
""",
"""    out.push({ type: \"msg\", key: `m${m.id}`, msg: m });
  }
  return out;
}

/** 轮 157：轮询尾部增量合并（替代「msgs = 尾部 N 条」的整段替换——那会把翻过的历史冲掉）
 * ------------------------------------------------------------
 * tailAsc：尾部若干条（旧→新）。规则：
 *  ① 已见过的 id → 原位更新（撤回/失败标记等字段能刷进来）；字段没变就不动数组（不触发重渲染）；
 *  ② 没见过的 id → 追加，插到乐观临时消息（id<0，发送中）之前——临时消息永远压尾部；
 *  ③ 返回 { rows, added }：无变化时 rows 与入参同引用（Vue 不会重渲染）；added = 是否有新消息落地。
 */
export function mergeTail(existing, tailAsc) {
  const cur = Array.isArray(existing) ? existing : [];
  const tail = Array.isArray(tailAsc) ? tailAsc : [];
  if (!tail.length) return { rows: cur, added: false };
  const curIdx = new Map(cur.map((m, i) => [m.id, i]));
  let rows = cur;
  let copied = false;
  let added = false;
  for (const m of tail) {                       /* ① 原位更新 */
    const i = curIdx.get(m.id);
    if (i == null) continue;
    if (rows[i] !== m && JSON.stringify(rows[i]) !== JSON.stringify(m)) {
      if (!copied) { rows = cur.slice(); copied = true; }
      rows[i] = m;
    }
  }
  for (const m of tail) {                       /* ② 追加新行 */
    if (curIdx.has(m.id)) continue;
    if (!copied) { rows = cur.slice(); copied = true; }
    const at = rows.findIndex((x) => x.id < 0);
    if (at >= 0) rows.splice(at, 0, m); else rows.push(m);
    added = true;
  }
  return { rows, added };
}
""")])

# ═══ ② MessagesView.vue ═══
MV = "src/views/MessagesView.vue"
edit(MV, [
# 导入
("""import { cacheKey, swr } from "../utils/cache.js";""",
 """import { cacheKey, swr, cachePeek, cacheSet } from "../utils/cache.js";"""),
("""  validateSend, sendErrKey, canRecall, relativeTime, rowView,
} from "../utils/dmRules.js";""",
 """  validateSend, sendErrKey, canRecall, relativeTime, rowView, mergeTail,
} from "../utils/dmRules.js";"""),
# 触顶自动加载（挂在 scrollBottom 后面）
("""function scrollBottom(smooth = false) {
  nextTick(() => {
    const el = listEl.value;
    if (!el) return;
    if (smooth && el.scrollTo) el.scrollTo({ top: el.scrollHeight, behavior: \"smooth\" });
    else el.scrollTop = el.scrollHeight;
  });
}
""",
 """function scrollBottom(smooth = false) {
  nextTick(() => {
    const el = listEl.value;
    if (!el) return;
    if (smooth && el.scrollTo) el.scrollTo({ top: el.scrollHeight, behavior: \"smooth\" });
    else el.scrollTop = el.scrollHeight;
  });
}

/* 轮 157：触顶自动翻历史——rAF 节流 + passive 监听，滚到顶 140px 内自动拉上一批；
 * 「加载更早」按钮保留（可见的 loading 态兜底）。 */
let topRaf = 0;
function onScrollTop() {
  if (topRaf) return;
  topRaf = requestAnimationFrame(() => {
    topRaf = 0;
    const el = listEl.value;
    if (!el || loadingMsgs.value || !hasMore.value || !oldestId.value || !activeId.value) return;
    if (el.scrollTop < 140) loadMessages(activeId.value, { before: oldestId.value });
  });
}
"""),
# loadMessages 锚点保持
("""    const asc = rows.slice().reverse();
    if (before == null) msgs.value = asc;
    else msgs.value = asc.concat(msgs.value);
    hasMore.value = rows.length === 30;""",
 """    const asc = rows.slice().reverse();
    if (before == null) msgs.value = asc;
    else {
      /* 轮 157：向上翻历史的锚点保持——先量高、插行、下一帧把 scrollTop 补上差值。
       * 不补的话浏览器把视口钉在原 scrollTop 上，内容凭空「跳」一页；
       * 临时关平滑滚动，防浏览器动画与人锚点打架。 */
      const el = listEl.value;
      const oldH = el ? el.scrollHeight : 0;
      msgs.value = asc.concat(msgs.value);
      if (el) requestAnimationFrame(() => {
        const prevSb = el.style.scrollBehavior;
        el.style.scrollBehavior = \"auto\";
        el.scrollTop += el.scrollHeight - oldH;
        el.style.scrollBehavior = prevSb || \"\";
      });
    }
    hasMore.value = rows.length === 30;"""),
# openConv 省 RPC
("""  meta.value = null;
  await Promise.all([loadMessages(activeId.value), loadMeta(activeId.value)]);
  scrollBottom();""",
 """  meta.value = null;
  /* 轮 157：从会话列表点进来时 activeConv 行已带昵称/免打扰/拉黑/请求态——不再单拉
   * conv_meta（每次开聊天少一次 RPC 往返）；深链直进（通知/瓶子记录）列表行缺失才拉。 */
  if (!convs.value.some((c) => String(c.conv_id) === String(activeId.value))) {
    await loadMeta(activeId.value);
  }
  await loadMessages(activeId.value);
  scrollBottom();"""),
# 发送后就地落位
("""  try {
    await dmApi.send(convId, text, null);
    await loadMessages(convId);
    scrollBottom(true);""",
 """  try {
    const r = await dmApi.send(convId, text, null);
    /* 轮 157：dm_send 直接回传 {msg_id, created_at} → 就地把乐观行换成正式行，
     * 不再整段重载 30 条（发送到「已发」少一次网络往返，弱网尤其明显） */
    const mid = r && r.msg_id;
    if (mid != null) {
      const rowSrv = {
        id: mid, sender: meId.value, body: text, image_path: null,
        created_at: r.created_at || temp.created_at, deleted_at: null,
      };
      msgs.value = msgs.value.map((m) => (m.id === temp.id ? rowSrv : m));
      oldestId.value = msgs.value.length ? msgs.value[0].id : null;
      /* 首屏 SWR 缓存同步补上这条（不补的话 5s 内退出重进会先看到旧缓存少一条） */
      const ck = cacheKey(\"dm:msgs\", meId.value, convId);
      const snap = cachePeek(ck);
      if (Array.isArray(snap)) cacheSet(ck, [rowSrv].concat(snap).slice(0, 30));
    } else {
      await loadMessages(convId);   /* 兜底：拿不到 msg_id（异常网关）才走整段重载 */
    }
    scrollBottom(true);"""),
# 轮询重写
("""let timer = null;
async function tick() {
  if (typeof document !== \"undefined\" && document.hidden) return;
  if (!signedIn.value) return;
  await loadConvsImplicit();
  if (!activeId.value) return;
  const prev = msgs.value.length ? msgs.value[msgs.value.length - 1].id : null;
  try {
    const got = (await dmApi.listMessages(activeId.value, { before: null, limit: 30 })) || [];
    const asc = got.slice().reverse();
    if (asc.length && (!prev || asc[asc.length - 1].id !== prev)) {
      const el = listEl.value;
      const nearBottom = !el || (el.scrollHeight - el.scrollTop - el.clientHeight) < 120;
      msgs.value = asc;
      if (nearBottom) scrollBottom(true);
      dmApi.markRead(activeId.value).catch(() => {});
      refreshBadge();
    }
  } catch (e) { /* 静默 */ }
}""",
 """let timer = null;
let tickN = 0;        /* 轮 157：轮询拍数 */
let tickBusy = false; /* 轮 157：上一拍没回来就跳过，弱网下不叠请求 */
async function tick() {
  if (tickBusy) return;
  if (typeof document !== \"undefined\" && document.hidden) return;
  if (!signedIn.value) return;
  tickN++;
  tickBusy = true;
  try {
    if (activeId.value) {
      /* 尾部增量合并（mergeTail）：已见行原位更新、新行追加——翻过的历史不再被轮询冲掉 */
      const got = (await dmApi.listMessages(activeId.value, { before: null, limit: 20 })) || [];
      const asc = got.slice().reverse();
      if (asc.length) {
        const { rows, added } = mergeTail(msgs.value, asc);
        if (rows !== msgs.value) {
          const el = listEl.value;
          const nearBottom = !el || (el.scrollHeight - el.scrollTop - el.clientHeight) < 120;
          msgs.value = rows;
          if (added) {
            if (nearBottom) scrollBottom(true);
            dmApi.markRead(activeId.value).catch(() => {});
            refreshBadge();
          }
        }
      }
    }
    /* 会话列表不再每拍全量拉 200 行：每 3 拍（约 15s）一次，未读/预览仍够新鲜；
     * 后台 chatter 少 2/3，弱网下不跟用户操作抢带宽。消息轮询优先于列表刷新。 */
    if (tickN % 3 === 1) await loadConvsImplicit();
  } catch (e) { /* 静默 */ }
  finally { tickBusy = false; }
}"""),
# 回前台当拍必刷列表
("""function onVisible() {
  if (typeof document !== \"undefined\" && !document.hidden) tick();
}""",
 """function onVisible() {
  if (typeof document !== \"undefined\" && !document.hidden) { tickN = 0; tick(); }
}"""),
# 模板挂滚动监听
("""          <div ref=\"listEl\" class=\"dm-scroll\">""",
 """          <div ref=\"listEl\" class=\"dm-scroll\" @scroll.passive=\"onScrollTop\">"""),
])

# ═══ ③ BottleChat.vue（同款四件套） ═══
BC = "src/components/BottleChat.vue"
edit(BC, [
("""import { displayMsg, withDayDividers, canRecall, validateSend, sendErrKey } from \"../utils/dmRules.js\";""",
 """import { displayMsg, withDayDividers, canRecall, validateSend, sendErrKey, mergeTail } from \"../utils/dmRules.js\";"""),
("""function scrollBottom(smooth = false) {
  nextTick(() => {
    const el = listEl.value;
    if (!el) return;
    if (smooth && el.scrollTo) el.scrollTo({ top: el.scrollHeight, behavior: \"smooth\" });
    else el.scrollTop = el.scrollHeight;
  });
}
""",
 """function scrollBottom(smooth = false) {
  nextTick(() => {
    const el = listEl.value;
    if (!el) return;
    if (smooth && el.scrollTo) el.scrollTo({ top: el.scrollHeight, behavior: \"smooth\" });
    else el.scrollTop = el.scrollHeight;
  });
}

/* 轮 157：触顶自动翻历史（与会话段同款：rAF 节流 + passive 监听） */
let topRaf = 0;
function onScrollTop() {
  if (topRaf) return;
  topRaf = requestAnimationFrame(() => {
    topRaf = 0;
    const el = listEl.value;
    if (!el || loadingMsgs.value || !hasMore.value || !oldestId.value || !convId.value) return;
    if (el.scrollTop < 140) loadMessages(convId.value, { before: oldestId.value });
  });
}
"""),
("""    const rows = (await dmApi.listMessages(id, { before, limit: 30 })) || [];
    const asc = rows.slice().reverse();
    if (before == null) msgs.value = asc;
    else msgs.value = asc.concat(msgs.value);
    hasMore.value = rows.length === 30;""",
 """    const rows = (await dmApi.listMessages(id, { before, limit: 30 })) || [];
    const asc = rows.slice().reverse();
    if (before == null) msgs.value = asc;
    else {
      /* 轮 157：翻历史锚点保持（与会话段同款）——下一帧补 scrollTop 差值，视口不跳 */
      const el = listEl.value;
      const oldH = el ? el.scrollHeight : 0;
      msgs.value = asc.concat(msgs.value);
      if (el) requestAnimationFrame(() => {
        const prevSb = el.style.scrollBehavior;
        el.style.scrollBehavior = \"auto\";
        el.scrollTop += el.scrollHeight - oldH;
        el.style.scrollBehavior = prevSb || \"\";
      });
    }
    hasMore.value = rows.length === 30;"""),
("""  try {
    await dmApi.send(id, text, null);
    await loadMessages(id);
    scrollBottom(true);
    refreshBadge();
  } catch (e) {""",
 """  try {
    const r = await dmApi.send(id, text, null);
    /* 轮 157：dm_send 回传 {msg_id, created_at} → 就地落位，免整段重载（与会话段同款） */
    const mid = r && r.msg_id;
    if (mid != null) {
      const rowSrv = {
        id: mid, sender: props.meId, body: text, image_path: null,
        created_at: r.created_at || temp.created_at, deleted_at: null,
      };
      msgs.value = msgs.value.map((m) => (m.id === temp.id ? rowSrv : m));
      oldestId.value = msgs.value.length ? msgs.value[0].id : null;
    } else {
      await loadMessages(id);
    }
    scrollBottom(true);
    refreshBadge();
  } catch (e) {"""),
("""let timer = null;
async function tick() {
  if (typeof document !== \"undefined\" && document.hidden) return;
  if (!chatting.value) return;
  const prev = msgs.value.length ? msgs.value[msgs.value.length - 1].id : null;
  try {
    const got = (await dmApi.listMessages(convId.value, { before: null, limit: 30 })) || [];
    const asc = got.slice().reverse();
    if (asc.length && (!prev || asc[asc.length - 1].id !== prev)) {
      const el = listEl.value;
      const nearBottom = !el || (el.scrollHeight - el.scrollTop - el.clientHeight) < 120;
      msgs.value = asc;
      if (nearBottom) scrollBottom(true);
      dmApi.markRead(convId.value).catch(() => {});
      refreshBadge();
    }
  } catch (e) { /* 静默 */ }
}""",
 """let timer = null;
let tickBusy = false; /* 轮 157：上一拍没回来就跳过 */
async function tick() {
  if (tickBusy) return;
  if (typeof document !== \"undefined\" && document.hidden) return;
  if (!chatting.value) return;
  tickBusy = true;
  try {
    /* 轮 157：尾部增量合并（与会话段同款）——历史不再被轮询冲掉 */
    const got = (await dmApi.listMessages(convId.value, { before: null, limit: 20 })) || [];
    const asc = got.slice().reverse();
    if (asc.length) {
      const { rows, added } = mergeTail(msgs.value, asc);
      if (rows !== msgs.value) {
        const el = listEl.value;
        const nearBottom = !el || (el.scrollHeight - el.scrollTop - el.clientHeight) < 120;
        msgs.value = rows;
        if (added) {
          if (nearBottom) scrollBottom(true);
          dmApi.markRead(convId.value).catch(() => {});
          refreshBadge();
        }
      }
    }
  } catch (e) { /* 静默 */ }
  finally { tickBusy = false; }
}"""),
("""        <div ref=\"listEl\" class=\"dm-scroll\">""",
 """        <div ref=\"listEl\" class=\"dm-scroll\" @scroll.passive=\"onScrollTop\">"""),
])

# ═══ ④ style.css：渲染减负 ═══
edit("src/style.css", [
(""".dm-scroll {
  flex: 1; overflow-y: auto; max-height: 52vh;
  display: flex; flex-direction: column; gap: 8px; padding: 12px 2px;
}""",
 """.dm-scroll {
  flex: 1; overflow-y: auto; max-height: 52vh;
  display: flex; flex-direction: column; gap: 8px; padding: 12px 2px;
  overscroll-behavior: contain; /* 轮 157：聊天滚到底/顶不再连锁带动整页橡皮筋 */
}"""),
(""".dm-topmore { display: flex; justify-content: center; padding-bottom: 6px; }""",
 """.dm-topmore { display: flex; justify-content: center; padding-bottom: 6px; }
/* 轮 157：长对话渲染减负——离屏消息行跳过布局/绘制（content-visibility: auto），
 * contain-intrinsic-size 给近真实行高占位，滚动条不抖；行滚近视口即真实渲染。
 * 会话段与漂流瓶聊天框共用 .dm-line/.dm-day 类，一处生效两处受益。 */
.dm-line, .dm-day { content-visibility: auto; contain-intrinsic-size: auto 64px; }
.dm-day { contain-intrinsic-size: auto 40px; }"""),
])
print("ALL EDITS DONE")
