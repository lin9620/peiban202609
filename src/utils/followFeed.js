/* ═══════════ 关注流：启动预热 + 本地快照（轮 459）═══════════
 * 用户：「暖心墙点击我的关注，进去非常慢，能不能在启动页的时候就获取一部分数据，缓存到本地」。
 *
 * 慢在哪（改前的两条串行网络）：
 *   ① enterFollowFeed 先 `await refreshFollows(true)` 强制拉关注名单；
 *   ② 拿到名单才开始 `cloudFetchPosts` 拉第一页（内部还有 listPosts + listReactionsByPosts 两跳）。
 *   两段都回来之前，页面上只有一句「正在读取你的关注」，用户看到的就是白等。
 *
 * 这里做两件事：
 *   · warmFollowFeed()：启动页放行之后（浏览器空闲时）就把「名单 + 第一页」拉一次写进本地快照；
 *   · readFollowSnap() / saveFollowSnap()：进关注流时**先同步铺快照**（0ms 上屏），
 *     再后台校准 —— 和暖心墙本身同一套 SWR 口径，只是数据源换成「我关注的人」。
 *
 * 三条纪律（都踩过坑）：
 *   · 快照键按账号域（uid）分开 —— 换号绝不看到上一个人的关注流；
 *   · 快照带名单指纹（sig）—— 关注/取关过之后，快照里的帖子已经不全是「我关注的人发的」，
 *     调用方据此决定「直接沿用它」还是「整表换掉」；
 *   · **0 人关注绝不发请求** —— 服务端把空作者白名单当成「不过滤」，会返回全站内容（坑 8）。
 */
import { cacheDrop, cacheGet, cacheKey, cacheSet } from "./cache.js";
import { cloud } from "./supabase.js";
import { cloudFetchCommentCounts, cloudFetchPosts } from "./wall.js";
import { followState, refreshFollows } from "./follows.js";

/** 快照装多少条：与进页首屏同口径（REFRESH_PAGE = 20）——
 *  两边条数不一样的话，进页后会有一次「先 12 条、再变 20 条」的重排，看着像闪。 */
export const FOLLOW_SNAP_PAGE = 20;
/** 多久之内算新鲜：比这更近的快照不再重复拉网络（启动预热 + 进出页面共用这一条） */
const FRESH_MS = 3 * 60 * 1000;
/** 快照最长可用：超过就别铺屏了（放三天前的关注流比空着更误导人），后台照常拉新的 */
const MAX_AGE = 3 * 24 * 3600 * 1000;

function uid() { return (cloud.user && cloud.user.id) || ""; }
function snapKey() { return cacheKey("wall:follow-posts", uid()); }

/**
 * 关注名单指纹（djb2，只看「是谁」，不看顺序）。
 * 用来判断一份快照还是不是「我此刻关注的人」发的内容 —— 名单一变，快照里的帖子就得整表换掉。
 */
export function idsSig(ids) {
  const list = Array.isArray(ids) ? ids.map(String) : [];
  const s = list.slice().sort().join(",");
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + ":" + list.length;
}

/** 读快照（同步、0ms）。没有快照 / 过期 / 未登录 → null */
export function readFollowSnap() {
  if (!uid()) return null;
  const snap = cacheGet(snapKey(), { maxAge: MAX_AGE });
  if (!snap || !Array.isArray(snap.rows) || !snap.rows.length) return null;
  return snap;
}

/**
 * 写快照。rows 为空（关注的人一条都没发过）时不写 —— 空快照没有任何价值，
 * 只会让下次进页多一次「有缓存但没内容」的误判。
 */
export function saveFollowSnap(ids, rows, counts = null) {
  if (!uid() || !Array.isArray(rows) || !rows.length) return;
  cacheSet(snapKey(), {
    t: Date.now(),
    sig: idsSig(ids),
    ids: (ids || []).map(String),
    rows,
    counts: counts || null,
  });
}

/** 清快照（0 人关注 / 退出登录后不该留别人的内容在设备上） */
export function clearFollowSnap() {
  if (!uid()) return;
  cacheDrop(snapKey());
}

/* 启动预热的单飞 + 节流：App 启动与登录各调一次，不能变成两次同样的请求 */
let warming = null;
let warmedAt = 0;

/**
 * 启动期预热：把「关注名单 + 第一页」拉一次写进本地快照。
 * 调用方（App.vue）在启动页放行后、浏览器空闲时 fire-and-forget 地跑；
 * 失败一律静默 —— 进页时还有常规路径兜底，预热 never 阻塞任何东西。
 * @returns {Promise<object|null>} 写好的快照（失败/无关注 → null）
 */
export function warmFollowFeed({ force = false } = {}) {
  if (!(cloud.ready && cloud.user)) return Promise.resolve(null);
  if (warming) return warming;
  const snap = readFollowSnap();
  if (!force && snap && Date.now() - (snap.t || 0) < FRESH_MS) return Promise.resolve(snap);
  if (!force && Date.now() - warmedAt < FRESH_MS) return Promise.resolve(null);

  warming = (async () => {
    try {
      /* 名单本身有多处缓存（followState + 本地快照），这里用非强制口径：
         真拉过就直接吃现成的，省掉一次必然重复的往返 */
      await refreshFollows();
      /* 名单没拉回来（弱网 / 离线）≠ 没有关注 —— 此时**绝不能清快照**，
         否则一次失败的预热就把上一份能直接用的缓存白白清掉，下次进页又要干等。 */
      if (followState.error) return null;
      const ids = followState.ids;
      if (!ids.length) { clearFollowSnap(); return null; }

      const rows = await cloudFetchPosts(FOLLOW_SNAP_PAGE, 0, { userIds: ids });
      if (!rows || !rows.length) return null;
      saveFollowSnap(ids, rows, null);
      warmedAt = Date.now();
      /* 评论数后台补：卡片上的数字也要准，但不该让预热多等一次往返 */
      cloudFetchCommentCounts(rows.map((r) => r.dbId)).then((counts) => {
        if (counts) saveFollowSnap(ids, rows, counts);
      }).catch(() => {});
      return readFollowSnap();
    } catch (e) {
      return null;
    } finally {
      warming = null;
    }
  })();
  return warming;
}
