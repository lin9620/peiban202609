# 轮 157b：聊天消息「窗口缓存」——翻过的历史也进本地缓存，下次打开本地直出
import io

def edit(p, pairs):
    s = io.open(p, encoding="utf-8").read()
    for old, new in pairs:
        assert s.count(old) == 1, f"{p}: anchor x{s.count(old)}: {old[:70]!r}"
        s = s.replace(old, new)
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)
    print("ok", p)

# ═══ ① dmRules.js：窗口缓存助手（纯函数层，dm-test 可直接单测） ═══
edit("src/utils/dmRules.js", [
("""/* 私信业务规则（纯函数，阶段 4）
 * ------------------------------------------------------------
 * 与 wallRules.js / comments.js 同一哲学：所有「能不碰网络就算出来」的判断都放这里，
 * 视图层（MessagesView / dm.js）只做装配 —— 因此每一条都能单测（tools/dm-test.mjs）。
 * 常量约定（与 MIGRATION_dm_notifications.sql 同源）：
 *   📷 = 纯图片消息的预览占位；⟲ = 最新一条被撤回后的预览占位。
 */
""",
"""/* 私信业务规则（纯函数，阶段 4）
 * ------------------------------------------------------------
 * 与 wallRules.js / comments.js 同一哲学：所有「能不碰网络就算出来」的判断都放这里，
 * 视图层（MessagesView / dm.js）只做装配 —— 因此每一条都能单测（tools/dm-test.mjs）。
 * 常量约定（与 MIGRATION_dm_notifications.sql 同源）：
 *   📷 = 纯图片消息的预览占位；⟲ = 最新一条被撤回后的预览占位。
 */
import { cacheKey, cachePeek, cacheSet } from "./cache.js";
"""),
("""  for (const m of tail) {                       /* ② 追加新行 */
    if (curIdx.has(m.id)) continue;
    if (!copied) { rows = cur.slice(); copied = true; }
    const at = rows.findIndex((x) => x.id < 0);
    if (at >= 0) rows.splice(at, 0, m); else rows.push(m);
    added = true;
  }
  return { rows, added };
}
""",
"""  for (const m of tail) {                       /* ② 追加新行 */
    if (curIdx.has(m.id)) continue;
    if (!copied) { rows = cur.slice(); copied = true; }
    const at = rows.findIndex((x) => x.id < 0);
    if (at >= 0) rows.splice(at, 0, m); else rows.push(m);
    added = true;
  }
  return { rows, added };
}

/* ──────── 轮 157b：会话消息「窗口缓存」 ────────
 * 首屏 SWR 一直有（最近 30 条本地直出），但翻过的历史页不进缓存，且全局缓存护栏只有
 * 60 条、会话一多聊天快照就被挤掉——用户要的是「下次打开聊天窗口，本地先把历史顶上来」。
 * 这里把本次翻到的窗口整体缓存（rows 新→旧 + more 是否还有更早），旧版纯数组快照兼容读。
 * 两个聊天视图（会话段 / 漂流瓶段）与发送补条都必须走这三个助手，形状才不会漂移。 */

/** 服务端分页批量（首屏一次拉多少；dmWin 兼容判定按它认「还有更早」） */
export const DM_PAGE = 30;
/** 缓存窗口上限（条）：超窗裁最旧的，localStorage 不被撑爆 */
export const DM_WINDOW_CAP = 60;

/** dm:msgs 缓存键（带用户域，换账号不串数据） */
export function dmMsgsKey(meId, convId) {
  return cacheKey("dm:msgs", meId, convId);
}

/** 归一化缓存快照 → { rows 新→旧, more }；旧版纯数组兼容；垃圾入参返回 null */
export function dmWin(v) {
  if (Array.isArray(v)) return { rows: v, more: v.length === DM_PAGE };
  if (v && Array.isArray(v.rows)) return { rows: v.rows, more: !!v.more };
  return null;
}

/** 写窗口快照（裁到 WINDOW_CAP） */
export function dmCacheWindow(meId, convId, rowsDesc, more) {
  cacheSet(dmMsgsKey(meId, convId), {
    rows: (Array.isArray(rowsDesc) ? rowsDesc : []).slice(0, DM_WINDOW_CAP),
    more: !!more,
  });
}

/** 读窗口快照（无 / 垃圾 → null） */
export function dmPeekWindow(meId, convId) {
  return dmWin(cachePeek(dmMsgsKey(meId, convId)));
}
"""),
])

# ═══ ② cache.js：全局护栏 60 → 120（dm:convs + 每会话 dm:msgs + 墙/通知/故事共存，60 条会被挤） ═══
edit("src/utils/cache.js", [
("""export const CACHE_MAX_ENTRIES = 60;""",
 """export const CACHE_MAX_ENTRIES = 120;   /* 轮 157b：60 → 120——聊天每会话一条窗口快照，60 条会被其它域的缓存挤出（用户实测重进丢缓存） */"""),
])

# ═══ ③ MessagesView.vue ═══
MV = "src/views/MessagesView.vue"
edit(MV, [
("""import { cacheKey, swr, cachePeek, cacheSet } from "../utils/cache.js";""",
 """import { cacheKey, swr } from "../utils/cache.js";"""),
("""  validateSend, sendErrKey, canRecall, relativeTime, rowView, mergeTail,
} from "../utils/dmRules.js";""",
 """  validateSend, sendErrKey, canRecall, relativeTime, rowView, mergeTail,
  dmMsgsKey, dmPeekWindow, dmCacheWindow, dmWin,
} from "../utils/dmRules.js";"""),
("""const msgs = ref([]);        // 当前会话消息（旧→新）""",
 """const msgs = ref([]);        // 当前会话消息（旧→新）
let msgsConv = "";           // msgs 现在装的是哪个会话（轮 157b：防跨会话误合并）"""),
# loadMessages：SWR 窗口化重写
("""  await swr(
    before == null ? cacheKey("dm:msgs", meId.value, id) : null,  /* 只缓存首屏；翻历史页不缓存 */
    {
      cached: (rows) => { applyRows(rows); loadingMsgs.value = false; scrollBottom(); },
      fresh: (rows) => {
        /* 刚发的乐观消息（负数临时 id）还在屏上 → 这轮先不覆盖，交给 5s 轮询 / send 后的重载 */
        if (msgs.value.some((m) => m.id < 0)) return;
        applyRows(rows);
      },
      onError: () => applyRows([]),
    },
    () => dmApi.listMessages(id, { before, limit: 30 }),
  );
  loadingMsgs.value = false;
}""",
 """  await swr(
    before == null ? dmMsgsKey(meId.value, id) : null,
    {
      /* 轮 157b：首屏先吃本地窗口（最多 60 条，含上次翻过的历史），立刻渲染不闪载入 */
      cached: (v) => {
        const w = dmWin(v);
        if (!w || !w.rows.length) return;
        applyRows(w.rows, w.more);
        loadingMsgs.value = false;
        scrollBottom();
      },
      fresh: (v) => {
        const w = dmWin(v);
        if (!w) return;
        if (before != null) {
          applyRows(w.rows, w.more);
          /* 历史页并入缓存窗口（更旧的页拼前面）；本页拉不满 30 = 没有更早了 */
          const hit = dmPeekWindow(meId.value, id);
          if (hit) dmCacheWindow(meId.value, id, w.rows.concat(hit.rows), w.more && hit.more);
        } else if (msgsConv === id && msgs.value.some((m) => m.id < 0)) {
          return;   /* 乐观消息在场：不动视图，交给轮询 / send 收敛 */
        } else if (msgsConv === id) {
          /* 重开同一会话：尾部增量并入，保住已翻的历史窗口 */
          const asc = w.rows.slice().reverse();
          const { rows } = mergeTail(msgs.value, asc);
          if (rows !== msgs.value) msgs.value = rows;
          oldestId.value = msgs.value.length ? msgs.value[0].id : null;
        } else {
          applyRows(w.rows, w.more);
        }
        if (w.more === false) hasMore.value = false;
      },
      onError: () => { if (before == null && msgsConv !== id) applyRows([], false); },
    },
    () => dmApi.listMessages(id, { before, limit: 30 }).then((rows) => {
      rows = rows || [];
      /* 首屏按「窗口快照」落缓存（swr 直接缓存本返回值） */
      return before == null ? { rows, more: rows.length === 30 } : rows;
    }),
  );
  loadingMsgs.value = false;
}"""),
# applyRows 认 more 标记 + msgsConv 跟踪
("""    const asc = rows.slice().reverse();
    if (before == null) msgs.value = asc;
    else {
      /* 轮 157：向上翻历史的锚点保持——先量高、插行、下一帧把 scrollTop 补上差值。""",
 """    const asc = rows.slice().reverse();
    if (before == null || msgsConv !== id) {
      msgs.value = asc;
    } else {
      /* 轮 157：向上翻历史的锚点保持——先量高、插行、下一帧把 scrollTop 补上差值。"""),
("""        el.style.scrollBehavior = prevSb || "";
      });
    }
    hasMore.value = rows.length === 30;
    oldestId.value = msgs.value.length ? msgs.value[0].id : null;
  };
  await swr(""",
 """        el.style.scrollBehavior = prevSb || "";
      });
    }
    msgsConv = id;
    hasMore.value = more != null ? more : rows.length === 30;
    oldestId.value = msgs.value.length ? msgs.value[0].id : null;
  };
  await swr("""),
# 发送补条走窗口助手
("""      /* 首屏 SWR 缓存同步补上这条（不补的话 5s 内退出重进会先看到旧缓存少一条） */
      const ck = cacheKey("dm:msgs", meId.value, convId);
      const snap = cachePeek(ck);
      if (Array.isArray(snap)) cacheSet(ck, [rowSrv].concat(snap).slice(0, 30));""",
 """      /* 首屏窗口缓存同步补上这条（不补的话 5s 内退出重进会先看到旧缓存少一条） */
      const win = dmPeekWindow(meId.value, convId);
      if (win) dmCacheWindow(meId.value, convId, [rowSrv].concat(win.rows), win.more);"""),
# 路由回列表：清 msgsConv
("""  activeId.value = "";
  msgs.value = [];
  meta.value = null;
  fromList.value = false;""",
 """  activeId.value = "";
  msgs.value = [];
  msgsConv = "";
  meta.value = null;
  fromList.value = false;"""),
])

# ═══ ④ BottleChat.vue：接入同款窗口缓存（与会话段共用 dm:msgs 键） ═══
BC = "src/components/BottleChat.vue"
edit(BC, [
("""import { displayMsg, withDayDividers, canRecall, validateSend, sendErrKey, mergeTail } from "../utils/dmRules.js";""",
 """import { displayMsg, withDayDividers, canRecall, validateSend, sendErrKey, mergeTail,
  dmMsgsKey, dmPeekWindow, dmCacheWindow, dmWin } from "../utils/dmRules.js";
import { swr } from "../utils/cache.js";"""),
("""const msgs = ref([]);""",
 """const msgs = ref([]);
let msgsConv = "";           /* msgs 现在装的是哪个会话（轮 157b：防跨会话误合并） */"""),
("""  loadingMsgs.value = true;
  try {
    const rows = (await dmApi.listMessages(id, { before, limit: 30 })) || [];
    const asc = rows.slice().reverse();
    if (before == null) msgs.value = asc;
    else {
      /* 轮 157：翻历史锚点保持（与会话段同款）——下一帧补 scrollTop 差值，视口不跳 */
      const el = listEl.value;
      const oldH = el ? el.scrollHeight : 0;
      msgs.value = asc.concat(msgs.value);
      if (el) requestAnimationFrame(() => {
        const prevSb = el.style.scrollBehavior;
        el.style.scrollBehavior = "auto";
        el.scrollTop += el.scrollHeight - oldH;
        el.style.scrollBehavior = prevSb || "";
      });
    }
    hasMore.value = rows.length === 30;
    oldestId.value = msgs.value.length ? msgs.value[0].id : null;
  } catch (e) {
    if (before == null) msgs.value = [];
  }
  loadingMsgs.value = false;
}""",
 """  loadingMsgs.value = true;
  const applyRows = (rows, more) => {
    const asc = rows.slice().reverse();
    if (before == null || msgsConv !== id) {
      msgs.value = asc;
    } else {
      /* 轮 157：翻历史锚点保持（与会话段同款）——下一帧补 scrollTop 差值，视口不跳 */
      const el = listEl.value;
      const oldH = el ? el.scrollHeight : 0;
      msgs.value = asc.concat(msgs.value);
      if (el) requestAnimationFrame(() => {
        const prevSb = el.style.scrollBehavior;
        el.style.scrollBehavior = "auto";
        el.scrollTop += el.scrollHeight - oldH;
        el.style.scrollBehavior = prevSb || "";
      });
    }
    msgsConv = id;
    hasMore.value = more != null ? more : rows.length === 30;
    oldestId.value = msgs.value.length ? msgs.value[0].id : null;
  };
  await swr(
    before == null ? dmMsgsKey(props.meId, id) : null,
    {
      /* 轮 157b：与会话段共用 dm:msgs 窗口缓存——手机上聊过的，桌面瓶聊秒开同一份 */
      cached: (v) => {
        const w = dmWin(v);
        if (!w || !w.rows.length) return;
        applyRows(w.rows, w.more);
        loadingMsgs.value = false;
      },
      fresh: (v) => {
        const w = dmWin(v);
        if (!w) return;
        if (before != null) {
          applyRows(w.rows, w.more);
          const hit = dmPeekWindow(props.meId, id);
          if (hit) dmCacheWindow(props.meId, id, w.rows.concat(hit.rows), w.more && hit.more);
        } else if (msgsConv === id && msgs.value.some((m) => m.id < 0)) {
          return;   /* 乐观消息在场：不动视图 */
        } else if (msgsConv === id) {
          const asc = w.rows.slice().reverse();
          const { rows } = mergeTail(msgs.value, asc);
          if (rows !== msgs.value) msgs.value = rows;
          oldestId.value = msgs.value.length ? msgs.value[0].id : null;
        } else {
          applyRows(w.rows, w.more);
        }
        if (w.more === false) hasMore.value = false;
      },
      onError: () => { if (before == null && msgsConv !== id) { msgs.value = []; msgsConv = ""; } },
    },
    () => dmApi.listMessages(id, { before, limit: 30 }).then((rows) => {
      rows = rows || [];
      return before == null ? { rows, more: rows.length === 30 } : rows;
    }),
  );
  loadingMsgs.value = false;
}"""),
("""async function onLetter() {
  msgs.value = [];
  body.value = "";""",
 """async function onLetter() {
  msgs.value = [];
  msgsConv = "";
  body.value = "";"""),
])
print("ALL 157b EDITS DONE")
